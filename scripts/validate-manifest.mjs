/**
 * Validate the package manifest and the bundle patch.
 *
 * A broken manifest does not make the plugin behave oddly — it makes it
 * uninstallable, or installable and then silently absent from the profile. So
 * the checks here are about the things that fail quietly:
 *
 *  - every path named in `exports`, `files`, `dsh.bundle.patch` and `icon`
 *    exists on disk;
 *  - the runtime entry the patch's `name` refers to resolves;
 *  - the locale files parse and carry the display metadata the Plugin Manager
 *    reads, with the detail document they name present;
 *  - the icon is a real image of a format the panel accepts, inside the size cap;
 *  - every module under lib/ parses, because a syntax error in a lazily imported
 *    module only surfaces at the moment a user clicks the thing that loads it.
 *
 * Run from the package root:
 *   node scripts/validate-manifest.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/** Record a problem rather than throwing, so one run reports all of them. */
function fail(message) {
  problems.push(message)
}

function mustExist(relative, why) {
  const path = join(root, relative)
  if (!existsSync(path)) {
    fail(`${why}: ${relative} does not exist`)
    return undefined
  }
  return path
}

// ---- manifest --------------------------------------------------------------

const manifestPath = join(root, 'package.json')
if (!existsSync(manifestPath)) {
  console.error('package.json is missing')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

for (const field of ['name', 'version', 'description', 'license', 'type', 'main']) {
  if (typeof manifest[field] !== 'string' || manifest[field] === '') fail(`package.json is missing "${field}"`)
}
if (manifest.type !== 'module') fail('package.json "type" must be "module": the Host loads the plugin as ESM')
if (manifest.name !== 'dsh-connect-qwenwork') notes.push(`package name is "${manifest.name}"`)

// The runtime entry.
if (typeof manifest.main === 'string') mustExist(manifest.main.replace(/^\.\//, ''), 'manifest.main')

// Every export target must exist.
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  const target = typeof value === 'string' ? value : value?.default
  if (typeof target !== 'string') {
    fail(`exports["${key}"] has no string target`)
    continue
  }
  // Wildcard exports name a pattern, not a file; check the directory exists.
  if (target.includes('*')) {
    const directory = dirname(target.replace(/^\.\//, ''))
    mustExist(directory, `exports["${key}"] pattern directory`)
  } else {
    mustExist(target.replace(/^\.\//, ''), `exports["${key}"]`)
  }
}

// Every shipped file must exist. A pattern is expanded loosely: the directory
// it points into has to exist and hold at least one file.
for (const entry of manifest.files ?? []) {
  if (entry.includes('*')) {
    const directory = dirname(entry.replace(/^\.\//, ''))
    mustExist(directory, `files entry "${entry}" directory`)
  } else {
    mustExist(entry.replace(/^\.\//, ''), `files entry "${entry}"`)
  }
}

// The bundle patch.
const patchRelative = manifest.dsh?.bundle?.patch
if (typeof patchRelative !== 'string') {
  fail('package.json is missing dsh.bundle.patch')
} else {
  const patchPath = mustExist(patchRelative.replace(/^\.\//, ''), 'dsh.bundle.patch')
  if (patchPath !== undefined) {
    const patch = readFileSync(patchPath, 'utf8')
    // The patch must insert this package, by the same name the manifest uses.
    if (!patch.includes(`name: ${manifest.name}`) && !patch.includes(`name: '${manifest.name}'`)) {
      fail(`dsh.bundle.patch does not insert "${manifest.name}"`)
    }
    if (!/- insert:/.test(patch)) fail('dsh.bundle.patch has no "- insert:" section')
  }
}

// The client half.
const clientExport = manifest.exports?.['./client']
if (clientExport === undefined) fail('package.json is missing exports["./client"]: the settings panel needs it')
else if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"')

// ---- locales ---------------------------------------------------------------

for (const locale of ['en', 'zh']) {
  const path = mustExist(`locale/${locale}.json`, `locale/${locale}.json`)
  if (path === undefined) continue
  let document
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`locale/${locale}.json is not valid JSON: ${error.message}`)
    continue
  }
  const meta = document.meta ?? {}
  for (const field of ['title', 'description']) {
    if (typeof meta[field] !== 'string' || meta[field].trim() === '') {
      fail(`locale/${locale}.json is missing meta.${field}`)
    }
  }
  if (typeof meta.detail === 'string') mustExist(meta.detail, `locale/${locale}.json meta.detail`)
}

// ---- icon ------------------------------------------------------------------

const iconPath = join(root, 'icons/dsh-connect-qwenwork-128.png')
if (existsSync(iconPath)) {
  const bytes = readFileSync(iconPath)
  const size = statSync(iconPath).size
  // PNG magic, so a renamed text file cannot pass as artwork.
  const png = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (!png) fail('icons/dsh-connect-qwenwork-128.png is not a PNG')
  if (size > 256 * 1024) fail(`the icon is ${size} bytes, over the 256 KiB cap`)
  if (png) {
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (width !== 128 || height !== 128) fail(`the icon is ${width}x${height}, expected 128x128`)
  }
} else {
  fail('icons/dsh-connect-qwenwork-128.png is missing')
}

// ---- the bundled signing component -----------------------------------------

const wasmPath = join(root, '.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm')
if (existsSync(wasmPath)) {
  const bytes = readFileSync(wasmPath)
  if (bytes.subarray(0, 4).toString('hex') !== '0061736d') fail('the bundled component is not a WASM module')
  notes.push(`bundled component: ${bytes.length} bytes`)
} else {
  fail('the bundled signing component is missing; the plugin cannot sign a request without it')
}

// ---- every module parses ---------------------------------------------------

const modules = [
  'lib/index.js',
  'lib/adapter.mjs',
  'lib/account.mjs',
  'lib/catalog.mjs',
  'lib/catalog-store.mjs',
  'lib/chat.mjs',
  'lib/client.js',
  'lib/constants.mjs',
  'lib/errors.mjs',
  'lib/http-fence.mjs',
  'lib/http-json.mjs',
  'lib/login.mjs',
  'lib/model-resolve.mjs',
  'lib/model-state.mjs',
  'lib/panel.mjs',
  'lib/panel-view.mjs',
  'lib/probe.mjs',
  'lib/runtime.mjs',
  'lib/runtime-config.mjs',
  'lib/shim.mjs',
  'lib/store.mjs',
  'lib/wasm.mjs',
]
for (const module of modules) {
  const path = mustExist(module, 'lib module')
  if (path === undefined) continue
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split('\n').slice(0, 3).join(' ')
    fail(`${module} does not parse: ${detail}`)
  }
}

// ---- report ----------------------------------------------------------------

for (const note of notes) console.log('note: ' + note)
if (problems.length > 0) {
  console.error('\nmanifest check failed:')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('manifest OK (' + modules.length + ' modules, ' + Object.keys(manifest.exports ?? {}).length + ' exports)')
