/**
 * The QwenWork panel's host half: the loopback routes the browser half drives.
 *
 *   GET  /plugins/dsh-connect-qwenwork/status        account, plan, credits, models
 *   POST /plugins/dsh-connect-qwenwork/login         start a browser authorization
 *   GET  /plugins/dsh-connect-qwenwork/login         poll that attempt
 *   POST /plugins/dsh-connect-qwenwork/cancel        withdraw the running attempt
 *   POST /plugins/dsh-connect-qwenwork/models        re-read the account's catalog
 *   POST /plugins/dsh-connect-qwenwork/model         change one model's switch or a capability
 *   POST /plugins/dsh-connect-qwenwork/test-account  is the credential alive (read-only)
 *   POST /plugins/dsh-connect-qwenwork/test-model    probe one or every enabled model
 *   POST /plugins/dsh-connect-qwenwork/logout        forget the stored authorization
 *
 * Why a route at all: the token exchange happens in the Host process, and the
 * browser half must never see a token. It only ever asks "am I signed in",
 * "please start a login", and "did it land yet".
 *
 * This module owns the route *behaviour*. The fence lives in http-fence.mjs and
 * the payload shapes in panel-view.mjs, so neither the security check nor the
 * view contract is buried in a 500-line file.
 */
import { beginLogin, completeLogin, readAccount, seedCatalog } from './login.mjs'
import { probeAccount, probeModels } from './probe.mjs'
import { describeAccount, describeChoices, describeModels, describeRuntime, summariseProbes } from './panel-view.mjs'
import { prepareQwenworkInfer } from './wasm.mjs'

/** How long one browser authorization attempt stays usable. */
const LOGIN_TTL_MS = 5 * 60 * 1000
/** Credit balances are a network read; do not repeat one for the same panel open. */
const CREDITS_TTL_MS = 60 * 1000

/**
 * Build the panel's route handlers.
 * @param options.store - the credential store.
 * @param options.catalog - the catalog cache.
 * @param options.modelState - the per-model overrides.
 * @param options.runtimeProvider - resolves the WASM component.
 * @param options.signer - the WASM signing entry point (injectable for tests).
 * @param options.log - logger for transport failures.
 */
export function createPanel(options) {
  const store = options.store
  const catalog = options.catalog
  const runtimeProvider = options.runtimeProvider
  const modelState = options.modelState
  const signer = options.signer ?? prepareQwenworkInfer
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

  /** One credit read; `force` rotates the token first. */
  async function readBalance(force) {
    const live = await store.resolve(force)
    const { quota } = await readAccount(live, runtimeProvider())
    return quota
  }

  /** GET /status: state plus, only when asked, the credit balance. */
  async function status(url) {
    const now = Date.now()
    const account = describeAccount(store, now)
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
      models: describeModels(catalog, modelState),
      choices: describeChoices(),
      modelsRefreshedAt: catalog.refreshedAt(),
      runtime: describeRuntime(runtimeProvider),
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
      const saved = store.peek()
      return { loggingIn: false, done: true, loggedIn: true, account: saved?.email || saved?.uid }
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

  /**
   * POST /models: re-read the account's catalog.
   *
   * The reply is the SAME shape `status` reports, including every capability and
   * its overrides — a refresh that adds models must hand the panel their vision,
   * context window and reasoning flag, or the new rows would paint as "no image"
   * until the next full reload.
   */
  async function refreshModels() {
    if (store.peek() === undefined) throw new Error('还没登录，先登录再刷新模型列表。')
    const live = await store.resolve()
    await catalog.refresh(live, runtimeProvider())
    return {
      models: describeModels(catalog, modelState),
      choices: describeChoices(),
      refreshedAt: catalog.refreshedAt(),
    }
  }

  /**
   * POST /model: change one model's switch or one of its three capabilities.
   *
   * The body carries `{ id, enabled?, contextWindow?, image?, effort? }`. Only
   * the fields present are written, and a `null` value clears that override so
   * the model follows the catalog again — which is why clearing is a delete
   * rather than a write of today's default.
   */
  function setModel(body) {
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) throw new Error('缺少模型 id')
    if (catalog.get(id) === undefined) throw new Error('该模型不在当前目录中，先刷新模型列表。')
    if (modelState === undefined) throw new Error('这个版本没有接模型设置')

    if (typeof body.enabled === 'boolean') modelState.set(id, body.enabled)
    if ('contextWindow' in body) {
      const value = body.contextWindow
      modelState.setContextWindow(id, value === null || value === '' ? undefined : value)
    }
    if ('image' in body) {
      const value = body.image
      if (value === null) modelState.setImage(id, undefined)
      else if (typeof value !== 'boolean') throw new Error('图片能力必须是布尔值')
      else modelState.setImage(id, value)
    }
    if ('effort' in body) {
      const value = body.effort
      modelState.setEffort(id, value === null || value === '' ? undefined : value)
    }

    return { id, models: describeModels(catalog, modelState), choices: describeChoices() }
  }

  /**
   * POST /test-account: is the credential alive and is the gateway reachable?
   *
   * Deliberately NOT a chat. The gateway's read-only account endpoint proves the
   * credential, the network and the account state without generating a token,
   * so this button costs nothing — which is what a connection test should be.
   */
  async function testAccount() {
    if (store.peek() === undefined) throw new Error('还没登录，先登录再测。')
    const live = await store.resolve()
    const result = await probeAccount({ credentials: live, runtime: runtimeProvider() })
    log('panel: account probe ' + result.verdict)
    if (result.verdict === 'auth') credits = undefined
    return result
  }

  /**
   * POST /test-model: probe one model, or every enabled model in turn.
   *
   * Sequential, one model at a time, because the gateway throttles bursts and a
   * throttled probe would report a good model as rate-limited.
   *
   * @param body `{ id? }` — one model, or every enabled model when absent.
   */
  async function testModels(body) {
    if (store.peek() === undefined) throw new Error('还没登录，先登录再测。')
    const live = await store.resolve()
    const all = catalog.listResolved()
    const only = typeof body?.id === 'string' && body.id ? body.id : undefined
    let targets = all
    if (only !== undefined) {
      const one = all.find((model) => model.id === only)
      if (one === undefined) throw new Error('该模型不在当前已开启的目录中。')
      targets = [one]
    } else if (targets.length === 0) {
      throw new Error('没有已开启的模型可以测。')
    }
    const results = await probeModels({
      models: targets,
      credentials: live,
      runtime: runtimeProvider(),
      signer,
    })
    if (results.some((result) => result.verdict === 'auth')) credits = undefined
    log('panel: probed ' + results.length + ' model(s); ' + summariseProbes(results).available + ' available')
    return { results, testedAt: Date.now(), summary: summariseProbes(results) }
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
    setModel,
    describeChoices,
    testAccount,
    testModels,
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
      model: '/plugins/dsh-connect-qwenwork/model',
      testAccount: '/plugins/dsh-connect-qwenwork/test-account',
      testModel: '/plugins/dsh-connect-qwenwork/test-model',
      logout: '/plugins/dsh-connect-qwenwork/logout',
    },
  }
}
