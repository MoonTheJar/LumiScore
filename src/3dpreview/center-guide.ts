/**
 * 相机对中辅助层 —— 给「居中偏移」滑轨用的参考线。
 * 实现方式同 aspect-overlay：纯 DOM 覆盖层挂在 body，与画布同一内缩可视区，
 * 不拦截指针事件（不堆进 3D 场景）。拖动滑轨时出现、松手即消失。
 * 只画一条居中十字（一横一竖）交叉于画布可视区中心，作为对中参考。
 */
let overlay: HTMLDivElement | null = null
let shown = false

export function mountCenterGuide(): void {
	if (overlay) return
	overlay = document.createElement("div")
	overlay.className = "center-guide-overlay"
	overlay.innerHTML =
		'<div class="cg-cross cg-cross-v"></div>' +
		'<div class="cg-cross cg-cross-h"></div>'
	document.body.appendChild(overlay)
	hideCenterGuide()
}

export function isCenterGuideShown(): boolean {
	return shown
}

export function showCenterGuide(): void {
	if (!overlay) return
	shown = true
	overlay.style.display = ""
}

/** 松手即消失（不做延迟淡出，避免残留干扰） */
export function hideCenterGuide(): void {
	if (!overlay) return
	shown = false
	overlay.style.display = "none"
}
