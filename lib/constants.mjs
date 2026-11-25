/**
 * QwenWork wire facts, carried over from pi-qwenwork-provider (MIT).
 *
 * Nothing here knows about DSH: these are the gateway's own constants, the
 * built-in fallback catalog, and the client headers the official desktop app
 * sends. The DSH-facing pieces live in adapter.mjs / shim.mjs.
 */
export const PROVIDER_ID = 'qwenwork-community'
export const GATEWAY = 'https://gateway.qwenwork.cn'
export const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'
export const REDIRECT_URI = 'qwenwork-cn://'
export const ACCOUNT_PATH = '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing'
export const REFRESH_PATH = '/api/v1/deviceToken/refresh'
export const FALLBACK_VERSION = '1.3.2'
export const FALLBACK_RELEASE = '1.3.2-26101704'
// Default context tier advertised for the desktop model catalog.
export const ADAPTER_CONTEXT_WINDOW = 1_000_000
// Keep the output ceiling independent of the context window.
export const MAX_ADAPTER_OUTPUT_TOKENS = 131072
// QwenWorkCN 2.1.0 (26111906): managed OpenCode routes without an explicit
// output limit use OPENCODE_MANAGED_MAAS_DEFAULT_MAX_OUTPUT_TOKENS = 32 * 1024.
export const DESKTOP_OUTPUT_TOKENS = 32768

function catalogModel(name, vision) {
  return {
    name,
    reasoning: true,
    modalities: { input: vision ? ['text', 'image'] : ['text'] },
    limit: { context: ADAPTER_CONTEXT_WINDOW, output: DESKTOP_OUTPUT_TOKENS },
  }
}

export const MODELS = Object.freeze({
  // The two service tiers the desktop app exposes as chat modes.
  'qwork-auto': catalogModel('千问办公 · 标准', true),
  'qwork-advanced': catalogModel('千问办公 · 高级', true),

  // Designated-model keys and input capabilities from the desktop chat-modes
  // v2 catalog (QwenWorkCN 2.1.0), not the display labels or DashScope IDs.
  'qwen4-max': catalogModel('Qwen4-Max', true),
  'qwen3.8-max-preview': catalogModel('Qwen3.8-Max', true),
  'qwen3.8-flash': catalogModel('Qwen3.8-Flash', true),
  'ling-3.1-flash': catalogModel('Ling-3.1-Flash', false),
  'deepseek-flash': catalogModel('DeepSeek-V4.1-Flash', true),
  'deepseek-v4-pro': catalogModel('DeepSeek-V4-Pro', false),
  'glm-5.3': catalogModel('GLM-5.3', false),
  'glm-5.3-flash': catalogModel('GLM-5.3-Flash', false),
  'kimi-k3.1-pro': catalogModel('Kimi-K3.1-Pro', true),
  'minimax-m3.1-flash': catalogModel('MiniMax-M3.1-Flash', true),
  'step-5-preview': catalogModel('Step-5-Preview', true),
})

export function clientHeaders(runtime = {}) {
  const version = runtime.version || FALLBACK_VERSION
  const release = runtime.releaseVersion || FALLBACK_RELEASE
  return {
    Accept: 'application/json',
    'User-Agent': `QwenWork/${version}`,
    'X-QwenWork-Version': version,
    'X-QwenWork-Release-Version': release,
    'X-QwenWork-Build': release.split('-').at(-1),
    'X-QwenWork-Platform': process.platform,
    'X-QwenWork-Arch': process.arch,
    'X-QwenWork-Channel': 'stable',
    'X-QwenWork-App-Mode': 'standard',
  }
}
