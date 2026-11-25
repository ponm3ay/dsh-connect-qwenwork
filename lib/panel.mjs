/**
 * The QwenWork panel's host half: the loopback routes the browser half drives.
 *
 *   GET  /plugins/dsh-connect-qwenwork/status    account, plan, credits, models
 *   POST /plugins/dsh-connect-qwenwork/login     start a browser authorization
 *   GET  /plugins/dsh-connect-qwenwork/login     poll that attempt
 *   POST /plugins/dsh-connect-qwenwork/cancel    withdraw the running attempt
 *   POST /plugins/dsh-connect-qwenwork/models    re-read the account's catalog
 *   POST /plugins/dsh-connect-qwenwork/logout    forget the stored authorization
 *
 * Why a route at all: the token exchange happens in the Host process, and the
 * browser half must never see a token. It only ever asks "am I signed in",
 * "please start a login", and "did it land yet".
 *
 * Everything here is fenced to this machine: token material never leaves
 * loopback, and the login route can open a real authorization, so both a bad
 * Host header and a cross-site Origin are refused before any work happens.
 */
import { beginLogin, completeLogin, readAccount, seedCatalog } from './login.mjs'

/** How long one browser authorization attempt stays usable. */
const LOGIN_TTL_MS = 5 * 60 * 1000
/** Credit balances are a network read; do not repeat one for the same panel open. */
const CREDITS_TTL_MS = 60 * 1000

/**
 * Refuse anything that did not come from this machine's own page.
 *
 * Prefers the Host's own gate (`ctx.get('connection').requestRejection`) so
 * this plugin inherits whatever policy the running DSH applies; falls back to
 * an explicit loopback + same-Origin check when that service is absent.
 */
export function makeFence(ctx) {
  function harnessConnection() {
    for (const source of [ctx, ctx && ctx.root]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection && typeof connection.requestRejection === 'function') return connection
      } catch {
        /* try the next source */
      }
    }
    return undefined
  }

  function header(headers, wanted) {
    if (headers === undefined || headers === null) return undefined
    if (typeof headers.get === 'function') {
      const got = headers.get(wanted)
      return typeof got === 'string' ? got : undefined
    }
    const found = headers[wanted]
    return typeof found === 'string' ? found : undefined
  }

  function isLoopback(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
    const parts = hostname.split('.')
    // 127.0.0.0/8 only. Checking "four numeric parts" alone would admit any
    // LAN address, which is exactly what must never reach the login route.
    return parts.length === 4 && parts[0] === '127'
      && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  }

  return function refusal(request) {
    const connection = harnessConnection()
    if (connection !== undefined) {
      try {
        return connection.requestRejection(request)
      } catch {
        /* fall through to the local restatement */
      }
    }
    const headers = request === undefined || request === null ? undefined : request.headers
    const host = header(headers, 'host')
    if (host === undefined) return 403
    let hostUrl
    try {
      hostUrl = new URL('http://' + host)
    } catch {
      return 403
    }
    if (!isLoopback(hostUrl.hostname)) return 403
    if (header(headers, 'sec-fetch-site') === 'cross-site') return 403
    const origin = header(headers, 'origin')
    if (origin === undefined) return undefined
    try {
      return new URL(origin).host === hostUrl.host ? undefined : 403
    } catch {
      return 403
    }
  }
}

/**
 * Read the request body as JSON, refusing anything that is not small and parseable.
 */
export function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text === '' ? {} : JSON.parse(text)
        resolve(value !== null && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Build the panel's route handlers.
 * @param options.store - the credential store.
 * @param options.catalog - the catalog cache.
 * @param options.runtimeProvider - resolves the WASM component.
 * @param options.refreshCatalog - pulls a fresh listing from upstream.
 * @param options.log - logger for transport failures.
 */
export function createPanel(options) {
  const store = options.store
  const catalog = options.catalog
  const runtimeProvider = options.runtimeProvider
  const log = options.log ?? (() => {})

  /** The one running attempt, if any. Only one browser approval at a time. */
  let attempt
  let credits

  function sweepAttempt(now) {
    if (attempt !== undefined && now - attempt.at > LOGIN_TTL_MS) {
      try { attempt.controller.abort(new Error('授权超时')) } catch { /* already gone */ }
      attempt = undefined
    }
  }

  /** The account as the panel shows it, without any token material. */
  function describeAccount() {
    const current = store.peek()
    if (current === undefined) return { loggedIn: false }
    const now = Date.now()
    const expires = typeof current.expires === 'number' ? current.expires : undefined
    return {
      loggedIn: true,
      account: current.email || current.name || current.uid || undefined,
      name: current.name || undefined,
      email: current.email || undefined,
      uid: current.uid || undefined,
      plan: current.plan || undefined,
      organizationId: current.organizationId || undefined,
      expires: expires === undefined ? undefined : new Date(expires).toISOString(),
      expiresInMs: expires === undefined ? undefined : expires - now,
      expired: expires === undefined ? false : expires <= now,
      store: store.file,
    }
  }

  /** One credit read; `force` rotates the token first. */
  async function readBalance(force) {
    const live = await store.resolve(force)
    const { quota } = await readAccount(live, runtimeProvider())
    return quota
  }

  /** GET /status: state plus, only when asked, the credit balance. */
  async function status(url) {
    const now = Date.now()
    const account = describeAccount()
    const wantsCredits = url.searchParams.get('credits') === '1'
    let balance
    let note
    if (account.loggedIn && wantsCredits) {
      if (credits !== undefined && now - credits.at < CREDITS_TTL_MS) {
        balance = credits.value
      } else {
        try {
          balance = await readBalance(false)
          credits = { at: now, value: balance }
        } catch (error) {
          if (error && error.status === 401) {
            // The gateway can revoke a session before its JWT expires, and only
            // a rotation recovers it. One retry, then report the truth.
            try {
              balance = await readBalance(true)
              credits = { at: now, value: balance }
            } catch (again) {
              note = again && again.message ? again.message : String(again)
              balance = { unavailable: true }
            }
          } else {
            note = error && error.message ? error.message : String(error)
            balance = { unavailable: true }
          }
        }
      }
    }
    return {
      ...account,
      balance,
      note,
      loggingIn: attempt !== undefined,
      models: catalog.list().map((model) => ({ id: model.id, name: model.name })),
      modelsRefreshedAt: catalog.refreshedAt(),
      runtime: describeRuntime(),
    }
  }

  /** The WASM component's identity, for the panel's diagnostics row. */
  function describeRuntime() {
    try {
      const runtime = runtimeProvider()
      return { available: true, version: runtime.version, releaseVersion: runtime.releaseVersion, sha256: runtime.sha256 }
    } catch (error) {
      return { available: false, error: error && error.message ? error.message : String(error) }
    }
  }

  /** POST /login: open one browser authorization and start polling it. */
  function login() {
    sweepAttempt(Date.now())
    if (attempt !== undefined) {
      throw new Error('已经有一个授权在等浏览器确认，完成或取消它再试。')
    }
    const runtime = runtimeProvider()
    const flow = beginLogin(runtime)
    const controller = new AbortController()
    const entry = { at: Date.now(), flow, controller, settled: false, error: undefined }
    attempt = entry
    ;(async () => {
      try {
        const credentials = await completeLogin(flow, { signal: controller.signal })
        const seeded = await seedCatalog(credentials, runtime)
        if (seeded !== undefined) catalog.adopt(seeded)
        store.save(credentials)
        credits = undefined
        entry.settled = true
        log('panel: signed in ' + (credentials.email || credentials.uid))
      } catch (error) {
        entry.settled = true
        entry.error = error && error.message ? error.message : String(error)
      } finally {
        if (attempt === entry && entry.settled) {
          // Keep the entry around so one poll can report how it ended.
          entry.at = Date.now()
        }
      }
    })()
    return { started: true, url: flow.url, instructions: '在新标签页完成千问办公授权，然后回到这里等待自动完成；无需粘贴验证码。' }
  }

  /** GET /login: has the running attempt landed? */
  function pollLogin() {
    const entry = attempt
    if (entry === undefined) return { loggingIn: false, loggedIn: store.peek() !== undefined }
    if (entry.error !== undefined) {
      attempt = undefined
      return { loggingIn: false, failed: true, error: entry.error, loggedIn: store.peek() !== undefined }
    }
    if (entry.settled && store.peek() !== undefined) {
      attempt = undefined
      return { loggingIn: false, done: true, loggedIn: true, account: store.peek()?.email || store.peek()?.uid }
    }
    if (entry.settled) {
      attempt = undefined
      return { loggingIn: false, failed: true, error: entry.error ?? '授权没有完成', loggedIn: false }
    }
    if (Date.now() - entry.at > LOGIN_TTL_MS) {
      try { entry.controller.abort(new Error('授权超时')) } catch { /* already gone */ }
      attempt = undefined
      return { loggingIn: false, failed: true, error: '浏览器授权超时，请重新点登录生成新链接。', loggedIn: store.peek() !== undefined }
    }
    return { loggingIn: true, url: entry.flow.url, loggedIn: false }
  }

  /** POST /cancel: withdraw the running attempt. */
  function cancel() {
    const entry = attempt
    attempt = undefined
    if (entry !== undefined) {
      try { entry.controller.abort(new Error('已取消')) } catch { /* already gone */ }
    }
    return { loggingIn: false, loggedIn: store.peek() !== undefined }
  }

  /** POST /models: re-read the account's catalog. */
  async function refreshModels() {
    if (store.peek() === undefined) throw new Error('还没登录，先登录再刷新模型列表。')
    const live = await store.resolve()
    const models = await catalog.refresh(live, runtimeProvider())
    return { models: models.map((model) => ({ id: model.id, name: model.name })), refreshedAt: catalog.refreshedAt() }
  }

  /** POST /logout: forget the stored authorization. */
  function logout() {
    cancel()
    store.clear()
    credits = undefined
    return { loggedIn: false }
  }

  return {
    status,
    login,
    pollLogin,
    cancel,
    refreshModels,
    logout,
    /** Stop any in-flight attempt when the plugin unloads. */
    close() {
      if (attempt !== undefined) {
        try { attempt.controller.abort(new Error('插件已卸载')) } catch { /* already gone */ }
        attempt = undefined
      }
    },
    paths: {
      status: '/plugins/dsh-connect-qwenwork/status',
      login: '/plugins/dsh-connect-qwenwork/login',
      cancel: '/plugins/dsh-connect-qwenwork/cancel',
      models: '/plugins/dsh-connect-qwenwork/models',
      logout: '/plugins/dsh-connect-qwenwork/logout',
    },
  }
}
