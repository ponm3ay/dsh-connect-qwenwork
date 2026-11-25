import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthStore } from '../lib/store.mjs'
import { createCatalog } from '../lib/catalog-store.mjs'
import { createModelState, CONTEXT_CHOICES } from '../lib/model-state.mjs'
import { resolveModel, effortChoices } from '../lib/model-resolve.mjs'
import { createShim } from '../lib/shim.mjs'
import { createPanel } from '../lib/panel.mjs'
import { prepareQwenworkInfer } from '../lib/wasm.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'
import { ADAPTER_CONTEXT_WINDOW } from '../lib/constants.mjs'

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

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-cap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const modelState = createModelState({ file: join(dir, '.qwenwork-models.json') })
  const catalog = createCatalog({ file: join(dir, '.qwenwork-models.json.catalog'), state: modelState })
  return { dir, store, modelState, catalog }
}

const frame = (body) => 'data: ' + JSON.stringify({ body: JSON.stringify(body) }) + '\n\n'
const done = 'data: {"body":"[DONE]"}\n\n'
const chunk = (delta, finishReason = null) => ({
  id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

// ---- resolution ------------------------------------------------------------

test('a model with no overrides follows the catalog', () => {
  const entry = { id: 'deepseek-flash', key: 'deepseek-flash', name: 'DeepSeek', reasoning: true, vision: true }
  const resolved = resolveModel(entry, {})
  assert.equal(resolved.vision, true)
  assert.equal(resolved.contextWindow, ADAPTER_CONTEXT_WINDOW)
  assert.equal(resolved.effort, undefined)
  assert.equal(resolved.reasoning, true)
})

test('the image override works in both directions', () => {
  const textOnly = { id: 'a', key: 'a', name: 'A', reasoning: true, vision: false }
  const vision = { id: 'b', key: 'b', name: 'B', reasoning: true, vision: true }
  // A catalog that says text-only can be opted into images.
  assert.equal(resolveModel(textOnly, { image: true }).vision, true)
  // A catalog that claims vision can be kept text-only.
  assert.equal(resolveModel(vision, { image: false }).vision, false)
  // Absent means follow the catalog.
  assert.equal(resolveModel(vision, {}).vision, true)
  assert.equal(resolveModel(textOnly, {}).vision, false)
})

test('the context override replaces the advertised default', () => {
  const entry = { id: 'a', key: 'a', name: 'A', reasoning: true, vision: true }
  assert.equal(resolveModel(entry, { contextWindow: 200_000 }).contextWindow, 200_000)
  assert.equal(resolveModel(entry, { contextWindow: 2_000_000 }).contextWindow, 2_000_000)
  // A nonsense value falls back rather than shrinking the budget to nothing.
  assert.equal(resolveModel(entry, { contextWindow: -1 }).contextWindow, ADAPTER_CONTEXT_WINDOW)
  assert.equal(resolveModel(entry, { contextWindow: 1.5 }).contextWindow, ADAPTER_CONTEXT_WINDOW)
})

test('the effort override is reported, and an unknown level is ignored', () => {
  const entry = { id: 'a', key: 'a', name: 'A', reasoning: true, vision: true }
  assert.equal(resolveModel(entry, { effort: 'low' }).effort, 'low')
  assert.equal(resolveModel(entry, { effort: 'off' }).effort, 'off')
  assert.equal(resolveModel(entry, { effort: 'nonsense' }).effort, undefined)
  assert.equal(resolveModel(entry, {}).effort, undefined)
})

test('a model that does not reason offers no thinking levels', () => {
  const thinking = { id: 'a', key: 'a', name: 'A', reasoning: true, vision: true }
  const plain = { id: 'b', key: 'b', name: 'B', reasoning: false, vision: true }
  assert.deepEqual(effortChoices(thinking), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(effortChoices(plain), [])
})

test('reasoning stays a catalog fact even when the user overrides the level', () => {
  const entry = { id: 'a', key: 'a', name: 'A', reasoning: false, vision: true }
  // Asking for a level on a non-reasoning model does not make it reason.
  const resolved = resolveModel(entry, { effort: 'high' })
  assert.equal(resolved.reasoning, false)
})

// ---- persistence -----------------------------------------------------------

test('each override is written, read back and cleared independently', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-persist-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, '.qwenwork-models.json')
  const state = createModelState({ file })

  state.setContextWindow('m1', 500_000)
  state.setImage('m1', true)
  state.setEffort('m1', 'low')
  assert.deepEqual(state.overridesOf('m1'), { contextWindow: 500_000, image: true, effort: 'low' })

  // A fresh store over the same file sees all three.
  const again = createModelState({ file })
  assert.deepEqual(again.overridesOf('m1'), { contextWindow: 500_000, image: true, effort: 'low' })

  // Clearing one field leaves the others alone.
  again.setContextWindow('m1', undefined)
  assert.deepEqual(again.overridesOf('m1'), { image: true, effort: 'low' })

  // Clearing the last field drops the entry entirely.
  again.setImage('m1', undefined)
  again.setEffort('m1', '')
  assert.deepEqual(again.overridesOf('m1'), {})
})

test('an override of the catalog default is not stored as a pinned value', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-default-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = createModelState({ file: join(dir, 's.json') })
  state.setContextWindow('m1', ADAPTER_CONTEXT_WINDOW)
  // It IS stored: the user chose it explicitly. The point is that clearing it
  // removes the pin, so a later catalog change is not silently overridden.
  assert.equal(state.overridesOf('m1').contextWindow, ADAPTER_CONTEXT_WINDOW)
  state.setContextWindow('m1', undefined)
  assert.equal(state.overridesOf('m1').contextWindow, undefined)
})

test('a file written by the previous version still loads its switch list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, '.qwenwork-models-off.json')
  writeFileSync(file, JSON.stringify(['glm-5.3', 'kimi-k3.1-pro']))
  const state = createModelState({ file })
  assert.equal(state.enabled('glm-5.3'), false)
  assert.equal(state.enabled('qwork-auto'), true)
  assert.deepEqual(state.disabledIds().sort(), ['glm-5.3', 'kimi-k3.1-pro'])
})

test('the old switch file is read as the new state, and the new file wins once written', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-migrate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, '.qwenwork-models.json')
  writeFileSync(file, JSON.stringify({ off: ['glm-5.3'], models: { 'qwork-auto': { contextWindow: 500_000 } } }))
  const state = createModelState({ file })
  assert.equal(state.enabled('glm-5.3'), false)
  assert.equal(state.enabled('kimi-k3.1-pro'), true)
  assert.deepEqual(state.overridesOf('qwork-auto'), { contextWindow: 500_000 })
})

test('bad values are refused rather than stored', (t) => {
  const { modelState } = fixture(t)
  assert.throws(() => modelState.setContextWindow('m1', 0), /正整数/)
  assert.throws(() => modelState.setContextWindow('m1', -5), /正整数/)
  assert.throws(() => modelState.setEffort('m1', 'turbo'), /思考强度/)
  assert.throws(() => modelState.setImage('m1', 'yes'), /布尔/)
})

// ---- the catalog hands out resolved models --------------------------------

test('the catalog exposes resolved models, not raw entries', (t) => {
  const { modelState, catalog } = fixture(t)
  modelState.setContextWindow('qwork-auto', 500_000)
  modelState.setImage('ling-3.1-flash', true)

  const resolved = catalog.listResolved()
  const auto = resolved.find((model) => model.id === 'qwork-auto')
  assert.equal(auto.contextWindow, 500_000, 'the override reaches the resolved model')

  const ling = resolved.find((model) => model.id === 'ling-3.1-flash')
  assert.equal(ling.vision, true, 'a text-only model can be opted into images')

  // The raw catalog entry is untouched.
  assert.equal(catalog.get('qwork-auto').contextWindow, undefined)
})

test('a switched-off model is absent from the resolved list', (t) => {
  const { modelState, catalog } = fixture(t)
  modelState.set('qwork-auto', false)
  assert.ok(!catalog.listResolved().some((model) => model.id === 'qwork-auto'))
  assert.equal(catalog.resolved('qwork-auto'), undefined)
})

// ---- the shim honours the image override ----------------------------------

test('an image sent to a text-only-configured model is refused before inference', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  // The catalog says qwen4-max takes images; the user says it does not.
  modelState.setImage('qwen4-max', false)
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
        model: 'qwen4-max',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        }],
      }),
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /图片/)
    assert.equal(sent, false, 'an image must never reach a text-only-configured model')
  } finally {
    shim.close()
  }
})

test('the image override reaches the signed envelope', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  // The catalog says ling-3.1-flash is text-only; the user opts it into images.
  modelState.setImage('ling-3.1-flash', true)
  let envelope
  const shim = createShim({
    store, catalog, runtimeProvider: getRuntime,
    async signer(input) {
      envelope = JSON.parse(input.body)
      return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed' }
    },
    async fetchImpl() {
      return new Response(frame(chunk({ content: 'ok' }, 'stop')) + done,
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ling-3.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(envelope.model_config.is_vl, true, 'the override must reach the upstream is_vl flag')
  } finally {
    shim.close()
  }
})

// ---- the panel writes all three -------------------------------------------

test('the panel writes each capability and reports the catalog value it overrode', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime })

  const before = await panel.status(new URL('http://127.0.0.1/status'))
  const auto = before.models.find((model) => model.id === 'qwork-auto')
  assert.equal(auto.contextWindow, ADAPTER_CONTEXT_WINDOW)
  assert.equal(auto.catalogContextWindow, ADAPTER_CONTEXT_WINDOW)
  assert.equal(auto.overridden.contextWindow, false)

  const after = panel.setModel({ id: 'qwork-auto', contextWindow: 500_000 })
  const updated = after.models.find((model) => model.id === 'qwork-auto')
  assert.equal(updated.contextWindow, 500_000)
  assert.equal(updated.overridden.contextWindow, true)
  assert.equal(updated.catalogContextWindow, ADAPTER_CONTEXT_WINDOW, 'the catalog value is still reported')

  // Image and effort in the same call.
  const both = panel.setModel({ id: 'qwork-auto', image: false, effort: 'low' })
  const bothModel = both.models.find((model) => model.id === 'qwork-auto')
  assert.equal(bothModel.vision, false)
  assert.equal(bothModel.effort, 'low')

  // Clearing puts it back on the catalog.
  const cleared = panel.setModel({ id: 'qwork-auto', contextWindow: null, image: null, effort: null })
  const clearedModel = cleared.models.find((model) => model.id === 'qwork-auto')
  assert.equal(clearedModel.contextWindow, ADAPTER_CONTEXT_WINDOW)
  assert.equal(clearedModel.vision, true)
  assert.equal(clearedModel.effort, '')
  assert.deepEqual(clearedModel.overridden, { contextWindow: false, image: false, effort: false })
})

test('the panel reports the choices it offers', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime })
  const status = await panel.status(new URL('http://127.0.0.1/status'))
  const choices = panel.describeChoices()
  assert.deepEqual(choices.contextWindows, CONTEXT_CHOICES)
  assert.ok(choices.efforts.includes('off'))
  assert.ok(choices.efforts.includes('high'))
  assert.equal(choices.defaultContextWindow, ADAPTER_CONTEXT_WINDOW)
  // The status carries the same choice list so one fetch paints the whole page.
  assert.ok(Array.isArray(status.models))
})

test('a capability write on an unknown model is refused', (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime })
  assert.throws(() => panel.setModel({ id: 'nope', contextWindow: 500_000 }), /目录/)
})
