/**
 * Per-model enable/disable state.
 *
 * Disabling a model is a local preference, not an upstream fact: the account can
 * still serve it, the user simply does not want it in the picker. It lives in
 * $DSH_HOME/.qwenwork-models-off.json as a plain id list, so it survives
 * restarts and a catalog refresh (a refresh replaces the catalog, not this).
 *
 * The set is keyed by catalog id, not by the upstream key: ids are what the
 * picker and the shim's lookup use, and an id that disappears from the catalog
 * simply stops matching anything.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function statePath(dshHome) {
  return join(dshHome, '.qwenwork-models-off.json')
}

/**
 * @param options.file - where the disabled ids are kept.
 * @param options.log - logger for persistence failures.
 */
export function createModelState(options = {}) {
  const file = options.file
  const log = options.log ?? (() => {})
  let disabled

  const load = () => {
    if (disabled !== undefined) return disabled
    disabled = new Set()
    if (file === undefined) return disabled
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(stored)) {
        for (const id of stored) if (typeof id === 'string' && id) disabled.add(id)
      }
    } catch {
      /* a missing or corrupt file simply means "everything is on" */
    }
    return disabled
  }

  const persist = () => {
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify([...load()], null, 2), { mode: 0o600 })
    } catch (error) {
      log('qwenwork: could not persist the model switch state: ' + (error?.message ?? String(error)))
    }
  }

  return {
    file,
    /** Whether one model is currently offered to the picker. */
    enabled(id) {
      return !load().has(id)
    },
    /** Every disabled id, as an array. */
    disabledIds() {
      return [...load()]
    },
    /**
     * Turn one model on or off.
     * @returns the resulting enabled state.
     */
    set(id, enabled) {
      if (typeof id !== 'string' || !id) throw new Error('模型 id 不能为空')
      const set = load()
      if (enabled) set.delete(id)
      else set.add(id)
      persist()
      return !set.has(id)
    },
    /** Drop ids that are no longer in the catalog, so the file cannot grow forever. */
    prune(knownIds) {
      const set = load()
      const known = new Set(knownIds)
      let changed = false
      for (const id of [...set]) {
        if (!known.has(id)) {
          set.delete(id)
          changed = true
        }
      }
      if (changed) persist()
      return changed
    },
  }
}
