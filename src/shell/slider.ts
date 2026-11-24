// 统一滑轨：自绘拖动条 + 数值输入框 + 原生控件回退。
// 拖动条用 CSS 画在原生 <input type="range"> 上（自绘轨道/拇指/已填段）；底层仍是原生
// range，键盘 / 触屏 / 读屏 / 自定义样式失效时都回退到原生行为，不会拖不动。
// 除播放条外，拖动滑轨时临时隐藏其它悬浮窗与下拉，只保留滑轨自身所在容器（拖动条仍显现）。

export interface SliderPairOpts {
	/** 数字框显示格式，默认 String(v) */
	fmt?: (v: number) => string;
	/** commit 模式的夹取区间，两者都给才夹 */
	min?: number;
	max?: number;
	/** true=数字框 change 才提交；缺省=数字框 input 实时生效 */
	commitOnChange?: boolean;
	/** 拖动时不隐藏其它悬浮窗/下拉（播放条用） */
	noHide?: boolean;
}

// ── 拖动隐藏：只保留正在拖动的那条滑轨可见，其余所有悬浮窗（含滑轨自身所在窗）
//    与下拉都隐藏。用 visibility 而非 opacity：祖先 hidden 时，被标记的滑轨自身
//    visible 仍单独显现（不带走面板背景），拖动条留在原位、画布透出来。 ──
let dragActive: HTMLElement | null = null;
export function beginSliderDrag(el: HTMLElement): void {
	endSliderDrag();
	dragActive = el;
	el.classList.add("slider-drag-active");
	document.body.classList.add("is-slider-drag");
}
export function endSliderDrag(): void {
	document.body.classList.remove("is-slider-drag");
	if (dragActive) dragActive.classList.remove("slider-drag-active");
	dragActive = null;
}
// 全局唯一 pointerup/cancel 收尾，避免每个滑轨各挂一个 window 监听
window.addEventListener("pointerup", () => endSliderDrag());
window.addEventListener("pointercancel", () => endSliderDrag());

// ── 自绘外观 + 已填段 + 拖动隐藏；返回 updateFill 供外部 sync 时刷新 ──
const sliderSetup = new WeakMap<HTMLInputElement, () => void>();
export function setupSlider(
	range: HTMLInputElement,
	opts: { noHide?: boolean | undefined } = {},
): () => void {
	const existing = sliderSetup.get(range);
	if (existing) return existing;
	range.classList.add("sh-slider");
	const updateFill = (): void => {
		const min = Number(range.min);
		const max = Number(range.max);
		const v = Number(range.value);
		const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
		range.style.setProperty("--fill", `${Math.max(0, Math.min(100, pct))}%`);
	};
	range.addEventListener("input", updateFill);
	if (!opts.noHide) {
		range.addEventListener("pointerdown", () => beginSliderDrag(range));
	}
	updateFill();
	sliderSetup.set(range, updateFill);
	return updateFill;
}

/** 外部程序化改值（如相机 syncPanel 每帧回填）后刷新已填段，不触发 set。 */
export function refreshSliderFill(range: HTMLInputElement): void {
	const fn = sliderSetup.get(range);
	if (fn) fn();
}

/** 绑定一对滑轨+数字框，返回 sync(v)：外部改值后回填两端，不触发 set。 */
export function bindSliderPair(
	slide: HTMLInputElement,
	num: HTMLInputElement,
	set: (v: number) => void,
	opts: SliderPairOpts = {},
): (v: number) => void {
	const fmt = opts.fmt ?? ((v) => String(v));
	const updateFill = setupSlider(slide, { noHide: opts.noHide });
	const sync = (v: number): void => {
		slide.value = String(v);
		num.value = fmt(v);
		updateFill();
	};
	slide.addEventListener("input", () => {
		const v = Number(slide.value) || 0;
		set(v);
		num.value = fmt(v);
		updateFill();
	});
	if (opts.commitOnChange) {
		num.addEventListener("change", () => {
			let v = Number(num.value);
			if (opts.min !== undefined && opts.max !== undefined) {
				v = Math.min(opts.max, Math.max(opts.min, v));
			}
			if (!Number.isFinite(v)) {
				sync(Number(slide.value));
				return;
			}
			set(v);
			sync(v);
		});
	} else {
		num.addEventListener("input", () => {
			const v = Number(num.value);
			if (Number.isNaN(v)) return;
			set(v);
			slide.value = String(v);
			updateFill();
		});
	}
	num.addEventListener("keydown", (e) => {
		if (e.key === "Enter") num.blur();
	});
	return sync;
}
