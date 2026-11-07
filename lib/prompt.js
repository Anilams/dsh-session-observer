/**
 * 旁路模型的协议层：提示词 + 严格解析。
 *
 * 两条硬纪律（见 DESIGN.md §2、§8）：
 *   1. 输出是**封闭 JSON**，字段定死，字数有上限。自由文本摘要会被 UI 截断，
 *      而且会引诱旁路模型写小作文——那是这个产品最典型的失败方式。
 *   2. 解析失败一律"当作这次没跑"，绝不降级成自由文本。宁可没有标注，也不要错标注。
 */

/** 输出字段上限。超了就截断而不是拒绝——摘要略长不是致命伤，但不要默默变长。 */
const CAPS = {
  now: 40,
  because: 30,
  intent: 24,
  chosen: 24,
  alternative: 24,
}

export const SYSTEM_PROMPT = `SIDECAR_POLICY
你是主模型的旁路观察者。你只看它的**行为**（工具调用、结果、步骤），不看它的自述推理。
你的唯一职责是：用一行字说清它此刻在做什么，并预测它下一步要做什么。

硬性规则：
1. 只输出一个 JSON 对象，不要 Markdown、不要代码块、不要任何解释文字。
2. 对象成员恰好七个：now, because, predict, fork, alignment, confidence, anchors。
3. now：≤40 个汉字，动宾结构，说"在做什么"，不要形容词堆砌，不要复述工具名。
4. because：≤30 个汉字，说"为什么这一步"。说不出来就填 null。
5. predict：{"tool":"<工具名>","target":"<该工具的关键参数，如路径或命令>","intent":"<≤24字>"}。
   这是最重要的一项——必须是一个**具体的、下一动作级别**的预测，不能是"继续处理"这种废话。
6. fork：如果这一步是一次真正的路线选择，填 {"chosen":"...","alternative":"..."}，否则 null。
7. alignment：0-100 整数。当前动作与你判断的**用户原始目标**的对齐度。100=完全对齐。
8. confidence：0-1 的小数，表示你对上面判断的把握。看不懂就老实给低分。
9. anchors：数组，从 RECENT_EVENTS 里挑 1-2 个最能支撑你判断的 seq（整数）。

禁止：给"总分"、给建议、给鼓励、解释你的方法。你是一个仪表，不是一个导师。`

/**
 * 组装旁路请求的消息体。
 * @param {object} input
 * @param {string} input.goal 用户原始目标（turn 的首条人类消息，截断）
 * @param {Array} input.ledger 结构化行为窗口
 * @param {string} [input.thinkingHead] 本窗口内 reasoning 的前缀采样
 * @param {object} input.metrics 确定性度量
 * @param {Array} input.events 原始事件（供 anchors 引用 seq）
 * @param {string} [input.previousNow] 上一次的 now，供判断"是否仍然在做同一件事"
 * @returns {Array} messages
 */
export function buildMessages({ goal, ledger, thinkingHead, metrics, events, previousNow }) {
  const digest = events.map((event) => ({
    seq: event.seq,
    type: event.type,
    // 只给摘要级别的内容：多给无益，反而稀释注意力。
    detail: detailOf(event),
  }))

  return [{
    role: 'user',
    content: [{
      type: 'text',
      text: [
        `GOAL\n${clip(goal || '（未知，用户尚未给出明确目标）', 300)}`,
        ``,
        `METRICS\n${JSON.stringify(metrics)}`,
        ``,
        `PREVIOUS_NOTE\n${previousNow ? clip(previousNow, 80) : '（本轮第一次标注）'}`,
        ``,
        `THINKING_HEAD\n${thinkingHead ? clip(thinkingHead, 480) : '（本窗口没有可见推理）'}`,
        ``,
        `RECENT_EVENTS\n${JSON.stringify(digest)}`,
        ``,
        `LEDGER\n${JSON.stringify(ledger)}`,
        ``,
        `只输出那个七成员 JSON 对象。`,
      ].join('\n'),
    }],
  }]
}

/** 事件 → 一行摘要。刻意做得极简：旁路模型需要的是形状，不是内容。 */
function detailOf(event) {
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'tool/call':
      return `${data.name}(${clip(String(data.arguments ?? ''), 120)})`
    case 'tool/result': {
      const failed = data.message?.isError === true || data.error !== undefined
      return failed ? `FAIL ${clip(data.error?.reason ?? data.error?.code ?? '', 80)}` : 'ok'
    }
    case 'assistant/message': {
      const text = (data.message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
      return clip(text, 100)
    }
    case 'user/message':
      return clip(messageText(data), 120)
    case 'step/end':
      return `step ${data.step} end`
    case 'turn/start':
      return `turn ${data.turn} start`
    default:
      return ''
  }
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
}

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 七个成员，一个不多一个不少。 */
const MEMBERS = ['now', 'because', 'predict', 'fork', 'alignment', 'confidence', 'anchors']

/**
 * 严格解析旁路模型的回复。
 * @param {string} text 模型原始输出
 * @param {{validSeqs: Set<number>}} context 用于校验 anchors 是否真实存在
 * @returns {object} 归一化后的 note 字段
 * @throws {Error} 任何不符合协议的情况都抛错——调用方据此丢弃这次标注
 */
export function parseNote(text, context) {
  const trimmed = String(text ?? '').trim()
  // 允许模型不小心包了 ```json —— 剥掉，但除此之外不做任何宽容解析。
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  let parsed
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    throw new Error('sidecar: reply is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('sidecar: reply is not an object')
  }

  const keys = Object.keys(parsed)
  if (keys.length !== MEMBERS.length || !MEMBERS.every((key) => keys.includes(key))) {
    throw new Error(`sidecar: member set mismatch (${keys.join(',')})`)
  }

  if (typeof parsed.now !== 'string' || parsed.now.trim() === '') throw new Error('sidecar: bad now')
  if (parsed.because !== null && typeof parsed.because !== 'string') throw new Error('sidecar: bad because')
  if (!Number.isInteger(parsed.alignment) || parsed.alignment < 0 || parsed.alignment > 100) {
    throw new Error('sidecar: bad alignment')
  }
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('sidecar: bad confidence')
  }
  if (!Array.isArray(parsed.anchors) || parsed.anchors.length === 0 || parsed.anchors.length > 3) {
    throw new Error('sidecar: bad anchors')
  }
  // 结构性防幻觉：anchor 必须是真实存在的 seq，否则整条 note 作废。
  for (const anchor of parsed.anchors) {
    if (!Number.isInteger(anchor) || !context.validSeqs.has(anchor)) {
      throw new Error(`sidecar: anchor ${anchor} not in window`)
    }
  }

  let predict = null
  if (parsed.predict !== null) {
    if (parsed.predict === null || typeof parsed.predict !== 'object'
      || typeof parsed.predict.tool !== 'string' || parsed.predict.tool.trim() === '') {
      throw new Error('sidecar: bad predict')
    }
    predict = {
      tool: parsed.predict.tool.trim().slice(0, 40),
      target: typeof parsed.predict.target === 'string' ? parsed.predict.target.trim().slice(0, 120) : '',
      intent: clip(parsed.predict.intent ?? '', CAPS.intent),
    }
  }

  let fork = null
  if (parsed.fork !== null) {
    if (typeof parsed.fork !== 'object' || typeof parsed.fork.chosen !== 'string'
      || typeof parsed.fork.alternative !== 'string') {
      throw new Error('sidecar: bad fork')
    }
    fork = { chosen: clip(parsed.fork.chosen, CAPS.chosen), alternative: clip(parsed.fork.alternative, CAPS.alternative) }
  }

  return {
    now: clip(parsed.now, CAPS.now),
    because: parsed.because ? clip(parsed.because, CAPS.because) : null,
    predict,
    fork,
    alignment: parsed.alignment,
    confidence: parsed.confidence,
    anchors: [...new Set(parsed.anchors)].slice(0, 3),
  }
}
