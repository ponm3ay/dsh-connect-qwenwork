/**
 * Smoke-testing: can this account talk, and which models answer?
 *
 * Two questions, one mechanism, and the mechanism is deliberately as small as
 * it can be: send ONE minimal request through the same signed path a real chat
 * takes, then stop at the first byte that comes back.
 *
 * Why the first byte is enough. The gateway validates the credential and the
 * model id BEFORE it generates anything, so a refused account or an unknown
 * model fails at the response headers — never mid-stream. Anything that arrives
 * after that is the model actually answering, which is the fact being asked
 * about. Hanging up there is what keeps a smoke test cheap: no completion is
 * billed, and no SSE is parsed, because a smoke test is not an evaluation.
 *
 * Three rules this module exists to keep:
 *
 *  1. A probe must never run away. Every attempt is bounded by a deadline, and
 *     the body is abandoned the moment the first byte lands.
 *  2. A verdict must be honest about what it does not know. "The stream ended
 *     without a byte" is `empty`; a network failure is `network`, not "the model
 *     is broken". Only an explicit upstream refusal is a negative verdict.
 *  3. Probes run one at a time. Bursts get throttled, and a throttled probe
 *     would report a good model as rate-limited.
 */
import { randomUUID } from 'node:crypto'
import { ACCOUNT_PATH, ADAPTER_CONTEXT_WINDOW, GATEWAY, clientHeaders } from './constants.mjs'
import { ProviderError, upstreamError } from './errors.mjs'

/** How long one probe may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 30000
/** The shortest prompt that still exercises the real request path. */
const PROBE_PROMPT = 'ping'
/** One token of output: enough to make the model speak, too little to cost anything. */
const PROBE_MAX_TOKENS = 8

/**
 * What one probe concluded.
 *
 * `available`      a byte came back, so the model answered
 * `empty`          the request was accepted but produced nothing
 * `unsupported`    the gateway explicitly refused this model for this account
 * `auth`           the credential is not usable (expired, revoked, wrong org)
 * `quota`          the account is out of credits
 * `rate_limited`   the gateway is throttling; says nothing about the model
 * `timeout`        no answer within the deadline
 * `network`        the request never completed; says nothing about the model
 */
export const VERDICTS = ['available', 'empty', 'unsupported', 'auth', 'quota', 'rate_limited', 'timeout', 'network']

/** A verdict that means "the model itself is not usable", as opposed to a transient condition. */
export function isNegative(verdict) {
  return verdict === 'unsupported'
}

/** A verdict that means "we could not tell". */
export function isInconclusive(verdict) {
  return verdict === 'timeout' || verdict === 'network' || verdict === 'rate_limited'
}

/**
 * The probe body: one user turn, one token of room, streaming on.
 *
 * Shaped by `buildRequest` is deliberately avoided — that function exists to
 * translate a real conversation, and a probe has no conversation. What it must
 * share with a real request is the signed envelope and the destination, and
 * those live in the signer and the URL, not here.
 */
export function probeBody(model) {
  return {
    request_id: randomUUID(),
    request_set_id: undefined,
    session_id: randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: PROBE_PROMPT,
      features: [],
      extra: { context: [], modelConfig: { key: model.key, is_reasoning: false }, originalContent: PROBE_PROMPT },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: model.key,
      display_name: model.name,
      model: '',
      format: 'openai',
      is_vl: model.vision === true,
      is_reasoning: false,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: ADAPTER_CONTEXT_WINDOW,
    },
    system: '',
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    tools: [],
    parameters: { max_tokens: PROBE_MAX_TOKENS },
    business: { product: 'qoder_work', type: 'agent', version: '1', feature_switches: {} },
  }
}

/**
 * Map a thrown error onto a verdict.
 *
 * `chatResponse` normalises upstream failures into ProviderError with a status
 * and a code, so this reads those rather than re-parsing messages.
 */
function verdictOfError(error, aborted) {
  if (aborted) return { verdict: 'timeout', detail: '在限定时间内没有返回' }
  const status = typeof error?.status === 'number' ? error.status : undefined
  const message = String(error?.message ?? error ?? '')
  if (status === 401 || status === 403 || error?.code === 'authentication_error') {
    return { verdict: 'auth', detail: message }
  }
  if (status === 429) {
    return error?.code === 'insufficient_quota'
      ? { verdict: 'quota', detail: message }
      : { verdict: 'rate_limited', detail: message }
  }
  if (status === 400 || status === 404 || status === 422) {
    return { verdict: 'unsupported', detail: message }
  }
  return { verdict: 'network', detail: message || '请求没有完成' }
}

/**
 * Read exactly one byte, then hang up.
 *
 * This is the whole cost control: the reader is cancelled as soon as a byte
 * arrives, so the gateway sees a client that stopped listening rather than one
 * that waited for a completion. No SSE is parsed — a smoke test does not need to
 * understand the answer, only to see that one arrived.
 *
 * @returns `{ answered: boolean, sample: string }` where `sample` is at most a
 *   short prefix kept for diagnostics.
 */
async function readOneByte(response) {
  if (response.body === null) return { answered: false, sample: '' }
  const reader = response.body.getReader()
  try {
    const { value, done } = await reader.read()
    if (done || value === undefined || value.byteLength === 0) return { answered: false, sample: '' }
    // Keep a short printable prefix so the panel can show something concrete
    // when the model says something surprising, without retaining the answer.
    const text = new TextDecoder().decode(value.subarray(0, 120))
    return { answered: true, sample: text.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60) }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Probe one model.
 *
 * @param options.model - the resolved model (`{ id, key, name, vision, ... }`).
 * @param options.credentials - live credentials from the store.
 * @param options.runtime - the discovered WASM component.
 * @param options.signer - the WASM signing entry point (injectable for tests).
 * @param options.fetchImpl - injectable transport for tests.
 * @param options.timeoutMs - override for the probe deadline.
 * @returns `{ id, verdict, detail, ms, sample? }` — never throws.
 */
export async function probeModel(options) {
  const model = options.model
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  try {
    const body = probeBody(model)
    const prepared = await options.signer({
      wasmPath: options.runtime.wasmPath,
      cosyVersion: options.runtime.version,
      uid: options.credentials.uid,
      name: options.credentials.name ?? '',
      email: options.credentials.email ?? '',
      accessToken: options.credentials.access,
      machineId: options.credentials.machineId,
      organizationId: options.credentials.organizationId ?? '',
      dataPolicyAgreed: false,
      body: JSON.stringify(body),
      modelKey: model.key,
      endpoint: GATEWAY,
    })
    // The signer decides the destination; a probe must not trust a different one
    // than a real chat would use.
    const target = new URL(prepared.url, GATEWAY)
    if (target.origin !== GATEWAY) {
      throw new ProviderError('签名组件返回了非预期的推理地址，已拒绝发送', 502)
    }
    const headers = {
      ...clientHeaders(options.runtime),
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Request-Id': randomUUID(),
      'X-Model-Key': model.key,
      'X-Model-Source': 'system',
      'Cosy-MachineId': options.credentials.machineId,
      'Cosy-MachineToken': options.credentials.machineId,
      'Cosy-Version': options.runtime.version,
      'Cosy-ClientType': '6',
      'Cosy-Business-Product': 'qoder_work',
      'Cosy-Business-Type': 'agent',
      'Cosy-Scene': 'qwork',
      'Cosy-MachineOS': `${process.arch}_${process.platform}`,
      'Cosy-MachineType': '5',
      'Cosy-Data-Policy': 'disagree',
      'Login-Version': 'v2',
      ...prepared.headers,
    }
    const response = await fetchImpl(target.href, {
      method: 'POST',
      headers,
      body: prepared.body,
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // The gateway's error shape is already understood; reuse that reading.
      const parsed = upstreamError(text.slice(0, 4000), response.status)
      const detail = parsed?.message || text.slice(0, 200) || `HTTP ${response.status}`
      // `upstreamError` folds every 429 into the quota code, which is right for
      // a chat (both mean "stop asking") but wrong for a probe: a throttled
      // model is fine and must not be reported as a broken one. So the raw body
      // decides between the two, not the normalised code.
      const quota = /quota|credit|额度|积分/i.test(text)
      const verdict = response.status === 401 || response.status === 403 ? 'auth'
        : response.status === 429 ? (quota ? 'quota' : 'rate_limited')
          : response.status >= 400 && response.status < 500 ? 'unsupported'
            : 'network'
      return { id: model.id, verdict, detail, ms: Date.now() - started }
    }
    const { answered, sample } = await readOneByte(response)
    return {
      id: model.id,
      verdict: answered ? 'available' : 'empty',
      detail: answered ? '有返回' : '请求被接受但没有返回内容',
      ms: Date.now() - started,
      ...(answered && sample ? { sample } : {}),
    }
  } catch (error) {
    const mapped = verdictOfError(error, controller.signal.aborted)
    return { id: model.id, verdict: mapped.verdict, detail: mapped.detail, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe several models, one at a time.
 *
 * Sequential on purpose: the gateway throttles bursts, and a burst would report
 * `rate_limited` for models that are fine. `onResult` fires after each one so
 * the panel can paint progress instead of waiting for the whole list.
 */
export async function probeModels(options) {
  const results = []
  for (const model of options.models) {
    if (options.signal?.aborted) break
    const result = await probeModel({ ...options, model })
    results.push(result)
    options.onResult?.(result, results.length, options.models.length)
  }
  return results
}

/**
 * Probe the account itself: is the credential alive and can we reach the gateway?
 *
 * This does NOT send a chat. The gateway already answers a read-only account
 * endpoint that proves the same three things a chat would — the credential is
 * valid, the network reaches the gateway, and the account is not suspended —
 * without generating a token. That is what "test the connection" means, and it
 * costs nothing.
 *
 * @param options.credentials - live credentials from the store.
 * @param options.runtime - the discovered WASM component.
 * @param options.fetchImpl - injectable transport for tests.
 * @returns `{ ok, verdict, detail, ms, account? }`
 */
export async function probeAccount(options) {
  const started = Date.now()
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    if (typeof options.credentials?.access !== 'string' || !options.credentials.access) {
      return { ok: false, verdict: 'auth', detail: '没有可用的凭据，请先登录', ms: Date.now() - started }
    }
    const response = await fetchImpl(GATEWAY + ACCOUNT_PATH, {
      headers: { ...clientHeaders(options.runtime), Authorization: `Bearer ${options.credentials.access}` },
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const parsed = upstreamError(text.slice(0, 4000), response.status)
      const detail = parsed?.message || text.slice(0, 200) || `HTTP ${response.status}`
      const verdict = response.status === 401 || response.status === 403 ? 'auth'
        : response.status === 429 ? (/quota|credit|额度|积分/i.test(text) ? 'quota' : 'rate_limited')
          : response.status >= 400 && response.status < 500 ? 'unsupported'
            : 'network'
      return { ok: false, verdict, detail, ms: Date.now() - started }
    }
    // A parseable account document is the proof: the credential was accepted and
    // the gateway answered with this account's own facts.
    let account
    try {
      account = await response.json()
    } catch {
      return { ok: false, verdict: 'network', detail: '网关返回了无法解析的账号信息', ms: Date.now() - started }
    }
    const user = account?.user ?? {}
    const uid = user.id ?? user.uid
    if (uid === undefined || uid === null || String(uid) === '') {
      return { ok: false, verdict: 'unsupported', detail: '网关没有返回账号标识', ms: Date.now() - started }
    }
    return {
      ok: true,
      verdict: 'available',
      detail: '凭据有效，网关可达',
      ms: Date.now() - started,
      account: {
        name: typeof user.name === 'string' ? user.name : undefined,
        email: typeof user.email === 'string' ? user.email : undefined,
        plan: typeof account?.plan?.name === 'string' ? account.plan.name : undefined,
      },
    }
  } catch (error) {
    const mapped = verdictOfError(error, controller.signal.aborted)
    return { ok: false, verdict: mapped.verdict, detail: mapped.detail, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}
