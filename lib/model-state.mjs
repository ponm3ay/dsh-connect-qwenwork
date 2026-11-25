/**
 * Per-model overrides: enabled, context window, image input, thinking level.
 *
 * Every field is an OVERLAY, not a replacement. The catalog keeps the upstream
 * facts; this file records only where the user disagreed with them. A field
 * that is absent means "follow the catalog", which is why clearing an override
 * is a delete rather than a write of the default — otherwise a later upstream
 * change would be silently pinned to a number the user never chose.
 *
 * Stored in $DSH_HOME/.qwenwork-models.json as:
 *   { "off": ["id", …], "models": { "<id>": { contextWindow?, image?, effort? } } }
 *
 * The three overrides mean different things, and the difference is load-bearing:
 *
 *  - `contextWindow` is a number. DSH sizes its context budget from it, so it
 *    changes how much conversation is sent, not what the model can do.
 *  - `image` is a tri-state: absent follows the catalog, `true` opts a model the
 *    catalog calls text-only into image input, `false` keeps images out of a
 *    model that claims vision. Both directions exist because the catalog is a
 *    vendor snapshot and a vendor snapshot can be wrong in either direction.
 *  - `effort` is the default thinking level for this model, or `""` to follow
 *    the provider default. It never raises a level the model cannot take: the
 *    adapter refuses that instead of silently downgrading.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function statePath(dshHome) {
  return join(dshHome, '.qwenwork-models.json')
}

/** Thinking levels pi-ai understands, low to high. `off` disables reasoning. */
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Context windows a user may pick, in tokens. The catalog default is 1M. */
export const CONTEXT_CHOICES = [200_000, 500_000, 1_000_000, 2_000_000]

const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined)

/**
 * @param options.file - where the overrides are kept.
 * @param options.log - logger for persistence failures.
 */
export function createModelState(options = {}) {
  const file = options.file
  const log = options.log ?? (() => {})
  let loaded

  const load = () => {
    if (loaded !== undefined) return loaded
    loaded = { off: new Set(), models: new Map() }
    if (file === undefined) return loaded
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      // A file written by an older version was a bare id list.
      const off = Array.isArray(stored) ? stored : Array.isArray(stored?.off) ? stored.off : []
      for (const id of off) if (typeof id === 'string' && id) loaded.off.add(id)
      const models = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored.models : undefined
      if (models !== null && typeof models === 'object') {
        for (const [id, entry] of Object.entries(models)) {
          if (typeof id !== 'string' || !id || entry === null || typeof entry !== 'object') continue
          const clean = {}
          const contextWindow = positiveInt(entry.contextWindow)
          if (contextWindow !== undefined) clean.contextWindow = contextWindow
          if (typeof entry.image === 'boolean') clean.image = entry.image
          if (typeof entry.effort === 'string' && (entry.effort === '' || EFFORTS.includes(entry.effort))) clean.effort = entry.effort
          if (Object.keys(clean).length > 0) loaded.models.set(id, clean)
        }
      }
    } catch {
      /* a missing or corrupt file simply means "everything follows the catalog" */
    }
    return loaded
  }

  const persist = () => {
    if (file === undefined) return
    const state = load()
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({
        off: [...state.off],
        models: Object.fromEntries(state.models),
      }, null, 2), { mode: 0o600 })
    } catch (error) {
      log('qwenwork: could not persist the model overrides: ' + (error?.message ?? String(error)))
    }
  }

  /** The override object for one model, or an empty object. */
  const overridesOf = (id) => load().models.get(id) ?? {}

  /** Write one field, or drop it when the value is `undefined` (follow the catalog). */
  const setField = (id, field, value) => {
    const state = load()
    const next = { ...overridesOf(id) }
    if (value === undefined) delete next[field]
    else next[field] = value
    if (Object.keys(next).length === 0) state.models.delete(id)
    else state.models.set(id, next)
    persist()
    return next
  }

  return {
    file,
    /** Whether one model is currently offered to the picker. */
    enabled(id) {
      return !load().off.has(id)
    },
    /** Every disabled id, as an array. */
    disabledIds() {
      return [...load().off]
    },
    /** Turn one model on or off. */
    set(id, enabled) {
      if (typeof id !== 'string' || !id) throw new Error('模型 id 不能为空')
      const state = load()
      if (enabled) state.off.delete(id)
      else state.off.add(id)
      persist()
      return !state.off.has(id)
    },
    /** Every override for one model: `{ contextWindow?, image?, effort? }`. */
    overridesOf,
    /** Set or clear the context window override. */
    setContextWindow(id, value) {
      if (value === undefined) return setField(id, 'contextWindow', undefined)
      const tokens = positiveInt(value)
      if (tokens === undefined) throw new Error('上下文窗口必须是正整数')
      return setField(id, 'contextWindow', tokens)
    },
    /** Set or clear the image-input override. */
    setImage(id, value) {
      if (value === undefined) return setField(id, 'image', undefined)
      if (typeof value !== 'boolean') throw new Error('图片能力必须是布尔值')
      return setField(id, 'image', value)
    },
    /** Set or clear the default thinking level. `""` clears it. */
    setEffort(id, value) {
      if (value === undefined || value === '') return setField(id, 'effort', undefined)
      if (!EFFORTS.includes(value)) throw new Error('未知的思考强度：' + String(value))
      return setField(id, 'effort', value)
    },
    /** Forget every override and switch for one model. */
    clear(id) {
      const state = load()
      state.models.delete(id)
      state.off.delete(id)
      persist()
    },
    /** Drop ids that are no longer in the catalog, so the file cannot grow forever. */
    prune(knownIds) {
      const state = load()
      const known = new Set(knownIds)
      let changed = false
      for (const id of [...state.off]) {
        if (!known.has(id)) {
          state.off.delete(id)
          changed = true
        }
      }
      for (const id of [...state.models.keys()]) {
        if (!known.has(id)) {
          state.models.delete(id)
          changed = true
        }
      }
      if (changed) persist()
      return changed
    },
  }
}
