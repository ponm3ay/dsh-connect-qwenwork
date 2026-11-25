/**
 * Load the browser half the way DSH's client module system does: a
 * `window.__ModuleLoader__.load({ id, factory })` call whose factory is handed
 * a `require` for the shared modules. This checks the module registers into
 * `settings.section`, and that its render function produces the right tree for
 * each of the three states a real panel shows: signed out, waiting for the
 * browser, and signed in.
 *
 * Run from the plugin directory:
 *   node scripts/client.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

const fixtures = {
  signedOut: { loggedIn: false, models: [], runtime: { available: true, version: '2.1.0', releaseVersion: '2.1.0-26111906' } },
  waiting: { loggedIn: false, loggingIn: true, models: [], runtime: { available: true, version: '2.1.0', releaseVersion: '2.1.0-26111906' } },
  signedIn: {
    loggedIn: true,
    account: 'someone@example.com',
    plan: '专业版',
    expires: new Date(Date.now() + 26 * 3600_000).toISOString(),
    expiresInMs: 26 * 3600_000,
    balance: { balance: '剩余 12,480 积分', windows: [{ name: '办公积分', display: '12,480' }] },
    models: [
      { id: 'qwork-auto', name: '千问办公 · 标准', enabled: true },
      { id: 'qwen4-max', name: 'Qwen4-Max', enabled: true },
      { id: 'glm-5.3', name: 'GLM-5.3', enabled: false },
    ],
    modelsRefreshedAt: Date.now(),
    store: 'D:\\.dsh\\.qwenwork-auth.json',
    runtime: { available: true, version: '2.1.0', releaseVersion: '2.1.0-26111906' },
  },
}

/**
 * Render the panel once against a fixture, the way the browser would.
 *
 * The component owns its state, so the React stub hands back the fixture from
 * the first `useState` (which is the status slot) and inert setters after it.
 */
function render(statusFixture, { loginPending = false } = {}) {
  let registered
  let slotName
  let slot = 0

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    /**
     * The component declares its state slots in a fixed order:
     * 0 status, 1 busy, 2 note, 3 confirming, 4 modelsNote, 5 login.
     * Feeding the fixture into slot 0 and the pending login into slot 5 is what
     * lets one render cover every visual state without a real browser.
     */
    useState(initial) {
      const index = slot++
      if (index === 0) return [statusFixture, () => {}]
      if (index === 5) {
        return [loginPending ? { url: 'https://gateway.qwenwork.cn/device/selectAccounts?challenge=abc', instructions: '在新标签页完成千问办公授权' } : undefined, () => {}]
      }
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }

  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        const exported = factory((name) => {
          if (name === 'react') return React
          throw new Error('unexpected require: ' + name)
        })
        if (typeof exported.apply !== 'function') throw new Error('the module exported no apply()')
        exported.apply({
          slots: {
            inject(name, run) {
              slotName = name
              run()
            },
            register(options, component) {
              registered = { options, component }
              return () => {}
            },
          },
        })
        return { id, exported }
      },
    },
  }

  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild() {} },
  }
  new Function('window', 'document', 'console', source)(window, document, console)

  if (registered === undefined) throw new Error('the panel did not register into a slot')
  if (slotName !== 'settings.section') throw new Error('the panel must register into settings.section, got ' + slotName)
  const tree = registered.component()
  if (tree === undefined || tree === null) throw new Error('the component rendered nothing')
  return { tree, options: registered.options }
}

/** Expand a card component element into the node the browser paints. */
function paint(card) {
  return card.type(card.props)
}

const seen = {}

// ---- signed out ------------------------------------------------------------
{
  const { tree, options } = render(fixtures.signedOut)
  seen.section = `${options.name}/${options.id} order ${options.order} label=${options.label()}`
  const [header, ...cards] = tree.children
  if (header.type !== 'header') throw new Error('the page must start with a header')
  console.log('section:', seen.section)
  console.log('header:', header.children.map((child) => child.children.join('')).join(' / '))
  if (cards.length !== 2) throw new Error('signed out must paint account + diagnostics, got ' + cards.length)
  const painted = cards.map(paint)
  for (const node of painted) {
    if (node.props.className !== 'dsq-card') throw new Error('each section must paint a dsq-card')
  }
  const titles = painted.map((node) => node.children[0].children.map((child) => (Array.isArray(child.children) ? child.children.join('') : '')).join(''))
  console.log('signed-out cards:', titles.join(', '))
  if (titles.some((title) => title.includes('可用模型'))) {
    throw new Error('a signed-out panel must not advertise a model card')
  }
  const text = JSON.stringify(tree)
  if (!text.includes('登录')) throw new Error('a signed-out panel must offer the login action')
}

// ---- waiting for the browser -----------------------------------------------
{
  const { tree } = render(fixtures.waiting, { loginPending: true })
  const painted = tree.children.slice(1).map(paint)
  const account = painted[0]
  const text = JSON.stringify(account)
  if (!text.includes('等待浏览器授权')) throw new Error('a pending login must show the waiting block')
  if (!text.includes('dsq-spinner')) throw new Error('a pending login must show progress, not just words')
  if (!text.includes('device/selectAccounts')) throw new Error('a pending login must offer the authorization link')
  if (text.includes('dsq-btn-primary')) throw new Error('the login button must give way to the waiting block')
  console.log('waiting: spinner + link + cancel, no duplicate login button')
}

// ---- signed in -------------------------------------------------------------
{
  const { tree } = render(fixtures.signedIn)
  const painted = tree.children.slice(1).map(paint)
  if (painted.length !== 3) throw new Error('signed in must paint account + models + diagnostics, got ' + painted.length)
  const titles = painted.map((node) => node.children[0].children.map((child) => (Array.isArray(child.children) ? child.children.join('') : '')).join(''))
  console.log('signed-in cards:', titles.join(', '))
  // The models card counts what is on, not what exists: 2 of 3 here.
  if (!titles.some((title) => title.includes('可用模型（2/3）'))) {
    throw new Error('the models card must count enabled over total, got ' + titles.join(' | '))
  }
  const accountText = JSON.stringify(painted[0])
  if (!accountText.includes('12,480')) throw new Error('the balance must be shown')
  if (!accountText.includes('so***@example.com')) throw new Error('the account must be masked')
  if (accountText.includes('someone@example.com')) throw new Error('the full account must never be rendered')
  if (!accountText.includes('已登录')) throw new Error('the status pill must say it is signed in')

  // Every model row carries a real checkbox, and a switched-off one is marked.
  const modelsText = JSON.stringify(painted[1])
  const switches = (modelsText.match(/"type":"checkbox"/g) ?? []).length
  console.log('model switches:', switches)
  if (switches !== 3) throw new Error('every model row must have a switch, got ' + switches)
  if (!modelsText.includes('dsq-sw-track')) throw new Error('a switch must paint its track')
  if (!modelsText.includes('dsq-model-off')) throw new Error('a switched-off model must be marked')
  if (!modelsText.includes('glm-5.3')) throw new Error('a switched-off model must still be listed, so it can be turned back on')
}

// ---- helpers ---------------------------------------------------------------
{
  const { tree } = render(fixtures.signedOut)
  void tree
  // Reach the helpers through a fresh load.
  let exported
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory(() => ({ createElement: () => ({}), useState: (v) => [v, () => {}], useEffect() {} }))
      },
    },
  }
  new Function('window', 'document', 'console', source)(window, { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } }, console)
  const test = exported.__test
  if (test === undefined) throw new Error('the module exported no __test helpers')

  const cases = [
    ['stateOf(undefined)', test.stateOf(undefined), { text: '正在读取…' }],
    ['stateOf(signed-out)', test.stateOf({ loggedIn: false }), { text: '未登录' }],
    ['stateOf(expired)', test.stateOf({ loggedIn: true, expired: true }), { text: '已过期' }],
    ['stateOf(soon)', test.stateOf({ loggedIn: true, expiresInMs: 60_000 }), { tone: 'warn' }],
    ['stateOf(on)', test.stateOf({ loggedIn: true, expiresInMs: 3600_000 }), { text: '已登录', live: true }],
  ]
  for (const [name, actual, expected] of cases) {
    console.log(name + ':', JSON.stringify(actual))
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) throw new Error(name + ' must have ' + key + '=' + JSON.stringify(value))
    }
  }
  if (test.maskAccount('someone@example.com') !== 'so***@example.com') throw new Error('maskAccount must keep only the first two characters')
  if (test.remaining(-1) !== '已过期') throw new Error('remaining must report an expired interval')
  const split = test.splitBalance('剩余 1,234.5 积分')
  console.log('splitBalance:', JSON.stringify(split))
  if (split.num !== '1,234.5' || split.suffix !== '积分') throw new Error('splitBalance must separate the number from its suffix')
  if (test.splitBalance('读不到').num !== '读不到') throw new Error('splitBalance must keep a numberless display whole')
}

console.log('CLIENT OK')
