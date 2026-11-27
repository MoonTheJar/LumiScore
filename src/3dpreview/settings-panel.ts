// ── 第 5 页悬浮设置窗 v4：三页结构（材质 / 环境 / 运动） ─────────────
// 左列：材质 / 环境 / 运动
// 右列：
//   · 材质页：上方对象 tabs（乐谱 / 背景 / 小球），每个对象组一行
//     「颜色下拉窗（跟随源 + 自定义色 + 恢复默认）+ 材质下拉（预设 / 网络贴图）」，
//     下面滑杆（贴图缩放 / 粗糙度 / 金属度 / 透明度 / 点亮发光）
//   · 环境页：上方子 tabs 通用 / 光照 / 水面（暂未开放）/ 雾效（暂未开放）
//     通用 = 渲染半径 + 设备（gpu/cpu/auto）+ 光线追踪（实验，性能风险提示）+
//            凸起高度（显示 ×100 世界单位）+ 预设主题
//   · 运动页：上方子 tabs 小球 / 拖尾 / 点亮 / 轨迹线
//     小球 = 大小 / 下落时间 / 发光强度（真光源）/ 亮度（自发光）
//     拖尾 = 特效 / 发光强度 / 透明度 / 长度 / 颜色（跟随小球或自定义）
//     点亮 = 颜色四选一（跟随小球 / 跟随音轨 / 跟随主题色 / 自定义）
//     轨迹线 = 跳动高度 + 轨迹线 / 起点线 / 终点线三块样式（颜色走颜色下拉窗）
import { ColorBus } from "../shared/color-bus";
import {
	listDownloaded,
	listResources,
	subscribe as subscribeRes,
} from "../shared/resource-manager";
import { createFloatingWindow } from "../shell/floating";
import { onLocaleChange, t } from "../shell/i18n";
import { bringToFront } from "../shell/layer";
import { createSelect } from "../shell/select";
import type { ShellHandle } from "../shell/shell";
import { setupSlider } from "../shell/slider";
import { createColorPicker } from "./colorPicker";
import {
	type AnyPreset,
	baseColorOf,
	inkColorOf,
	isGlassPreset,
	type MatObject,
	type MatTune,
	type ObjMatConfig,
	presetDefaultTune,
	SCORE_BALL_OPTIONS,
	SURFACE_OPTIONS,
} from "./materials3d";
import { catLeafZh, catPathZh, texNameZh } from "./ph-names";
import { fetchTextureList, type PHAsset } from "./polyhaven";

export type ArcStyle = "solid" | "dashed" | "none";
export type TrajShape = "parabola" | "line";
/** 元素点亮三档：off=关闭（不点亮）/ stream=流式（前沿随播放头扫过）/ block=逐块（经过时整块点亮） */
export type LitMode = "off" | "stream" | "block";
/** 渲染设备：auto = 逐级降级；gpu = 强制高性能显卡；cpu = 低功耗软渲染 */
export type DeviceMode = "auto" | "gpu" | "cpu";
/** 球光晕特效样式（three-glow-mesh）：关闭 / 柔和 / 光环 */
export type BallGlowStyle = "off" | "soft" | "halo";
/** 点亮颜色四选一 */

/** 光照设置：顶光（亮度最低 0 = 无光源）+ 天空（环境贴图/环境光） */
export interface LightSettings {
	ambient: number;
	ambientColor: number;
	keyColor: number;
	keyIntensity: number;
	keyAzimuth: number;
	keyElevation: number;
	env: number;
}

/** 一条辅助线的样式（线形 / 透明度 / 颜色） */
export interface GuideLineStyle {
	style: ArcStyle;
	opacity: number;
	color: number;
	followTrack?: boolean; // 仅轨迹线：颜色跟随各轨道配色
}

/** 预设点亮主题键（实际颜色表在 main.ts 的 LIT_THEMES） */
export const THEME_KEYS = ["Dark", "Midnight", "Neon", "Sunset", "Ocean"] as const;

/** 巡检调度：自动修的东西也全部保留手动入口，所以「自动」只是开关，不是唯一路径 */
export interface RepairSettings {
	patrolOn: boolean; // 总开关：关掉就只能手动自检
	autoApply: boolean; // 关掉 = 只报告不动手，每一项都留按钮
	intervalSec: number; // 定时扫描间隔（秒）
	onBoot: boolean; // 触发时机：载入完这张谱
	onSetting: boolean; // 触发时机：改完场景设置（防抖）
	onVisible: boolean; // 触发时机：从后台切回前台
	onContext: boolean; // 触发时机：WebGL 上下文恢复后
}

/** 与 main.ts 共用的第 5 页外观状态（材质 / 环境 / 运动） */
export interface SurfSettings {
	viewRadius: number;
	/** 边缘过渡带宽度（×viewRadius）：地面在这段里淡到 0，终点正好是元素硬裁剪线 */
	viewFeather: number;
	mat: Record<"score" | "ground" | "ball", ObjMatConfig>;
	matTune: Record<"score" | "ground" | "ball", MatTune>;
	selectedObject: MatObject | "sky";
	// ── 选择性 bloom 四源：每源「亮度」= 它在正式画面里的颜色强度，
	//    「光效」= 它进发光缓冲的权重（0=完全不发光）。两者互不干扰。──
	brightBall: number; // 小球/拖尾亮度 0-1
	glowBall: number; // 小球光效 0-1
	brightLit: number; // 点亮符头亮度 0-1
	glowLit: number; // 点亮符头光效 0-1
	brightGround: number; // 底面亮度 0-1
	groundWidth: number; // 底面宽度（世界单位，以中轴线为基准向两侧各一半）
	groundFade: number; // 底面两侧边缘渐变强度 0-1
	glowGround: number; // 底面光效 0-1（>0 等于把整块地面当光源）
	brightSky: number; // 天空/背景亮度 0-1（0=黑 1=白）
	glowSky: number; // 天空光效 0-1（>0 等于把背景当光源加回来）
	bloomStrength: number; // 发光缓冲整体放大倍率
	scoreGlow: number; // 乐谱本身（未点亮谱面）自发光强度，0=不发光
	lighting: LightSettings;
	// ── 环境 · 通用 ──
	device: DeviceMode;
	rt: boolean; // 光线追踪（实验：实时阴影）
	rise: number; // 凸起高度（世界单位；面板显示 ×100）
	theme: string; // 预设点亮主题
	// ── 运动 · 小球 ──
	ballSize: number; // 球半径 = 该倍数 × 一个谱线间距（main.ts 构建时实测）
	/** 小球落到符头的撞击粒子迸发（默认关） */
	hitFx: boolean;
	ballGlowStyle: BallGlowStyle; // 球光晕特效（three-glow-mesh）
	ballGlowRange: number; // 光晕范围（世界单位，外扩厚度）
	flightMs: number; // 下落时间（到达=点亮）
	bloomThreshold: number; // bloom 亮度阈值（高于此值才发光）
	/** 阈值自动钉在发光缓冲峰值下方：手动阈值一旦高于峰值，整层被高通滤成纯黑，
	 *  强度/半径全部空转（看着就像滑杆坏了）。关掉即完全手动态。 */
	bloomAutoThreshold: boolean;
	bloomRadius: number; // bloom 光晕半径（辉光扩散范围）
	ballLightIntensity: number; // 小球作为点光源的亮度
	// ── 运动 · 拖尾 ──
	trailFollowBall: boolean;
	trailColor: number; // 不跟随小球时的自定义拖尾色
	trailAlpha: number; // 拖尾透明度 0-1
	trailPct: number;
	trailIntensity: number;
	// ── 运动 · 点亮 ──
	litEnabled: boolean; // 音符点亮总开关（false = 不点亮任何音符）
	/** 点亮色跟随小球/路径色（默认开）：开着时下面的点亮颜色设置项隐藏 */
	litFollowBall: boolean;
	litColor: number; // 不跟随时的自定义点亮色
	litTie: LitMode; // 连音线点亮
	litSlur: LitMode; // 圆滑线点亮
	litFingering: LitMode; // 指法点亮
	litChordMark: LitMode; // 和弦标记点亮
	litLyric: LitMode; // 歌词点亮（只控制发光，不控制显示；显示与否在乐谱页管理）
	// ── 水面（暂未开放，保留状态兼容 main.ts） ──
	waterOn: boolean;
	waterAmp: number;
	waterSpeed: number;
	waterWaveLen: number;
	waterColor: number;
	trajShape: TrajShape; // 轨迹形状（UI 已并入默认抛物线，状态保留）
	jumpHeight: number;
	// ── 运动 · 路径（起点/终点线） ──
	/** 起点线离谱面（最左符头）的距离，SVG 用户单位；与第三页竖线拖拽同源 */
	termLeadGap: number;
	/** 终点线离谱面（最右符头）的距离，同上 */
	termTailGap: number;
	/** 起点高度跟随主路径弧高（jumpHeight × 段水平距离）；默认开 */
	termLeadHFollow: boolean;
	termTailHFollow: boolean;
	/** 不跟随时的绝对高度（×谱线间距） */
	termLeadH: number;
	termTailH: number;
	trackLine: GuideLineStyle;
	startLine: GuideLineStyle;
	endLine: GuideLineStyle;
	// 乐谱页路径多选（main.ts 导入曲子后更新 pathNames；空数组=全选）
	pathNames: string[];
	/** 每条路径的自定义色（null = 用连线页带过来的默认色）；小球与点亮共用同一条色 */
	pathColors: (number | null)[];
	pathDefaultColors: number[]; // 每条路径默认色（面板显示与恢复默认用）
	selectedPaths: number[];
	/** 逐路径数值覆盖（null/缺省 = 吃全局默认值）。选中多条且取值不一致时，
	 *  滑轨旁的输入框显示「多值」。 */
	pathNums: Partial<Record<PathNumKey, (number | null)[]>>;
	/** 逐路径字符串覆盖（null/缺省 = 吃全局默认值）：材质预设 / 光晕样式 */
	pathStrs: Partial<Record<PathStrKey, (string | null)[]>>;
	/** 逐路径布尔覆盖（null/缺省 = 吃全局默认值）：撞击粒子 */
	pathBools: Partial<Record<PathBoolKey, (boolean | null)[]>>;
	/** 修复页签的巡检调度（与外观无关，但同样要落盘） */
	repair: RepairSettings;
}

export interface SettingsPanelHandle {
	el: HTMLElement;
	refresh(): void;
	/** main.ts 派生出新的生效值后调用（自动阈值 / 钳位后的光晕半径），只回填显示 */
	syncDerived(): void;
}

/**
 * 可以「每条路径各一份」的数值项。bloom 全屏后处理、视距这类整幅画面共用的项不在此列。
 * rough/metal/trailPct 原本是全局值，本轮改造成逐路径可调；回落分别取
 * surf.matTune.ball.rough / surf.matTune.ball.metal / surf.trailPct（见 globalNumVal）。
 */
export type PathNumKey =
	| "ballSize"
	| "brightBall"
	| "glowBall"
	| "ballLightIntensity"
	| "ballGlowRange"
	| "brightLit"
	| "glowLit"
	| "ballRough"
	| "ballMetal"
	| "trailPct";
/** 逐路径字符串项：球材质预设（回落 surf.mat.ball.preset）、球光晕样式（回落 surf.ballGlowStyle） */
export type PathStrKey = "ballPreset" | "ballGlowStyle";
/** 逐路径布尔项：撞击粒子（回落 surf.hitFx） */
export type PathBoolKey = "hitFx";

// ── 小控件工厂 ────────────────────────────────────────────────
function row(label: string, control: HTMLElement): HTMLElement {
	const r = document.createElement("div");
	r.className = "sp-row";
	const s = document.createElement("span");
	s.textContent = label;
	r.append(s, control);
	return r;
}
/** 滑轨控件 = range + 可键入数值框（数值框兼作「多值」显示位） */
type SlideCtl = HTMLSpanElement & {
	range: HTMLInputElement;
	num: HTMLInputElement;
	/** 外部（main.ts 派生出的生效值）回填显示：只改视图，不回写状态、不触发 onInput */
	sync(v: number): void;
};
/** 数值框小数位：按 step 推（0.05→2 位，5→0 位） */
function numDecimals(step: number): number {
	return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
}
function slider(
	min: number,
	max: number,
	step: number,
	value: number,
	onInput: (v: number) => void,
	endless = false,
	multi = false,
): SlideCtl {
	const wrap = document.createElement("span") as SlideCtl;
	wrap.className = "sp-slide";
	const el = document.createElement("input");
	el.type = "range";
	el.min = String(min);
	el.max = String(max);
	el.step = String(step);
	el.value = String(value);
	const updateFill = setupSlider(el);
	const dec = numDecimals(step);
	const num = document.createElement("input");
	num.type = "text";
	num.inputMode = "decimal";
	num.title = t("sp.numHint");
	const show = (): void => {
		updateFill();
		if (multi) {
			num.className = "sp-numbox sp-numbox--multi";
			num.value = t("sp.multi");
			return;
		}
		num.className = "sp-numbox";
		num.value = String(+Number(el.value).toFixed(dec));
	};
	const commit = (): void => {
		const v = Number(num.value);
		if (!Number.isFinite(v)) {
			show();
			return;
		}
		const c = Math.min(Number(el.max), Math.max(Number(el.min), v));
		el.value = String(c);
		onInput(c);
		show();
	};
	num.addEventListener("focus", () => {
		if (multi) num.value = "";
		else num.select();
	});
	num.addEventListener("change", () => {
		if (num.value.trim() === "") show();
		else commit();
	});
	num.addEventListener("keydown", (e) => {
		if (e.key === "Enter") num.blur();
	});
	show();
	wrap.sync = (v): void => {
		el.value = String(
			Math.min(Number(el.max), Math.max(Number(el.min), v)),
		);
		show();
	};
	if (!endless) {
		el.addEventListener("input", () => {
			onInput(Number(el.value));
			show();
		});
		wrap.append(el, num);
		wrap.range = el;
		wrap.num = num;
		return wrap;
	}
	// 无极模式：轨道跨度 [max-min] 恒定不变；拖到端点不松鼠标继续向该方向拖时，
	// 整个 [min,max] 区间整体平移（min/max 同加减），滑块视觉卡在端点，实际值无限可调。
	let dragging = false;
	let startX = 0;
	let startValue = 0;
	let lo0 = 0;
	let hi0 = 0;
	let range = 0;
	el.addEventListener("pointerdown", (e) => {
		dragging = true;
		startX = e.clientX;
		startValue = Number(el.value);
		lo0 = Number(el.min);
		hi0 = Number(el.max);
		range = Math.max(1e-6, hi0 - lo0);
		try {
			el.setPointerCapture(e.pointerId);
		} catch {
			/* noop */
		}
	});
	el.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		const rect = el.getBoundingClientRect();
		const trackW = Math.max(1, rect.width);
		const delta = (e.clientX - startX) / trackW; // 轨道宽度的比例增量
		const rel = (startValue - lo0) / range + delta; // 滑块在轨道内的相对位置
		let lo: number;
		let value: number;
		if (rel < 0) {
			// 卡在最左：min/max 整体左移（同减）
			lo = lo0 + rel * range;
			value = lo;
		} else if (rel > 1) {
			// 卡在最右：min/max 整体右移（同加）
			lo = lo0 + (rel - 1) * range;
			value = lo + range;
		} else {
			lo = lo0;
			value = lo0 + rel * range;
		}
		el.min = String(lo);
		el.max = String(lo + range);
		el.value = String(value);
		onInput(value);
		show();
	});
	const endDrag = (): void => {
		dragging = false;
	};
	el.addEventListener("pointerup", endDrag);
	el.addEventListener("pointercancel", endDrag);
	wrap.append(el, num);
	wrap.range = el;
	wrap.num = num;
	return wrap;
}
function checkbox(
	checked: boolean,
	onInput: (v: boolean) => void,
): HTMLInputElement {
	const el = document.createElement("input");
	el.type = "checkbox";
	el.checked = checked;
	el.addEventListener("change", () => onInput(el.checked));
	return el;
}
/** 面板里的下拉一律走外壳自绘组件：原生 select 的弹层样式跨浏览器不一致，触屏上更是
 *  另一套系统 UI，跟不了主题（相机模式行早已这么做，这里补齐剩下几处）。 */
function selectOf(
	items: { v: string; l: string }[],
	cur: string,
	onChange: (v: string) => void,
): HTMLElement {
	const ctl = createSelect({ options: items, value: cur, onChange });
	ctl.el.classList.add("sp-select");
	return ctl.el;
}
function subhead(text: string): HTMLElement {
	const h = document.createElement("div");
	h.className = "sp-subhead";
	h.textContent = text;
	return h;
}
function note(text: string): HTMLElement {
	const n = document.createElement("div");
	n.className = "sp-note";
	n.textContent = text;
	return n;
}
function riskNote(text: string): HTMLElement {
	const n = document.createElement("div");
	n.className = "sp-note sp-rtrisk";
	n.textContent = text;
	return n;
}

/** 正等轴测正方体：折叠气泡与顶栏图标共用同一枚，两处看着就是同一个东西 */
const CUBE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" draggable="false"><path d="M12 2 21 7 12 12 3 7Z" fill="currentColor" opacity="1"/><path d="M3 7 12 12 12 22 3 17Z" fill="currentColor" opacity="0.48"/><path d="M21 7 12 12 12 22 21 17Z" fill="currentColor" opacity="0.72"/></svg>`;

export function createSettingsPanel(
	settings: SurfSettings,
	onChange: (patch: Partial<SurfSettings>) => void,
	onOpenCache?: () => void,
	isPlaying?: () => boolean,
	shell?: ShellHandle,
): SettingsPanelHandle {
	const host = document.createElement("div");
	host.className = "sp-host sp-host--wide";

	const win = createFloatingWindow({
		storageKey: "midee.float.surf3d",
		host,
		ariaLabel: t("sp.windowAria"),
		// 折叠气泡悬停/读屏用本窗自己的名字（3D 设置），不能落到外壳默认的「播放器」
		reopenLabel: () => t("sp.windowAria"),
		// 场景窗专属：折叠后的 reopen 气泡用正等轴测正方体（顶面亮、两侧面渐暗）
		reopenHTML: CUBE_ICON,
		anchor: {
			x: Math.max(60, window.innerWidth - 600),
			y: Math.max(70, (window.innerHeight - 560) / 2),
		},
		// 场景窗专属：四边粗线长按可调大小（限画布区）+ 播放闲置自动隐藏（未钉住时）
		// 宽度要给明确初值：窗体现在驱动 .sp-host 的宽度，缺了它就得靠延后一帧量尺寸兜底
		resizable: {
			min: { w: 320, h: 200 },
			max: { w: 900, h: 680 },
			default: { w: 560, h: 320 },
		},
		autoHide: { isPlaying: isPlaying ?? (() => false) },
	});

	// 交给外壳登记为可切换形态：默认仍是悬浮窗（现状），切到顶栏就是图标 + 下拉。
	shell?.dockFloat({
		id: "surf",
		titleKey: "sp.windowAria",
		iconHTML: CUBE_ICON,
		win,
		host,
	})

	// ── 标题行 ──
	const head = document.createElement("div");
	head.className = "sp-head";
	const title = document.createElement("strong");
	title.textContent = t("sp.title");
	head.append(win.grip, title, win.pinBtn, win.closeBtn);

	// ── 左右分栏骨架 ──
	const split = document.createElement("div");
	split.className = "sp-split";

	// 左列：分类树
	const nav = document.createElement("div");
	nav.className = "sp-nav";
	const NAV_ITEMS: { id: string; labelKey: string }[] = [
		{ id: "score", labelKey: "sp.nav.score" },
		{ id: "ball", labelKey: "sp.nav.ball" },
		{ id: "lit", labelKey: "sp.nav.lit" },
		{ id: "path", labelKey: "sp.nav.path" },
		{ id: "env", labelKey: "sp.nav.env" },
		{ id: "general", labelKey: "sp.nav.general" },
	];
	const navBtns: Record<string, HTMLButtonElement> = {};
	for (const it of NAV_ITEMS) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "sp-nav__btn";
		b.textContent = t(it.labelKey);
		b.addEventListener("click", () => showPage(it.id));
		nav.append(b);
		navBtns[it.id] = b;
	}

	// 右列：内容区
	const content = document.createElement("div");
	content.className = "sp-content";

	split.append(nav, content);
	host.append(head, split);

	// ── 悬浮弹层（材质下拉 / 颜色下拉窗共用：fixed 挂在 body，避免被滚动区裁剪） ──
	let popEl: HTMLElement | null = null;
	let popCleanup: (() => void) | null = null;
	function closePop(): void {
		popEl?.remove();
		popEl = null;
		popCleanup?.();
		popCleanup = null;
	}
	function openPop(anchor: HTMLElement, pop: HTMLElement): void {
		closePop();
		document.body.append(pop);
		const r = anchor.getBoundingClientRect();
		// 用弹窗真实宽度定位：取色面板比锚点宽，按锚点宽算会被视口右边缘裁掉
		const w = Math.max(240, r.width, pop.offsetWidth);
		const spaceBelow = window.innerHeight - r.bottom - 16;
		const openUp = spaceBelow < 240 && r.top > spaceBelow;
		pop.style.minWidth = `${w}px`;
		pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
		pop.style.maxHeight = `${Math.max(160, Math.min(360, openUp ? r.top - 16 : spaceBelow))}px`;
		if (openUp) pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
		else pop.style.top = `${r.bottom + 4}px`;
		const onDown = (e: PointerEvent): void => {
			const target = e.target as Node;
			if (pop.contains(target) || anchor.contains(target)) return;
			closePop();
		};
		const onScroll = (e: Event): void => {
			const target = e.target as Node | null;
			if (target && pop.contains(target)) return;
			closePop();
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") closePop();
		};
		document.addEventListener("pointerdown", onDown, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", closePop);
		document.addEventListener("keydown", onKey);
		popCleanup = () => {
			document.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", closePop);
			document.removeEventListener("keydown", onKey);
		};
		popEl = pop;
		bringToFront(pop);
	}
	function ddItem(
		label: string,
		active: boolean,
		title: string,
		onPick: () => void,
		depth = 0,
	): HTMLButtonElement {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "sp-dditem" + (active ? " sp-dditem--on" : "");
		b.textContent = label;
		if (title) b.title = title;
		if (depth) b.style.paddingLeft = `${8 + depth * 10}px`;
		b.addEventListener("click", onPick);
		return b;
	}
	function ddSec(text: string): HTMLElement {
		const s = document.createElement("div");
		s.className = "sp-ddsec";
		s.textContent = text;
		return s;
	}
	function ddSep(): HTMLElement {
		const d = document.createElement("div");
		d.className = "sp-ddsep";
		return d;
	}

	// ── 颜色下拉窗（统一）：自定义取色 + 跟随其他元素（可同步/单次）+ 恢复默认 ──
	// 跟随列表自动来自 ColorBus；自定义色变色时广播到 ColorBus（成为可跟随源）。
	interface ColorChipOpts {
		value: number; // 当前颜色（hex）
		label?: string; // 订阅登记用的稳定键
		busId?: string; // 自己在 ColorBus 的 id（提供跟随列表 + 自定义色时广播）
		busName?: string; // 跟随列表里显示的名字：填 i18n key，显示时 t()（路径名这类用户数据直接填原文，t() 缺 key 会原样回退）
		defaultColor: number; // 恢复默认时回落的颜色
		onChange: (v: number) => void;
		/** 「恢复默认」的自定义行为（路径色要置回 null 各回各的默认，而不是写同一个色） */
		onReset?: () => void;
		/** 作用域内各路径的当前值：>1 个不同值时 chip 显示「多值」，不写回（不动就不会被刷掉） */
		multi?: () => number[];
		lg?: boolean;
	}
	/** 跟随订阅登记在面板级：chip 因切页重建时替换掉自己那条，不再层层叠加 */
	const followRegistry = new Map<string, () => void>();
	function colorChip(o: ColorChipOpts): HTMLButtonElement {
		if (o.busId && o.busName) ColorBus.register(o.busId, o.busName, o.value);
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "sp-chip" + (o.lg ? " sp-chip--lg" : "");
		const sw = document.createElement("span");
		sw.className = "sp-chip__sw";
		const lab = document.createElement("span");
		lab.className = "sp-chip__lab";
		const caret = document.createElement("span");
		caret.className = "sp-chip__caret";
		caret.textContent = "▾";
		btn.append(sw, lab, caret);
		const hexStr = (v: number): string =>
			`#${v.toString(16).padStart(6, "0").toUpperCase()}`;
		let liveUnsub: (() => void) | null = null;
		const sync = (): void => {
			const many = o.multi?.() ?? [];
			if (many.length > 1) {
				// 作用域里各路径取值不一致 → 显示多个值；不点它就不会被刷成同一个
				sw.style.background = hexStr(many[0]!);
				lab.textContent = "";
				const tag = document.createElement("span");
				tag.className = "sp-multi";
				tag.textContent = t("sp.multiTag", { n: many.length });
				lab.append(tag);
				for (const c of many) {
					const d = document.createElement("i");
					d.className = "sp-swatch";
					d.style.background = hexStr(c);
					lab.append(d);
				}
				return;
			}
			sw.style.background = hexStr(o.value);
			lab.textContent = hexStr(o.value);
		};
		const applyCustom = (c: number): void => {
			o.value = c; // 同步 chip 显示（否则标签一直停在打开面板时的旧色）
			if (liveUnsub) {
				liveUnsub();
				liveUnsub = null;
			}
			o.onChange(c);
			if (o.busId) ColorBus.publish(o.busId, c); // 自己的颜色广播
			sync();
		};
		sync();
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (popEl) {
				closePop();
				return;
			}
			const pop = document.createElement("div");
			pop.className = "sp-ddpop sp-ddpop--color";
			// 第一行：跟随下拉 + 同步开关
			const frow = document.createElement("div");
			frow.className = "sp-crow";
			const syncCk = document.createElement("input");
			syncCk.type = "checkbox";
			syncCk.title = t("sp.syncHint");
			const syncLab = document.createElement("span");
			syncLab.textContent = t("sp.sync");
			syncLab.style.color = "var(--sh-muted)";
			// 跟随下拉走外壳自绘组件（与面板其余下拉一致）；变更按同步开关决定实时订阅或取一次快照
			const fopts = [{ v: "", l: t("sp.noFollow") }];
			for (const f of ColorBus.listExclude(o.busId ?? "")) fopts.push({ v: f.id, l: t(f.name) });
			const fsel = selectOf(fopts, "", (target) => {
				if (liveUnsub) {
					liveUnsub();
					liveUnsub = null;
				}
				if (!target) return;
				if (syncCk.checked) {
					const key = o.busId ?? o.label ?? target;
					followRegistry.get(key)?.();
					liveUnsub = ColorBus.subscribe(target, (c) => {
						o.value = c; // 回写后 sync() 才拿得到新色（否则色块/文字一直停在旧值）
						o.onChange(c);
						sync();
					});
					followRegistry.set(key, liveUnsub);
				} else {
					const snap = ColorBus.peek(target);
					if (snap !== undefined) {
						o.value = snap;
						o.onChange(snap);
						sync();
					}
				}
			});
			fsel.style.flex = "1";
			frow.append(fsel, syncCk, syncLab);
			pop.append(frow);
			// 自定义取色：自绘面板（拖动只改预览小方块，点「确认」才提交）
			const busColors = ColorBus.listExclude(o.busId ?? "")
				.map((f) => ColorBus.peek(f.id))
				.filter((c): c is number => c !== undefined);
			const picker = createColorPicker({
				value: o.value,
				presets: busColors.length ? [{ label: t("sp.presets"), colors: busColors }] : [],
				onCommit: (c) => {
					closePop();
					applyCustom(c);
				},
			});
			pop.append(picker.el);
			pop.append(ddSep());
			pop.append(
				ddItem(t("sp.resetDefault"), false, "", () => {
					closePop();
					if (o.onReset) o.onReset();
					else applyCustom(o.defaultColor);
				}),
			);
			openPop(btn, pop);
		});
		return btn;
	}
	function colorRow(
		label: string,
		base: Omit<ColorChipOpts, "lg">,
	): HTMLElement {
		return row(label, colorChip(base));
	}

	// ── 路径作用域：面板顶部的「全选 / 路径1 / 路径2」决定颜色改谁 ──
	// selectedPaths 三态：[] = 全选；[-1] = 全不选（调分轨项不影响任何轨道）；
	// 其余非空数组 = 选中这些路径。[-1] 只在 UI 层用，main.ts 不读 selectedPaths。
	function pathScope(): number[] {
		const n = settings.pathNames.length;
		if (!n) return [];
		if (settings.selectedPaths.length === 1 && settings.selectedPaths[0] === -1) return [];
		const sel = settings.selectedPaths.filter((i) => i >= 0 && i < n);
		return sel.length ? sel : Array.from({ length: n }, (_, i) => i);
	}
	/** 全选状态：空数组，或手动把所有路径都选上（用于全选按钮同步高亮） */
	function isAllSelected(): boolean {
		const n = settings.pathNames.length;
		if (!n) return true;
		if (settings.selectedPaths.length === 1 && settings.selectedPaths[0] === -1) return false;
		if (settings.selectedPaths.length === 0) return true;
		const sel = settings.selectedPaths.filter((i) => i >= 0 && i < n);
		return sel.length === n;
	}
	function scopeLabel(): string {
		const n = settings.pathNames.length;
		if (!n) return t("sp.allPaths");
		const sel = pathScope();
		return sel.length === n
			? t("sp.allPaths")
			: sel.map((i) => settings.pathNames[i]).join(t("sp.listSep"));
	}
	/** 作用域当前色：任一路径有自定义色就显示它，否则显示该路径默认色 */
	function scopeColor(): number {
		const sel = pathScope();
		for (const i of sel) {
			const c = settings.pathColors[i];
			if (c != null) return c;
		}
		return settings.pathDefaultColors[sel[0] ?? 0] ?? 0x9aa7b5;
	}
	/** 作用域内各路径的「生效色」：自定义优先，否则连线页带过来的默认色 */
	function scopeColors(): number[] {
		return pathScope().map(
			(i) =>
				settings.pathColors[i] ??
				settings.pathDefaultColors[i] ??
				0x9aa7b5,
		);
	}
	/** 路径多选栏（全选 / 路径1 / 路径2 …）——小球页和点亮页共用。
	 *  全选按钮固定在栏首不随横向滚动；点击在「全选」/「全不选」间切换；
	 *  用户手动逐个选完所有路径时，全选按钮也同步高亮。 */
	function pathBar(): HTMLElement | null {
		if (settings.pathNames.length === 0) return null;
		const bar = document.createElement("div");
		bar.className = "sp-pathbar";
		const all = isAllSelected();
		const allBtn = document.createElement("button");
		allBtn.type = "button";
		allBtn.className = "sp-pathbtn sp-pathbtn--all" + (all ? " sp-pathbtn--on" : "");
		allBtn.textContent = all ? t("sp.deselectAll") : t("sp.selectAll");
		allBtn.addEventListener("click", () => {
			onChange({ selectedPaths: all ? [-1] : [] });
			renderPage();
		});
		bar.append(allBtn);
		const scroll = document.createElement("div");
		scroll.className = "sp-pathbar__scroll";
		const scope = pathScope();
		settings.pathNames.forEach((name, i) => {
			const b = document.createElement("button");
			b.type = "button";
			const on = scope.includes(i);
			b.className = "sp-pathbtn" + (on ? " sp-pathbtn--on" : "");
			b.textContent = name;
			b.addEventListener("click", () => {
				const raw = settings.selectedPaths;
				// 从「全不选」(-1) 起步时，集合从空开始，避免 -1 混进结果
				const set =
					raw.length === 1 && raw[0] === -1
						? new Set<number>()
						: new Set(raw.filter((x) => x >= 0));
				if (set.has(i)) set.delete(i);
				else set.add(i);
				onChange({ selectedPaths: Array.from(set) });
				renderPage();
			});
			scroll.append(b);
		});
		bar.append(scroll);
		return bar;
	}
	/** PathNumKey → 全局回落值：rough/metal/trailPct 在嵌套字段里，单独映射 */
	const NUM_GLOBAL: Record<PathNumKey, (s: SurfSettings) => number> = {
		ballSize: (s) => s.ballSize,
		brightBall: (s) => s.brightBall,
		glowBall: (s) => s.glowBall,
		ballLightIntensity: (s) => s.ballLightIntensity,
		ballGlowRange: (s) => s.ballGlowRange,
		brightLit: (s) => s.brightLit,
		glowLit: (s) => s.glowLit,
		ballRough: (s) => s.matTune.ball.rough,
		ballMetal: (s) => s.matTune.ball.metal,
		trailPct: (s) => s.trailPct,
	};
	function globalNum(key: PathNumKey): number {
		return NUM_GLOBAL[key](settings);
	}
	/** 作用域内各路径的生效值（去重）：>1 个就说明现在是"多值"状态 */
	function scopeVals(key: PathNumKey): number[] {
		const g = globalNum(key);
		const arr = settings.pathNums[key];
		return [...new Set(pathScope().map((i) => arr?.[i] ?? g))];
	}
	/** 把值写进作用域内的每条路径（不动它不会被刷，动了就把这几条刷成同一个）。
	 *  rerender=false 给拖动中的滑轨用：重建面板会把 range 元素整个换掉，浏览器的隐式
	 *  指针捕获随之断掉，结果滑块只能挪一个像素就卡住。值照常实时下发，松手再重建。 */
	function writeNums(key: PathNumKey, v: number, rerender = true): void {
		const arr = [...(settings.pathNums[key] ?? [])];
		for (const i of pathScope()) arr[i] = v;
		onChange({ pathNums: { ...settings.pathNums, [key]: arr } });
		if (rerender) renderPage();
	}
	/** 逐路径数值滑轨：多值时滑轨旁的输入框显示「多值」，键入同样落到作用域 */
	function pathSlider(
		label: string,
		key: PathNumKey,
		min: number,
		max: number,
		step: number,
	): HTMLElement {
		const vals = scopeVals(key);
		const ctl = slider(
			min,
			max,
			step,
			vals[0] ?? globalNum(key),
			(v) => writeNums(key, v, false),
			false,
			vals.length > 1,
		);
		// 松手才重建（不是 change）：range 的 change 在键盘方向键下也会逐次触发，
		// 重建会把刚按过方向键的滑轨换成新的节点 → 按一次丢一次焦点，键盘没法连续微调。
		// 拖动结束时浏览器有隐式指针捕获，pointerup 一定落在这根滑轨上。
		ctl.range.addEventListener("pointerup", () => renderPage());
		// 键盘方向键不会 pointerup，用「离开这个滑轨」作为收尾时机：
		// 免得调完值后「多值」标记一直停在旧状态。
		ctl.range.addEventListener("blur", () => renderPage());
		ctl.num.addEventListener("change", () => renderPage());
		return row(
			label, // 作用域由顶部路径栏表示，这里不再重复挂后缀
			ctl,
		);
	}
	// ── 逐路径字符串（材质预设 / 光晕样式）：原本全局，本轮改造成分轨可调 ──
	const STR_GLOBAL: Record<PathStrKey, (s: SurfSettings) => string> = {
		ballPreset: (s) => s.mat.ball.preset,
		ballGlowStyle: (s) => s.ballGlowStyle,
	};
	function globalStr(key: PathStrKey): string {
		return STR_GLOBAL[key](settings);
	}
	/** 作用域内各路径的生效字符串（去重）：>1 个即"多值" */
	function scopeStrs(key: PathStrKey): string[] {
		const g = globalStr(key);
		const arr = settings.pathStrs[key];
		return [...new Set(pathScope().map((i) => arr?.[i] ?? g))];
	}
	function writeStrs(key: PathStrKey, v: string, rerender = true): void {
		const arr = [...(settings.pathStrs[key] ?? [])];
		for (const i of pathScope()) arr[i] = v;
		onChange({ pathStrs: { ...settings.pathStrs, [key]: arr } });
		if (rerender) renderPage();
	}
	/** 逐路径下拉：多值时 label 标注，选值即把作用域内所有路径统一 */
	function pathSelect(
		label: string,
		key: PathStrKey,
		items: { v: string; l: string }[],
	): HTMLElement {
		const vals = scopeStrs(key);
		const multi = vals.length > 1;
		const ctl = selectOf(items, vals[0] ?? globalStr(key), (v) =>
			writeStrs(key, v, false),
		);
		ctl.addEventListener("change", () => renderPage());
		return row(multi ? `${label} · ${t("sp.multi")}` : label, ctl);
	}
	// ── 逐路径布尔（撞击粒子）：原本全局，本轮改造成分轨可调 ──
	const BOOL_GLOBAL: Record<PathBoolKey, (s: SurfSettings) => boolean> = {
		hitFx: (s) => s.hitFx,
	};
	function globalBool(key: PathBoolKey): boolean {
		return BOOL_GLOBAL[key](settings);
	}
	function scopeBools(key: PathBoolKey): boolean[] {
		const g = globalBool(key);
		const arr = settings.pathBools[key];
		return [...new Set(pathScope().map((i) => arr?.[i] ?? g))];
	}
	function writeBools(key: PathBoolKey, v: boolean, rerender = true): void {
		const arr = [...(settings.pathBools[key] ?? [])];
		for (const i of pathScope()) arr[i] = v;
		onChange({ pathBools: { ...settings.pathBools, [key]: arr } });
		if (rerender) renderPage();
	}
	/** 逐路径复选框：多值时半选（indeterminate），点击即把作用域内所有路径统一 */
	function pathCheckbox(label: string, key: PathBoolKey): HTMLElement {
		const vals = scopeBools(key);
		const multi = vals.length > 1;
		const checked = multi ? false : (vals[0] ?? globalBool(key));
		const ctl = checkbox(checked, (c) => writeBools(key, c, false));
		if (multi) ctl.indeterminate = true;
		ctl.addEventListener("change", () => renderPage());
		return row(multi ? `${label} · ${t("sp.multi")}` : label, ctl);
	}
	function pathColorRow(): HTMLElement {
		const sel = pathScope();
		const first = sel[0] ?? 0;
		// 只选了一条路径 → 用这条路径自己的总线 id（能被别处跟随、也不会和另一页串味）
		const solo = sel.length === 1;
		const write = (vals: (number | null)[]) => {
			onChange({ pathColors: vals });
			renderPage();
		};
		return row(
			t("sp.colorScoped", { scope: scopeLabel() }),
			colorChip({
				value: scopeColor(),
				label: solo ? `path.${first}` : "path.color",
				busId: solo ? `path.${first}` : "path.color",
				busName: solo ? (settings.pathNames[first] ?? t("sp.path")) : "sp.bus.pathColor",
				defaultColor: settings.pathDefaultColors[first] ?? 0x9aa7b5,
				// 选中多条路径且颜色不一致 → chip 显示「多值 N」+ 各色块，不刷掉任何一条
				multi: () => [...new Set(scopeColors())],
				onChange: (v) => {
					const next = [...settings.pathColors];
					for (const i of sel) next[i] = v;
					write(next);
				},
				onReset: () => {
					const next = [...settings.pathColors];
					for (const i of sel) next[i] = null; // 各回各自的连线页默认色
					write(next);
				},
				lg: true,
			}),
		);
	}

	// ── 页面切换 ──
	// 默认页要落在 NAV_ITEMS 里真实存在的项上：原来初始化成 "material"，
	// 而导航里没有这一项 → renderPage 走 else 分支显示「通用」，但六个 tab 一个都不高亮。
	let activePage = "general";
	// main.ts 会派生出「生效值」的两项（自动阈值 / 钳到 [0,1] 的光晕半径）：
	// 记下控件句柄，派生后单独回填，不整页重绘（重绘会打断正在拖的滑轨）
	let bloomThrCtl: SlideCtl | null = null;
	let bloomRadCtl: SlideCtl | null = null;
	let envTab: "sky" | "ground" | "ambient" = "sky";
	// 光源开关是用 keyIntensity 表达的（关 = 写 0），所以「关」这个动作本身会把
	// 用户设定的强度抹掉，重开时只能凭一个写死的数还原。这里记住最后一次有效强度。
	let keyOnIntensity = 1.2;
	let motionTab: "ball" | "trail" | "lit" | "track" = "ball";
	function showPage(id: string): void {
		activePage = id;
		renderPage();
	}
	function renderPage(): void {
		closePop();
		bloomThrCtl = null;
		bloomRadCtl = null;
		for (const k of Object.keys(navBtns))
			navBtns[k]!.classList.toggle("sp-nav__btn--on", k === activePage);
		content.textContent = "";
		if (activePage === "score") renderScorePage(content);
		else if (activePage === "ball") renderMotionPage(content, "ball");
		else if (activePage === "lit") renderMotionPage(content, "lit");
		else if (activePage === "path") renderMotionPage(content, "traj");
		else if (activePage === "env") renderEnvPage(content);
		else renderGeneral(content);
	}

	/** 顶部一排子 tabs（环境：通用/光照/水面/雾效；运动：小球/拖尾/点亮/轨迹线） */
	function subTabs(
		root: HTMLElement,
		items: { id: string; label: string; disabled?: boolean }[],
		cur: string,
		onPick: (id: string) => void,
	): void {
		const wrap = document.createElement("div");
		wrap.className = "sp-objtabs";
		for (const o of items) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "sp-objtab";
			b.textContent = o.label;
			if (o.disabled) {
				b.disabled = true;
				b.style.opacity = "0.4";
				b.title = t("sp.soon");
			} else if (cur === o.id) b.classList.add("sp-objtab--on");
			b.addEventListener("click", () => onPick(o.id));
			wrap.append(b);
		}
		root.append(wrap);
	}

	// ── 材质页：对象 tabs + 一行「颜色下拉窗 + 材质下拉」+ 滑杆 ──
	function renderMaterialPage(root: HTMLElement): void {
		closePop();
		root.textContent = "";
		ensureTexList(); // 网络贴图列表后台拉取，就绪后自动重渲本页
		// 对象选择 tabs
		const objTabs = document.createElement("div");
		objTabs.className = "sp-objtabs";
		const OBJ_ITEMS: {
			id: MatObject | "sky";
			labelKey: string;
			soon?: boolean;
		}[] = [
			{ id: "score", labelKey: "sp.nav.score" },
			{ id: "ground", labelKey: "sp.obj.ground" },
			{ id: "ball", labelKey: "sp.nav.ball" },
			{ id: "sky", labelKey: "sp.env.sky", soon: true },
		];
		for (const o of OBJ_ITEMS) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "sp-objtab";
			b.textContent = t(o.labelKey);
			if (o.soon) {
				b.disabled = true;
				b.style.opacity = "0.4";
				b.title = t("sp.soon");
			} else if (settings.selectedObject === o.id)
				b.classList.add("sp-objtab--on");
			b.addEventListener("click", () => {
				onChange({ selectedObject: o.id });
				renderPage();
			});
			objTabs.append(b);
		}
		root.append(objTabs);

		const obj = settings.selectedObject;
		if (obj !== "score" && obj !== "ground" && obj !== "ball") {
			root.append(note(t("sp.objSoon")));
			return;
		}
		const cfg = settings.mat[obj];

		// 组内小补丁：改 ObjMatConfig 的一个字段
		const patchCfg = (over: Partial<ObjMatConfig>): void => {
			onChange({ mat: { ...settings.mat, [obj]: { ...cfg, ...over } } });
		};
		const rerender = (): void => renderPage();

		// ── 一行：颜色下拉窗（圆角方形色块 + 文字）+ 材质下拉（圆角矩形） ──
		const matRow = document.createElement("div");
		matRow.className = "sp-matrow";

		// 各对象底色（乐谱/背景/小球），颜色自动广播到 ColorBus 供其他元素跟随
		const BUS_NAME: Record<MatObject, string> = {
			score: "sp.bus.scoreBase",
			ground: "sp.bus.groundBase",
			ball: "sp.bus.ballBase",
		};
		const chip = colorChip({
			value: cfg.color ?? baseColorOf(cfg.preset),
			busId: `mat.${obj}`,
			busName: BUS_NAME[obj],
			defaultColor: obj === "ball" ? 0x9aa7b5 : baseColorOf(cfg.preset),
			onChange: (v) => patchCfg({ color: v }),
			lg: true,
		});
		chip.title = t("sp.baseColorHint");
		matRow.append(chip);

		const ddWrap = document.createElement("div");
		ddWrap.className = "sp-matdd";
		const ddBtn = document.createElement("button");
		ddBtn.type = "button";
		ddBtn.className = "sp-matdd__btn";
		const ddLabel = document.createElement("span");
		ddLabel.className = "sp-matdd__label";
		ddLabel.textContent = currentMatLabel(cfg);
		const ddCaret = document.createElement("span");
		ddCaret.className = "sp-matdd__caret";
		ddCaret.textContent = "▾";
		ddBtn.append(ddLabel, ddCaret);
		ddWrap.append(ddBtn);
		matRow.append(ddWrap);
		root.append(matRow);

		ddBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (popEl) {
				closePop();
				return;
			}
			openMatPop(ddBtn, obj, cfg, rerender);
		});

		// 下方调节区
		const adj = document.createElement("div");
		adj.className = "sp-adj";

		// 贴图缩放：1:1 覆盖不拉伸（等比重复），仅网络贴图模式显示
		if (cfg.source === "network" && cfg.tex) {
			adj.append(
				row(
					t("sp.texScale"),
					slider(1, 12, 0.5, cfg.texScale ?? 4, (v) =>
						patchCfg({ texScale: v }),
					true),
				),
			);
			adj.append(note(t("sp.texScaleNote")));
		}

		// 物理参数：按材质类型自洽显示
		const tune = settings.matTune[obj];
		const patchTune = (over: Partial<MatTune>): void =>
			onChange({
				matTune: { ...settings.matTune, [obj]: { ...tune, ...over } },
			});
		if (!isGlassPreset(cfg.preset)) {
			adj.append(
				row(
					t("sp.rough"),
					slider(0, 1, 0.01, tune.rough, (v) => patchTune({ rough: v })),
				),
			);
			adj.append(
				row(
					t("sp.metal"),
					slider(0, 1, 0.01, tune.metal, (v) => patchTune({ metal: v })),
				),
			);
		} else {
			adj.append(
				row(
					t("sp.opacity"),
					slider(0, 1, 0.01, tune.trans, (v) => patchTune({ trans: v })),
				),
			);
		}
		// 乐谱点亮发光已迁到「自发光」页（收编重复控件）
		root.append(adj);
	}

	// ── 材质下拉：预设 + 网络贴图（Poly Haven 三级分类折叠） ──────
	let texList: PHAsset[] | null = null;
	let texState: "idle" | "loading" | "failed" | "ready" = "idle";
	const texById = new Map<string, PHAsset>();

	function presetLabel(p: AnyPreset): string {
		return t(`sp.preset.${p}`);
	}

	/** 下拉按钮上显示的名字：预设名 / 中文贴图名 + 分类短名 */
	function currentMatLabel(cfg: ObjMatConfig): string {
		if (cfg.source !== "network") return presetLabel(cfg.preset);
		const a = texById.get(cfg.tex);
		if (a) return `${texNameZh(a.name)} · ${catLeafZh(a.category)}`;
		// Poly Haven 清单未加载时，用资源管理器里已下载贴图的中文名兜底
		const stored = listResources("texture").find((s) => s.id === cfg.tex);
		if (stored) return stored.label ?? stored.name;
		if (!cfg.tex) return t("sp.pickTex");
		return texState === "failed" ? cfg.tex : t("sp.texLoading");
	}

	/** 构建「材质下拉」按钮（预设 + 网络贴图），供乐谱/地面/小球页复用 */
	function buildMatDropdown(
		obj: "score" | "ground" | "ball",
		cfg: ObjMatConfig,
		rerender: () => void,
	): HTMLElement {
		const ddWrap = document.createElement("div");
		ddWrap.className = "sp-matdd";
		const ddBtn = document.createElement("button");
		ddBtn.type = "button";
		ddBtn.className = "sp-matdd__btn";
		const ddLabel = document.createElement("span");
		ddLabel.className = "sp-matdd__label";
		ddLabel.textContent = currentMatLabel(cfg);
		const ddCaret = document.createElement("span");
		ddCaret.className = "sp-matdd__caret";
		ddCaret.textContent = "▾";
		ddBtn.append(ddLabel, ddCaret);
		ddWrap.append(ddBtn);
		ddBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (popEl) { closePop(); return; }
			openMatPop(ddBtn, obj, cfg, rerender);
		});
		return ddWrap;
	}

	function ensureTexList(): void {
		if (texState !== "idle") return;
		texState = "loading";
		fetchTextureList()
			.then((list) => {
				texList = list;
				texById.clear();
				for (const a of list) texById.set(a.id, a);
				texState = "ready";
			})
			.catch(() => {
				texState = "failed";
			})
			.finally(() => {
				// 网络贴图列表是异步拉的，回来时必须把「材质」下拉重灌一次，否则下拉里
				// 永远只有预设、看不到贴图。条件要按当前页判断：原来写死 "material"
				// （那是个已经不存在页签的页面）→ 等于永远不刷新。
				// 只在真的摆了材质下拉的两页刷新，且绝不无脑重建（会把拖动中的滑轨换掉）。
				if (activePage === "score" || activePage === "env") renderPage();
			});
	}

	/** 打开材质下拉浮层（预设段 + 横线分隔 + 网络贴图三级折叠段） */
	function openMatPop(
		btn: HTMLElement,
		obj: "score" | "ground" | "ball",
		cfg: ObjMatConfig,
		rerender: () => void,
	): void {
		const pop = document.createElement("div");
		pop.className = "sp-ddpop";

		const pickPreset = (v: AnyPreset): void => {
			closePop();
			onChange({
				mat: {
					...settings.mat,
					[obj]: { ...cfg, source: "preset", preset: v },
				},
				matTune: { ...settings.matTune, [obj]: presetDefaultTune(v) },
			});
			rerender();
		};
		const pickTex = (id: string): void => {
			closePop();
			onChange({
				mat: { ...settings.mat, [obj]: { ...cfg, source: "network", tex: id } },
			});
			rerender();
		};

		// ── 预设段 ──
		pop.append(ddSec(t("sp.presets")));
		for (const o of obj === "ground" ? SURFACE_OPTIONS : SCORE_BALL_OPTIONS) {
			pop.append(
				ddItem(
					t(`sp.preset.${o.value}`),
					cfg.source === "preset" && cfg.preset === o.value,
					"",
					() => pickPreset(o.value),
				),
			);
		}

		// ── 横线分隔 ──
		pop.append(ddSep());

		// ── 网络贴图段（只显示已下载的；未下载的到「下载资源」获取） ──
		const dlTexIds = new Set(listDownloaded("texture").map((s) => s.id));
		// 当前选中的贴图即使未下载也保留（避免选中项从列表消失）
		const curTex = cfg.source === "network" ? cfg.tex : null;
		const visibleTex = texList
			? texList.filter((a) => dlTexIds.has(a.id) || a.id === curTex)
			: null;
		pop.append(
			ddSec(
				visibleTex
					? t("sp.netTexCount", { n: visibleTex.length })
					: t("sp.netTex"),
			),
		);
		if (!texList) {
			// Poly Haven 清单尚未加载时，用资源管理器里已下载的贴图兜底展示
			// （只有 id/中文名/一级分组，无三级分类路径，故平铺展示）。
			const fallback = listResources("texture").filter(
				(s) => dlTexIds.has(s.id) || s.id === curTex,
			);
			if (fallback.length) {
				const groups = new Map<string, typeof fallback>();
				for (const s of fallback) {
					const g = s.group ?? "";
					if (!groups.has(g)) groups.set(g, []);
					groups.get(g)!.push(s);
				}
				for (const [g, rs] of [...groups.entries()].sort((a, b) =>
					a[0].localeCompare(b[0], "zh"),
				)) {
					const d = document.createElement("details");
					d.className = "sp-ddgrp";
					const s = document.createElement("summary");
					s.className = "sp-ddgrp__head";
					const nm = document.createElement("span");
					nm.className = "sp-ddgrp__name";
					nm.textContent = g || t("sp.uncategorized");
					const cnt = document.createElement("span");
					cnt.className = "sp-ddgrp__cnt";
					cnt.textContent = String(rs.length);
					s.append(nm, cnt);
					d.append(s);
					for (const r of rs.sort((x, y) =>
						(x.label ?? x.name).localeCompare(y.label ?? y.name, "zh"),
					)) {
						d.append(
							ddItem(
								r.label ?? r.name,
								cfg.source === "network" && cfg.tex === r.id,
								r.id,
								() => pickTex(r.id),
								1,
							),
						);
					}
					pop.append(d);
				}
			} else {
				pop.append(
					note(
						texState === "failed"
							? t("sp.texFailed")
							: t("sp.texListLoading"),
					),
				);
			}
		} else if (!visibleTex?.length) {
			const noTex = document.createElement("div");
			noTex.className = "sp-note";
			const pre = document.createElement("span");
			pre.textContent = t("sp.noTexPre");
			const link = document.createElement("button");
			link.type = "button";
			link.className = "sp-link";
			link.textContent = t("cache.title");
			link.addEventListener("click", () => onOpenCache?.());
			const post = document.createElement("span");
			post.textContent = t("sp.noTexPost");
			noTex.append(pre, link, post);
			pop.append(noTex);
		} else {
			interface Grp {
				zh: string;
				count: number;
				children: Map<string, Grp>;
				items: PHAsset[];
			}
			const tops = new Map<string, Grp>();
			const zhOf = (key: string): string =>
				key === "__other" ? t("sp.uncategorized") : catLeafZh(key);
			for (const a of visibleTex) {
				let segs = (a.category || "").split("/").filter(Boolean);
				if (!segs.length) segs = ["__other"];
				let map = tops;
				let g: Grp | null = null;
				for (let i = 0; i < segs.length; i++) {
					const key = segs.slice(0, i + 1).join("/");
					let next = map.get(key);
					if (!next) {
						next = { zh: zhOf(key), count: 0, children: new Map(), items: [] };
						map.set(key, next);
					}
					next.count++;
					g = next;
					map = next.children;
				}
				g?.items.push(a);
			}
			const buildGroups = (
				map: Map<string, Grp>,
				depth: number,
			): DocumentFragment => {
				const frag = document.createDocumentFragment();
				const arr = [...map.values()].sort(
					(x, y) => y.count - x.count || x.zh.localeCompare(y.zh, "zh"),
				);
				for (const g of arr) {
					const d = document.createElement("details");
					d.className = "sp-ddgrp";
					const s = document.createElement("summary");
					s.className = "sp-ddgrp__head";
					s.style.paddingLeft = `${4 + depth * 10}px`;
					const nm = document.createElement("span");
					nm.className = "sp-ddgrp__name";
					nm.textContent = g.zh;
					const cnt = document.createElement("span");
					cnt.className = "sp-ddgrp__cnt";
					cnt.textContent = String(g.count);
					s.append(nm, cnt);
					d.append(s);
					if (g.children.size) d.append(buildGroups(g.children, depth + 1));
					for (const a of [...g.items].sort((x, y) =>
						x.name.localeCompare(y.name, "zh"),
					)) {
						d.append(
							ddItem(
								texNameZh(a.name),
								cfg.source === "network" && cfg.tex === a.id,
								`${a.name} · ${catPathZh(a.category)}`,
								() => pickTex(a.id),
								depth + 1,
							),
						);
					}
					frag.append(d);
				}
				return frag;
			};
			pop.append(buildGroups(tops, 0));
		}

		openPop(btn, pop);
	}

	// ── 环境页：天空 / 地面 / 环境 三按钮 ──
	function renderEnvPage(root: HTMLElement, fixedTab?: string): void {
		closePop();
		root.textContent = "";
		if (fixedTab) {
			envTab = fixedTab as typeof envTab;
		} else {
			subTabs(
				root,
				[
					{ id: "sky", label: t("sp.env.sky") },
					{ id: "ground", label: t("sp.env.ground") },
					{ id: "ambient", label: t("sp.env.ambient") },
				],
				envTab,
				(id) => {
					envTab = id as typeof envTab;
					renderPage();
				},
			);
		}
		if (envTab === "sky") {
			// 背景灰阶（亮度）与它进发光缓冲的权重（光效）
			root.append(
				subhead(t("sp.env.sky")),
				row(
					t("sp.skyBright"),
					slider(0, 1, 0.01, settings.brightSky, (v) =>
						onChange({ brightSky: v }),
					),
				),
				row(
					t("sp.skyGlow"),
					slider(0, 1, 0.01, settings.glowSky, (v) =>
						onChange({ glowSky: v }),
					),
				),
			);
			root.append(note(t("sp.skyNote")));
			// 天空另加光源：开关 + 颜色窗（默认白）
			root.append(
				subhead(t("sp.skyLight")),
				row(
					t("sp.lightOn"),
					checkbox(settings.lighting.keyIntensity > 0, (c) => {
						onChange({
							lighting: { ...settings.lighting, keyIntensity: c ? keyOnIntensity : 0 },
						});
						renderPage();
					}),
				),
				row(
					t("sp.lightColor"),
					colorChip({
						value: settings.lighting.keyColor,
						busId: "light.key",
						busName: "sp.bus.keyLight",
						defaultColor: 0xffffff,
						onChange: (v) =>
							onChange({ lighting: { ...settings.lighting, keyColor: v } }),
						lg: true,
					}),
				),
				row(
					t("sp.lightIntensity"),
					slider(0, 3, 0.1, settings.lighting.keyIntensity, (v) => {
						if (v > 0) keyOnIntensity = v // 记住开灯时的强度，关灯再开才回得来
						onChange({ lighting: { ...settings.lighting, keyIntensity: v } })
					}),
				),
				row(
					t("sp.azimuth"),
					slider(0, 360, 5, settings.lighting.keyAzimuth, (v) =>
						onChange({ lighting: { ...settings.lighting, keyAzimuth: v } }),
					),
				),
				row(
					t("sp.elevation"),
					slider(0, 90, 5, settings.lighting.keyElevation, (v) =>
						onChange({ lighting: { ...settings.lighting, keyElevation: v } }),
					),
				),
			);
		} else if (envTab === "ground") {
			// 地面材质 + 自发光
			ensureTexList(); // 网络贴图列表后台拉取
			const groundCfg = settings.mat.ground;
			const patchGround = (over: Partial<ObjMatConfig>): void =>
				onChange({ mat: { ...settings.mat, ground: { ...groundCfg, ...over } } });
			const rerender = (): void => renderPage();
			root.append(
				subhead(t("sp.groundMat")),
				row(
					t("sp.color"),
					colorChip({
						value: groundCfg.color ?? baseColorOf(groundCfg.preset),
						busId: "mat.ground",
						busName: "sp.bus.ground",
						defaultColor: 0xe9edf0,
						onChange: (v) => patchGround({ color: v }),
						lg: true,
					}),
				),
				row(
					t("sp.material"),
					buildMatDropdown("ground", groundCfg, rerender),
				),
				row(
					t("sp.groundBright"),
					slider(0, 1, 0.01, settings.brightGround, (v) =>
						onChange({ brightGround: v }),
					),
				),
				row(
					t("sp.groundGlow"),
					slider(0, 1, 0.01, settings.glowGround, (v) =>
						onChange({ glowGround: v }),
					),
				),
				row(
					t("sp.groundWidth"),
					slider(2, 200, 1, settings.groundWidth, (v) =>
						onChange({ groundWidth: v }),
					),
				),
				row(
					t("sp.groundFade"),
					slider(0, 1, 0.01, settings.groundFade, (v) =>
						onChange({ groundFade: v }),
					),
				),
			);
		} else {
			// 环境光
			root.append(
				subhead(t("sp.ambientLight")),
				row(
					t("sp.ambientColor"),
					colorChip({
						value: settings.lighting.ambientColor,
						busId: "light.ambient",
						busName: "sp.bus.ambient",
						defaultColor: 0xffffff,
						onChange: (v) =>
							onChange({ lighting: { ...settings.lighting, ambientColor: v } }),
						lg: true,
					}),
				),
				row(
					t("sp.ambientBright"),
					slider(0, 3, 0.1, settings.lighting.ambient, (v) =>
						onChange({ lighting: { ...settings.lighting, ambient: v } }),
					),
				),
				row(
					t("sp.envMapIntensity"),
					slider(0, 2, 0.1, settings.lighting.env, (v) =>
						onChange({ lighting: { ...settings.lighting, env: v } }),
					),
				),
			);
		}
	}

	function renderGeneral(root: HTMLElement): void {
		root.append(
			row(
				t("sp.viewRadius"),
				slider(2, 40, 0.5, settings.viewRadius, (v) =>
					onChange({ viewRadius: v }),
				),
			),
		);
		root.append(note(t("sp.viewRadiusNote")));
		// 过渡带终点 = 元素硬裁剪线：0 = 地面也在裁剪线上直接断掉（会看到一道边）
		root.append(
			row(
				t("sp.viewFeather"),
				slider(0, 3, 0.05, settings.viewFeather, (v) =>
					onChange({ viewFeather: v }),
				),
			),
		);
		root.append(note(t("sp.viewFeatherNote")));

		// 设备：切换会重建渲染器
		root.append(
			row(
				t("sp.device"),
				selectOf(
					[
						{ v: "auto", l: t("sp.device.auto") },
						{ v: "gpu", l: t("sp.device.gpu") },
						{ v: "cpu", l: t("sp.device.cpu") },
					],
					settings.device,
					(v) => {
						onChange({ device: v as DeviceMode });
						renderPage();
					},
				),
			),
		);
		root.append(note(t("sp.deviceNote")));

		// 光线追踪（实验）：实时阴影
		root.append(
			row(
				t("sp.rt"),
				checkbox(settings.rt, (c) => {
					onChange({ rt: c });
					renderPage();
				}),
			),
		);
		root.append(riskNote(t("sp.rtNote")));

		// 凸起高度：显示 ×100（世界单位），可拖动/可输入；点「确认重建」才应用
		// （凸起变化 = 全量重建 3584+ 个 mesh，实时拖动会卡）
		root.append(
			confirmAdjust(t("sp.rise"), {
				min: 0.1,
				max: 3,
				step: 0.1,
				value: Math.round(settings.rise * 100 * 10) / 10,
				commit: (v) => {
					onChange({ rise: v / 100 });
					renderPage();
				},
				hint: t("sp.riseHint"),
			}),
		);

		// 预设主题（自顶栏迁入）
		root.append(
			row(
				t("sp.themePreset"),
				selectOf(
					THEME_KEYS.map((k) => ({ v: k, l: k })),
					settings.theme,
					(v) => {
						onChange({ theme: v });
						renderPage();
					},
				),
			),
		);
	}

	/** 可拖动 + 可输入 + 确认按钮（重建类设置用：改完点确认才应用，避免高频全量重建） */
	function confirmAdjust(
		label: string,
		opts: {
			min: number;
			max: number;
			step: number;
			value: number;
			commit: (v: number) => void;
			hint?: string;
		},
	): HTMLElement {
		const box = document.createElement("div");
		box.className = "sp-lineblk";
		box.append(subhead(label));
		// 滑轨自带的数值框在这里只当"待提交值"用：拖/写都先进 cur，点确认才落到场景
		const cur = { v: opts.value };
		const sliderEl = slider(opts.min, opts.max, opts.step, opts.value, (v) => {
			cur.v = v;
		});
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "sp-morebtn";
		btn.textContent = t("sp.rebuild");
		btn.addEventListener("click", () => opts.commit(cur.v));
		box.append(row(t("sp.preview"), sliderEl), row("", btn));
		if (opts.hint) box.append(note(opts.hint));
		return box;
	}

	// ── 乐谱页：材质 / 高度 / 发光（三行） ──
	function renderScorePage(root: HTMLElement): void {
		ensureTexList(); // 网络贴图列表后台拉取，就绪后自动重渲本页
		const scoreCfg = settings.mat.score;
		const patchScoreCfg = (over: Partial<ObjMatConfig>): void => {
			onChange({ mat: { ...settings.mat, score: { ...scoreCfg, ...over } } });
		};
		const rerender = (): void => renderPage();
		root.append(
			subhead(t("sp.material")),
			row(
				t("sp.color"),
				colorChip({
					value: scoreCfg.inkColor ?? inkColorOf(scoreCfg.preset),
					busId: "mat.score.ink",
					busName: "sp.bus.scoreInk",
					defaultColor: inkColorOf(scoreCfg.preset),
					onChange: (v) => patchScoreCfg({ inkColor: v }),
					onReset: () => patchScoreCfg({ inkColor: null }),
					lg: true,
				}),
			),
			row(
				t("sp.material"),
				buildMatDropdown("score", scoreCfg, rerender),
			),
			row(
				t("sp.rough"),
				slider(0, 1, 0.01, settings.matTune.score.rough, (v) =>
					onChange({
						matTune: {
							...settings.matTune,
							score: { ...settings.matTune.score, rough: v },
						},
					}),
				),
			),
			// 凸起高度不在这里：它 = 全量重建 3584+ 个 mesh，只能「改值 + 点确认重建」，
			// 已收编到「环境 → 通用」的 confirmAdjust（那边显示 ×100 世界单位）。
			subhead(t("sp.glow")),
			row(
				t("sp.selfGlow"),
				slider(0, 3, 0.05, settings.scoreGlow, (v) =>
					onChange({ scoreGlow: v }),
				),
			),
		);
	}


	// ── 运动页：小球 / 拖尾 / 点亮 / 轨迹线 ──
	function renderMotionPage(root: HTMLElement, fixedTab?: string): void {
		closePop();
		root.textContent = "";
		if (fixedTab) {
			// 顶级页（小球/点亮/路径）：不显示子 tabs，直接渲染对应内容
			motionTab = fixedTab as typeof motionTab;
		} else {
			subTabs(
				root,
				[
					{ id: "ball", label: t("sp.nav.ball") },
					{ id: "trail", label: t("sp.motion.trail") },
					{ id: "lit", label: t("sp.nav.lit") },
					{ id: "track", label: t("sp.motion.track") },
				],
				motionTab,
				(id) => {
					motionTab = id as typeof motionTab;
					renderPage();
				},
			);
		}
		if (motionTab === "ball") renderBall(root);
		else if (motionTab === "trail") renderTrail(root);
		else if (motionTab === "lit") renderLit(root);
		else renderTrack(root);
	}

	/** bloom 全屏后处理控件（小球页与点亮页共用，确保两处调同一组字段、显示同步）：
	 *  强度 / 自动阈值 / 亮度阈值 / 光晕半径 + 说明。阈值在 auto 时禁用但显示当前自动值。 */
	function bloomControls(): HTMLElement[] {
		const out: HTMLElement[] = [];
		out.push(
			row(
				t("sp.bloomStrength"),
				slider(0, 3, 0.05, settings.bloomStrength, (v) =>
					onChange({ bloomStrength: v }),
				),
			),
			row(
				t("sp.bloomAuto"),
				checkbox(settings.bloomAutoThreshold, (c) => {
					onChange({ bloomAutoThreshold: c });
					renderPage();
				}),
			),
		);
		const thr = slider(0, 1, 0.01, settings.bloomThreshold, (v) => {
			// 手动拖阈值 = 用户明确接管：自动模式当场关掉，否则下一次 applySurf
			// 又把它改回去，滑杆看起来像「拖了没反应」
			onChange({ bloomThreshold: v, bloomAutoThreshold: false });
			renderPage();
		});
		bloomThrCtl = thr;
		if (settings.bloomAutoThreshold) {
			// 禁用但正常显示数值位置：自动值由 syncBloomThreshold 算出后
			// 通过 syncDerived 回填到这里，滑块位置反映真实生效阈值
			thr.range.disabled = true;
			thr.num.disabled = true;
			thr.num.title = t("sp.bloomAutoHint");
		}
		out.push(row(t("sp.bloomThreshold"), thr));
		// 上限收到 1：three 的 bloomRadius 是 5 级模糊权重的插值系数，
		// 文档口径 [0,1]；超过 1 会把最紧那级的权重拖成负数（抵消而非更大）
		const rad = slider(0, 1, 0.05, settings.bloomRadius, (v) =>
			onChange({ bloomRadius: v }),
		);
		bloomRadCtl = rad;
		out.push(row(t("sp.bloomRadius"), rad));
		out.push(note(t("sp.bloomNote")));
		return out;
	}
	function renderBall(root: HTMLElement): void {
		// ── 顶部全局区（路径栏上方）：bloom 是全屏后处理，天生无法逐路径，始终可调 ──
		root.append(subhead(t("sp.global")), ...bloomControls());
		// 顶部路径多选按钮栏（全选默认开，可横向滚动）
		const bar = pathBar();
		if (bar) root.append(bar);
		// ── 分轨区：以下都支持逐路径独立调节；全选时一起调 = 全局生效 ──
		root.append(
			subhead(t("sp.material")),
			pathColorRow(),
			pathSelect(t("sp.material"), "ballPreset", [
				{ v: "flat", l: t("sp.preset.flat") },
				{ v: "metal", l: t("sp.preset.metal") },
				{ v: "glass", l: t("sp.preset.glass") },
				{ v: "paper", l: t("sp.preset.paper") },
				{ v: "wood", l: t("sp.preset.wood") },
				{ v: "tile", l: t("sp.preset.tile") },
			]),
			pathSlider(t("sp.rough"), "ballRough", 0, 1, 0.01),
			pathSlider(t("sp.metal"), "ballMetal", 0, 1, 0.01),
		);
		root.append(
			subhead(t("sp.size")),
			pathSlider(t("sp.ballSize"), "ballSize", 0.1, 2, 0.01),
			pathCheckbox(t("sp.hitFx"), "hitFx"),
		);
		root.append(
			subhead(t("sp.trailGlow")),
			pathSlider(t("sp.trailLen"), "trailPct", 0, 200, 5),
			pathSelect(t("sp.glowStyle"), "ballGlowStyle", [
				{ v: "off", l: t("sp.glowStyle.off") },
				{ v: "soft", l: t("sp.glowStyle.soft") },
				{ v: "halo", l: t("sp.glowStyle.halo") },
			]),
		);
		// 作用域内任意路径光晕样式 ≠ off 才显示范围滑杆
		if (scopeStrs("ballGlowStyle").some((s) => s !== "off")) {
			root.append(pathSlider(t("sp.glowRange"), "ballGlowRange", 0, 2, 0.05));
		}
		root.append(
			subhead(t("sp.emission")),
			pathSlider(t("sp.ballBright"), "brightBall", 0, 1, 0.01),
			pathSlider(t("sp.ballGlow"), "glowBall", 0, 1, 0.01),
		);
		// 小球光源：独立于「自发光」。自发光只让球自身发亮（bloom），
		// 点光源才是真正照亮周围谱面的灯——每条路径一盏，互不干扰。
		root.append(
			subhead(t("sp.ballLightSection")),
			pathSlider(t("sp.ballLight"), "ballLightIntensity", 0, 5, 0.1),
		);
		root.append(note(t("sp.fallNote")));
	}

	function renderTrail(root: HTMLElement): void {
		// meshline 丝带拖尾：宽度随「强度」、透明度随「透明度」
		root.append(
			row(
				t("sp.trailIntensity"),
				slider(0, 2, 0.05, settings.trailIntensity, (v) =>
					onChange({ trailIntensity: v }),
				),
			),
		);
		root.append(
			row(
				t("sp.opacity"),
				slider(0, 1, 0.05, settings.trailAlpha, (v) =>
					onChange({ trailAlpha: v }),
				),
			),
		);
		root.append(
			row(
				t("sp.trailPct"),
				slider(0, 200, 5, settings.trailPct, (v) => onChange({ trailPct: v })),
			),
		);
		root.append(
			row(
				t("sp.followBall"),
				checkbox(settings.trailFollowBall, (c) => {
					onChange({ trailFollowBall: c });
					renderPage();
				}),
			),
		);
		if (!settings.trailFollowBall) {
			root.append(
				colorRow(t("sp.trailColor"), {
					value: settings.trailColor,
					busId: "trail",
					busName: "sp.bus.trail",
					defaultColor: 0xffffff,
					onChange: (v) => onChange({ trailColor: v }),
				}),
			);
		}
	}

	function renderLit(root: HTMLElement): void {
		// ── 顶部全局区（路径栏上方）：都是天生无法逐路径的全局项，始终可调 ──
		root.append(
			subhead(t("sp.global")),
			// 跟随小球 = 总开关：开着时点亮整套沿用小球的色/亮度/光效，分轨区隐藏
			row(
				t("sp.followBall"),
				checkbox(settings.litFollowBall, (c) => {
					onChange({ litFollowBall: c });
					renderPage();
				}),
			),
			subhead(t("sp.litSubToggles")),
			// ── 元素点亮三档：连音线 / 圆滑线 / 指法 / 和弦标记 / 歌词 ──
			// 只控制点亮发光，不控制元素是否显示（显示与否在乐谱页管理）。跟随小球与否都显示。
			...(() => {
				const items = (): { v: string; l: string }[] => [
					{ v: "off", l: t("sp.litModeOff") },
					{ v: "stream", l: t("sp.litModeStream") },
					{ v: "block", l: t("sp.litModeBlock") },
				];
				return [
					row(t("sp.litTie"), selectOf(items(), settings.litTie, (v) => onChange({ litTie: v as LitMode }))),
					row(t("sp.litSlur"), selectOf(items(), settings.litSlur, (v) => onChange({ litSlur: v as LitMode }))),
					row(t("sp.litFingering"), selectOf(items(), settings.litFingering, (v) => onChange({ litFingering: v as LitMode }))),
					row(t("sp.litChordMark"), selectOf(items(), settings.litChordMark, (v) => onChange({ litChordMark: v as LitMode }))),
					row(t("sp.litLyric"), selectOf(items(), settings.litLyric, (v) => onChange({ litLyric: v as LitMode }))),
				];
			})(),
			...bloomControls(),
		);
		// 顶部路径多选按钮栏
		const bar = pathBar();
		if (bar) root.append(bar);
		// 跟随小球开着 → 点亮整套沿用小球的色/亮度/光效，分轨区隐藏
		if (settings.litFollowBall) {
			root.append(note(t("sp.litFollowNote")));
			return;
		}
		// ── 分轨区：点亮色 / 亮度 / 光晕，逐路径可调 ──
		root.append(
			colorRow(t("sp.litColorScoped", { scope: scopeLabel() }), {
				value: settings.litColor,
				busId: "lit.custom",
				busName: "sp.bus.lit",
				defaultColor: 0xffd166,
				onChange: (v) => onChange({ litColor: v }),
			}),
			subhead(t("sp.glow")),
			pathSlider(t("sp.litBright"), "brightLit", 0, 1, 0.01),
			pathSlider(t("sp.litGlow"), "glowLit", 0, 1, 0.01),
		);
	}

	function renderTrack(root: HTMLElement): void {
		// 抛物线高度比例
		root.append(
			subhead(t("sp.mainPath")),
			row(
				t("sp.arcHeight"),
				slider(0, 1.5, 0.05, settings.jumpHeight, (v) =>
					onChange({ jumpHeight: v }),
				),
			),
		);
		// ── 起点线 / 终点线 ──
		// 「远离乐谱距离」与第三页那条竖线是同一份数据：第三页直接拖竖线，这里拖滑轨，
		// 单位都是 SVG 用户宽度（默认 90 = 第三页 TERM_MARGIN）。
		// 高度默认「跟随主路径」= 与抛物线同一算法（抛物线高度 × 段水平距离）；
		// 关掉跟随（或直接拖高度滑轨）就改成自定义高度（×谱线间距）。
		root.append(
			subhead(t("sp.startLine")),
			row(
				t("sp.termGap"),
				slider(12, 600, 2, settings.termLeadGap, (v) =>
					onChange({ termLeadGap: v }),
				),
			),
			row(
				t("sp.termLeadH"),
				slider(0, 24, 0.5, settings.termLeadH, (v) =>
					onChange({ termLeadH: v, termLeadHFollow: false }),
				),
			),
			row(
				t("sp.followArc"),
				checkbox(settings.termLeadHFollow, (c) => {
					onChange({ termLeadHFollow: c });
					renderPage();
				}),
			),
			note(
				settings.termLeadHFollow
					? t("sp.leadFollowNote")
					: t("sp.leadCustomNote"),
			),
		);
		root.append(
			subhead(t("sp.endLine")),
			row(
				t("sp.termGap"),
				slider(12, 600, 2, settings.termTailGap, (v) =>
					onChange({ termTailGap: v }),
				),
			),
			row(
				t("sp.termTailH"),
				slider(0, 24, 0.5, settings.termTailH, (v) =>
					onChange({ termTailH: v, termTailHFollow: false }),
				),
			),
			row(
				t("sp.followArc"),
				checkbox(settings.termTailHFollow, (c) => {
					onChange({ termTailHFollow: c });
					renderPage();
				}),
			),
			note(
				settings.termTailHFollow
					? t("sp.tailFollowNote")
					: t("sp.tailCustomNote"),
			),
		);
		// 辅助线：开关 + 颜色窗（默认跟随小球）+ 样式下拉 + 透明度
		// 统一作用到三类辅助线（轨迹线 / 起点线 / 终点线）：此前只改轨迹线，
		// 起点/终点线没有自己的外观控件，辅助线设置永远落不到它们上。
		const g = settings.trackLine;
		const patchLine = (over: Partial<GuideLineStyle>): void =>
			onChange({
				trackLine: { ...g, ...over },
				startLine: { ...settings.startLine, ...over },
				endLine: { ...settings.endLine, ...over },
			});
		root.append(
			subhead(t("sp.guide")),
			row(
				t("sp.guideOn"),
				checkbox(g.style !== "none", (c) => {
					patchLine({ style: c ? "solid" : "none" });
					renderPage();
				}),
			),
			row(
				t("sp.color"),
				colorChip({
					value: g.color,
					busId: "line.track",
					busName: "sp.bus.guide",
					defaultColor: 0x888888,
					onChange: (v) => patchLine({ color: v }),
					lg: true,
				}),
			),
			row(
				t("sp.style"),
				selectOf(
					[
						{ v: "solid", l: t("sp.style.solid") },
						{ v: "dashed", l: t("sp.style.dashed") },
					],
					g.style,
					(v) => patchLine({ style: v as ArcStyle }),
				),
			),
			row(
				t("sp.opacity"),
				slider(0, 1, 0.05, g.opacity, (v) => patchLine({ opacity: v })),
			),
		);
	}

	// 开机页要与 renderPage 实际渲染的那一页一致：写死 "material" 时导航里没有这一项，
	// 内容走 else 分支显示「通用」，六个 tab 却一个都不高亮。
	showPage("general");

	// 这是非模态悬浮窗，语言可以在它开着时从顶栏切换。标题 / 导航 / aria 都是建窗时
	// 一次性写进去的，refresh 只重画右栏，所以这三处得跟着一起重译。
	onLocaleChange(() => {
		title.textContent = t("sp.title");
		win.root.setAttribute("aria-label", t("sp.windowAria"));
		for (const it of NAV_ITEMS) {
			const b = navBtns[it.id];
			if (b) b.textContent = t(it.labelKey);
		}
		renderPage();
	});

	return {
		el: win.root,
		// refresh = 重画当前页；原来固定跳回 "material"，等于每次刷新都把用户踢离
		// 他正在看的页签（而且那个页签根本不存在）。
		refresh() {
			renderPage();
		},
		// 把 main.ts 派生出的生效值回填到对应滑轨（只动这两行，不整页重绘）
		syncDerived() {
			if (bloomThrCtl) bloomThrCtl.sync(settings.bloomThreshold);
			if (bloomRadCtl) bloomRadCtl.sync(settings.bloomRadius);
		},
	};
}