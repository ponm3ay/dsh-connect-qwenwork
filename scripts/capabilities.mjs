/**
 * Verify the three per-model overrides reach pi-ai through the real adapter.
 *
 * The unit tests prove the state machine and the envelope; this proves the part
 * only the shipped runtime can answer — that a context window, an image
 * capability and a thinking level land in the model descriptor DSH actually
 * reads, because a descriptor that disagrees with the request is a bug no unit
 * test can see.
 *
 * Run from a directory whose node_modules holds the extracted runtime:
 *   node scripts/capabilities.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthStore } from '../lib/store.mjs'
import { createCatalog } from '../lib/catalog-store.mjs'
import { createModelState } from '../lib/model-state.mjs'
import { createShim } from '../lib/shim.mjs'
import { createAdapter } from '../lib/adapter.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'

const runtime = getRuntime()
const home = mkdtempSync(join(tmpdir(), 'qwenwork-cap-'))
const store = createAuthStore({ dshHome: home, runtimeProvider: () => runtime })
store.save({
  type: 'oauth', access: 'cap-access', refresh: 'cap-refresh', uid: '7',
  machineId: 'cap-machine', email: 'cap@example.invalid', name: 'Cap', organizationId: '',
  expires: Date.now() + 3600_000,
})
const modelState = createModelState({ file: join(home, 'state.json') })
const catalog = createCatalog({ file: join(home, 'catalog.json'), state: modelState })

const frame = (body) => 'data: ' + JSON.stringify({ body: JSON.stringify(body) }) + '\n\n'
const chunk = (delta, finishReason = null) => ({
  id: 'x', object: 'chat.completion.chunk', created: 1,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

let envelope
const shim = createShim({
  store, catalog, runtimeProvider: () => runtime,
  async signer(input) {
    envelope = JSON.parse(input.body)
    return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed' }
  },
  async fetchImpl() {
    return new Response(frame(chunk({ content: 'ok' }, 'stop')) + 'data: {"body":"[DONE]"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  },
})
await shim.ready

const built = createAdapter({ shim, catalog, providerId: 'qwenwork', displayName: '千问办公 (QwenWork)' })

// ---- 1. the default descriptor ---------------------------------------------
{
  const resolved = await built.adapter.resolveModel('qwenwork', 'qwork-auto')
  console.log('default qwork-auto:', JSON.stringify(resolved.context), JSON.stringify(resolved.inputModalities))
  if (resolved.context.contextWindow !== 1_000_000) throw new Error('the default context window must be 1M')
  if (!resolved.inputModalities.includes('image')) throw new Error('qwork-auto advertises vision')
  const efforts = (resolved.reasoning?.efforts ?? []).map((effort) => effort.id)
  console.log('default efforts:', efforts.join(', '))
  // `off` must be selectable: it is how the user turns thinking off, and DSH
  // refuses an explicit `off` when the model does not advertise it.
  if (!efforts.includes('off')) throw new Error('off must be offered, or thinking can never be turned off')
  if (!efforts.includes('high')) throw new Error('high must be offered')
}

// ---- 2. a context override reaches DSH -------------------------------------
{
  modelState.setContextWindow('qwork-auto', 500_000)
  const resolved = await built.adapter.resolveModel('qwenwork', 'qwork-auto')
  console.log('context override:', resolved.context.contextWindow)
  if (resolved.context.contextWindow !== 500_000) throw new Error('the context override must reach DSH')
  modelState.setContextWindow('qwork-auto', undefined)
  const back = await built.adapter.resolveModel('qwenwork', 'qwork-auto')
  if (back.context.contextWindow !== 1_000_000) throw new Error('clearing must restore the catalog value')
  console.log('context restored:', back.context.contextWindow)
}

// ---- 3. an image override reaches DSH, both directions ---------------------
{
  // The catalog says ling-3.1-flash is text-only.
  const before = await built.adapter.resolveModel('qwenwork', 'ling-3.1-flash')
  if (before.inputModalities.includes('image')) throw new Error('ling-3.1-flash is text-only in the catalog')
  modelState.setImage('ling-3.1-flash', true)
  const after = await built.adapter.resolveModel('qwenwork', 'ling-3.1-flash')
  console.log('image opt-in:', after.inputModalities.join(','))
  if (!after.inputModalities.includes('image')) throw new Error('an image opt-in must reach DSH')
  modelState.setImage('ling-3.1-flash', undefined)

  // And the other direction: a vision model kept text-only.
  modelState.setImage('qwork-auto', false)
  const kept = await built.adapter.resolveModel('qwenwork', 'qwork-auto')
  console.log('image opt-out:', kept.inputModalities.join(','))
  if (kept.inputModalities.includes('image')) throw new Error('an image opt-out must reach DSH')
  modelState.setImage('qwork-auto', undefined)
}

// ---- 4. a thinking override is carried, and a request uses it --------------
{
  modelState.setEffort('qwork-auto', 'low')
  const resolved = await built.adapter.resolveModel('qwenwork', 'qwork-auto')
  console.log('effort default for qwork-auto:', JSON.stringify(resolved.reasoning?.defaultEffort))
  if (resolved.reasoning?.defaultEffort !== 'low') throw new Error('the effort override must become the model default')

  // Drive one request at that level and read the signed envelope.
  const call = await built.adapter.prepareCall('qwenwork', 'qwork-auto')
  for await (const event of call.stream({
    provider: 'qwenwork',
    model: 'qwork-auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    reasoningEffort: 'low',
    signal: new AbortController().signal,
  })) void event
  console.log('envelope is_reasoning at low:', envelope.model_config.is_reasoning)
  if (envelope.model_config.is_reasoning !== true) throw new Error('a thinking level must enable the upstream switch')

  // And `off` must leave it out.
  for await (const event of call.stream({
    provider: 'qwenwork',
    model: 'qwork-auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    reasoningEffort: 'off',
    signal: new AbortController().signal,
  })) void event
  console.log('envelope is_reasoning at off:', envelope.model_config.is_reasoning)
  if (envelope.model_config.is_reasoning !== false) throw new Error('off must disable the upstream switch')
}

// ---- 5. a switched-off model leaves the picker -----------------------------
{
  modelState.set('qwork-auto', false)
  const models = await built.adapter.listModels('qwenwork')
  if (models.some((model) => model.id === 'qwork-auto')) throw new Error('a switched-off model must leave the picker')
  console.log('picker after switching qwork-auto off:', models.length, 'models')
}

console.log('CAPABILITIES OK')
shim.close()
rmSync(home, { recursive: true, force: true })
