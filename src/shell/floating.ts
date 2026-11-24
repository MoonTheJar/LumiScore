// 悬浮窗底层：只负责「浮在页面上」的行为——位置持久化、把手拖拽、
// 图钉钉住（钉住后不可拖动）、关闭收成一个图标气泡（再点恢复）。
//
// 与旧版不同：不再自带标题栏。把手（六点）/图钉/关闭按钮作为元素返回，
// 由调用方摆进自己的工具行（见 playerbar.ts），因此整窗可以只有一行。

import { t, onLocaleChange } from './i18n'
import { bindTip } from './tooltip'
import { bringToFront } from './layer'
import { attachBlankDrag, canvasRect, clampIntoCanvas, createEdgeLayer, type Edge, type EdgeLayer, type Size } from './dock'
import { PUB_ROOT } from '../shared/pub-root'

export interface FloatingOptions {
  /** 持久化前缀，例如 'midee.float.player'（位置 .pos、钉选 .pin、高度 .h） */
  storageKey: string
  /** 窗体内容（调用方自己排布，把手/图钉/关闭按钮也要放进去） */
  host: HTMLElement
  /** 折叠为单个图标时，气泡里显示的内容（默认品牌小图标） */
  reopenHTML?: string | undefined
  /** 初始位置；缺省底部居中 */
  anchor?: { x: number; y: number }
  /** 无障碍标签 */
  ariaLabel?: string | undefined
  /** 折叠气泡的悬停提示/无障碍名（反应式，随语言切换）；缺省用 ariaLabel，再缺省「播放器」。
   *  各窗体必须传自己的名字，否则场景设置立方体也会显示成「播放器」。 */
  reopenLabel?: (() => string) | undefined
  /** 播放中无操作自动隐藏（仅未钉住时）；任何操作（鼠标/触屏/按键）即刻唤起。
   *  isPlaying 返回当前是否在播放；delay 为闲置多久后隐藏（默认 2800ms）。 */
  autoHide?: { isPlaying: () => boolean; delay?: number }
  /** 边缘粗线长按后拖拽改大小。普通横屏四边都可拉，其余断点只保留上下（=原来的纯调高）。
   *  尺寸上限另与画布可视区取交集；宽度没存过就一直由内容决定（不写 width）。 */
  /** 每次拖动收尾（把手 / 空白 / 折叠图标）回调一次：坐标是**夹回画布之前**的意图位置，
   *  dock 层用它判断「拖回顶栏带 = 转回下拉形态」（用夹取后的位置永远顶不到顶栏）。*/
  onDragEnd?: ((rect: { top: number; left: number }) => void) | undefined
  /** 拖动过程中的意图位置：给 dock 层实时亮出侧编辑区的吸附预览矩形 */
  onDragMove?: ((x: number, y: number) => void) | undefined
  resizable?: {
    min: Size
    max: Size
    /** 没存过尺寸时的初值；只给 h 就是「高度定、宽度交给内容」 */
    default?: Partial<Size>
    edges?: readonly Edge[] | undefined
  }
}

export interface FloatingHandle {
  root: HTMLElement
  reopen: HTMLElement
  /** 六点拖拽把手：调用方放在行首 */
  grip: HTMLElement
  /** 图钉按钮：调用方放在第二位 */
  pinBtn: HTMLButtonElement
  /** 关闭按钮：调用方放在行尾 */
  closeBtn: HTMLButtonElement
  /** 四边粗线图层（只给了 resizable 的窗体才有）：折叠时要跟着藏 */
  edgeLayer: EdgeLayer | null
  isPinned: () => boolean
  setCollapsed: (collapsed: boolean) => void
  /** 摆到指定位置并落盘（dock 层拖出图标时要按释放点开窗） */
  setPos: (p: Pos) => void
}

interface Pos {
  x: number
  y: number
}

const MARGIN = 12

// ── 全局活动追踪（所有浮窗共享一份监听）：任何鼠标/触屏/按键/滚轮都算「有操作」，
//    用于播放中闲置自动隐藏的唤起。模块级只注册一次，避免每个浮窗各挂一套监听。 ──
let lastActivity = performance.now()
const wakeFns = new Set<() => void>()
function bumpActivity(): void {
  lastActivity = performance.now()
  for (const fn of wakeFns) fn()
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'] as const) {
  window.addEventListener(ev, bumpActivity, { passive: true, capture: true })
}

// ── 全局「是否在播放」探针：只有播放条手里有播放器实例，让它注册一次，
//    其余浮窗（顶栏拖下来的工具/比例/音轨窗）共用同一个口径做播放中闲置自动隐藏。 ──
let playingProbe: (() => boolean) | null = null
export function setPlayingProbe(fn: (() => boolean) | null): void {
  playingProbe = fn
}
export function isPlayingNow(): boolean {
  return playingProbe?.() === true
}

function clampPos(p: Pos, el: HTMLElement): Pos {
  const w = el.offsetWidth || 320
  const h = el.offsetHeight || 44
  // 播放条自己就是 --sh-dock-bottom 的测量对象，夹它会变成自我反馈；
  // 它只要求别越到顶栏上面，左右仍按视口（竖屏/超宽还要贴边停靠）。
  const isPlayer = !!el.querySelector(':scope > .sh-pb')
  if (!isPlayer) return clampIntoCanvas(p, { w, h })
  const c = canvasRect()
  const maxY = Math.max(c.top + MARGIN, window.innerHeight - h - MARGIN)
  return {
    x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(c.top + MARGIN, p.y), maxY),
  }
}

export function createFloatingWindow(opts: FloatingOptions): FloatingHandle {
  const root = document.createElement('div')
  root.className = 'sh-float'
  if (opts.ariaLabel) root.setAttribute('aria-label', opts.ariaLabel)
  root.appendChild(opts.host)
  document.body.appendChild(root)
  // 点到悬浮窗即抬到最上层（与顶栏下拉重叠时后出现/后点者在上）
  root.addEventListener('pointerdown', () => bringToFront(root), true)

  // ── 六点把手 ────────────────────────────────────────────────
  const grip = document.createElement('div')
  grip.className = 'sh-float__grip'
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-label', t('player.drag'))
  bindTip(grip, () => t('player.drag'))
  const dots = document.createElement('span')
  dots.className = 'sh-float__dots'
  for (let i = 0; i < 6; i++) dots.appendChild(document.createElement('i'))
  grip.appendChild(dots)

  // ── 图钉（点击变色 + 向左倾斜 15°，钉住后把手不可拖） ────────
  const pinBtn = document.createElement('button')
  pinBtn.type = 'button'
  pinBtn.className = 'sh-pb__icon sh-pb__pin'
  pinBtn.setAttribute('aria-label', t('player.pin'))
  pinBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3v5l3 3v2h-6v6l-1 2-1-2v-6H5v-2l3-3V3h8m0-2H8c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 .28-.11.53-.29.71L6.3 12.1c-.19.19-.3.44-.3.7V14c0 .55.45 1 1 1h5v5.5c0 .32.18.62.46.77L12 22l.54-.73c.28-.15.46-.45.46-.77V15h5c.55 0 1-.45 1-1v-1.2c0-.26-.11-.51-.29-.71l-2.41-2.39A1 1 0 0 1 15 9V3h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>'
  bindTip(pinBtn, () => (pinned ? t('player.unpinHint') : t('player.pinHint')))

  // ── 关闭（收成一个图标气泡） ────────────────────────────────
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'sh-pb__icon sh-pb__close'
  closeBtn.setAttribute('aria-label', t('player.close'))
  bindTip(closeBtn, () => t('player.close'))
  closeBtn.textContent = '×'

  const reopen = document.createElement('button')
  reopen.type = 'button'
  reopen.className = 'sh-float__reopen'
  const reopenText = opts.reopenLabel ?? (() => opts.ariaLabel ?? t('player.title'))
  reopen.setAttribute('aria-label', reopenText())
  bindTip(reopen, reopenText)
  // 悬停提示由 bindTip 每次重算（天然随语言变）；aria-label 是静态属性，需随语言刷新
  onLocaleChange(() => reopen.setAttribute('aria-label', reopenText()))
  reopen.innerHTML =
    opts.reopenHTML ??
    `<img src="${PUB_ROOT}icons/lumiscore-logo.svg" width="24" height="24" alt="" draggable="false"/>`
  reopen.hidden = true
  document.body.appendChild(reopen)

  // ── 位置持久化 ──────────────────────────────────────────────
  const defaultPos = (): Pos => {
    if (opts.anchor) return opts.anchor
    const w = root.offsetWidth || 480
    const h = root.offsetHeight || 44
    return { x: (window.innerWidth - w) / 2, y: window.innerHeight - h - 56 }
  }
  const loadPos = (): Pos | null => {
    try {
      const raw = localStorage.getItem(`${opts.storageKey}.pos`)
      if (!raw) return null
      const p = JSON.parse(raw) as Pos
      if (typeof p.x === 'number' && typeof p.y === 'number') return p
    } catch {
      /* 脏数据 → 默认位置 */
    }
    return null
  }
  const savePos = (p: Pos): void => {
    try {
      localStorage.setItem(`${opts.storageKey}.pos`, JSON.stringify(p))
    } catch {
      /* noop */
    }
  }
  /** 本次拖动想去的位置（未经夹取）：拖回顶栏带的判定要用它 */
  let wanted: Pos = { x: 0, y: 0 }
  const reportDragEnd = (): void => {
    opts.onDragEnd?.({ top: wanted.y, left: wanted.x })
  }
  const reportDragMove = (p: Pos): void => {
    opts.onDragMove?.(p.x, p.y)
  }
  const applyPos = (p: Pos): void => {
    const c = clampPos(p, root)
    root.style.left = `${Math.round(c.x)}px`
    root.style.top = `${Math.round(c.y)}px`
    reopen.style.left = `${Math.round(c.x)}px`
    reopen.style.top = `${Math.round(c.y)}px`
  }
  applyPos(loadPos() ?? defaultPos())
  // 首帧（字体/折行稳定后）再夹一次：创建时 offsetWidth 可能是旧宽度
  requestAnimationFrame(() => applyPos(loadPos() ?? defaultPos()))

  /** 窗口自身尺寸变化（折行/挂载 footer）时，把当前位置夹回视口内 */
  const clampCurrent = (): void => {
    // 折叠隐藏时 root 尺寸归 0、rect 落在 (0,0)，此时夹取会把 reopen 气泡甩到左上角；
    // 气泡应留在窗口原先的位置，故隐藏态直接跳过
    if (root.hidden) return
    const r = root.getBoundingClientRect()
    applyPos({ x: r.left, y: r.top })
  }
  new ResizeObserver(clampCurrent).observe(root)

  // ── 图钉状态 ────────────────────────────────────────────────
  let pinned = false
  try {
    pinned = localStorage.getItem(`${opts.storageKey}.pin`) === '1'
  } catch {
    /* noop */
  }
  const applyPinned = (): void => {
    root.dataset.pinned = String(pinned)
    pinBtn.classList.toggle('sh-pb__pin--on', pinned)
    // 钉住 = 常显不自动隐藏，但仍可拖动（不再禁用把手）；未钉住 = 播放闲置自动隐藏
    try {
      localStorage.setItem(`${opts.storageKey}.pin`, pinned ? '1' : '0')
    } catch {
      /* noop */
    }
    if (pinned) root.classList.remove('sh-float--idle')
  }
  applyPinned()
  pinBtn.addEventListener('click', () => {
    pinned = !pinned
    applyPinned()
  })

  // ── 关闭 / 恢复 ─────────────────────────────────────────────
  let collapsed = false
  /** 由 resize 那一段挂上：窗体刚从折叠态露出来时补做一次「按内容定宽」——
   *  折叠期间 offsetWidth 是 0，创建时那一帧量不到。 */
  let onReveal: (() => void) | null = null
  const setCollapsed = (next: boolean): void => {
    if (next && !root.hidden) {
      // 折叠瞬间把 reopen 气泡钉到窗口当前实际位置（原拖拽点/停靠点），
      // 避免沿用旧的 applyPos 坐标或隐藏后被夹到左上角
      const r = root.getBoundingClientRect()
      reopen.style.left = `${Math.round(r.left)}px`
      reopen.style.top = `${Math.round(r.top)}px`
    }
    collapsed = next
    root.hidden = next
    reopen.hidden = !next
    // 边缘线跟着窗体藏收，不然折叠后留四条悬空的粗线
    edgeLayer?.setVisible(!next)
    if (!next) {
      onReveal?.()
      clampCurrent()
    }
  }
  closeBtn.addEventListener('click', () => setCollapsed(true))

  // 折叠气泡可拖动：拖 = 移动位置（持久化），点 = 恢复整窗；
  // 拖过的那次 click 吞掉，别一撒手就把窗弹回来
  let bubbleMoved = false
  let bubbleDrag: {
    dx: number
    dy: number
    id: number
    sx: number
    sy: number
  } | null = null
  reopen.addEventListener('pointerdown', (e) => {
    bubbleMoved = false
    const r = reopen.getBoundingClientRect()
    bubbleDrag = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
    }
    try {
      reopen.setPointerCapture(e.pointerId)
    } catch {
      /* 同把手：个别环境没有活动指针，监听仍挂在 window 上 */
    }
    e.preventDefault()
  })
  window.addEventListener('pointermove', (e) => {
    if (!bubbleDrag || bubbleDrag.id !== e.pointerId) return
    if (
      !bubbleMoved &&
      Math.hypot(e.clientX - bubbleDrag.sx, e.clientY - bubbleDrag.sy) > 4
    )
      bubbleMoved = true
    if (bubbleMoved) bringToFront(reopen)
    if (bubbleMoved) {
      wanted = { x: e.clientX - bubbleDrag.dx, y: e.clientY - bubbleDrag.dy }
      reportDragMove(wanted)
      applyPos(wanted)
    }
  })
  const endBubbleDrag = (e: PointerEvent): void => {
    if (!bubbleDrag || bubbleDrag.id !== e.pointerId) return
    bubbleDrag = null
    try {
      reopen.releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    if (bubbleMoved) {
      const r = reopen.getBoundingClientRect()
      savePos({ x: r.left, y: r.top })
      reportDragEnd()
    }
  }
  window.addEventListener('pointerup', endBubbleDrag)
  reopen.addEventListener('pointercancel', () => {
    bubbleDrag = null
  })

  reopen.addEventListener('click', () => {
    if (bubbleMoved) {
      bubbleMoved = false // 拖完的 click 不算"点开"
      return
    }
    setCollapsed(false)
    bringToFront(root)
  })

  // ── 把手拖拽（钉住与否都可拖；钉住只影响自动隐藏） ──────────
  let drag: { dx: number; dy: number; id: number } | null = null
  grip.addEventListener('pointerdown', (e) => {
    const r = root.getBoundingClientRect()
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId }
    try {
      grip.setPointerCapture(e.pointerId)
    } catch {
      /* 某些环境（合成事件/触屏兼容层）没有活动指针，监听仍挂在 window 上 */
    }
    e.preventDefault()
  })
  window.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return
    wanted = { x: e.clientX - drag.dx, y: e.clientY - drag.dy }
    reportDragMove(wanted)
    applyPos(wanted)
  })
  const endDrag = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId) return
    drag = null
    try {
      grip.releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    const r = root.getBoundingClientRect()
    savePos({ x: r.left, y: r.top })
    reportDragEnd()
  }
  window.addEventListener('pointerup', endDrag)
  grip.addEventListener('pointercancel', () => {
    drag = null
  })

  // ── 空白处拖动（有把手也照样能拖空白）：交互元素与边缘粗线一律不抢手势 ──
  attachBlankDrag(root, {
    onMove: (x, y) => {
      wanted = { x, y }
      reportDragMove(wanted)
      applyPos(wanted)
    },
    onEnd: () => {
      const r = root.getBoundingClientRect()
      savePos({ x: r.left, y: r.top })
      reportDragEnd()
    },
  })

  // ── 播放中闲置自动隐藏（仅未钉住）：任何操作即刻唤起，闲置超 delay 再隐 ──
  if (opts.autoHide) {
    const ah = opts.autoHide
    const delay = ah.delay ?? 2800
    const wake = (): void => {
      root.classList.remove('sh-float--idle')
    }
    wakeFns.add(wake)
    window.setInterval(() => {
      const idle = performance.now() - lastActivity > delay
      const shouldHide = !pinned && !collapsed && !drag && ah.isPlaying() && idle
      root.classList.toggle('sh-float--idle', shouldHide)
    }, 300)
  }

  // ── 边缘粗线长按改大小（场景悬浮窗这类面板型浮窗） ──────────
  // 上下两任何断点都拉得到（原本就只有这个能力）；左右两只在普通横屏由 CSS 显出来，
  // 竖屏/超宽的浮窗本来就是贴边窄条，横向拉没有意义。
  let edgeLayer: EdgeLayer | null = null
  if (opts.resizable) {
    const { min, max } = opts.resizable
    root.classList.add('sh-float--resizable')
    const sizeKey = `${opts.storageKey}.size`
    const hKey = `${opts.storageKey}.h`
    const loadSize = (): Size | null => {
      try {
        const raw = localStorage.getItem(sizeKey)
        if (raw) {
          const s = JSON.parse(raw) as Partial<Size>
          if (typeof s.w === 'number' && typeof s.h === 'number') return { w: s.w, h: s.h }
        }
        // 旧版只存高度：把它读进来，别把用户已经调好的高度丢掉
        const h = Number(localStorage.getItem(hKey))
        return Number.isFinite(h) && h > 0 ? { w: 0, h } : null
      } catch {
        return null
      }
    }
    const saveSize = (s: Size): void => {
      try {
        localStorage.setItem(sizeKey, JSON.stringify(s))
      } catch {
        /* noop */
      }
    }
    const saved = loadSize()
    root.style.height = `${Math.round(saved?.h || opts.resizable.default?.h || 320)}px`
    // 宽度必须有明确的主人：面板自己常写死宽度（场景窗 .sp-host 就是 560px），
    // 窗体不设显式宽度时「要拉的尺寸」和「实际渲染的尺寸」对不上，
    // 贴边粗线就像橡皮筋一样弹回去。
    // 注意不能在这一点直接量 root.offsetWidth：窗体是先建好、面板 DOM 由调用方随后才塞进来，
    // 此刻量到的是只剩边框的 2px，等于把窗口钉成一条缝。所以延后一帧量，并且只接受合理值。
    const pinWidth = (w: number): boolean => {
      if (!(w >= min.w)) return false
      root.style.width = `${Math.round(w)}px`
      return true
    }
    const pinNatural = (): void => {
      if (!root.style.width) pinWidth(root.offsetWidth)
    }
    if (!pinWidth(saved?.w || 0) && !pinWidth(opts.resizable.default?.w || 0)) {
      requestAnimationFrame(pinNatural)
      // 启动就处于折叠态的窗体（顶栏拖下来的下拉重启后就是小图标）在这一帧量到的是 0，
      // 等它露脸时再补一次，宽度才始终有明确的主人。
      onReveal = pinNatural
    }
    // CSS 在 .sh-float 上压了一道 max-width: calc(100vw - 24px)（超宽档还有一条让侧栏的）。
    // 这道帽必须报给调整层：不然拉到 545 之后每帧都要 560、布局只给 545，
    // 贴边粗线就成了「拉不动还会啪地弹回去」的橡皮筋。
    const cssCap = (v: string): number => {
      const n = Number.parseFloat(v)
      return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY
    }
    edgeLayer = createEdgeLayer(root, {
      edges: opts.resizable.edges,
      min,
      max: () => {
        const cs = getComputedStyle(root)
        return { w: Math.min(max.w, cssCap(cs.maxWidth)), h: Math.min(max.h, cssCap(cs.maxHeight)) }
      },
      onResize: (box) => {
        root.style.width = `${Math.round(box.w)}px`
        root.style.height = `${Math.round(box.h)}px`
        applyPos({ x: box.x, y: box.y })
      },
      onEnd: (w, h) => {
        saveSize({ w: Math.round(w), h: Math.round(h) })
        clampCurrent()
      },
    })
  }

  window.addEventListener('resize', clampCurrent)

  return {
    root,
    reopen,
    grip,
    pinBtn,
    closeBtn,
    edgeLayer,
    isPinned: () => pinned,
    setCollapsed,
    setPos: (p: Pos) => {
      applyPos(p)
      savePos(p)
    },
  }
}
