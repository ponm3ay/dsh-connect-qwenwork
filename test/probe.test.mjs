import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeModel, probeModels, probeAccount, probeBody, isNegative, isInconclusive } from '../lib/probe.mjs'
import { createAuthStore } from '../lib/store.mjs'
import { createCatalog } from '../lib/catalog-store.mjs'
import { createModelState } from '../lib/model-state.mjs'
import { createPanel } from '../lib/panel.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'

const credentials = {
  type: 'oauth', access: 'probe-access', refresh: 'probe-refresh', uid: '9',
  machineId: 'probe-machine', email: 'probe@example.invalid', name: 'Probe', organizationId: '',
  expires: Date.now() + 3600_000,
}

const runtime = getRuntime()

/** A model as the catalog resolves it. */
const model = (id, extra = {}) => ({
  id, key: id, name: id, reasoning: true, vision: true,
  contextWindow: 1_000_000, effort: undefined, overrides: {}, ...extra,
})

/** A stub signer that records what it was asked to sign. */
function stubSigner(seen) {
  return async (input) => {
    if (seen) {
      seen.push({ modelKey: input.modelKey, body: JSON.parse(input.body), accessToken: input.accessToken })
    }
    return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed' }
  }
}

/** A body that yields `bytes` then ends. */
function streamOf(text) {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A stream that carries a real model delta, which is what "answered" means. */
function answerStream(text = 'ok') {
  return streamOf('data: {"body":"' + JSON.stringify({ choices: [{ delta: { content: text } }] }).replace(/"/g, '\\"') + '"}\n\n')
}

// ---- the request a probe sends ---------------------------------------------

test('a probe body is minimal: one user turn, one token of room, no tools', () => {
  const body = probeBody(model('deepseek-flash'))
  assert.equal(body.stream, true)
  assert.deepEqual(body.tools, [])
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.messages[0].content, 'ping')
  assert.ok(body.parameters.max_tokens <= 8, 'the probe must cap its output to almost nothing')
  // Reasoning stays off: a probe asks "can you answer", not "how well do you think".
  assert.equal(body.model_config.is_reasoning, false)
  assert.equal(body.model_config.key, 'deepseek-flash')
})

test('the probe envelope reflects the model vision flag', () => {
  assert.equal(probeBody(model('vision', { vision: true })).model_config.is_vl, true)
  assert.equal(probeBody(model('text', { vision: false })).model_config.is_vl, false)
})

test('a probe sends one signed request to the same destination a chat uses', async () => {
  const seen = []
  const result = await probeModel({
    model: model('deepseek-flash'),
    credentials,
    runtime,
    signer: stubSigner(seen),
    fetchImpl: async () => answerStream('ok'),
  })
  assert.equal(result.verdict, 'available')
  assert.equal(seen.length, 1, 'exactly one request')
  assert.equal(seen[0].modelKey, 'deepseek-flash')
  assert.equal(seen[0].accessToken, credentials.access)
})

// ---- one byte is the whole test --------------------------------------------

test('a probe keeps reading past the transport envelope until the model speaks', async () => {
  // The live gateway sends `data:{"headers":…}` first, then the model's chunk.
  // Stopping at the first byte would call every reachable model "available".
  const frames = [
    'data: {"headers":{"Content-Type":["application/json"]}}\n\n',
    'data: {"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"好\\"}}]}"}\n\n',
    'data: {"body":"[DONE]"}\n\n',
  ]
  let index = 0
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        if (index >= frames.length) return controller.close()
        controller.enqueue(new TextEncoder().encode(frames[index++]))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  assert.equal(result.verdict, 'available')
  assert.equal(result.sample, '好', 'the sample must be the model output, not the envelope')
})

test('envelope-only traffic is "empty", never "available"', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response(
      'data: {"headers":{"Content-Type":["application/json"]}}\n\ndata: {"body":"[DONE]"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  })
  assert.equal(result.verdict, 'empty')
  assert.equal(isNegative(result.verdict), false)
})

test('a probe that never speaks hangs up instead of looping forever', async () => {
  // A stream that keeps sending envelope and never a content delta. Without a
  // cap on bytes READ this loop would never end; the cap is what this asserts.
  let sent = 0
  const started = Date.now()
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    timeoutMs: 5000,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        sent++
        controller.enqueue(new TextEncoder().encode('data: {"headers":{"x":"' + 'y'.repeat(200) + '"}}\n\n'))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  assert.equal(result.verdict, 'empty')
  assert.ok(Date.now() - started < 4000, 'the byte cap must end the read well before the timeout')
})

test('a probe keeps only a short printable sample for diagnostics', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => streamOf('data: {"body":"' + '{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"' + 'x'.repeat(5000) + '\\"}}]}' + '"}\n\n'),
  })
  assert.equal(result.verdict, 'available')
  assert.ok(result.sample.length <= 60, 'the sample must stay short')
})

test('a probe of a stream that ends with no bytes is "empty"', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  assert.equal(result.verdict, 'empty')
  assert.equal(isNegative(result.verdict), false)
})

// ---- verdicts --------------------------------------------------------------

test('a 401 is an auth verdict, and says nothing about the model', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response('{"error":{"message":"登录已失效"}}', { status: 401 }),
  })
  assert.equal(result.verdict, 'auth')
  assert.equal(isNegative(result.verdict), false, 'a bad credential is not a broken model')
})

test('a 429 with a quota message is a quota verdict', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response('{"error":{"message":"积分已用尽"}}', { status: 429 }),
  })
  assert.equal(result.verdict, 'quota')
  assert.equal(isNegative(result.verdict), false)
})

test('a plain 429 is rate limiting, not a broken model', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response('{"error":{"message":"too many requests"}}', { status: 429 }),
  })
  assert.equal(result.verdict, 'rate_limited')
  assert.equal(isInconclusive(result.verdict), true)
})

test('an explicit model refusal is the one negative verdict', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => new Response('{"error":{"message":"不支持的模型"}}', { status: 400 }),
  })
  assert.equal(result.verdict, 'unsupported')
  assert.equal(isNegative(result.verdict), true)
  assert.equal(isInconclusive(result.verdict), false)
})

test('a network failure is inconclusive, never "the model is broken"', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  assert.equal(result.verdict, 'network')
  assert.equal(isNegative(result.verdict), false)
  assert.equal(isInconclusive(result.verdict), true)
})

test('a probe that never answers times out instead of hanging', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    timeoutMs: 60,
    fetchImpl: (input, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
    }),
  })
  assert.equal(result.verdict, 'timeout')
  assert.equal(isInconclusive(result.verdict), true)
})

test('a probe never throws, whatever the transport does', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: async () => { throw new Error('signer exploded') },
    fetchImpl: async () => streamOf(''),
  })
  assert.equal(typeof result.verdict, 'string')
  assert.equal(typeof result.detail, 'string')
})

test('a probe refuses a signer that points somewhere else', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: async () => ({ url: 'https://example.invalid/', headers: {}, body: 'x' }),
    fetchImpl: async () => { throw new Error('must not send to a foreign host') },
  })
  assert.notEqual(result.verdict, 'available')
})

test('a probe reports how long it took', async () => {
  const result = await probeModel({
    model: model('m'),
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => answerStream('ok'),
  })
  assert.equal(typeof result.ms, 'number')
  assert.ok(result.ms >= 0)
})

// ---- several models --------------------------------------------------------

test('probing several models runs them one at a time, in order', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const results = await probeModels({
    models: [model('a'), model('b'), model('c')],
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 5))
      concurrent--
      return answerStream('ok')
    },
  })
  assert.deepEqual(results.map((result) => result.id), ['a', 'b', 'c'])
  assert.equal(maxConcurrent, 1, 'probes must not burst; the gateway throttles')
})

test('probing several reports progress as each lands', async () => {
  const progress = []
  await probeModels({
    models: [model('a'), model('b')],
    credentials,
    runtime,
    signer: stubSigner(),
    fetchImpl: async () => answerStream('ok'),
    onResult: (result, done, total) => progress.push([result.id, done, total]),
  })
  assert.deepEqual(progress, [['a', 1, 2], ['b', 2, 2]])
})

test('a cancelled probe run stops before the next model', async () => {
  const controller = new AbortController()
  let calls = 0
  const results = await probeModels({
    models: [model('a'), model('b'), model('c')],
    credentials,
    runtime,
    signer: stubSigner(),
    signal: controller.signal,
    fetchImpl: async () => {
      calls++
      controller.abort()
      return answerStream('ok')
    },
  })
  assert.equal(calls, 1, 'cancelling must not start the next probe')
  assert.equal(results.length, 1)
})

// ---- the connection button: read-only, costs nothing ----------------------

test('the connection probe reads the account endpoint, not a chat', async () => {
  let seen
  const result = await probeAccount({
    credentials,
    runtime,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), headers: init.headers }
      return Response.json({ user: { id: '9', name: 'Probe', email: 'probe@example.invalid' }, plan: { name: '专业版' } })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'available')
  // The read-only account endpoint, not the inference endpoint: this is what
  // makes the connection test free.
  assert.match(seen.url, /account-context/)
  assert.ok(!seen.url.includes('agent_chat_generation'), 'the connection test must not send a chat')
  assert.equal(seen.headers.Authorization, 'Bearer ' + credentials.access)
  assert.equal(result.account.plan, '专业版')
})

test('the connection probe does not touch any model', async () => {
  // It is handed no model list at all, and still answers: the subject is the
  // credential, so a model would be irrelevant.
  const result = await probeAccount({
    credentials,
    runtime,
    fetchImpl: async () => Response.json({ user: { id: '9' } }),
  })
  assert.equal(result.ok, true)
})

test('an expired credential makes the connection probe fail with an auth verdict', async () => {
  const result = await probeAccount({
    credentials,
    runtime,
    fetchImpl: async () => new Response('{"error":{"message":"expired"}}', { status: 401 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'auth')
})

test('a connection probe with no credential says so without calling out', async () => {
  let called = false
  const result = await probeAccount({
    credentials: { access: '' },
    runtime,
    fetchImpl: async () => { called = true; return Response.json({}) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'auth')
  assert.equal(called, false)
})

test('a connection probe that never answers times out', async () => {
  const result = await probeAccount({
    credentials,
    runtime,
    timeoutMs: 60,
    fetchImpl: (input, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'timeout')
})

test('a connection probe treats an unparseable answer as a network problem', async () => {
  const result = await probeAccount({
    credentials,
    runtime,
    fetchImpl: async () => new Response('not json', { status: 200 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'network')
})

// ---- the panel routes ------------------------------------------------------

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-probe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const modelState = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state: modelState })
  return { dir, store, modelState, catalog }
}

test('the panel refuses to test while signed out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-probe-out-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  const modelState = createModelState({ file: join(dir, 'state.json') })
  const catalog = createCatalog({ file: join(dir, 'catalog.json'), state: modelState })
  const panel = createPanel({
    store, catalog, modelState, runtimeProvider: getRuntime,
    signer: async () => { throw new Error('must not sign while signed out') },
  })
  await assert.rejects(() => panel.testAccount(), /登录/)
  await assert.rejects(() => panel.testModels({}), /登录/)
})

test('the panel tests one named model', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({
    store, catalog, modelState, runtimeProvider: getRuntime, signer: stubSigner(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async () => answerStream('ok')
  try {
    const result = await panel.testModels({ id: 'deepseek-flash' })
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].id, 'deepseek-flash')
    assert.equal(result.summary.total, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('the panel tests every enabled model and skips the switched-off ones', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  modelState.set('glm-5.3', false)
  modelState.set('kimi-k3.1-pro', false)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime, signer: stubSigner() })
  const original = globalThis.fetch
  globalThis.fetch = async () => answerStream('ok')
  try {
    const enabled = catalog.listResolved().length
    const result = await panel.testModels({})
    assert.equal(result.results.length, enabled, 'only enabled models are probed')
    assert.ok(!result.results.some((entry) => entry.id === 'glm-5.3'))
    assert.equal(result.summary.available, enabled)
    assert.equal(result.summary.failed, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('the panel refuses to test a model that is switched off or unknown', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  modelState.set('glm-5.3', false)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime, signer: stubSigner() })
  await assert.rejects(() => panel.testModels({ id: 'glm-5.3' }), /目录/)
  await assert.rejects(() => panel.testModels({ id: 'not-a-model' }), /目录/)
})

test('the panel counts failures separately from successes', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime, signer: stubSigner() })
  const original = globalThis.fetch
  let call = 0
  globalThis.fetch = async () => {
    call++
    if (call === 1) return answerStream('ok')
    return new Response('{"error":{"message":"不支持"}}', { status: 400 })
  }
  try {
    const result = await panel.testModels({})
    assert.equal(result.summary.total, result.results.length)
    assert.equal(result.summary.available, 1)
    assert.equal(result.summary.failed, result.results.length - 1)
  } finally {
    globalThis.fetch = original
  }
})

test('the panel connection test reads the account, not a model', async (t) => {
  const { store, modelState, catalog } = fixture(t)
  const panel = createPanel({ store, catalog, modelState, runtimeProvider: getRuntime, signer: stubSigner() })
  const original = globalThis.fetch
  let calledUrl
  globalThis.fetch = async (url) => {
    calledUrl = String(url)
    return Response.json({ user: { id: '42', email: 'probe@example.invalid' } })
  }
  try {
    const result = await panel.testAccount()
    assert.equal(result.ok, true)
    assert.match(calledUrl, /account-context/)
    assert.ok(!calledUrl.includes('agent_chat_generation'))
  } finally {
    globalThis.fetch = original
  }
})
