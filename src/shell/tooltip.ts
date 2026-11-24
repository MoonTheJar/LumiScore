// 统一的悬浮提示气泡：比原生 title 好看，支持拖动条拖动时气泡跟随滑块、数字实时变化。
//
// bindTip(el, getText)      悬停 / 键盘聚焦显示（按钮、图标、时间文本等）
// bindRangeTip(input, fn)   滑杆悬停显示当前值；按住拖动时气泡钉在滑块上方并实时刷新

import { bringToFront } from './layer'

let bubble: HTMLDivElement | null = null
let currentTarget: HTMLElement | null = null
let rangeTarget: HTMLInputElement | null = null
let rangeRefresh: (() => void) | null = null
let hideTimer: number | undefined
let rafPending = false

/** 没有悬停能力的设备（手机/平板）：手指点击不配弹悬停气泡 */
const coarsePointer = matchMedia('(hover: none)')

function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble
  bubble = document.createElement('div')
  bubble.className = 'sh-tip'
  bubble.hidden = true
  document.body.append(bubble)
  return bubble
}

function cancelHide(): void {
  if (hideTimer) {
    window.clearTimeout(hideTimer)
    hideTimer = undefined
  }
}

function placeAt(target: HTMLElement, clientX: number, clientY: number): void {
  const b = ensureBubble()
  const margin = 6
  const rect = b.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  let x = clientX
  if (x - rect.width / 2 < margin) x = margin + rect.width / 2
  if (x + rect.width / 2 > vw - margin) x = vw - margin - rect.width / 2
  b.style.left = `${x}px`
  // 上方放不下就翻到锚点下方（顶栏按钮都贴近屏幕顶部），箭头同步翻向上
  const a = target.getBoundingClientRect()
  const above = clientY - rect.height - 1 >= margin
  b.classList.toggle('sh-tip--below', !above)
  // 入场动画的 keyframes 是按上方位移写死的，下方放置时关掉避免动画期间错位
  b.style.animation = above ? '' : 'none'
  b.style.top = above
    ? `${Math.max(margin + rect.height, clientY)}px`
    : `${Math.min(a.bottom + 9, vh - margin - rect.height)}px`
}

function show(target: HTMLElement, text: string, x: number, y: number): void {
  const b = ensureBubble()
  if (!text) return
  cancelHide()
  b.textContent = text
  // 长文本（如被省略号截断的项目名）在气泡里自由折行
  b.classList.toggle('sh-tip--wrap', target.dataset.tipWrap === '1')
  b.hidden = false
  bringToFront(b)
  placeAt(target, x, y)
  currentTarget = target
}

function hide(target?: HTMLElement): void {
  if (target && currentTarget !== target) return
  cancelHide()
  if (bubble) bubble.hidden = true
  currentTarget = null
}

function scheduleHide(target: HTMLElement): void {
  cancelHide()
  hideTimer = window.setTimeout(() => hide(target), 120)
}

function rectCenterTop(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top - 8 }
}

/** 普通元素：悬停 / 聚焦显示 */
export function bindTip(el: HTMLElement, getText: () => string): void {
  const gated = (): boolean => {
    // 触屏没有悬停这回事，手指一点就 focus/mouseenter，气泡会糊在操作上；
    // 只留主动 opt-in 的（项目名全名气泡，data-tip-wrap='1'）
    return coarsePointer.matches && el.dataset.tipWrap !== '1'
  }
  el.addEventListener('mouseenter', () => {
    if (rangeTarget || gated()) return
    const { x, y } = rectCenterTop(el)
    show(el, getText(), x, y)
  })
  el.addEventListener('mouseleave', () => scheduleHide(el))
  el.addEventListener('focus', () => {
    if (gated()) return
    const { x, y } = rectCenterTop(el)
    show(el, getText(), x, y)
  })
  el.addEventListener('blur', () => hide(el))
}

/** 滑杆：悬停显示当前值；拖动时气泡跟随滑块（位置随值走） */
export function bindRangeTip(input: HTMLInputElement, getText: () => string): void {
  const thumbPos = (): { x: number; y: number } => {
    const r = input.getBoundingClientRect()
    const min = Number(input.min) || 0
    const max = Number(input.max) || 100
    const v = Number(input.value)
    const ratio = max > min ? (v - min) / (max - min) : 0
    // 滑块 thumb 半径约 7px，按轨道宽度线性插值
    const x = r.left + 7 + ratio * Math.max(0, r.width - 14)
    return { x, y: r.top - 8 }
  }
  const refresh = (): void => {
    if (currentTarget !== input) return
    const { x, y } = thumbPos()
    const b = ensureBubble()
    b.textContent = getText()
    placeAt(input, x, y)
  }
  bindTip(input, getText)
  input.addEventListener('pointerdown', () => {
    rangeTarget = input
    rangeRefresh = refresh
    const { x, y } = thumbPos()
    show(input, getText(), x, y)
  })
  // input 事件本身按帧频率触发，直接刷新；这样即使页面被节流（如后台标签页）
  // 键盘步进 / 赋值也能立刻更新气泡，不依赖 rAF
  input.addEventListener('input', refresh)
}

// 拖动跟随只在全局挂一次：由 rangeTarget 标记当前按住的滑杆。原来每个滑杆各挂
// 一对 window pointermove/pointerup，音轨面板反复重建会无限累积并钉住旧 DOM。
function kickRaf(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    rangeRefresh?.()
  })
}
function endRangeDrag(): void {
  if (!rangeTarget) return
  const t = rangeTarget
  rangeTarget = null
  rangeRefresh = null
  scheduleHide(t)
}
window.addEventListener('pointermove', () => {
  if (rangeTarget) kickRaf()
})
window.addEventListener('pointerup', endRangeDrag)
window.addEventListener('pointercancel', endRangeDrag)
