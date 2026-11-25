/**
 * Load the browser half the way DSH's client module system does: a
 * `window.__ModuleLoader__.load({ id, factory })` call whose factory is handed
 * a `require` for the shared modules. This checks the module registers into
 * `settings.section` and that its render function produces a tree from a
 * status payload, without a browser.
 *
 * Run from a directory whose node_modules holds the extracted runtime:
 *   node scripts/client.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// A minimal React stand-in: createElement returns a plain node so a render can
// be inspected without a DOM.
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
}
const hooks = []
const React = {
  createElement,
  useState(initial) {
    const pair = [typeof initial === 'function' ? initial() : initial, () => {}]
    hooks.push(pair)
    return pair
  },
  useEffect(effect) { hooks.push(['effect', effect]) },
}

let registered
let injectedSlot
const ctx = {
  slots: {
    inject(name, run) {
      injectedSlot = name
      run()
    },
    register(options, component) {
      registered = { options, component }
      return () => {}
    },
  },
}

const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const require = (name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      }
      const exported = factory(require)
      if (exported === undefined || exported.apply === undefined) throw new Error('the module exported no apply()')
      console.log('module id:', id)
      exported.apply(ctx)
      console.log('inject:', JSON.stringify(exported.inject))
      console.log('slot:', injectedSlot)
      if (registered === undefined) throw new Error('the panel did not register into a slot')
      console.log('section:', registered.options.name, '/', registered.options.id, 'order', registered.options.order)
      console.log('label:', registered.options.label())

      // The component is a function component: calling it returns a tree.
      const tree = registered.component()
      if (tree === undefined || tree === null) throw new Error('the component rendered nothing')
      console.log('rendered root:', tree.type, 'children:', tree.children.length)

      // Its helpers must be exported for the module's own tests.
      const test = exported.__test
      if (test === undefined) throw new Error('the module exported no __test helpers')
      const state = test.stateOf(undefined)
      console.log('stateOf(undefined):', JSON.stringify(state))
      if (state.text !== '正在读取账号状态…') throw new Error('stateOf must describe the loading state')
      const signedOut = test.stateOf({ loggedIn: false })
      console.log('stateOf(signed-out):', JSON.stringify(signedOut))
      if (signedOut.text !== '还没登录') throw new Error('stateOf must describe the signed-out state')
      const expired = test.stateOf({ loggedIn: true, expired: true })
      if (expired.text !== '凭据已过期') throw new Error('stateOf must describe the expired state')
      const on = test.stateOf({ loggedIn: true, expiresInMs: 3600_000 })
      if (on.text !== '已登录') throw new Error('stateOf must describe the signed-in state')
      console.log('maskAccount:', test.maskAccount('someone@example.com'))
      if (test.maskAccount('someone@example.com') !== 'so***@example.com') throw new Error('maskAccount must keep only the first two characters')
      console.log('remaining:', test.remaining(90_000_000), '/', test.remaining(-1))
      if (test.remaining(-1) !== '已过期') throw new Error('remaining must report an expired interval')
    },
  },
}

// Evaluate the browser bundle with the fake window in scope.
const runner = new Function('window', 'console', source)
runner(window, console)
console.log('CLIENT OK')
