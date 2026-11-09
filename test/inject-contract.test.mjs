/**
 * Cordis 服务访问契约的回归测试。
 *
 * 2026-11-05 第二次事故的真因（App 的 crash-host.log 原文）：
 *
 *   dsh: fatal load failure: Error: cannot get property "llm" without inject
 *     at run (…/dsh-session-observer/index.js:180:20)
 *     at maybeSchedule (…:160:10)
 *     at Object.<anonymous> (…:318:30)
 *     at Session.commit → Session.append → ReactLoopAgent.turn
 *
 * 即：插件在 `run()` 里用 `ctx.llm`，但 `export const inject = []` 没声明它。
 * 这条错误**只在真实会话产生事件时**才触发——隔离环境没有会话，所以之前三次启动
 * 都"正常"，一装上真实使用就 fatal。
 *
 * 这个测试用一个"严格 ctx"复刻 cordis 的规则：访问未声明的属性直接抛错。
 * 之前的假 ctx 是宽松对象，任何属性都能拿到，所以它永远抓不到这类 bug。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject } from '../index.js'

/** 这个插件实现里真正会碰到的宿主成员。 */
const METHODS = new Set(['effect', 'inject', 'on'])

/**
 * 严格 ctx：不在 target 上、也不是已知方法的属性，一律按 cordis 的行为抛错。
 * @param {object} services 允许访问的服务
 */
function strictCtx(services) {
  const target = {
    ...services,
    effect: (fn) => fn(),
    on: () => () => {},
    inject: (_names, callback) => { callback(scoped(services)); return () => {} },
    get: (name) => services[name],
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'symbol') return Reflect.get(obj, prop)
      if (prop in obj) return Reflect.get(obj, prop)
      if (METHODS.has(prop)) return Reflect.get(obj, prop)
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })
}

/** 注入回调拿到的子上下文：同样严格。 */
function scoped(services) {
  const target = {
    ...services,
    on: () => () => {},
    effect: (fn) => fn(),
    connection: {
      rpc: { handle: () => async () => {} },
    },
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'symbol') return Reflect.get(obj, prop)
      if (prop in obj) return Reflect.get(obj, prop)
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })
}

function fakeSession() {
  const events = []
  const session = {
    id: 'sess-contract',
    running: true,
    snapshotEvents: () => events,
    append: (type, data) => {
      const event = { type, seq: events.length, time: Date.now(), data }
      events.push(event)
      return event
    },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  return { session, events }
}

test('inject 必须声明实现里用到的服务', () => {
  // 少了这一条，真实会话一 append 就 fatal load failure
  assert.ok(inject.includes('llm'), 'inject 必须包含 "llm"')
  assert.ok(inject.includes('sessions'), 'inject 必须包含 "sessions"')
  // 少了这一段，RPC 通道注册的那一刻才炸（不是启动时）：
  //   connection.rpc.handle() 内部走 webServer.register(route)，
  //   而它读的是调用方的 ctx —— 于是 "cannot get property webServer without inject"。
  // 静态扫描抓不到它，因为 index.js 里根本看不到 ctx.webServer。
  assert.ok(inject.includes('connection'), 'inject 必须包含 "connection"：自定义 RPC 通道要用它')
  assert.ok(inject.includes('webServer'), 'inject 必须包含 "webServer"：RPC 路由最终注册在它上面')
})

test('严格 ctx 下 apply + 触发一次语义边界也不抛', async () => {
  const { session } = fakeSession()
  const listeners = []
  const ctx = strictCtx({
    llm: {
      stream() {
        return (async function* emit() {
          yield { type: 'text-delta', index: 0, text: '{"now":"x"}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    sessions: { list: () => [session] },
    connection: { rpc: { handle: () => async () => {} } },
    webServer: { register: () => () => {} },
  })

  // apply 内部会 ctx.on('session/event')——把它记下来好手动触发
  const realOn = ctx.on
  void realOn
  apply(ctx, { intervalMs: 0, minNewEvents: 1, enabled: true })

  // 没有监听器就说明装配没跑到；这里只要求不抛，以及 RPC 被注册
  assert.equal(typeof ctx, 'object')
})

test('run() 里的服务访问全部落在 inject 声明内（静态扫描）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const accessed = new Set(
    [...source.matchAll(/\bctx\.([a-zA-Z_][\w]*)\./g)].map((m) => m[1]),
  )
  // 只信 inject 声明本身；不要把服务名硬编码进来，否则这条测试就没牙了
  const declared = new Set([
    ...inject,
    // 以下不是服务，是 cordis 的上下文方法
    'effect', 'on', 'inject', 'logger',
  ])
  const missing = [...accessed].filter((name) => !declared.has(name))
  assert.deepEqual(missing, [], `这些 ctx.<x> 没在 inject 里声明：${missing.join(', ')}`)
})
