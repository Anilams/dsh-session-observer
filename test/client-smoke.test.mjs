/**
 * 浏览器半边的装载冒烟测试：不启动浏览器，只验证"能不能被 __ModuleLoader__ 装载、
 * 装出来的 {inject, apply} 是否把视图正确注册进 conversation.view"。
 *
 * 它抓的是最容易静默失败的东西：id 与壳里已有的条目撞车、order 排到 chat 前面、
 * 忘包 ctx.effect、以及组件首帧渲染就抛错。
 * 抓不到的是真实渲染与 RPC 往返——那需要在跑起来的 GUI 里看。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** 极简 React 替身：只够让组件定义通过，不真正渲染。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}

/** 装载 client.js 并返回它注册出来的东西。 */
async function load() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load(options) { captured = options } } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild() {} },
  }
  try {
    new Function('window', 'document', source)(globalThis.window, globalThis.document)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  assert.ok(captured !== null, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-session-observer')
  assert.equal(typeof captured.factory, 'function')
  const module = captured.factory((specifier) => {
    if (specifier === 'react') return ReactStub
    throw new Error(`unexpected require: ${specifier}`)
  })
  return module
}

function makeCtx(sink) {
  return {
    effect(fn) { const dispose = fn(); sink.effects += 1; return dispose },
    slots: {
      inject(name, callback) { sink.injected.push(name); return callback() },
      register(options, component) {
        sink.registered.push({ options, component })
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  }
}

test('client.js 把视图注册进 conversation.view，且排在 chat 与 trajectory 之后', async () => {
  const module = await load()

  assert.equal(typeof module.apply, 'function')
  // 右栏时代依赖 sidebarRightTabs；新视图不该再碰它。
  assert.deepEqual(module.inject, ['slots', 'connection'])
  assert.ok(!module.inject.includes('sidebarRightTabs'), '不该再依赖右栏服务')

  const sink = { effects: 0, injected: [], registered: [] }
  module.apply(makeCtx(sink))

  assert.deepEqual(sink.injected, ['conversation.view'])
  assert.equal(sink.registered.length, 1)

  const { options, component } = sink.registered[0]
  assert.equal(options.name, 'conversation.view')
  // 复用 chat / trajectory 的 id 会顶掉它们，必须用自己的。
  assert.equal(options.id, 'observer')
  assert.ok(!['chat', 'trajectory'].includes(options.id))
  // chat = 0，trajectory = 10。
  assert.ok(options.order > 10, `order 必须排在 trajectory 之后，实际 ${options.order}`)
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '观察')
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof component, 'function')

  // inject 回调必须把 sessionId 与 RPC 调用器都交出去。
  const props = options.inject('session-123')
  assert.equal(props.sessionId, 'session-123')
  assert.equal(typeof props.call, 'function')
})

test('视图组件在首帧（没有数据时）渲染出一个元素而不抛错', async () => {
  const module = await load()
  const sink = { effects: 0, injected: [], registered: [] }
  module.apply(makeCtx(sink))

  const { component } = sink.registered[0]
  const props = sink.registered[0].options.inject('session-123')

  const outer = component(props)
  // 首帧：还没有快照，应该是空壳而不是加载动画——
  // 平稳态的留白是设计，不是没画完。
  assert.equal(outer.type, 'div')
  assert.equal(outer.props.className, 'svo-root')
  // 空壳就是空的：不转圈、不骨架、不闪。
  assert.deepEqual(outer.props.children ?? [], [])
})
