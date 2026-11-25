/**
 * Shaping the panel's payloads.
 *
 * These functions are pure: they take the current store/catalog/state and return
 * the JSON the browser half renders. Keeping them out of panel.mjs is what makes
 * the shape testable without a server, and it keeps one rule in one place — the
 * browser must never be handed token material, and the capability it shows must
 * be the capability the request will actually use.
 */
import { ADAPTER_CONTEXT_WINDOW } from './constants.mjs'
import { resolveModel } from './model-resolve.mjs'
import { CONTEXT_CHOICES, EFFORTS } from './model-state.mjs'

/**
 * The account as the panel shows it, with no token material.
 *
 * `account` is the one display string; `email`/`name`/`uid` stay separate so a
 * surface can choose its own mask without re-deriving which one exists.
 */
export function describeAccount(store, now = Date.now()) {
  const current = store.peek()
  if (current === undefined) return { loggedIn: false }
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

/**
 * Every model as the panel shows it: the resolved capability plus the catalog
 * facts it overrode, so the UI can offer "follow the catalog" and name what that
 * value is.
 */
export function describeModels(catalog, modelState) {
  return catalog.listAll().map((model) => {
    const overrides = modelState === undefined ? {} : modelState.overridesOf(model.id)
    const resolved = resolveModel(model, overrides)
    return {
      id: model.id,
      name: model.name,
      enabled: modelState === undefined ? true : modelState.enabled(model.id),
      // What DSH will actually use.
      contextWindow: resolved.contextWindow,
      vision: resolved.vision,
      effort: resolved.effort ?? '',
      reasoning: resolved.reasoning,
      // What the catalog says, so "follow the catalog" has something to name.
      catalogContextWindow: ADAPTER_CONTEXT_WINDOW,
      catalogVision: model.vision === true,
      // Which fields the user has overridden.
      overridden: {
        contextWindow: overrides.contextWindow !== undefined,
        image: overrides.image !== undefined,
        effort: overrides.effort !== undefined,
      },
    }
  })
}

/** The choices the panel offers, so it never invents a level the route cannot send. */
export function describeChoices() {
  return {
    contextWindows: CONTEXT_CHOICES,
    efforts: EFFORTS,
    defaultContextWindow: ADAPTER_CONTEXT_WINDOW,
  }
}

/** The signing component's identity, for the diagnostics row. */
export function describeRuntime(runtimeProvider) {
  try {
    const runtime = runtimeProvider()
    return { available: true, version: runtime.version, releaseVersion: runtime.releaseVersion, sha256: runtime.sha256 }
  } catch (error) {
    return { available: false, error: error && error.message ? error.message : String(error) }
  }
}

/** A probe summary the panel can paint without re-deriving the rules. */
export function summariseProbes(results) {
  return {
    available: results.filter((result) => result.verdict === 'available').length,
    failed: results.filter((result) => result.verdict !== 'available' && result.verdict !== 'empty').length,
    total: results.length,
  }
}
