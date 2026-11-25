/**
 * The DSH-facing adapter: pi-ai model descriptors + a PiAiAdapter whose
 * profiles point at the loopback shim.
 *
 * This mirrors how dsh-connect-autoclaw / workbuddy / qoder assemble a route on
 * the public `dsh-llm-pi-ai` seam (PiAiAdapter + createProvider +
 * openAICompletionsApi): the shim speaks OpenAI chat completions, so pi-ai
 * needs nothing special, and DSH keeps its own request contract, tool loop and
 * reasoning handling.
 *
 * The three per-model overrides all land in the descriptor, because that is the
 * only place DSH reads capability from:
 *   - `contextWindow` sizes DSH's context budget for that model;
 *   - `input` decides whether an image attachment is admitted or refused before
 *     the request is built;
 *   - `thinkingLevelMap` decides which thinking levels the picker offers, and
 *     `profile.reasoning` supplies the default when the model override is clear.
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { outputTokenLimit } from './catalog-store.mjs'
import { EFFORTS } from './model-state.mjs'

/** Subscription credits are not priced per token; report zero rather than guess. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Inert pi-ai auth plane: the shim secret is the only credential, resolved per
 * request, so pi-ai's own credential lifecycle must never manufacture one.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return [] },
    async modify() { throw new Error('dsh-connect-qwenwork: this route has no pi-ai credential lifecycle') },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false },
  },
}

/**
 * The thinking levels this route understands, low to high.
 *
 * QwenWork takes a single `is_reasoning` switch, so every level maps to itself
 * and `off` maps to the literal string "none". It must NOT be null: DSH treats
 * a null mapping as "this model cannot be asked for that level" and then refuses
 * an explicit `off` with UNSUPPORTED_REASONING_EFFORT — which would leave the
 * user no way to turn thinking off. pi-ai recognises "none" as the off spelling
 * and sends no `reasoning_effort`, which is exactly the request we want.
 */
function thinkingLevelMap() {
  const map = Object.fromEntries(EFFORTS.filter((level) => level !== 'off').map((level) => [level, level]))
  map.off = 'none'
  return map
}

/** One pi-ai model descriptor pointing at the shim, with the overrides applied. */
function toPiModel(model, baseUrl, provider) {
  return {
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    provider,
    baseUrl,
    // The resolved capability, not the catalog's raw claim: an override can put
    // a text-only model into image mode, or keep images out of a vision model.
    input: model.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: model.contextWindow,
    maxTokens: outputTokenLimit(model),
    reasoning: model.reasoning === true,
    ...(model.reasoning === true ? { thinkingLevelMap: thinkingLevelMap() } : {}),
    compat: {
      // QwenWork bills in credits and has no verified per-token price.
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: model.reasoning === true,
      supportsFinishReason: true,
      supportsStrictMode: false,
    },
  }
}

/**
 * Assemble the adapter.
 *
 * `getModels` re-reads the shim's base URL on every call so the ephemeral port
 * applies from the first snapshot after startup, and a restart never leaves a
 * model pointing at a dead port. The model list itself comes from the catalog
 * with overrides applied, so a switch or a capability change shows up without
 * restarting the process.
 */
export function createAdapter(options) {
  const shim = options.shim
  const providerId = options.providerId
  const displayName = options.displayName
  const catalog = options.catalog

  /** The models DSH should see right now, overrides applied. */
  const resolvedModels = () => catalog.listResolved()

  const buildModels = () => {
    const baseUrl = shim.baseUrl() + '/v1'
    return resolvedModels().map((model) => toPiModel(model, baseUrl, providerId))
  }

  /**
   * The route-level default thinking level.
   *
   * A per-model override is the model's own default, and DSH carries only one
   * default per route — so this reports the level the majority of models ask
   * for, falling back to `high` when none do. A model's own override still wins
   * at request time because DSH sends the level it displays for that model.
   */
  const defaultReasoning = () => {
    const asked = resolvedModels().map((model) => model.effort).filter((level) => typeof level === 'string')
    if (asked.length === 0) return 'high'
    const counts = new Map()
    for (const level of asked) counts.set(level, (counts.get(level) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: 'QwenWork shim secret',
          async resolve() {
            return { auth: { apiKey: shim.secret() }, source: 'QwenWork' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = () => ({
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: 600000,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    reasoning: defaultReasoning(),
    piProvider: provider,
  })

  return {
    adapter: new PiAiAdapter({
      profiles: () => new Map([[providerId, profile()]]),
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.secret(),
    }),
    models: () => resolvedModels(),
  }
}
