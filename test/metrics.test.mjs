import assert from 'node:assert/strict'
import test from 'node:test'

import { computeMetrics, hitRate, normalizeTarget, scorePrediction, reasoningHead } from '../lib/metrics.js'
import { apply, createState, toView } from '../lib/fold.js'
import { parseNote } from '../lib/prompt.js'

let seq = 0
const call = (name, args, step = 1) => ({ seq: ++seq, type: 'tool/call',
  data: { turn: 1, step, callId: `c${seq}`, name, arguments: JSON.stringify(args) } })
const ok = () => ({ seq: ++seq, type: 'tool/result',
  data: { turn: 1, step: 1, message: { toolCallId: `c${seq - 1}`, isError: false } } })
const fail = (reason = 'boom') => ({ seq: ++seq, type: 'tool/result',
  data: { turn: 1, step: 1, message: { toolCallId: `c${seq - 1}`, isError: true },
    error: { name: 'Error', code: 'E', reason } } })

test('重复检测：同 tool 同参数第二次即标记', () => {
  seq = 0
  const events = [call('bash', { command: 'npm test' }), ok(), call('bash', { command: 'npm test' }), ok()]
  const { metrics, calls } = computeMetrics(events)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].repeat, false)
  assert.equal(calls[1].repeat, true)
  assert.equal(metrics.repeat_rate, 0.5)
})

test('失败率与连续失败 streak', () => {
  seq = 0
  const events = [
    call('bash', { command: 'a' }), fail('x'),
    call('bash', { command: 'b' }), fail('y'),
    call('bash', { command: 'c' }), ok(),
  ]
  const { metrics, flags } = computeMetrics(events)
  assert.equal(metrics.tool_fail_rate, round2(2 / 3))
  assert.equal(metrics.max_fail_streak, 2)
  assert.ok(flags.some((f) => f.kind === 'fail-streak'))
})

test('破坏性操作被规则表捕获', () => {
  seq = 0
  const events = [call('bash', { command: 'rm -rf /tmp/x' }), ok()]
  const { metrics, flags } = computeMetrics(events)
  assert.equal(metrics.destructiveness, 1)
  assert.ok(flags.some((f) => f.kind === 'destructive' && f.level === 'high'))
})

test('进展率：失败的目标不推进', () => {
  seq = 0
  const events = [
    { seq: ++seq, type: 'step/start', data: { turn: 1, step: 1 } },
    call('read', { path: 'a.ts' }), fail(),
    { seq: ++seq, type: 'step/end', data: { turn: 1, step: 2 } },
  ]
  const { metrics } = computeMetrics(events)
  assert.equal(metrics.progress_rate, 0)
  assert.equal(metrics.steps, 1)
})

test('预测判定：工具名先于目标', () => {
  assert.equal(scorePrediction({ tool: 'bash', target: 'npm test' }, { name: 'bash', target: 'npm test -- auth' }), 'full')
  assert.equal(scorePrediction({ tool: 'bash', target: 'npm test' }, { name: 'bash', target: 'ls' }), 'partial')
  assert.equal(scorePrediction({ tool: 'bash', target: 'npm test' }, { name: 'read', target: 'npm test' }), 'miss')
  assert.equal(scorePrediction(null, { name: 'bash', target: 'x' }), 'miss')
})

test('归一化与命中率', () => {
  assert.equal(normalizeTarget("  'npm   test' "), 'npm test')
  assert.equal(hitRate(['full', 'full', 'partial', 'miss']), 0.63)
  assert.equal(hitRate([]), null)
})

test('reasoning 前缀采样只取 reasoning 块', () => {
  const message = { message: { content: [
    { type: 'reasoning', text: '思考一' },
    { type: 'text', text: '正文' },
    { type: 'reasoning', text: '思考二' },
  ] } }
  assert.equal(reasoningHead(message), '思考一\n思考二')
})

test('折叠：note 进脊柱，预测在真实动作到达时被判定', () => {
  seq = 0
  let state = createState()
  state = apply(state, { seq: ++seq, type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把 X 改成 Y' }] } })
  assert.equal(state.goal, '把 X 改成 Y')

  state = apply(state, { seq: 500, type: 'observer/note', data: {
    now: '在读 session 存储实现', because: '需要先确认数据形状',
    predict: { tool: 'edit', target: 'src/auth.ts', intent: '改校验' },
    fork: null, alignment: 88, confidence: 0.7, anchors: [400], usage: { inputTokens: 1400, outputTokens: 120, ms: 900 },
  } })
  assert.equal(state.spine.length, 1)
  assert.equal(state.now.text, '在读 session 存储实现')
  assert.deepEqual(state.pending, { tool: 'edit', target: 'src/auth.ts', intent: '改校验' })

  // 真实动作到达 → 命中
  state = apply(state, call('edit', { path: 'src/auth.ts' }))
  assert.deepEqual(state.predictionHistory, ['full'])
  assert.equal(state.pending, null)

  // 未命中
  state = apply(state, { seq: 600, type: 'observer/note', data: {
    now: '跑测试', because: null, predict: { tool: 'bash', target: 'npm test', intent: '验证' },
    fork: null, alignment: 90, confidence: 0.6, anchors: [500], usage: null } })
  state = apply(state, call('read', { path: 'package.json' }))
  assert.deepEqual(state.predictionHistory, ['full', 'miss'])
})

test('折叠：无关事件返回同一引用（投影的零下游工作保证）', () => {
  const state = createState()
  assert.equal(apply(state, { seq: 1, type: 'request/header', data: {} }), state)
})

test('折叠：用户换目标会清空旧标注', () => {
  let state = createState()
  state = apply(state, { seq: 1, type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一件事' }] } })
  state = apply(state, { seq: 2, type: 'observer/note', data: { now: '在做 A', alignment: 90, confidence: 0.8, anchors: [1] } })
  state = apply(state, { seq: 3, type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '换个任务' }] } })
  assert.equal(state.goal, '换个任务')
  assert.equal(state.now, null)
})

test('toView 汇总风险等级与预测增量', () => {
  let state = createState()
  state = apply(state, { seq: 1, type: 'observer/note', data: { now: 'x', alignment: 80, confidence: 0.5, anchors: [1] } })
  state = { ...state, predictionHistory: ['full', 'miss'], baselineRate: 0.9 }
  const view = toView(state)
  assert.equal(view.prediction.rate, 0.5)
  assert.equal(view.prediction.delta, -40)
  assert.equal(view.risk, 0)
})

test('note 解析：七个成员缺一不可', () => {
  const valid = {
    now: '在读配置', because: '确认默认值', predict: { tool: 'read', target: 'config.yaml', intent: '看默认' },
    fork: null, alignment: 70, confidence: 0.6, anchors: [12],
  }
  const ctx = { validSeqs: new Set([12, 13]) }
  assert.equal(parseNote(JSON.stringify(valid), ctx).now, '在读配置')

  const missing = { ...valid }
  delete missing.confidence
  assert.throws(() => parseNote(JSON.stringify(missing), ctx), /member set mismatch/)

  // anchor 不存在 → 整条作废（结构性防幻觉）
  assert.throws(() => parseNote(JSON.stringify({ ...valid, anchors: [999] }), ctx), /not in window/)
  // 越界 alignment
  assert.throws(() => parseNote(JSON.stringify({ ...valid, alignment: 120 }), ctx), /bad alignment/)
  // 非 JSON
  assert.throws(() => parseNote('它正在读配置。', ctx), /not JSON/)
  // 带 markdown 围栏可以宽容
  assert.equal(parseNote('```json\n' + JSON.stringify(valid) + '\n```', ctx).now, '在读配置')
})

function round2(value) {
  return Math.round(value * 100) / 100
}
