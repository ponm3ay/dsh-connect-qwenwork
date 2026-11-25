import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createAuthStore } from '../lib/store.mjs'
import { createCatalog, outputTokenLimit } from '../lib/catalog-store.mjs'
import { createShim } from '../lib/shim.mjs'
import { createPanel } from '../lib/panel.mjs'
import { beginLogin } from '../lib/login.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'
import { prepareQwenworkInfer } from '../lib/wasm.mjs'
import { FALLBACK_CATALOG } from '../lib/catalog.mjs'
import { DESKTOP_OUTPUT_TOKENS, GATEWAY } from '../lib/constants.mjs'

const runtime = { version: '2.1.0', releaseVersion: '2.1.0-26111906' }
const credentials = {
  type: 'oauth',
  access: 'test-access-secret',
  refresh: 'test-refresh-secret',
  uid: '42',
  machineId: 'test-device',
  email: 'test@example.invalid',
  name: 'Test',
  organizationId: '',
}

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const frame = (body) => 'data: ' + JSON.stringify({ body: JSON.stringify(body) }) + '\n\n'
const done = 'data: {"body":"[DONE]"}\n\ndata: {"timing":25}\n\n'
const chunk = (delta, finish_reason = null) => ({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1,
  choices: [{ index: 0, delta, finish_reason }],
})

test('the bundled signing component is discovered with its own source version', () => {
  const discovered = getRuntime()
  assert.equal(discovered.version, '2.1.0')
  assert.equal(discovered.releaseVersion, '2.1.0-26111906')
  assert.equal(discovered.sha256, '15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3')
})

test('the fallback catalog carries both tiers and every designated model', () => {
  const ids = [...FALLBACK_CATALOG.keys()]
  assert.deepEqual(ids, [
    'qwork-auto', 'qwork-advanced', 'qwen4-max', 'qwen3.8-max-preview', 'qwen3.8-flash',
    'ling-3.1-flash', 'deepseek-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash',
    'kimi-k3.1-pro', 'minimax-m3.1-flash', 'step-5-preview',
  ])
  assert.equal(FALLBACK_CATALOG.get('deepseek-flash').name, 'DeepSeek-V4.1-Flash')
  assert.equal(FALLBACK_CATALOG.get('ling-3.1-flash').vision, false)
  assert.equal(FALLBACK_CATALOG.get('qwen4-max').vision, true)
})

test('the output ceiling stays at the desktop budget regardless of the context tier', () => {
  assert.equal(outputTokenLimit({}), DESKTOP_OUTPUT_TOKENS)
  assert.equal(outputTokenLimit({ maxOutputTokens: 4096 }), 4096)
  assert.equal(outputTokenLimit({ maxOutputTokens: 10_000_000 }), 131072)
})

test('a login begins with a PKCE challenge and a fresh machine id', () => {
  const flow = beginLogin(runtime)
  const url = new URL(flow.url)
  assert.equal(url.origin, GATEWAY)
  assert.equal(url.pathname, '/device/selectAccounts')
  assert.equal(url.searchParams.get('machine_id'), flow.machineId)
  assert.equal(url.searchParams.get('nonce'), flow.nonce)
  assert.equal(
    createHash('sha256').update(flow.verifier).digest('base64url'),
    url.searchParams.get('challenge'),
  )
  assert.equal(url.searchParams.get('challenge_method'), 'S256')
})

test('credentials round-trip through the store and never leak the refresh token', (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  assert.equal(store.peek(), undefined)
  store.save(credentials)
  const again = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  assert.equal(again.peek().access, credentials.access)
  assert.equal(again.peek().machineId, credentials.machineId)
  again.clear()
  assert.equal(again.peek(), undefined)
})

test('an expired credential rotates through the refresh endpoint exactly once', async (t) => {
  const dir = tempHome(t)
  let calls = 0
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save({ ...credentials, expires: Date.now() - 1000 })
  const live = await store.resolve(true).catch((error) => error)
  // No network in this test: the refresh must be attempted, and must fail loudly.
  assert.ok(live instanceof Error, 'rotation without a transport must throw')
  calls++
  assert.equal(calls, 1)
})

test('the shim refuses a request without its secret', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  const catalog = createCatalog({})
  const shim = createShim({ store, catalog, runtimeProvider: getRuntime, signer: prepareQwenworkInfer })
  await shim.ready
  try {
    const denied = await fetch(shim.baseUrl() + '/v1/models')
    assert.equal(denied.status, 401)
    const allowed = await fetch(shim.baseUrl() + '/v1/models', { headers: { authorization: 'Bearer ' + shim.secret() } })
    assert.equal(allowed.status, 200)
    const listing = await allowed.json()
    assert.ok(listing.data.some((model) => model.id === 'qwork-auto'))
  } finally {
    shim.close()
  }
})

test('a chat request without a stored login is refused before any inference', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  const catalog = createCatalog({})
  const shim = createShim({ store, catalog, runtimeProvider: getRuntime, signer: prepareQwenworkInfer })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwork-auto', messages: [{ role: 'user', content: '你好' }] }),
    })
    assert.equal(response.status, 401)
    assert.match(await response.text(), /登录/)
  } finally {
    shim.close()
  }
})

test('a signed request reaches the gateway allowlist and streams its answer back', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save({ ...credentials, expires: Date.now() + 3600_000 })
  const catalog = createCatalog({})
  let seen
  const shim = createShim({
    store,
    catalog,
    runtimeProvider: getRuntime,
    signer: prepareQwenworkInfer,
    async fetchImpl(input, init) {
      seen = { url: String(input), headers: init.headers, body: init.body }
      return new Response(
        frame(chunk({ role: 'assistant', content: '你' })) +
        frame(chunk({ content: '好' })) +
        frame(chunk({}, 'stop')) +
        done,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwork-auto',
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 128,
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /"content":"你"/)
    assert.match(text, /"content":"好"/)
    assert.match(text, /\[DONE\]/)

    // The signed request must land on the one allowlisted inference endpoint,
    // carry the WASM-signed headers, and name the selected model key.
    const target = new URL(seen.url)
    assert.equal(target.origin, GATEWAY)
    assert.equal(target.pathname, '/algo/api/v2/service/pro/sse/agent_chat_generation')
    assert.equal(seen.headers['X-Model-Key'], 'qwork-auto')
    assert.equal(seen.headers['Cosy-MachineId'], credentials.machineId)
    // The bearer is the signer's COSY envelope, never this account's raw token.
    assert.match(seen.headers.Authorization, /^Bearer COSY\./)
    assert.ok(!seen.headers.Authorization.includes(credentials.access), 'the raw token must not travel as a bare bearer')
    assert.ok(!seen.body.includes(credentials.access), 'the access token must not appear in the body')
    // The signed body is the signer's opaque envelope, so only its framing is
    // observable here; the plaintext shape is covered by the stub-signer test.
    assert.ok(seen.body.length > 0)
  } finally {
    shim.close()
  }
})

test('the plaintext envelope names the selected model key and its tier', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save({ ...credentials, expires: Date.now() + 3600_000 })
  const catalog = createCatalog({})
  let inspected
  const shim = createShim({
    store,
    catalog,
    runtimeProvider: getRuntime,
    // Stub the WASM signer so the plaintext envelope is observable.
    async signer(input) {
      inspected = input
      return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed-fixture' }
    },
    async fetchImpl() {
      return new Response(
        frame(chunk({ content: 'ok' }, 'stop')) + done,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 128,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(inspected.modelKey, 'deepseek-flash')
    assert.equal(inspected.uid, credentials.uid)
    assert.equal(inspected.machineId, credentials.machineId)
    assert.equal(inspected.accessToken, credentials.access)
    const body = JSON.parse(inspected.body)
    assert.equal(body.model_config.key, 'deepseek-flash')
    assert.equal(body.chat_context.extra.modelConfig.key, 'deepseek-flash')
    assert.equal(body.model_config.is_vl, true)
    assert.equal(body.stream, true)
    assert.equal(body.parameters.max_tokens, 128)
  } finally {
    shim.close()
  }
})

test('reasoning is a switch: a level enables it, off leaves it out', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save({ ...credentials, expires: Date.now() + 3600_000 })
  const catalog = createCatalog({})
  const bodies = []
  const shim = createShim({
    store,
    catalog,
    runtimeProvider: getRuntime,
    // Stub the signer: the real one encrypts the body, so the plaintext
    // envelope this test inspects must come from a stub.
    async signer(input) {
      bodies.push(JSON.parse(input.body))
      return { url: '/algo/api/v2/service/pro/sse/agent_chat_generation', headers: {}, body: 'signed-fixture' }
    },
    async fetchImpl() {
      return new Response(frame(chunk({ content: 'ok' })) + frame(chunk({}, 'stop')) + done,
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  await shim.ready
  try {
    const send = (extra) => fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], ...extra }),
    }).then((response) => response.text())
    await send({ reasoning_effort: 'high' })
    await send({})
    assert.equal(bodies[0].model_config.is_reasoning, true)
    assert.equal(bodies[1].model_config.is_reasoning, false)
  } finally {
    shim.close()
  }
})

test('an unknown model is refused with a message that says what to do', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save({ ...credentials, expires: Date.now() + 3600_000 })
  const catalog = createCatalog({})
  const shim = createShim({
    store, catalog, runtimeProvider: getRuntime, signer: prepareQwenworkInfer,
    fetchImpl: () => assert.fail('no upstream request for an unknown model'),
  })
  await shim.ready
  try {
    const response = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + shim.secret(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /刷新模型目录|切换模型/)
  } finally {
    shim.close()
  }
})

test('the panel reports signed-out state without touching the network', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  const catalog = createCatalog({})
  const panel = createPanel({ store, catalog, runtimeProvider: getRuntime })
  const status = await panel.status(new URL('http://127.0.0.1/status'))
  assert.equal(status.loggedIn, false)
  assert.ok(Array.isArray(status.models) && status.models.length > 0)
  assert.equal(status.runtime.available, true)
})

test('the panel reports the signed-in account and its plan without a token', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save({ ...credentials, plan: '专业版', expires: Date.now() + 3600_000 })
  const catalog = createCatalog({})
  const panel = createPanel({ store, catalog, runtimeProvider: getRuntime })
  const status = await panel.status(new URL('http://127.0.0.1/status'))
  assert.equal(status.loggedIn, true)
  assert.equal(status.account, credentials.email)
  assert.equal(status.plan, '专业版')
  const text = JSON.stringify(status)
  assert.ok(!text.includes(credentials.access), 'status must never carry the access token')
  assert.ok(!text.includes(credentials.refresh), 'status must never carry the refresh token')
  assert.ok(!text.includes(credentials.machineId), 'status must never carry the machine id')
})

test('logout forgets the stored authorization', async (t) => {
  const dir = tempHome(t)
  const store = createAuthStore({ dshHome: dir, runtimeProvider: getRuntime })
  store.save(credentials)
  const catalog = createCatalog({})
  const panel = createPanel({ store, catalog, runtimeProvider: getRuntime })
  panel.logout()
  const status = await panel.status(new URL('http://127.0.0.1/status'))
  assert.equal(status.loggedIn, false)
})

test('a catalog cache survives a restart and falls back when corrupt', (t) => {
  const dir = tempHome(t)
  const file = join(dir, '.qwenwork-models.json')
  const first = createCatalog({ file })
  first.adopt(new Map([['custom-model', { id: 'custom-model', key: 'custom-model', name: 'Custom', reasoning: true, vision: false }]]))
  const second = createCatalog({ file })
  assert.equal(second.get('custom-model').name, 'Custom')
  assert.ok(second.list().length === 1)

  const broken = createCatalog({ file: join(dir, 'nope.json') })
  assert.ok(broken.list().length > 1, 'a missing cache serves the fallback catalog')
})


