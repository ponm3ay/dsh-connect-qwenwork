/**
 * The model catalog: what the signed-in account can actually serve.
 *
 * QwenWork publishes a desktop chat-modes catalog per account. It is cached in
 * $DSH_HOME/.qwenwork-models.json so a restart shows the last known list
 * without a network round trip, and a catalog outage falls back to the
 * built-in snapshot rather than emptying the model picker.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { FALLBACK_CATALOG, fetchCatalog, parseCatalog } from './catalog.mjs'
import { DESKTOP_OUTPUT_TOKENS, MAX_ADAPTER_OUTPUT_TOKENS } from './constants.mjs'

/** Re-read the upstream catalog at most this often. */
export const CATALOG_MAX_AGE = 30 * 60 * 1000

const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined)

/** The advertised context tier never raises the separate output ceiling. */
export function outputTokenLimit(model) {
  return Math.min(model.maxOutputTokens ?? DESKTOP_OUTPUT_TOKENS, MAX_ADAPTER_OUTPUT_TOKENS)
}

/**
 * One catalog cache over a file.
 * @param options.file - where the last successful listing is kept.
 * @param options.log - logger for persistence failures.
 */
export function createCatalog(options = {}) {
  const file = options.file
  const log = options.log ?? (() => {})
  let current
  let checkedAt = 0

  const restore = () => {
    if (current !== undefined) return current
    current = FALLBACK_CATALOG
    if (file === undefined) return current
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      if (!stored || !Array.isArray(stored.models)) return current
      const models = new Map()
      for (const row of stored.models) {
        if (typeof row?.id !== 'string' || !row.id || typeof row.key !== 'string' || !row.key) continue
        models.set(row.id, {
          id: row.id,
          key: row.key,
          name: typeof row.name === 'string' && row.name ? row.name : row.key,
          reasoning: row.reasoning === true,
          vision: row.vision === true,
          maxOutputTokens: positive(row.maxOutputTokens),
        })
      }
      if (models.size === 0) return current
      current = models
      checkedAt = typeof stored.checkedAt === 'number' ? stored.checkedAt : 0
    } catch {
      /* a missing or corrupt cache simply means "use the fallback" */
    }
    return current
  }

  const publish = (models) => {
    current = models
    checkedAt = Date.now()
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({
        checkedAt,
        models: [...models.values()],
      }, null, 2), { mode: 0o600 })
    } catch (error) {
      log('qwenwork: could not persist the model catalog: ' + (error?.message ?? String(error)))
    }
  }

  return {
    file,
    /** The current listing, as `{ id, key, name, reasoning, vision, maxOutputTokens }`. */
    list() {
      return [...restore().values()]
    },
    /** The catalog entry for one model id, or undefined. */
    get(id) {
      return restore().get(id)
    },
    refreshedAt() {
      restore()
      return checkedAt || undefined
    },
    /**
     * Interrogate the account's catalog.
     * @param auth - live credentials.
     * @param runtime - the discovered WASM component and its version facts.
     * @param options.signal - caller cancellation.
     * @returns the published listing.
     */
    async refresh(auth, runtime, options = {}) {
      const response = await fetchCatalog(auth, runtime, { fetchImpl: options.fetchImpl ?? fetch, signal: options.signal })
      const models = response instanceof Map ? response : parseCatalog(response)
      publish(models)
      return [...models.values()]
    },
    /** Keep a listing another code path already fetched (e.g. right after login). */
    adopt(models) {
      publish(models)
      return [...models.values()]
    },
  }
}
