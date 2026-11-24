// 浮层形态层：下拉 ↔ 悬浮窗 ↔ 侧编辑区 共用的底座。
//
// 这一层只解决三件事：
//   ① 画布可视区（canvasRect）——所有浮层的定位与限幅都以「去掉顶栏/侧栏/底栏/
//      侧编辑区之后的那块矩形」为准，浮层绝不许叠到背板控件上；
//   ② 富布局判定（isRichLayout）——拖出/吸附/侧编辑区这类高级交互只在普通横屏
//      （4:3 ~ 2:1，宽度够）提供，竖屏/窄横屏/超宽一律回退到现有的「能用就行」形态；
//   ③ 通用手势（attachBlankDrag / attachEdgeResize）——有没有六点把手都能拖空白处
//      移动；四边中点的粗线长按后可拉大小，限幅在画布可视区内。
//
// 约定：所有测量只读 CSS 变量（shell.ts 的 dockVars 负责写），不在这里量 DOM，
// 否则顶栏高度一变就要重算一整轮，还会和 CSS 断点打架。

import { t } from './i18n'
import { bindTip } from './tooltip'

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

/** 高级交互只在普通横屏开：4:3 以上、2:1 以下，且宽度不小于 900px。
 *  竖屏（≤1:1）走第二行、超宽（≥2:1）走右侧栏，那两套是「正常功能回退」，
 *  不做拖出/吸附/侧编辑区。 */
export const mqRich: MediaQueryList = matchMedia(
  '(min-aspect-ratio: 1.34) and (max-aspect-ratio: 1.99) and (min-width: 900px)',
)

export function isRichLayout(): boolean {
  return mqRich.matches
}

// 断点订阅只注册一次（每个浮层各挂一套 mqRich 监听没必要）
const richFns = new Set<(rich: boolean) => void>()
mqRich.addEventListener('change', (e) => {
  for (const fn of richFns) fn(e.matches)
})

export function onRichChange(fn: (rich: boolean) => void): () => void {
  richFns.add(fn)
  return () => richFns.delete(fn)
}

function cssPx(cs: CSSStyleDeclaration, name: string, d = 0): number {
  const v = Number.parseFloat(cs.getPropertyValue(name))
  return Number.isFinite(v) ? v : d
}

/** 画布可视区：顶栏下沿 → 底栏上沿，左右扣掉超宽右侧栏与侧编辑区。
 *  浮层的定位、限幅、吸附预览矩形全部以这块矩形为边界。 */
export function canvasRect(): Rect {
  const cs = getComputedStyle(document.documentElement)
  const top = cssPx(cs, '--sh-canvas-top', cssPx(cs, '--sh-dock-top', 54))
  const left = cssPx(cs, '--sh-dock-left')
  const right = window.innerWidth - cssPx(cs, '--sh-side-inset') - cssPx(cs, '--sh-dock-right')
  const bottom = window.innerHeight - cssPx(cs, '--sh-dock-bottom')
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  }
}

/** 把 p 夹进画布可视区（尺寸 wh 的浮层左上角可用范围） */
export function clampIntoCanvas(p: { x: number; y: number }, wh: Size, m = 8): { x: number; y: number } {
  const r = canvasRect()
  const maxX = Math.max(r.left + m, r.right - m - wh.w)
  const maxY = Math.max(r.top + m, r.bottom - m - wh.h)
  return {
    x: Math.min(Math.max(r.left + m, p.x), maxX),
    y: Math.min(Math.max(r.top + m, p.y), maxY),
  }
}

/** 空白处按下即可拖动。交互元素（按钮/输入/标签/把手/边缘线）一律不抢手势，
 *  内容超高（要滚动）时触屏也不抢——否则手指没法滚列表。 */
export function attachBlankDrag(
  el: HTMLElement,
  o: {
    onMove: (x: number, y: number) => void
    onStart?: () => void
    onEnd?: () => void
    /** 命中即不拖动；默认排除所有交互元素 */
    exclude?: string
    /** 现势闸门：返回 false 就不进入拖动（例如内容已经不在下拉形态时） */
    enabled?: () => boolean
  },
): void {
  const EXCLUDE =
    o.exclude ??
    'button, a, input, select, textarea, label, summary, [contenteditable], [role="option"], [data-no-drag], .sh-edge, .sh-float__grip'
  let drag: { dx: number; dy: number; id: number } | null = null
  el.addEventListener('pointerdown', (e) => {
    if (o.enabled && !o.enabled()) return
    const t = e.target as HTMLElement | null
    if (!t || (o.exclude ? t.closest(o.exclude) : t.closest(EXCLUDE))) return
    // 可滚动的内容 + 手指 = 让浏览器自己滚
    if (e.pointerType === 'touch' && el.scrollHeight > el.clientHeight + 2) return
    const r = el.getBoundingClientRect()
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId }
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件环境没有活动指针，监听仍挂在 window 上 */
    }
    o.onStart?.()
    e.preventDefault()
  })
  window.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return
    o.onMove(e.clientX - drag.dx, e.clientY - drag.dy)
  })
  const end = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId) return
    drag = null
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    o.onEnd?.()
  }
  window.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', () => {
    drag = null
  })
}

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export interface EdgeLayer {
  el: HTMLElement
  /** 目标矩形变了（内容自适应、被别处改尺寸、滚动、缩放）就调一次贴合 */
  sync: () => void
  setVisible: (b: boolean) => void
  destroy: () => void
}

/**
 * 四边中点的粗线：鼠标按住即进入调整态；触屏/触控笔先长按 armMs 再到点，
 *  且到点那一刻用现行指针与现行矩形重新起算（不跟手就是沿用了按下时的旧起点）。
 *
 * 图层挂在 body 上、按目标的 getBoundingClientRect 贴合，而不是塞进目标内部——
 * 下拉本体是滚动容器，内部绝对定位的把手会跟着内容滚走，也够不着 padding 之外。
 * 长按这一下是防误触：边缘线压在内容上，随手一划就改尺寸会很难受。
 * 尺寸与位移都交给调用方落地（下拉要跟着重定位、还要写 max-height）。
 */
export function createEdgeLayer(
  target: HTMLElement,
  o: {
    edges?: readonly Edge[] | undefined
    min: Size
    /** 上限：固定值或按当前画布可视区现算，最终与画布矩形取交集 */
    max?: Size | (() => Size) | undefined
    onResize: (box: { x: number; y: number; w: number; h: number }) => void
    onEnd?: (w: number, h: number) => void | undefined
    armMs?: number | undefined
  },
): EdgeLayer {
  const edges = o.edges ?? (['left', 'right', 'top', 'bottom'] as const)
  const armMs = o.armMs ?? 150
  const maxOf = (): Size => (typeof o.max === 'function' ? o.max() : o.max ?? { w: 4096, h: 4096 })
  const layer = document.createElement('div')
  layer.className = 'sh-edge-layer'
  const handles = new Map<Edge, HTMLElement>()
  for (const edge of edges) {
    const hnd = document.createElement('div')
    hnd.className = `sh-edge sh-edge--${edge}`
    hnd.dataset.edge = edge
    hnd.setAttribute('role', 'separator')
    hnd.setAttribute('aria-label', t('dock.resizeEdge'))
    bindTip(hnd, () => t('dock.resizeEdge'))
    handles.set(edge, hnd)
    layer.append(hnd)
  }
  document.body.append(layer)

  let manualHide = false
  const rect = (): { x: number; y: number; w: number; h: number } => {
    const r = target.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  const sync = (): void => {
    const r = rect()
    // 目标被藏起来了（折叠气泡、页面自己 stow 悬浮窗，都不走 setCollapsed）：
    // 四条边缘线必须跟着消失，不然会在画布上留下悬空的粗线
    if (manualHide || r.w < 2 || r.h < 2) {
      layer.style.visibility = 'hidden'
      return
    }
    layer.style.visibility = 'visible'
    layer.style.left = `${Math.round(r.x)}px`
    layer.style.top = `${Math.round(r.y)}px`
    layer.style.width = `${Math.round(r.w)}px`
    layer.style.height = `${Math.round(r.h)}px`
    // 压在目标之上一点点：谁最后被抬层谁在上面，靠 sync 时机决定
    const z = Number.parseFloat(getComputedStyle(target).zIndex)
    layer.style.zIndex = Number.isFinite(z) ? String(z + 1) : '1012'
  }
  sync()

  const ro = new ResizeObserver(sync)
  ro.observe(target)
  // 页面可能直接 target.hidden = true（3D 页收纳场景窗就是这条路），
  // 尺寸观察器不一定补得上，所以连属性变化一起盯。
  const mo = new MutationObserver(sync)
  mo.observe(target, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] })
  // 弹出动画用的是 transform: scale()，只改视觉不改布局：RO/layout 都不触发，
  // 而图层按 getBoundingClientRect 贴合（动画期间那个矩形是缩放后的），
  // 所以动画收尾时必须再贴一次，不然四条边线比面板窄一圈。
  const onAnim = (): void => {
    sync()
  }
  target.addEventListener('transitionend', onAnim)
  target.addEventListener('animationend', onAnim)
  window.addEventListener('resize', sync)
  window.addEventListener('scroll', sync, true)

  let st: {
    id: number
    edge: Edge
    sx: number
    sy: number
    x: number
    y: number
    w: number
    h: number
    armed: boolean
  } | null = null
  let armTimer = 0
  /** 最后一次指针位置：长按到点时用现行位置重新起算，面板才不会「啪」地跳过去 */
  let lastPt = { x: 0, y: 0 }
  /** 最近一帧算出的矩形（st 里那份是 arm 那一刻的基准，全程不许改）：
   *  基准一旦被就地改写，下一帧又按「相对原始按下点」的位移累加，尺寸就会越拉越快、
   *  撞到限幅后再往回拉也对不上——这就是「拖的时候会跳变」。收尾存盘读这份现行值。 */
  let cur = { x: 0, y: 0, w: 0, h: 0 }

  /** 进入调整态。鼠标按在那条专用线上意图已经很明确，立刻生效；
   *  触屏/触控笔保留一点长按门槛（线上就是内容，随手一划不该改尺寸），
   *  但到点后用**当前**指针与**当前**矩形重新起算，绝不沿用按下那一刻的旧起点。 */
  const arm = (): void => {
    if (!st || st.armed) return
    const r = rect()
    st = { ...st, armed: true, sx: lastPt.x, sy: lastPt.y, x: r.x, y: r.y, w: r.w, h: r.h }
    cur = r
    layer.classList.add('is-edge-resizing')
  }

  const stop = (): void => {
    window.clearTimeout(armTimer)
    if (st?.armed) o.onEnd?.(cur.w, cur.h)
    st = null
    layer.classList.remove('is-edge-resizing')
  }

  for (const [edge, hnd] of handles) {
    hnd.addEventListener('pointerdown', (e) => {
      const r = rect()
      lastPt = { x: e.clientX, y: e.clientY }
      st = { id: e.pointerId, edge, sx: e.clientX, sy: e.clientY, ...r, armed: false }
      try {
        hnd.setPointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
      window.clearTimeout(armTimer)
      if (e.pointerType === 'mouse' || armMs <= 0) arm()
      else armTimer = window.setTimeout(arm, armMs)
      e.preventDefault()
      e.stopPropagation()
    })
    hnd.addEventListener('pointercancel', stop)
  }

  window.addEventListener('pointermove', (e) => {
    if (!st || st.id !== e.pointerId) return
    lastPt = { x: e.clientX, y: e.clientY }
    if (!st.armed) return
    // 用按下时记住的那条边，不读 e.target：没有活动指针的环境（合成事件、触屏兼容层）
    // setPointerCapture 会失败，move 的 target 就落到 window 上，读 dataset 等于没反应
    const edge = st.edge
    const c = canvasRect()
    const max = maxOf()
    const dx = e.clientX - st.sx
    const dy = e.clientY - st.sy
    // 全部按「相对按下点」的位移从基准算，基准本身全程不改（改了就变成累加，越拉越快）
    let w = st.w
    let h = st.h
    if (edge === 'right') w = st.w + dx
    else if (edge === 'left') w = st.w - dx
    else if (edge === 'bottom') h = st.h + dy
    else h = st.h - dy
    // 能长多大 = 调用方上限 ∩「锚点到画布边界」的余量。
    // 拉右边锚在左、拉左边锚在右（上下一样），所以对侧永远不动；
    // 位移再由尺寸反推，不会出现「顶边拉到顶栏上、底边却挤出画布」。
    const roomW = edge === 'left' ? st.x + st.w - c.left : c.left + c.w - st.x
    const roomH = edge === 'top' ? st.y + st.h - c.top : c.top + c.h - st.y
    w = Math.min(Math.max(o.min.w, w), Math.min(max.w, roomW))
    h = Math.min(Math.max(o.min.h, h), Math.min(max.h, roomH))
    const x = edge === 'left' ? st.x + st.w - w : st.x
    const y = edge === 'top' ? st.y + st.h - h : st.y
    cur = { x, y, w, h }
    o.onResize(cur)
    sync()
  })
  const up = (e: PointerEvent): void => {
    if (!st || st.id !== e.pointerId) return
    stop()
  }
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)

  return {
    el: layer,
    sync,
    setVisible: (b: boolean) => {
      manualHide = !b
      sync()
    },
    destroy: () => {
      ro.disconnect()
      mo.disconnect()
      target.removeEventListener('transitionend', onAnim)
      target.removeEventListener('animationend', onAnim)
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      layer.remove()
    },
  }
}

// ── 形态注册表：同一块内容要么当顶栏下拉，要么当悬浮窗，二者互斥 ──────
//
// 状态与手势在这一层，真正造窗/开关下拉由 shell 回调实现（dock 不反向依赖
// floating.ts，否则和 floating → dock 组成循环 import）。
// 记住三条口径：
//   · 顶栏图标按住往下拖出顶栏带 → 变成悬浮小图标（悬浮窗的折叠态）；
//     小图标或悬浮窗标题行拖回顶栏带 → 图标回到功能区，下拉形态恢复。
//   · 折叠小图标沿用顶栏那颗图标（iconHTML 传的就是按钮里那枚 SVG）。
//   · 形态存 localStorage，重启页面按上次的形态装配。

export type DockForm = 'drop' | 'float' | 'side'

export interface DockPoint {
  x: number
  y: number
}

export interface Dockable {
  id: string
  /** 悬浮窗标题 / 折叠图标的悬停说明（i18n key） */
  titleKey: string
  /** 顶栏按钮里的图标 SVG；折叠成小图标时原样沿用 */
  iconHTML: string
  /** 形态切换时显隐的那个顶栏元素：内置下拉是图标按钮，页面注册的浮窗是整只迷你控件 */
  btn: HTMLElement
  /** 拖出顶栏的手势起点：内置下拉就是按钮本身；迷你播放器是那一枚六点把手 */
  dragFrom?: HTMLElement | undefined
  /** 允许出现的形态，默认两种都行（设置/步骤只给 ['drop']） */
  forms?: readonly DockForm[]
  /** 没存过偏好时的形态。播放条/场景窗这类「本来就是悬浮窗」的传 'float' */
  defaultForm?: DockForm
  /** 侧编辑区形态落点（form==='side' 时生效），由 shell 在吸附那一刻写好 */
  sideSlot: { side: Side; slot: SideSlot }
  /** 切到悬浮窗：shell 用 createFloatingWindow 建窗（只建一次，之后显隐）并摆到 pos */
  showFloat: (pos: DockPoint | null, collapsed: boolean) => void
  /** 收起悬浮窗（窗体留着，内容回位到下拉） */
  hideFloat: () => void
  /** 关掉可能开着的下拉 */
  closeDrop: () => void
  /** 挂进侧编辑区的某个槽（side=该侧、slot=整条或上/下半） */
  mountSide?: (side: Side, slot: SideSlot) => void
  /** 从侧编辑区取回内容（回到下拉/悬浮窗形态） */
  unmountSide?: () => void
}

export interface DockRegistry {
  add: (d: Dockable) => void
  formOf: (id: string) => DockForm
  setForm: (
    id: string,
    form: DockForm,
    pos?: DockPoint | null,
    collapsed?: boolean,
    sideSlot?: { side: Side; slot: SideSlot },
  ) => void
  /** 顶栏按钮：图标拖出顶栏带就转成悬浮小图标；返回 true 表示这次点击已被拖动吃掉 */
  bindButton: (id: string) => void
  /** 悬浮窗/小图标被拖到哪儿收尾：吸附到侧编辑区，或拖回顶栏带转回下拉形态 */
  dragEnded: (id: string, rect: { top: number; left: number }) => void
  /** 下拉被拖到哪儿收尾：侧边 → 侧编辑区，画布内 → 悬浮窗（都不成立就弹回锚点） */
  dropDragEnded: (id: string, x: number, y: number) => DockForm
  /** 断点变了（转进/转出普通横屏）重新按各自形态装配 */
  reapplyAll: () => void
  /** 记下某块内容实际落在侧编辑区的哪一格。整条被挤成两块时，搬家的那块要靠这个
   *  把落点写回去，否则下次开机它还按「整条」挂载，会把同侧另一块顶成没有出口的孤儿。 */
  rememberSlot: (id: string, side: Side, slot: SideSlot) => void
  onChange: (fn: (id: string, form: DockForm) => void) => () => void
}

export function createDockRegistry(sides: SideDocks): DockRegistry {
  const items = new Map<string, Dockable>()
  const forms = new Map<string, DockForm>()
  const fns = new Set<(id: string, form: DockForm) => void>()
  /** 刚拖出过图标：紧随其后的 click 不能再开下拉 */
  const draggedAt = new Map<string, number>()

  const key = (id: string): string => `midee.dockform.${id}`
  const slotKey = (id: string): string => `midee.dockslot.${id}`
  const read = (id: string, d: Dockable): DockForm => {
    const allow = d.forms ?? ['drop', 'float']
    const def = d.defaultForm && allow.includes(d.defaultForm) ? d.defaultForm : allow[0] ?? 'drop'
    let v: string | null = null
    try {
      v = localStorage.getItem(key(id))
    } catch {
      /* 隐私模式：按默认形态 */
    }
    return v && allow.includes(v as DockForm) ? (v as DockForm) : def
  }
  /** 读回上次的落点；没记过就放右侧整条 */
  const readSlot = (id: string): { side: Side; slot: SideSlot } => {
    let v: string | null = null
    try {
      v = localStorage.getItem(slotKey(id))
    } catch {
      /* noop */
    }
    const [side, slot] = (v ?? 'right-full').split('-')
    return {
      side: side === 'left' ? 'left' : 'right',
      slot: slot === 'top' || slot === 'bottom' ? slot : 'full',
    }
  }
  const write = (id: string, form: DockForm): void => {
    try {
      localStorage.setItem(key(id), form)
    } catch {
      /* noop */
    }
  }

  /** 形态落地：下拉与悬浮窗二选一，顶栏按钮跟着同进同退。
   *  非普通横屏一律按下拉装配（存下来的偏好不动，转回横屏再恢复）。 */
  const apply = (
    d: Dockable,
    form: DockForm,
    pos: DockPoint | null,
    collapsed: boolean,
  ): void => {
    // 非普通横屏一律回退到「该项的默认形态」：三个下拉回退成顶栏下拉，
    // 播放条/场景窗的默认本来就是悬浮窗，回退也就继续当悬浮窗。
    if (form !== 'drop' && !isRichLayout()) form = d.defaultForm ?? 'drop'
    if (form === 'drop' && !isRichLayout() && d.defaultForm === 'float') form = 'float'
    if (form === 'side') {
      // 侧编辑区是常驻的：顶栏控件让位，悬浮窗也收掉，内容只存在于槽里
      d.closeDrop()
      d.btn.style.display = 'none'
      d.hideFloat()
      d.mountSide?.(d.sideSlot.side, d.sideSlot.slot)
      return
    }

    d.unmountSide?.()
    if (form === 'float') {
      d.closeDrop()
      d.btn.style.display = 'none'
      d.showFloat(pos, collapsed)
    } else {
      d.hideFloat()
      d.btn.style.display = ''
    }
  }

  const emit = (id: string, form: DockForm): void => {
    for (const fn of fns) fn(id, form)
  }

  const api: DockRegistry = {
    add(d): void {
      items.set(d.id, d)
      const f = read(d.id, d)
      forms.set(d.id, f)
      // 落点也要按存过的来：apply 读的是 d.sideSlot，不回填的话开机时两块侧编辑区
      // 全按字面默认值挤进同一条右栏的整格，上下半区的手动布局每次刷新就丢。
      d.sideSlot = readSlot(d.id)
      // 按存下来的形态完整装配一遍（顶栏控件的显隐也在里面），
      // 只调 showFloat 会留下「图标还在、点下去把内容从窗里掏走」的错状态。
      // 开机折叠策略：本来就是悬浮窗形态的（播放条/场景窗）保持展开=现状；
      // 用户手动拖出来的（三个下拉）折叠成小图标，不占画布。
      apply(d, f, null, d.defaultForm !== 'float')
    },

    formOf(id): DockForm {
      return forms.get(id) ?? 'drop'
    },

    setForm(id, form, pos, collapsed, sideSlot): void {
      const d = items.get(id)
      if (!d) return
      const allow = d.forms ?? ['drop', 'float']
      let next = allow.includes(form) ? form : d.defaultForm ?? allow[0] ?? 'drop'
      // 拖拽手势在窄屏也会发生（手指一划就出窗），这里一律挡回来：
      // 高级形态只在普通横屏提供，其余断点回到该项自己的默认形态。
      if (!isRichLayout()) next = d.defaultForm ?? 'drop'
      if (next === 'side' && !d.mountSide) next = 'drop'
      if (sideSlot) {
        d.sideSlot = sideSlot
        try {
          localStorage.setItem(slotKey(id), `${sideSlot.side}-${sideSlot.slot}`)
        } catch {
          /* noop */
        }
      }
      // 已经是侧编辑区、只是换了槽位（上/下半、左右挪）时不能早退，
      // 否则第二次吸附看着「亮了一下预览却没搬过去」。
      const sameForm = next === forms.get(id) && form === next
      if (sameForm && next !== 'side') return
      forms.set(id, next)
      write(id, next)
      apply(d, next, pos ?? null, collapsed ?? false)
      emit(id, next)
    },

    bindButton(id): void {
      const d = items.get(id)
      if (!d) return
      const src = d.dragFrom ?? d.btn
      const topbarBottom = (): number => {
        const r = document.querySelector('.sh-topbar')?.getBoundingClientRect()
        // 竖屏第二行/超宽侧栏：顶栏矩形不靠谱时退回「按 CSS 变量的画布上沿」
        return r && r.height > 0 ? r.bottom : canvasRect().top
      }
      let st: { id: number; sx: number; sy: number; moved: boolean } | null = null
      src.addEventListener('pointerdown', (e) => {
        if (api.formOf(id) !== 'drop' || !isRichLayout()) return
        st = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false }
      })
      window.addEventListener('pointermove', (e) => {
        if (!st || st.id !== e.pointerId) return
        if (!st.moved && Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) st.moved = true
      })
      window.addEventListener('pointerup', (e) => {
        if (!st || st.id !== e.pointerId) return
        const moved = st.moved
        st = null
        if (!moved) return
        // 只有拖出顶栏带（落在画布区里）才算 detach；还在带内就是手滑
        if (e.clientY <= topbarBottom()) return
        draggedAt.set(id, Date.now())
        api.setForm(id, 'float', { x: e.clientX - 22, y: e.clientY - 22 }, true)
      })
      // 拖完的 click 吞一次，别一撒手又把下拉弹开
      src.addEventListener(
        'click',
        (e) => {
          const at = draggedAt.get(id) ?? 0
          if (Date.now() - at < 500) {
            draggedAt.delete(id)
            e.stopImmediatePropagation()
            e.preventDefault()
          }
        },
        true,
      )
    },

    dragEnded(id, rect): void {
      const d = items.get(id)
      if (!d) return
      // 松手点在侧边吸附带里 → 优先落成侧编辑区（左右都能吸，和悬浮窗当前位置无关）
      const hit = isRichLayout() ? sides.hover(rect.left, rect.top) : null
      if (hit) {
        api.setForm(id, 'side', null, false, hit)
        sides.clear()
        return
      }
      sides.clear()
      if (api.formOf(id) !== 'float') return
      if (rect.top < canvasRect().top) api.setForm(id, 'drop')
    },

    dropDragEnded(id, x, y): DockForm {
      const hit = isRichLayout() ? sides.hover(x, y) : null
      sides.clear()
      if (hit) {
        api.setForm(id, 'side', null, false, hit)
        return 'side'
      }
      const c = canvasRect()
      if (isRichLayout() && x > c.left && x < c.right && y > c.top && y < c.bottom) {
        // 拖进画布但没贴近侧边 =  detach 成悬浮窗，窗就开在松手这一点
        api.setForm(id, 'float', { x: x - 24, y: y - 12 }, false)
        return 'float'
      }
      return api.formOf(id)
    },

    reapplyAll(): void {
      // 折叠策略和开机一致：原本就是悬浮窗的（播放条/场景窗）保持展开，
      // 用户手动拖出来的才折成小图标。窗口来回跨界不该把播放条折没。
      for (const [id, d] of items) apply(d, forms.get(id) ?? 'drop', null, d.defaultForm !== 'float')
    },

    rememberSlot(id, side, slot): void {
      const d = items.get(id)
      if (!d) return
      d.sideSlot = { side, slot }
      try {
        localStorage.setItem(slotKey(id), `${side}-${slot}`)
      } catch {
        /* noop */
      }
    },

    onChange(fn): () => void {
      fns.add(fn)
      return () => fns.delete(fn)
    },
  }
  return api
}

// ── 侧编辑区 ───────────────────────────────────────────────
//
// 纵向下拉/悬浮窗拖到页面左或右边缘 → 变成一块常驻编辑区：上抵顶栏下沿、下到底栏上沿，
// 顶栏那颗图标取消，画布按 --sh-dock-left / --sh-dock-right 避让。
// 同侧上 1/3、下 1/3 各能吸附半块，于是同一侧可以叠两块；只占半块时另外半块是空的，
// 画布避让仍按整条宽度算（半块与整块同宽，避让看宽度不看内容）。
// 中缝那条粗线拖宽度：两个半块共用同一个宽度值，所以粗线永远居中、两半天然同步。

export type Side = 'left' | 'right'
export type SideSlot = 'full' | 'top' | 'bottom'

export interface SideZoneHandle {
  side: Side
  el: HTMLElement
  /** 把内容放进某个槽；slot=full 占整条，top/bottom 各占一半 */
  mount: (content: HTMLElement, slot: SideSlot) => void
  unmount: (content: HTMLElement) => void
  slotOf: (content: HTMLElement) => SideSlot | null
  /** 命中测试：指针落在哪一格，不在吸附带内返回 null */
  slotAt: (x: number, y: number) => SideSlot | null
  /** 拖动过程中跟随指针的预览矩形（主题色半透明）；传 null 收起 */
  preview: (slot: SideSlot | null) => void
  width: () => number
  setWidth: (w: number) => void
  refresh: () => void
}

const SIDE_MIN_W = 220
const SIDE_MAX_W = 560
const SIDE_DEFAULT_W = 300
/** 距边多少像素内进入吸附 */
const SNAP_EDGE = 56

function sideRect(side: Side, slot: SideSlot, w: number): Rect {
  const c = canvasRect()
  // 横向一律贴视口边（超宽还要躲开右侧栏）：侧编辑区自己就是「让画布往里缩」的那块，
  // 若拿 canvasRect 的 left/right 定位，它会被自己写进去的 --sh-dock-left/right 再推一次，
  // 窗口每变一次尺寸就往中间滑一格。上下仍按画布带（顶栏下沿 → 底栏上沿）。
  const inset = cssPx(getComputedStyle(document.documentElement), '--sh-side-inset')
  const x = side === 'left' ? 0 : window.innerWidth - inset - w
  const half = (c.bottom - c.top) / 2
  if (slot === 'top')
    return { left: x, top: c.top, right: x + w, bottom: c.top + half, w, h: half }
  if (slot === 'bottom')
    return {
      left: x,
      top: c.bottom - half,
      right: x + w,
      bottom: c.bottom,
      w,
      h: half,
    }
  return { left: x, top: c.top, right: x + w, bottom: c.bottom, w, h: c.bottom - c.top }
}

export function createSideZone(side: Side): SideZoneHandle {
  const wKey = `midee.sidedock.${side}.w`
  let w = SIDE_DEFAULT_W
  try {
    const v = Number(localStorage.getItem(wKey))
    if (Number.isFinite(v) && v >= SIDE_MIN_W && v <= SIDE_MAX_W) w = v
  } catch {
    /* 用默认宽度 */
  }

  const el = document.createElement('aside')
  el.className = `sh-sidedock sh-sidedock--${side}`
  el.dataset.side = side
  const full = document.createElement('div')
  full.className = 'sh-sidedock__slot sh-sidedock__slot--full'
  const topSlot = document.createElement('div')
  topSlot.className = 'sh-sidedock__slot sh-sidedock__slot--top'
  const botSlot = document.createElement('div')
  botSlot.className = 'sh-sidedock__slot sh-sidedock__slot--bottom'
  const seam = document.createElement('div')
  seam.className = 'sh-sidedock__seam'
  seam.setAttribute('role', 'separator')
  seam.setAttribute('aria-label', t('dock.sideWidth'))
  bindTip(seam, () => t('dock.sideWidth'))
  const hint = document.createElement('div')
  // 预览矩形挂在 body 上、按视口坐标定位：塞在 zone 里的话，空的那一侧
  // （zone 因为没内容而 hidden）永远亮不出预览——第一次吸附恰恰就是空侧。
  hint.className = 'sh-sidedock__preview'
  el.append(full, topSlot, botSlot, seam)
  document.body.append(el, hint)

  const slotEl = (s: SideSlot): HTMLElement =>
    s === 'full' ? full : s === 'top' ? topSlot : botSlot
  const occupied = (): boolean =>
    !!(full.children.length || topSlot.children.length || botSlot.children.length)

  const paint = (): void => {
    const r = sideRect(side, 'full', w)
    el.style.width = `${Math.round(r.w)}px`
    el.style.left = `${Math.round(r.left)}px`
    el.style.top = `${Math.round(r.top)}px`
    el.style.height = `${Math.round(r.h)}px`
    el.hidden = !occupied()
    // 避让变量只在有内容时占位，空的一侧完全不压缩画布
    document.documentElement.style.setProperty(
      side === 'left' ? '--sh-dock-left' : '--sh-dock-right',
      occupied() ? `${Math.round(r.w)}px` : '0px',
    )
  }

  let rz: { id: number; sx: number; sw: number } | null = null
  seam.addEventListener('pointerdown', (e) => {
    rz = { id: e.pointerId, sx: e.clientX, sw: w }
    try {
      seam.setPointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    e.preventDefault()
    e.stopPropagation()
  })
  window.addEventListener('pointermove', (e) => {
    if (!rz || rz.id !== e.pointerId) return
    const dir = side === 'left' ? 1 : -1
    // 上限按「除本侧以外」的可用宽度算：canvasRect 的宽里已经扣掉了本侧自己写进去的
    // --sh-dock-left/right，再拿它乘 0.6 就成了自我收紧——拖一下就锁死在最小宽度。
    const cs = getComputedStyle(document.documentElement)
    const other = cssPx(cs, side === 'left' ? '--sh-dock-right' : '--sh-dock-left')
    const inset = cssPx(cs, '--sh-side-inset')
    const avail = window.innerWidth - other - inset
    // 侧编辑区最宽只吃可用区六成：再宽就是把谱面挤没了
    const cap = Math.min(SIDE_MAX_W, Math.max(SIDE_MIN_W, Math.floor(avail * 0.6)))
    w = Math.min(Math.max(SIDE_MIN_W, rz.sw + (e.clientX - rz.sx) * dir), cap)
    paint()
  })
  const endRz = (e: PointerEvent): void => {
    if (!rz || rz.id !== e.pointerId) return
    rz = null
    try {
      seam.releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    try {
      localStorage.setItem(wKey, String(Math.round(w)))
    } catch {
      /* noop */
    }
  }
  window.addEventListener('pointerup', endRz)

  // 构造即画一次：没人调 paint 的话，hidden 和避让变量都还是空值，
  // 一块 12px 宽的裸边框就会杵在页面边缘（所有断点都中招）。
  paint();
  // 窗口尺寸一变，这条的 left/top/height 全要重算（常驻内容不会再触发 paint）
  window.addEventListener('resize', paint)

  const inBand = (x: number): boolean => {
    const c = canvasRect()
    return side === 'left' ? x - c.left <= SNAP_EDGE : c.right - x <= SNAP_EDGE
  }

  return {
    side,
    el,
    mount(content, slot): void {
      // 整块与两个半块互斥：谁被指定，另一个形态就腾出来
      if (slot === 'full') {
        topSlot.replaceChildren()
        botSlot.replaceChildren()
      } else {
        // 原先占整条的那块让到对侧半区，这就是「同一侧叠两块」的入口
        const moved = [...full.children]
        full.replaceChildren()
        if (moved.length) (slot === 'top' ? botSlot : topSlot).replaceChildren(...moved)
        slotEl(slot).replaceChildren()
      }
      slotEl(slot).append(content)
      paint()
    },
    unmount(content): void {
      content.remove()
      paint()
    },
    slotOf(content): SideSlot | null {
      const p = content.parentElement
      if (p === full) return 'full'
      if (p === topSlot) return 'top'
      if (p === botSlot) return 'bottom'
      return null
    },
    slotAt(x, y): SideSlot | null {
      if (!inBand(x)) return null
      const c = canvasRect()
      if (y < c.top || y > c.bottom) return null
      const half = (c.bottom - c.top) / 2
      if (!occupied()) {
        // 空侧：指针落在中间那一档就是整条，否则上下各半（叠两块就靠这里）
        return Math.abs(y - (c.top + half)) < half * 0.42 ? 'full' : y < c.top + half ? 'top' : 'bottom'
      }
      // 一整条被占：落在上/下 1/3 就把它挤成两块（mount 负责搬家）
      if (full.children.length) return y < c.top + half ? 'top' : 'bottom'
      // 两块都满了：这一侧不再收，宁可让它继续当悬浮窗，也别把已存在的那块挤成孤儿
      if (topSlot.children.length && botSlot.children.length) return null
      return y < c.top + half ? 'top' : 'bottom'
    },
    preview(slot): void {
      if (!slot) {
        hint.style.opacity = '0'
        return
      }
      const r = sideRect(side, slot, w)
      hint.style.opacity = '1'
      hint.style.left = `${Math.round(r.left)}px`
      hint.style.top = `${Math.round(r.top)}px`
      hint.style.width = `${Math.round(r.w)}px`
      hint.style.height = `${Math.round(r.h)}px`
    },
    width: () => w,
    setWidth(next: number): void {
      w = Math.min(SIDE_MAX_W, Math.max(SIDE_MIN_W, next))
      paint()
    },
    refresh: paint,
  }
}

export interface SideDocks {
  zones: Record<Side, SideZoneHandle>
  /** 拖动中调用：亮出会落到的槽并返回它，不在吸附带返回 null */
  hover: (x: number, y: number) => { side: Side; slot: SideSlot } | null
  clear: () => void
  refresh: () => void
}

export function createSideDocks(): SideDocks {
  const zones: Record<Side, SideZoneHandle> = {
    left: createSideZone('left'),
    right: createSideZone('right'),
  }
  // 顶栏带预览：拖回顶栏 = 变回下拉形态，同样要提前围出目标区域
  const topHint = document.createElement('div')
  topHint.className = 'sh-dockhint'
  document.body.append(topHint)
  const paintTopHint = (on: boolean): void => {
    topHint.style.opacity = on ? '1' : '0'
    if (!on) return
    const c = canvasRect()
    if (c.top <= 1) {
      // 超宽段没有顶栏，这块预览本就不该出现
      topHint.style.opacity = '0'
      return
    }
    topHint.style.left = `${Math.round(c.left)}px`
    topHint.style.top = '0px'
    topHint.style.width = `${Math.round(c.right - c.left)}px`
    topHint.style.height = `${Math.round(c.top)}px`
  }
  return {
    zones,
    hover(x, y) {
      const c = canvasRect()
      if (y < c.top) {
        paintTopHint(true)
        for (const z of Object.values(zones)) z.preview(null)
        return null
      }
      paintTopHint(false)
      let hit: { side: Side; slot: SideSlot } | null = null
      for (const side of ['left', 'right'] as const) {
        const z = zones[side]
        const slot = z.slotAt(x, y)
        z.preview(slot)
        if (slot && !hit) hit = { side, slot }
      }
      return hit
    },
    clear() {
      for (const z of Object.values(zones)) z.preview(null)
      paintTopHint(false)
    },
    refresh() {
      for (const z of Object.values(zones)) z.refresh()
    },
  }
}
