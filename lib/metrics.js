/**
 * 确定性度量层 —— 不花一分钱、零延迟、可解释。
 *
 * 设计要点（见 DESIGN.md §5）：
 *   六个"胜任度"信号里，有五个不需要模型。能用规则算的，就不该让概率模型投票。
 *   这里只依赖 `@deepseek-ai/dsh-session` 的事件形状，不依赖任何服务，纯函数、可单测。
 *
 * 事件形状（已核实 dsh-session/lib/types/types.d.ts:354-388）：
 *   tool/call   { turn, step, callId, name, arguments: string }
 *   tool/result { turn, step, message: ToolResultMessage, error?, meta? }
 *   step/start  { turn, step }
 *   step/end    { turn, step }
 *   user/message  UserMessage
 *   assistant/message { message, usage?, interrupted? }
 */

/** 破坏性操作规则表：命中即计入 destructiveness。按"宁可多报"配置，review 时人工降噪。 */
const DESTRUCTIVE = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/, 'rm -rf'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-z]*[fd]/, 'git clean -fd'],
  [/\bgit\s+push\s+.*(--force|-f)\b/, 'force push'],
  [/\bdrop\s+(table|database)\b/i, 'drop table'],
  [/\btruncate\s+table\b/i, 'truncate'],
  [/\bkubectl\s+delete\b/, 'kubectl delete'],
  [/\bdocker\s+(rm|rmi|system\s+prune)\b/, 'docker prune'],
  [/\bsudo\s+/, 'sudo'],
  [/\bchmod\s+777\b/, 'chmod 777'],
  [/\b>\s*\/dev\/sd[a-z]/, 'raw disk write'],
]

/** 从一条工具调用里抽出「目标」：用于进展率与重复判定。 */
function targetOf(name, rawArgs) {
  let args
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
  } catch {
    return String(rawArgs ?? '').slice(0, 120)
  }
  if (args === null || typeof args !== 'object') return String(args).slice(0, 120)
  // 常见字段族：路径优先，其次命令，其次查询。
  const pick = args.path ?? args.file_path ?? args.filePath ?? args.file
    ?? args.command ?? args.cmd ?? args.query ?? args.url ?? args.pattern
  if (typeof pick === 'string') return pick.slice(0, 160)
  // 兜底：键名排序后的紧凑 JSON，保证同参同键。
  const keys = Object.keys(args).sort()
  return keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join('&').slice(0, 160)
}

/** 稳定指纹：同 tool + 同目标 视为「重复」。 */
function fingerprintOf(name, target) {
  return `${name}\u0000${target}`
}

/**
 * 取本步 reasoning 的**前缀**（head-sampling CoT，见 DESIGN.md §3）。
 *
 * 已核实：会话日志里没有逐字增量。`assistant/message` 只在 step 结束时落一份压缩流
 * （`data.stream: AssistantStreamRecord[]`，delta 被打包成 `reasoning-chunks` run，
 *  dsh-llm/lib/types/assistant-stream.d.ts:16-40）。所以这里读的是 runs，不是 content blocks。
 *
 * 为什么只取前缀：模型通常在开头就宣告意图，后面的展开是演算过程——信息密度最低，
 * 正是"来不及看"的那部分。取前缀能砍掉 80%+ 输入，同时天然滤掉中间演算噪声。
 */
export function reasoningHead(message, maxChars = 480) {
  const stream = message?.stream
  if (Array.isArray(stream)) {
    const parts = []
    let budget = maxChars
    for (const record of stream) {
      if (record?.type !== 'reasoning-chunks' || !Array.isArray(record.texts)) continue
      for (const piece of record.texts) {
        if (typeof piece !== 'string' || piece === '') continue
        parts.push(piece)
        budget -= piece.length
        if (budget <= 0) break
      }
      if (budget <= 0) break
    }
    if (parts.length > 0) return capText(parts.join(''), maxChars)
  }
  // 兼容已组装的 content 形状（transient 通道 / 未来版本）。
  const content = message?.message?.content ?? message?.content
  if (!Array.isArray(content)) return ''
  const blocks = content.filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
  return blocks.length === 0 ? '' : capText(blocks.map((block) => block.text).join('\n'), maxChars)
}

const capText = (text, maxChars) => {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

/**
 * 计算一个事件窗口的确定性度量。
 * @param {ReadonlyArray<{type: string, data?: any}>} events 按 seq 升序的事件（可含非工具事件，会被忽略）
 * @param {{ stepBudget?: number }} [options] stepBudget = 该任务复杂度的期望步数先验
 * @returns {{ calls: Array, steps: number, metrics: object, flags: Array }}
 */
export function computeMetrics(events, options = {}) {
  const stepBudget = options.stepBudget ?? 12
  const calls = []
  const pending = new Map() // callId -> call 记录
  const seen = new Map() // fingerprint -> 次数
  const progressedTargets = new Set()
  let steps = 0
  let inStep = false

  for (const event of events) {
    const type = event?.type
    if (type === 'step/start') {
      steps += 1
      inStep = true
      continue
    }
    if (type === 'step/end') {
      inStep = false
      continue
    }
    if (type === 'tool/call') {
      const name = String(event.data?.name ?? 'unknown')
      const target = targetOf(name, event.data?.arguments)
      const fingerprint = fingerprintOf(name, target)
      const prior = seen.get(fingerprint) ?? 0
      seen.set(fingerprint, prior + 1)
      const call = {
        callId: String(event.data?.callId ?? ''),
        turn: event.data?.turn ?? 0,
        step: event.data?.step ?? 0,
        name,
        target,
        fingerprint,
        repeat: prior > 0,
        ok: null,
        error: undefined,
        destruct: DESTRUCTIVE.find(([re]) => re.test(target))?.[1],
      }
      calls.push(call)
      if (call.callId) pending.set(call.callId, call)
      progressedTargets.add(target)
      continue
    }
    if (type === 'tool/result') {
      const id = String(event.data?.message?.toolCallId ?? event.data?.message?.id ?? '')
      const call = id ? pending.get(id) : undefined
      const isError = event.data?.message?.isError === true || event.data?.error !== undefined
      if (call) {
        call.ok = !isError
        call.error = event.data?.error?.reason ?? event.data?.error?.code
        pending.delete(id)
        // 失败的重复不计入"有效进展"：它没有推进状态。
        if (isError) progressedTargets.delete(call.target)
      } else {
        // 没有对应 call 的孤立结果：仍然计入失败率，但无法归因到具体调用。
        calls.push({ callId: id, turn: event.data?.turn ?? 0, step: event.data?.step ?? 0,
          name: '(orphan)', target: '', fingerprint: '', repeat: false,
          ok: !isError, error: event.data?.error?.reason, destruct: undefined })
      }
    }
  }

  const total = calls.length
  const failed = calls.filter((c) => c.ok === false).length
  const repeats = calls.filter((c) => c.repeat).length
  const destructive = calls.filter((c) => c.destruct !== undefined)
  const repeatRate = total === 0 ? 0 : repeats / total
  const failRate = total === 0 ? 0 : failed / total
  const progressRate = steps === 0 ? 0 : progressedTargets.size / steps
  const economy = stepBudget === 0 ? 0 : Math.max(0, Math.min(1, stepBudget / Math.max(steps, 1)))

  // 连续失败 run：最需要人介入的信号，单独算出最大连击。
  let streak = 0
  let maxStreak = 0
  for (const call of calls) {
    if (call.ok === false) {
      streak += 1
      maxStreak = Math.max(maxStreak, streak)
    } else if (call.ok === true) {
      streak = 0
    }
  }

  const flags = []
  if (maxStreak >= 2) flags.push({ kind: 'fail-streak', level: maxStreak >= 3 ? 'high' : 'medium', value: maxStreak })
  if (repeats >= 2) flags.push({ kind: 'repeat', level: repeats >= 4 ? 'high' : 'medium', value: repeats })
  if (destructive.length > 0) {
    flags.push({ kind: 'destructive', level: 'high', value: destructive.length,
      detail: destructive.map((c) => c.destruct) })
  }
  if (progressRate === 0 && steps >= 4) flags.push({ kind: 'no-progress', level: 'medium', value: steps })
  if (steps > stepBudget * 2) flags.push({ kind: 'over-budget', level: 'medium', value: steps })

  return {
    calls,
    steps,
    flags,
    metrics: {
      repeat_rate: round(repeatRate),
      tool_fail_rate: round(failRate),
      progress_rate: round(progressRate),
      destructiveness: destructive.length,
      economy: round(economy),
      max_fail_streak: maxStreak,
      calls: total,
      steps,
      /**
       * 按工具名的分布（前 5）。界面右侧的「工具分布」直接读它——
       * 客户端拿不到原始 calls 数组，这里算好再传，省一次传输也省一次口径分歧。
       */
      tool_mix: topMix(calls, 5),
      /**
       * 按轮次的计数。轮次筛选要显示每一轮的真实数字，
       * 用同一次遍历算出来，避免客户端再数一遍数出两套结果。
       */
      turn_stats: turnStats(calls),
    },
    /** 给旁路模型的"行为窗口"：不是原始 CoT，是结构化动作 ledger（DESIGN.md §3）。 */
    ledger: calls.slice(-(options.ledgerLimit ?? 16)).map((c) => ({
      step: c.step,
      tool: c.name,
      target: c.target.slice(0, 80),
      ok: c.ok,
      repeat: c.repeat || undefined,
      error: c.error?.slice(0, 60),
      destruct: c.destruct,
    })),
  }
}

const round = (value) => Math.round(value * 100) / 100

/** 按工具名聚合，返回 [[name, n], ...]，降序，取前 limit 个。 */
const topMix = (calls, limit) => {
  const map = new Map()
  for (const call of calls) {
    const name = call?.name ?? 'other'
    map.set(name, (map.get(name) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

/** 按 turn 聚合调用数与失败数。 */
const turnStats = (calls) => {
  const map = new Map()
  for (const call of calls) {
    const n = typeof call?.turn === 'number' ? call.turn : 0
    const row = map.get(n) ?? { n, calls: 0, fails: 0, steps: 0, _steps: new Set() }
    row.calls += 1
    if (call.ok === false) row.fails += 1
    if (typeof call.step === 'number') row._steps.add(call.step)
    row.steps = row._steps.size
    map.set(n, row)
  }
  return [...map.values()]
    .map(({ _steps, ...row }) => row)
    .sort((a, b) => a.n - b.n)
}

/**
 * 预测命中判定 —— 把"胜任度"降级为可验证的误差（DESIGN.md §5 第二步）。
 * 纯确定性比对：不看模型措辞，只看工具名与归一化目标。
 * @param {{tool?: string, target?: string}} prediction
 * @param {{name: string, target: string}} actual
 * @returns {'full'|'partial'|'miss'}
 */
export function scorePrediction(prediction, actual) {
  if (!prediction || typeof prediction.tool !== 'string' || !actual) return 'miss'
  const wantTool = prediction.tool.trim().toLowerCase()
  const gotTool = String(actual.name ?? '').trim().toLowerCase()
  if (wantTool !== gotTool) return 'miss'
  const wantTarget = normalizeTarget(prediction.target)
  const gotTarget = normalizeTarget(actual.target)
  if (wantTarget === '' || gotTarget === '') return 'partial'
  if (gotTarget.includes(wantTarget) || wantTarget.includes(gotTarget)) return 'full'
  return 'partial'
}

/** 归一化：去掉引号/空白/尾斜杠，转小写，便于包含式比较。 */
export function normalizeTarget(value) {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().replace(/\/+$/, '')
}

/** 命中率（滑窗）。full=1, partial=0.5, miss=0。 */
export function hitRate(history) {
  if (!Array.isArray(history) || history.length === 0) return null
  const total = history.reduce((sum, item) => sum + (item === 'full' ? 1 : item === 'partial' ? 0.5 : 0), 0)
  return Math.round((total / history.length) * 100) / 100
}
