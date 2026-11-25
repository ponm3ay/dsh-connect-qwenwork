/**
 * End-to-end smoke test against the exact packages the installed DSH ships.
 *
 * It builds the real adapter (PiAiAdapter + pi-ai openai-completions) over the
 * real loopback shim, then drives one chat through pi-ai's own stream path with
 * a stub upstream. This is the test that proves the DSH seam is wired right:
 * the plugin's own unit tests deliberately stub the signer, so they cannot see
 * whether pi-ai's request shape survives the trip.
 *
 * Run from a directory whose node_modules holds the extracted runtime:
 *   node scripts/smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthStore } from '../lib/store.mjs'
import { createCatalog } from '../lib/catalog-store.mjs'
import { createShim } from '../lib/shim.mjs'
import { createAdapter } from '../lib/adapter.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'

const runtime = getRuntime()
const home = mkdtempSync(join(tmpdir(), 'qwenwork-smoke-'))
const store = createAuthStore({ dshHome: home, runtimeProvider: () => runtime })
store.save({
  type: 'oauth',
  access: 'smoke-access',
  refresh: 'smoke-refresh',
  uid: '99',
  machineId: 'smoke-machine',
  email: 'smoke@example.invalid',
  name: 'Smoke',
  organizationId: '',
  expires: Date.now() + 3600_000,
})
const catalog = createCatalog({})

const frame = (body) => 'data: ' + JSON.stringify({ body: JSON.stringify(body) }) + '\n\n'
const chunk = (delta, finishReason = null) => ({
  id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

let upstreamBody
let upstreamHeaders
const shim = createShim({
  store,
  catalog,
  runtimeProvider: () => runtime,
  // Stub the signer so the plaintext envelope pi-ai produced is observable.
  async signer(input) {
    upstreamBody = JSON.parse(input.body)
    return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed' }
  },
  async fetchImpl() {
    return new Response(
      frame(chunk({ role: 'assistant', content: '你好' })) +
      frame(chunk({ content: '，世界' })) +
      frame(chunk({}, 'stop')) +
      'data: {"body":"[DONE]"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
await shim.ready

const built = createAdapter({ shim, catalog, providerId: 'qwenwork', displayName: '千问办公 (QwenWork)' })

// 1. The adapter describes the route the way DSH's registry expects.
const info = built.adapter.providerInfo('qwenwork')
console.log('providerInfo:', JSON.stringify(info))
if (info.id !== 'qwenwork' || !info.name) throw new Error('providerInfo must preserve id and name')

const models = await built.adapter.listModels('qwenwork')
console.log('listModels:', models.length, 'models; first =', JSON.stringify(models[0]))
if (models.length === 0) throw new Error('listModels must offer the catalog')

const resolved = await built.adapter.resolveModel('qwenwork', 'deepseek-flash')
console.log('resolveModel:', JSON.stringify(resolved))
if (resolved.id !== 'deepseek-flash') throw new Error('resolveModel must describe the requested model')

// 2. Drive one chat through the adapter's own stream path.
const call = await built.adapter.prepareCall('qwenwork', 'deepseek-flash')
const text = []
let reasoning
let finished
for await (const event of call.stream({
  provider: 'qwenwork',
  model: 'deepseek-flash',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ],
  tools: [],
  reasoningEffort: 'high',
  signal: new AbortController().signal,
})) {
  if (event.type === 'text-delta' && typeof event.text === 'string') text.push(event.text)
  if (event.type === 'reasoning-delta') reasoning = (reasoning ?? '') + (event.text ?? '')
  if (event.type === 'finish') finished = event.reason ?? true
}
console.log('streamed text:', JSON.stringify(text.join('')))
console.log('finish:', JSON.stringify(finished))

// 3. What pi-ai actually asked the shim for.
console.log('upstream model_config:', JSON.stringify(upstreamBody.model_config))
console.log('upstream max_tokens:', upstreamBody.parameters.max_tokens)
console.log('upstream is_reasoning:', upstreamBody.model_config.is_reasoning)
console.log('upstream system:', JSON.stringify(upstreamBody.system || '').slice(0, 120))

if (text.join('') !== '你好，世界') throw new Error('the streamed text did not survive the adapter: ' + JSON.stringify(text.join('')))
if (upstreamBody.model_config.key !== 'deepseek-flash') throw new Error('the upstream request named the wrong model key')
if (upstreamBody.model_config.is_reasoning !== true) throw new Error('a reasoning level must enable the reasoning switch')
if (!(upstreamBody.parameters.max_tokens > 0)) throw new Error('the request must carry a positive output budget')
if (upstreamHeaders !== undefined) throw new Error('unexpected header capture')

console.log('SMOKE OK')
shim.close()
rmSync(home, { recursive: true, force: true })
