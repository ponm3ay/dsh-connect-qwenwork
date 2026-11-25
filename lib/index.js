/**
 * dsh-connect-qwenwork — QwenWork (千问办公) as a DSH model provider, with an
 * in-process loopback shim instead of an external gateway.
 *
 * Layout, and why:
 *   lib/constants.mjs     the gateway's wire facts and the fallback catalog
 *   lib/account.mjs       PKCE login, token rotation, account context (from pi-qwenwork-provider, MIT)
 *   lib/catalog.mjs       the desktop chat-modes catalog parser (from pi-qwenwork-provider, MIT)
 *   lib/chat.mjs          the signed inference request and its SSE decoder (from pi-qwenwork-provider, MIT)
 *   lib/wasm.mjs          the official WASM signer glue (from pi-qwenwork-provider, MIT)
 *   lib/runtime.mjs       locating the bundled/installed signing component (from pi-qwenwork-provider, MIT)
 *   lib/store.mjs         this machine's credentials, with serialized rotation
 *   lib/catalog-store.mjs the account's model listing, cached on disk
 *   lib/model-state.mjs   per-model switch and capability overrides
 *   lib/model-resolve.mjs catalog facts + overrides → the model DSH sees
 *   lib/probe.mjs         smoke-testing the account and each model
 *   lib/shim.mjs          127.0.0.1 server that speaks OpenAI chat completions
 *                         and forwards signed requests upstream
 *   lib/adapter.mjs       pi-ai descriptors + PiAiAdapter over the shim
 *   lib/login.mjs         one browser authorization attempt
 *   lib/panel.mjs         the settings page's route behaviour
 *   lib/panel-view.mjs    the payload shapes the panel renders
 *   lib/http-fence.mjs    the loopback/origin check every route runs
 *
 * Nothing here reaches outside the process for the chat path: no magpie, no
 * separate daemon, no port to remember. That is the whole point of copying
 * dsh-connect-autoclaw's pattern rather than wrapping a gateway.
 */
import { join } from 'node:path'
import { createAuthStore } from './store.mjs'
import { createCatalog } from './catalog-store.mjs'
import { createModelState, statePath } from './model-state.mjs'
import { createShim } from './shim.mjs'
import { createAdapter } from './adapter.mjs'
import { prepareQwenworkInfer } from './wasm.mjs'
import { getRuntime } from './runtime-config.mjs'
import { createPanel } from './panel.mjs'
import { makeFence } from './http-fence.mjs'
import { readJson } from './http-json.mjs'

export const name = 'dsh-connect-qwenwork'
export const inject = ['llm']

const PROVIDER = 'qwenwork'
const PROVIDER_NAME = '千问办公 (QwenWork)'

/**
 * The panel's routes, as a table.
 *
 * A table rather than eight near-identical `child.effect(register(...))` blocks:
 * the path, the method and the handler belong together, and adding a route used
 * to mean copying a block and editing three lines inside it.
 */
const ROUTES = [
  { key: 'status', method: 'GET', call: (panel, url) => panel.status(url) },
  { key: 'login', method: 'POST', call: (panel) => panel.login() },
  { key: 'cancel', method: 'POST', call: (panel) => panel.cancel() },
  { key: 'models', method: 'POST', call: (panel) => panel.refreshModels() },
  { key: 'model', method: 'POST', call: (panel, _url, body) => panel.setModel(body || {}) },
  { key: 'testAccount', method: 'POST', call: (panel) => panel.testAccount() },
  { key: 'testModel', method: 'POST', call: (panel, _url, body) => panel.testModels(body || {}) },
  { key: 'logout', method: 'POST', call: (panel) => panel.logout() },
]

/** Resolve $DSH_HOME the way the host does, with the documented fallbacks. */
function dshHomeOf(ctx) {
  const paths = ctx.get('homePaths')
  if (paths !== undefined && typeof paths.home === 'string' && paths.home.length > 0) return paths.home
  const candidates = [process.env.DSH_HOME, join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')]
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return '.dsh'
}

/** Write one JSON reply with the headers a loopback panel route needs. */
function send(response, code, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Wrap one handler with the fence, the method check and the body parse.
 *
 * Every route gets the same three guards in the same order, so no route can be
 * added later that quietly skips one.
 */
function routeHandler({ method, call, panel, refusal }) {
  return async (request, response) => {
    try {
      const rejected = refusal(request)
      if (rejected !== undefined) {
        send(response, rejected, { error: 'refused', status: rejected })
        return
      }
      if (request.method !== method) {
        response.writeHead(405, { allow: method })
        response.end()
        return
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const body = method === 'POST' ? await readJson(request) : undefined
      send(response, 200, await call(panel, url, body))
    } catch (error) {
      send(response, 400, { error: error && error.message ? error.message : String(error) })
    }
  }
}

export async function apply(ctx) {
  const dshHome = dshHomeOf(ctx)
  const log = (message) => ctx.logger.warn('dsh-connect-qwenwork: ' + message)
  const store = createAuthStore({ dshHome, runtimeProvider: getRuntime, log })
  const modelState = createModelState({ file: statePath(dshHome), log })
  const catalog = createCatalog({ file: join(dshHome, '.qwenwork-models.json.catalog'), state: modelState, log })
  const shim = createShim({
    store,
    catalog,
    runtimeProvider: getRuntime,
    signer: prepareQwenworkInfer,
    log,
  })

  ctx.effect(() => () => shim.close())

  let releaseAdapter
  let releaseDirectory
  try {
    await shim.ready
    const built = createAdapter({ shim, catalog, providerId: PROVIDER, displayName: PROVIDER_NAME })
    releaseAdapter = ctx.llm.registerAdapter([PROVIDER], built.adapter)
    releaseDirectory = ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER,
      displayName: PROVIDER_NAME,
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
      declared: false,
    }])
  } catch (error) {
    ctx.logger.error('dsh-connect-qwenwork: provider registration failed: ' + (error && error.message ? error.message : String(error)))
    return
  }

  ctx.effect(() => () => {
    try { releaseAdapter?.() } finally { releaseDirectory?.() }
  })

  // Model discovery: the catalog is refreshed on demand, but a signed-out
  // account must not offer models it cannot serve, and a switched-off model is
  // never offered at all. The capability fields carry the user's overrides, so
  // the picker shows the same context window and modalities the request will use.
  ctx.llm.registerModelDiscovery(ctx.fiber?.entry?.options?.id ?? name, async (request) => {
    if (request && request.provider && request.provider !== PROVIDER) return []
    if (store.peek() === undefined) return []
    return catalog.listResolved().map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: Math.min(model.maxOutputTokens ?? 32768, 131072),
      inputModalities: model.vision ? ['text', 'image'] : ['text'],
    }))
  })

  // The settings panel's own routes. Registered even when provider activation
  // failed above, so a broken or signed-out install is still repairable from the
  // UI — which is exactly when a user needs it.
  ctx.inject(['webServer'], (child) => {
    const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime, signer: prepareQwenworkInfer, log })
    const refusal = makeFence(child)
    child.effect(() => () => panel.close(), 'dsh-connect-qwenwork: panel cleanup')

    for (const route of ROUTES) {
      const path = panel.paths[route.key]
      if (typeof path !== 'string') throw new Error('dsh-connect-qwenwork: no path for route ' + route.key)
      child.effect(
        () => child.webServer.register({
          kind: 'exact',
          path,
          handler: routeHandler({ method: route.method, call: route.call, panel, refusal }),
        }),
        'dsh-connect-qwenwork: ' + route.key + ' route',
      )
    }
  })
}
