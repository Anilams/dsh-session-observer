/**
 * note 存储与「重放时按 anchor 归位」的测试。
 *
 * 2026-11-06 事故之后，note 不再进会话日志：写进日志的自定义事件会让宿主
 * 在读盘时拒绝解释整份会话（20 份会话因此打不开）。这里钉住两件事：
 *   1. 存储本身：追加、排序、坏行跳过、条数上限；
 *   2. 重放：note 必须折在 anchor 之后、下一条日志事件之前——顺序错了，
 *      预测命中判定就会跟真实动作错位。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendNote, MAX_NOTES, notesDir, readNotes } from '../lib/notes.js'
import { apply, DEFAULTS } from '../index.js'

function freshHome() {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observer-notes-'))
  return process.env.DSH_HOME
}

test('追加后按 anchor 升序读回', () => {
  freshHome()
  appendNote('s1', { anchor: 9, time: 30, data: { now: 'c' } })
  appendNote('s1', { anchor: 2, time: 10, data: { now: 'a' } })
  appendNote('s1', { anchor: 5, time: 20, data: { now: 'b' } })

  const notes = readNotes('s1')
  assert.deepEqual(notes.map((note) => note.data.now), ['a', 'b', 'c'])
  assert.deepEqual(notes.map((note) => note.anchor), [2, 5, 9])
})

test('坏行整行跳过，不牵连其他标注', () => {
  freshHome()
  appendNote('s2', { anchor: 1, time: 1, data: { now: 'keeping' } })
  const file = path.join(notesDir(), `${encodeURIComponent('s2')}.jsonl`)
  fs.appendFileSync(file, '{"v":1,"anchor":2,\n', 'utf8') // 半截行
  appendNote('s2', { anchor: 3, time: 3, data: { now: 'also-keeping' } })

  const notes = readNotes('s2')
  assert.deepEqual(notes.map((note) => note.data.now), ['keeping', 'also-keeping'])
})

test('只保留最后 MAX_NOTES 条', () => {
  freshHome()
  for (let i = 0; i < MAX_NOTES + 50; i += 1) {
    appendNote('s3', { anchor: i, time: i, data: { now: `n${i}` } })
  }
  const notes = readNotes('s3', MAX_NOTES)
  assert.equal(notes.length, MAX_NOTES)
  assert.equal(notes.at(-1).data.now, `n${MAX_NOTES + 49}`)
})

test('会话 id 里的怪字符不会逃出存储目录', () => {
  freshHome()
  appendNote('../../etc/passwd', { anchor: 0, time: 0, data: { now: 'x' } })
  const files = fs.readdirSync(notesDir())
  assert.equal(files.length, 1)
  assert.ok(!files[0].includes('/'))
})

/** 最小 ctx：只实现 index.js 真正用到的面（与 host-smoke 同构）。 */
function makeCtx(session) {
  const listeners = []
  const connection = {}
  const webServer = makeWebServer()
  const ctx = {
    llm: { stream: () => { throw new Error('不应触发旁路：enabled=false') } },
    sessions: { list: () => [session] },
    effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch { /* noop */ } } },
    connection,
    webServer,
    routes: webServer.routes,
    inject(_names, callback) {
      callback({
        on(name, listener) { listeners.push({ name, listener }); return () => {} },
        effect(fn) { fn(); return () => {} },
      })
      return () => {}
    },
  }
  return ctx
}

test('重放时 note 折在 anchor 之后、下一条事件之前', async () => {
  freshHome()
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'a', name: 'read', arguments: '{"path":"a"}' } },
    { seq: 2, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'b', name: 'bash', arguments: '{"command":"pnpm test"}' } },
  ]
  // 写一条带预测的 note，锚在 seq 2。
  appendNote('sess-replay', {
    anchor: 2,
    time: 100,
    data: { now: '准备跑测试', predict: { tool: 'bash', target: 'pnpm test', intent: '跑测试' }, confidence: 0.8 },
  })

  const session = { id: 'sess-replay', snapshotEvents: () => events, requestHeader: () => undefined }
  const ctx = makeCtx(session)
  apply(ctx, { ...DEFAULTS, enabled: false })

  const result = await callRoute(ctx, 'snapshot', { sessionId: 'sess-replay' })
  assert.equal(result.ok, true)
  assert.equal(result.value.now.text, '准备跑测试', 'note 没被折回来')
  assert.equal(result.value.spine.length, 1)
  // 顺序证据：note(anchor 2) 的预测必须被 seq 3 的 tool/call 判定掉，1 命中。
  assert.equal(result.value.prediction.history.length, 1, 'note 没有折在 anchor 之后 —— 预测没被后续动作判定')
  assert.equal(result.value.prediction.history[0], 'full')
  assert.equal(result.value.metrics.calls, 2)
})

/** 假 webServer：记录注册进来的路由，供测试直接驱动。 */
function makeWebServer() {
  const routes = new Map()
  return { routes,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/**
 * 走一遍真实的 node:http 桥接：假 req 是异步可迭代的，假 res 收集状态码与 body。
 * 这样测试覆盖到的是 mountRoute 的整条路径，而不是直接调 handler。
 */
async function callRoute(ctx, endpoint, payload, { method = 'POST' } = {}) {
  const route = ctx.webServer.routes.get('/session-observer')
  if (route === undefined) throw new Error('RPC 路由没有注册')
  const body = method === 'POST'
    ? JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload })
    : ''
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  const req = {
    method,
    url: `/session-observer/${endpoint}`,
    headers: { host: '127.0.0.1:3097', 'content-type': 'application/json' },
    [Symbol.asyncIterator]() {
      let index = 0
      return { async next() { return index < chunks.length ? { value: chunks[index++], done: false } : { done: true, value: undefined } } }
    },
    destroy() {},
  }
  const state = { status: 0, body: '', ended: false }
  const res = {
    writeHead(status) { state.status = status },
    write(chunk) { state.body += Buffer.from(chunk).toString('utf8'); return true },
    end(chunk) { if (chunk !== undefined) state.body += Buffer.from(chunk).toString('utf8'); state.ended = true },
    on() {},
    once() {},
    off() {},
    get writableEnded() { return state.ended },
  }
  await route.handler(req, res)
  if (state.status !== 200) throw new Error(`RPC ${endpoint} 返回 HTTP ${state.status}: ${state.body}`)
  return JSON.parse(state.body).result
}
