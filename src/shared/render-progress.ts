// ── 渲染/计算小进度条弹窗 ──────────────────────────────────────
// 供第 2 / 3 / 5 页在「进入页面」或「重建（重排版 / 重算连线 / 重渲染 3D）」时
// 弹出一个紧凑的小卡片，展示当前阶段文案 + 进度条，完成后自动淡出。
//
// 用法：
//   const prog = createRenderProgress()
//   prog.show('正在加载乐谱…')
//   prog.set(0.3, '正在排版…')
//   prog.set(0.7, '正在构建场景…')
//   prog.done()
//
// 设计要点：
//   · 顶栏下方居中，不挡操作（pointer-events:none），层级在顶栏之上但低于模态框
//   · 进度可由调用方按阶段推进；若调用方只调 show/done，内部会用平滑推进兜底，
//     避免长同步任务时进度条看起来「卡死」
//   · 多次 show 复用同一实例，避免重复插入 DOM

let instance: RenderProgress | null = null

export interface RenderProgress {
  show(label?: string): void
  /** fraction ∈ [0,1]；传 label 同时更新阶段文案 */
  set(fraction: number, label?: string): void
  /** 推到 100% 并在短暂延迟后淡出 */
  done(label?: string): void
}

export function createRenderProgress(): RenderProgress {
  if (instance) return instance

  const wrap = document.createElement('div')
  wrap.className = 'rp-wrap'
  wrap.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:calc(var(--sh-topbar-h, 52px) + 14px)',
    'transform:translateX(-50%) translateY(-8px)',
    'z-index:60',
    'min-width:240px',
    'max-width:min(420px, calc(100vw - 32px))',
    'padding:10px 14px 12px',
    'border-radius:12px',
    'border:1px solid var(--sh-border)',
    'background:color-mix(in srgb, var(--sh-surface) 92%, transparent)',
    'backdrop-filter:blur(12px)',
    'box-shadow:0 10px 30px rgba(0,0,0,0.18)',
    'color:var(--sh-text)',
    'font-size:12.5px',
    'opacity:0',
    'pointer-events:none',
    'transition:opacity 0.25s ease, transform 0.25s ease',
  ].join(';')

  const label = document.createElement('div')
  label.className = 'rp-label'
  label.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:7px;color:var(--sh-text);font-weight:600'

  const spinner = document.createElement('span')
  spinner.style.cssText =
    'width:13px;height:13px;border-radius:50%;border:2px solid var(--sh-border-strong);border-top-color:var(--sh-accent);animation:rp-spin 0.8s linear infinite;flex:none'
  const labelText = document.createElement('span')
  label.append(spinner, labelText)

  const track = document.createElement('div')
  track.style.cssText =
    'height:4px;border-radius:999px;background:var(--sh-border-strong);overflow:hidden'
  const bar = document.createElement('div')
  bar.style.cssText =
    'height:100%;width:0%;border-radius:999px;background:var(--sh-accent);transition:width 0.35s cubic-bezier(0.4,0,0.2,1)'
  track.appendChild(bar)

  wrap.append(label, track)
  document.body.appendChild(wrap)

  // 兜底动画：若外部长时间不更新进度，让进度条缓慢前推（但永远到不了 100%）
  let ticker = 0
  let externalFraction = 0
  let smoothFraction = 0
  let visible = false
  let doneTimer: ReturnType<typeof setTimeout> | null = null

  function tick(): void {
    if (!visible) return
    ticker++
    // 向 externalFraction 靠拢；同时若 external 没动，小幅自推
    const target = Math.min(0.96, externalFraction + (1 - externalFraction) * 0.012)
    smoothFraction += (target - smoothFraction) * 0.18
    bar.style.width = `${Math.round(smoothFraction * 100)}%`
    requestAnimationFrame(tick)
  }

  function show(lbl?: string): void {
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null }
    externalFraction = 0
    smoothFraction = 0
    bar.style.width = '0%'
    bar.style.transition = 'none'
    // 强制 reflow 后恢复过渡
    void bar.offsetWidth
    bar.style.transition = ''
    if (lbl) labelText.textContent = lbl
    wrap.style.opacity = '1'
    wrap.style.transform = 'translateX(-50%) translateY(0)'
    visible = true
    requestAnimationFrame(tick)
  }

  function set(fraction: number, lbl?: string): void {
    externalFraction = Math.max(0, Math.min(1, fraction))
    if (lbl) labelText.textContent = lbl
  }

  function done(lbl?: string): void {
    externalFraction = 1
    smoothFraction = 1
    bar.style.width = '100%'
    if (lbl) labelText.textContent = lbl
    spinner.style.animation = 'none'
    spinner.style.borderColor = 'var(--sh-accent)'
    doneTimer = setTimeout(() => {
      visible = false
      wrap.style.opacity = '0'
      wrap.style.transform = 'translateX(-50%) translateY(-8px)'
      // 复位，便于下次 show 时从 0 开始
      externalFraction = 0
      smoothFraction = 0
      bar.style.width = '0%'
      spinner.style.animation = ''
      spinner.style.borderColor = ''
    }, 450)
  }

  // 注入旋转动画（仅一次）
  if (!document.getElementById('rp-style')) {
    const style = document.createElement('style')
    style.id = 'rp-style'
    style.textContent = '@keyframes rp-spin{to{transform:rotate(360deg)}}'
    document.head.appendChild(style)
  }

  instance = { show, set, done }
  return instance
}
