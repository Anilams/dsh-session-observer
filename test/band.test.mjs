/**
 * 密度带的算法测试。
 *
 * 这条带子是这个产品唯一「不读数字就能诊断」的东西，所以它算错的方式很阴：
 * 不会抛错、不会空白，只会把「它一直在干活」画成「它卡住了」，或者反过来。
 * 这种错误只能靠断言钉住。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}

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
  return captured.factory((specifier) => {
    if (specifier === 'react') return ReactStub
    throw new Error(`unexpected require: ${specifier}`)
  })
}

const T0 = 1_700_000_000_000
const at = (minutes) => T0 + minutes * 60_000

test('只有节拍（free 模式）时带子也不是死的', async () => {
  const { __internals } = await load()
  const { bandOf, BUCKETS } = __internals

  const beats = [
    { t: at(0), k: 'tool', c: 'a' },
    { t: at(1), k: 'tool', c: 'b' },
    { t: at(1), k: 'say' },
  ]
  const band = bandOf([], beats, T0, at(10))

  assert.equal(band.length, BUCKETS)
  assert.ok(band.some((cell) => cell.count > 0), '有动作就必须画出来，不能空白')
  assert.ok(band.some((cell) => cell.count === 0), '没动作的时段要留白——那是它卡住的证据')
})

test('最后一个时钟段是空的，而中间有动作：空白不被填平', async () => {
  const { __internals } = await load()
  const { bandOf } = __internals

  // 前 1 分钟在干活，之后 9 分钟什么都没发生。
  const band = bandOf([], [{ t: at(0), k: 'tool', c: 'a' }], T0, at(10))
  const filled = band.filter((cell) => cell.count > 0)
  assert.equal(filled.length, 1)
  assert.ok(band.slice(10).every((cell) => cell.count === 0), '卡住的尾巴必须是空的')
})

test('note 的权重高于节拍：标注过的位置更显眼', async () => {
  const { __internals } = await load()
  const { bandOf } = __internals

  const withBeat = bandOf([], [{ t: T0, k: 'tool', c: 'a' }], T0, at(1))
  const withNote = bandOf([{ at: T0, kind: 'mile' }], [], T0, at(1))
  assert.ok(withNote[0].count > withBeat[0].count, 'note 必须比节拍重')
})

test('岔路格子即使没有动作也保持琥珀标记', async () => {
  const { __internals } = await load()
  const { bandOf } = __internals
  const band = bandOf([{ at: T0, kind: 'fork' }], [], T0, at(1))
  assert.equal(band[0].fork, true)
})

test('每一格记住自己最后一次可跳转的 callId', async () => {
  const { __internals } = await load()
  const { bandOf } = __internals

  const band = bandOf([], [
    { t: at(0), k: 'tool', c: 'older' },
    { t: at(0), k: 'tool', c: 'newer' },
    { t: at(0), k: 'say' },
  ], T0, at(1))

  assert.equal(band[0].callId, 'newer', '同格里取最近一次，才符合「刚才发生了什么」')
  assert.equal(band[0].at, at(0))
})

test('格子高度按密度归一，且空白格永远最矮', async () => {
  const { __internals } = await load()
  const { bandOf } = __internals

  const busy = []
  for (let index = 0; index < 8; index += 1) busy.push({ t: at(0), k: 'tool', c: `c${index}` })
  const band = bandOf([], [...busy, { t: at(5), k: 'tool', c: 'x' }], T0, at(10))

  const tallest = Math.max(...band.map((cell) => cell.height))
  assert.equal(tallest, 22)
  assert.equal(band.filter((cell) => cell.count === 0)[0].height, 2)
})

test('时间戳落在窗口外的节拍被忽略，不会挤到首尾格子里', async () => {
  const { __internals } = await load()
  const { bandOf } = __internals

  const band = bandOf([], [
    { t: T0 - 60_000, k: 'tool', c: 'before' },
    { t: at(99), k: 'tool', c: 'after' },
  ], T0, at(10))

  assert.ok(band.every((cell) => cell.count === 0), '窗口外的事件不参与画图')
})
