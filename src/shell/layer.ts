// 浮层层级管理：顶栏下拉、悬浮窗、气泡、弹窗等互相重叠时，
// 遵循「谁最后出现（或最后被点到）谁在上」——每次 show/focus 递增分配 z-index。
// CSS 里的固定 z-index 只作为首帧兜底，显示后统一由这里接管。
// 起始值高于页面所有固定 z-index（当前最高 toasts 4000），避免托管浮层被固定层级盖住。

let zCounter = 10000

/** 把元素抬到所有已托管浮层的最上面 */
export function bringToFront(el: HTMLElement | null | undefined): void {
  if (!el) return
  // 取元素当前已有的层级（行内或 CSS 计算值），避免把已有高层级的浮层反而降回去
  const cur = parseInt(getComputedStyle(el).zIndex, 10)
  if (!Number.isNaN(cur)) zCounter = Math.max(zCounter, cur)
  zCounter += 1
  el.style.zIndex = String(zCounter)
}
