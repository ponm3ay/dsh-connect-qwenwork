import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthStore } from '../lib/store.mjs'
import { createCatalog } from '../lib/catalog-store.mjs'
import { createModelState } from '../lib/model-state.mjs'
import { createShim } from '../lib/shim.mjs'
import { createPanel } from '../lib/panel.mjs'
import { prepareQwenworkInfer } from '../lib/wasm.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'

const credentials = {
  type: 'oauth',
  access: 'test-access',
  refresh: 'test-refresh',
  uid: '42',
  machineId: 'test-device',
  email: 'test@example.invalid',
  name: 'Test',
  organizationId: '',
  expires: Date.now() + 3600_000,
}

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-switch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A home with a stored login, a catalog and a switch state. */
function fixture(t) {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const modelState = createModelState({ file: join(dir, '.qwenwork-models-off.json') })
  const catalog = createCatalog({ file: join(dir, '.qwenwork-models.json'), state: modelState })
  return { dir, store, modelState, catalog }
}

const frame = (body) => 'data: ' + JSON.stringify({ body: JSON.stringify(body) }) + '\n\n'
const done = 'data: {"body":"[DONE]"}\n\n'
const chunk = (delta, finishReason = null) => ({
  id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

test('a model starts enabled and switching it off is remembered across restarts', (t) => {
  const { dir, modelState } = fixture(t)
  assert.equal(modelState.enabled('qwork-auto'), true)
  assert.equal(modelState.set('qwork-auto', false), false)
  assert.equal(modelState.enabled('qwork-auto'), false)

  // A fresh store over the same file must remember the choice.
  const again = createModelState({ file: join(dir, '.qwenwork-models-off.json') })
  assert.equal(again.enabled('qwork-auto'), false)
  assert.deepEqual(again.disabledIds(), ['qwork-auto'])
})

test('a switched-off model disappears from the picker and from discovery', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  modelState.set('deepseek-flash', false)

  const all = catalog.listAll()
  const on = catalog.listEnabled()
  assert.ok(all.some((model) => model.id === 'deepseek-flash'), 'the catalog still knows the model')
  assert.ok(!on.some((model) => model.id === 'deepseek-flash'), 'the picker must not offer it')

  // The shim's own listing follows the same set. (The pi-ai adapter is covered
  // by scripts/smoke.mjs, which runs against the shipped runtime.)
  const shim = createShim({ store, catalog, runtimeProvider: getRuntime, signer: prepareQwenworkInfer })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/models', { headers: { authorization: 'Bearer ' + shim.secret() } })
    const listing = await response.json()
    assert.ok(!listing.data.some((model) => model.id === 'deepseek-flash'))
    assert.ok(listing.data.some((model) => model.id === 'qwork-auto'))
  } finally {
    shim.close()
  }
})

test('a request for a switched-off model is refused before any inference', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  modelState.set('qwork-auto', false)
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
      body: JSON.stringify({ model: 'qwork-auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /关闭|切换模型/)
    assert.equal(sent, false, 'a switched-off model must never reach upstream')
  } finally {
    shim.close()
  }
})

test('the shim lists only enabled models on /v1/models', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  modelState.set('glm-5.3', false)
  const shim = createShim({ store, catalog, runtimeProvider: getRuntime, signer: prepareQwenworkInfer })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/models', { headers: { authorization: 'Bearer ' + shim.secret() } })
    const listing = await response.json()
    assert.ok(!listing.data.some((model) => model.id === 'glm-5.3'))
    assert.ok(listing.data.some((model) => model.id === 'qwork-auto'))
  } finally {
    shim.close()
  }
})

test('the panel reports and toggles model state', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime })

  const before = await panel.status(new URL('http://127.0.0.1/status'))
  assert.ok(before.models.every((model) => model.enabled === true))
  assert.ok(before.models.some((model) => model.id === 'qwork-auto'))

  const off = panel.setModel({ id: 'qwork-auto', enabled: false })
  assert.equal(off.enabled, false)
  assert.ok(off.models.find((model) => model.id === 'qwork-auto').enabled === false)

  const after = await panel.status(new URL('http://127.0.0.1/status'))
  assert.equal(after.models.find((model) => model.id === 'qwork-auto').enabled, false)

  const on = panel.setModel({ id: 'qwork-auto', enabled: true })
  assert.equal(on.enabled, true)
})

test('the panel refuses to switch a model it does not know', (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime })
  assert.throws(() => panel.setModel({ id: 'not-a-model', enabled: false }), /目录/)
  assert.throws(() => panel.setModel({ enabled: false }), /模型 id/)
})

test('a catalog refresh forgets switch state for models the account dropped', (t) => {
  const { modelState, catalog } = fixture(t)
  modelState.set('qwork-auto', false)
  modelState.set('retired-model', false)
  // The account now only has qwork-auto.
  catalog.adopt(new Map([['qwork-auto', { id: 'qwork-auto', key: 'qwork-auto', name: '千问办公 · 标准', reasoning: true, vision: true }]]))
  assert.deepEqual(modelState.disabledIds(), ['qwork-auto'], 'the retired id must be dropped, the live choice kept')
})

test('switching a model off does not disturb another model already off', (t) => {
  const { modelState } = fixture(t)
  modelState.set('glm-5.3', false)
  modelState.set('kimi-k3.1-pro', false)
  modelState.set('glm-5.3', true)
  assert.deepEqual(modelState.disabledIds(), ['kimi-k3.1-pro'])
})
