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
      {
        id: 'qwork-auto', name: '千问办公 · 标准', enabled: true, reasoning: true,
        contextWindow: 1000000, catalogContextWindow: 1000000, vision: true, catalogVision: true, effort: '',
        overridden: { contextWindow: false, image: false, effort: false },
      },
      {
        id: 'qwen4-max', name: 'Qwen4-Max', enabled: true, reasoning: true,
        contextWindow: 500000, catalogContextWindow: 1000000, vision: true, catalogVision: true, effort: 'low',
        overridden: { contextWindow: true, image: false, effort: true },
      },
      {
        id: 'glm-5.3', name: 'GLM-5.3', enabled: false, reasoning: false,
        contextWindow: 1000000, catalogContextWindow: 1000000, vision: false, catalogVision: false, effort: '',
        overridden: { contextWindow: false, image: false, effort: false },
      },
    ],
    choices: {
      contextWindows: [200000, 500000, 1000000, 2000000],
      efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultContextWindow: 1000000,
    },
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
  // 3 rows: each has an enable switch and an image switch = 6 checkboxes.
  if (switches !== 6) throw new Error('every model row must have an enable and an image switch, got ' + switches)
  if (!modelsText.includes('dsq-sw-track')) throw new Error('a switch must paint its track')
  if (!modelsText.includes('dsq-model-off')) throw new Error('a switched-off model must be marked')
  if (!modelsText.includes('glm-5.3')) throw new Error('a switched-off model must still be listed, so it can be turned back on')

  // The three capability controls are all present.
  const selects = (modelsText.match(/"type":"select"/g) ?? []).length
  console.log('selects (context + effort):', selects)
  // 2 reasoning models x (context + effort) + 1 non-reasoning x context = 5
  if (selects !== 5) throw new Error('each reasoning model needs context + effort selects, got ' + selects)

  // The two test buttons exist, and the cost is stated before they are clicked.
  if (!modelsText.includes('测连接')) throw new Error('the connection test button must exist')
  if (!modelsText.includes('测全部模型')) throw new Error('the test-all button must exist')
  // The copy must distinguish the free connection test from the paid probes.
  if (!modelsText.includes('不消耗积分')) throw new Error('the panel must say the connection test is free')
  if (!modelsText.includes('消耗')) throw new Error('the panel must warn that model probes spend credits')
  // Each model row offers its own probe.
  if (!modelsText.includes('dsq-model-foot')) throw new Error('each model row must carry its own test control')
  if (!modelsText.includes('dsq-testbar')) throw new Error('the test bar must be painted')

  // A test result must be RENDERED, not just written into state. The first cut
  // called setTestNote and never painted it, so clicking produced nothing.
  {
    let registered
    const React = {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
      },
      useState(initial) {
        // slot 0 status, slot 5 login, slot 8 testNote (see the component's order)
        renderSlot++
        if (renderSlot === 1) return [fixtures.signedIn, () => {}]
        if (renderSlot === 9) return [{ tone: 'ok', text: '连接正常：so***@example.com（210ms）' }, () => {}]
        return [typeof initial === 'function' ? initial() : initial, () => {}]
      },
      useEffect() {},
    }
    let renderSlot = 0
    const window = {
      __ModuleLoader__: {
        load({ factory }) {
          const exported = factory((name) => {
            if (name === 'react') return React
            throw new Error('unexpected require: ' + name)
          })
          exported.apply({
            slots: {
              inject: (name, run) => run(),
              register: (options, component) => { registered = { options, component } },
            },
          })
        },
      },
    }
    new Function('window', 'document', 'console', source)(window, { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } }, console)
    const tree = registered.component()
    const modelsCard = tree.children.slice(1).map(paint).find((node) => JSON.stringify(node).includes('dsq-testbar'))
    if (modelsCard === undefined) throw new Error('the models card must be painted')
    const paintedModels = JSON.stringify(modelsCard)
    if (!paintedModels.includes('连接正常')) {
      throw new Error('a test result must be rendered in the panel, not only stored in state')
    }
    console.log('test result is rendered: ok')
  }
  if (!modelsText.includes('字段'.slice(0, 0) + '上下文')) throw new Error('the context field must be labelled')
  if (!modelsText.includes('图片')) throw new Error('the image field must be labelled')
  if (!modelsText.includes('思考强度')) throw new Error('the thinking field must be labelled')
  // A model with an override says so and offers a reset.
  if (!modelsText.includes('已改')) throw new Error('an overridden field must be marked')
  if (!modelsText.includes('跟随目录')) throw new Error('an overridden field must offer a reset')
  // A non-reasoning model gets no thinking picker at all. Walk the painted tree
  // rather than a string slice, so a label elsewhere cannot mask the answer.
  const walk = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    out.push(node)
    for (const child of node.children ?? []) walk(child, out)
    return out
  }
  const nodes = walk(painted[1])
  // An enabled row's class is exactly "dsq-model"; a disabled one adds a suffix.
  const rows = nodes.filter((node) => /^dsq-model(\s|$)/.test(String(node.props?.className ?? '')))
  if (rows.length === 0) throw new Error('the model rows must be painted')
  /** The row whose id label reads exactly this model id. */
  const rowFor = (id) => rows.find((row) => walk(row).some(
    (node) => String(node.props?.className ?? '') === 'dsq-model-id' && node.children.includes(id),
  ))
  const glmNode = rowFor('glm-5.3')
  if (glmNode === undefined) throw new Error('the non-reasoning model row must be painted')
  if (JSON.stringify(glmNode).includes('思考强度')) throw new Error('a non-reasoning model must not offer a thinking level')
  const autoNode = rowFor('qwork-auto')
  if (autoNode === undefined) throw new Error('the reasoning model row must be painted')
  if (!JSON.stringify(autoNode).includes('思考强度')) throw new Error('a reasoning model must offer a thinking level')
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
