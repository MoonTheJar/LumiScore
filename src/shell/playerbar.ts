// 播放悬浮条：一行排开（宽度不够自动折行），2D / 3D 两页共用。
//
// 从左到右：
//  1 六点把手（移动悬浮窗，悬停提示可拖动）
//  2 图钉（点击变色并向左倾斜 15°，钉住后窗口不可拖）
//  3 后退 N 秒       4 播放/暂停（悬停提示相反状态）   5 前进 N 秒
//     （N = 设置 ▾ → 跳转步长，0～12 秒，默认 10；N=0 时这两个按钮收掉）
//  6 当前时间（悬停显示 当前/总时长）  7 进度条（拖动气泡显示 新时间/总时长）
//  8 音量图标（点击静音/恢复）        9 音量滑杆（悬停/拖动气泡 音量-xx%）
// 10 速度文字按钮（点击循环切换）
// 11 左右箭头图标（悬停提示同 12）    12 缩放滑杆（2D：谱面宽度；3D：小球拖尾长度）
// 13 ×（点击收成一个图标）

import { createFloatingWindow, setPlayingProbe } from './floating'
import type { ShellHandle } from './shell'
import { onLocaleChange, t } from './i18n'
import { bindTip, bindRangeTip } from './tooltip'
import { getNudgeSec, onAudioPrefChange } from '../shared/audio-prefs'
import type { MideePlayer } from '../3dpreview/player'
import { fmtTime } from '../3dpreview/player'

export interface PlayerBarZoom {
  min: number
  max: number
  step?: number
  /** 当前百分比 */
  value(): number
  /** 外部（如菜单滑杆）改动后，拖条同步 */
  apply(pct: number): void
  /** 悬停/拖动气泡文本，例如「宽度-100%」「拖尾-100%」 */
  title(pct: number): string
}

export interface PlayerBarOptions {
  storageKey: string
  /** 播放器可能延迟创建，故用取值函数 */
  getPlayer(): MideePlayer | null
  /** 点击播放/暂停：由页面负责懒加载播放器与播放前后的业务（如 3D 球复位） */
  togglePlay(): void | Promise<void>
  /** 第 12 项滑杆的含义由页面定义；不传则隐藏缩放滑杆（如连线页，排版已在第 2 步锁定） */
  zoom?: PlayerBarZoom
  /**
   * 自定义播放时间线（含首尾偏移等）：提供后进度条按 0..1 映射到该时间线，
   * 「后退 / 前进 N 秒」（N 取设置里的跳转步长）与拖动都交给页面定位；
   * 气泡/总时长也用 setProgress 传入的完整时长。
   * 不传则直接操作播放器的音乐时间（2D/3D 页）。
   */
  seekFrac?(frac: number): void
  nudge?(deltaSec: number): void
  /** 折叠气泡图标内容（默认品牌 logo） */
  reopenHTML?: string
  /** 传入外壳句柄后，播放条额外获得「顶栏迷你播放控件」这一形态（六点 + 播放/暂停 + 秒数 + ∨），
   *  与悬浮播放条二选一；不传则维持只有悬浮条。 */
  shell?: ShellHandle
  /**
   * 竖屏底栏第二行居中的页面按钮：第三页「路径」、第五页「场景设置」。
   * disabled 置真的按钮呈灰态只做占位（如第二页「添加」的开发中标记）。
   * 步数标识不在这——统一放顶栏（shell.ts 的 .sh-pagecount）。
   */
  action?: { label(): string; run(): void; disabled?(): boolean }
}

export interface PlayerBarHandle {
  /** RAF 进度回调：刷新时间与进度条 */
  setProgress(cur: number, dur: number): void
  /** 播放/暂停状态变化时刷新按钮图标与悬停提示 */
  setPlaying(playing: boolean): void
  /** 播放结束 */
  setEnded(dur: number): void
  /** 外部改变缩放后同步滑杆 */
  refreshZoom(): void
  /** 播放器加载完成后，把持久化的音量/速度灌进去 */
  attachPlayer(): void
}

const SPEEDS = [0.5, 0.75, 1, 1.5, 2]

// 顶栏迷你控件用「线框」播放/暂停：顶栏那些按钮本来就是描边风格，
// 用播放条那种实心三角会在一条功能区里跳出两块黑。
const MINI_SVG = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.4 5.5v13M15.6 5.5v13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  caret: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // 顶栏图标位（缩成悬浮小图标时也是这枚）
  icon: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" draggable="false"><path d="M8 5.5v13l11-6.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
}

// ── 图标（进退按钮不带数字，10 秒只写在悬停提示里） ─────────────
const SVG = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.6L5.2 9l5.8 4.4v-3A5.6 5.6 0 1 1 5.4 16H3.4a7.6 7.6 0 1 0 7.6-9z" fill="currentColor" stroke="none"/><path d="M5.2 4.6v3.4" /></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4.6L18.8 9 13 13.4V10a5.6 5.6 0 1 0 5.6 6h2A7.6 7.6 0 1 1 13 7z" fill="currentColor" stroke="none"/><path d="M18.8 4.6V8" /></svg>',
  arrows:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8L3 12l4 4M17 8l4 4-4 4M3 12h18"/></svg>',
}

function speakerSvg(level: 'mute' | 'low' | 'high'): string {
  const waves =
    level === 'mute'
      ? '<path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
      : level === 'low'
        ? '<path d="M16.5 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
        : '<path d="M16 8.6a5 5 0 0 1 0 6.8M18.4 6.4a8.4 8.4 0 0 1 0 11.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.2v5.6h3.8L13 19V5L7.8 9.2H4z"/>${waves}</svg>`
}

export function createPlayerBar(opts: PlayerBarOptions): PlayerBarHandle {
  // ── 行内容（挂进悬浮窗） ───────────────────────────────────
  const host = document.createElement('div')
  host.className = 'sh-pb'
  const row = document.createElement('div')
  row.className = 'sh-pb__row'

  // 竖屏/超宽把播放条停靠底部（非可拖悬浮窗）时不受闲置自动隐藏影响
  const dockedMq = matchMedia('(max-aspect-ratio: 1/1), (min-aspect-ratio: 2/1)')
  const win = createFloatingWindow({
    storageKey: opts.storageKey,
    host,
    ariaLabel: t('player.title'),
    reopenLabel: () => t('player.title'),
    // 折叠后的 reopen 气泡用向右播放三角（与场景设置窗的立方体区分，一眼认出是播放器）；
    // 不沿用外壳默认的品牌 logo
    reopenHTML:
      opts.reopenHTML ??
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" draggable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    autoHide: { isPlaying: () => !dockedMq.matches && opts.getPlayer()?.playing === true },
  })
  // 顶栏拖下来的那些悬浮窗也要「播放中闲置自动隐藏」，但它们拿不到播放器实例：
  // 由播放条把这个口径挂到浮层模块上，一处判定、各窗共用。
  setPlayingProbe(() => opts.getPlayer()?.playing === true)

  // ── 3 后退 / 5 前进 / 4 播放 ───────────────────────────────
  // 这几个按钮只有 SVG 内芯，没有任何文字：bindTip 的气泡在触屏上本来就不弹
  // （见 tooltip.ts），读屏更是完全读不出「这是什么按钮」，所以 aria-label 必须单独给。
  const backBtn = document.createElement('button')
  backBtn.type = 'button'
  backBtn.className = 'sh-pb__icon'
  backBtn.innerHTML = SVG.back
  // 步长不写死：文案与 aria 都现读设置里的「跳转步长」（见下面 paintNudge）
  bindTip(backBtn, () => t('player.backN', { n: getNudgeSec() }))

  const playBtn = document.createElement('button')
  playBtn.type = 'button'
  playBtn.className = 'sh-pb__icon sh-pb__play'
  playBtn.innerHTML = SVG.play

  const fwdBtn = document.createElement('button')
  fwdBtn.type = 'button'
  fwdBtn.className = 'sh-pb__icon'
  fwdBtn.innerHTML = SVG.fwd
  bindTip(fwdBtn, () => t('player.forwardN', { n: getNudgeSec() }))

  // ── 6 时间 / 7 进度 ────────────────────────────────────────
  const timeEl = document.createElement('span')
  timeEl.className = 'sh-pb__time'
  timeEl.textContent = '0:00'

  const seek = document.createElement('input')
  seek.type = 'range'
  seek.className = 'sh-pb__seek'
  seek.min = '0'
  seek.max = '1000'
  seek.value = '0'
  seek.setAttribute('aria-label', t('player.seek'))
  let seeking = false
  let curTime = 0
  let totalTime = 0
  seek.addEventListener('pointerdown', () => {
    seeking = true
  })
  window.addEventListener('pointerup', () => {
    seeking = false
  })

  // ── 8 音量图标 / 9 音量滑杆 ────────────────────────────────
  const volBtn = document.createElement('button')
  volBtn.type = 'button'
  // sh-pb__vol：竖屏要把音量从「图标一律隐藏」的规则里单独捞回到底栏第二行右侧
  volBtn.className = 'sh-pb__icon sh-pb__vol'

  const vol = document.createElement('input')
  vol.type = 'range'
  vol.className = 'sh-pb__mini-range'
  vol.min = '0'
  vol.max = '150'
  vol.step = '1'
  vol.setAttribute('aria-label', t('player.volume'))

  // ── 10 速度文字按钮 ────────────────────────────────────────
  const speedBtn = document.createElement('button')
  speedBtn.type = 'button'
  speedBtn.className = 'sh-pb__speed'
  speedBtn.setAttribute('aria-label', t('player.speed'))
  bindTip(speedBtn, () => t('player.speed'))

  // ── 11 缩放箭头 / 12 缩放滑杆 ──────────────────────────────
  const zoomIcon = document.createElement('span')
  zoomIcon.className = 'sh-pb__zoom-icon'
  zoomIcon.innerHTML = SVG.arrows

  const zoomRange = document.createElement('input')
  zoomRange.type = 'range'
  zoomRange.className = 'sh-pb__mini-range sh-pb__zoom'
  zoomRange.setAttribute('aria-label', t('player.zoom'))
  if (opts.zoom) {
    zoomRange.min = String(opts.zoom.min)
    zoomRange.max = String(opts.zoom.max)
    zoomRange.step = String(opts.zoom.step ?? 1)
  }

  // ── 竖屏底栏第二行居中的页面按钮；桌面隐藏 ──
  const actionBtn = document.createElement('button')
  actionBtn.type = 'button'
  actionBtn.className = 'sh-pb__action'
  if (opts.action) {
    actionBtn.textContent = opts.action.label()
    actionBtn.disabled = opts.action.disabled?.() ?? false
    actionBtn.addEventListener('click', () => {
      if (opts.action?.disabled?.()) return
      opts.action!.run()
    })
  } else {
    actionBtn.hidden = true
  }

  // 换行占位：桌面不显示。折行点定在进度条之后——
  // 中窄屏折行时「音量起」全部落到第二行；竖屏靠 order 排布不受 DOM 位置影响
  const rowBreak = document.createElement('div')
  rowBreak.className = 'sh-pb__break'

  row.append(
    win.grip,
    win.pinBtn,
    backBtn,
    playBtn,
    fwdBtn,
    timeEl,
    seek,
    rowBreak,
    volBtn,
    vol,
    speedBtn,
    actionBtn,
    win.closeBtn,
  )
  if (opts.zoom) {
    row.insertBefore(zoomIcon, win.closeBtn)
    row.insertBefore(zoomRange, win.closeBtn)
  }
  host.append(row)

  // ── 持久化偏好：音量 / 速度 ────────────────────────────────
  const readPrefNum = (key: string, def: number): number => {
    try {
      const raw = localStorage.getItem(key)
      const n = raw === null ? NaN : Number(raw)
      return Number.isFinite(n) ? n : def
    } catch {
      return def
    }
  }
  const writePref = (key: string, v: number): void => {
    try {
      localStorage.setItem(key, String(v))
    } catch {
      /* noop */
    }
  }

  let volume = readPrefNum('midee.volume', 100) || 0
  if (volume > 150) volume = 150
  let lastNonZero = volume > 0 ? volume : 100
  let speedIdx = Math.max(0, SPEEDS.indexOf(readPrefNum('midee.speed', 1)))

  const volumeText = (): string => `${t('player.volume')}-${Math.round(volume)}%`
  const paintVolume = (): void => {
    const lvl = volume <= 0 ? 'mute' : volume < 55 ? 'low' : 'high'
    volBtn.innerHTML = speakerSvg(lvl)
    vol.value = String(Math.round(volume))
    // 按钮是「切换」，所以标签说它要点开后发生什么，而不是当前状态
    volBtn.setAttribute('aria-label', volume > 0 ? t('player.mute') : t('player.unmute'))
  }
  bindTip(volBtn, volumeText)
  bindRangeTip(vol, volumeText)
  vol.addEventListener('input', () => {
    volume = Number(vol.value)
    if (volume > 0) lastNonZero = volume
    opts.getPlayer()?.setMasterVolume(volume / 100)
    writePref('midee.volume', volume)
    paintVolume()
  })
  volBtn.addEventListener('click', () => {
    volume = volume > 0 ? 0 : lastNonZero
    opts.getPlayer()?.setMasterVolume(volume / 100)
    writePref('midee.volume', volume)
    paintVolume()
  })
  paintVolume()

  const paintSpeed = (): void => {
    const s = SPEEDS[speedIdx]!
    speedBtn.textContent = Number.isInteger(s) ? `${s}×` : `${s.toFixed(2).replace(/0$/, '')}×`
  }
  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length
    const s = SPEEDS[speedIdx]!
    opts.getPlayer()?.setSpeed(s)
    writePref('midee.speed', s)
    paintSpeed()
  })
  paintSpeed()

  // ── 12 缩放滑杆（可选；连线页不传 zoom） ────────────────────
  const paintZoom = (): void => {
    if (!opts.zoom) return
    const pct = Math.round(opts.zoom.value())
    zoomRange.value = String(pct)
  }
  if (opts.zoom) {
    const zoomText = (): string => opts.zoom!.title(Number(zoomRange.value))
    bindRangeTip(zoomRange, zoomText)
    bindTip(zoomIcon, zoomText)
    zoomRange.addEventListener('input', () => {
      opts.zoom!.apply(Number(zoomRange.value))
      paintZoom()
    })
    paintZoom()
  }

  // ── 播放控制 ────────────────────────────────────────────────
  let playing = false
  /** 顶栏迷你播放键的刷新（只有注册了 dockFloat 才存在） */
  let paintMini: (() => void) | null = null
  const paintPlay = (): void => {
    playBtn.innerHTML = playing ? SVG.pause : SVG.play
    playBtn.setAttribute('aria-label', playing ? t('player.pause') : t('player.play'))
    paintMini?.()
  }
  bindTip(playBtn, () => (playing ? t('player.pause') : t('player.play')))
  paintPlay()
  playBtn.addEventListener('click', () => void opts.togglePlay())

  const seekBy = (delta: number): void => {
    if (opts.nudge) { opts.nudge(delta); return }
    const p = opts.getPlayer()
    if (!p || p.duration <= 0) return
    p.seek(Math.max(0, Math.min(p.duration, p.currentTime + delta)))
  }

  // ── 跳转步长（设置 ▾ → 跳转步长，0～12 秒，默认 10）──────────
  // 每次点击现读，不在这里缓存一份：设置改了立刻生效，两个页面的播放条也不会分岔。
  // 0 秒 = 这个动作没有意义，两个按钮直接收掉（不是禁用——禁用只会留两个点不动的方块）。
  function paintNudge(): void {
    const n = getNudgeSec()
    const off = n <= 0
    // 用行内 display 而不是 hidden：.sh-pb__icon 自己写了 display:grid，
    // 竖屏那档还有 :has() 规则再次强制显示，hidden 属性压不住它们。
    backBtn.style.display = off ? 'none' : ''
    fwdBtn.style.display = off ? 'none' : ''
    if (off) return
    backBtn.setAttribute('aria-label', t('player.backN', { n }))
    fwdBtn.setAttribute('aria-label', t('player.forwardN', { n }))
  }
  backBtn.addEventListener('click', () => seekBy(-getNudgeSec()))
  fwdBtn.addEventListener('click', () => seekBy(getNudgeSec()))
  paintNudge()
  onAudioPrefChange(paintNudge)
  onLocaleChange(paintNudge)

  // 时间：常态显当前，悬停气泡显 当前/总时长
  bindTip(timeEl, () => `${fmtTime(curTime)} / ${fmtTime(totalTime)}`)

  // 进度条：拖动气泡显示 新时间/总时长，数字随拖动实时变化
  bindRangeTip(seek, () => {
    // 自定义时间线（含首尾偏移）时总时长用 setProgress 传入的 totalTime
    const dur = opts.seekFrac ? totalTime : (opts.getPlayer()?.duration ?? totalTime)
    const t2 = dur > 0 ? (Number(seek.value) / 1000) * dur : 0
    return `${fmtTime(t2)}/${fmtTime(dur)}`
  })
  seek.addEventListener('input', () => {
    if (opts.seekFrac) { opts.seekFrac(Number(seek.value) / 1000); return }
    const p = opts.getPlayer()
    if (!p || p.duration <= 0) return
    p.seek((Number(seek.value) / 1000) * p.duration)
  })

  // ── 折行悬浮窗：宽度自检 ────────────────────────────────────
  // 目标宽度是「单行宽度的一半」，但那几乎正好等于第一行的最小需要宽度（零余量），
  // 真实窗口里字体/DPI/滚动条稍有差异就会被挤成三行。
  // 所以按实际渲染行数自检，一挡 8px 加宽直到恰好两行为止。
  const midMq = matchMedia('(max-aspect-ratio: 4/3)')
  const portraitMq = matchMedia('(max-aspect-ratio: 1/1)')
  const ultraMq = matchMedia('(min-aspect-ratio: 2/1)')

  const isWrapped = (): boolean => {
    // 竖屏是停靠底栏、超宽是贴左下的裸控件条，两者都不算「折行悬浮窗」
    if (portraitMq.matches || ultraMq.matches) return false
    return midMq.matches || win.root.classList.contains('is-wrapped')
  }

  // 同一行内的项目交叉轴中心一致（align-items: center），按中心聚类数行数最稳
  const rowCount = (): number => {
    const centers: number[] = []
    for (const child of Array.from(row.children)) {
      const e = child as HTMLElement
      if (e.classList.contains('sh-pb__break')) continue
      if (getComputedStyle(e).display === 'none') continue
      const b = e.getBoundingClientRect()
      centers.push(Math.round(b.top + b.height / 2))
    }
    if (!centers.length) return 0
    centers.sort((a, b) => a - b)
    let n = 1
    for (let i = 1; i < centers.length; i++) if (centers[i]! - centers[i - 1]! > 12) n++
    return n
  }

  // 临时把行拉回单行不折行，量出自然总宽
  const singleLineWidth = (): number => {
    const prevW = host.style.width
    const prevMw = host.style.maxWidth
    const prevWrap = row.style.flexWrap
    host.style.width = 'max-content'
    host.style.maxWidth = 'none'
    row.style.flexWrap = 'nowrap'
    const w = host.offsetWidth
    host.style.width = prevW
    host.style.maxWidth = prevMw
    row.style.flexWrap = prevWrap
    return w
  }

  const applyWrappedWidth = (): void => {
    if (isWrapped()) {
      let w = Math.floor(singleLineWidth() / 2)
      host.style.maxWidth = 'none'
      for (let i = 0; i < 40; i++) {
        host.style.width = `${w}px`
        if (rowCount() <= 2) break
        w += 8
      }
    } else {
      host.style.width = ''
      host.style.maxWidth = ''
    }
  }
  // ── 超宽屏：页面动作按钮挪进右侧栏功能区 ──────────────────────
  // 底部只剩裸播放控件（左手），路径/场景这类页面入口归右手侧的栏内。
  // 栏内显示由 .sh-topbar-group > .sh-pb__action 负责，这里只管搬家。
  let inRail = false
  const placeAction = (): void => {
    if (!opts.action) return
    const wantRail = ultraMq.matches
    if (wantRail === inRail) return
    const group = document.querySelector<HTMLElement>('.sh-topbar-group')
    if (wantRail) {
      if (!group) return
      group.appendChild(actionBtn)
      inRail = true
    } else {
      row.insertBefore(actionBtn, win.closeBtn)
      inRail = false
    }
  }

  const relayout = (): void => {
    placeAction()
    applyWrappedWidth()
  }
  relayout()
  window.addEventListener('resize', relayout)
  for (const mq of [midMq, portraitMq, ultraMq]) mq.addEventListener('change', relayout)

  // 宽屏双击六点把手 = 手动折行/还原；中窄屏折行是强制的，不给切回单行
  win.grip.addEventListener('dblclick', () => {
    if (midMq.matches || portraitMq.matches || ultraMq.matches) return
    win.root.classList.toggle('is-wrapped')
    applyWrappedWidth()
  })

  // ── 顶栏迷你播放控件（可选形态）：六点 + 线框播放/暂停 + 无框秒数 + ∨ ──
  // 六点用来把这枚控件拖回悬浮条形态；∨ 点开的是同一条播放条（内容在两者间搬动）。
  let miniPlay: HTMLButtonElement | null = null
  let miniTime: HTMLInputElement | null = null
  let miniSec = -1
  if (opts.shell) {
    const mini = document.createElement('div')
    mini.className = 'sh-mini-player'
    const grip = document.createElement('span')
    grip.className = 'sh-mini-player__grip'
    grip.setAttribute('data-dock-grip', '')
    grip.setAttribute('aria-hidden', 'true')
    const dotsEl = document.createElement('span')
    dotsEl.className = 'sh-float__dots'
    for (let i = 0; i < 6; i++) dotsEl.appendChild(document.createElement('i'))
    grip.appendChild(dotsEl)
    bindTip(grip, () => t('dock.playerToFloat'))

    miniPlay = document.createElement('button')
    miniPlay.type = 'button'
    miniPlay.className = 'sh-mini-player__play'
    miniPlay.innerHTML = MINI_SVG.play

    miniTime = document.createElement('input')
    miniTime.type = 'number'
    miniTime.className = 'sh-mini-player__time'
    miniTime.min = '0'
    miniTime.step = '1'
    miniTime.value = '0'
    miniTime.setAttribute('aria-label', t('dock.playerSec'))

    const caret = document.createElement('button')
    caret.type = 'button'
    caret.className = 'sh-mini-player__caret'
    caret.setAttribute('data-dock-caret', '')
    caret.setAttribute('aria-haspopup', 'true')
    caret.setAttribute('aria-expanded', 'false')
    caret.setAttribute('aria-label', t('player.title'))
    caret.innerHTML = MINI_SVG.caret

    mini.append(grip, miniPlay, miniTime, caret)

    const gotoSec = (sec: number): void => {
      const dur = opts.getPlayer()?.duration ?? totalTime
      if (dur <= 0) return
      const v = Math.max(0, Math.min(dur, sec))
      if (opts.seekFrac) opts.seekFrac(v / dur)
      else opts.getPlayer()?.seek(v)
    }
    miniPlay.addEventListener('click', () => void opts.togglePlay())
    // 回车/失焦才跳转：边打字边 seek 会把播放条带着乱跑
    miniTime.addEventListener('change', () => gotoSec(Number(miniTime!.value) || 0))
    miniTime.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') gotoSec(Number(miniTime!.value) || 0)
    })
    const paintMiniPlay = (): void => {
      if (!miniPlay) return
      miniPlay.innerHTML = playing ? MINI_SVG.pause : MINI_SVG.play
      miniPlay.setAttribute('aria-label', playing ? t('player.pause') : t('player.play'))
    }
    paintMiniPlay()
    onLocaleChange(paintMiniPlay)
    paintMini = paintMiniPlay

    opts.shell.dockFloat({
      id: 'player',
      titleKey: 'player.title',
      iconHTML: MINI_SVG.icon,
      win,
      host,
      mini,
      leftmost: true,
    })
  }

  // ── 句柄：页面把播放器回调转发到这里 ────────────────────────
  const handle: PlayerBarHandle = {
    setProgress(cur, dur) {
      curTime = cur
      totalTime = dur
      timeEl.textContent = fmtTime(cur)
      // 顶栏那枚可编辑秒数跟着走：正在输入时不抢光标，且只在整数秒变了才写
      if (miniTime && document.activeElement !== miniTime) {
        const sec = Math.floor(cur)
        if (sec !== miniSec) {
          miniSec = sec
          miniTime.value = String(sec)
        }
      }
      if (!seeking) seek.value = String(dur > 0 ? Math.round((cur / dur) * 1000) : 0)
    },
    setPlaying(next) {
      playing = next
      paintPlay()
    },
    setEnded(dur) {
      playing = false
      paintPlay()
      seek.value = '0'
      curTime = 0
      totalTime = dur
      timeEl.textContent = '0:00'
    },
    refreshZoom() {
      paintZoom()
    },
    attachPlayer() {
      const p = opts.getPlayer()
      if (!p) return
      p.setMasterVolume(volume / 100)
      p.setSpeed(SPEEDS[speedIdx]!)
    },
  }

  onLocaleChange(() => {
    paintPlay()
    paintVolume()
    paintZoom()
    if (opts.action) actionBtn.textContent = opts.action.label()
  })

  return handle
}
