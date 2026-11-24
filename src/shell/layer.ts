// 浮层层级管理：顶栏下拉、悬浮窗、气泡、弹窗等互相重叠时，
// 遵循「谁最后出现（或最后被点到）谁在上」——每次 show/focus 递增分配 z-index。
// CSS 里的固定 z-index 只作为首帧兜底，显示后统一由这里接管。

let zCounter = 1000

/** 把元素抬到所有已托管浮层的最上面 */
export function bringToFront(el: HTMLElement | null | undefined): void {
  if (!el) return
  zCounter += 1
  el.style.zIndex = String(zCounter)
}
