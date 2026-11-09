// 一份贴近真实形状的快照，用来在浏览器里跑视图组件
const T0 = Date.parse('2026-11-09T09:00:00+08:00')
const min = (n) => n * 60000
const nodes = [
  { seq: 10, turn: 1, kind: 'mile', text: '通读编辑器的保存链路', because: '入口是 Editor 的 onChange', at: T0 + min(2) },
  { seq: 22, turn: 1, kind: 'fork', text: '选定草稿落盘方案', at: T0 + min(28),
    fork: { chosen: 'IndexedDB 按文档 id 分片', alternatives: ['localStorage 全量字符串'] }, callId: 'call-1' },
  { seq: 31, turn: 1, kind: 'fork', text: '防抖间隔定多少', at: T0 + min(64),
    fork: { chosen: '800ms 防抖 + 失焦立即写', alternatives: ['固定 2s 定时写'] }, callId: 'call-2' },
  { seq: 40, turn: 2, kind: 'mile', text: '冲突后保留谁的版本', at: T0 + min(180) },
  { seq: 48, turn: 2, kind: 'dim', text: '怀疑是防抖导致的重复写入', because: '日志样本太少，未确认', at: T0 + min(212) },
  { seq: 55, turn: 3, kind: 'mile', text: '把存储层抽成接口', at: T0 + min(320), callId: 'call-3' },
]
const beats = []
for (let i = 0; i < 40; i += 1) {
  beats.push({ t: T0 + min(2 + i * 8), k: 'tool', c: 'c' + i })
}
export const snapshot = {
  v: 1,
  goal: '给 markdown 编辑器加自动保存，草稿要能恢复',
  turn: 3, step: 12, at: T0 + min(332), startedAt: T0,
  verdict: { state: 'running', since: T0 + min(320), reason: null, quietSince: null },
  elapsedMs: min(12), totalMs: min(332),
  ended: false,
  baseline: { p90AdvanceMs: 21000, samples: 128 },
  metrics: { repeat_rate: 0.39, tool_fail_rate: 0.008, progress_rate: 0.8, destructiveness: 0,
    economy: 0.7, max_fail_streak: 1, calls: 248, steps: 236,
    tool_mix: [['bash', 132], ['edit', 61], ['read', 34], ['write', 15], ['grep', 6]],
    turn_stats: [{ n: 1, calls: 148, fails: 1 }, { n: 2, calls: 36, fails: 1 }, { n: 3, calls: 44, fails: 0 }] },
  flags: [], risk: 0,
  prediction: { pending: null, history: [], rate: null, baseline: null, delta: null },
  spine: nodes, beats,
  usage: { annotations: 0, tokens: 0, cost: 0 },
  mode: 'free',
}
