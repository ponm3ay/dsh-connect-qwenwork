/**
 * Mount the plugin inside a real Cordis context with stub `llm` / `webServer`
 * services, then exercise the routes and the model-discovery callback the host
 * would call. This is the closest check to activation that runs outside DSH.
 *
 * Run from a directory whose node_modules holds the extracted runtime:
 *   node scripts/mount.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'qwenwork-mount-'))
process.env.DSH_HOME = home

const calls = { adapters: [], directory: [], discovery: [], routes: [], effects: [] }

const ctx = new Context()

// A logger the plugin can write through.
ctx.logger = {
  info() {},
  warn(...args) { calls.warn = (calls.warn ?? []).concat(args.map(String)) },
  error(...args) { calls.error = (calls.error ?? []).concat(args.map(String)) },
  debug() {},
}

// homePaths, as the host provides it.
ctx.provide('homePaths', { home })

// The llm seam: exactly the three registration entry points this plugin uses.
ctx.provide('llm', {
  registerAdapter(providers, adapter) {
    calls.adapters.push({ providers, adapter })
    return () => calls.effects.push('adapter released')
  },
  registerConfigurableProviders(entries) {
    calls.directory.push(entries)
    return () => calls.effects.push('directory released')
  },
  registerModelDiscovery(namespace, discover) {
    calls.discovery.push({ namespace, discover })
    return () => calls.effects.push('discovery released')
  },
})

// The webServer seam.
ctx.provide('webServer', {
  register(route) {
    calls.routes.push(route)
    return () => calls.effects.push('route released: ' + route.path)
  },
})

console.log('plugin:', name, 'inject:', JSON.stringify(inject))
await apply(ctx)

if (calls.adapters.length !== 1) throw new Error('expected exactly one adapter registration, got ' + calls.adapters.length)
if (calls.adapters[0].providers[0] !== 'qwenwork') throw new Error('the adapter must own the qwenwork route')
if (calls.directory.length !== 1) throw new Error('expected one configurable-provider registration')
if (calls.discovery.length !== 1) throw new Error('expected one model-discovery registration')

const routePaths = calls.routes.map((route) => route.path).sort()
console.log('routes:', routePaths.join(', '))
const expected = [
  '/plugins/dsh-connect-qwenwork/cancel',
  '/plugins/dsh-connect-qwenwork/login',
  '/plugins/dsh-connect-qwenwork/logout',
  '/plugins/dsh-connect-qwenwork/models',
  '/plugins/dsh-connect-qwenwork/status',
]
for (const path of expected) {
  if (!routePaths.includes(path)) throw new Error('missing route ' + path)
}

// The provider must describe itself the way the registry requires.
const info = calls.adapters[0].adapter.providerInfo('qwenwork')
console.log('providerInfo:', JSON.stringify(info))
if (info.id !== 'qwenwork') throw new Error('providerInfo must preserve the route id')

// A signed-out account offers no models.
const discovered = await calls.discovery[0].discover({ provider: 'qwenwork' })
console.log('signed-out discovery:', JSON.stringify(discovered))
if (discovered.length !== 0) throw new Error('a signed-out account must not advertise models')

// A foreign provider route is ignored.
const foreign = await calls.discovery[0].discover({ provider: 'trae' })
if (foreign.length !== 0) throw new Error('discovery must ignore routes this plugin does not own')

// The status route answers the browser half.
const statusRoute = calls.routes.find((route) => route.path.endsWith('/status'))
const request = { method: 'GET', url: '/plugins/dsh-connect-qwenwork/status', headers: { host: '127.0.0.1:62871' } }
let statusCode
let payload
const response = {
  writeHead(code) { statusCode = code },
  end(body) { payload = body },
}
await statusRoute.handler(request, response)
console.log('status HTTP', statusCode, payload.slice(0, 200))
if (statusCode !== 200) throw new Error('the status route must answer 200 to a loopback request')
const status = JSON.parse(payload)
if (status.loggedIn !== false) throw new Error('a fresh home must report signed out')
if (!Array.isArray(status.models) || status.models.length === 0) throw new Error('the status route must list the fallback catalog')
if (status.runtime?.available !== true) throw new Error('the status route must report the signing component')

// A cross-site request must be refused before any work happens.
let refusedCode
await statusRoute.handler(
  { method: 'GET', url: '/plugins/dsh-connect-qwenwork/status', headers: { host: '127.0.0.1:62871', 'sec-fetch-site': 'cross-site' } },
  { writeHead(code) { refusedCode = code }, end() {} },
)
console.log('cross-site refusal:', refusedCode)
if (refusedCode !== 403) throw new Error('a cross-site request must be refused with 403')

// Disposing the context must release every registration it made.
await ctx.fiber.dispose()
console.log('effects on dispose:', calls.effects.length)
if (calls.effects.length < 5) throw new Error('disposal must release the registrations')

console.log('MOUNT OK')
rmSync(home, { recursive: true, force: true })
