import { readFileSync } from 'node:fs'
import { discoverRuntime } from './runtime.mjs'

const localConfig = new URL('../.qwenwork.local.json', import.meta.url)

export function getRuntime() {
  const env = { ...process.env }
  if (!env.QWENWORK_APP_PATH && !env.QWENWORK_WASM_PATH) {
    let config
    try { config = JSON.parse(readFileSync(localConfig, 'utf8')) } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('无法读取 .qwenwork.local.json，请检查 JSON 格式。')
    }
    if (config !== undefined) {
      if (typeof config?.appPath !== 'string' || !config.appPath.trim()) {
        throw new Error('.qwenwork.local.json 需要一个非空 appPath。')
      }
      env.QWENWORK_APP_PATH = config.appPath.trim()
    }
  }
  return discoverRuntime({ env })
}
