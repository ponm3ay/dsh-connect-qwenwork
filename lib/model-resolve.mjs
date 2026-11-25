/**
 * Resolving a catalog entry into the model DSH actually sees.
 *
 * The catalog carries the upstream facts; the user's overrides carry the
 * disagreements. This module is the one place they are combined, so the picker,
 * the shim and the capability check can never drift apart: everything asks
 * `resolveModel` rather than reading the catalog directly.
 *
 * The precedence rule is the same one the other connectors use: an override
 * wins when it is set, the catalog answers when it is not, and nothing is
 * invented when neither does.
 */
import { ADAPTER_CONTEXT_WINDOW } from './constants.mjs'
import { EFFORTS } from './model-state.mjs'

/**
 * The effective shape of one model.
 * @param entry - a catalog entry: `{ id, key, name, reasoning, vision, maxOutputTokens }`.
 * @param overrides - the user's overrides for that id: `{ contextWindow?, image?, effort? }`.
 * @returns `{ id, key, name, vision, reasoning, contextWindow, effort, overrides }`
 *   where `vision`/`contextWindow`/`effort` already reflect the overrides.
 */
export function resolveModel(entry, overrides = {}) {
  // Image input: the override decides when present, in both directions. A model
  // the catalog calls text-only can be opted into images because a vendor
  // snapshot can be stale; a model that claims vision can be kept text-only
  // because a snapshot can be wrong the other way too.
  const vision = typeof overrides.image === 'boolean' ? overrides.image : entry.vision === true
  // Context: a number the user picked, else the advertised default. It is a
  // request budget, never a claim that the gateway will serve that much.
  const contextWindow = Number.isSafeInteger(overrides.contextWindow) && overrides.contextWindow > 0
    ? overrides.contextWindow
    : ADAPTER_CONTEXT_WINDOW
  // Thinking: the override, else the provider default the adapter declares.
  // An empty string is how the panel says "follow the default".
  const effort = typeof overrides.effort === 'string' && EFFORTS.includes(overrides.effort) ? overrides.effort : undefined
  return {
    id: entry.id,
    key: entry.key,
    name: entry.name,
    vision,
    // Reasoning stays a catalog fact: a model that does not reason has no
    // levels to choose from, and offering the picker anyway would be a lie.
    reasoning: entry.reasoning === true,
    contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    effort,
    overrides,
  }
}

/**
 * The levels one model can be set to, lowest to highest.
 *
 * `off` is always offered: it is the one level every reasoning model can take,
 * and it is what turns the upstream switch off. A non-reasoning model gets no
 * levels at all rather than a picker whose every choice does nothing.
 */
export function effortChoices(model) {
  if (model.reasoning !== true) return []
  return ['off', ...EFFORTS.filter((level) => level !== 'off')]
}
