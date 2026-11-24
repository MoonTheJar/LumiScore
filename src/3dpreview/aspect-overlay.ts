// 顶栏「画面比例」下拉 + 画布上的裁剪辅助层（虚线框 / 置黑遮罩）。
// 纯视觉参考：辅助线不参与任何导出；导出裁剪与这里共用同一 contain 口径
// （见 aspect-ratio.ts 的 cropRectFor，比例变了虚线/遮罩跟着画布重算）。
import { t } from "../shell/i18n";
import { ASPECT_RATIOS, aspectById, cropRectFor } from "./aspect-ratio";

const BULB_SVG =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.4c.6.6 1 1.4 1 2.1h6c0-.7.4-1.5 1-2.1A6 6 0 0 0 12 3z"/></svg>';

/** 画布坐标里的「可视区」（顶栏以下）：辅助虚线和导出裁剪的公共基准。
 *  画布本身铺满视口，但上沿被顶栏盖住一条——用户排画面是按看得见的部分排的。 */
export function visibleViewRect(): { x: number; y: number; w: number; h: number } {
	const el = document.querySelector<HTMLElement>(".aspect-overlay");
	const canvas = document.getElementById("canvas-container");
	const cr = canvas?.getBoundingClientRect();
	if (el && cr) {
		const r = el.getBoundingClientRect();
		return {
			x: r.left - cr.left,
			y: r.top - cr.top,
			w: r.width,
			h: r.height,
		};
	}
	return {
		x: 0,
		y: 0,
		w: canvas?.clientWidth ?? window.innerWidth,
		h: canvas?.clientHeight ?? window.innerHeight,
	};
}

export function createAspectOverlay(): { menu: HTMLElement } {
	const guides = new Set<string>();
	let black: string | null = null;

	// 覆盖层挂在画布可视区（顶栏以下），不拦截任何鼠标事件
	const overlay = document.createElement("div");
	overlay.className = "aspect-overlay";
	document.body.append(overlay);

	const menu = document.createElement("div");
	menu.className = "aspect-menu";
	const hint = document.createElement("div");
	hint.className = "aspect-menu__hint";
	hint.dataset.i18n = "aspect.hint";
	hint.textContent = t("aspect.hint");
	menu.append(hint);

	const rows = new Map<
		string,
		{ row: HTMLDivElement; pick: HTMLDivElement; bulb: HTMLButtonElement }
	>();
	for (const r of ASPECT_RATIOS) {
		const row = document.createElement("div");
		row.className = "aspect-row";
		// 行本身不扮按钮：里面还有一个真按钮（灯泡），role=button 套 button 会被读屏吞掉内层
		const pick = document.createElement("div");
		pick.className = "aspect-row__pick";
		pick.setAttribute("role", "button");
		pick.tabIndex = 0;
		const dot = document.createElement("i");
		dot.className = "aspect-dot";
		dot.style.background = r.color;
		const label = document.createElement("span");
		label.textContent = r.id;
		pick.append(dot, label);
		const bulb = document.createElement("button");
		bulb.type = "button";
		bulb.className = "aspect-bulb";
		bulb.title = t("aspect.bulb");
		bulb.dataset.i18nTitle = "aspect.bulb";
		bulb.setAttribute("aria-label", t("aspect.blackAria"));
		bulb.dataset.i18nAria = "aspect.blackAria";
		bulb.innerHTML = BULB_SVG;
		row.append(pick, bulb);
		const toggleGuide = (): void => {
			if (guides.has(r.id)) guides.delete(r.id);
			else guides.add(r.id);
			sync();
		};
		row.addEventListener("click", toggleGuide);
		pick.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			e.stopPropagation(); // 空格别漏到页面级快捷键去当播放/暂停
			toggleGuide();
		});
		bulb.addEventListener("click", (e) => {
			e.stopPropagation();
			black = black === r.id ? null : r.id;
			sync();
		});
		menu.append(row);
		rows.set(r.id, { row, pick, bulb });
	}

	function layout(): void {
		overlay.textContent = "";
		const W = overlay.clientWidth;
		const H = overlay.clientHeight;
		if (W < 4 || H < 4) return;
		for (const id of guides) {
			const r = aspectById(id);
			if (!r) continue;
			const c = cropRectFor(W, H, r.ratio);
			const g = document.createElement("div");
			g.className = "aspect-guide";
			g.style.borderColor = r.color;
			g.style.left = `${c.x}px`;
			g.style.top = `${c.y}px`;
			g.style.width = `${c.w}px`;
			g.style.height = `${c.h}px`;
			overlay.append(g);
		}
		if (black) {
			const r = aspectById(black);
			if (r) {
				const c = cropRectFor(W, H, r.ratio);
				// 裁掉的部分 = 框外四块，置黑
				const masks: [number, number, number, number][] = [
					[0, 0, W, c.y],
					[0, c.y + c.h, W, H - c.y - c.h],
					[0, c.y, c.x, c.h],
					[c.x + c.w, c.y, W - c.x - c.w, c.h],
				];
				for (const [x, y, w, h] of masks) {
					if (w <= 0 || h <= 0) continue;
					const m = document.createElement("div");
					m.className = "aspect-mask";
					m.style.left = `${x}px`;
					m.style.top = `${y}px`;
					m.style.width = `${w}px`;
					m.style.height = `${h}px`;
					overlay.append(m);
				}
			}
		}
	}

	function sync(): void {
		for (const [id, el] of rows) {
			const on = guides.has(id);
			el.row.classList.toggle("is-on", on);
			el.pick.setAttribute("aria-pressed", on ? "true" : "false");
			const lit = black === id;
			el.bulb.classList.toggle("is-on", lit);
			el.bulb.setAttribute("aria-pressed", lit ? "true" : "false");
		}
		layout();
	}

	window.addEventListener("resize", layout);
	// 顶栏收起/展开会改变可视高度，也重算一遍
	new ResizeObserver(layout).observe(overlay);
	sync();

	return { menu };
}
