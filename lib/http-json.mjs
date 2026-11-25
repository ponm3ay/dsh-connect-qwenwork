/**
 * Reading a panel route's request body.
 *
 * A panel POST carries at most a few hundred bytes of JSON, so anything large is
 * either a mistake or an attempt to make the Host allocate: the reader refuses at
 * 64 KiB and destroys the request rather than buffering the rest.
 */

/** How large a panel request body may be. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read the request body as JSON.
 * @param request - node:http request.
 * @returns the parsed object, `{}` for an empty body.
 * @throws when the body is too large or is not a JSON object.
 */
export function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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
