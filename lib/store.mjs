/**
 * QwenWork authorization storage for this machine.
 *
 * A sign-in is a bearer pair plus the two identifiers the WASM signer needs
 * (uid and the random machine id minted at login). It lives in
 * $DSH_HOME/.qwenwork-auth.json, mode 0600 where the OS honours it — outside
 * any synced directory, and never in the profile's settings file.
 *
 * The browser half of the settings panel never sees any of this: it asks the
 * Host "am I signed in" and posts nothing but a request to start or end a
 * login.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renewAuth } from './account.mjs'
import { ProviderError } from './errors.mjs'

/** Refresh this long before the access token lapses. */
const REFRESH_SKEW_MS = 10 * 60 * 1000

export function storePath(dshHome) {
  return join(dshHome, '.qwenwork-auth.json')
}

/**
 * One machine's QwenWork authorization.
 *
 * `resolve()` is what the chat path uses: it hands back credentials valid for
 * at least ten more minutes, rotating first when needed. Rotation is
 * serialized because a refresh token is spent on use, so two concurrent
 * rotations would burn it twice.
 */
export function createAuthStore(options = {}) {
  const file = options.file ?? storePath(options.dshHome)
  const runtimeProvider = options.runtimeProvider
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = options.log ?? (() => {})
  let cached
  let inflight

  const load = () => {
    if (cached !== undefined) return cached
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      cached = raw && typeof raw.access === 'string' && raw.access ? raw : undefined
    } catch {
      cached = undefined
    }
    return cached
  }

  const persist = (next) => {
    cached = next
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
    } catch (error) {
      log('qwenwork: could not persist authorization: ' + (error?.message ?? String(error)))
    }
    return next
  }

  const usable = (entry) =>
    entry !== undefined
    && typeof entry.access === 'string'
    && entry.access.length > 0
    && (typeof entry.expires !== 'number' || entry.expires - REFRESH_SKEW_MS > Date.now())

  return {
    file,
    /** Store a completed login. */
    save(credentials) {
      return persist(credentials)
    },
    /** Forget the stored authorization; the next request reports "signed out". */
    clear() {
      cached = undefined
      inflight = undefined
      try {
        rmSync(file, { force: true })
      } catch {
        /* a read-only home must not make sign-out throw */
      }
    },
    /** The stored credentials without any network work, or undefined. */
    peek: load,
    /**
     * Credentials good for at least ten more minutes.
     *
     * `force` rotates even when the stored token looks fresh: the gateway can
     * revoke a session before its `exp`, and only a rotation recovers from it.
     */
    async resolve(force) {
      const current = load()
      if (current === undefined) {
        throw new ProviderError('千问办公还没登录：打开「设置 → 千问办公」点登录，在浏览器完成授权。', 401, 'authentication_error')
      }
      if (!force && usable(current)) return current
      if (inflight !== undefined) return inflight
      inflight = (async () => {
        try {
          const next = await renewAuth(current, runtimeProvider(), { fetchImpl })
          return persist({ ...current, ...next })
        } finally {
          inflight = undefined
        }
      })()
      return inflight
    },
  }
}
