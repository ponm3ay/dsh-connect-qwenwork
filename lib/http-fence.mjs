/**
 * The fence around the panel's loopback routes.
 *
 * Every route this plugin registers is reachable by anything that can send an
 * HTTP request to the host's port, and two of them are worth attacking: the
 * login route opens a real browser authorization, and the account route answers
 * with the signed-in account. So each request is checked before any work
 * happens, and the check has two layers:
 *
 *  1. The host's own gate (`ctx.get('connection').requestRejection`), when the
 *     running DSH provides one. Inheriting that policy is what keeps this plugin
 *     honest on a deployment that has tightened it.
 *  2. A local restatement for when it does not: loopback Host only, no
 *     cross-site fetch metadata, and a same-origin Origin when one is sent.
 *
 * The local check is deliberately strict about the Host header. A `Host` naming
 * a LAN address is refused even though the socket is loopback, because a proxy
 * or a DNS-rebinding page can make that pairing happen.
 */

/** Whether a hostname is this machine's own loopback. */
function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  // 127.0.0.0/8 only. Checking "four numeric parts" alone would admit any LAN
  // address, which is exactly what must never reach the login route.
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Read one header from either a Headers instance or a plain object. */
function header(headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

/** The host's connection service, when the running DSH has one. */
function harnessConnection(ctx) {
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

/**
 * Build the refusal check for one host context.
 * @param ctx - the Host context, used to find the harness gate.
 * @returns `(request) => number | undefined` — a status to refuse with, or
 *   undefined to let the request through.
 */
export function makeFence(ctx) {
  return function refusal(request) {
    const connection = harnessConnection(ctx)
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
