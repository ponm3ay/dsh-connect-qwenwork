/**
 * The DSH-facing adapter: pi-ai model descriptors + a PiAiAdapter whose
 * profiles point at the loopback shim.
 *
 * This mirrors how dsh-connect-autoclaw / workbuddy / qoder assemble a route on
 * the public `dsh-llm-pi-ai` seam (PiAiAdapter + createProvider +
 * openAICompletionsApi): the shim speaks OpenAI chat completions, so pi-ai
 * needs nothing special, and DSH keeps its own request contract, tool loop and
 * reasoning handling.
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { outputTokenLimit } from './catalog-store.mjs'
import { ADAPTER_CONTEXT_WINDOW } from './constants.mjs'

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
 * Reasoning levels pi-ai understands, low to high.
 *
 * QwenWork takes a single `is_reasoning` switch (the shim reads the presence of
 * `reasoning_effort`), so every level maps to itself and only `off` is null —
 * which is what makes pi-ai send no `reasoning_effort` at all.
 */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function thinkingLevelMap() {
  const map = Object.fromEntries(THINKING_LEVELS.map((level) => [level, level]))
  map.off = null
  return map
}

/** One pi-ai model descriptor pointing at the shim. */
function toPiModel(model, baseUrl, provider) {
  return {
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    provider,
    baseUrl,
    input: model.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: ADAPTER_CONTEXT_WINDOW,
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
 * model pointing at a dead port. The model list itself comes from the catalog,
 * so a refresh shows up without restarting the process.
 */
export function createAdapter(options) {
  const shim = options.shim
  const providerId = options.providerId
  const displayName = options.displayName
  const catalog = options.catalog

  const buildModels = () => {
    const baseUrl = shim.baseUrl() + '/v1'
    // Only models the user left switched on are described to the picker.
    return catalog.listEnabled().map((model) => toPiModel(model, baseUrl, providerId))
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

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: 600000,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    reasoning: 'high',
    piProvider: provider,
  }

  return {
    adapter: new PiAiAdapter({
      profiles: () => new Map([[providerId, profile]]),
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.secret(),
    }),
    models: () => catalog.list(),
  }
}
