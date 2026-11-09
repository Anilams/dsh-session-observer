/**
 * 密度带的事实层测试。
 *
 * 这一层负责一件事：**带子画的是「它做过什么」，不是「模型说了什么」**。
 *
 * 所以两个方向都要钉住：
 *   1. 该记的必须记——不然 free 模式下带子是一条死平线，看着像卡住；
 *   2. 不该记的绝不能记——重复调用、纯 reasoning、失败以外的结果都不算动作，
 *      不然打转的会话会被画成一条又粗又亮的线，比不画还糟。
 *
 * 另一半是「慢放」的落点：note 只有 seq，轨迹视图要 callId。两者对不上，
 * 点一下就跳到空白处，比跳不过去更糟。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, createState, toView } from '../lib/fold.js'

/** 造一条事件。seq 显式给，回放才有确定性。 */
const ev = (seq, type, time, data = {}) => ({ seq, type, time, data })

/** 把一串事件折成状态。 */
function fold(events) {
  let state = createState()
  for (const event of events) state = apply(state, event)
  return state
}

// ── 节拍：该记的 ──────────────────────────────────────────────────────────

test('工具调用记一个节拍，并带上 callId', () => {
  const state = fold([
    ev(1, 'turn/start', 1000, { turn: 1 }),
    ev(2, 'tool/call', 1100, { turn: 1, step: 1, callId: 'call_a', name: 'read', arguments: '{}' }),
  ])
  const beats = state.beats.filter((beat) => beat.k === 'tool')
  assert.equal(beats.length, 1)
  assert.equal(beats[0].t, 1100)
  assert.equal(beats[0].c, 'call_a', 'callId 就是慢放的落点，不能丢')
})

test('工具失败记一个节拍，成功的结果不记', () => {
  const ok = fold([
    ev(1, 'tool/call', 1000, { callId: 'a', name: 'read', arguments: '{}' }),
    ev(2, 'tool/result', 1200, { message: { toolCallId: 'a', isError: false } }),
  ])
  assert.equal(ok.beats.filter((beat) => beat.k === 'fail').length, 0)

  const failed = fold([
    ev(1, 'tool/call', 1000, { callId: 'a', name: 'bash', arguments: '{}' }),
    ev(2, 'tool/result', 1200, { message: { toolCallId: 'a', isError: true } }),
  ])
  assert.equal(failed.beats.filter((beat) => beat.k === 'fail').length, 1)
})

test('纯 reasoning 的消息不记节拍，说了话才记', () => {
  const reasoningOnly = fold([
    ev(1, 'assistant/message', 1000, {
      message: { content: [{ type: 'reasoning', text: '想一想' }] },
    }),
  ])
  assert.equal(reasoningOnly.beats.length, 0, '想而不说不是产出')

  const spoke = fold([
    ev(1, 'assistant/message', 1000, {
      message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '做完了' }] },
    }),
  ])
  assert.equal(spoke.beats.length, 1)
  assert.equal(spoke.beats[0].k, 'say')
})

test('用户消息只在 source.kind === user 时记节拍', () => {
  const synthetic = fold([
    ev(1, 'user/message', 1000, { source: { kind: 'system' }, content: 'AGENTS.md…' }),
  ])
  assert.equal(synthetic.beats.length, 0)

  const human = fold([
    ev(1, 'user/message', 1000, { source: { kind: 'user' }, content: '继续' }),
  ])
  assert.equal(human.beats.length, 1)
  assert.equal(human.beats[0].k, 'user')
})

test('与判决无关的事件不产生节拍（step/end、approval 等）', () => {
  const state = fold([
    ev(1, 'step/end', 1000, { step: 1 }),
    ev(2, 'approval/asked', 1100, { id: 'x' }),
  ])
  assert.equal(state.beats.length, 0, '这些不是动作，画进带子会稀释密度')
})

test('节拍有上限，长会话不会把快照撑爆', () => {
  const events = []
  for (let index = 0; index < 900; index += 1) {
    events.push(ev(index, 'tool/call', index * 10, { callId: `c${index}`, name: 'read', arguments: '{}' }))
  }
  const state = fold(events)
  assert.equal(state.beats.length, 600, '上限就是 600')
  assert.equal(state.beats.at(-1).c, 'c899', '丢的是最早的那批')
})

// ── 慢放：note 的落点 ────────────────────────────────────────────────────

test('note 的 callId 取 anchors 命中的那一次工具调用', () => {
  let state = fold([
    ev(1, 'tool/call', 1000, { callId: 'first', name: 'read', arguments: '{}' }),
    ev(2, 'tool/call', 2000, { callId: 'second', name: 'bash', arguments: '{}' }),
  ])
  state = apply(state, ev(3, 'observer/note', 2100, {
    now: '在跑测试', anchors: [1], confidence: 0.9,
  }))
  assert.equal(state.spine.at(-1).callId, 'first', '模型指的那一次优先，不是最近的')
})

test('anchors 指不到工具时退回「此刻之前最近的一次」', () => {
  let state = fold([
    ev(1, 'tool/call', 1000, { callId: 'a', name: 'read', arguments: '{}' }),
    ev(2, 'tool/call', 2000, { callId: 'b', name: 'bash', arguments: '{}' }),
    ev(3, 'step/end', 2100, { step: 1 }),
  ])
  state = apply(state, ev(4, 'observer/note', 2200, { now: '在收尾', anchors: [3], confidence: 0.8 }))
  assert.equal(state.spine.at(-1).callId, 'b')
})

test('没有工具调用时 callId 是 null——宁可不可点，也不跳到错的地方', () => {
  let state = fold([ev(1, 'turn/start', 1000, { turn: 1 })])
  state = apply(state, ev(2, 'observer/note', 1100, { now: '刚起步', anchors: [], confidence: 0.7 }))
  assert.equal(state.spine.at(-1).callId, null)
})

// ── 快照形状 ──────────────────────────────────────────────────────────────

test('toView 把节拍交给客户端', () => {
  const state = fold([
    ev(1, 'tool/call', 1000, { callId: 'a', name: 'read', arguments: '{}' }),
  ])
  const view = toView(state)
  assert.ok(Array.isArray(view.beats))
  assert.equal(view.beats.length, 1)
  assert.equal(view.beats[0].c, 'a')
})

test('无关事件返回同一引用——投影层的零下游工作保证', () => {
  const state = createState()
  assert.equal(apply(state, { seq: 1, type: '不存在的类型', time: 1, data: {} }), state)
})
