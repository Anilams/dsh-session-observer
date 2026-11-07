/**
 * dsh-session-observer —— 浏览器半边（会话视图「观察」）
 *
 * 零构建：手写 ESM，由 `window.__ModuleLoader__.load({id, factory})` 装载。
 * 只 require 壳的静态种子词条（react），不依赖任何 profile 包。
 *
 * 这个视图只回答一个问题：**我现在需要插手吗？**
 *
 * 它因此故意长得不像仪表盘：
 *   - 平稳态近乎空白，只写四个字（空白是「你不需要在场」的视觉编码）
 *   - 颜色预算只有一个强调色，只在判决不是「在跑」时出场
 *   - 历史折叠成一条密度带：厚度即密度，薄而长的一段空白即卡住
 *   - 决策点常驻展开，按类型上色（里程碑/岔路/不确定）
 *
 * 设计见 DESIGN.md / 方案 star-dsh-clever-koala.md。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-observer',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const ID = 'dsh-session-observer'
    const CHANNEL = '/session-observer'
    const CSS_ID = 'dsh-session-observer/client.css'

    /** 判决 → 文案、色点。空字符串表示不显示额外理由。 */
    const VERDICT = {
      running: { word: '在跑', tone: 'calm' },
      stuck: { word: '卡住', tone: 'warn' },
      erroring: { word: '出错', tone: 'warn' },
      waiting: { word: '等你', tone: 'ask' },
      dangerous: { word: '危险', tone: 'alarm' },
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    //
    // 全部走 --dsw-* 语义 token，暗色自动跟随。
    // 布局是「一列，宽 640，垂直居中偏上」——这是整块视图的骨架，
    // 平稳态下的留白不是没画完，是画出来的。

    // 全部走 --dsw-* / --ds-* 语义令牌；只读不写，暗色自动跟随。
    // 圆点与胶囊必须显式 corner-shape:round —— 宿主全局启用了 superellipse(1.5)，
    // 不退出的话正圆会被压成圆角方块。
    const CSS = `
.svo-root{
  /* 语义令牌做底，色相令牌做语气。只读不写。 */
  --svo-ink:var(--dsw-alias-label-primary);
  --svo-ink-2:var(--dsw-alias-label-secondary);
  --svo-ink-3:var(--dsw-alias-label-tertiary);
  --svo-line:var(--dsw-alias-border-l1);

  /* 五种语气，各有专属色相。这是这套 UI 的"多巴胺"来源，
     但每一种都只在语义成立时出现，不做装饰。 */
  --svo-run:#22c55e;      /* 在跑：绿 */
  --svo-mile:#38bdf8;     /* 里程碑：天蓝 */
  --svo-fork:#f59e0b;     /* 岔路：琥珀 */
  --svo-dim:#a78bfa;      /* 低置信：紫 */
  --svo-alarm:#f43f5e;    /* 危险：玫红 */
  --svo-ask:#3b82f6;      /* 等你：蓝 */

  box-sizing:border-box;height:100%;overflow-y:auto;overscroll-behavior:contain;
  display:flex;justify-content:center;
  padding:clamp(48px,13vh,120px) 32px 56px;
  background:var(--dsw-alias-bg-base);
  color:var(--svo-ink);
  font:var(--dsw-font-s-14);
  font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;
}
.svo-col{width:100%;max-width:var(--dsh-chat-content-width,680px);
  display:flex;flex-direction:column;gap:24px}

/* ── 判决：唯一的英雄。静止，无动效——静止就是消息 ── */
.svo-head{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.svo-dot{width:9px;height:9px;border-radius:50%;corner-shape:round;flex:none}
.svo-dot.calm{background:var(--svo-run);box-shadow:0 0 0 3px color-mix(in srgb,var(--svo-run) 16%,transparent)}
.svo-dot.warn{background:var(--svo-fork);box-shadow:0 0 0 3px color-mix(in srgb,var(--svo-fork) 18%,transparent)}
.svo-dot.ask{background:var(--svo-ask);box-shadow:0 0 0 3px color-mix(in srgb,var(--svo-ask) 16%,transparent)}
.svo-dot.alarm{background:var(--svo-alarm);box-shadow:0 0 0 3px color-mix(in srgb,var(--svo-alarm) 20%,transparent)}
.svo-dot.hollow{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-border-l4)}
.svo-word{font:var(--dsw-font-l-20);letter-spacing:-.01em;color:var(--svo-ink)}
.svo-word.calm{color:var(--svo-ink)}
.svo-tick{font-family:var(--ds-font-family-code);font-size:12px;color:var(--svo-ink-3);
  padding:2px 8px;border-radius:999px;corner-shape:round;
  background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-elevation-stroke)}
.svo-because{margin:10px 0 0;font:var(--dsw-font-s-14);color:var(--svo-ink-2);
  max-width:52ch;text-wrap:pretty}
.svo-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.svo-btn{
  appearance:none;border:0;box-shadow:var(--dsw-elevation-stroke);
  background:var(--dsw-alias-bg-layer-2);
  border-radius:999px;corner-shape:round;padding:6px 14px;font:var(--dsw-font-xs-13);
  color:var(--svo-ink-2);cursor:pointer;
  transition:background-color .14s var(--ds-ease-in-out),color .14s var(--ds-ease-in-out);
}
.svo-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--svo-ink)}
.svo-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.svo-btn:focus-visible{outline:1px solid var(--svo-ask);outline-offset:2px}
.svo-btn.primary{color:var(--svo-ink)}
.svo-btn:disabled{opacity:.45;cursor:default}

/* ── 密度带：整段的节奏。密度越高色相越暖，一眼看出哪里密哪里空 ── */
.svo-spine{display:flex;flex-direction:column;gap:0}
.svo-band{display:flex;align-items:flex-end;gap:2px;height:30px}
.svo-band i{flex:1;min-width:2px;border-radius:3px 3px 1px 1px;
  transition:opacity .14s var(--ds-ease-in-out)}
/* 四档色阶：空 → 淡天蓝 → 靛 → 紫 */
.svo-band i.empty{background:var(--dsw-alias-label-tertiary);opacity:.10}
.svo-band i.l1{background:#38bdf8;opacity:.45}
.svo-band i.l2{background:#818cf8;opacity:.62}
.svo-band i.l3{background:#c084fc;opacity:.78}
/* 岔路永远琥珀——它是唯一需要你回头看一眼的格子 */
.svo-band i.fork{background:var(--svo-fork);opacity:.9}

.svo-axis{display:flex;justify-content:space-between;gap:16px;
  font-family:var(--ds-font-family-code);font-size:10.5px;color:var(--svo-ink-3);
  margin-top:8px;letter-spacing:.01em;
  border-bottom:.5px solid var(--dsw-alias-border-l1);padding-bottom:10px}

/* ── 决策点：常驻展开，一条彩色的时间轴 ── */
.svo-chain{
  display:flex;flex-direction:column;
  margin-top:6px;position:relative;
}
.svo-chain::before{
  content:"";position:absolute;left:33px;top:14px;bottom:14px;width:1.5px;
  background:linear-gradient(to bottom,var(--svo-mile),transparent);
  opacity:.35;border-radius:2px;
}
.svo-node{display:flex;gap:0;align-items:flex-start;
  padding:9px 10px 9px 0;border-radius:10px;
  animation:svo-in .22s cubic-bezier(.2,.8,.2,1) both;
  transition:background-color .14s var(--ds-ease-in-out)}
.svo-node:hover{background:var(--dsw-alias-interactive-bg-hover)}
@keyframes svo-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

/* 刻度列 + 彩点 */
.svo-node .k{font-family:var(--ds-font-family-code);font-size:10.5px;
  color:var(--svo-ink-3);flex:none;width:38px;padding-top:4px}
.svo-node .g{flex:none;width:20px;display:flex;justify-content:center;padding-top:6px;position:relative;z-index:1}
.svo-node .g b{width:8px;height:8px;border-radius:50%;corner-shape:round;
  background:var(--svo-mile);box-shadow:0 0 0 3px var(--dsw-alias-bg-base)}

.svo-node .t{font:var(--dsw-font-xs-13);color:var(--svo-ink);line-height:1.55;flex:1;min-width:0}
.svo-node .s{display:block;font:var(--dsw-font-xxs-12);color:var(--svo-ink-3);
  margin-top:3px;line-height:1.5}
.svo-node .s .x{text-decoration:line-through;
  text-decoration-color:var(--dsw-alias-border-l4);opacity:.7}

/* 类型标签：只给"需要你注意"的两种节点 */
.svo-node .tag{display:inline-block;margin-right:7px;padding:1px 7px;
  border-radius:999px;corner-shape:round;font-size:10.5px;line-height:16px;
  vertical-align:1px;letter-spacing:.02em}
.svo-node .tag.fork{color:var(--svo-fork);
  background:color-mix(in srgb,var(--svo-fork) 13%,transparent)}
.svo-node .tag.dim{color:var(--svo-dim);
  background:color-mix(in srgb,var(--svo-dim) 13%,transparent)}

/* 三种节点各有底色，让"事件类型"一眼可辨 */
.svo-node.mile .g b{background:var(--svo-mile)}
.svo-node.fork{padding-left:0}
.svo-node.fork .g b{background:var(--svo-fork);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--svo-fork) 16%,var(--dsw-alias-bg-base))}
.svo-node.fork .t{color:var(--svo-ink)}
.svo-node.dim .g b{background:var(--svo-dim);opacity:.75}
.svo-node.dim .t{color:var(--svo-ink-2)}

/* 最新一条：心跳点，唯一持续动效 */
.svo-node.fresh .g b{animation:svo-pulse 2.2s ease-in-out infinite}
@keyframes svo-pulse{
  0%,100%{box-shadow:0 0 0 3px var(--dsw-alias-bg-base)}
  50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--svo-mile) 22%,transparent)}
}

.svo-empty{font:var(--dsw-font-xs-13);color:var(--svo-ink-3);
  padding:18px 0 4px;max-width:46ch}

/* ── 脚注：安静的模式开关，不做设置页 ── */
.svo-foot{display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  font:var(--dsw-font-xxs-12);color:var(--svo-ink-3);
  border-top:.5px solid var(--dsw-alias-border-l1);padding-top:16px}
.svo-foot .sp{flex:1}
.svo-badge{display:inline-flex;align-items:center;gap:6px;
  padding:3px 9px;border-radius:999px;corner-shape:round;
  background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-stroke)}
.svo-badge b{width:6px;height:6px;border-radius:50%;corner-shape:round;flex:none}
.svo-badge.smart b{background:var(--svo-fork)}
.svo-badge.free b{background:var(--svo-run)}
.svo-link{appearance:none;background:none;border:0;padding:0;
  font:var(--dsw-font-xxs-12);color:var(--svo-ink-3);cursor:pointer;
  text-decoration:underline;text-decoration-color:var(--dsw-alias-border-l3);
  text-underline-offset:3px;transition:color .14s var(--ds-ease-in-out)}
.svo-link:hover{color:var(--svo-ink-2);text-decoration-color:currentColor}
.svo-link:focus-visible{outline:1px solid var(--svo-ask);
  outline-offset:2px;border-radius:3px}

.svo-idle{font:var(--dsw-font-xs-13);color:var(--svo-ink-3);max-width:46ch}

@media (prefers-reduced-motion:reduce){
  .svo-band i,.svo-node,.svo-btn,.svo-link{transition:none}
  .svo-node,.svo-node.fresh .g b{animation:none}
}
`

    function ensureCss() {
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = ID
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** RPC 薄封装：统一把 {ok,...} 信封拆开。 */
    function rpc(ctx, endpoint, payload) {
      return ctx.connection.rpc.call(CHANNEL, endpoint, payload ?? {})
        .then((result) => {
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            throw new Error(result?.error?.message ?? 'rpc failed')
          }
          return result.value
        })
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────

    /** 毫秒 → 人话。判决旁边的刻度用它，所以不许有小数点。 */
    function duration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${seconds} 秒`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
    }

    /** 时钟：只给密度带用，不给人读秒。 */
    function clock(at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 把决策点折成密度带。
     *
     * 每一格的厚度 = 那段时间里的决策点数量。于是：
     *   - 薄而长的一段空白 → 它卡住了
     *   - 粗而密的一串     → 它在原地打转
     * 两种病不读任何数字就能分辨，这正是这条带存在的理由。
     */
    const BUCKETS = 56

    function bandOf(spine, startedAt, now) {
      const cells = new Array(BUCKETS).fill(0)
      const forks = new Array(BUCKETS).fill(false)
      const from = startedAt ?? now
      const span = Math.max(1, now - from)
      const nodes = Array.isArray(spine) ? spine : []
      for (const node of nodes) {
        const at = typeof node.at === 'number' ? node.at : null
        if (at === null) continue
        const ratio = (at - from) / span
        if (ratio < 0 || ratio > 1.0001) continue
        const slot = Math.min(BUCKETS - 1, Math.max(0, Math.floor(ratio * BUCKETS)))
        cells[slot] += 1
        if (node.kind === 'fork') forks[slot] = true
      }
      const max = Math.max(1, ...cells)
      return cells.map((count, index) => ({
        count,
        fork: forks[index],
        // 一格都没有 → 极矮；有 → 按比例线性映射到 3..22px
        height: count === 0 ? 2 : 3 + (count / max) * 19,
        // 色阶：密度越高色相越暖，和高度一起编码同一件事（冗余是刻意的）
        tone: count === 0 ? 'empty' : count === 1 ? 'l1' : count === 2 ? 'l2' : 'l3',
      }))
    }

    // ── 决策点时间轴 ────────────────────────────────────────────────────────

    /**
     * 决策点**常驻展开**——它们是这个视图的主要内容，藏起来等于没有。
     *
     * 顺序是新的在上：你回来时最想知道的永远是「刚才发生了什么」。
     * 最新一条带心跳，那是整屏唯一的持续动效。
     */
    function Spine({ spine, startedAt, now }) {
      const band = bandOf(spine, startedAt, now)
      const all = Array.isArray(spine) ? spine.slice().reverse() : []
      const nodes = all.slice(0, 30)

      return h('div', { className: 'svo-spine' },
        // 密度带：整段的节奏。它回答的是「这段时间整体什么样」，
        // 下面的时间轴回答「具体有哪几个关键点」。
        h('div', { className: 'svo-band' },
          band.map((cell, index) => h('i', {
            key: index,
            className: cell.fork ? 'fork' : cell.tone,
            style: { height: cell.height + 'px' },
          }))),

        h('div', { className: 'svo-axis' },
          h('span', null, startedAt ? clock(startedAt) : ''),
          h('span', null, nodes.length === 0 ? '' : `${all.length} 个决策点`),
          h('span', null, clock(now))),

        nodes.length === 0
          ? h('div', { className: 'svo-empty' },
            '还没有决策点。它会在语义边界处记下一句：这一步在做什么、为什么。')
          : h('div', { className: 'svo-chain' },
            nodes.map((node, index) => h('div', {
              key: String(node.seq ?? index),
              className: 'svo-node ' + (node.kind ?? 'mile') + (index === 0 ? ' fresh' : ''),
            },
            h('span', { className: 'k' }, node.at ? clock(node.at) : '—'),
            h('span', { className: 'g' }, h('b', null)),
            h('span', { className: 't' },
              // 岔路与低置信带类型标签——它们是"需要你注意"的两种节点，
              // 只靠圆点颜色区分太弱。
              node.kind === 'fork'
                ? h('span', { className: 'tag fork' }, '岔路')
                : node.kind === 'dim'
                  ? h('span', { className: 'tag dim' }, '不确定')
                  : null,
              node.text,
              node.fork
                ? h('span', { className: 's' },
                  `选：${node.fork.chosen}　`,
                  h('span', { className: 'x' }, `弃：${node.fork.alternative}`))
                : node.because
                  ? h('span', { className: 's' }, node.because)
                  : null)))))
    }

    // ── 主视图 ──────────────────────────────────────────────────────────────

    function View({ sessionId, call }) {
      const [view, setView] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      /** 'ask' = 首次引导；'free' = 纯规则；'smart' = 开了旁路模型 */
      const [mode, setMode] = React.useState(null)

      React.useEffect(() => {
        let live = true
        let timer = null
        let interval = 2500

        const tick = async () => {
          try {
            const next = await call('snapshot', sessionId ? { sessionId } : {})
            if (!live) return
            setView(next)
            setFailed(false)
            // 异常时刷快一点，让人看见它自己恢复；平稳时省电。
            const abnormal = next?.verdict?.state !== 'running' || next?.verdict?.state === 'waiting'
            interval = abnormal ? 1200 : 2500
          } catch {
            if (!live) return
            setFailed(true)
            interval = 5000
          }
          timer = setTimeout(tick, interval)
        }
        tick()
        return () => { live = false; if (timer !== null) clearTimeout(timer) }
      }, [sessionId, call])

      /**
       * 模式解析，必须放在**同一个** effect 里。
       *
       * 拆成两个会踩竞态：首次提交时两个 effect 都会跑，后一个把前一个刚设的
       * 'ask' 覆盖成宿主的 'free'，引导页永远不出现。合成一个，分支明确：
       *   1. 还没定过 → 本地缓存说的算；没有缓存就问一次
       *   2. 定过 → 以宿主为准（本地缓存只是首帧的猜测）
       */
      React.useEffect(() => {
        if (view === null) return
        if (mode === null) {
          let saved = null
          try {
            saved = window.localStorage.getItem('dsh-session-observer/mode')
          } catch { /* 隐私模式：读不到就当没定过 */ }
          setMode(saved === 'smart' || saved === 'free' ? saved : 'ask')
          return
        }
        if (mode === 'ask') return
        if (view.mode === 'smart' || view.mode === 'free') setMode(view.mode)
      }, [view, mode])

      const choose = (value) => {
        setMode(value)
        try { window.localStorage.setItem('dsh-session-observer/mode', value) } catch { /* 隐私模式 */ }
        setBusy(true)
        void call('config', { patch: { mode: value } })
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      if (failed && view === null) {
        return h('div', { className: 'svo-root' },
          h('div', { className: 'svo-col' },
            h('div', { className: 'svo-idle' }, '观察未接通。这不影响会话本身。')))
      }
      if (view === null) {
        // 加载态不转圈、不闪——空着就是最准确的表达。
        return h('div', { className: 'svo-root' }, h('div', { className: 'svo-col' }))
      }

      const verdict = view.verdict ?? { state: 'running', since: null, reason: null }
      const spec = VERDICT[verdict.state] ?? VERDICT.running
      const ended = view.ended === true
      const cold = (view.baseline?.samples ?? 0) < 20

      // 冷启动与「回合已交回」都要说出来：前者是它还没资格开口，
      // 后者是它不该开口。把这两种情况伪装成「一切正常」是不诚实的。
      const word = ended && verdict.state === 'running' ? '空闲' : spec.word
      const tone = ended && verdict.state === 'running' ? 'hollow' : spec.tone

      const tick = view.elapsedMs == null ? '' : duration(view.elapsedMs)
      // 只在两种时候说理由：判决给了理由，或还没攒够样本。
      // 其余情况一概不说——平稳态的安静是设计出来的。
      const because = verdict.reason
        ?? (cold ? '还在摸这个会话的节奏，攒够样本前不会喊你。' : null)

      return h('div', { className: 'svo-root' },
        h('div', { className: 'svo-col' },

          // ⑤ 判决
          h('div', null,
            h('div', { className: 'svo-head' },
              h('span', { className: 'svo-dot ' + tone }),
              h('span', { className: 'svo-word ' + (tone === 'calm' || tone === 'hollow' ? 'calm' : '') }, word),
              tick === '' ? null : h('span', { className: 'svo-tick' }, tick)),
            because === null ? null : h('p', { className: 'svo-because' }, because),

            // 动作：只在真的可操作时出现。每个都必须真能执行——
            // 按钮点了没反应，比没有按钮更糟。
            verdict.state === 'dangerous' && mode === 'smart'
              ? h('div', { className: 'svo-actions' },
                h('button', {
                  className: 'svo-btn',
                  disabled: busy,
                  onClick: () => {
                    setBusy(true)
                    void call('config', { patch: { mode: 'free' } })
                      .catch(() => {}).finally(() => setBusy(false))
                  },
                }, '先停掉旁路'))
              : (verdict.state === 'stuck' || verdict.state === 'erroring')
                // 免费模式下没有模型可问，就不该给一个点了不花钱但也没用的按钮。
                ? (mode === 'smart'
                  ? h('div', { className: 'svo-actions' },
                    h('button', {
                      className: 'svo-btn',
                      disabled: busy,
                      onClick: () => {
                        setBusy(true)
                        void call('annotate-now', sessionId ? { sessionId } : {})
                          .catch(() => {}).finally(() => setBusy(false))
                      },
                    }, '看一眼它在试什么'))
                  : null)
                : null),

          // ④ 脊
          cold && (view.spine?.length ?? 0) === 0
            ? null
            : h(Spine, { spine: view.spine, startedAt: view.startedAt ?? (view.at - view.totalMs), now: view.at }),

          // 首次引导：一个安静的选择，不是设置页
          mode === 'ask'
            ? h('div', null,
              h('p', { className: 'svo-because' },
                '这个视图能纯靠规则判断它卡没卡住，一分钱不花。'),
              h('p', { className: 'svo-because', style: { marginTop: 6 } },
                '也可以让另一个模型跟着看，多说一句话——按量计费，一天大约几毛钱。'),
              h('div', { className: 'svo-actions' },
                h('button', { className: 'svo-btn primary', disabled: busy, onClick: () => choose('smart') },
                  '让它多说一句'),
                h('button', { className: 'svo-btn', disabled: busy, onClick: () => choose('free') },
                  '先不用，只看卡没卡')))
            : null,

          // 脚注：模式常驻，但不做成设置页
          h('div', { className: 'svo-foot' },
            mode === null || mode === 'ask'
              ? null
              : h('span', { className: 'svo-badge ' + (mode === 'smart' ? 'smart' : 'free') },
                h('b', null),
                mode === 'smart' ? '规则 + 旁路模型' : '只用规则'),
            h('span', { className: 'sp' }),
            mode === null || mode === 'ask'
              ? null
              : h('button', {
                className: 'svo-link',
                onClick: () => setMode('ask'),
              }, mode === 'smart' ? '改成不花钱' : '让它多说一句'))))
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    /**
     * 只依赖 slots 与 connection。
     *
     * 不比 chat / trajectory 更少——它们也是普通插槽注册。
     * 没有 conversation 目标构建器是**故意的**：本视图不消费对话节点，
     * 它消费的是宿主半边折叠出来的判决快照。
     */
    const inject = ['slots', 'connection']

    function apply(ctx) {
      ensureCss()

      // 等 conversation 壳声明了这个插槽再注册，避免加载顺序问题。
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'observer',
        // chat = 0，trajectory = 10。观察排在它们之后。
        order: 20,
        label: () => '观察',
        inject: (sessionId) => ({
          sessionId,
          call: (endpoint, payload) => rpc(ctx, endpoint, payload),
        }),
      }, View))
    }

    return { inject, apply }
  },
})
