import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCatalog } from '../lib/catalog-store.mjs'
import { createModelState } from '../lib/model-state.mjs'
import { createShim } from '../lib/shim.mjs'
import { createAuthStore } from '../lib/store.mjs'
import { createPanel } from '../lib/panel.mjs'
import { prepareQwenworkInfer } from '../lib/wasm.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'
import { parseCatalog } from '../lib/catalog.mjs'
import { ADAPTER_CONTEXT_WINDOW } from '../lib/constants.mjs'

const credentials = {
  type: 'oauth', access: 'test-access', refresh: 'test-refresh', uid: '42',
  machineId: 'test-device', email: 'test@example.invalid', name: 'Test', organizationId: '',
  expires: Date.now() + 3600_000,
}

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-refresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A catalog row as the gateway sends it. */
const row = (key, extra = {}) => ({
  key,
  enable: true,
  source: 'system',
  format: 'openai/chat-completions',
  ...extra,
})

/**
 * A refresh response. `catalog.refresh()` calls the real fetchCatalog, so the
 * payload has to look like the gateway's: schema v2 plus a catalog array.
 */
function refreshPayload(rows) {
  return { schema_version: 2, catalog: rows }
}

const auth = { access: 'x', refresh: 'y', uid: '1', machineId: 'm' }

// ---- parseCatalog: the capability fields ----------------------------------

test('parseCatalog reads is_vl and is_reasoning off each row', () => {
  const models = parseCatalog(refreshPayload([
    row('vision-reasoning', { is_vl: true, is_reasoning: true }),
    row('vision-only', { is_vl: true, is_reasoning: false }),
    row('text-reasoning', { is_vl: false, is_reasoning: true }),
    row('text-only', { is_vl: false, is_reasoning: false }),
  ]))
  assert.equal(models.get('vision-reasoning').vision, true)
  assert.equal(models.get('vision-reasoning').reasoning, true)
  assert.equal(models.get('vision-only').vision, true)
  assert.equal(models.get('vision-only').reasoning, false)
  assert.equal(models.get('text-reasoning').vision, false)
  assert.equal(models.get('text-reasoning').reasoning, true)
  assert.equal(models.get('text-only').vision, false)
  assert.equal(models.get('text-only').reasoning, false)
})

test('a row that says nothing about a capability is treated as not having it', () => {
  const models = parseCatalog(refreshPayload([row('silent')]))
  const model = models.get('silent')
  // `=== true` is deliberate: an absent or non-boolean flag must not be read as
  // "yes". Over-claiming vision admits an image the model then rejects mid-turn.
  assert.equal(model.vision, false)
  assert.equal(model.reasoning, false)
})

test('a non-boolean capability flag is not read as true', () => {
  const models = parseCatalog(refreshPayload([
    row('stringly', { is_vl: 'true', is_reasoning: 1 }),
  ]))
  assert.equal(models.get('stringly').vision, false)
  assert.equal(models.get('stringly').reasoning, false)
})

test('parseCatalog keeps the display name and the upstream key', () => {
  const models = parseCatalog(refreshPayload([
    row('named-model', { is_vl: true, i18n: { display_name: { zh: '中文名', en: 'English' } } }),
    row('unnamed-model', { is_vl: false }),
  ]))
  assert.equal(models.get('named-model').name, '中文名')
  assert.equal(models.get('named-model').key, 'named-model')
  // A row with no display name falls back to its key rather than an empty label.
  assert.equal(models.get('unnamed-model').name, 'unnamed-model')
})

// ---- refresh: models that did not exist before ----------------------------

test('a refresh that adds models gives the new ones their own capabilities', async (t) => {
  const dir = tempHome(t)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  // Start from the built-in fallback catalog, which has no such ids.
  assert.equal(catalog.get('brand-new-vision'), undefined)
  assert.equal(catalog.get('brand-new-text'), undefined)

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('qwork-auto', { is_vl: true, is_reasoning: true }),
      row('brand-new-vision', { is_vl: true, is_reasoning: true, i18n: { display_name: { zh: '新视觉模型' } } }),
      row('brand-new-text', { is_vl: false, is_reasoning: false, i18n: { display_name: { zh: '新纯文本模型' } } }),
    ])),
  })

  const vision = catalog.resolved('brand-new-vision')
  const text = catalog.resolved('brand-new-text')
  assert.equal(vision.vision, true, 'a newly added vision model must keep its vision')
  assert.equal(vision.reasoning, true)
  assert.equal(vision.name, '新视觉模型')
  assert.equal(text.vision, false, 'a newly added text-only model must not be given vision')
  assert.equal(text.reasoning, false)
  // Neither has an override, so both follow the catalog's context default.
  assert.equal(vision.contextWindow, ADAPTER_CONTEXT_WINDOW)
  assert.equal(text.contextWindow, ADAPTER_CONTEXT_WINDOW)
})

test('a new model appears in the picker with the capability the catalog reports', async (t) => {
  const dir = tempHome(t)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('brand-new-vision', { is_vl: true, is_reasoning: true }),
      row('brand-new-text', { is_vl: false, is_reasoning: true }),
    ])),
  })

  const resolved = catalog.listResolved()
  assert.deepEqual(resolved.map((model) => model.id).sort(), ['brand-new-text', 'brand-new-vision'])
  assert.equal(resolved.find((model) => model.id === 'brand-new-vision').vision, true)
  assert.equal(resolved.find((model) => model.id === 'brand-new-text').vision, false)
})

test('a new model is enabled by default and can then be configured', async (t) => {
  const dir = tempHome(t)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('brand-new-model', { is_vl: false, is_reasoning: true }),
    ])),
  })

  // Enabled, with no overrides.
  assert.equal(state.enabled('brand-new-model'), true)
  assert.deepEqual(state.overridesOf('brand-new-model'), {})
  assert.equal(catalog.resolved('brand-new-model').vision, false)

  // The user can now opt it into images, exactly like a built-in model.
  state.setImage('brand-new-model', true)
  assert.equal(catalog.resolved('brand-new-model').vision, true)

  // And switch it off.
  state.set('brand-new-model', false)
  assert.equal(catalog.resolved('brand-new-model'), undefined)
})

test('a model that survives a refresh keeps its user overrides', async (t) => {
  const dir = tempHome(t)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('survivor', { is_vl: false, is_reasoning: true }),
    ])),
  })
  state.setContextWindow('survivor', 500_000)
  state.setImage('survivor', true)
  state.setEffort('survivor', 'low')

  // Refresh again; the model is still there, and the upstream now disagrees
  // about vision — the user's explicit choice must win.
  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('survivor', { is_vl: false, is_reasoning: true }),
      row('added-later', { is_vl: true, is_reasoning: false }),
    ])),
  })

  const survivor = catalog.resolved('survivor')
  assert.equal(survivor.contextWindow, 500_000, 'the context override survives a refresh')
  assert.equal(survivor.vision, true, 'the image override survives a refresh')
  assert.equal(survivor.effort, 'low', 'the effort override survives a refresh')
  // The new model arrives clean.
  assert.deepEqual(state.overridesOf('added-later'), {})
})

test('a model dropped by a refresh takes its overrides with it', async (t) => {
  const dir = tempHome(t)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('temporary', { is_vl: true, is_reasoning: true }),
    ])),
  })
  state.setImage('temporary', false)
  state.set('temporary', false)

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('qwork-auto', { is_vl: true, is_reasoning: true }),
    ])),
  })

  assert.equal(catalog.get('temporary'), undefined)
  assert.deepEqual(state.overridesOf('temporary'), {}, 'a dropped model must not leave overrides behind')
  assert.deepEqual(state.disabledIds(), [], 'a dropped model must not leave a switch behind')
})

// ---- the refresh reaches the panel and the shim ---------------------------

test('the panel reports a newly refreshed model with its capability', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })
  const panel = createPanel({ store, catalog, modelState: state, runtimeProvider: getRuntime })

  // The panel's own refresh route is what a user clicks.
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json(refreshPayload([
    row('fresh-vision', { is_vl: true, is_reasoning: true, i18n: { display_name: { zh: '刚上线' } } }),
    row('fresh-text', { is_vl: false, is_reasoning: true, i18n: { display_name: { zh: '刚上线纯文本' } } }),
  ]))
  try {
    const result = await panel.refreshModels()
    assert.ok(result.models.some((model) => model.id === 'fresh-vision'))
    const fresh = result.models.find((model) => model.id === 'fresh-vision')
    assert.equal(fresh.vision, true, 'the panel must report the new model vision')
    assert.equal(fresh.catalogVision, true)
    assert.equal(fresh.overridden.image, false)
    const text = result.models.find((model) => model.id === 'fresh-text')
    assert.equal(text.vision, false)
  } finally {
    globalThis.fetch = original
  }
})

test('an image sent to a newly refreshed text-only model is refused', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('fresh-text', { is_vl: false, is_reasoning: true }),
    ])),
  })

  let sent = false
  const shim = createShim({
    store, catalog, runtimeProvider: getRuntime, signer: prepareQwenworkInfer,
    fetchImpl: () => { sent = true; return new Response('') },
  })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fresh-text',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        }],
      }),
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /图片/)
    assert.equal(sent, false)
  } finally {
    shim.close()
  }
})

test('a newly refreshed vision model carries is_vl into the signed envelope', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const state = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state })

  await catalog.refresh(auth, getRuntime(), {
    fetchImpl: async () => Response.json(refreshPayload([
      row('fresh-vision', { is_vl: true, is_reasoning: false }),
    ])),
  })

  let envelope
  const shim = createShim({
    store, catalog, runtimeProvider: getRuntime,
    async signer(input) {
      envelope = JSON.parse(input.body)
      return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed' }
    },
    async fetchImpl() {
      return new Response(
        'data: ' + JSON.stringify({ body: JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) }) + '\n\ndata: {"body":"[DONE]"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fresh-vision', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(envelope.model_config.is_vl, true, 'a refreshed model keeps its vision upstream')
    assert.equal(envelope.model_config.is_reasoning, false, 'a non-reasoning model must not be sent as reasoning')
  } finally {
    shim.close()
  }
})
