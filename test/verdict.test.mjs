/**
 * 判决层的测试。
 *
 * 这一层是整个视图唯一可能「喊错」的地方——一次误报就足以让用户永久静音它。
 * 所以这里的测试分两类：
 *   1. 单元：每条规则单独成立（归因顺序、冷启动、迟滞、重复不算前进）；
 *   2. 回放：拿真实会话日志跑一遍，统计它会不会在明显正常的地方喊卡住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classify, cloneVerdict, createVerdict, humanDuration, judge, observe, p90, stuckAfter,
} from '../lib/verdict.js'

/** 造一条事件。时间显式给，回放才有确定性。 */
const ev = (type, time, data = {}) => ({ type, time, data, seq: time })

/** 把一串事件喂进状态机，返回状态。 */
function feed(events, state = createVerdict()) {
  for (const event of events) observe(state, event)
  return state
}

// ── 单元 ──────────────────────────────────────────────────────────────────

test('p90：只用正间隔，且对「偶尔快」免疫', () => {
  const base = [0, 10_000, 20_000, 30_000, 40_000]
  const gaps = [10_000, 10_000, 10_000, 10_000]
  assert.equal(p90(base), gaps[Math.floor(gaps.length * 0.9)])
  // 样本不足时不给数——不许瞎猜。
  assert.equal(p90([0]), null)
  assert.equal(p90([]), null)
})

test('重复调用不算前进，新的工具目标才算', () => {
  const state = createVerdict()
  observe(state, ev('tool/call', 1000, { name: 'read', callId: 'a', arguments: '{"path":"x.ts"}' }))
  assert.equal(state.advances.length, 1, '第一次调用算前进')

  // 同参数再来一次：在动，但不前进。
  observe(state, ev('tool/call', 2000, { name: 'read', callId: 'b', arguments: '{"path":"x.ts"}' }))
  assert.equal(state.advances.length, 1, '重复调用不该刷新前进时刻')

  // 换一个目标：又前进了。
  observe(state, ev('tool/call', 3000, { name: 'read', callId: 'c', arguments: '{"path":"y.ts"}' }))
  assert.equal(state.advances.length, 2)
})

test('只有文字块算「说」，reasoning 不算', () => {
  const state = createVerdict()
  observe(state, ev('assistant/message', 1000, {
    message: { content: [{ type: 'reasoning', text: '想一想' }] },
  }))
  assert.equal(state.advances.length, 0, '纯 reasoning 不是产出')

  observe(state, ev('assistant/message', 2000, {
    message: { content: [{ type: 'text', text: '完成了' }] },
  }))
  assert.equal(state.advances.length, 1)
})

test('子代理生命周期算前进——否则长时间跑子代理会被误判', () => {
  const state = createVerdict()
  observe(state, ev('tool-workflow/agent-start', 1000))
  observe(state, ev('tool-workflow/agent-end', 5000))
  assert.equal(state.advances.length, 2)
})

test('冷启动：样本不足 20 个间隔时永不喊卡住', () => {
  const state = createVerdict()
  // 攒 10 个前进事件（9 个间隔），然后沉默 10 分钟。
  for (let index = 0; index < 10; index += 1) {
    observe(state, ev('tool/call', 1000 + index * 1000, { name: 'read', callId: String(index), arguments: `{"path":"${index}.ts"}` }))
  }
  const verdict = judge(state, 1000 + 9 * 1000 + 600_000)
  assert.equal(verdict.state, 'running', '冷启动期间只观察不报警')
  assert.equal(verdict.attribution, 'cold')
})

test('归因「用户」时，等多久都不报警', () => {
  const state = createVerdict()
  for (let index = 0; index < 30; index += 1) {
    observe(state, ev('tool/call', 1000 + index * 1000, { name: 'read', callId: String(index), arguments: `{"path":"${index}.ts"}` }))
  }
  // 回合结束 = 交回给用户。
  observe(state, ev('turn/end', 31_000))
  const verdict = judge(state, 31_000 + 3_600_000)
  assert.equal(verdict.state, 'waiting')
  assert.equal(verdict.attribution, 'user')
})

test('「等你」需要悬够门限，且用户一回来就退出', () => {
  const state = createVerdict()
  observe(state, ev('turn/end', 1000))

  // 刚交回 1 秒：不到 5 秒门限，不该占屏——否则就是一次闪烁。
  assert.equal(judge(state, 2000).state, 'running')

  // 悬够 6 秒：现在值得说了。
  assert.equal(judge(state, 7000).state, 'waiting')

  // 用户回来：立刻退出，不许卡在 waiting。
  observe(state, ev('turn/start', 8000, { turn: 2 }))
  assert.equal(judge(state, 8000).state, 'running')
})

test('有工具在飞且在预算内 → 不喊卡住（长命令的保护）', () => {
  const state = createVerdict()
  for (let index = 0; index < 30; index += 1) {
    observe(state, ev('tool/call', 1000 + index * 1000, { name: 'read', callId: String(index), arguments: `{"path":"${index}.ts"}` }))
  }
  observe(state, ev('tool/call', 31_000, { name: 'bash', callId: 'long', arguments: '{"command":"pnpm build"}' }))
  // 沉默 4 分钟，但工具还在飞。
  const verdict = judge(state, 31_000 + 240_000)
  assert.equal(verdict.state, 'running')
  assert.equal(verdict.attribution, 'tool')
})

test('工具飞过它自己的历史耗时 → 归因环境，这是最该大声的一格', () => {
  const state = createVerdict()
  // 先给 bash 攒 4 次历史，每次约 1 秒，并攒够前进样本。
  for (let index = 0; index < 30; index += 1) {
    const at = 1000 + index * 4000
    observe(state, ev('tool/call', at, { name: index % 5 === 0 ? 'bash' : 'read', callId: `c${index}`, arguments: `{"i":${index}}` }))
    observe(state, ev('tool/result', at + 1000, { message: { toolCallId: `c${index}`, isError: false } }))
  }
  const at = 1000 + 30 * 4000
  observe(state, ev('tool/call', at, { name: 'bash', callId: 'hung', arguments: '{"command":"sleep"}' }))
  const verdict = judge(state, at + 600_000)
  assert.equal(verdict.state, 'erroring')
  assert.equal(verdict.attribution, 'env')
})

test('模型真的沉默超过阈值 → 卡住，且理由是人话', () => {
  const state = createVerdict()
  for (let index = 0; index < 30; index += 1) {
    const at = 1000 + index * 1000
    observe(state, ev('tool/call', at, { name: 'read', callId: `c${index}`, arguments: `{"path":"${index}.ts"}` }))
    observe(state, ev('tool/result', at + 200, { message: { toolCallId: `c${index}`, isError: false } }))
  }
  // 沉默从**前进**的那一刻算起，而不是工具返回的那一刻。
  const advance = 1000 + 29 * 1000
  const budget = stuckAfter(state)
  assert.ok(budget !== null && budget >= 30_000, `阈值不该低于地板值，实际 ${budget}`)

  assert.equal(judge(state, advance + budget).state, 'running', '刚好到阈值还不该翻面')
  const verdict = judge(state, advance + budget + 60_000)
  assert.equal(verdict.state, 'stuck')
  assert.equal(verdict.attribution, 'model')
  assert.match(verdict.reason, /没有新进展/)
})

test('迟滞：退出异常要持续一段时间，防止色点在阈值附近跳', () => {
  const state = createVerdict()
  // 每次调用都要回结果，否则 30 个调用会一直「在飞」，被正确归因为工具在干活。
  for (let index = 0; index < 30; index += 1) {
    const at = 1000 + index * 1000
    observe(state, ev('tool/call', at, { name: 'read', callId: `c${index}`, arguments: `{"path":"${index}.ts"}` }))
    observe(state, ev('tool/result', at + 200, { message: { toolCallId: `c${index}`, isError: false } }))
  }
  const advance = 1000 + 29 * 1000
  const budget = stuckAfter(state)
  const at = advance + budget + 60_000
  assert.equal(judge(state, at).state, 'stuck')

  // 真实恢复：来了新的前进事件。
  observe(state, ev('tool/call', at + 1000, { name: 'read', callId: 'fresh', arguments: '{"path":"fresh.ts"}' }))

  // 刚恢复的一瞬间：仍维持「卡住」，不许闪。
  assert.equal(judge(state, at + 1000).state, 'stuck')
  // 条件不成立持续够久之后才回到 running。
  assert.equal(judge(state, at + 20_000).state, 'running')
})

test('cloneVerdict 是真拷贝：改副本不影响原件', () => {
  const state = createVerdict()
  observe(state, ev('tool/call', 1000, { name: 'read', callId: 'a', arguments: '{"p":1}' }))
  const copy = cloneVerdict(state)
  copy.advances.push(9999)
  copy.seen.add('x')
  copy.inflight.set('zzz', { name: 'bash', startedAt: 0 })
  assert.equal(state.advances.length, 1)
  assert.equal(state.seen.has('x'), false)
  assert.equal(state.inflight.has('zzz'), false)
})

test('classify 对无关事件返回不前进', () => {
  assert.equal(classify({ type: 'session/title', data: {} }, createVerdict()).advanced, false)
  assert.equal(classify({ type: 'step/start', data: {} }, createVerdict()).advanced, false)
})

test('humanDuration 说人话', () => {
  assert.equal(humanDuration(45_000), '45 秒')
  assert.equal(humanDuration(600_000), '10 分钟')
  assert.equal(humanDuration(3_600_000), '1 小时')
  assert.equal(humanDuration(-1), '—')
})
