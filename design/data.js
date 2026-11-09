/* 公开演示数据（合成，不含任何真实会话内容）
   一场虚构的编程会话：给 markdown 编辑器加自动保存 */
window.OBS = {
  verdict: { word: '运行中', tick: '12 分' },
  headline: { turns: 4, current: 4, activeMin: 41, span: '2 天', events: 812, notes: 31, forks: 5, range: '周一 → 周二' },
  idleBefore: { 2: '6.2 小时', 3: '1.1 小时', 4: '9.4 小时' },
  /* 有效时间轴上的密度（48 格） */
  rhythm: [2,1,1,6,4,3,2,5,3,2,1,1,4,3,2,2,1,1,3,2,2,1,1,2,3,2,2,1,4,3,2,1,1,2,2,3,2,1,1,2,3,4,2,1,2,3,2,1],
  total: { steps: 236, calls: 248, fails: 2, repeats: 96, notes: 31, forks: 5,
    tools: [['bash', 132], ['edit', 61], ['read', 34], ['write', 15], ['grep', 6]] },
  turns: [
    { n: 1, state: 'done', start: '周一 09:12', end: '周一 15:30', span: '6.2 小时', active: 24,
      events: 486, steps: 141, calls: 148, fails: 1, repeats: 61, notes: 18, forks: 3,
      tools: [['bash', 74], ['edit', 42], ['read', 22], ['grep', 6], ['write', 4]],
      sum: '给 markdown 编辑器加自动保存，草稿要能恢复',
      nodes: [
        { t: '09:12', k: 'mile', text: '通读编辑器的保存链路', sub: '入口是 Editor 组件的 onChange' },
        { t: '09:26', k: 'mile', text: '确认草稿存储位置', sub: 'localStorage 与 IndexedDB 各有取舍' },
        { t: '09:48', k: 'fork', text: '选定草稿落盘方案', sub: '大文档要能存下，又要能同步读',
          chosen: 'IndexedDB 按文档 id 分片', alt: 'localStorage 全量字符串' },
        { t: '10:31', k: 'fork', text: '防抖间隔定多少', sub: '太短写放大，太长丢字多',
          chosen: '800ms 防抖 + 失焦立即写', alt: '固定 2s 定时写' },
        { t: '11:05', k: 'fork', text: '恢复时如何提示用户', sub: '静默恢复会让人以为内容没变',
          chosen: '顶部横幅提示「已恢复草稿」', alt: '直接覆盖当前内容' }
      ], more: 13 },
    { n: 2, state: 'done', start: '周一 15:30', end: '周一 16:36', span: '1.1 小时', active: 5,
      events: 148, steps: 34, calls: 36, fails: 1, repeats: 12, notes: 6, forks: 2,
      tools: [['bash', 18], ['edit', 11], ['read', 6], ['write', 1]],
      sum: '两个标签页同时编辑同一篇会互相覆盖吗',
      nodes: [
        { t: '15:32', k: 'fork', text: '多标签页冲突怎么处理', sub: '用户实测发现内容被覆盖',
          chosen: 'BroadcastChannel 广播版本号', alt: '只在写入前比对时间戳' },
        { t: '15:51', k: 'fork', text: '冲突后保留谁的版本',
          chosen: '两份都留，弹出对比选择', alt: '后写覆盖先写' },
        { t: '16:10', k: 'dim', text: '怀疑是防抖导致的重复写入', sub: '日志样本太少，未确认' }
      ], more: 3 },
    { n: 3, state: 'done', start: '周二 08:40', end: '周二 09:52', span: '1.2 小时', active: 8,
      events: 121, steps: 41, calls: 44, fails: 0, repeats: 15, notes: 5, forks: 0,
      tools: [['bash', 26], ['edit', 8], ['read', 6], ['write', 4]],
      sum: '补自动化测试，覆盖断网与恢复两条路径',
      nodes: [
        { t: '08:41', k: 'mile', text: '把存储层抽成接口，方便注入假实现', sub: '先解耦再写测试' },
        { t: '09:03', k: 'mile', text: '断网用例：写入失败后重试三次' },
        { t: '09:30', k: 'mile', text: '恢复用例：草稿比正文新时弹横幅', sub: '断言横幅文案与按钮' }
      ], more: 1 },
    { n: 4, state: 'live', start: '周二 09:52', end: '进行中', span: '12 分', active: 4,
      events: 57, steps: 9, calls: 12, fails: 0, repeats: 4, notes: 2, forks: 0,
      tools: [['bash', 8], ['edit', 3], ['read', 1]],
      sum: '把自动保存的间隔做成可配置项，放在设置页',
      nodes: [
        { t: '09:52', k: 'mile', text: '查设置页的注册方式', sub: '设置项要跟随文档级配置' },
        { t: '09:57', k: 'mile', text: '把 800ms 常量提成配置读取', live: true }
      ], more: 0 }
  ]
};
