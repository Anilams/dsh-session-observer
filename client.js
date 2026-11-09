/**
 * dsh-session-observer —— 浏览器半边（会话视图「观察」）
 *
 * 零构建：手写 ESM，由 `window.__ModuleLoader__.load({id, factory})` 装载。
 * 只 require 壳的静态种子词条（react），不依赖任何 profile 包。
 *
 * 这个视图只回答一个问题：**我现在需要插手吗？**
 *
 * 版式（v9）：一屏两栏，左观察右统计，互为索引。
 *   左：按轮次分节的时间脊，决策点常驻展开，岔路画出被放弃的那条
 *   右：目标 / 合计 / 工具分布 / 成本，点数字能反向筛左列
 * 空闲时段折在「有效时间轴」上——过夜的空档只占一段虚线，不占横向空间。
 *
 * 设计见 DESIGN.md / design/index.html。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-observer',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const ID = 'dsh-session-observer'
    const CHANNEL = '/session-observer'
    const CSS_ID = 'dsh-session-observer/client.css'

    /** 判决 → 文案、语气。空字符串表示不显示额外理由。 */
    const VERDICT = {
      running: { word: '运行中', tone: 'calm', icon: 'pulse' },
      stuck: { word: '停滞', tone: 'warn', icon: 'clock' },
      erroring: { word: '异常', tone: 'warn', icon: 'warn' },
      waiting: { word: '待确认', tone: 'ask', icon: 'info' },
      dangerous: { word: '高风险', tone: 'alarm', icon: 'warn' },
    }
    /** 空闲是「落回静止」而不是第五种判决，它单独有一个图标。 */
    const IDLE = { word: '空闲', tone: 'hollow', icon: 'ring' }

    // ── 图标 ────────────────────────────────────────────────────────────────
    //
    // 20×20 网格、1.5 描边、currentColor。全部手写：这是本插件自有的资产，
    // 不引入第三方图标包（许可证与体积都不划算）。
    const ICONS = {
      pulse: 'M2.6 10h2.8l1.7-4.4 2.5 8.8 2.1-6.1 1.5 1.7h3.4',
      clock: 'M10 3.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8M10 6.6v3.9l2.5 1.5',
      warn: 'M10 3.3 16.9 16H3.1L10 3.3ZM10 7.9v3.4M10 13.5v.2',
      info: 'M10 3.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8M10 9.2v4.2M10 6.9v.2',
      ring: 'M10 4.7a5.3 5.3 0 1 0 0 10.6 5.3 5.3 0 0 0 0-10.6M10 8.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6',
      dot: 'M10 6.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4',
      gauge: 'M3.3 14.3a6.9 6.9 0 1 1 13.4 0M10 13.2 13 9.4',
      clipboard: 'M7.1 4.3h5.8v12.4H7.1ZM8.5 4.3V2.9h3v1.4M8.9 8.7h2.2M8.9 11.5h2.2',
      ledger: 'M4.8 3.7h10.4v12.6H4.8ZM7.2 7.5h5.6M7.2 10.3h5.6M7.2 13.1h3.2',
      branch: 'M10 7.2V4.6M10 7.2 6.6 11.4M10 7.2l3.4 4.2M10 8.4a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4M6.6 10.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4M13.4 10.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4',
      screen: 'M3.5 4.7h13v9.1h-13ZM8.1 13.8l-.7 2.6M11.9 13.8l.7 2.6M7.4 16.4h5.2',
      box: 'M3.7 6.6h12.6v9.8H3.7ZM3.7 6.6 6.1 3.7h7.8l2.4 2.9',
      check: 'M4.7 10.4 8.2 13.9l7-8',
      chev: 'M8.1 4.7 13.3 10l-5.2 5.3',
      gear: 'M10 6.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6M10 2.7v1.9M10 15.4v1.9M2.7 10h1.9M15.4 10h1.9M4.9 4.9l1.3 1.3M13.8 13.8l1.3 1.3M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3',
      filter: 'M3.4 5.2h13.2l-5.1 6v5.1l-3-1.6v-3.5Z',
    }

    function Ico({ name, size = 14, className }) {
      const d = ICONS[name]
      if (d === undefined) return null
      // 全部图标都是描边几何：一套线宽、一套圆角，缩到 12px 也不会糊成块。
      return h('svg', {
        className: 'svo-ico' + (className === undefined ? '' : ' ' + className),
        width: size, height: size, viewBox: '0 0 20 20',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d }))
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    //
    // 全部走 --dsw-* 语义令牌；只读不写，暗色自动跟随。
    // 圆角与胶囊必须显式 corner-shape:round —— 宿主全局启用了 superellipse(1.5)。
    const CSS = `
.svo-root{
  --svo-ink:var(--dsw-alias-label-primary);
  --svo-ink-2:var(--dsw-alias-label-secondary);
  --svo-ink-3:var(--dsw-alias-label-tertiary);
  --svo-line:var(--dsw-alias-border-l1);
  --svo-line-2:var(--dsw-alias-border-l3);
  --svo-surface:var(--dsw-alias-bg-base);
  --svo-surface-2:var(--dsw-alias-bg-layer-2);
  --svo-blue:var(--dsw-alias-brand-primary,#006eff);
  --svo-run:#22c55e;
  --svo-mile:#38bdf8;
  --svo-fork:#f59e0b;
  --svo-dim:#a78bfa;
  --svo-alarm:#f43f5e;

  container-type:inline-size;
  display:flex;flex-direction:column;
  height:100%;min-height:0;
  font:var(--dsw-font-xs-13,13px/20px);
  color:var(--svo-ink);
  background:var(--svo-surface);
}

/* ── 顶栏 44px ── */
.svo-top{flex:none;display:flex;align-items:center;gap:10px;
  height:44px;padding:0 14px;
  border-bottom:1px solid var(--svo-line);background:var(--svo-surface-2)}
.svo-vico{display:inline-flex;align-items:center;color:var(--tone,var(--svo-run))}
.svo-vico.calm{--tone:var(--svo-run)}
.svo-vico.warn{--tone:var(--svo-fork)}
.svo-vico.ask{--tone:var(--svo-blue)}
.svo-vico.alarm{--tone:var(--svo-alarm)}
.svo-vico.hollow{--tone:var(--svo-ink-3)}
.svo-word{font-weight:600;font-size:14px;letter-spacing:-.01em}
.svo-tick{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;
  color:var(--svo-ink-2);background:var(--dsw-alias-bg-layer-2);
  border-radius:4px;padding:1px 6px}
.svo-crumb{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--svo-ink-2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.svo-crumb b{font-weight:600;color:var(--svo-ink)}
.svo-crumb .sep{width:3px;height:3px;border-radius:50%;corner-shape:round;
  background:var(--svo-ink-3);opacity:.6;flex:none}
.svo-sp{flex:1}
.svo-btn{display:inline-flex;align-items:center;gap:5px;
  height:24px;padding:0 9px;border-radius:4px;corner-shape:round;
  border:1px solid var(--svo-line-2);background:var(--svo-surface);
  font:inherit;font-size:11px;color:var(--svo-ink-2);cursor:pointer;
  transition:background .12s var(--ds-ease-in-out),border-color .12s var(--ds-ease-in-out)}
.svo-btn:hover{background:var(--dsw-alias-bg-hover);border-color:var(--svo-ink-3)}
.svo-btn:focus-visible{outline:2px solid var(--svo-blue);outline-offset:1px}
.svo-btn[disabled]{opacity:.5;cursor:default}

/* ── 主体两栏 ── */
.svo-body{flex:1;display:flex;min-height:0}
.svo-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}

/* 下划线 tab */
.svo-tabs{flex:none;display:flex;align-items:center;gap:0;
  padding:0 14px;border-bottom:1px solid var(--svo-line);overflow-x:auto}
.svo-tab{position:relative;display:inline-flex;align-items:center;gap:5px;
  height:34px;padding:0 10px;border:0;background:none;cursor:pointer;
  font:inherit;font-size:13px;color:var(--svo-ink-2);white-space:nowrap;
  transition:color .12s var(--ds-ease-in-out)}
.svo-tab:hover{color:var(--svo-ink)}
.svo-tab:focus-visible{outline:2px solid var(--svo-blue);outline-offset:-2px}
.svo-tab u{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:9px;
  text-decoration:none;color:var(--svo-ink-3)}
.svo-tab.on{color:var(--svo-ink);font-weight:500}
.svo-tab.on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;
  background:var(--svo-blue);border-radius:1px;corner-shape:round}
.svo-tab.on u{color:var(--svo-ink-2)}
.svo-tabs .sp{flex:1}
.svo-hint{font-size:11px;color:var(--svo-ink-3);white-space:nowrap;padding-left:10px}

/* 滚动区 */
.svo-scroll{flex:1;overflow-y:auto;padding:0 14px 28px;min-height:0}
.svo-scroll::-webkit-scrollbar{width:10px}
.svo-scroll::-webkit-scrollbar-thumb{background:var(--svo-line-2);border-radius:9px;
  corner-shape:round;border:3px solid var(--svo-surface)}

/* 轮次分节 */
.svo-turn{border-bottom:1px solid var(--svo-line)}
.svo-turn:last-child{border-bottom:0}
.svo-thead{display:flex;align-items:center;gap:8px;height:32px;width:100%;
  padding:0;border:0;background:none;text-align:left;cursor:pointer;font:inherit;
  border-radius:4px;corner-shape:round}
.svo-thead:hover{background:var(--dsw-alias-bg-hover)}
.svo-thead:focus-visible{outline:2px solid var(--svo-blue);outline-offset:-2px}
.svo-tnum{width:28px;flex:none;text-align:center;
  font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--svo-ink-2)}
.svo-tname{font-size:13px;font-weight:600;color:var(--svo-ink)}
.svo-twhen{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--svo-ink-3)}
.svo-thead .sp{flex:1}
.svo-tmeta{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--svo-ink-2)}
.svo-tmeta b{font-weight:600;color:var(--svo-ink)}
.svo-arrow{display:inline-flex;color:var(--svo-ink-3);transition:transform .12s var(--ds-ease-in-out)}
.svo-turn.on .svo-arrow{transform:rotate(90deg);color:var(--svo-blue)}
.svo-turn.on .svo-thead{background:color-mix(in srgb,var(--svo-blue) 7%,transparent);
  box-shadow:inset 2px 0 0 var(--svo-blue)}
.svo-turn.on .svo-tnum,.svo-turn.on .svo-tname{color:var(--svo-blue)}

/* 决策行 */
.svo-rows{position:relative;padding:2px 0 6px}
.svo-spine-line{position:absolute;left:13.5px;top:4px;bottom:10px;width:1px;background:var(--svo-line)}
.svo-row{display:flex;align-items:flex-start;min-height:24px;position:relative;
  border-radius:4px;corner-shape:round;cursor:default}
.svo-row:hover{background:var(--dsw-alias-bg-hover)}
.svo-row.can{cursor:pointer}
.svo-row:focus-visible{outline:2px solid var(--svo-blue);outline-offset:-2px}
.svo-rail{width:28px;flex:none;align-self:stretch;display:flex;justify-content:center;
  padding-top:3px;color:var(--tone,var(--svo-ink-3))}
.svo-rail .svo-ico{position:relative;z-index:1;background:var(--svo-surface);border-radius:50%;
  corner-shape:round}
.svo-row:hover .svo-rail .svo-ico{background:var(--dsw-alias-bg-hover)}
.svo-body-col{flex:1;min-width:0;padding:1px 4px 1px 0}
.svo-rtop{display:flex;align-items:baseline;gap:10px;min-height:20px}
.svo-rtime{width:34px;flex:none;font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:11px;color:var(--svo-ink-2)}
.svo-rtext{font-size:13px;line-height:20px;color:var(--svo-ink);min-width:0}
.svo-rsub{font-size:11px;line-height:18px;color:var(--svo-ink-2);margin-left:44px}
.svo-go{margin-left:auto;align-self:center;padding-right:4px;opacity:0;
  color:var(--svo-ink-3);transition:opacity .12s var(--ds-ease-in-out)}
.svo-row.can:hover .svo-go{opacity:1;color:var(--svo-blue)}

.svo-tag{display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 5px;
  margin-left:6px;border-radius:4px;corner-shape:round;font-size:9px;font-weight:500;
  vertical-align:1px}
.svo-tag.fork{color:#8a5c0f;background:color-mix(in srgb,var(--svo-fork) 16%,transparent)}
.svo-tag.dim{color:var(--svo-dim);background:color-mix(in srgb,var(--svo-dim) 16%,transparent)}

/* 岔路的两条路 */
.svo-pick{display:flex;gap:6px;margin:2px 0 4px 44px;flex-wrap:wrap}
.svo-opt{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;
  border-radius:4px;corner-shape:round;font-size:11px;max-width:100%}
.svo-opt span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.svo-opt b{font-size:9px;font-weight:600;opacity:.75;flex:none}
.svo-opt.take{background:color-mix(in srgb,var(--svo-blue) 10%,transparent);color:var(--svo-blue)}
.svo-opt.drop{background:var(--dsw-alias-bg-layer-2);color:var(--svo-ink-2);
  text-decoration:line-through;text-decoration-color:var(--svo-ink-3)}
.svo-opt.drop b{text-decoration:none;color:var(--svo-ink-3)}

/* 空闲分隔 */
.svo-idle{display:flex;align-items:center;gap:8px;height:24px;font-size:11px;color:var(--svo-ink-2)}
.svo-idle .g{width:28px;flex:none;align-self:stretch;display:flex;justify-content:center}
.svo-idle .g i{width:1px;height:100%;
  background:repeating-linear-gradient(var(--svo-ink-3) 0 3px,transparent 3px 7px);opacity:.5}
.svo-idle .f{flex:1;height:1px;
  background:repeating-linear-gradient(to right,var(--svo-ink-3) 0 3px,transparent 3px 7px);opacity:.45}
.svo-idle .lbl{display:inline-flex;align-items:center;gap:4px;flex:none}
.svo-more{margin:2px 0 4px 44px;font-size:11px;color:var(--svo-ink-2)}

/* ── 右栏 ── */
.svo-side{width:300px;flex:none;border-left:1px solid var(--svo-line);
  padding:12px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;
  background:var(--svo-surface)}
.svo-panel{border:1px solid var(--svo-line);border-radius:4px;corner-shape:round;
  padding:10px 12px}
.svo-phead{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.svo-phead .svo-ico{color:var(--svo-ink-3)}
.svo-phead h4{font-size:11px;font-weight:500;color:var(--svo-ink-2);margin:0}
.svo-phead .r{margin-left:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:9px;color:var(--svo-ink-3)}
.svo-goal{font-size:11px;line-height:18px;color:var(--svo-ink-2);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.svo-kv{display:flex;flex-direction:column}
.svo-krow{display:flex;align-items:center;height:20px;font-size:13px;color:var(--svo-ink-2)}
.svo-krow .v{margin-left:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:13px;color:var(--svo-ink)}
.svo-krow .u{font-size:9px;color:var(--svo-ink-3);margin-left:3px}
.svo-krow.warn .v{color:var(--svo-fork)}

/* 节奏条 */
.svo-chart{margin-top:8px;padding-top:8px;border-top:1px solid var(--svo-line)}
.svo-bars{display:flex;align-items:flex-end;gap:2px;height:52px;position:relative}
.svo-bars i{flex:1;min-width:2px;border-radius:1px 1px 0 0;corner-shape:round;
  background:var(--svo-blue);opacity:.9}
.svo-bars i.off{opacity:.14}
.svo-axis{display:flex;justify-content:space-between;margin-top:4px;
  font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:9px;color:var(--svo-ink-2)}
.svo-legend{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.svo-lg{display:inline-flex;align-items:center;gap:4px;font-size:9px;color:var(--svo-ink-2)}
.svo-lg i{width:6px;height:6px;border-radius:1px;corner-shape:round}

/* 工具分布 */
.svo-mix{display:flex;height:4px;border-radius:2px;corner-shape:round;overflow:hidden;margin-bottom:6px}
.svo-mix i{height:100%}
.svo-tool{display:flex;align-items:center;gap:6px;height:20px;font-size:13px;color:var(--svo-ink-2)}
.svo-tool .svo-ico{color:var(--svo-ink-3)}
.svo-tool .nm{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}
.svo-tool .v{margin-left:auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:11px;color:var(--svo-ink-3)}

/* 成本 */
.svo-cost{display:flex;align-items:baseline;gap:8px}
.svo-cost .big{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:19px;
  font-weight:600;color:var(--svo-ink)}
.svo-cost .sub{font-size:11px;color:var(--svo-ink-2);line-height:1.5}

/* 空态与错误 */
.svo-empty{font-size:13px;color:var(--svo-ink-2);padding:24px 0;max-width:46ch}
.svo-err{font-size:13px;color:var(--svo-ink-2);padding:24px 14px;max-width:46ch}

@media (prefers-reduced-motion:reduce){
  .svo-btn,.svo-tab,.svo-arrow,.svo-go{transition:none}
}
@container (max-width:820px){
  .svo-side{display:none}
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
            const error = new Error(result?.error?.message ?? 'rpc failed')
            error.code = result?.error?.code ?? 'unknown'
            throw error
          }
          return result.value
        })
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────

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

    /** 长跨度用「小时/天」，用在顶栏的面包屑里。 */
    function span(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const minutes = Math.round(ms / 60000)
      if (minutes < 60) return `${minutes} 分`
      const hours = minutes / 60
      if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时`
      return `${(hours / 24).toFixed(1)} 天`
    }

    function clock(at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 日期 + 时间，跨天时才显示日期。 */
    function stamp(at, withDate) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      return withDate ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : time
    }

    /**
     * 把节拍与决策点叠成节奏条。
     *
     * 每一格的厚度 = 那段时间里的动作数量。于是薄而长的一段空白就是「它停过」。
     * 数据源两个，权重不同：节拍是事实（一次动作 = 1），决策点是标注（+2）。
     */
    const BUCKETS = 48
    const BEAT_WEIGHT = 1
    const NOTE_WEIGHT = 2

    function bandOf(spine, beats, startedAt, now) {
      const cells = Array.from({ length: BUCKETS }, () => ({ count: 0, fork: false, callId: null, at: 0 }))
      const from = startedAt ?? now
      const spanMs = Math.max(1, now - from)
      const slotOf = (at) => {
        const ratio = (at - from) / spanMs
        if (!(ratio >= 0 && ratio <= 1.0001)) return -1
        return Math.min(BUCKETS - 1, Math.max(0, Math.floor(ratio * BUCKETS)))
      }
      for (const node of Array.isArray(spine) ? spine : []) {
        if (typeof node?.at !== 'number') continue
        const slot = slotOf(node.at)
        if (slot < 0) continue
        cells[slot].count += NOTE_WEIGHT
        if (node.kind === 'fork') cells[slot].fork = true
      }
      for (const beat of Array.isArray(beats) ? beats : []) {
        if (typeof beat?.t !== 'number') continue
        const slot = slotOf(beat.t)
        if (slot < 0) continue
        cells[slot].count += BEAT_WEIGHT
        if (typeof beat.c === 'string' && beat.c !== '') {
          cells[slot].callId = beat.c
          cells[slot].at = beat.t
        }
      }
      const max = Math.max(1, ...cells.map((cell) => cell.count))
      return cells.map((cell) => ({
        ...cell,
        height: cell.count === 0 ? 2 : 3 + (cell.count / max) * 45,
      }))
    }

    // ── 组装视图模型 ────────────────────────────────────────────────────────

    /**
     * 把快照折成界面要的形状：按轮分组、算出空闲间隔、挑出要显示的节点。
     *
     * 轮次从 spine 节点的 turn 字段来；没有 turn 的历史数据全归到第 0 组，
     * 这一组不显示轮次标题，只显示脊——旧日志也能用。
     */
    function buildModel(view) {
      const spine = Array.isArray(view.spine) ? view.spine : []
      const beats = Array.isArray(view.beats) ? view.beats : []
      const metrics = view.metrics ?? {}
      const stats = new Map((metrics.turn_stats ?? []).map((row) => [row.n, row]))

      const groups = new Map()
      for (const node of spine) {
        const n = typeof node.turn === 'number' ? node.turn : 0
        if (!groups.has(n)) groups.set(n, [])
        groups.get(n).push(node)
      }
      const turns = [...groups.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, nodes]) => {
          const sorted = nodes.slice().sort((a, b) => a.seq - b.seq)
          const timed = sorted.filter((node) => typeof node.at === 'number')
          const row = stats.get(n) ?? null
          return {
            n,
            nodes: sorted.slice(-24),
            hidden: Math.max(0, sorted.length - 24),
            start: timed.length > 0 ? timed[0].at : null,
            end: timed.length > 0 ? timed[timed.length - 1].at : null,
            forks: sorted.filter((node) => node.kind === 'fork').length,
            calls: row?.calls ?? null,
            fails: row?.fails ?? null,
            steps: row?.steps ?? null,
          }
        })

      // 空闲间隔：上一轮最后一个节点 → 这一轮第一个节点，超过 30 分钟才标。
      const idleBefore = {}
      for (let i = 1; i < turns.length; i += 1) {
        const prev = turns[i - 1]
        const here = turns[i]
        if (prev.end === null || here.start === null) continue
        const gap = here.start - prev.end
        if (gap > 30 * 60 * 1000) idleBefore[here.n] = gap
      }

      const totalTurns = turns.filter((turn) => turn.n > 0).length
      const totalCalls = typeof metrics.calls === 'number'
        ? metrics.calls
        : turns.reduce((sum, turn) => sum + (turn.calls ?? 0), 0)
      return {
        turns,
        idleBefore,
        totalTurns,
        totalCalls,
        startedAt: view.startedAt ?? (view.at - view.totalMs),
        now: view.at,
        forks: spine.filter((node) => node.kind === 'fork').length,
        notes: spine.length,
      }
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    function TopBar({ verdict, model, mode, busy, onToggleMode }) {
      const idle = verdict.ended && verdict.state === 'running'
      const spec = idle ? IDLE : (VERDICT[verdict.state] ?? VERDICT.running)
      const tick = verdict.elapsedMs == null ? '' : duration(verdict.elapsedMs)
      const turnLabel = model.totalTurns > 0 ? `第 ${model.totalTurns} 轮` : '会话'
      return h('div', { className: 'svo-top' },
        h('span', { className: 'svo-vico ' + spec.tone }, h(Ico, { name: spec.icon, size: 16 })),
        h('span', { className: 'svo-word' }, spec.word),
        tick === '' ? null : h('span', { className: 'svo-tick' }, tick),
        h('span', { className: 'svo-crumb' },
          h('span', null, turnLabel),
          h('span', { className: 'sep' }),
          h('span', null, '累计 ', h('b', null, span(verdict.totalMs)))),
        h('span', { className: 'svo-sp' }),
        mode === null || mode === 'ask'
          ? null
          : h('button', {
            className: 'svo-btn',
            onClick: onToggleMode,
            disabled: busy,
            title: mode === 'smart' ? '现在会额外调用一个模型' : '现在只靠规则，不花钱',
          },
            h(Ico, { name: mode === 'smart' ? 'gear' : 'filter', size: 12 }),
            mode === 'smart' ? '规则 + 旁路模型' : '只用规则'))
    }

    function Tabs({ model, selected, onSelect }) {
      const total = model.totalCalls
      return h('div', { className: 'svo-tabs', role: 'tablist' },
        h('button', {
          className: 'svo-tab' + (selected === null ? ' on' : ''),
          role: 'tab', 'aria-selected': selected === null,
          onClick: () => onSelect(null),
        }, h(Ico, { name: 'filter', size: 12 }), h('span', null, '全部'),
          total > 0 ? h('u', null, String(total)) : null),
        model.turns.filter((turn) => turn.n > 0).map((turn) => h('button', {
          key: String(turn.n),
          className: 'svo-tab' + (selected === turn.n ? ' on' : ''),
          role: 'tab', 'aria-selected': selected === turn.n,
          onClick: () => onSelect(selected === turn.n ? null : turn.n),
        }, h('span', null, '第 ' + turn.n + ' 轮'),
          turn.calls === null ? null : h('u', null, String(turn.calls)))),
        h('span', { className: 'sp' }),
        h('span', { className: 'svo-hint' },
          model.notes + ' 个决策点' + (model.forks > 0 ? ' · ' + model.forks + ' 处岔路' : '')))
    }

    /** 一个决策点。岔路会把「选了哪条 / 弃了哪条」画出来。 */
    function NodeRow({ node, onOpen }) {
      const tone = node.kind === 'fork' ? 'var(--svo-fork)'
        : node.kind === 'dim' ? 'var(--svo-dim)' : 'var(--svo-blue)'
      const can = typeof node.callId === 'string' && node.callId !== ''
      const fork = node.fork ?? null
      return h('div', {
        className: 'svo-row' + (can ? ' can' : ''),
        style: { '--tone': tone },
        tabIndex: can ? 0 : -1,
        role: can ? 'button' : undefined,
        onClick: can ? () => onOpen(node.callId) : undefined,
        onKeyDown: can ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen(node.callId)
          }
        } : undefined,
      },
        h('span', { className: 'svo-rail' },
          h(Ico, { name: node.kind === 'fork' ? 'branch' : node.kind === 'dim' ? 'info' : 'dot', size: 13 })),
        h('div', { className: 'svo-body-col' },
          h('div', { className: 'svo-rtop' },
            h('span', { className: 'svo-rtime' }, typeof node.at === 'number' ? clock(node.at) : ''),
            h('span', { className: 'svo-rtext' }, node.text,
              node.kind === 'fork' ? h('span', { className: 'svo-tag fork' }, '岔路') : null,
              node.kind === 'dim' ? h('span', { className: 'svo-tag dim' }, '低置信') : null)),
          fork !== null && (fork.chosen || fork.alternatives?.length)
            ? h('div', { className: 'svo-pick' },
              h('span', { className: 'svo-opt take' }, h('b', null, '选'),
                h('span', null, String(fork.chosen ?? '—'))),
              Array.isArray(fork.alternatives) && fork.alternatives.length > 0
                ? h('span', { className: 'svo-opt drop' }, h('b', null, '弃'),
                  h('span', null, String(fork.alternatives[0])))
                : null)
            : node.because
              ? h('div', { className: 'svo-rsub' }, node.because)
              : null),
        can ? h('span', { className: 'svo-go' }, h(Ico, { name: 'chev', size: 12 })) : null)
    }

    function TurnSection({ turn, idleBefore, selected, onSelect, onOpen }) {
      const on = selected === turn.n
      const head = turn.n > 0
        ? h('button', {
          className: 'svo-thead',
          onClick: () => onSelect(on ? null : turn.n),
          'aria-expanded': on,
        },
          h('span', { className: 'svo-tnum' }, String(turn.n)),
          h('span', { className: 'svo-tname' }, '第 ' + turn.n + ' 轮'),
          turn.start === null ? null : h('span', { className: 'svo-twhen' },
            stamp(turn.start, true) +
            (turn.end === null || turn.end === turn.start ? '' : ' → ' + stamp(turn.end, true))),
          h('span', { className: 'sp' }),
          h('span', { className: 'svo-tmeta' },
            turn.forks > 0 ? h('span', null, turn.forks + ' 岔路') : null,
            turn.calls === null ? null : h('span', null, h('b', null, String(turn.calls)), ' 次调用'),
            turn.fails === null || turn.fails === 0 ? null : h('span', null, h('b', null, String(turn.fails)), ' 失败')),
          h('span', { className: 'svo-arrow' }, h(Ico, { name: 'chev', size: 12 })))
        : null

      return h('section', { className: 'svo-turn' + (on ? ' on' : ''), 'data-turn': turn.n },
        idleBefore === undefined ? null : h('div', { className: 'svo-idle' },
          h('span', { className: 'g' }, h('i', null)),
          h('span', { className: 'f' }),
          h('span', { className: 'lbl' }, h(Ico, { name: 'clock', size: 12 }), '空闲 ' + span(idleBefore)),
          h('span', { className: 'f' })),
        head,
        h('div', { className: 'svo-rows' },
          h('i', { className: 'svo-spine-line' }),
          turn.nodes.map((node) => h(NodeRow, { key: String(node.seq), node, onOpen })),
          turn.hidden > 0 ? h('div', { className: 'svo-more' }, '还有 ' + turn.hidden + ' 个更早的决策点') : null))
    }

    function SidePanel({ icon, title, right, children }) {
      return h('div', { className: 'svo-panel' },
        h('div', { className: 'svo-phead' },
          h(Ico, { name: icon, size: 12 }),
          h('h4', null, title),
          right === null || right === undefined ? null : h('span', { className: 'r' }, right)),
        children)
    }

    function Side({ view, model, selected, onSelect }) {
      const metrics = view.metrics ?? {}
      const turn = selected === null ? null : model.turns.find((row) => row.n === selected) ?? null
      const calls = turn?.calls ?? metrics.calls ?? 0
      const fails = turn?.fails ?? null
      const failRate = turn === null
        ? (metrics.tool_fail_rate ?? 0)
        : (turn.fails !== null && turn.calls > 0 ? turn.fails / turn.calls : 0)
      const repeat = metrics.repeat_rate ?? 0
      const band = bandOf(view.spine, view.beats, model.startedAt, model.now)
      const mixTotal = (metrics.tool_mix ?? []).reduce((sum, row) => sum + row[1], 0) || 1
      const usage = view.usage ?? {}
      const tokens = usage.tokens?.total ?? usage.tokens ?? 0
      const colors = ['var(--svo-blue)', 'var(--svo-dim)', 'var(--svo-mile)', 'var(--svo-fork)', 'var(--svo-ink-3)']

      const mixRows = (metrics.tool_mix ?? []).length === 0
        ? null
        : [
          h('div', { className: 'svo-mix', key: 'mix' },
            metrics.tool_mix.map(([name, count], index) => h('i', {
              key: name,
              style: { width: (count / mixTotal * 100) + '%', background: colors[index % colors.length] },
            }))),
          ...metrics.tool_mix.map(([name, count]) => h('div', { key: name, className: 'svo-tool' },
            h(Ico, { name: 'screen', size: 12 }),
            h('span', { className: 'nm' }, name),
            h('span', { className: 'v' }, Math.round(count / mixTotal * 100) + '%'))),
        ]

      return h('aside', { className: 'svo-side' },
        h(SidePanel, { icon: 'gauge', title: '会话目标', right: turn === null ? null : '第 ' + turn.n + ' 轮' },
          h('p', { className: 'svo-goal' }, view.goal ?? '（宿主没有给出目标）')),

        h(SidePanel, {
          icon: 'clipboard',
          title: turn === null ? '会话合计' : '第 ' + turn.n + ' 轮',
          right: turn === null ? '' : '',
        },
          h('div', { className: 'svo-kv' },
            h('div', { className: 'svo-krow' }, h('span', null, '工具调用'),
              h('span', { className: 'v' }, String(calls), h('span', { className: 'u' }, '次'))),
            h('div', { className: 'svo-krow' }, h('span', null, '步数'),
              h('span', { className: 'v' },
                String(turn?.steps ?? metrics.steps ?? 0), h('span', { className: 'u' }, '步'))),
            h('div', { className: 'svo-krow' + (failRate >= 0.15 ? ' warn' : '') },
              h('span', null, '失败率'),
              h('span', { className: 'v' }, (Math.round(failRate * 1000) / 10).toString(),
                h('span', { className: 'u' }, '%'))),
            h('div', { className: 'svo-krow' + (repeat >= 0.4 ? ' warn' : '') },
              h('span', null, '重复率'),
              h('span', { className: 'v' }, String(Math.round(repeat * 100)),
                h('span', { className: 'u' }, '%')))),
          h('div', { className: 'svo-chart' },
            h('div', { className: 'svo-bars' },
              band.map((cell, index) => h('i', {
                key: String(index),
                style: { height: cell.height + 'px' },
                title: cell.count === 0 ? '无动作' : cell.count + ' 个动作',
              }))),
            h('div', { className: 'svo-axis' },
              h('span', null, '开头'),
              h('span', null, '密度 = 动作数'),
              h('span', null, '现在')))),

        mixRows === null ? null : h(SidePanel, {
          icon: 'box',
          title: '工具分布',
          right: String(metrics.calls ?? 0) + ' 次',
        }, mixRows),

        h(SidePanel, {
          icon: 'ledger',
          title: '成本',
          right: view.mode === 'smart' ? '旁路模型' : '规则分析',
        },
          h('div', { className: 'svo-cost' },
            h('span', { className: 'big' }, view.mode === 'smart' ? `¥${(usage.cost ?? 0).toFixed(2)}` : '¥0'),
            h('span', { className: 'sub' },
              view.mode === 'smart'
                ? `已调用 ${usage.annotations ?? 0} 次 · ${tokens} token`
                : '不调用模型 · 0 token'))))
    }

    // ── 视图 ────────────────────────────────────────────────────────────────

    function View({ sessionId, call, openView }) {
      const [view, setView] = React.useState(null)
      const [failed, setFailed] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [mode, setMode] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const scrollRef = React.useRef(null)
      const stickRef = React.useRef(true)

      React.useEffect(() => {
        let live = true
        let timer = null
        let interval = 2500
        const tick = async () => {
          try {
            const next = await call('snapshot', sessionId ? { sessionId } : {})
            if (!live) return
            setView(next)
            setFailed(null)
            const abnormal = next?.verdict?.state !== 'running' || next?.verdict?.state === 'waiting'
            interval = abnormal ? 1200 : 2500
          } catch (error) {
            if (!live) return
            setFailed(error?.code === 'no-session' ? 'no-session' : 'transport')
            interval = 5000
          }
          timer = setTimeout(tick, interval)
        }
        tick()
        return () => { live = false; if (timer !== null) clearTimeout(timer) }
      }, [sessionId, call])

      React.useEffect(() => {
        if (view === null) return
        if (mode === null) {
          let saved = null
          try { saved = window.localStorage.getItem('dsh-session-observer/mode') } catch { /* 隐私模式 */ }
          setMode(saved === 'smart' || saved === 'free' ? saved : 'ask')
          return
        }
        if (mode === 'ask') return
        if (view.mode === 'smart' || view.mode === 'free') setMode(view.mode)
      }, [view, mode])

      // 贴底跟随：用户往上翻的时候不要抢滚动。
      React.useEffect(() => {
        const el = scrollRef.current
        if (el === null || stickRef.current !== true) return
        el.scrollTop = el.scrollHeight
      }, [view])

      const choose = (value) => {
        setMode(value)
        try { window.localStorage.setItem('dsh-session-observer/mode', value) } catch { /* 隐私模式 */ }
        setBusy(true)
        void call('config', { patch: { mode: value } }).catch(() => {}).finally(() => setBusy(false))
      }

      if (failed !== null && view === null) {
        return h('div', { className: 'svo-root' },
          h('div', { className: 'svo-err' },
            failed === 'no-session'
              ? '这个会话还没载入，换进来一下就好。'
              : '观察未接通。这不影响会话本身。'))
      }
      if (view === null) return h('div', { className: 'svo-root' })

      const verdict = view.verdict ?? { state: 'running', since: null, reason: null }
      const ended = view.ended === true
      const model = buildModel(view)
      const cold = (view.baseline?.samples ?? 0) < 20

      if (mode === 'ask') {
        return h('div', { className: 'svo-root' },
          h(TopBar, { verdict: { ...verdict, ended, totalMs: view.totalMs }, model, mode, busy, onToggleMode: () => {} }),
          h('div', { className: 'svo-err' },
            h('p', null, '这个视图能纯靠规则判断它卡没卡住，一分钱不花。'),
            h('p', { style: { marginTop: 6 } },
              '也可以让另一个模型跟着看，多说一句话——按量计费。'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
              h('button', { className: 'svo-btn', disabled: busy, onClick: () => choose('free') }, '先不用，只看卡没卡'),
              h('button', { className: 'svo-btn', disabled: busy, onClick: () => choose('smart') }, '让它多说一句'))))
      }

      const empty = model.turns.length === 0
      const onOpen = (callId) => {
        if (typeof openView === 'function') openView('trajectory', callId)
      }

      return h('div', { className: 'svo-root' },
        h(TopBar, {
          verdict: { ...verdict, ended, totalMs: view.totalMs, elapsedMs: view.elapsedMs },
          model, mode, busy,
          onToggleMode: () => choose(mode === 'smart' ? 'free' : 'smart'),
        }),
        h('div', { className: 'svo-body' },
          h('div', { className: 'svo-main' },
            h(Tabs, { model, selected, onSelect: setSelected }),
            h('div', {
              className: 'svo-scroll',
              ref: scrollRef,
              onScroll: (event) => {
                const el = event.currentTarget
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              },
            },
              empty
                ? h('div', { className: 'svo-empty' },
                  cold || ended
                    ? '还没有可观察的动作。它一动，这里就会长出行来。'
                    : '这个会话刚开，还没有可观察的动作。')
                : model.turns
                  .filter((turn) => selected === null || turn.n === selected || turn.n === 0)
                  .map((turn) => h(TurnSection, {
                    key: String(turn.n),
                    turn,
                    idleBefore: model.idleBefore[turn.n],
                    selected,
                    onSelect: setSelected,
                    onOpen,
                  })))),
          h(Side, { view, model, selected, onSelect: setSelected })))
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    const inject = ['slots', 'connection']

    function apply(ctx) {
      ensureCss()
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'observer',
        order: 20,
        label: () => '观察',
        inject: (sessionId) => ({
          sessionId,
          call: (endpoint, payload) => rpc(ctx, endpoint, payload),
        }),
      }, View))
    }

    return {
      inject,
      apply,
      __internals: { bandOf, BUCKETS, buildModel },
    }
  },
})
