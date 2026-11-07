/**
 * dsh-session-observer —— 宿主半边
 *
 * 三件事，都在这里：
 *   1. 采集：订阅 `session/event`（post-commit、fire-and-forget、失败被吞），
 *      滚动折叠成确定性度量。**绝不 await 在主循环里。**
 *   2. 标注：在语义边界触发一次旁路模型调用，把结果写进**插件自己的** note 存储
 *      （lib/notes.js）。绝不 `session.append()` 自定义事件——那会让整份会话在
 *      下次读盘时被拒绝解释（详见 lib/notes.js 顶部的事故记录）。
 *   3. 供数：通过 Connection RPC 把折叠后的当前值交给右栏面板。
 *
 * 不在这里做的事：渲染（在 client.js）、note 持久化（lib/notes.js）。
 *
 * 关键纪律（见 DESIGN.md §8）：
 *   - 旁路失败一律静默降级：没有 note 就只显示确定性度量，那部分本来就够用。
 *   - 并发闸门自建（llm 层没有），上限默认 1。
 *   - 卸载时先停调度、再 abort 在途、再等结清。
 */

// 刻意不 import 任何 @deepseek-ai/* 包。
// 原因（2026-11-05 事故）：本插件以 link: 方式装在 profile 里，宿主怎么解析
// 这些裸包名取决于运行环境（CLI / Electron+asar / 版本差异）。只要解析失败，
// 就是 import 阶段的硬崩，而 import 崩溃发生在插件 `apply` 之前，插件自己
// 接不住——宿主会判定整棵插件树不可用。为此这里只用标准 Web API 自给自足。
import { computeMetrics } from './lib/metrics.js'
import { apply as foldApply, createState, toView } from './lib/fold.js'
import { appendNote, readNotes } from './lib/notes.js'
import { buildMessages, parseNote, SYSTEM_PROMPT } from './lib/prompt.js'

export const name = 'session-observer'

/**
 * 必须在顶层声明，否则 cordis 在 `ctx.<service>` 上直接抛
 * `cannot get property "<name>" without inject`。
 *
 * 2026-11-05 第二次事故就是这条：这里写着 `[]`，而 `run()` 里用了 `ctx.llm`，
 * 于是第一次真实会话 append 事件时立刻 fatal load failure，App 判定整棵插件树不可用。
 * `connection` 是可选的（headless 没有），所以继续用 `ctx.inject(['connection'], …)` 按需取。
 */
export const inject = ['llm', 'sessions']

/**
 * 事件类型 → 是否需要在调度器里被"看见"。别订阅 waterfall/serial，那会改控制流。
 *
 * 除了度量层要的几种，还必须收「责任在用户」与「子代理生命周期」——
 * 它们不影响任何度量，但决定判决是「卡住」还是「等你」。
 * 少收一个 approval/asked，用户去泡咖啡的三十分钟就会被算成模型卡住。
 */
const WATCHED = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'user/message', 'assistant/message',
  'tool/call', 'tool/result',
  'approval/asked', 'approval/decided',
  'tool-workflow/agent-start', 'tool-workflow/agent-end',
  'tool-workflow/run-start', 'tool-workflow/run-end',
])

export const DEFAULTS = {
  enabled: true,
  /**
   * 'free' = 只跑规则，旁路模型完全不起（零成本，装了就敢开着）
   * 'smart' = 额外让旁路模型说一句话（首次引导时由用户选择）
   *
   * 默认 free：一个默认会花钱的插件，不可能被"随手装上"。
   */
  mode: 'free',
  /** 最小间隔：再频繁就是在烧钱，而且 note 会淹没用户。 */
  intervalMs: 25_000,
  /** 窗口内少于这么多条新事件就不跑——省掉"什么都没发生"的空转。 */
  minNewEvents: 3,
  timeoutMs: 15_000,
  /** 必须显式给，宿主不替你设上限。 */
  maxTokens: 400,
  /** 必须显式给，否则 DeepSeek 回落到 'high'，成本翻 3-5 倍。 */
  reasoningEffort: 'off',
  temperature: 0,
  /** 旁路路由；留空则跟随当前会话记录的 request/header。 */
  provider: '',
  model: '',
  maxInflight: 1,
  /** 连续失败这么多步就无条件触发一次标注（即使还没到间隔）。 */
  urgentFailStreak: 2,
}

/**
 * 宿主插件入口。
 *
 * 这层包装存在的唯一理由：**插件不允许让宿主启动失败**。
 * 上次事故的直接后果是 App 判定插件树不可用、把整个 profile 重置成最小模板。
 * 这里把任何意外抛出都吞掉并降级成"插件不工作"，而不是"整台机器不工作"。
 */
export function apply(ctx, config = {}) {
  try {
    install(ctx, config)
  } catch (error) {
    reportSoftFailure(ctx, error)
  }
}

/** 真正的装配逻辑；任何异常都由上面的 apply 接住。 */
function install(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  /** sessionId -> 折叠状态 */
  const states = new Map()
  /** sessionId -> { at, seen, pending: boolean } */
  const schedule = new Map()
  /** 在途调用（自建并发闸门） */
  const inflight = new Set()
  const lifecycle = new AbortController()

  // ── 折叠 ────────────────────────────────────────────────────────────────

  /**
   * 冷启动/重启后第一次触达：把日志重放一遍。
   *
   * note 有两个来源，都按 seq 顺序折：
   *   - 旧日志里的 `observer/note` 事件（0.2.x 及以前写进去的，已由修复工具补了
   *     ignorable，仍能被宿主读出来）——所以历史会话的脊柱不会因为这次改动而消失；
   *   - 插件自己的 note 存储（lib/notes.js），按写入时的 anchor 折在对应事件之后。
   */
  function replay(session) {
    let state = createState()
    let events = []
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    } catch {
      events = []
    }
    const notes = readNotes(String(session?.id ?? ''))
    let index = 0
    for (const event of events) {
      // anchor 严格小于下一条日志事件的 seq → 这条 note 落在 anchor 之后。
      while (index < notes.length && notes[index].anchor < (event.seq ?? 0)) {
        state = foldApply(state, noteEvent(notes[index]))
        index += 1
      }
      state = foldApply(state, event)
    }
    while (index < notes.length) {
      state = foldApply(state, noteEvent(notes[index]))
      index += 1
    }
    return state
  }

  /** 把存储里的 note 还原成折叠层认的信封。 */
  function noteEvent(record) {
    return { type: 'observer/note', seq: record.anchor, time: record.time, data: record.data }
  }

  function stateOf(session) {
    const id = String(session?.id ?? '')
    if (!id) return createState()
    let state = states.get(id)
    if (state === undefined) {
      state = replay(session)
      states.set(id, state)
    }
    return state
  }

  // ── 边界判定 ────────────────────────────────────────────────────────────

  /**
   * 语义边界（DESIGN.md §4）。**按边界取样，不按秒轮询**：
   * 定时会同时犯两个错 —— 无事可报时烧钱，关键转折时错过。
   */
  function isBoundary(event, state) {
    switch (event?.type) {
      case 'turn/start':
        return 'turn'
      case 'step/end':
        return 'step'
      case 'tool/result': {
        const failed = event.data?.message?.isError === true || event.data?.error !== undefined
        if (failed && (state.metrics.max_fail_streak ?? 0) >= cfg.urgentFailStreak) return 'urgent'
        return null
      }
      default:
        return null
    }
  }

  function slotOf(sessionId) {
    let slot = schedule.get(sessionId)
    if (slot === undefined) {
      slot = { at: 0, seen: 0 }
      schedule.set(sessionId, slot)
    }
    return slot
  }

  function maybeSchedule(session, boundary) {
    if (!cfg.enabled) return
    // free 模式：旁路模型完全不起，一分钱不花。首屏判决照常工作。
    if (cfg.mode !== 'smart') return
    const id = String(session?.id ?? '')
    if (!id) return
    const slot = slotOf(id)
    slot.seen += 1

    const urgent = boundary === 'urgent'
    const now = Date.now()
    if (!urgent && now - slot.at < cfg.intervalMs) return
    if (!urgent && slot.seen < cfg.minNewEvents) return

    slot.at = now
    slot.seen = 0
    void run(session)
  }

  // ── 旁路调用 ────────────────────────────────────────────────────────────

  /** 跟随会话当初实际用的路由，而不是插件自己拍一个。 */
  function routeOf(session) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    try {
      const header = session.requestHeader?.()
      const route = header?.config
      if (route?.provider && route?.model) return { provider: route.provider, model: route.model }
    } catch {
      /* 路由未就绪：放弃这次标注，等下一步再来 */
    }
    return null
  }

  async function run(session) {
    // 免费模式下一分钱都不该花——包括手动触发的路径（annotate-now 也走这里）。
    if (cfg.mode !== 'smart') return
    if (inflight.size >= cfg.maxInflight) return
    if (typeof ctx.llm?.stream !== 'function') return
    const route = routeOf(session)
    if (route === null) return

    const state = stateOf(session)
    const window = state.recent.slice(-16)
    if (window.length === 0) return
    const validSeqs = new Set(window.map((event) => event.seq))
    if (typeof state.lastSeq === 'number') validSeqs.add(state.lastSeq)

    const task = annotate(session, state, window, validSeqs, route)
    inflight.add(task)
    try {
      await task
    } finally {
      inflight.delete(task)
    }
  }

  async function annotate(session, state, window, validSeqs, route) {
    const started = Date.now()
    // 超时：标准 AbortSignal，不依赖宿主的 timeout 工具。
    const timerController = new AbortController()
    const timer = setTimeout(
      () => timerController.abort(new Error('SESSION_OBSERVER_TIMEOUT')),
      cfg.timeoutMs,
    )
    const signal = lifecycle.signal === undefined
      ? timerController.signal
      : AbortSignal.any([lifecycle.signal, timerController.signal])
    let text = ''
    let usage = null

    try {
      const collector = createTextCollector()
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: SYSTEM_PROMPT,
        messages: buildMessages({
          goal: state.goal,
          ledger: computeMetrics(window).ledger,
          thinkingHead: state.reasoningHead,
          metrics: state.metrics,
          events: window,
          previousNow: state.now?.text,
        }),
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        reasoningEffort: cfg.reasoningEffort,
        signal,
        // 刻意不传 sessionId：这让 cost-meter 把它记进日/月总计，而不是会话成本。
      })

      for await (const chunk of stream) {
        if (signal.aborted) throw signal.reason ?? new Error('aborted')
        collector.push(chunk)
        if (chunk?.type === 'finish') {
          // 只有明确不是 stop 才拒绝；reason 缺失时不猜。
          if (chunk.reason !== undefined && chunk.reason?.kind !== 'stop') return bumpRejected(session)
          break
        }
      }
      text = collector.text().trim()
      usage = collector.usage
    } catch (error) {
      // fail-open：旁路失败不改变主会话任何行为，也不在 UI 里报错，只是这一步没有标注。
      bumpRejected(session)
      return
    } finally {
      clearTimeout(timer)
    }

    if (typeof text !== 'string' || text.trim() === '') return bumpRejected(session)

    let note
    try {
      note = parseNote(text, { validSeqs })
    } catch {
      // 协议不合法的标注**整条丢弃**：宁可没有标注，也不要错标注。
      return bumpRejected(session)
    }

    const payload = {
      ...note,
      at: Date.now(),
      model: `${route.provider}/${route.model}`,
      usage: usage === null ? null : {
        inputTokens: numberOr(usage.inputTokens ?? usage.input, 0),
        outputTokens: numberOr(usage.outputTokens ?? usage.output, 0),
        ms: Date.now() - started,
      },
      // 确定性度量随 note 一起落盘：事后回看时能对上"当时是什么状态"。
      metrics: state.metrics,
      flags: state.flags.map((flag) => flag.kind),
    }

    // 写进插件自己的存储，**不碰会话日志**（理由见 lib/notes.js 顶部）。
    // anchor = 写入这一刻的会话 seq，重放时靠它把 note 折回原来的位置。
    const id = String(session.id)
    const current = states.get(id) ?? state
    const record = { anchor: lastEventSeq(session) ?? current.lastSeq, time: payload.at, data: payload }
    if (!appendNote(id, record)) return bumpRejected(session)

    // 立刻原地折一次：面板不必等下一个事件就能看到这条标注。
    // 已经不经过 session/event 回流了，所以这里只折一次，不存在重复计数。
    const folded = foldApply(current, noteEvent(record))
    if (folded !== current) states.set(id, folded)
  }

  function bumpRejected(session) {
    const state = states.get(String(session?.id ?? ''))
    if (state === undefined) return
    states.set(String(session.id), {
      ...state,
      usage: { ...state.usage, rejected: state.usage.rejected + 1 },
    })
  }

  // ── 订阅 ────────────────────────────────────────────────────────────────

  ctx.inject(['sessions'], (scoped) => {
    scoped.effect(() => scoped.on('session/event', (session, event) => {
      // 0.3 起 note 不再写进会话日志；这里保留 observer/note 是为了旧日志
      // （恢复出来的历史会话）仍能把脊柱画出来。
      if (!WATCHED.has(event?.type) && event?.type !== 'observer/note') return
      const id = String(session?.id ?? '')
      if (!id) return

      const previous = stateOf(session)
      // 冷启动那次 replay 已经把当前事件折进去了（post-commit，事件已在日志里）——
      // 再折一次会让 tool/call 被重复计数。按 seq 去重。
      const alreadyFolded = typeof event.seq === 'number' && event.seq <= previous.lastSeq
      const next = alreadyFolded ? previous : foldApply(previous, event)
      if (next !== previous) states.set(id, next)

      const boundary = isBoundary(event, next)
      if (boundary !== null) maybeSchedule(session, boundary)
    }), 'session-observer: event tap')

    // 会话离开时释放折叠状态，别让长跑进程无限增长。
    scoped.effect(() => scoped.on('session/disposed', (session) => {
      const id = String(session?.id ?? '')
      states.delete(id)
      schedule.delete(id)
    }), 'session-observer: state reap')
  })

  // ── 供数 ────────────────────────────────────────────────────────────────

  ctx.inject(['connection'], (scoped) => {
    const dispose = scoped.connection.rpc.handle('/session-observer', async (endpoint, payload) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
      const target = pickSession(ctx, sessionId)
      if (target === null) {
        return { ok: false, error: { code: 'no-session', message: 'no live session', details: {} } }
      }
      const state = stateOf(target.session)

      switch (endpoint) {
        case 'snapshot':
          // mode 由宿主说了算：客户端可能有陈旧的本地记忆，不能让它盖过真实配置。
          return {
            ok: true,
            value: toView(state, {
              session: target.meta,
              running: target.running,
              mode: cfg.mode,
            }),
          }
        case 'annotate-now':
          // 手动触发一次（面板上的"现在就标注"按钮）。
          void run(target.session)
          return { ok: true, value: { queued: true } }
        case 'sessions':
          return { ok: true, value: listSessions(ctx) }
        case 'config':
          if (payload?.patch && typeof payload.patch === 'object') Object.assign(cfg, payload.patch)
          return { ok: true, value: { ...cfg } }
        default:
          return { ok: false, error: { code: 'unknown-endpoint', message: String(endpoint), details: {} } }
      }
    })
    scoped.effect(() => () => { void dispose() }, 'session-observer: rpc')
  })

  // ── 生命周期 ────────────────────────────────────────────────────────────

  ctx.effect(() => () => {
    lifecycle.abort(new Error('session-observer disposed'))
    return Promise.allSettled([...inflight])
  }, 'session-observer: lifecycle')
}

/** 把会话列表压成面板能用的形状。 */
function listSessions(ctx) {
  const out = []
  try {
    const sessions = ctx.sessions?.list?.() ?? []
    for (const session of sessions) {
      out.push({
        id: String(session.id),
        title: session.title ?? null,
        running: session.running ?? undefined,
        lastAt: session.lastEventTime ?? undefined,
      })
    }
  } catch {
    return []
  }
  return out
}

/** 选目标会话：显式 id 优先，否则取最近有活的。 */
function pickSession(ctx, sessionId) {
  let sessions = []
  try {
    sessions = ctx.sessions?.list?.() ?? []
  } catch {
    return null
  }
  if (sessionId !== undefined) {
    const hit = sessions.find((session) => String(session.id) === sessionId)
    if (hit === undefined) return null
    return {
      session: hit,
      meta: { id: String(hit.id), title: hit.title ?? null },
      running: hit.running,
    }
  }
  if (sessions.length === 0) return null
  // 没有标题/时间信息时的稳定兜底：取列表首位（DSH 的列表本身按最近活动排序）。
  const first = sessions[0]
  return { session: first, meta: { id: String(first.id), title: first.title ?? null }, running: first.running }
}

const numberOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** 当前会话日志最后一条事件的 seq；拿不到就交给调用方回退。 */
function lastEventSeq(session) {
  try {
    const events = session?.snapshotEvents?.()
    const last = Array.isArray(events) ? events[events.length - 1] : undefined
    return typeof last?.seq === 'number' ? last.seq : undefined
  } catch {
    return undefined
  }
}


/** 收集文本增量与 usage —— 取代 @deepseek-ai/dsh-llm 的 BlockAssembler，零外部依赖。 */
function createTextCollector() {
  const texts = new Map()
  let usage = null
  return {
    push(chunk) {
      if (chunk === null || typeof chunk !== 'object') return
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        texts.set(chunk.index ?? 0, (texts.get(chunk.index ?? 0) ?? '') + chunk.text)
      } else if (chunk.type === 'usage') {
        usage = chunk.usage ?? null
      }
    },
    text() {
      return [...texts.keys()].sort((a, b) => a - b).map((key) => texts.get(key)).join('')
    },
    get usage() { return usage },
  }
}

/** 任何一个 log 面都用不上时也不能抛；尽力而为。 */
function reportSoftFailure(ctx, error) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const logger = ctx?.logger
    if (typeof logger?.warn === 'function') logger.warn(`[session-observer] 已禁用：${message}`)
    else console.warn(`[session-observer] 已禁用：${message}`)
  } catch {
    /* 连日志都打不出来就算了，静默 */
  }
}