/**
 * 宿主半边冒烟测试：用一个假 ctx 把 index.js 真正 apply 起来，跑完整条链路。
 *
 * 覆盖的是最容易"看起来对、跑起来错"的部分：
 *   - ctx.inject 的两处软依赖是否都进去
 *   - session/event 旁听 → 折叠 → 边界触发
 *   - 旁路调用（真 BlockAssembler 吸流）→ 严格解析 → 写入插件自己的 note 存储
 *   - 会话日志里**一条自定义事件都不许出现**（否则下次读盘整份会话被拒）
 *   - RPC snapshot 是否返回面板要的形状
 *   - 重复事件不会把 tool/call 记两次
 *
 * 不覆盖：真实 Connection 往返、真实模型、真实会话存储。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, DEFAULTS } from '../index.js'
import { readNotes } from '../lib/notes.js'

/** 每个用例一份独立的 DSH_HOME，note 存储互不串味。 */
function freshHome() {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observer-test-'))
  return process.env.DSH_HOME
}

let seq = 0
const nextSeq = () => ++seq

/** 造一个最小会话：日志可重放、能 append、能报路由。 */
function makeSession() {
  const events = []
  const appended = []
  const session = {
    id: 'sess-test',
    title: '测试会话',
    running: true,
    snapshotEvents: () => events,
    append: (type, data) => {
      const event = { type, seq: nextSeq(), time: Date.now(), data }
      appended.push(event)
      events.push(event)
      return event
    },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  }
  return { session, events, appended }
}

/** 假 ctx：只实现 index.js 真正用到的那几个面。 */
function makeCtx({ session, reply }) {
  const listeners = []
  const disposers = []
  let streamOptions = null

  const connection = {
    rpc: {
      handle(channel, handler) {
        ctx.rpcHandler = handler
        ctx.rpcChannel = channel
        return async () => {}
      },
    },
  }

  const ctx = {
    llm: {
      stream(options) {
        streamOptions = options
        return (async function* emit() {
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'usage', usage: { inputTokens: 1420, outputTokens: 138 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    sessions: { list: () => [session] },
    effect(fn) { disposers.push(fn()); return fn },
    inject(_names, callback) {
      callback({
        on(name, listener) {
          listeners.push({ name, listener })
          return () => {}
        },
        effect(fn) { disposers.push(fn()); return fn },
        connection,
      })
      return () => {}
    },
  }
  return { ctx, emit: (name, ...args) => {
    for (const entry of listeners) if (entry.name === name) entry.listener(...args)
  }, getStreamOptions: () => streamOptions }
}

test('完整链路：事件 → 折叠 → 旁路 → note 落盘 → RPC 快照', async () => {
  seq = 0
  freshHome()
  const { session, appended } = makeSession()
  // 锚点必须是窗口里真实存在的 seq。这里 seq 序列是确定的：
  // 1=user 2=step/start 3=tool/call 4=tool/result 5=step/end
  const reply = JSON.stringify({
    now: '在验证右栏面板注册',
    because: '确认扩展点',
    predict: { tool: 'bash', target: 'pnpm test', intent: '跑测试' },
    fork: null,
    alignment: 82,
    confidence: 0.72,
    anchors: [4],
  })

  const harness = makeCtx({ session, reply })
  apply(harness.ctx, { ...DEFAULTS, mode: 'smart', intervalMs: 0, minNewEvents: 1 })

  // 先确认两处软依赖都接上了
  assert.equal(harness.ctx.rpcChannel, '/session-observer')
  assert.equal(typeof harness.ctx.rpcHandler, 'function')

  harness.emit('session/event', session, { seq: nextSeq(), type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把 X 改成 Y' }] } })
  harness.emit('session/event', session, { seq: nextSeq(), type: 'step/start', data: { turn: 1, step: 1 } })
  harness.emit('session/event', session, { seq: nextSeq(), type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' } })
  harness.emit('session/event', session, { seq: nextSeq(), type: 'tool/result',
    data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false } } })
  // step/end 才是语义边界 → 触发旁路
  harness.emit('session/event', session, { seq: nextSeq(), type: 'step/end', data: { turn: 1, step: 1 } })

  await waitFor(() => readNotes('sess-test').length > 0)
  const note = readNotes('sess-test').at(-1)
  assert.ok(note !== undefined, 'note 没有落进插件存储（旁路被丢弃了）')
  assert.equal(appended.filter((entry) => entry.type === 'observer/note').length, 0,
    '自定义事件写进了会话日志 —— 宿主重启后会拒绝解释整份会话')
  assert.equal(typeof note.anchor, 'number', 'note 必须记住写入时的会话 seq，重放才能折回原位')
  assert.equal(note.data.now, '在验证右栏面板注册')
  assert.equal(note.data.alignment, 82)
  assert.deepEqual(note.data.anchors, [4])
  assert.equal(note.data.usage.inputTokens, 1420)
  assert.equal(note.data.usage.outputTokens, 138)
  assert.ok(note.data.metrics !== undefined, 'note 应该带上当时的确定性度量')

  // 请求参数的三条硬约束
  const options = harness.getStreamOptions()
  assert.ok(options !== null, '旁路模型没有被调用')
  assert.equal(options.reasoningEffort, 'off', 'reasoningEffort 必须显式 off')
  assert.equal(typeof options.maxTokens, 'number')
  assert.equal(options.sessionId, undefined, '旁路调用不能带 sessionId（会污染会话成本视图）')
  assert.equal(options.temperature, 0)

  // RPC 快照
  const result = await harness.ctx.rpcHandler('snapshot', { sessionId: 'sess-test' }, undefined)
  assert.equal(result.ok, true)
  assert.equal(result.value.goal, '把 X 改成 Y')
  assert.equal(result.value.step, 1)
  assert.equal(result.value.metrics.calls, 1)
  assert.equal(result.value.spine.length, 1)
  assert.equal(result.value.now.text, '在验证右栏面板注册')
  assert.equal(result.value.spine[0].kind, 'mile')
  assert.equal(result.value.usage.notes, 1)
  // 回归：append 会同步触发 session/event，tap 折过一次，annotate 里不能再折第二次
  assert.equal(new Set(result.value.spine.map((n) => n.seq)).size, result.value.spine.length,
    '脊柱里出现了重复 seq —— 说明 note 被折叠了两遍')
})

test('重复事件不会把同一 tool/call 记两次（replay 去重）', () => {
  seq = 0
  const { session, events } = makeSession()
  // 预置日志：模拟冷启动
  events.push({ seq: nextSeq(), type: 'step/start', data: { turn: 1, step: 1 } })
  events.push({ seq: nextSeq(), type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } })

  const harness = makeCtx({ session, reply: '{}' })
  apply(harness.ctx, { ...DEFAULTS, enabled: false })

  // 同一个事件投递两次（第一次会触发 replay，replay 已经把它折进去了）
  const event = events[events.length - 1]
  harness.emit('session/event', session, event)
  harness.emit('session/event', session, event)

  return harness.ctx.rpcHandler('snapshot', { sessionId: 'sess-test' }, undefined).then((result) => {
    assert.equal(result.value.metrics.calls, 1, '重复投递导致 tool/call 被重复计数')
  })
})

test('协议不合法的旁路回复整条丢弃，不落盘', async () => {
  seq = 0
  freshHome()
  const { session, appended } = makeSession()
  const harness = makeCtx({ session, reply: '它正在读配置。' }) // 自由文本，不是 JSON
  apply(harness.ctx, { ...DEFAULTS, mode: 'smart', intervalMs: 0, minNewEvents: 1 })

  harness.emit('session/event', session, { seq: nextSeq(), type: 'step/start', data: { turn: 1, step: 1 } })
  harness.emit('session/event', session, { seq: nextSeq(), type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' } })
  harness.emit('session/event', session, { seq: nextSeq(), type: 'step/end', data: { turn: 1, step: 1 } })

  await delay(300)
  assert.equal(readNotes('sess-test').length, 0)

  const result = await harness.ctx.rpcHandler('snapshot', { sessionId: 'sess-test' }, undefined)
  assert.ok(result.value.usage.rejected >= 1, '非法回复应该计入 rejected')
})

test('未知 RPC 端点给出结构化错误，而不是抛异常', async () => {
  seq = 0
  const { session } = makeSession()
  const harness = makeCtx({ session, reply: '{}' })
  apply(harness.ctx, { ...DEFAULTS, enabled: false })
  const result = await harness.ctx.rpcHandler('nope', {}, undefined)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown-endpoint')
})

test('没有会话时快照返回 no-session，不崩', async () => {
  seq = 0
  const harness = makeCtx({ session: { id: 'x', snapshotEvents: () => [] }, reply: '{}' })
  harness.ctx.sessions = { list: () => [] }
  apply(harness.ctx, { ...DEFAULTS, enabled: false })
  const result = await harness.ctx.rpcHandler('snapshot', {}, undefined)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'no-session')
})

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await delay(20)
  }
}
