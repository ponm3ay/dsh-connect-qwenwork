/**
 * The sign-in flow, as DSH drives it.
 *
 * QwenWork authorizes through the browser: the plugin opens an account-select
 * page carrying a PKCE challenge and a fresh machine id, the human approves
 * there, and the plugin polls the gateway until the device token lands. No
 * pasted code, and nothing is read from the desktop app's own login files.
 *
 * This module owns the flow only. The Host half (panel.mjs) decides who may
 * start one, and the credential store owns where the result is written.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { GATEWAY, CLIENT_ID, REDIRECT_URI, clientHeaders } from './constants.mjs'
import { finishLogin, pollLogin, waitForLogin } from './account.mjs'
import { abortSignal, jsonResponse, ProviderError } from './errors.mjs'
import { fetchCatalog } from './catalog.mjs'

/**
 * Begin one attempt: the URL to open, and the material the poll needs.
 * @param runtime - the discovered WASM component and its version facts.
 */
export function beginLogin(runtime) {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const nonce = randomUUID()
  const machineId = randomUUID()
  const query = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  })
  return {
    verifier,
    challenge,
    nonce,
    machineId,
    runtime,
    url: `${GATEWAY}/device/selectAccounts?${query}`,
  }
}

/**
 * Finish one attempt: poll until the browser approval lands, exchange it for
 * credentials, and read the account context the chat path needs.
 *
 * @param flow - the object `beginLogin` returned.
 * @param options.signal - aborts the wait; the caller's Cancel button.
 * @param options.fetchImpl - injectable transport for tests.
 * @returns the credentials to store, plus the account facts the panel shows.
 */
export async function completeLogin(flow, options = {}) {
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const signal = options.signal
  const tokens = await waitForLogin(flow, { ...options, fetchImpl, signal })
  const credentials = await finishLogin(flow, tokens, { fetchImpl, signal })
  return credentials
}

/**
 * After a successful login, try to seed the catalog with the account's own
 * listing. A catalog outage must not fail a login that already succeeded.
 * @returns the listing, or undefined when it could not be read.
 */
export async function seedCatalog(credentials, runtime, options = {}) {
  try {
    return await fetchCatalog(credentials, runtime, {
      fetchImpl: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
      signal: options.signal,
    })
  } catch {
    return undefined
  }
}

/**
 * Read the account context (plan, quota) for the panel's status card.
 * @returns the account document, or undefined when it cannot be read.
 */
export async function readAccount(credentials, runtime, options = {}) {
  const { getAccount, quotaForMagpie } = await import('./account.mjs')
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const context = await getAccount(credentials, runtime, { fetchImpl, signal: options.signal })
  return { context, quota: quotaForMagpie(context, credentials) }
}

export { pollLogin, abortSignal, jsonResponse, ProviderError }
