// ── 自绘取色面板 ────────────────────────────────────────────────
// 替掉浏览器原生 <input type="color">：样式受控、预设/最近可选、
// 且拖动只改小方块预览，必须点「确认」才提交（避免边拖边重建材质）。
import {
	type HSV,
	hexString,
	hexToHsv,
	hsvToHex,
	hsvToRgb,
	parseHex,
	rgbToHsv,
} from "../shared/color-hsv";
import { t } from "../shell/i18n";

export interface PresetGroup {
	label: string;
	colors: number[];
}

export interface ColorPickerHandle {
	el: HTMLElement;
	/** 外部改色时同步面板（不触发提交） */
	set(v: number): void;
}

const RECENT_KEY = "lumiscore.recentColors";
const RECENT_MAX = 12;
const SV_W = 208;
const SV_H = 140;

/** 最近使用（localStorage，跨曲子保留） */
export function loadRecentColors(): number[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((v): v is number => typeof v === "number")
			.slice(0, RECENT_MAX);
	} catch {
		return [];
	}
}

export function pushRecentColor(v: number): number[] {
	const list = [v, ...loadRecentColors().filter((c) => c !== v)].slice(
		0,
		RECENT_MAX,
	);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(list));
	} catch {
		/* 隐私模式下写失败就算了 */
	}
	return list;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const n = document.createElement(tag);
	n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
}

export function createColorPicker(opts: {
	value: number;
	presets?: PresetGroup[];
	onCommit: (v: number) => void;
}): ColorPickerHandle {
	const hsv: HSV = hexToHsv(opts.value);
	let hueOnly = false; // 重绘 SV 底图的唯一触发条件

	const root = el("div", "sp-cp");
	root.addEventListener("pointerdown", (e) => e.stopPropagation());

	// ── SV 方块 + 色相条 + 预览/HEX ──
	const main = el("div", "sp-cp__main");
	const svBox = el("div", "sp-cp__sv");
	svBox.tabIndex = 0;
	svBox.setAttribute("role", "application");
	svBox.setAttribute("aria-label", t("cp.sv"));
	const cv = document.createElement("canvas");
	cv.width = SV_W;
	cv.height = SV_H;
	cv.className = "sp-cp__svcv";
	const ctx = cv.getContext("2d")!;
	const svDot = el("span", "sp-cp__dot");
	svBox.append(cv, svDot);

	const hueBar = el("div", "sp-cp__hue");
	hueBar.tabIndex = 0;
	hueBar.setAttribute("aria-label", t("cp.hue"));
	const hueKnob = el("span", "sp-cp__knob");
	hueBar.append(hueKnob);

	const side = el("div", "sp-cp__side");
	const preview = el("span", "sp-cp__preview");
	const hexIn = el("input", "sp-cp__hex");
	hexIn.type = "text";
	hexIn.spellcheck = false;
	hexIn.setAttribute("aria-label", t("cp.hex"));
	side.append(preview, hexIn);
	main.append(svBox, hueBar, side);
	root.append(main);

	// ── R/G/B 数值 ──
	const rgbRow = el("div", "sp-cp__rgb");
	const chan: HTMLInputElement[] = [];
	for (const name of ["R", "G", "B"]) {
		rgbRow.append(el("span", "sp-cp__chan", name));
		const i = el("input", "sp-cp__num");
		i.type = "number";
		i.min = "0";
		i.max = "255";
		i.setAttribute("aria-label", name);
		i.addEventListener("change", () => {
			const v = Math.max(0, Math.min(255, Number(i.value) || 0));
			i.value = String(v);
			adoptRgb(
				chan[0]!.valueAsNumber ?? 0,
				chan[1]!.valueAsNumber ?? 0,
				chan[2]!.valueAsNumber ?? 0,
			);
		});
		rgbRow.append(i);
		chan.push(i);
	}
	root.append(rgbRow);

	// ── 预设 / 最近 ──
	const groups: PresetGroup[] = [];
	if (opts.presets?.length) groups.push(...opts.presets);
	const recent = loadRecentColors();
	if (recent.length) groups.push({ label: t("cp.recent"), colors: recent });
	for (const g of groups) {
		if (!g.colors.length) continue;
		const row = el("div", "sp-cp__row");
		row.append(el("span", "sp-cp__label", g.label));
		for (const c of g.colors.slice(0, 14)) {
			const b = el("button", "sp-cp__sw");
			b.type = "button";
			b.style.background = hexString(c);
			b.title = hexString(c);
			b.addEventListener("click", () => adopt(hsvToHex(hexToHsv(c))));
			row.append(b);
		}
		root.append(row);
	}

	// ── 确认 ──
	const foot = el("div", "sp-cp__foot");
	const ok = el("button", "sh-btn sh-btn--primary sp-cp__ok");
	ok.type = "button";
	ok.textContent = t("cp.ok");
	ok.addEventListener("click", () => {
		pushRecentColor(hsvToHex(hsv));
		opts.onCommit(hsvToHex(hsv));
	});
	foot.append(ok);
	root.append(foot);

	// ── 绘制与同步 ──
	function drawSV(): void {
		const img = ctx.createImageData(SV_W, SV_H);
		for (let y = 0; y < SV_H; y++) {
			const v = 1 - y / (SV_H - 1);
			for (let x = 0; x < SV_W; x++) {
				const [r, gg, b] = hsvToRgb(hsv.h, x / (SV_W - 1), v);
				const i = (y * SV_W + x) * 4;
				img.data[i] = r;
				img.data[i + 1] = gg;
				img.data[i + 2] = b;
				img.data[i + 3] = 255;
			}
		}
		ctx.putImageData(img, 0, 0);
	}

	function refresh(): void {
		if (hueOnly) {
			hueOnly = false;
			drawSV();
		}
		const hex = hsvToHex(hsv);
		const str = hexString(hex);
		preview.style.background = str;
		if (document.activeElement !== hexIn) hexIn.value = str;
		if (document.activeElement !== chan[0])
			chan[0]!.value = String((hex >> 16) & 255);
		if (document.activeElement !== chan[1])
			chan[1]!.value = String((hex >> 8) & 255);
		if (document.activeElement !== chan[2]) chan[2]!.value = String(hex & 255);
		svDot.style.left = `${hsv.s * 100}%`;
		svDot.style.top = `${(1 - hsv.v) * 100}%`;
		hueKnob.style.top = `${(hsv.h / 360) * 100}%`;
		hueBar.style.setProperty("--cp-hue", `${hsv.h}`);
	}

	/** 直接指定 HSV（拖动/取色用，不动 RGB 输入） */
	function adopt(next: number): void {
		Object.assign(hsv, hexToHsv(next));
		hueOnly = true;
		refresh();
	}
	function adoptRgb(r: number, g: number, b: number): void {
		Object.assign(hsv, rgbToHsv(r, g, b));
		hueOnly = true;
		refresh();
	}

	/** 在元素内拖动 → 归一化坐标 */
	function drag(
		node: HTMLElement,
		onMove: (nx: number, ny: number) => void,
	): void {
		const fire = (e: PointerEvent): void => {
			const r = node.getBoundingClientRect();
			onMove(
				Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
				Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
			);
		};
		node.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			node.setPointerCapture(e.pointerId);
			fire(e);
		});
		node.addEventListener("pointermove", (e) => {
			if (node.hasPointerCapture(e.pointerId)) fire(e);
		});
	}

	drag(svBox, (nx, ny) => {
		hsv.s = nx;
		hsv.v = 1 - ny;
		refresh();
	});
	drag(hueBar, (_nx, ny) => {
		hsv.h = ny * 360;
		hueOnly = true;
		refresh();
	});

	svBox.addEventListener("keydown", (e) => {
		const step = e.shiftKey ? 0.1 : 0.02;
		if (e.key === "ArrowLeft") hsv.s = Math.max(0, hsv.s - step);
		else if (e.key === "ArrowRight") hsv.s = Math.min(1, hsv.s + step);
		else if (e.key === "ArrowUp") hsv.v = Math.min(1, hsv.v + step);
		else if (e.key === "ArrowDown") hsv.v = Math.max(0, hsv.v - step);
		else return;
		e.preventDefault();
		refresh();
	});
	hueBar.addEventListener("keydown", (e) => {
		const step = e.shiftKey ? 15 : 3;
		if (e.key === "ArrowUp" || e.key === "ArrowLeft")
			hsv.h = (hsv.h - step + 360) % 360;
		else if (e.key === "ArrowDown" || e.key === "ArrowRight")
			hsv.h = (hsv.h + step) % 360;
		else return;
		e.preventDefault();
		hueOnly = true;
		refresh();
	});
	hexIn.addEventListener("change", () => {
		const v = parseHex(hexIn.value);
		if (v === null) {
			refresh(); // 输入不合法就弹回当前值
			return;
		}
		adopt(v);
	});

	drawSV();
	refresh();

	return {
		el: root,
		set(v: number): void {
			adopt(v);
		},
	};
}
