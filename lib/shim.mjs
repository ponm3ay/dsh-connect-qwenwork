/**
 * The loopback shim: a tiny OpenAI-shaped server on 127.0.0.1 that holds the
 * QwenWork credentials and speaks the gateway's signed protocol.
 *
 * WHY A SHIM AT ALL. DSH's chat path is pi-ai's `openai-completions` API, which
 * builds the request body and wire headers itself. QwenWork needs things that
 * API cannot express: a WASM-signed header set over the exact body bytes, the
 * envelope the desktop app sends instead of a plain completion body, and a
 * different destination URL. Putting a loopback hop in between leaves every one
 * of those in one place, and keeps DSH's own request contract untouched. The
 * same shape is what dsh-connect-autoclaw / workbuddy / qoder use; this plugin
 * copies the pattern rather than inventing a second one.
 *
 * The shim binds to 127.0.0.1 on an ephemeral port and requires a per-process
 * random secret, so nothing else on the machine can drive it by accident.
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chatResponse } from './chat.mjs'
import { ProviderError, errorResponse } from './errors.mjs'

/** How many ports to roll before giving up on a Fetch-refused one. */
const PORT_ROLL_LIMIT = 5

function listenOnce(server) {
  return new Promise((resolve, reject) => {
    const settle = () => {
      server.off('listening', onListening)
      server.off('error', onError)
      server.off('close', onClose)
    }
    const onListening = () => { settle(); resolve() }
    const onError = (error) => { settle(); reject(error) }
    const onClose = () => { settle(); resolve() }
    server.once('listening', onListening)
    server.once('error', onError)
    server.once('close', onClose)
    server.listen(0, '127.0.0.1')
  })
}

/**
 * Whether this runtime's Fetch refuses the port without connecting. The Fetch
 * standard bans a list of ports, and every client of this shim goes through the
 * same global fetch, so a banned port would be silent and total. Asking the
 * client itself cannot disagree with it.
 */
async function clientRefusesPort(port) {
  try {
    await fetch('http://127.0.0.1:' + port + '/healthz')
    return false
  } catch (error) {
    let current = error
    for (let depth = 0; depth < 4; depth++) {
      if (!(current instanceof Error)) return false
      if (current.message === 'bad port') return true
      current = current.cause
    }
    return false
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'qwenwork shim: bad or missing secret', type: 'invalid_request_error' } }))
}

/**
 * Whether an OpenAI-shaped message list carries an image part.
 *
 * Only the shapes pi-ai actually emits are inspected: a `content` array whose
 * parts have `type: "image_url"` (or the Responses spelling `input_image`).
 * Anything else is text, which every model takes.
 */
function hasImagePart(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') return true
    }
  }
  return false
}

/**
 * Bind the shim.
 *
 * @param options.store - the credential store (`resolve()` gives live credentials).
 * @param options.catalog - the current catalog (`list()` / `get(id)`), read per request so a refresh applies live.
 * @param options.runtimeProvider - resolves the WASM component and its version facts.
 * @param options.signer - the WASM signing entry point (injectable for tests).
 * @param options.log - a logger for transport failures.
 * @returns the loopback handle: `ready` settles once a reachable port is bound.
 */
export function createShim(options) {
  const store = options.store
  const catalog = options.catalog
  const runtimeProvider = options.runtimeProvider
  const signer = options.signer
  const log = options.log ?? (() => {})
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const secret = randomBytes(24).toString('hex')
  const server = createServer(handle)
  let port

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      const given = Buffer.from(String(req.headers.authorization || ''))
      const want = Buffer.from('Bearer ' + secret)
      if (given.length !== want.length || !timingSafeEqual(given, want)) return unauthorized(res)

      if (url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: catalog.listResolved().map((model) => ({ id: model.id, object: 'model', owned_by: 'qwenwork' })),
        }))
        return
      }
      if (url.pathname !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'qwenwork shim: unknown path ' + url.pathname } }))
        return
      }

      const raw = await readBody(req)
      let request
      try {
        request = JSON.parse(raw)
      } catch {
        throw new ProviderError('千问办公适配器收到无效的请求体', 400, 'invalid_request_error')
      }
      const modelId = request?.model
      // A model the user switched off is not servable: a stale picker entry or a
      // retried request must not reach it either. The resolved entry carries the
      // user's capability overrides, so the request is shaped from what the user
      // configured rather than from the raw catalog.
      const selected = typeof modelId === 'string' ? catalog.resolved(modelId) : undefined
      if (selected === undefined) {
        throw new ProviderError('该模型不在千问办公当前目录中，或已被关闭，请刷新模型目录或切换模型', 400, 'invalid_request_error')
      }
      // A model the user configured as text-only must not be handed an image,
      // even if the catalog advertises vision for it.
      if (!selected.vision && hasImagePart(request?.messages)) {
        throw new ProviderError('该模型被设为不支持图片输入，请在设置里打开它的图片能力', 400, 'invalid_request_error')
      }

      const credentials = await store.resolve()
      const runtime = runtimeProvider()
      const response = await chatResponse({ ...request, model: modelId, stream: true }, credentials, runtime, {
        selected,
        signer,
        fetchImpl,
        signal: undefined,
      })

      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        ...(response.status === 429 ? { 'Retry-After': '60' } : {}),
        ...(response.status === 401 ? { 'X-QwenWork-Sign-In': 'expired' } : {}),
      })
      if (response.body === null) {
        res.end()
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(typeof value === 'string' ? value : decoder.decode(value, { stream: true }))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      res.end()
    } catch (error) {
      const message = error?.message ? error.message : String(error)
      log('qwenwork shim: ' + message)
      if (!res.headersSent) {
        const payload = await errorResponse(error instanceof ProviderError ? error : new ProviderError(message)).text()
        const status = error instanceof ProviderError ? error.status : 502
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(payload)
      } else {
        res.end()
      }
    }
  }

  const ready = (async () => {
    for (let attempt = 0; attempt < PORT_ROLL_LIMIT; attempt++) {
      await listenOnce(server)
      port = server.address().port
      if (!(await clientRefusesPort(port))) return port
      await new Promise((resolve) => server.close(resolve))
    }
    throw new Error('qwenwork shim: could not bind a port the client accepts')
  })()

  return {
    ready,
    secret: () => secret,
    port: () => port,
    baseUrl: () => 'http://127.0.0.1:' + port,
    close: () => { try { server.close() } catch { /* already down */ } },
  }
}
