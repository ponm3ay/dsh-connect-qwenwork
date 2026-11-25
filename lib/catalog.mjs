import { createHash } from 'node:crypto'
import { DESKTOP_OUTPUT_TOKENS, GATEWAY, MAX_ADAPTER_OUTPUT_TOKENS, MODELS, clientHeaders } from './constants.mjs'
import { abortSignal } from './errors.mjs'

const CATALOG_PATH = '/api/desktop/chat-modes'
const CATALOG_TIMEOUT = 6500
const MAX_BYTES = 1024 * 1024
const MAX_MODELS = 256
const MODEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/
const FORMATS = new Set(['openai/chat-completions', 'anthropic/messages'])
const TIERS = new Map([['flash', 'qwork-auto'], ['pro', 'qwork-advanced']])
const TIER_NAMES = new Set(TIERS.values())
export const CATALOG_MAX_AGE = 30 * 60 * 1000

const piId = key => TIERS.get(key) ?? key
const modelName = value => typeof value === 'string' && value.trim() && value.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value) ? value.trim() : undefined

const positiveTokenCount = value => Number.isSafeInteger(value) && value > 0 ? value : undefined

// The advertised context tier does not raise the separate output ceiling.
export function outputTokenLimit(model) {
  return Math.min(model.maxOutputTokens ?? DESKTOP_OUTPUT_TOKENS, MAX_ADAPTER_OUTPUT_TOKENS)
}

export const FALLBACK_CATALOG = new Map(Object.entries(MODELS).map(([id, info]) => [id, {
  id, key: id, name: info.name, reasoning: info.reasoning, vision: info.modalities.input.includes('image'),
}]))

export function catalogScope(auth) {
  if (typeof auth?.uid !== 'string' || !auth.uid || typeof auth.machineId !== 'string' || !auth.machineId) return undefined
  // The random browser login device makes this opaque and prevents reuse after changing logins.
  return createHash('sha256').update(JSON.stringify([auth.uid, auth.machineId, auth.organizationId ?? ''])).digest('hex')
}

export function parseCatalog(payload) {
  const data = payload?.catalog === undefined ? payload?.data : payload
  if ((data?.schema_version ?? data?.schemaVersion) !== 2 || !Array.isArray(data.catalog) || data.catalog.length > MAX_MODELS) {
    throw new Error('千问办公模型目录格式不受支持')
  }
  const models = new Map()
  for (const row of data.catalog) {
    if (typeof row?.key !== 'string' || !MODEL_KEY.test(row.key) || row.enable !== true || row.visible === false ||
        row.source !== 'system' || !FORMATS.has(row.format)) continue
    const { key } = row
    const id = piId(key)
    // Prefer the current server key over an old alias if both are present.
    if (models.has(id) && key === id) continue
    const display = row.i18n?.display_name
    const name = TIER_NAMES.has(id) ? MODELS[id].name : modelName(display?.zh) ?? modelName(display?.en) ?? modelName(row.display_name) ?? key
    const maxOutputTokens = positiveTokenCount(row.max_output_tokens) ?? positiveTokenCount(row.maxOutputTokens)
    models.set(id, { id, key, name, reasoning: row.is_reasoning === true, vision: row.is_vl === true, maxOutputTokens })
  }
  if (!models.size) throw new Error('千问办公没有返回可用的模型目录')
  return models
}

export function restoreCatalog(stored, scope, providerId, api) {
  if (!scope || stored?.qwenworkCatalogScope !== scope || !Array.isArray(stored.models) || stored.models.length > MAX_MODELS) return undefined
  const models = new Map()
  for (const model of stored.models) {
    const key = model?.qwenworkKey
    const name = modelName(model?.name)
    if (model?.type !== 'chat' || model.provider !== providerId || model.api !== api ||
        typeof key !== 'string' || !MODEL_KEY.test(key) || model.id !== piId(key) || !name || !Array.isArray(model.input)) return undefined
    models.set(model.id, {
      id: model.id, key, name, reasoning: model.reasoning === true, vision: model.input.includes('image'),
      // Old caches stored the adapter's hard-coded maxTokens. Only use values
      // explicitly copied from the desktop model catalog.
      maxOutputTokens: positiveTokenCount(model.qwenworkMaxOutputTokens),
    })
  }
  return models.size ? { scope, models, checkedAt: stored.checkedAt } : undefined
}

export async function fetchCatalog(auth, runtime, { fetchImpl, signal }) {
  const requestSignal = abortSignal(signal, CATALOG_TIMEOUT)
  const response = await fetchImpl(GATEWAY + CATALOG_PATH, {
    method: 'GET', redirect: 'error', signal: requestSignal,
    headers: { ...clientHeaders(runtime), Authorization: `Bearer ${auth.access}` },
  })
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`千问办公模型目录请求失败（HTTP ${response.status}）`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      requestSignal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('千问办公模型目录响应超过大小限制')
      text += decoder.decode(value, { stream: true })
    }
    requestSignal.throwIfAborted()
    let json
    try { json = JSON.parse(text + decoder.decode()) } catch { throw new Error('千问办公模型目录不是有效 JSON') }
    return parseCatalog(json)
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
