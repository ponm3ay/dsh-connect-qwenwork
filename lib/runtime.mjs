import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { FALLBACK_VERSION, FALLBACK_RELEASE } from './constants.mjs'

const bundledRoot = fileURLToPath(new URL('../.qwenwork-runtime/', import.meta.url))
// Apply the source version only to this exact official binary, including copies.
const bundledSignature = {
  sha256: '15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3',
  version: '2.1.0',
  releaseVersion: '2.1.0-26111906',
}

function readPackage(archive) {
  let fd
  try {
    fd = fs.openSync(archive, 'r')
    const head = Buffer.alloc(16)
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) return {}
    const size = head.readUInt32LE(12)
    if (size <= 0 || size > 16 * 1024 * 1024) return {}
    const data = Buffer.alloc(size)
    if (fs.readSync(fd, data, 0, size, 16) !== size) return {}
    const entry = JSON.parse(data).files?.['package.json']
    if (!entry || entry.unpacked || entry.size > 256 * 1024 || !/^\d+$/.test(entry.offset)) return {}
    const pkg = Buffer.alloc(entry.size)
    if (fs.readSync(fd, pkg, 0, pkg.length, 8 + head.readUInt32LE(4) + Number(entry.offset)) !== pkg.length) return {}
    return JSON.parse(pkg)
  } catch { return {} } finally { if (fd !== undefined) fs.closeSync(fd) }
}

export function runtimeCandidates({ env = process.env, platform = process.platform, home = os.homedir(), bundledRoot: componentRoot = bundledRoot } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const roots = []
  if (env.QWENWORK_APP_PATH) roots.push(env.QWENWORK_APP_PATH)
  if (componentRoot) roots.push(componentRoot)
  if (platform === 'darwin') roots.push('/Applications/QwenWorkCN.app/Contents/Resources', paths.join(home, 'Applications/QwenWorkCN.app/Contents/Resources'))
  if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const folder of ['Programs/QwenWorkCN', 'QwenWorkCN', 'Programs/QwenWork', 'QwenWork']) roots.push(paths.join(root, folder))
    }
  }
  if (platform === 'linux') roots.push('/opt/QwenWorkCN/resources', '/opt/qwenworkcn/resources', '/opt/apps/QwenWorkCN/resources', paths.join(home, '.local/share/qwenworkcn/resources'))
  const resources = roots.flatMap(root => {
    if (root.endsWith('.app')) return [paths.join(root, 'Contents/Resources')]
    const standard = [root, paths.join(root, 'resources')]
    if (platform !== 'win32') return standard
    // Newer Windows installs put each release under a versioned subdirectory.
    // Only inspect direct, version-named directories under known App roots.
    try {
      const releases = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      return [...releases.map(release => paths.join(root, release, 'resources')), ...standard]
    } catch { return standard }
  })
  const files = resources.map(root => paths.join(root, 'qoder-auth-wasm/qoder_auth_wasm_bg.wasm'))
  return [...new Set([env.QWENWORK_WASM_PATH, ...files].filter(Boolean))]
}

export function discoverRuntime(options = {}) {
  const env = options.env ?? process.env
  const candidates = runtimeCandidates(options)
  for (const wasmPath of candidates) {
    try {
      const stat = fs.statSync(wasmPath)
      if (!stat.isFile() || stat.size < 8 || stat.size > 8 * 1024 * 1024) continue
      const bytes = fs.readFileSync(wasmPath)
      if (bytes.subarray(0, 4).toString('hex') !== '0061736d') continue
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const bundled = sha256 === bundledSignature.sha256 ? bundledSignature : undefined
      const pkg = readPackage(path.join(path.dirname(path.dirname(wasmPath)), 'app.asar'))
      const version = env.QWENWORK_CLIENT_VERSION || pkg.version || bundled?.version || FALLBACK_VERSION
      const releaseVersion = env.QWENWORK_RELEASE_VERSION || pkg.qoderworkUpgradeVersion || bundled?.releaseVersion || FALLBACK_RELEASE
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || !/^[\w.+-]+$/.test(releaseVersion)) throw new Error('无效的客户端版本信息')
      return { wasmPath: path.resolve(wasmPath), version, releaseVersion, sha256, bytes: bytes.length }
    } catch (error) { if (env.QWENWORK_WASM_PATH === wasmPath) throw new Error(`无法加载指定的千问办公签名组件：${error.code ?? error.message}`) }
  }
  throw new Error('未找到千问办公签名组件。请检查插件内的 .qwenwork-runtime 目录，或安装千问办公官方 App；非标准位置可设置 QWENWORK_APP_PATH 或 QWENWORK_WASM_PATH。插件不读取 App 的登录文件。')
}
