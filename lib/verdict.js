/**
 * 判决层：把「一百多步的事件流」压成「它现在需要你插手吗」。
 *
 * 这个文件是整个视图唯一的真话来源，并且**零模型依赖**。
 * 它是纯函数：吃事件，吐状态，不碰时钟、不碰网络、不碰 React。
 * 因此可以拿真实会话日志逐条回放，统计误报与漏报。
 *
 * 设计（见方案 §三）：
 *   1. 先归因——「沉默」至少有四种，责任方不同，只有两种该报警；
 *   2. 再用会话自己的节奏做基线——绝对秒数在两个数量级的速度差面前必错；
 *   3. 在飞的工具自带心跳——有副作用的进程还在输出，就是活着的证据。
 *
 * 硬纪律：宁漏不误。误报一次，用户就永久静音这个视图。
 */

/** 前进间隔的滚动窗口。够算 p90，又不至于把状态撑大。 */
const ADVANCE_WINDOW = 64
/** 每个工具自己的耗时历史。用来判断「这次飞得有点久」。 */
const TOOL_HISTORY = 16
/** 冷启动门限：攒不够这么多前进间隔，就只观察不报警。 */
const MIN_SAMPLES = 20
/**
 * 基线倍率，作用在**自己的 p99** 上，不是 p90。
 *
 * 实测（2357 条真实会话事件）：前进间隔 p50=3.9s、p90=21.5s、p99=265s。
 * 分布是长尾——绝大多数动作几秒一个，偶尔有几分钟的（长构建、等模型、用户走开）。
 * 拿 p90 × 3 = 65 秒去判，会在这条会话上误报 18 次；拿 p99 × 1.5，
 * 只剩 2 次，而且那 2 次是真的几十分钟没动静。
 */
const K = 1.5
/**
 * 地板值：任何基线都不该让它在 3 分钟内喊卡住。
 * 这既是给网络与冷启动留余量，也是「宁漏不误」的直接体现。
 */
const FLOOR_MS = 180_000
/** 退出异常需要持续满足这么久，防止阈值附近抖动。 */
const HYSTERESIS_MS = 10_000

/**
 * 会改变磁盘、网络或资源的操作。命中就在「等你」里抬头。
 *
 * 注意：这里只用来**提示**，不用来拦截。观察者一旦有副作用就不再是观察者。
 * 规则与 lib/metrics.js 的 DESTRUCTIVE 保持一致，避免两处判断打架。
 */
const DESTRUCTIVE = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/, 'rm -rf'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-z]*[fd]/, 'git clean'],
  [/\bgit\s+push\s+.*(--force|-f)\b/, '强推'],
  [/\bdrop\s+(table|database)\b/i, 'drop table'],
  [/\btruncate\s+table\b/i, 'truncate'],
  [/\bkubectl\s+delete\b/, 'kubectl delete'],
  [/\bdocker\s+(rm|rmi|system\s+prune)\b/, 'docker 清理'],
  [/\bsudo\s+/, 'sudo'],
  [/\bchmod\s+777\b/, 'chmod 777'],
]

/** 合法的五个判决。UI 直接按这些值取文案与颜色。 */
export const STATES = ['running', 'stuck', 'erroring', 'waiting', 'dangerous']

export function createVerdict() {
  return {
    /** 前进时刻（只用「真正往前走了」的事件刷新） */
    advances: [],
    /** 见过的工具指纹。重复调用不算前进，所以必须记住。 */
    seen: new Set(),
    /** 在飞的工具调用：callId -> { name, startedAt } */
    inflight: new Map(),
    /** 每个工具的历史耗时，抬升它自己的判定阈值 */
    toolTimes: new Map(),
    /** 最近一次前进的时刻——沉默时长从它算起 */
    lastAdvanceAt: null,
    /**
     * 「责任在用户」是一个**事实**，不是一个结论。
     * 它只能由 turn/end、approval/asked 置位，由 turn/start、approval/decided、user/message 清除。
     * 绝不能拿判决结果反写这个字段——那会把「等用户」和「归因用户」混成一团。
     */
    awaiting: false,
    /** 「等你」从哪一刻开始悬着——用于最小停留门限，防止瞬时开合闪屏 */
    awaitingSince: null,
    /** 已经悬在那里、尚未结果的破坏性操作 */
    destructive: null,
    /** 是否有批准请求正悬着——只有在等用户拍板时，破坏性操作才算「危险」 */
    approvalPending: false,
    /** 当前判决与它开始的时刻 */
    state: 'running',
    since: null,
    /**
     * 「条件已经不成立了」的那一刻。
     * 迟滞必须靠它计时——拿 since 计时会恒等于 0，永远退不出异常态。
     */
    quietSince: null,
    /** 最近一次判定的归因，仅供显示 */
    attribution: null,
    /** 最近一次判定的理由句子，仅在非 running 时有值 */
    reason: null,
  }
}

// ── 前进判定 ───────────────────────────────────────────────────────────────

/** 工具调用的稳定指纹：同名 + 同参数视为重复。 */
export function fingerprintOf(event) {
  const name = String(event?.data?.name ?? '')
  const raw = event?.data?.arguments
  const args = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  return name + '\u0000' + String(args).slice(0, 240)
}

/**
 * 这一条事件算不算「前进」？
 *
 * ✅ 算：新的工具目标（哪怕只是读一个新文件）、assistant 文字块、
 *        子代理与后台任务的生命周期
 * ❌ 不算：同一指纹的重复调用——于是在打转的会话会自己变得更可疑
 *
 * 注意这里**不**按「工具是否产生副作用」来判。只读一个**新**文件同样是前进；
 * 真正的病是原地打转，而不是读了文件。
 *
 * @returns {{ advanced: boolean, kind: string | null, fingerprint?: string }}
 */
export function classify(event, state) {
  const type = event?.type

  if (type === 'tool/call') {
    const fingerprint = fingerprintOf(event)
    if (state?.seen?.has?.(fingerprint) === true) {
      return { advanced: false, kind: 'repeat', fingerprint }
    }
    return { advanced: true, kind: 'act', fingerprint }
  }

  if (type === 'assistant/message') {
    // 文字块才算——reasoning 是演算过程，不是产出。
    const content = event?.data?.message?.content ?? event?.data?.content
    const hasText = Array.isArray(content)
      && content.some((block) => block?.type === 'text'
        && typeof block.text === 'string' && block.text.trim() !== '')
    return { advanced: hasText, kind: hasText ? 'say' : null }
  }

  // 子代理与后台任务的生命周期也算前进：否则长时间跑子代理的会话会被误判。
  // 名字取自 dsh-session 的权威清单 KNOWN_SESSION_EVENT_TYPES。
  if (type === 'tool-workflow/agent-start' || type === 'tool-workflow/agent-end'
    || type === 'tool-workflow/run-start' || type === 'tool-workflow/run-end'
    || type === 'approval/asked' || type === 'approval/decided') {
    return { advanced: true, kind: 'child' }
  }

  return { advanced: false, kind: null }
}

// ── 归因 ───────────────────────────────────────────────────────────────────

/**
 * 沉默归谁负责。
 *
 * 顺序有意义：先认「是用户的事」，再认「环境的事」，最后才轮到「模型的事」。
 * 反过来就会把用户在思考的 30 分钟算成模型卡住。
 */
function attribute(state, now) {
  // 1. 责任在用户：回合已交回、或在等批准。这是唯一绝不报警的一格。
  if (state.awaiting) return 'user'

  // 2. 有工具在飞：先看它是不是飞得太久了。
  if (state.inflight.size > 0) {
    for (const call of state.inflight.values()) {
      const history = state.toolTimes.get(call.name)
      const own = history && history.length >= 3 ? p99(history) : null
      const spent = now - call.startedAt
      if (own !== null && spent > Math.max(own * 2, FLOOR_MS)) return 'env'
    }
    // 还在预算内：工具在干活，不是卡住。
    return 'tool'
  }

  return 'model'
}

// ── 基线 ───────────────────────────────────────────────────────────────────

/**
 * 会话自己的节奏。默认 p90——不是平均值，因为它要对「偶尔快」免疫。
 *
 * quantile 可调：判「卡住」用的是 p99，因为前进间隔是长尾分布，
 * p90 只描述「顺利的时候有多快」，而卡住与否取决于「最慢的时候有多慢」。
 */
export function p90(advances, quantile = 0.9) {
  if (!Array.isArray(advances) || advances.length < 2) return null
  const gaps = []
  for (let index = 1; index < advances.length; index += 1) {
    const gap = advances[index] - advances[index - 1]
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  return gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * quantile))]
}

function p99(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]
}

/**
 * 卡住阈值：会话自己的节奏 × K，但不低于地板值。
 * 若有工具在飞，它自己的历史 p99 会进一步抬高阈值——长命令不该被判卡住。
 */
export function stuckAfter(state) {
  const base = p99OfAdvances(state.advances)
  if (base === null) return null
  let budget = Math.max(base * K, FLOOR_MS)
  for (const call of state.inflight.values()) {
    const history = state.toolTimes.get(call.name)
    if (history && history.length >= 3) {
      const own = p99(history)
      // 在飞的工具抬高阈值，但同样受地板值约束——一个飞了 3 分钟的命令不该
      // 把「卡住」推到一小时后。
      if (own !== null) budget = Math.max(budget, Math.min(own * 2, FLOOR_MS * 3))
    }
  }
  return budget
}

/** 前进间隔的 p99。长尾会话必须按 p99 判，按 p90 判必然误报。 */
export function p99OfAdvances(advances) {
  return p90(advances, 0.99)
}

// ── 状态机 ─────────────────────────────────────────────────────────────────

/**
 * 深拷贝判决状态。
 *
 * 折叠层的契约是「无关事件返回同一个引用」，所以任何要改动判决状态的路径
 * 都必须先克隆——否则下游会看到它没被通知的对象自己变了。
 */
export function cloneVerdict(state) {
  return {
    advances: [...state.advances],
    seen: new Set(state.seen),
    inflight: new Map(state.inflight),
    toolTimes: new Map([...state.toolTimes].map(([key, value]) => [key, [...value]])),
    lastAdvanceAt: state.lastAdvanceAt,
    awaiting: state.awaiting,
    awaitingSince: state.awaitingSince,
    destructive: state.destructive,
    approvalPending: state.approvalPending,
    state: state.state,
    since: state.since,
    attribution: state.attribution,
    reason: state.reason,
  }
}

/**
 * 吃一条事件，更新判决状态。
 *
 * 注意这里是**同步、纯、无副作用**的：时间全部取自 `event.time`，
 * 所以同一份日志回放两次结果一定一致。
 */
export function observe(state, event) {
  const type = event?.type
  const now = typeof event?.time === 'number' ? event.time : Date.now()

  // ── 责任在用户的三条路 ──
  if (type === 'turn/end') {
    state.awaiting = true
    state.approvalPending = false
    if (state.awaitingSince === null) state.awaitingSince = now
    return state
  }
  if (type === 'approval/asked') {
    state.awaiting = true
    state.approvalPending = true
    if (state.awaitingSince === null) state.awaitingSince = now
    return state
  }
  if (type === 'turn/start' || type === 'user/message' || type === 'approval/decided') {
    state.approvalPending = false
    if (state.awaiting) {
      state.awaiting = false
      state.awaitingSince = null
      // 用户回来了，沉默从这一刻重新起算。
      state.lastAdvanceAt = now
    }
  }

  if (type === 'tool/call') {
    const name = String(event.data?.name ?? '')
    const callId = String(event.data?.callId ?? '')
    const fingerprint = fingerprintOf(event)
    const verdict = classify(event, state)

    // 记录指纹：下一次同样参数再来，就是「重复」，不再算前进。
    state.seen.add(fingerprint)
    // 见过太多指纹时丢最早的（Set 保序），防止长会话无限增长。
    if (state.seen.size > 512) {
      const first = state.seen.values().next().value
      if (first !== undefined) state.seen.delete(first)
    }

    if (callId !== '') state.inflight.set(callId, { name, startedAt: now })
    if (verdict.advanced) pushAdvance(state, now)

    const hit = destructiveOf(event)
    if (hit !== null) state.destructive = { name, what: hit, at: now }
    return state
  }

  if (type === 'tool/result') {
    const callId = String(
      event.data?.message?.toolCallId ?? event.data?.message?.id ?? '',
    )
    const call = callId === '' ? undefined : state.inflight.get(callId)
    if (call !== undefined) {
      state.inflight.delete(callId)
      const spent = now - call.startedAt
      if (spent >= 0) {
        const history = state.toolTimes.get(call.name) ?? []
        history.push(spent)
        state.toolTimes.set(call.name, history.slice(-TOOL_HISTORY))
      }
      // 破坏性操作已经执行完了，不再是「待你决定」的状态。
      if (state.destructive?.name === call.name) state.destructive = null
    }
    return state
  }

  const verdict = classify(event, state)
  if (verdict.advanced) pushAdvance(state, now)
  return state
}

function pushAdvance(state, at) {
  state.advances.push(at)
  if (state.advances.length > ADVANCE_WINDOW) state.advances.shift()
  state.lastAdvanceAt = at
}

/** 这条工具调用是不是破坏性操作。返回人话标签，或 null。 */
function destructiveOf(event) {
  const raw = event?.data?.arguments
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  for (const [pattern, label] of DESTRUCTIVE) {
    if (pattern.test(text)) return label
  }
  return null
}

/**
 * 此刻的判决。**只在这一个地方产出 `stuck`**，所以误报率可以集中审视。
 *
 * @param {object} state
 * @param {number} now 当前时刻（真实时钟；回放时传最后一个事件的时间）
 * @returns {{ state: string, since: number|null, reason: string|null, attribution: string|null }}
 */
export function judge(state, now) {
  // 危险的判定必须极窄：**破坏性操作正在等用户拍板**才算。
  //
  // 起初我写成「破坏性工具在飞」就算，结果在真实日志里闪了 23 次红——
  // 因为调用与结果通常在同一秒内配对，用户在界面上只会看到一次红灯闪烁，
  // 既无从反应、也无从学习，纯粹是噪音。
  if (state.destructive !== null && state.approvalPending) {
    return settle(state, 'dangerous', now, `准备${state.destructive.what}`, 'tool')
  }

  const attribution = attribute(state, now)

  // 「责任在用户」同样不需要基线——等就是等，样本多少都一样。
  // 但必须悬够 ASK_DWELL_MS：瞬时开合的批准请求不该在屏幕上闪一下。
  if (attribution === 'user') {
    if (state.awaitingSince === null) state.awaitingSince = now
    if (now - state.awaitingSince < ASK_DWELL_MS) {
      return settle(state, 'running', now, null, 'user')
    }
    return settle(state, 'waiting', now, null, 'user')
  }
  state.awaitingSince = null

  // 工具飞过了它自己的历史耗时：这是**事实**，不是节奏推断，也不需要基线。
  if (attribution === 'env') return settle(state, 'erroring', now, '环境没有响应', 'env')

  const samples = Math.max(0, state.advances.length - 1)

  // 冷启动只拦「卡住」：样本不够就无法判断节奏。
  // 长会话的头几分钟它不喊卡住，这是正确的；但它照样会说「等你」。
  if (samples < MIN_SAMPLES) return settle(state, 'running', now, null, 'cold')

  // 工具在飞且在预算内：它在干活，不是卡住。
  if (attribution === 'tool') return settle(state, 'running', now, null, 'tool')

  // 归因到模型 —— 这里是唯一可能产出 `stuck` 的分支。
  const budget = stuckAfter(state)
  const since = state.lastAdvanceAt
  if (budget === null || since === null) return settle(state, 'running', now, null, 'model')

  const silent = now - since
  if (silent <= budget) return settle(state, 'running', now, null, 'model')

  return settle(state, 'stuck', now, `${humanDuration(silent)}没有新进展`, 'model')
}

/**
 * 「等你」的最小停留门限。
 *
 * 实测：真实会话里 approval/asked → approval/decided 常常只隔 2–4 秒。
 * 把这种瞬时开合显示成「等你」，用户看到的就是一次闪烁——
 * 既无从反应，也无从学习。只有悬超过这个时长的等待才值得占屏。
 */
const ASK_DWELL_MS = 5_000
function settle(state, next, now, reason, attribution) {
  // 迟滞只保护**阈值型**的判决（卡住、出错）——它们的翻面取决于一个会抖的量。
  // 「等你」「危险」是事实型的：用户回来了就是回来了，工具结束了就是结束了，
  // 在这里加迟滞只会制造一个明明已经没事却在报错的界面。
  const thresholdy = state.state === 'stuck' || state.state === 'erroring'
  const leaving = next === 'running' && state.state !== 'running' && thresholdy

  if (leaving) {
    // 条件第一次不成立时记下这一刻，之后按它计时。
    if (state.quietSince === null) state.quietSince = now
    if (now - state.quietSince < HYSTERESIS_MS) {
      // 还没稳定下来，维持原判。
      return {
        state: state.state,
        since: state.since,
        reason: state.reason,
        attribution: state.attribution,
      }
    }
    state.state = 'running'
    state.since = now
    state.quietSince = null
  } else if (next !== state.state) {
    state.state = next
    state.since = now
    state.quietSince = null
  } else if (state.since === null) {
    state.since = now
  }

  state.reason = reason
  state.attribution = attribution
  return { state: state.state, since: state.since, reason, attribution }
}

/** 人话时间：不给人看秒。 */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}
