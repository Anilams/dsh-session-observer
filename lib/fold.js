/**
 * 折叠层：把会话日志折成面板可读的当前值。
 *
 * 它同时是两个东西：
 *   1. `dsh-session-projection` 的一个投影单元（`apply` 必须同步、纯、引用稳定）
 *   2. 面板的唯一数据源（客户端通过 RPC 读它的快照）
 *
 * 为什么历史链不单独存：note 写进了会话日志，投影只是把日志重新折成"当前值"。
 * 刷新、重连、重启、导出全部自动成立（见 DESIGN.md §1）。
 */

import { computeMetrics, hitRate, reasoningHead, scorePrediction } from './metrics.js'
import { cloneVerdict, createVerdict, judge, observe, p90 } from './verdict.js'

/** 滚动窗口大小：足够判断趋势，又不至于把投影值撑大。 */
const WINDOW = 48
/** 历史链上限。超过就丢最早的——它是 UI，不是归档。 */
const SPINE_LIMIT = 40
/**
 * 节拍上限。节拍是**事实**（发生过什么），不是标注（模型怎么说）。
 *
 * 它存在的原因是设计的第一条不变量「骨架先于标注」：密度带如果只由 note 驱动，
 * 那它在 free 模式下是一条死平线，在 smart 模式下画的是「模型说话的密度」而不是
 * 「它做事的密度」。两种都是谎。所以带子必须由原始事件先画出来，note 只往上加权重。
 */
const BEAT_LIMIT = 600
/** 预测历史的滑窗。 */
const PRED_LIMIT = 12

export const PROJECTION_KEY = 'sessionObserver'
export const STATE_VERSION = 1

/** 每种风险等级的排序权重：面板用它决定"要不要抬头"。 */
const LEVEL_WEIGHT = { critical: 3, high: 2, medium: 1, low: 0 }

/** 新建一个空状态。 */
export function createState() {
  return {
    v: STATE_VERSION,
    goal: '',
    turn: 0,
    step: 0,
    lastSeq: -1,
    /** 滚动事件窗口（已压缩，只留度量需要的字段） */
    recent: [],
    /** 最近一次 note（面板顶部的"此刻"） */
    now: null,
    /** 决策点脊柱，最新在后 */
    spine: [],
    /**
     * 节拍：确定性事件发生的时刻，最新在后。
     * `{ t: 毫秒时间戳, k: 种类, c?: 工具调用 id }`
     *
     * 与 spine 的分工：spine 是「模型说这一步在干什么」，节拍是「它确实动了」。
     * 密度带两者都用——节拍打底，note 加权。
     */
    beats: [],
    /** 待验证的预测 + 历史命中 */
    pending: null,
    predictionHistory: [],
    /** 旁路计量 */
    usage: { notes: 0, inputTokens: 0, outputTokens: 0, ms: 0, rejected: 0 },
    /** 确定性度量（每次 apply 重算，窗口有界所以很便宜） */
    metrics: computeMetrics([]).metrics,
    flags: [],
    reasoningHead: '',
    /** 判决状态机（见 lib/verdict.js）：零模型依赖，供首屏直接用 */
    verdict: createVerdict(),
    /** 首条事件时刻，用于「已跑多久」的刻度 */
    startedAt: null,
    /** 当前会话是否已结束（turn/end 之后尚无新 turn） */
    ended: false,
  }
}

/**
 * 判决层关心的事件。
 *
 * 除了度量层已经在看的那几种，还包括「责任在用户」与「子代理生命周期」——
 * 它们不影响度量，但决定判决，必须进折叠。
 */
const VERDICT_TYPES = new Set([
  'turn/start', 'turn/end', 'user/message', 'step/start', 'step/end',
  'tool/call', 'tool/result', 'assistant/message',
  'approval/asked', 'approval/decided',
  'tool-workflow/agent-start', 'tool-workflow/agent-end',
  'tool-workflow/run-start', 'tool-workflow/run-end',
])

/** 取一条消息的纯文本。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
}

/**
 * 事件 → 一个节拍。返回 null 表示这个事件不占时间轴上的位置。
 *
 * 判据只有一条：**它是不是一次「有产出的动作」**。重复调用同一个工具、重试、
 * 读同一个文件都不产出节拍——于是打转的会话在带子上会自己变成一条又密又扁的线，
 * 不需要任何额外规则去识别它。
 */
function beatOf(event) {
  const time = typeof event?.time === 'number' ? event.time : null
  if (time === null) return null
  switch (event.type) {
    case 'tool/call': {
      const callId = event.data?.callId
      // callId 是慢放的落点：没有它就跳不过去，所以有就带上。
      return typeof callId === 'string' && callId !== ''
        ? { t: time, k: 'tool', c: callId }
        : { t: time, k: 'tool' }
    }
    case 'tool/result': {
      const failed = event.data?.message?.isError === true || event.data?.error !== undefined
      return failed ? { t: time, k: 'fail' } : null
    }
    case 'assistant/message':
      // 只有真的说出话来才算——纯 reasoning 的块不是产出。
      // content 可能挂在 message 上（已组装形状），也可能直接在 data 上（transient 通道）。
      return textOf(event.data?.message ?? event.data).trim() === '' ? null : { t: time, k: 'say' }
    case 'user/message':
      return event.data?.source?.kind === 'user' ? { t: time, k: 'user' } : null
    case 'turn/start':
      return { t: time, k: 'turn' }
    case 'tool-workflow/agent-start':
    case 'tool-workflow/run-start':
      return { t: time, k: 'agent' }
    default:
      return null
  }
}

/**
 * 给一条 note 找「慢放」的落点。
 *
 * note 自己只有 seq（日志位置），而轨迹视图的 focus 是 callId——两者不是一回事。
 * 优先用模型挑的 anchors 里那一个工具调用；挑不出来就退到「此刻之前最近的一次」，
 * 因为决策点讲的永远是刚刚发生的那一下。
 */
function focusCallId(recent, seq, anchors) {
  const calls = (Array.isArray(recent) ? recent : [])
    .filter((item) => item?.type === 'tool/call' && typeof item.data?.callId === 'string')
  if (calls.length === 0) return null
  const wanted = new Set(Array.isArray(anchors) ? anchors : [])
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (wanted.has(calls[index].seq)) return calls[index].data.callId
  }
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index].seq <= seq) return calls[index].data.callId
  }
  return null
}

/**
 * 折叠一个事件。与单元无关的事件必须返回**同一个引用**——这是投影注册表
 * 的零下游工作保证（Object.is 闸门）。
 */
export function apply(state, event) {
  const type = event?.type
  if (type === 'observer/note') return applyNote(state, event)
  if (!VERDICT_TYPES.has(type)) return state

  const next = { ...state, lastSeq: event.seq ?? state.lastSeq }
  let touched = false

  // 判决层先走：它是首屏的唯一真话来源，且不受度量层影响。
  // 必须先克隆——上面那行浅拷贝会让新旧两份状态共享同一个 verdict 对象。
  next.verdict = cloneVerdict(state.verdict)
  observe(next.verdict, event)
  // 判决状态已经变了，这个事件就一定不是无关事件。
  touched = true

  // 节拍先落地：它不依赖任何下游判断，是带子唯一的事实来源。
  const beat = beatOf(event)
  if (beat !== null) next.beats = [...state.beats, beat].slice(-BEAT_LIMIT)

  if (state.startedAt === null && typeof event.time === 'number') {
    next.startedAt = event.time
  }

  if (type === 'turn/end') {
    next.ended = true
  } else if (type === 'turn/start') {
    next.ended = false
    next.turn = event.data?.turn ?? state.turn
    next.step = 0
    touched = true
  } else if (type === 'step/start') {
    next.step = event.data?.step ?? state.step
    touched = true
  } else if (type === 'user/message') {
    // 只认真正的人类输入：合成上下文（注入的 AGENTS.md、技能内容等）不算目标变更。
    if (event.data?.source?.kind === 'user') {
      const text = textOf(event.data).trim()
      if (text) {
        next.goal = text.slice(0, 600)
        // 用户换目标 → 旧的预测与标注立即作废。
        next.pending = null
        next.now = null
        touched = true
      }
    }
  } else if (type === 'assistant/message') {
    const head = reasoningHead(event.data, 480)
    if (head) {
      next.reasoningHead = head
      touched = true
    }
  }

  if (type === 'tool/call' || type === 'tool/result') {
    next.recent = [...state.recent, compact(event)].slice(-WINDOW)
    // 预测命中判定发生在这里：真实动作到齐的那一刻，用确定性规则比对。
    if (type === 'tool/call' && state.pending) {
      const verdict = scorePrediction(state.pending, {
        name: event.data?.name,
        target: String(event.data?.arguments ?? ''),
      })
      next.predictionHistory = [...state.predictionHistory, verdict].slice(-PRED_LIMIT)
      next.pending = null
    }
    touched = true
  }

  if (!touched) return state

  const measured = computeMetrics(next.recent)
  next.metrics = measured.metrics
  next.flags = measured.flags
  return next
}

/** 只留度量需要的字段，别把整份工具输出留在投影里。 */
function compact(event) {
  const data = event.data ?? {}
  if (event.type === 'tool/call') {
    return { seq: event.seq, type: 'tool/call',
      data: { turn: data.turn, step: data.step, callId: data.callId, name: data.name, arguments: data.arguments } }
  }
  return { seq: event.seq, type: 'tool/result',
    data: { turn: data.turn, step: data.step,
      message: { toolCallId: data.message?.toolCallId ?? data.message?.id, isError: data.message?.isError },
      error: data.error && { name: data.error.name, code: data.error.code, reason: data.error.reason } } }
}

/** 一条 note 进日志时：更新"此刻"、追加脊柱节点、登记待验证的预测。 */
function applyNote(state, event) {
  const note = event.data ?? {}
  const seq = event.seq ?? state.lastSeq

  const node = {
    seq,
    /** 这个决策点属于第几轮——界面按轮分组全靠它。 */
    turn: state.turn,
    kind: note.fork ? 'fork' : (note.confidence < 0.5 ? 'dim' : 'mile'),
    text: note.now ?? '',
    because: note.because ?? null,
    fork: note.fork ?? null,
    alignment: note.alignment ?? null,
    confidence: note.confidence ?? null,
    anchors: note.anchors ?? [],
    at: note.at ?? null,
    /** 慢放落点：这一条对应哪一次工具调用（可空）。 */
    callId: focusCallId(state.recent, seq, note.anchors),
  }

  return {
    ...state,
    lastSeq: seq,
    now: node,
    // 同一个 seq 只能出现一次：日志里 seq 唯一，重复必然是折叠路径走了两遍。
    // 这里按 seq 覆盖而不是追加——修 bug 之前，它表现成脊柱里出现成对的重复节点。
    spine: (state.spine.some((item) => item.seq === seq)
      ? state.spine.map((item) => (item.seq === seq ? node : item))
      : [...state.spine, node]).slice(-SPINE_LIMIT),
    // 未命中就丢掉上一次待验证的预测（说明模型没走那一步，或还没走）。
    pending: note.predict ?? null,
    usage: {
      notes: state.usage.notes + 1,
      inputTokens: state.usage.inputTokens + (note.usage?.inputTokens ?? 0),
      outputTokens: state.usage.outputTokens + (note.usage?.outputTokens ?? 0),
      ms: state.usage.ms + (note.usage?.ms ?? 0),
      rejected: state.usage.rejected,
    },
  }
}

/**
 * 给面板的视图：把状态压成一份稳定的 JSON 形状。
 * 面板不需要知道折叠细节，只需要"此刻 / 可预期性 / 风险 / 脊柱 / 计量"。
 */
export function toView(state, extra = {}) {
  const rate = hitRate(state.predictionHistory)
  const baseline = state.baselineRate ?? null

  // 判决要在这里现算：它依赖「此刻」，而折叠是纯事件驱动的。
  //
  // **必须原地判，不能克隆。** judge() 会把「进入这个状态的时刻」写进状态里，
  // 如果每次都在克隆上判完就扔，since 永远是 null、刻度恒为 0 秒，
  // 迟滞的 quietSince 也永远攒不起来。
  const now = Date.now()
  const verdict = judge(state.verdict, now)

  return {
    v: state.v,
    goal: state.goal,
    turn: state.turn,
    step: state.step,
    at: now,
    /** 首屏的主角：它现在需要你插手吗 */
    verdict,
    /** 这个状态已经持续了多久——判决静止时，它是唯一的「它还在」的证据 */
    elapsedMs: verdict.since === null ? 0 : Math.max(0, now - verdict.since),
    /** 首条事件到现在的总时长 */
    totalMs: state.startedAt === null ? 0 : Math.max(0, now - state.startedAt),
    /** 首条事件时刻。密度带要靠它把节点映射到时间轴上。 */
    startedAt: state.startedAt,
    /** 会话是否已把回合交回给用户 */
    ended: state.ended === true,
    /**
     * 会话自己的节奏。samples < 20 时冷启动，此时判决恒为 running——
     * 界面应该把这一点说出来，而不是假装一切正常。
     */
    baseline: {
      p90AdvanceMs: p90(state.verdict.advances),
      samples: Math.max(0, state.verdict.advances.length - 1),
    },
    now: state.now,
    metrics: state.metrics,
    flags: state.flags,
    risk: state.flags.reduce((max, flag) => Math.max(max, LEVEL_WEIGHT[flag.level] ?? 0), 0),
    prediction: {
      pending: state.pending,
      history: state.predictionHistory,
      rate,
      baseline,
      delta: rate !== null && baseline !== null ? Math.round((rate - baseline) * 100) : null,
    },
    spine: state.spine.slice(-SPINE_LIMIT),
    /**
     * 密度带的事实来源。客户端把它和 spine 叠在一起画：
     * 节拍打底（每个动作一格），note 加权（标注过的位置更高）。
     */
    beats: state.beats.slice(-BEAT_LIMIT),
    usage: state.usage,
    ...extra,
  }
}
