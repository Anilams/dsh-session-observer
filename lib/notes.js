/**
 * note 的落盘：插件自己的文件，**不写进宿主会话日志**。
 *
 * 为什么改（2026-11-06 事故）：
 *   宿主的 Session.append() 没有写入 `ignorable` 的入口，而读路径
 *   （dsh-session-persistence 的 validateStoredEvents）遇到「不认识的类型、
 *   且信封没标 ignorable」时会拒绝解释**整份**日志。于是
 *     session.append('observer/note', …)
 *   在当次进程里完全正常，重启后那份会话就再也打不开——本次一次打挂了 20 份会话。
 *   同一个坑 dsh-cost-meter 早就踩过，它的结论同样是：**不往宿主日志写自定义事件**，
 *   插件数据放插件自己的存储（见其 docs/session-history-recovery.md）。
 *
 * 折衷：note 不再随会话 fork/导出一起走。这是有意识的交换——「重启能打开会话」
 * 优先于「note 随日志迁移」。旧日志里已经存在的 observer/note 仍然被 fold 认得
 * （见 lib/fold.js），所以历史会话的脊柱不会因为这次改动而消失。
 *
 * 布局：$DSH_HOME/storages/session-observer/notes/<sessionId>.jsonl
 * 一行一条：{"v":1,"anchor":<写入时的会话 seq>,"time":<ms>,"data":{…note…}}
 * anchor 是排序依据：重放时把 note 折在 anchor 之后、下一条日志事件之前，
 * 与 note 写入当时的内存折叠顺序一致。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 单份会话保留的 note 条数。脊柱上限 40，留 10 倍余量给多回合会话。 */
export const MAX_NOTES = 400
/** 文件超过这个体积就压实一次，避免长跑会话无界增长。 */
const COMPACT_BYTES = 512 * 1024

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** note 目录；测试用 DSH_HOME 指到临时目录即可。 */
export function notesDir() {
  return path.join(dshHome(), 'storages', 'session-observer', 'notes')
}

function fileOf(sessionId) {
  // 会话 id 是 `session-<uuid>`，其余字符一律转义，避免路径穿越。
  const safe = encodeURIComponent(String(sessionId))
  return path.join(notesDir(), `${safe}.jsonl`)
}

/**
 * 读回一份会话的 note。
 * 坏行整行跳过（宁可少一条标注，也不要因为一行残片丢整份历史）。
 * @returns {{anchor:number, time:number, data:object}[]} 按 anchor/time 升序
 */
export function readNotes(sessionId, limit = MAX_NOTES) {
  const file = fileOf(sessionId)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (typeof record?.data !== 'object' || record.data === null) continue
      out.push({
        anchor: typeof record.anchor === 'number' ? record.anchor : 0,
        time: typeof record.time === 'number' ? record.time : 0,
        data: record.data,
      })
    } catch {
      /* 残片跳过 */
    }
  }
  out.sort((a, b) => (a.anchor - b.anchor) || (a.time - b.time))
  return out.slice(-limit)
}

/**
 * 追加一条 note。失败只返回 false，绝不抛——旁路数据丢了是小事，
 * 弄崩主会话是大事。
 */
export function appendNote(sessionId, record) {
  const file = fileOf(sessionId)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ v: 1, ...record })}\n`, 'utf8')
    compactIfNeeded(file)
    return true
  } catch {
    return false
  }
}

/** 超过阈值就只留最后 MAX_NOTES 条，原地重写。 */
function compactIfNeeded(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= COMPACT_BYTES) return
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const kept = lines.slice(-MAX_NOTES)
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${kept.join('\n')}\n`, 'utf8')
    fs.renameSync(temp, file)
  } catch {
    /* 压实失败不影响读写：下一轮再试 */
  }
}
