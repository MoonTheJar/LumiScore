// midee 3D 乐谱 —— WebGL + 全量立体构建（渲染核心 100% 照搬 3dtest）+ 轨道相机 v7
//
// 坐标系（用户规则）：
//   x = 时间轴（谱子延伸），y = 音高（谱面上下宽度），z = 高度（谱面 z=0）
//   谱面 = 竖直站立的 xy 平面；中线（最上谱线+最下谱线中点）与 x 轴重合
//   立体化：音符/谱线/符号向 +z 凸起（浮雕，凸起高度可调）
// 相机（轨道约束）：
//   焦点 P = 光轴(Principal Axis)与 x 轴交点；播放/←/→ 只改 P.x
//   高度 r = 镜头沿光轴到 x 轴距离；θxy（水平角/xy 平面）、θyz（竖直角/yz 平面，±80°）
//   摄像机 = P + r·(cosθyz·sinθxy, sinθyz, cosθyz·cosθxy)，lookAt P
//   r 绑定谱面宽：r_max = 8×H、r_min = 0.6×H（H = 谱面世界高度）
// 渲染（照搬 3dtest，无 LOD、无底纹理、全量构建）：
//   open（谱线/符干/连谱号/小节线/分页符…）→ ribbon 扁管（中心线 ±strokeW/2，端面封口，厚=rise）
//   fill（谱号/拍号/符头/附点/休止符/力度…）→ 多轮廓 Extrude（fillFlip=-1 翻转对齐）
//   text（指法/歌词/力度/英文…）→ CanvasTexture 薄片（浏览器字体渲染）

import { Midi } from "@tonejs/midi";
import * as THREE from "three";
import { VerovioToolkit as VrvToolkitClass } from "verovio/esm";
import createVerovioModule from "verovio/wasm";
// 现成特效库（用户指定）：碰符头粒子 = three.quarks；拖尾丝带 = meshline
// （threejs-trail-ribbon 在 npm 不存在，meshline 为同类丝带线库）。
// 球光晕 = three-glow-mesh 的算法，但其 npm 包依赖旧版 three（Face3）无法在
// three 0.186 打包，已按原算法本地化到 ./glowMesh.ts（参数与原库一致）。
import { createGlowMesh } from "./glowMesh";
import {
	BLOOM_LAYER,
	createSelectiveBloom,
	type GlowMat,
} from "./selectiveBloom";
import { BatchedRenderer, ParticleSystem, RenderMode } from "three.quarks";
import {
	ConstantColor,
	ConstantValue,
	IntervalValue,
	PointEmitter,
	Vector4,
} from "quarks.core";
import { applyI18n, onLocaleChange, t } from "../shell/i18n";
import { createContrastProbe } from "../shell/contrast";
import { createSelect, isSelectUI } from "../shell/select";
import { bindSliderPair, setupSlider, refreshSliderFill } from "../shell/slider";
import { createPlayerBar, type PlayerBarHandle } from "../shell/playerbar";
import { goStep, mountShell, confirmDialog, type ShellTool } from "../shell/shell";
import { downloadProjectZip } from "../shell/project-export";
import { createAspectOverlay, visibleViewRect } from "./aspect-overlay";
import { aspectById, cropRectFor } from "./aspect-ratio";
import { injectLitAnimation } from "./gltf-lit-anim";
import { createTrackPanel, type TrackPanelHandle } from "../shell/tracks";
import { audioClockNow } from "../shared/audio-clock";
import { registerCache } from "../shared/cache-registry";
import {
	getStored,
	refreshInUse,
} from "../shared/resource-manager";
import { setTextureHooks, ensureTextureCatalog } from "./texture-resource";
import { ColorBus } from "../shared/color-bus";
import { mergeTieEvents, parseMidiEvents, type PlayEvent } from "../score/midiEvents";
import {
	alignHeadsToEvents,
	corrAt,
	measureCorrectionAnchors,
	type CorrAnchor,
} from "../score/midiAlign";
import { parseXmlHeads } from "../shared/auto-links";
import { ensureNoteTypes } from "../shared/score-preprocess";
import {
	applySymbolEdits,
	convertSvgTextsToPaths,
	ensurePathFonts,
	loadSymbolEdits,
	preloadTextFonts,
} from "../shared/symbol-text";
import {
	baseColorOf,
	defaultObjMat,
	ensureEnvironment,
	inkColorOf,
	isGlassPreset,
	type MatOverrides,
	type MatTune,
	makeBallMaterial,
	makeBaseMaterial,
	makeInkMaterial,
	makeLitMaterial,
	type ObjMatConfig,
	presetDefaultTune,
	resetEnvironment,
	stampTexSet,
	type TexSetRef,
} from "./materials3d";
import { MideePlayer, playbackMidiB64 } from "./player";
import { createRenderProgress } from "../shared/render-progress";
import { fetchAssetInfo, mapUrl as phMapUrl } from "./polyhaven";
import {
	createSettingsPanel,
	type LightSettings,
	type PathNumKey,
	type RepairSettings,
	type SurfSettings,
	type SettingsPanelHandle,
} from "./settings-panel";
import { WaterSurface } from "./water3d";
import { VideoExporter } from "../export/VideoExporter";
import {
	openExportModal,
	type ExportApi,
	type ExportProgress,
	type ImageExportOpts,
	type ModelExportOpts,
	type VideoExportOpts,
} from "./export-modal";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import {
	OfflineContext,
	getContext,
	setContext,
	getDestination,
	Gain,
} from "tone";
import { createInstrument } from "./instruments";
import { midiToNoteName } from "./player";

interface VrvToolkit {
	loadData(xml: string): boolean;
	setOptions(opts: Record<string, unknown>): void;
	renderToSVG(pageNo?: number, xmlDeclaration?: boolean): string;
	renderToTimemap?(): { tstamp?: number; on?: string[] }[];
	getPageCount(): number;
	destroy(): void;
}

// ── 布局令牌 ──────────────────────────────────────────────────
const PX_PER_UNIT = 170; // SVG px → 世界单位
/** 乐谱整体放大倍数：谱/球/圆片/拖尾/凸起都在 world 组内，一起放大即可保持既有比例；
 *  组外的东西（相机距离、地面组、碰撞粒子）必须各自乘一次，见下方 SCORE_SCALE 的用法。 */
const SCORE_SCALE = 50;
// 凸起高度已迁入「3D 场景设置 → 环境 → 通用」（surf.rise，世界单位；面板显示 ×100）
const TRACK_STEP = 1.4; // ←/→ 单步（世界单位）
const FOV = 50;
const R_FACTOR_MAX = 8; // r_max = 8 × 谱面高
const R_FACTOR_MIN = 0.6; // r_min = 0.6 × 谱面高
const ROT_LIMIT = 180; // 三个旋转角范围 ±180°

// 播放器（提前声明：animate 每帧引用 player?.currentTime，音轨面板构造时也会读取）
let player: MideePlayer | null = null;

// ── 外壳先挂载 ────────────────────────────────────────────────
// 必须排在渲染器之前：WebGL 创建失败时（显卡被禁用 / 沙箱 / 驱动问题）
// 会在 new WebGLRenderer() 处同步抛出，若外壳还没挂上，整页会变成一片空白。
// 先挂外壳 → 顶栏、设置始终可用，画布留空并给出可操作的报错。
// 音轨面板稍后创建（须在 player 声明之后），先给顶栏下拉占一个插槽。
const tracksSlot = document.createElement("div");
// 本页改动标记：设置面板任何一项被调整、或顶栏改名后置真（视觉偏好已存 localStorage，
// 但刷新会丢掉「本次会话里调出来的画面」，所以离开前仍给一次确认）
let surfaceDirty = false;
// 测试台模式（src/bench 入口置标记）：锁定场景编辑、不读不写用户场景存档，
// 数据来自测试台写死的 fixture（sessionStorage）。开关关闭时主项目行为零变化。
const BENCH = (window as unknown as Record<string, unknown>).__LUMI_BENCH__ === true;
const shell = mountShell({
	step: 5,
	title: sessionStorage.getItem("midee.name") ?? t("common.untitled"),
	...(BENCH ? {} : { tracks: tracksSlot }),
	aspect: createAspectOverlay().menu,
	...(BENCH
		? {}
		: {
				onTitleRename: (text) => {
					surfaceDirty = true;
					try {
						sessionStorage.setItem("midee.name", text);
					} catch {
						/* noop */
					}
				},
			}),
	// 最右主按钮 = 导出（视频 / 模型 / 图片 / 工程文件）。默认文案是「下一步」，挂载后改写成「导出」。
	next: {
		onNext: () => openExportDialog(),
	},
	isDirty: () => surfaceDirty,
	onExport: () => openExportDialog(),
});

// 顶栏最右主按钮默认叫「下一步」，本页它是终点 → 把 i18n 绑定改指「导出」。
// 不能只改 textContent：applyI18n（含切换语言）会按 data-i18n 把文案刷回去。
(() => {
	const mainBtn = shell.topbar.querySelector<HTMLButtonElement>(".sh-next__main");
	if (mainBtn) {
		mainBtn.dataset.i18n = "ex.export";
		mainBtn.textContent = t("ex.export");
	}
})();

/** WebGL 不可用时的兜底界面：顶栏保留，画布留空，给出排查建议 */
function showFatal(detail: string): void {
	const hintEl = document.getElementById("hint");
	if (hintEl) hintEl.hidden = true;
	const emptyEl = document.getElementById("empty");
	if (emptyEl) emptyEl.hidden = true;
	const box = document.createElement("div");
	box.className = "p4-fatal";
	const esc = detail.replace(/[<>&]/g, (c) =>
		c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
	);
	box.innerHTML = `
    <div class="box">
      <h2 data-i18n="p4.fatal.title"></h2>
      <p data-i18n="p4.fatal.desc"></p>
      <ul>
        <li data-i18n="p4.fatal.tip1"></li>
        <li data-i18n="p4.fatal.tip2"></li>
        <li data-i18n="p4.fatal.tip3"></li>
      </ul>
      <pre>${esc}</pre>
    </div>`;
	document.body.append(box);
	applyI18n(document.body);
}

// ── 场景 ──────────────────────────────────────────────────────
const container = document.getElementById("canvas-container")!;


// 渲染后端：按设备模式（auto 逐级降级 / gpu 强制高性能显卡 / cpu 低功耗软渲染）创建；
// three.js 的 WebGLRenderer 会自动选择 WebGL2/WebGL1。全部失败才落 showFatal。
function createRenderer(mode: "auto" | "gpu" | "cpu"): THREE.WebGLRenderer {
	const attempts: THREE.WebGLRendererParameters[] =
		mode === "gpu"
			? [
					{
						antialias: true,
						powerPreference: "high-performance",
						failIfMajorPerformanceCaveat: true,
					},
					{
						antialias: false,
						powerPreference: "high-performance",
						failIfMajorPerformanceCaveat: true,
					},
				]
			: mode === "cpu"
				? [{ antialias: false, powerPreference: "low-power" }]
				: [
						{ antialias: true, powerPreference: "high-performance" },
						{ antialias: false, powerPreference: "high-performance" },
						{ antialias: false, failIfMajorPerformanceCaveat: false },
					];
	let lastErr: unknown;
	for (const attrs of attempts) {
		try {
			const r = new THREE.WebGLRenderer(attrs);
			// cpu 软渲染填满率有限：像素比固定 1、无抗锯齿；gpu/auto 按 DPR 上限 2
			r.setPixelRatio(
				mode === "cpu"
					? 1
					: Math.min(
							window.devicePixelRatio,
							isLowPerf() ? 1.5 : r.capabilities.isWebGL2 ? 2 : 1.5,
						),
			);
			r.setSize(container.clientWidth, container.clientHeight);
			return r;
		} catch (err) {
			lastErr = err;
			console.warn("[渲染] WebGL 创建降级", attrs, err);
		}
	}
	throw lastErr;
}
/** 渲染器上下文相关资源（贴图等）：设备重建后统一 needsUpdate 重传 */
const managedTextures = new Set<THREE.Texture>();
/** 挂接 WebGL 上下文丢失/恢复事件（渲染器重建后重新绑定用） */
let gpuOverlay: HTMLDivElement | null = null;
function showGpuOverlay(key: string): void {
	if (!gpuOverlay) {
		gpuOverlay = document.createElement("div");
		gpuOverlay.style.cssText =
			"position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:40;" +
			"padding:8px 16px;border-radius:999px;background:rgba(20,22,30,.88);color:#fff;" +
			"font-size:12.5px;backdrop-filter:blur(8px);box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;";
		document.body.append(gpuOverlay);
	}
	// 绑 data-i18n 而不是只写一次文案：上下文丢失期间用户照样能切语言
	gpuOverlay.dataset.i18n = key;
	gpuOverlay.textContent = t(key);
	gpuOverlay.style.display = "block";
}
function hideGpuOverlay(): void {
	if (gpuOverlay) gpuOverlay.style.display = "none";
}
function attachRendererEvents(r: THREE.WebGLRenderer): void {
	r.domElement.addEventListener("webglcontextlost", (e) => {
		e.preventDefault();
		console.error("[渲染] WebGL 上下文丢失（GPU 重置/驱动恢复），等待自动恢复");
		showGpuOverlay("p4.gpuLost");
	});
	r.domElement.addEventListener("webglcontextrestored", () => {
		console.info("[渲染] WebGL 上下文已恢复");
		hideGpuOverlay();
		// 恢复≠原样：GL 侧的贴图、composer 的 RenderTarget、PMREM 环境贴图全作废了。
		// 以前只把遮罩收掉，于是 GPU 重置之后必然留下黑块/残影/不更新的贴图——
		// 正是「像死模型一样赖在画面里」的一类。这里按硬重置那一档自动补回来。
		recoverGpuResources();
		// 上下文恢复是残留问题最高发的时刻：补扫一次，把还能自动修的当场修掉。
		// 延后一拍 —— recoverGpuResources 里的全量重画排在下一帧，立刻扫会看到
		// stage 刚清空、计数还没跟上的中间态，误报成「节点漂移」。
		setTimeout(() => patrol("context"), 1500);
	});
}
let renderer: THREE.WebGLRenderer;
try {
	renderer = createRenderer("auto");
} catch (err) {
	showFatal(String(err));
	throw err;
}
const hasWebGPU =
	typeof (navigator as Navigator & { gpu?: unknown }).gpu !== "undefined";
console.info(
	`[lumiscore] renderer=WebGL${renderer.capabilities.isWebGL2 ? "2" : "1"} webgpu=${hasWebGPU ? "available" : "n/a"}`,
);
container.appendChild(renderer.domElement);
attachRendererEvents(renderer);

const scene = new THREE.Scene();
const skyColor = new THREE.Color(0xffffff); // 天空亮度复用，避免每次面板改动都新建
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(
	FOV,
	container.clientWidth / container.clientHeight,
	1, // 相机最近也在 rMin（≈33 世界单位）之外，近裁剪面放大后不必再留 0.1
	20000, // 地面组放大 50× 后有 2 万单位长
);

// ── 选择性 Bloom（照搬测试台四源结构）：只有登记过的材质进发光缓冲 ──
// 全局 bloom 会把白底当光源，加色合成后整幅泛白、符头掉色；这里固定走选择性路径。
// 两个 EffectComposer 绑定创建时的 renderer：切换渲染设备重建 renderer 后必须一并
// 重建 bloom（见 rebuildRenderer），否则合成器仍往已 dispose 的旧上下文渲染 → 黑屏。
let bloom = createSelectiveBloom({
	renderer,
	scene,
	camera,
	width: container.clientWidth,
	height: container.clientHeight,
	matsOf: glowMatsOf,
});

/** 三条几何源当前要进发光缓冲的材质 + 各自的光效权重（每帧现取：材质会被预设重建、被拖尾/地面替换）。
 *  权重逐路径取：小球亮度/光效、点亮亮度/光效都能按路径各一份。 */
function glowMatsOf(which: "ball" | "lit" | "ground"): GlowMat[] {
	const out: GlowMat[] = [];
	const add = (m: THREE.Material | THREE.Material[], w: number) => {
		if (Array.isArray(m)) for (const x of m) out.push({ mat: x, w });
		else out.push({ mat: m, w });
	};
	if (which === "ground") {
		add(bgGround.material, surf.glowGround);
		return out;
	}
	// 谱面和球轨都还没建（空状态 / 首帧之前）：点亮与小球两条源必然为空，
	// 提前交白卷，省掉每帧两次上千元素的热循环（peakLuma 也在按拍调用）。
	if (!allElems.length && !ballTracks.length) return out;
	if (which === "lit") {
		for (const [i, list] of targetMeshes)
			for (const m of list) add(m.material, litGlowFor(i));
		return out;
	}
	for (const bt of ballTracks) {
		const w = effNum("glowBall", bt.pathIdx);
		for (const b of bt.pool) {
			add(b.material, w);
			const tr = b.userData.trail as TrailObj | undefined;
			if (tr) add(tr.mat, w);
		}
		// 副球和它的拖尾以前没登记 → 自身亮度直接漏进发光缓冲
		const sp = bt.split;
		if (sp) {
			add(sp.splitBall.material, w);
			add(sp.trailB.mat, w);
		}
	}
	return out;
}

// ── 平躺（Y-up / Z-up）最小补丁 ─────────────────────────────────
// 内部构建仍沿用「立式」坐标：乐谱在 XY 平面、凸起厚度/抛物线高度沿 +Z。
// world 绕 X 轴 −90°（(x,y,z)→(x,z,−y)）让谱面平浮在世界 XZ 平面、凸起朝世界
// +Y（真正的“上”）。相机不随 world 旋转，直接在 Y-up 世界用水平轨道球（见
// applyCam）：俯角控高度、偏航绕竖直轴，永远在水面上方不会钻到谱下。
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
world.scale.setScalar(SCORE_SCALE); // 乐谱+球+拖尾+圆片整体放大，内部坐标一律不变
scene.add(world);

const stage = new THREE.Group(); // 谱面/立体层
world.add(stage);

// ── 灯光与 PBR 环境 ───────────────────────────────────────────
// v2：光源全面可控（环境光颜色/强度、主光颜色/强度/方位/仰角），另提供
// 「全局光照（无光源）」模式——关掉所有直射光，只用 PMREM 环境贴图 IBL 照明，
// 靠 scene.environmentIntensity 调整整体曝光（金属/玻璃/微表面质感最均匀）。
ensureEnvironment(renderer, scene);
const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
scene.add(keyLight);
// 小球点光源按路径各一盏（见 BallTrack.light）：跟着本路径当前可见球走、颜色 = 本路径色。
// 挂在 world 里 → 位置直接用球的内部坐标；衰减按世界单位算，所以照程要乘 SCORE_SCALE。
const fillLight = new THREE.DirectionalLight(0xdfeaff, 0.4);
fillLight.position.set(-6, 5, -6);
scene.add(fillLight);
scene.add(keyLight.target); // 光追模式：target 跟随焦点（阴影投在谱面附近）
/** 把 surf.lighting 打到场景（studio=环境光+主光；ibl=纯环境贴图无光源） */
function applyLighting(): void {
	const L = surf.lighting;
	// 环境反射强度：three ≥ r163 支持 scene.environmentIntensity 全局缩放
	const sc = scene as THREE.Scene & { environmentIntensity?: number };
	if ("environmentIntensity" in sc) sc.environmentIntensity = L.env;
	ambientLight.intensity = L.ambient;
	ambientLight.color.setHex(L.ambientColor);
	keyLight.intensity = L.keyIntensity;
	keyLight.color.setHex(L.keyColor);
	// 辅光跟随主光（主光关=辅光同步关，保证「无光源」状态纯净）
	fillLight.intensity = L.keyIntensity * 0.32;
	const az = deg2rad(L.keyAzimuth);
	const el = deg2rad(L.keyElevation);
	// 方位角绕竖直轴、仰角抬升：位置只定方向（平行光）
	keyLight.position
		.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
		.multiplyScalar(12);
}

/** 光线追踪（实验）：主光实时阴影 PCFSoft（近似光追，非逐像素路径追踪）；开启有性能代价 */
function applyRT(): void {
	const on = surf.rt;
	renderer.shadowMap.enabled = on;
	if (!on) return;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	keyLight.castShadow = true;
	keyLight.shadow.mapSize.set(1024, 1024);
	const c = 24; // 阴影相机正交范围（谱面横向长，取大覆盖）
	keyLight.shadow.camera.left = -c;
	keyLight.shadow.camera.right = c;
	keyLight.shadow.camera.top = c;
	keyLight.shadow.camera.bottom = -c;
	keyLight.shadow.camera.near = 0.5;
	keyLight.shadow.camera.far = 80;
	keyLight.shadow.bias = -0.0006;
	keyLight.target.position.set(focusX, 0, 0);
	// 谱面元素/球/轨迹线投阴影；地面/底板接收
	for (const m of stage.children) m.castShadow = true;
	for (const ch of ballGroup.children) ch.castShadow = true;
	bgGround.receiveShadow = true;
	backplate.receiveShadow = true;
}

/** 重建选择性 bloom 的两个 composer：弃旧建新，迁移四源光效权重与 bloom 参数。
 *  换渲染器时必走；后期状态自己坏了（残影/黑屏/uniform 不更新）也可以单独走这一档。 */
function rebuildPost(): void {
	const prevGlow = { ...bloom.glow };
	const prevBloomParams = bloom.params();
	bloom.dispose();
	bloom = createSelectiveBloom({
		renderer,
		scene,
		camera,
		width: container.clientWidth,
		height: container.clientHeight,
		matsOf: glowMatsOf,
	});
	Object.assign(bloom.glow, prevGlow);
	bloom.setParams(prevBloomParams);
}

/** 上下文恢复后的自动补画：renderer 还活着，但它名下的 GL 资源已全部作废。
 *  与 rebuildRenderer 的区别是不换 canvas、不重建 renderer 本体。 */
function recoverGpuResources(): void {
	for (const t of managedTextures) t.needsUpdate = true;
	if (groundFadeTex) groundFadeTex.needsUpdate = true;
	rebuildPost();
	ensureEnvironment(renderer, scene);
	applyBloomSurf();
	applyRT();
	applyLighting();
	if (allElems.length) {
		renderProg.show(t("p4.prog.device"));
		requestAnimationFrame(() => {
			buildAll();
			renderProg.done(t("p4.prog.deviceDone"));
		});
	}
	resize();
}

/** 按 surf.device 重建渲染器（切换 gpu/cpu/auto）；旧上下文资源全部失效，
 *  统一重传贴图 + 重烘环境贴图 + 重建谱面 mesh（共享材质不再安全，保守全量重建）。 */
function rebuildRenderer(): void {
	resetEnvironment(scene);
	renderer.dispose();
	renderer.domElement.remove();
	try {
		renderer = createRenderer(surf.device);
	} catch (err) {
		console.warn("[渲染] 目标设备模式创建失败，回退自动降级链", err);
		renderer = createRenderer("auto");
	}
	container.appendChild(renderer.domElement);
	attachRendererEvents(renderer);
	// bloom 的两个 EffectComposer 绑死旧 renderer：弃旧建新，并迁移四源光效权重与 bloom 参数
	rebuildPost();
	// 旧 GL 上下文下上传的贴图作废：needsUpdate 触发重传
	for (const t of managedTextures) t.needsUpdate = true;
	if (groundFadeTex) groundFadeTex.needsUpdate = true;
	ensureEnvironment(renderer, scene);
	// 水面反射平面内部纹理绑定旧上下文：弃旧建新（水面暂未开放，仅作保险）
	if (water) {
		water.dispose();
		bgGroup.remove(water.mesh);
		water = null;
		if (surf.waterOn) ensureWater();
	}
	if (allElems.length) {
		renderProg.show(t("p4.prog.device"));
		requestAnimationFrame(() => {
			buildAll();
			renderProg.done(t("p4.prog.deviceDone"));
		});
	}
	applyRT();
	applyLighting();
	resize();
}

// ── 第 5 页外观状态（材质/水面/视野/发光/拖尾/轨迹线，由悬浮窗控制） ──
// 状态类型 SurfSettings / LightSettings 定义在 settings-panel（与 UI 共用一份，
// 避免双份接口漂移）；材质组配置 ObjMatConfig 见 materials3d。
// 第四页保存的轨迹形状（默认抛物线）
const readTrajShape = (): "parabola" | "line" => {
	const v = sessionStorage.getItem("midee.trajShape");
	return v === "line" ? "line" : "parabola";
};
const surf: SurfSettings = {
	viewRadius: 14,
	// 边缘过渡带宽度（以 viewRadius 为单位）：地面在这段里从全实淡到全透，
	// 淡到 0 的位置 = 元素硬裁剪的位置，两条线对齐才没有「中间亮、边上突然一道 cutoff」
	viewFeather: 1,
	mat: {
		score: defaultObjMat("paper"),
		ground: defaultObjMat("tile"),
		ball: defaultObjMat("flat"),
	},
	matTune: {
		score: presetDefaultTune("paper"),
		ground: presetDefaultTune("tile"),
		ball: presetDefaultTune("flat"),
	},
	selectedObject: "score",
	// ── 选择性 bloom 四源：每源「亮度」（正式画面里的颜色强度）+「光效」（发光缓冲权重）──
	// 四条亮度默认一律 0.5（用户反馈：1.0 的白底把发光和高光全冲掉了，一进来太白）
	brightBall: 0.5, // 小球/拖尾亮度（原 ballGlow：材质自发光强度）
	glowBall: 0.25, // 小球光效（进发光缓冲的 HDR 权重 0-1）
	brightLit: 0.5, // 点亮符头亮度（原 litGlow）
	glowLit: 0.25, // 点亮符头光效
	brightGround: 0.5, // 底面亮度（原 groundGlow）
	groundWidth: 60, // 底面宽度（世界单位，以中轴线为基准向两侧各一半）
	groundFade: 0.5, // 底面两侧边缘渐变强度 0-1
	glowGround: 0, // 底面光效（>0 等于把整块地面当光源，白底场景慎用）
	brightSky: 0.5, // 天空/背景亮度（0=黑 1=白）
	glowSky: 0, // 天空光效（>0 等于把背景当光源加回来，会糊掉前景）
	bloomStrength: 1.0, // 发光缓冲的整体放大倍率
	bloomRadius: 0.5, // 光晕扩散半径
	bloomThreshold: 0.25, // 亮度阈值：发光缓冲里高于此值才出晕
	// 阈值自动钉在「本帧最亮源」下方：手动阈值一旦高于峰值，整层被高通滤成纯黑，
	// 强度/半径全成空转（看起来像滑杆坏了）。关掉即回到完全手动态。
	bloomAutoThreshold: true,
	ballLightIntensity: 0, // 小球作为点光源亮度（默认 0 = 不作光源）
	scoreGlow: 0, // 乐谱本身（未点亮谱面）自发光强度，0=不发光
	lighting: {
		ambient: 0.5, // 环境光照亮乐谱（面板项「环境光亮度」，按「亮度一律 0.5」的反馈改的）
		ambientColor: 0xffffff,
		keyColor: 0xffffff,
		keyIntensity: 1.25,
		keyAzimuth: 30,
		keyElevation: 55,
		env: 0.9,
	},
	// ── 环境 · 通用 ──
	device: "auto",
	rt: false, // 光线追踪（实验：实时阴影）
	rise: 0.015, // 凸起高度（世界单位；面板显示 ×100 → 1.5，范围 0.1–3）
	theme: "Dark", // 预设点亮主题
	// ── 运动 · 小球 ──
	ballSize: 1 / 3, // 球半径 = 该倍数 × 一个谱线间距；原默认 0.5 偏大，按反馈缩到 2/3
	hitFx: false, // 小球落到符头的撞击粒子迸发（默认关，「小球」页可开）
	ballGlowStyle: "off", // 球光晕特效（three-glow-mesh）：off / soft / halo（默认无特效）
	ballGlowRange: 0.08, // 光晕范围（世界单位，外扩厚度）
	flightMs: 700, // 下落时间 ms（= 第三页 offStart 0.7s，两页首尾偏移一致）
	// ── 运动 · 拖尾 ──
	trailFollowBall: true,
	trailColor: 0xffffff, // 不跟随小球时的自定义拖尾色
	trailAlpha: 0.85, // 拖尾透明度 0-1
	// ── 运动 · 点亮 ──
	litEnabled: true, // 音符点亮总开关
	litFollowBall: true, // 点亮色默认跟随小球/路径色（开着时面板隐藏下面的颜色项）
	litColor: 0xffd166, // 不跟随时的自定义点亮色
	waterOn: false,
	waterAmp: 0.03,
	waterSpeed: 0.6,
	waterWaveLen: 1.4,
	waterColor: 0x16324a,
	trajShape: readTrajShape(),
	jumpHeight: 0.4,
	// ── 运动 · 路径（起点/终点线） ──
	// 距离：与第三页竖线拖拽同一份数据（SVG 用户单位，默认同 TERM_MARGIN 90）
	termLeadGap: 90,
	termTailGap: 90,
	// 高度：跟随主路径弧高（默认开）= jumpHeight × 段水平距离；关掉才吃下面的绝对值
	termLeadHFollow: true,
	termTailHFollow: true,
	termLeadH: 4, // ×谱线间距
	termTailH: 4, // ×谱线间距
	trackLine: {
		style: "solid",
		opacity: 0.45,
		color: 0x888888,
		followTrack: true,
	},
	startLine: { style: "solid", opacity: 0.7, color: 0x9aa7b5 },
	endLine: { style: "solid", opacity: 0.7, color: 0x9aa7b5 },
	trailPct: 100,
	trailIntensity: 1,
	pathNames: [], // 导入曲子后由 main.ts 更新
	pathColors: [], // 每条路径的自定义色（null = 用该路径默认色）
	pathDefaultColors: [], // 每条路径的默认色（连线页带过来的颜色）
	selectedPaths: [], // 空数组 = 全选
	pathNums: {}, // 逐路径数值覆盖（小球/点亮），缺省 = 吃上面的全局值
	repair: {
		patrolOn: true,
		autoApply: true,
		intervalSec: 30,
		onBoot: true,
		onSetting: true,
		onVisible: true,
		onContext: true,
	},
};

// 3D 场景设置持久化：整份 surf 存本机（midee.surf3d），刷新/重开不再丢，
// 也供工程 zip 导出/导入携带（见 shell/project-state.ts）。只覆盖已存字段，缺省仍用默认。
const SURF_KEY = "midee.surf3d";
// 存档可能来自旧版（缺新字段）、被改坏（NaN/字符串/越界）或别的构建，直接吃下去会让
// 后面每一层计算都带上 NaN。这里先留一份默认值快照，读完再逐项校验。
const surfDefaults = JSON.parse(JSON.stringify(surf)) as SurfSettings;
/** 逐项把 surf 里的数值修成「有限数」，并对有口径要求的几项钳回合法区间；
 *  嵌套的 lighting / mat / matTune 缺项时按默认补。不认识的键原样留着。 */
function normalizeSurf(): void {
	const rec = surf as unknown as Record<string, unknown>;
	const def = surfDefaults as unknown as Record<string, unknown>;
	for (const k of Object.keys(def)) {
		const want = def[k];
		if (typeof want === "number") {
			const got = rec[k];
			rec[k] =
				typeof got === "number" && Number.isFinite(got) ? got : want;
		}
	}
	// 有明确口径的几项：越界不报错但会静默改变画面
	surf.viewRadius = clamp(surf.viewRadius, 2, 40);
	surf.viewFeather = clamp(surf.viewFeather, 0, 3);
	surf.bloomThreshold = clamp(surf.bloomThreshold, 0, 1);
	surf.bloomRadius = clamp(surf.bloomRadius, 0, 1);
	surf.groundFade = clamp(surf.groundFade, 0, 1);
	const light = surf.lighting as unknown as Record<string, unknown>;
	const lightDef = surfDefaults.lighting as unknown as Record<string, unknown>;
	for (const k of Object.keys(lightDef)) {
		if (typeof light[k] !== "number" || !Number.isFinite(light[k] as number))
			light[k] = lightDef[k];
	}
	for (const o of ["score", "ground", "ball"] as const) {
		if (!surf.mat?.[o]) surf.mat[o] = structuredClone(surfDefaults.mat[o]);
		if (!surf.matTune?.[o])
			surf.matTune[o] = structuredClone(surfDefaults.matTune[o]);
	}
	if (!Array.isArray(surf.pathColors)) surf.pathColors = [];
	if (!Array.isArray(surf.pathDefaultColors)) surf.pathDefaultColors = [];
	if (!Array.isArray(surf.selectedPaths)) surf.selectedPaths = [];
	if (!surf.pathNums || typeof surf.pathNums !== "object")
		surf.pathNums = {};
	// 巡检设置单独补：老存档整块都没有，浅层 Object.assign 不会替嵌套对象补洞
	const rp = surf.repair as Partial<typeof surfDefaults.repair> | undefined;
	surf.repair = { ...surfDefaults.repair, ...(rp ?? {}) };
	surf.repair.intervalSec = clamp(surf.repair.intervalSec, 5, 600);
	for (const k of ["patrolOn", "autoApply", "onBoot", "onSetting", "onVisible", "onContext"] as const) {
		if (typeof surf.repair[k] !== "boolean") surf.repair[k] = surfDefaults.repair[k];
	}
}
if (BENCH) {
	// 测试台：场景参数写死（window.__LUMI_BENCH_SURF__，src/bench/flag.ts 置入），
	// 不读用户真实存档。mat/matTune 需二级合并，浅合并会丢掉嵌套的 mat.ball 等整块。
	const preset = (window as unknown as Record<string, unknown>)
		.__LUMI_BENCH_SURF__ as Partial<SurfSettings> | undefined;
	if (preset && typeof preset === "object") {
		Object.assign(surf, preset);
		if (preset.mat && typeof preset.mat === "object")
			Object.assign(surf.mat, preset.mat);
		if (preset.matTune && typeof preset.matTune === "object")
			Object.assign(surf.matTune, preset.matTune);
	}
} else {
	try {
		const saved = JSON.parse(localStorage.getItem(SURF_KEY) ?? "null") as
			| Partial<SurfSettings>
			| null;
		if (saved && typeof saved === "object") Object.assign(surf, saved);
	} catch {
		/* 损坏的存档忽略，用默认 */
	}
}
normalizeSurf();
let surfSaveTimer: number | undefined;
/** 防抖落盘：滑杆高频 input 时不必每次都写 localStorage */
function saveSurf(): void {
	if (BENCH) return; // 测试台绝不写用户真实存档
	window.clearTimeout(surfSaveTimer);
	surfSaveTimer = window.setTimeout(() => {
		try {
			localStorage.setItem(SURF_KEY, JSON.stringify(surf));
		} catch {
			/* 隐私模式忽略 */
		}
	}, 250);
}

// 背景组：地面板 + 水面同组（水面归于背景），整体跟随相机焦点平移，
// 沿谱长方向做边缘淡出——谱面元素被视野裁剪时，背景同步渐隐到页面包底色，
// 视野内外观感一致，不再出现"谱子消失了、地面还铺到天边"的割裂。
const bgGroup = new THREE.Group();
bgGroup.scale.setScalar(SCORE_SCALE); // 地面/水面跟着乐谱同比例（否则相对尺寸会缩 50 倍）
scene.add(bgGroup);
let bgGroundMat = makeBaseMaterial(
	surf.mat.ground.preset,
	overridesFor("ground"),
);
// 默认无光源：底面靠白色自发光呈现（groundGlow=0 时等效关闭）
bgGroundMat.emissive.setHex(0xffffff);
bgGroundMat.emissiveIntensity = surf.brightGround;
const GROUND_LEN = 400; // 沿谱长方向的固定长度，两端靠 alphaMap 渐隐
const bgGround = new THREE.Mesh(
	new THREE.PlaneGeometry(GROUND_LEN, Math.max(2, surf.groundWidth)),
	bgGroundMat,
);
bgGround.layers.enable(BLOOM_LAYER); // 底面是四条发光源之一（光效 0 时置黑，不进缓冲）
bgGround.rotation.x = -Math.PI / 2;
bgGround.position.set(0, -0.18, 0);
bgGround.frustumCulled = false; // 跟随焦点平移，包围盒始终覆盖相机，无需剔除
bgGroup.add(bgGround);

// 地面边缘淡出：alphaMap 横向渐变（中心实、|x|>淡出半径渐隐），随 viewRadius 重建
let groundFadeTex: THREE.CanvasTexture | null = null;
let groundFadeTimer: number | undefined;
function refreshGroundFade(): void {
	// 与 applyViewCrop 同一条线：元素在 |dx|>win 处被硬裁剪，地面必须在此之前
	// 已经淡到 0，否则裁剪线上「元素没了、地板还是实的」= 用户看到的那道分界。
	const win = Math.max(0.5, surf.viewRadius);
	const feather = Math.max(0, surf.viewFeather);
	const end = win; // u=0.5±end 处完全透明（正好是裁剪线）
	const solid = Math.min(
		0.49,
		(win / (1 + feather)) / GROUND_LEN,
	); // u∈[0.5±solid] 内完全不透明
	const e = Math.min(0.5, end / GROUND_LEN);
	const strength = Math.min(1, Math.max(0, surf.groundFade)); // 两侧边缘渐变强度
	const W = 256;
	const H = 128;
	const c = groundFadeTex?.image as HTMLCanvasElement | undefined;
	const canvas = c ?? document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d")!;
	const img = ctx.createImageData(W, H);
	for (let y = 0; y < H; y++) {
		// v = 宽度方向（局部 y → 世界 z）：0.5 是中轴线，两侧边缘淡出
		const side = Math.abs((y + 0.5) / H - 0.5) * 2;
		const across = 1 - strength * Math.pow(side, 1.5);
		for (let x = 0; x < W; x++) {
			const d = Math.abs((x + 0.5) / W - 0.5);
			const along = d <= solid ? 1 : d >= e ? 0 : 1 - (d - solid) / (e - solid);
			const v = Math.max(0, Math.min(1, along * across)) * 255;
			const i = (y * W + x) * 4;
			img.data[i] = v;
			img.data[i + 1] = v; // alphaMap 取绿色通道
			img.data[i + 2] = v;
			img.data[i + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	if (!groundFadeTex) {
		groundFadeTex = new THREE.CanvasTexture(canvas);
		bgGroundMat.alphaMap = groundFadeTex;
		bgGroundMat.transparent = true;
		bgGroundMat.needsUpdate = true;
	}
	groundFadeTex.needsUpdate = true;
}
/** 底面宽度变化：重建几何体（贴图 u/v 比例不变，无需重画） */
function rebuildGroundPlane(): void {
	bgGround.geometry.dispose();
	bgGround.geometry = new THREE.PlaneGeometry(
		GROUND_LEN,
		Math.max(2, surf.groundWidth),
	);
	refreshGroundFade();
}
/** 视野半径变化 → 防抖重建淡出贴图 */
function scheduleGroundFade(): void {
	window.clearTimeout(groundFadeTimer);
	groundFadeTimer = window.setTimeout(refreshGroundFade, 120);
}
refreshGroundFade();

// 乐谱底板（内部坐标：乐谱在 XY，板放在 z<0 一层；经 world 旋转后成为 XZ 板）。
// 底板归环境「地面」管（与地面同预设/底色/贴图），乐谱设置只作用于挤出的立体谱面本身。
const backplate = new THREE.Mesh(
	new THREE.PlaneGeometry(1, 1),
	makeBaseMaterial(surf.mat.ground.preset, overridesWithColor("ground")),
);
backplate.position.z = -0.02;
backplate.userData.keepVisible = true; // 不参与视野裁剪，否则谱面飘着像错位
backplate.frustumCulled = false;
stage.add(backplate);

// 水面（世界水平；归入背景组 bgGroup 与地面同进退；不透明纯反射，
// 波浪幅度受乐谱浮起高度钳制）
let water: WaterSurface | null = null;
function ensureWater(): WaterSurface {
	if (water) return water;
	water = new WaterSurface({
		width: 120,
		depth: 40,
		x: focusX,
		z: 0,
		y: -0.12,
		color: surf.waterColor,
		maxAmplitude: 0.1,
	});
	water.setAmplitude(surf.waterAmp);
	water.setSpeed(surf.waterSpeed);
	water.setWaveLength(surf.waterWaveLen);
	water.setVisible(surf.waterOn);
	bgGroup.add(water.mesh);
	return water;
}

// ── 轨道相机状态 ──────────────────────────────────────────────
let focusX = 0; // 焦点 x（视线与乐谱平面的交点；相机始终看向它，即“相机高度锚点”）
let radius = 4; // 相机离锚点的直线距离
let rotX = 52; // 俯角（度）：0=贴水面平视，90=正上方垂直俯视
let rotY = 0; // 偏航（度）：绕世界 +Y 在水面上方环绕
let rotZ = 0; // 翻滚（度）：绕视线
let rMin = 1;
let rMax = 20;
let trackLength = 40;
// 相机跟随：播放时镜头自动按进度匀速平移；用户手动旋转/缩放/拖滑块/方向键接管后置 false，
// 直到下次点播放（togglePlay）才重新跟随。避免一播放镜头把用户刚摆好的视角拽走。
let camFollowing = true;
// 相机模式：'timeline'=时间轴相机（默认，按进度平滑跟随小球，保证在视野内居中）；
// 'free'=自由相机（无任何约束，用户自由旋转缩放，双击中键聚焦当前小球）。
let camMode: "timeline" | "free" = "timeline";
/** 主路径（连线段）时间窗：lo=第一条连线出发、hi=最后一条到达，x0=首音位置。
 *  镜头只在这段跟随小球；null = 没有任何连线 → 退回按进度线性平移（老行为）。 */
let mainWin: { lo: number; hi: number; x0: number; startX: number } | null = null;
// 自由相机用户已接管：applyCam 不再用球坐标覆盖相机位置/角度
let freeTouched = false;
const PITCH_MIN = 5; // 俯角下限：不允许钻到水面以下/与桌面齐平
const PITCH_MAX = 87; // 俯角上限：避免 gimbal
const CAM_DEFAULT = { focus: 0, r: 4 * SCORE_SCALE, rx: 52, ry: 0, rz: 0 }; // r 是世界单位，跟着 SCORE_SCALE 走，否则会被 rMin 钳死

const deg2rad = (d: number): number => (d * Math.PI) / 180;

applyLighting(); // 初始光照（surf / deg2rad 均已就绪）
// applyBloomSurf 不能放这里：它要量发光缓冲的峰值，而那份数据（ballTracks /
// targetMeshes）在文件后段才声明，此刻取会踩 TDZ。挪到 animate 启动前那一行。

function applyCam(): void {
	// 自由相机且用户已接管：保持用户摆好的位置/角度，不被球坐标覆盖
	if (camMode === "free" && freeTouched) {
		syncPanel();
		return;
	}
	// Y-up 世界水平轨道球，锚点（视线与乐谱交点）= (focusX, 0, 0)。
	// θ=俯角决定相机世界高度；φ=偏航绕竖直轴；相机始终在水面上方。
	// 自由相机模式不锁俯仰轨道（允许任意俯仰，含正上方/水面下）；时间轴模式保留限制
	const fx = focusX * SCORE_SCALE; // 焦点 x 存的是内部单位，相机在世界坐标里看它
	const theta = deg2rad(camMode === "free" ? rotX : clamp(rotX, PITCH_MIN, PITCH_MAX));
	const phi = deg2rad(rotY);
	const rh = radius * Math.cos(theta); // 水平投影半径
	camera.position.set(
		fx + rh * Math.sin(phi),
		radius * Math.sin(theta),
		rh * Math.cos(phi), // φ=0 → 相机在 +z 侧，望向 -z：高音谱表(世界 -z)位于屏幕上方
	);
	camera.up.set(0, 1, 0); // 世界 +Y（天空/抛物线弓背方向）永远投影到屏幕上方
	camera.lookAt(fx, 0, 0);
	if (rotZ) camera.rotateZ(deg2rad(rotZ));
	syncPanel();
}

// ── 相机面板：焦点 x + 高度 r / 旋转 x/y/z（滑轨 + 手动输入）──
const focusInput = document.getElementById("focusX")! as HTMLInputElement;
const radiusInput = document.getElementById("radius")! as HTMLInputElement;
const radiusSlide = document.getElementById("radiusSlide")! as HTMLInputElement;
const rxInput = document.getElementById("rotX")! as HTMLInputElement;
const rxSlide = document.getElementById("rotXSlide")! as HTMLInputElement;
const ryInput = document.getElementById("rotY")! as HTMLInputElement;
const rySlide = document.getElementById("rotYSlide")! as HTMLInputElement;
const rzInput = document.getElementById("rotZ")! as HTMLInputElement;
const rzSlide = document.getElementById("rotZSlide")! as HTMLInputElement;
// 自由相机：世界位置 xyz + 姿态角（偏航/俯仰/翻滚），直接读写 camera 矩阵
const freeNum = (id: string): HTMLInputElement =>
	document.getElementById(id)! as HTMLInputElement;
const freeInputs = {
	x: [freeNum("freeXSlide"), freeNum("freeX")],
	y: [freeNum("freeYSlide"), freeNum("freeY")],
	z: [freeNum("freeZSlide"), freeNum("freeZ")],
	yaw: [freeNum("freeYawSlide"), freeNum("freeYaw")],
	pitch: [freeNum("freePitchSlide"), freeNum("freePitch")],
	roll: [freeNum("freeRollSlide"), freeNum("freeRoll")],
} as const;
const camSetTimeline = document.getElementById("camSetTimeline")!;
const camSetFree = document.getElementById("camSetFree")!;
// 居中跟随：容忍度 = 允许球偏离焦点多远才拉回（0 = 纯时间轴不跟随）；偏移 = 球停在中心线多远处
const camTolSlide = document.getElementById("camTolSlide")! as HTMLInputElement;
const camTolInput = document.getElementById("camTol")! as HTMLInputElement;
const camOffSlide = document.getElementById("camOffSlide")! as HTMLInputElement;
const camOffInput = document.getElementById("camOff")! as HTMLInputElement;
let camCenterTol = Number(camTolSlide.value) || 0;
let camCenterOffset = Number(camOffSlide.value) || 0;
bindSliderPair(camTolSlide, camTolInput, (v) => {
	camCenterTol = Math.max(0, v);
});
bindSliderPair(camOffSlide, camOffInput, (v) => {
	camCenterOffset = v;
});
// ── 顶栏「工具 ▾」：首尾 Mid 偏移量 = 第三页「播放 → 起点/终点留白」同一份数据
// （进来先读第三页的值，改完写回 store，回第三页看到的就是这个数） ──
const axisLeadSlide = document.getElementById("axisLeadSlide")! as HTMLInputElement;
const axisLeadNum = document.getElementById("axisLeadNum")! as HTMLInputElement;
const axisTailSlide = document.getElementById("axisTailSlide")! as HTMLInputElement;
const axisTailNum = document.getElementById("axisTailNum")! as HTMLInputElement;
bindSliderPair(axisLeadSlide, axisLeadNum, (v) => setAxisLead(v));
bindSliderPair(axisTailSlide, axisTailNum, (v) => setAxisTail(v));
// ── 工具下拉：相机模式（自绘下拉，不用浏览器原生 select） ──
const rad2deg = (r: number): number => (r * 180) / Math.PI;
const camModeOptions = (): { v: string; l: string }[] => [
	{ v: "timeline", l: t("cam.mode.timeline") },
	{ v: "free", l: t("cam.mode.free") },
];
const camModePick = createSelect({
	options: camModeOptions(),
	value: camMode,
	ariaLabel: t("cam.mode"),
	onChange: (v) => {
		camMode = v === "free" ? "free" : "timeline";
		camFollowing = camMode === "timeline";
		freeTouched = false; // 切模式时先按当前球坐标初始化一次，再交给用户自由控制
		applyCamModeUI();
		applyCam();
	},
});
document.getElementById("camModePick")!.append(camModePick.el);

/** 模式决定相机 tab 里露哪一套：时间轴=焦点/容忍度/半径/角度，自由=xyz+三角度 */
function applyCamModeUI(): void {
	camSetTimeline.hidden = camMode !== "timeline";
	camSetFree.hidden = camMode !== "free";
}
applyCamModeUI();

// ── 工具下拉的两个 tab：相机 / 时间 ──
{
	const tabs = Array.from(
		document.querySelectorAll<HTMLElement>("#camPanel .cam-tab"),
	);
	const panes = Array.from(
		document.querySelectorAll<HTMLElement>("#camPanel .cam-pane"),
	);
	for (const t of tabs) {
		t.addEventListener("click", () => {
			for (const o of tabs) o.classList.toggle("is-on", o === t);
			for (const p of panes) p.hidden = p.dataset.pane !== t.dataset.tab;
			if (t.dataset.tab === "fix") {
				// 打开就重扫一遍（只判定不动手）：面板关着时巡检照跑，
				// 但列表必须拿当下的判定回填，不能显示上一次的旧结论
				lastPatrolAt = Date.now();
				renderFixList(runSelfCheck(false));
				paintFixDiag();
			}
		});
	}
}

// ── 修复页签：自检 + 巡检调度 + 四级手动刷新 ──────────────────────
// 思路：能靠确定性信号判定的问题都写成一个「检测 + 修法」对。修法可以自动执行
// （巡检开着且没关自动修复），但每一项永远同时给手动按钮——自动只是省事，
// 不是唯一路径；用户关掉自动修复后，同一批问题照样逐条按得动。
type FixLevel = "ok" | "auto" | "fixable" | "manual";
interface FixItem {
	id: string;
	level: FixLevel;
	detail: string;
	/** level=fixable / manual 时的手动入口（fixable = 能自动修但这次没动手） */
	fix?: () => void;
	fixLabel?: string;
}

/** buildAll 结束时 stage 的子节点数：之后对不上就说明有节点是在重建之外被加/减的 */
let stageBuiltCount = 0;
/** 载入本页时上游 XML 的长度：之后变了说明第 2/3 页改过谱而本页没重画 */
let bootXmlLen = 0;
/** 上一次自检的资源计数，用来判断是不是单调增长（疑似泄漏） */
let fixBaseline: { geo: number; tex: number } | null = null;

/** 内联看门狗（index.html 头部那段）公开的装配状态：ready=模块顶层求值全部走完，
 *  err=走完之前收到的第一条脚本运行时错误原文。 */
interface AsmState {
	ready: boolean;
	err: string;
}
function asmState(): AsmState {
	const w = window as unknown as { __lumiAsm?: Partial<AsmState> };
	return { ready: w.__lumiAsm?.ready ?? false, err: w.__lumiAsm?.err ?? "" };
}

/** 必须由脚本装配出来的控件容器，按各自在 main.ts 里的装配点先后排列（950 → 1552 → 7449），
 *  缺哪个就说明求值停在哪一段——顺序本身就是诊断线索。
 *  空着 = 顶层求值中途抛错，后半段一个都没执行：页面看着正常，下拉却全没了。 */
const ASM_SLOTS: { id: string; min?: number; probe?: () => boolean }[] = [
	{ id: "camModePick", min: 1 },
	{ id: "fixPatrol", min: 6 },
	{ id: "surfPanel", probe: () => !!document.querySelector(".sp-host") },
];

/** 找出没装上的容器名 */
function missingAsmSlots(): string[] {
	return ASM_SLOTS.filter((s) => {
		if (s.probe) return !s.probe();
		const el = document.getElementById(s.id);
		return !el || el.children.length < (s.min ?? 1);
	}).map((s) => s.id);
}

/** 当前谱面的 x 跨度（含 2 个单位余量）：越界的就是不属于这张谱的旧节点 */
function scoreXSpan(): { lo: number; hi: number } {
	let lo = Infinity;
	let hi = -Infinity;
	for (const e of allElems) {
		const x0 = e.worldX - e.w / 2;
		const x1 = e.worldX + e.w / 2;
		if (x0 < lo) lo = x0;
		if (x1 > hi) hi = x1;
	}
	return Number.isFinite(lo)
		? { lo: lo - 2, hi: hi + 2 }
		: { lo: -Infinity, hi: Infinity };
}

/** 找出不属于当前谱面的节点，但不摘除。
 *  只认「x 区间完全落在谱面之外」这一条硬证据，宁可漏报也不误删用户的谱。 */
function findStaleNodes(): THREE.Object3D[] {
	const span = scoreXSpan();
	return stage.children.filter((m) => {
		if (m.userData.keepVisible) return false;
		const x0 = m.userData.worldX0 as number | undefined;
		if (x0 === undefined) return false;
		const x1 = (m.userData.worldX1 as number | undefined) ?? x0;
		return x1 < span.lo || x0 > span.hi;
	});
}

/** 摘除给定节点并释放其 GPU 资源 */
function removeStaleNodes(list: THREE.Object3D[]): number {
	for (const o of list) {
		stage.remove(o);
		const m = o as THREE.Mesh;
		m.geometry?.dispose();
		const mm = m.material as THREE.Material | THREE.Material[];
		if (Array.isArray(mm)) mm.forEach((x) => x.dispose());
		else mm?.dispose();
	}
	return list.length;
}

async function reloadScoreData(): Promise<void> {
	const xml = sessionStorage.getItem("midee.xml");
	if (!xml) return;
	await renderScore(
		sessionStorage.getItem("midee.name") ?? t("common.untitled"),
		xml,
	);
}

/** 跑一轮自检。
 *  apply=true  → 检出的问题当场修掉，条目记为 auto；
 *  apply=false → 只判定不动手，条目记为 fixable，修法挂在按钮上。
 *  两种情况下条目都带 fix 闭包：自动只是省一次点击，不是唯一路径。
 */
function runSelfCheck(apply: boolean): FixItem[] {
	const out: FixItem[] = [];
	const i = renderer.info;

	// 1) 场景树残留：x 落在当前谱面之外的节点（上一张谱没重画干净）+ 节点数漂移
	//    （buildAll 中途报错会少建一半，只靠 x 判不出来）
	const stale = allElems.length ? findStaleNodes() : [];
	const removed = stale.length && apply ? removeStaleNodes(stale) : 0;
	const drift = Math.abs(stage.children.length - stageBuiltCount);
	if (stale.length)
		out.push({
			id: "residue",
			level: apply ? "auto" : "fixable",
			detail: apply
				? t("fix.residueRemoved", { n: removed })
				: t("fix.residueFound", { n: stale.length }),
			fixLabel: t("fix.residueSweep"),
			fix: () => removeStaleNodes(findStaleNodes()),
		});
	else if (drift > 0)
		out.push({
			id: "residue",
			level: "manual",
			detail: t("fix.residueDrift", { n: drift }),
			fixLabel: t("fix.scene"),
			fix: rebuildSceneTier,
		});
	else
		out.push({
			id: "residue",
			level: "ok",
			detail: t("fix.residueOk", { n: stage.children.length }),
		});

	// 2) 发光层可达性。两种「拖了没反应」：
	//    ① 峰值为 0 —— 四条源（小球/点亮/底面/天空）的光效全是 0，缓冲里根本没有光源；
	//    ② 阈值 ≥ 峰值 —— 高通把整层滤成纯黑。开着「阈值自动」时这多半只是派生值
	//       还没补算（页面在后台 rAF 被节流就是一例），所以先现算一遍再判；
	//       手动态就是用户自己的设置了，只给按钮。
	const peak = bloom.peakLuma();
	if (peak <= 0 && !allElems.length)
		// 谱面还没建出来（刚进页面 / 空状态）：峰值为 0 属正常，别报成故障
		out.push({ id: "bloom", level: "ok", detail: t("fix.bloomIdle") });
	else if (peak <= 0)
		out.push({
			id: "bloom",
			level: "manual",
			detail: t("fix.bloomNoSource"),
		});
	else {
		if (apply && surf.bloomAutoThreshold) syncBloomThreshold();
		const gated = surf.bloomThreshold >= peak;
		out.push({
			id: "bloom",
			level: gated ? "manual" : "ok",
			detail: gated
				? t("fix.bloomGated", {
						thr: surf.bloomThreshold.toFixed(2),
						peak: peak.toFixed(2),
					})
				: t("fix.bloomOk", {
						thr: surf.bloomThreshold.toFixed(2),
						peak: peak.toFixed(2),
					}),
			fixLabel: surf.bloomAutoThreshold
				? t("fix.bloomRecalc")
				: t("sp.bloomAuto"),
			fix: () => {
				if (surf.bloomAutoThreshold) syncBloomThreshold();
				else applySurf({ bloomAutoThreshold: true });
			},
		});
	}

	// 3) 网络贴图掉缓存（材质说要贴图，缓存里却没有 → 画面是纯色）
	const lostTex: ("score" | "ground" | "ball")[] = [];
	for (const o of ["score", "ground", "ball"] as const) {
		const cfg = surf.mat[o];
		if (cfg.source === "network" && cfg.tex && !texObjDone.has(`${o}|${cfg.tex}`))
			lostTex.push(o);
	}
	if (lostTex.length) {
		if (apply) for (const o of lostTex) applyTexAsync(o, surf.mat[o]);
		out.push({
			id: "tex",
			level: apply ? "auto" : "fixable",
			detail: apply
				? t("fix.texReloaded", { n: lostTex.length })
				: t("fix.texMissing", { n: lostTex.length }),
			fixLabel: t("fix.texReload"),
			fix: () => {
				// 只重拉缓存里没有的那几组：已经加载成功的别重复传一遍显存
				for (const o of ["score", "ground", "ball"] as const) {
					const cfg = surf.mat[o];
					if (cfg.source === "network" && cfg.tex) applyTexAsync(o, cfg);
				}
			},
		});
	} else
		out.push({
			id: "tex",
			level: "ok",
			detail: t("fix.texOk"),
			fixLabel: t("fix.texReload"),
			fix: () => {
				for (const o of ["score", "ground", "ball"] as const)
					applyTexAsync(o, surf.mat[o]);
			},
		});

	// 4) 音频被浏览器挂起（有 player 却没在跑）：resume 是唯一解，也绝对安全
	let audioState = "";
	try {
		audioState = player ? getContext().state : "";
	} catch {
		audioState = "";
	}
	if (audioState === "suspended") {
		if (apply) void getContext().resume().catch(() => undefined);
		out.push({
			id: "audio",
			level: apply ? "auto" : "fixable",
			detail: apply ? t("fix.audioResumed") : t("fix.audioSuspended"),
			fixLabel: t("fix.audioRetry"),
			fix: () => {
				void getContext().resume().catch(() => undefined);
			},
		});
	} else if (audioState)
		out.push({
			id: "audio",
			level: "ok",
			detail: t("fix.audioOk"),
			fixLabel: t("fix.audioRetry"),
			fix: () => {
				void getContext().resume().catch(() => undefined);
			},
		});

	// 5) 上游数据与本页场景不一致（第 2/3 页改过谱）。
	//    重画会打断播放，绝不自动做 —— 只给入口。
	const nowXml = (sessionStorage.getItem("midee.xml") ?? "").length;
	if (bootXmlLen > 0 && nowXml > 0 && nowXml !== bootXmlLen)
		out.push({
			id: "upstream",
			level: "manual",
			detail: t("fix.upstreamStale", { a: bootXmlLen, b: nowXml }),
			fixLabel: t("fix.upstreamReload"),
			fix: () => void reloadScoreData(),
		});
	else
		out.push({ id: "upstream", level: "ok", detail: t("fix.upstreamOk") });

	// 6) 资源账本趋势（只报不删：判不出「合法共享」和「泄漏」，删错就是黑模）
	const grew =
		fixBaseline !== null &&
		(i.memory.geometries > fixBaseline.geo + Math.max(20, fixBaseline.geo * 0.25) ||
			i.memory.textures > fixBaseline.tex + Math.max(6, fixBaseline.tex * 0.25));
	if (grew && fixBaseline)
		out.push({
			id: "res",
			level: "manual",
			detail: t("fix.resGrew", {
				g0: fixBaseline.geo,
				g: i.memory.geometries,
				t0: fixBaseline.tex,
				t: i.memory.textures,
			}),
			fixLabel: t("fix.post"),
			fix: rebuildPostTier,
		});
	else
		out.push({
			id: "res",
			level: "ok",
			detail: t("fix.resOk", {
				g: i.memory.geometries,
				t: i.memory.textures,
				p: i.programs?.length ?? 0,
			}),
		});
	fixBaseline = { geo: i.memory.geometries, tex: i.memory.textures };

	// 7) GL 上下文状态
	if (renderer.getContext().isContextLost?.() ?? false)
		out.push({
			id: "ctx",
			level: "manual",
			detail: t("fix.ctxLost"),
			fixLabel: t("fix.context"),
			fix: () => void resetContextTier(),
		});
	else out.push({ id: "ctx", level: "ok", detail: t("fix.ctxOk") });

	// 8) 光晕特效样式关着、但逐路径范围还留着旧值（老存档会这样，滑杆已隐藏 → 说不清）
	const glowRanges = surf.pathNums.ballGlowRange ?? [];
	if (surf.ballGlowStyle === "off" && glowRanges.some((v) => (v ?? 0) > 0))
		out.push({
			id: "glow",
			level: "manual",
			detail: t("fix.glowOffButRange"),
			fixLabel: t("fix.glowEnable"),
			fix: () => applySurf({ ballGlowStyle: "soft" }),
		});
	else out.push({ id: "glow", level: "ok", detail: t("fix.glowOk") });

	// 9) 渲染循环心跳：rAF 链断了（切后台被节流后没恢复）画面就冻住
	const stalled = !document.hidden && !exportHold && performance.now() - lastFrameAt > 4000;
	if (stalled && apply) ensureLoop();
	if (stalled)
		out.push({
			id: "loop",
			level: apply ? "auto" : "fixable",
			detail: apply
				? t("fix.loopRestarted")
				: t("fix.loopStalled", {
						s: ((performance.now() - lastFrameAt) / 1000).toFixed(1),
					}),
			fixLabel: t("fix.loopRetry"),
			fix: ensureLoop,
		});
	else
		out.push({
			id: "loop",
			level: "ok",
			detail: exportHold
				? t("fix.loopExport")
				: t("fix.loopOk", { s: ((performance.now() - lastFrameAt) / 1000).toFixed(1) }),
		});

	// 10) 外壳装配：顶层求值一旦中断，自绘下拉、巡检面板、场景窗这些「脚本造出来的控件」
	//     根本不存在，而页面骨架看着一切正常——内联看门狗会弹横幅，这里留下可复查的账。
	{
		const empty = missingAsmSlots();
		const st = asmState();
		if (!empty.length && st.ready)
			out.push({
				id: "asm",
				level: "ok",
				detail: t("fix.asmOk", {
					n: document.querySelectorAll(".sh-select").length,
				}),
			});
		else {
			const parts: string[] = [
				empty.length
					? t("fix.asmEmpty", { ids: empty.join(" · ") })
					: t("fix.asmNoReport"),
				st.err ? t("fix.asmErr", { msg: st.err }) : t("fix.asmNoErr"),
			];
			out.push({
				id: "asm",
				level: "manual",
				detail: parts.join(" · "),
				fixLabel: t("fix.asmReload"),
				fix: () => location.reload(),
			});
		}
	}

	return out;
}

const fixDiagEl = document.getElementById("fixInfo");
const fixListEl = document.getElementById("fixList");
const fixStampEl = document.getElementById("fixStamp");

function renderFixList(items: FixItem[]): void {
	if (!fixListEl || !camPanelShown()) return;
	fixListEl.textContent = "";
	for (const it of items) {
		const row = document.createElement("div");
		row.className = "fix-item fix-item--" + it.level;
		const mark = document.createElement("span");
		mark.className = "fix-item__mark";
		mark.textContent =
			it.level === "ok"
				? "✓"
				: it.level === "auto"
					? "⚙"
					: it.level === "fixable"
						? "◆"
						: "!";
		const name = document.createElement("span");
		name.className = "fix-item__name";
		name.textContent = t("fix.item." + it.id);
		const detail = document.createElement("span");
		detail.className = "fix-item__detail";
		detail.textContent = it.detail;
		row.append(mark, name, detail);
		// auto 档也留按钮：修过一次不等于以后不用再修，而且用户有权手动重来
		if (it.fix) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "sh-btn sh-btn--sm fix-item__btn";
			btn.textContent = it.fixLabel ?? t("fix.run");
			btn.addEventListener("click", () => {
				it.fix?.();
				renderFixList(runSelfCheck(false));
				paintFixDiag();
			});
			row.append(btn);
		}
		fixListEl.append(row);
	}
	if (fixStampEl)
		fixStampEl.textContent = t("fix.stamp", {
			time: new Date(lastPatrolAt || Date.now()).toLocaleTimeString(),
			n: items.filter((x) => x.level !== "ok").length,
		});
}
function paintFixDiag(): void {
	if (!fixDiagEl || !camPanelShown()) return;
	const i = renderer.info;
	fixDiagEl.textContent = [
		`${t("fix.diag.geo")} ${i.memory.geometries} · ${t("fix.diag.tex")} ${i.memory.textures} · ${t("fix.diag.prog")} ${i.programs?.length ?? 0}`,
		`${t("fix.diag.calls")} ${i.render.calls} · ${t("fix.diag.tris")} ${i.render.triangles.toLocaleString()}`,
		`${t("fix.diag.elems")} ${allElems.length} · ${t("fix.diag.tracks")} ${ballTracks.length} · ${t("fix.diag.ties")} ${tieLights.length}`,
		`${t("fix.diag.stage")} ${stage.children.length}/${stageBuiltCount} · ${t("fix.diag.frame")} ${lastFrameAt ? ((performance.now() - lastFrameAt) / 1000).toFixed(1) + "s" : "-"}`,
		`${t("fix.diag.asm")} ${ASM_SLOTS.length - missingAsmSlots().length}/${ASM_SLOTS.length} · ${t("fix.diag.selects")} ${document.querySelectorAll(".sh-select").length}`,
	].join("\n");
}

// ── 巡检调度：定时器 + 四个触发时机，全部可关 ─────────────────────
let patrolTimer: number | null = null;
let patrolSettingTimer: number | null = null;
let lastPatrolAt = 0;
/** 触发时机 → surf.repair 里的开关字段；interval（定时器）不受单项开关约束 */
const PATROL_TRIGGER_KEY = {
	boot: "onBoot",
	setting: "onSetting",
	visible: "onVisible",
	context: "onContext",
	interval: null,
} as const;
type PatrolTrigger = keyof typeof PATROL_TRIGGER_KEY;

/** 巡检一次：判定 → （开着自动修复就）当场修 → 回填列表 */
function patrol(trigger: PatrolTrigger): void {
	const rp = surf.repair;
	const key = PATROL_TRIGGER_KEY[trigger];
	if (!rp.patrolOn || (key && !rp[key])) return;
	// 后台标签页里 rAF 被节流，心跳/资源计数全是噪声，回来时 onVisible 会补扫
	if (document.visibilityState === "hidden") return;
	lastPatrolAt = Date.now();
	const items = runSelfCheck(rp.autoApply);
	renderFixList(items);
	paintFixDiag();
}

/** 改设置后延后一拍再扫：滑杆拖动时别每帧都跑判定 */
function scheduleSettingPatrol(): void {
	if (patrolSettingTimer !== null) clearTimeout(patrolSettingTimer);
	patrolSettingTimer = window.setTimeout(() => {
		patrolSettingTimer = null;
		patrol("setting");
	}, 1500);
}

/** 按当前间隔重排定时器；关掉巡检就彻底不排 */
function applyPatrolSchedule(): void {
	if (patrolTimer !== null) {
		clearInterval(patrolTimer);
		patrolTimer = null;
	}
	if (!surf.repair.patrolOn) return;
	patrolTimer = window.setInterval(
		() => patrol("interval"),
		Math.max(5, surf.repair.intervalSec) * 1000,
	);
}

/** 巡检设置控件（复选框 + 间隔滑轨），全部走 applySurf → 自动持久化 + 重排定时器 */
function buildPatrolUi(): void {
	const box = document.getElementById("fixPatrol");
	if (!box) return;
	box.textContent = "";
	const rp = () => surf.repair;
	const set = (k: keyof RepairSettings, v: number | boolean): void => {
		applySurf({ repair: { ...rp(), [k]: v } });
		syncPatrolState();
	};
	const check = (k: keyof RepairSettings, labelKey: string): void => {
		const row = document.createElement("label");
		row.className = "cam-row fix-check";
		const inp = document.createElement("input");
		inp.type = "checkbox";
		inp.checked = Boolean(rp()[k]);
		inp.addEventListener("change", () => set(k, inp.checked));
		const sp = document.createElement("span");
		sp.textContent = t(labelKey);
		sp.setAttribute("data-i18n", labelKey);
		row.append(sp, inp);
		box.append(row);
	};
	check("patrolOn", "fix.p.on");
	check("autoApply", "fix.p.autoApply");
	const sub = document.createElement("div");
	sub.className = "cam-note";
	sub.setAttribute("data-i18n", "fix.p.autoApplyHint");
	sub.textContent = t("fix.p.autoApplyHint");
	box.append(sub);
	const head = document.createElement("div");
	head.className = "fix-prompt";
	head.setAttribute("data-i18n", "fix.p.triggers");
	head.textContent = t("fix.p.triggers");
	box.append(head);
	check("onBoot", "fix.p.boot");
	check("onSetting", "fix.p.setting");
	check("onVisible", "fix.p.visible");
	check("onContext", "fix.p.context");
	// 扫描间隔：滑轨 + 数字框一对（与相机面板同款控件）
	const row = document.createElement("div");
	row.className = "cam-row cam-row--slide";
	const lab = document.createElement("span");
	lab.setAttribute("data-i18n", "fix.p.interval");
	lab.textContent = t("fix.p.interval");
	const slide = document.createElement("input");
	slide.type = "range";
	slide.min = "5";
	slide.max = "600";
	slide.step = "5";
	const num = document.createElement("input");
	num.type = "number";
	num.min = "5";
	num.max = "600";
	num.step = "5";
	bindSliderPair(slide, num, (v) =>
		set("intervalSec", clamp(Math.round(v || 5), 5, 600)),
	);
	slide.value = num.value = String(rp().intervalSec);
	row.append(lab, slide, num);
	box.append(row);
	applyI18n(box);
}

/** 巡检状态汇总（页签标题行那句「开 · 每 30s · 自动修」）：改了开关或定时器都要刷新 */
function syncPatrolState(): void {
	applyPatrolSchedule();
	const state = document.getElementById("fixPatrolState");
	if (state)
		state.textContent = surf.repair.patrolOn
			? t("fix.p.onState", {
					s: surf.repair.intervalSec,
					m: surf.repair.autoApply ? t("fix.p.stateAuto") : t("fix.p.stateScan"),
				})
			: t("fix.p.offState");
}

// 四级手动刷新：越往下越慢也越彻底，各档只动自己那一层
function refreshBuffersTier(): void {
	// 轻刷：不新建任何对象，只把当前 surf 重新打到现有材质/uniform/裁剪/淡出贴图上
	applySurf({});
	updateBallMaterials();
	refreshLitColors();
	refreshTieColors();
	applyViewCrop();
	syncPanel();
}
function refreshBallsTier(): void {
	if (!allElems.length) return;
	initBalls(); // 球池/光晕网格/分支状态整套重建
	clearAllTrailHist(); // 拖尾历史留在旧轨迹上会拖出「幽灵线」
	updateBalls(visTime);
}
function rebuildSceneTier(): void {
	if (!allElems.length) return;
	renderProg.show(t("p4.prog.geo"));
	// 让出一帧再算：同步重建大谱面会卡住弹窗绘制，看起来像没响应
	requestAnimationFrame(() => {
		buildAll();
		refreshLitColors();
		updateBalls(visTime);
		renderProg.done(t("p4.prog.geoDone"));
		renderFixList(runSelfCheck(false));
	});
}
function rebuildPostTier(): void {
	rebuildPost();
	applyBloomSurf();
}
async function resetContextTier(): Promise<void> {
	const ok = await confirmDialog({
		title: t("fix.context"),
		message: t("fix.contextConfirm"),
		danger: true,
	});
	if (!ok) return;
	rebuildRenderer(); // 内含 bloom 重建 + 贴图重传 + 全量重画几何
	renderFixList(runSelfCheck(false));
}

function repaintAfterTier(): void {
	renderFixList(runSelfCheck(false));
	paintFixDiag();
}
// 手动扫描 = 只判定不动手；手动执行 = 判定 + 当场全修（无视自动修复开关）
document.getElementById("fixCheck")?.addEventListener("click", () => {
	lastPatrolAt = Date.now();
	renderFixList(runSelfCheck(false));
	paintFixDiag();
});
document.getElementById("fixApplyAll")?.addEventListener("click", () => {
	lastPatrolAt = Date.now();
	renderFixList(runSelfCheck(true));
	paintFixDiag();
});
document.getElementById("fixBuffers")?.addEventListener("click", () => {
	refreshBuffersTier();
	repaintAfterTier();
});
document.getElementById("fixBalls")?.addEventListener("click", () => {
	refreshBallsTier();
	repaintAfterTier();
});
document.getElementById("fixScene")?.addEventListener("click", () => {
	rebuildSceneTier();
});
document.getElementById("fixPost")?.addEventListener("click", () => {
	rebuildPostTier();
	repaintAfterTier();
});
document.getElementById("fixContext")?.addEventListener("click", () => {
	void resetContextTier();
});
buildPatrolUi();
syncPatrolState();

/** 面板是否真在屏幕上（camPanel 被外壳搬进「工具 ▾」，下拉关着就不用回填输入框） */
function camPanelShown(): boolean {
	const host = document
		.getElementById("camPanel")
		?.closest<HTMLElement>(".sh-dropdown");
	return !host?.hidden;
}

/** 自由相机位姿 → 六个输入框（拖拽/滚轮/捏合后也走这里，前提是下拉开着） */
function readFreePoseToPanel(): void {
	if (camMode !== "free" || !camPanelShown()) return;
	const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
	const set = (
		pair: readonly [HTMLInputElement, HTMLInputElement],
		v: number,
	): void => {
		const s = r2(v);
		pair[0].value = s;
		pair[1].value = s;
	};
	set(freeInputs.x, camera.position.x);
	set(freeInputs.y, camera.position.y);
	set(freeInputs.z, camera.position.z);
	set(freeInputs.yaw, rad2deg(e.y));
	// three 的相机 +X 是抬头，面板按「正=俯视」的直觉取反（与时间轴相机的俯角同向）
	set(freeInputs.pitch, -rad2deg(e.x));
	set(freeInputs.roll, rad2deg(e.z));
}
/** 六个输入框 → 相机位姿（YXZ 欧拉序：偏航绕世界 up、俯仰绕相机右、翻滚绕视线） */
function applyFreePose(): void {
	const v = (pair: readonly [HTMLInputElement, HTMLInputElement]): number =>
		Number.parseFloat(pair[1].value || pair[0].value) || 0;
	camera.position.set(v(freeInputs.x), v(freeInputs.y), v(freeInputs.z));
	camera.quaternion.setFromEuler(
		new THREE.Euler(
			-deg2rad(v(freeInputs.pitch)),
			deg2rad(v(freeInputs.yaw)),
			deg2rad(v(freeInputs.roll)),
			"YXZ",
		),
	);
	freeTouched = true; // 手动摆位 → 视为用户接管，applyCam 不再用球坐标覆盖
	readFreePoseToPanel();
}
for (const pair of Object.values(freeInputs)) {
	bindSliderPair(pair[0], pair[1], () => applyFreePose());
}

// ── 音画对齐（毫秒，持久化）：只搬可视时钟，音频时刻不动 ──
const AV_KEY = "midee.avOffset";
let avOffset = 0; // 秒：visTime = 音频时刻 + avOffset（正=画面超前）
try {
	const raw = Number(localStorage.getItem(AV_KEY));
	if (Number.isFinite(raw)) avOffset = Math.max(-2, Math.min(2, raw));
} catch {
	/* 读不到就 0 */
}
const avSlide = document.getElementById("avOffsetSlide")! as HTMLInputElement;
const avNum = document.getElementById("avOffsetNum")! as HTMLInputElement;
function syncAvInputs(): void {
	const ms = String(Math.round(avOffset * 1000));
	avSlide.value = ms;
	avNum.value = ms;
}
/** 音画对齐改值：写状态 + 持久化 + 回填（不动音频，画面整体前后挪） */
function setAvOffset(ms: number): void {
	avOffset = Math.max(-2, Math.min(2, (Number(ms) || 0) / 1000));
	try {
		localStorage.setItem(AV_KEY, String(avOffset));
	} catch {
		/* 存不进就只在本次生效 */
	}
	syncAvInputs();
}
bindSliderPair(avSlide, avNum, (v) => setAvOffset(v));
document.getElementById("avZero")!.addEventListener("click", () => {
	setAvOffset(0);
});

// ── 视觉时钟 = 音频播放头 + 音画对齐偏移 + 每小节软矫正 ──────────────
// 全站只有这一条换算式：小球、点亮、连音线前沿、镜头、播放条都必须先过它，
// 否则「球到了但灯没亮」这类错位又会长回来。
/** 每小节锚点：a=播放头秒（发声网格），c=这一小节画面时间要额外加的量。
 *  由 bindTargetTimes 按「画面网格 − 实际发声网格」算出（src/score/midiAlign）。 */
let corrAnchors: CorrAnchor[] = [];

/** 音频播放头秒 → 画面秒 */
const toVisTime = (audio: number): number =>
	audio + avOffset + corrAt(corrAnchors, audio);
/** 起播落点（音频秒）：留白要长到装得下音画对齐偏移，见 togglePlay */
const audioFloor = (): number => -axisLead - Math.max(0, avOffset);

syncAvInputs();

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

function syncPanel(): void {
	// 面板里的框正被编辑/拖着时不回填：syncPanel 会在滚轮、方向键、播放每帧被调用，
	// 无条件写 value 会把「打到一半的半径」冲掉，也会跟正在拖的滑轨抢手柄位置。
	const act = document.activeElement;
	const put = (input: HTMLInputElement, v: string): void => {
		if (input !== act) input.value = v;
	};
	put(focusInput, r2(focusX));
	if (radiusSlide !== act) {
		radiusSlide.min = r2(rMin);
		radiusSlide.max = r2(rMax);
	}
	put(radiusSlide, r2(radius));
	put(radiusInput, r2(radius));
	const rx = String(Math.round(rotX));
	const ry = String(Math.round(rotY));
	const rz = String(Math.round(rotZ));
	put(rxSlide, rx);
	put(rySlide, ry);
	put(rzSlide, rz);
	put(rxInput, rx);
	put(ryInput, ry);
	put(rzInput, rz);
	refreshSliderFill(radiusSlide);
	refreshSliderFill(rxSlide);
	refreshSliderFill(rySlide);
	refreshSliderFill(rzSlide);
	readFreePoseToPanel(); // 自由相机：xyz + 三角度随时跟着真实位姿回填（面板没开就直接返回）
}
/** 统一焦点入口：只改相机（全量构建，无需 LOD 跟随）；播放中手动改 → 同步音频 seek */
function setFocusX(v: number, fromPlay = false): void {
	const clamped = Math.max(0, Math.min(trackLength, v));
	if (Math.abs(clamped - focusX) < 0.001 && !fromPlay) return;
	focusX = clamped;
	applyCam();
	applyViewCrop();
	water?.setCenterX(focusX);
	// 手动改焦点 → 音频跳转（相机与播放位置绑定；player 未就绪时忽略）
	// 用与球轨迹一致的 x→time 逆映射，避免线性 seek 被非播放帧的 focusXAtTime 拉回
	if (player && player.duration > 0 && !fromPlay) {
		const tt = trackLength > 0 ? xToTime(clamped) : null;
		player.seek(
			tt !== null
				? tt
				: trackLength > 0
					? (clamped / trackLength) * player.duration
					: 0,
		);
	}
}
/** 偏航/翻滚钳制到 ±180（手动输入用；滑轨本身无法越界） */
function clampAngle(v: number): number {
	return clamp(v, -ROT_LIMIT, ROT_LIMIT);
}
/** 俯角钳制：始终在水面上方、不正顶（避免水平环绕 gimbal） */
function clampPitch(v: number): number {
	return clamp(v, PITCH_MIN, PITCH_MAX);
}

// ── 视野裁剪：以锚点 (focusX, 0, 0) 为中心、surf.viewRadius 为半宽的窗口 ──
// 判据是元素 x 区间 [worldX0, worldX1] 与窗口 [focusX-r, focusX+r] 是否重叠
// （不是中心点距离！合并谱线横贯全谱、中心在谱中间，按中心裁剪会把整条谱线
// 误杀成"谱线丢失"）。背景组（地面/水面）不在此裁剪：它们整体跟随焦点 +
// 边缘淡出，见 bgGroup。
function applyViewCrop(): void {
	const r = Math.max(0.5, surf.viewRadius);
	const lo = focusX - r;
	const hi = focusX + r;
	for (const m of stage.children) {
		// 底板/光照辅助等常驻元素不参与裁剪（否则谱面"飘起来"像错位）
		if (m.userData.keepVisible) {
			m.visible = true;
			continue;
		}
		const x0 =
			(m.userData.worldX0 as number | undefined) ??
			(m.userData.worldX as number | undefined) ??
			Number(m.position.x);
		const x1 = (m.userData.worldX1 as number | undefined) ?? x0;
		m.visible = x1 >= lo && x0 <= hi;
	}
	// 小球与轨迹线的视野裁剪在 updateBalls 里逐帧处理（球每帧重定位）
}

/** 安全解析 #rrggbb / rrggbb；非法/缺失时回退 fallback（避免 NaN 导致材质变黑） */
function parseColorHex(
	hex: string | undefined | null,
	fallback: number,
): number {
	const n = parseInt((hex ?? "").replace("#", ""), 16);
	return Number.isFinite(n) ? n : fallback;
}

/** 只 dispose 材质本身，不 dispose 其贴图（网络贴图由缓存统一管理、跨材质复用） */
function disposeMaterialOnly(
	mat: THREE.Material | THREE.Material[] | null | undefined,
): void {
	if (!mat) return;
	const arr = Array.isArray(mat) ? mat : [mat];
	for (const m of arr) m.dispose();
}

/** 某对象当前配置 + 物理调参 → 材质构造覆盖（粗糙度/金属度/玻璃不透明度/颜色着色） */
function overridesFor(obj: "score" | "ground" | "ball"): MatOverrides {
	const tune = surf.matTune[obj];
	const cfg = surf.mat[obj];
	const ov: MatOverrides = { roughness: tune.rough, metalness: tune.metal };
	if (isGlassPreset(cfg.preset)) ov.opacity = tune.trans;
	return ov;
}

/**
 * 颜色只有一个来源：路径色。小球、点亮符头、中心圆片全走这里。
 * 原先还叠加了「音轨色 trackColors / 小球材质底色 / 乐谱色」三级兜底，
 * 同一颗音和它的球各自取不同色板，第三页增删路径后必然错位——已整体撤销。
 * pathIdx < 0 = 该音符不在任何球轨上（孤立音），按轨号回到默认色板。
 */
function pathColorFor(pathIdx: number, fallbackChannel = 0): number {
	if (pathIdx >= 0) {
		const c = surf.pathColors[pathIdx];
		if (c != null) return c;
		const d = surf.pathDefaultColors[pathIdx];
		if (d != null) return d;
	}
	const len = surf.pathDefaultColors.length || 1;
	return surf.pathDefaultColors[fallbackChannel % len] ?? LIT_THEMES.Dark![0]!;
}
/** 小球表面色（沿用旧签名，材质重建处直接调） */
function cfgBallColor(track: number, pathIdx = -1): number {
	return pathIdx >= 0 ? pathColorFor(pathIdx) : track;
}
/**
 * 逐路径数值：路径覆盖优先，没单独设过就吃全局默认。
 * 面板上选中多条路径且取值不一致时，滑轨旁的输入框显示「多值」。
 */
function effNum(key: PathNumKey, pathIdx: number): number {
	const v = pathIdx >= 0 ? surf.pathNums[key]?.[pathIdx] : undefined;
	return v ?? (surf as unknown as Record<PathNumKey, number>)[key];
}
/** 某条路径的小球半径（= 倍数 × 一个谱线间距，贴在谱面上不随谱面缩放漂） */
function ballRadiusOf(pathIdx: number): number {
	return clamp(effNum("ballSize", pathIdx) * staffSpace, 1e-4, 10);
}
/** 点亮亮度/光效：跟随小球开着就整套沿用小球的值（多路径同落一音时取最亮） */
function litBrightFor(i: number): number {
	const ps = targetPaths[i];
	if (ps && ps.length > 1) {
		return Math.max(...ps.map((pi) => (surf.litFollowBall ? effNum("brightBall", pi) : effNum("brightLit", pi))));
	}
	const pi = targetPath[i] ?? -1;
	return surf.litFollowBall ? effNum("brightBall", pi) : effNum("brightLit", pi);
}
function litGlowFor(i: number): number {
	const ps = targetPaths[i];
	if (ps && ps.length > 1) {
		return Math.max(...ps.map((pi) => (surf.litFollowBall ? effNum("glowBall", pi) : effNum("glowLit", pi))));
	}
	const pi = targetPath[i] ?? -1;
	return surf.litFollowBall ? effNum("glowBall", pi) : effNum("glowLit", pi);
}

/**
 * 统一「小球亮度」语义（自洽性修复核心）：面板上「小球亮度 brightBall」在两种材质
 * 下必须表现一致——
 * - PBR 预设（metal/glass/paper/……）：材质有 emissive → 写真实自发光（emissive +
 *   emissiveIntensity），它既是 bloom 的光源，也会被环境光/点光源叠加。
 * - flat 纯色预设：材质是 MeshBasicMaterial，本身没有 emissive → 用颜色明度缩放
 *   表达同等亮度（0.35→1.0 倍）。以前这里只写 emissive，flat 下拖滑杆毫无反应，
 *   这就是「自发光不自洽」。
 * 每次都先 setHex(color) 再缩放/赋值，保证幂等：反复调用不会把颜色越乘越暗。
 */
function applyBallBrightness(
	mat: THREE.Material,
	color: number,
	bright: number,
): void {
	const b = Math.min(1, Math.max(0, bright));
	const sm = mat as THREE.MeshStandardMaterial;
	if (sm.emissive) {
		sm.emissive.setHex(color);
		sm.emissiveIntensity = b;
		return;
	}
	const bm = mat as THREE.MeshBasicMaterial;
	if (bm.color) bm.color.setHex(color).multiplyScalar(0.35 + 0.65 * b);
}

/** 仅替换小球材质（不重建几何体/轨迹线）：预设/发光/调参改变时调用，旧材质 dispose */
function updateBallMaterials(): void {
	if (!ballTracks.length) return;
	const cfg = surf.mat.ball;
	for (const bt of ballTracks) {
		const ballColor = cfgBallColor(bt.color, bt.pathIdx); // 路径自定义色优先
		const bright = effNum("brightBall", bt.pathIdx); // 小球亮度逐路径一份
		const mat = makeBallMaterial(
			cfg.preset,
			ballColor,
			bright,
			overridesFor("ball"),
		);
		applyBallBrightness(mat, ballColor, bright);
		bt.glow = rebuildTrackGlow(bt, ballColor);
		bt.light.color.setHex(ballColor); // 路径色变了，小球灯跟着变
		const oldMats = new Set<THREE.Material>();
		for (const b of bt.pool) {
			oldMats.add(b.material as THREE.Material);
			b.material = mat;
		}
		// 副球（分裂分支球）与主球共用同一份材质，必须一起换：否则旧材质被
		// dispose 后副球仍持有它 → 渲染成黑球并「死在那里」。这是「更新小球
		// 设置残留旧球」的根因之一。
		if (bt.split) {
			oldMats.add(bt.split.splitBall.material as THREE.Material);
			bt.split.splitBall.material = mat;
		}
		for (const m of oldMats) disposeMaterialOnly(m);
	}
}

/** 按各路径生效半径重设球（含副球）缩放：几何体共享，尺寸一律靠 scale */
function syncBallScales(): void {
	for (const bt of ballTracks) {
		const k = ballRadiusOf(bt.pathIdx) / BALL_GEO_R;
		for (const ball of bt.pool) ball.scale.setScalar(k);
		if (bt.split) bt.split.splitBall.scale.setScalar(k);
	}
}

// ── 设置应用：把 surf 的变更打到材质/水面/轨迹线 ──
// v2：三对象组（乐谱/背景/小球）各自独立——只重建配置真正发生变化的组，
// 组内材质全部从该组的 ObjMatConfig 派生；重建后若该组是网络贴图模式，
// 自动从缓存恢复贴图（改滑杆/切预设不再把贴图冲掉）。
function matCfgEq(a: ObjMatConfig, b: ObjMatConfig): boolean {
	return (
		a.source === b.source &&
		a.preset === b.preset &&
		a.tex === b.tex &&
		a.color === b.color &&
		a.inkColor === b.inkColor &&
		a.texScale === b.texScale
	);
}
function matTuneEq(a: MatTune, b: MatTune): boolean {
	return a.rough === b.rough && a.metal === b.metal && a.trans === b.trans;
}
/** 面板派生值回填用的引用（面板建好前为 null：boot 期 applyBloomSurf 会先跑几轮） */
let panelHandle: SettingsPanelHandle | null = null;

/** 阈值自动：把高通门槛钉在「本帧发光缓冲峰值」下方。
 *  阈值一旦高于峰值，整层被滤成纯黑，strength/radius 全部空转（用户反馈
 *  「光晕半径拖动无效」的根因）。峰值现算，所以面板滑杆显示的就是生效值。
 *  单独成函数是因为峰值会在 applyBloomSurf 之外变化（buildAll 重建 mesh、
 *  refreshLitColors 改点亮色），只挂在设置回调上就永远是上一轮的数 —— 每帧
 *  循环里按 200ms 一拍补算（peakLuma 要遍历上千个材质，逐帧量不划算）。 */
function syncBloomThreshold(): void {
	if (!surf.bloomAutoThreshold) return;
	const peak = bloom.peakLuma();
	// 向下取整到 0.01：四舍五入在峰值很低时会把阈值抬到 ≥ 峰值（peak=0.02 → 0.02），
	// 于是「自动」自己把整层重新滤黑，自检就永远报同一个修不掉的问题。
	const t = peak <= 0 ? 1 : Math.min(1, Math.floor(clamp(peak * 0.75, 0, 1) * 100) / 100);
	if (t === surf.bloomThreshold) return;
	surf.bloomThreshold = t;
	bloom.setParams({ threshold: t });
	panelHandle?.syncDerived();
}

/** 把 bloom 参数、四源光效权重与天空亮度推进选择性发光管线（面板任何改动都走这里） */
function applyBloomSurf(): void {
	// 小球/点亮/底面的光效权重不再走这里：每帧由 glowMatsOf 逐材质给出（点亮还能
	// 跟随小球、两者都能按路径各一份）。只有天空是整幅共用的，留在这里。
	bloom.glow.sky = surf.glowSky;
	// 天空亮度：背景色按灰阶缩放（1=白底，0=黑底；sRGB 口径，和面板百分比对得上）
	const g = Math.min(1, Math.max(0, surf.brightSky));
	scene.background = skyColor.setRGB(g, g, g, THREE.SRGBColorSpace);
	// 半径钳到 [0,1]：旧存档里可能有 1.5（面板当时给到这个上限），而 three 的
	// bloomRadius 是 5 级模糊权重的插值系数，>1 会把最紧那级权重拖成负数
	surf.bloomRadius = clamp(surf.bloomRadius, 0, 1);
	bloom.setParams({
		strength: surf.bloomStrength,
		radius: surf.bloomRadius,
		threshold: surf.bloomThreshold,
	});
	// 天空/背景刚落到 scene 上，peakLuma 这才量得到天空那一源 → 立刻校正自动阈值
	syncBloomThreshold();
	// 上面把阈值/半径改成了「生效值」，面板那两行得跟着显示，否则数字与实际脱节
	panelHandle?.syncDerived();
}

function applySurf(patch: Partial<SurfSettings>): void {
	// 先记录快照，便于只重建真正发生变化的对象材质（滑杆高频 input 避免无谓重建）
	const prevDevice = surf.device;
	const prevMat: Record<"score" | "ground" | "ball", ObjMatConfig> = {
		score: { ...surf.mat.score },
		ground: { ...surf.mat.ground },
		ball: { ...surf.mat.ball },
	};
	const prevTune: Record<"score" | "ground" | "ball", MatTune> = {
		score: { ...surf.matTune.score },
		ground: { ...surf.matTune.ground },
		ball: { ...surf.matTune.ball },
	};
	Object.assign(surf, patch);
	syncTermHeights(); // 跟随项：面板里的高度滑轨始终显示生效值（staffSpace 未量到时自动跳过）

	// 三对象组：任一配置/调参变化 → 只更新该组（贴图在全量重建后自动恢复）
	for (const obj of ["score", "ground", "ball"] as const) {
		if (
			!matCfgEq(prevMat[obj], surf.mat[obj]) ||
			!matTuneEq(prevTune[obj], surf.matTune[obj])
		) {
			rebuildObjectMaterial(obj, prevMat[obj]);
		}
		// 贴图缩放（texScale）只影响 repeat：克隆纹理并重打
		if (
			prevMat[obj].texScale !== surf.mat[obj].texScale &&
			surf.mat[obj].source === "network" &&
			surf.mat[obj].tex
		) {
			const key = `${obj}|${surf.mat[obj].tex}`;
			// 光删 texObjCache 不够：texObjDone 里的旧克隆会被下一轮同名写入无声覆盖，
			// 而每张克隆各自占一份 GPU 贴图（clone 共享 image，但 uuid 与上传是各一份）。
			// 拖一格泄一套三张，几十格就是几百 MB 显存。
			const stale = texObjDone.get(key);
			if (stale) {
				for (const tx of [stale.diff, stale.nor, stale.rough]) tx.dispose();
				texObjDone.delete(key);
			}
			texObjCache.delete(key);
			applyTexAsync(obj, surf.mat[obj]);
		}
	}

	// 光照
	if (patch.lighting !== undefined) applyLighting();

	// ── 环境 · 通用 ──
	// 凸起高度（世界单位；面板显示 ×100，范围 0.1–3 → 0.001–0.03）→ 全量重建
	if (patch.rise !== undefined) {
		surf.rise = clamp(patch.rise, 0.001, 0.03);
		recalcBallBaseZ();
		if (allElems.length) {
			renderProg.show(t("p4.prog.geo"));
			// 让出一帧让弹窗绘制，再做同步的全量几何重建（大谱下可能阻塞数百毫秒）
			requestAnimationFrame(() => {
				buildAll(); // buildAll 内部也会重算球基准高
				renderProg.done(t("p4.prog.geoDone"));
			});
		}
	}
	// 渲染设备（gpu/cpu/auto）→ 重建渲染器（放最后集中处理，见函数尾部）
	// 光线追踪（实验：实时阴影）
	if (patch.rt !== undefined) applyRT();
	// 预设点亮主题 → 音轨颜色表
	if (patch.theme !== undefined) applyLitTheme(surf.theme);

	// ── 运动 · 小球 ──
	if (patch.ballSize !== undefined) {
		// 实时：只改球半径变量 + 缩放现有球，不重建几何体（避免卡顿/拖尾清空）
		ballRadius = clamp(patch.ballSize * staffSpace, 1e-4, 10);
		recalcBallBaseZ();
	}
	if (patch.ballSize !== undefined || patch.pathNums !== undefined)
		syncBallScales();
	// 球光晕特效（样式/范围）→ 重建球轨（随球重建光晕网格）
	if (
		patch.ballGlowStyle !== undefined ||
		patch.ballGlowRange !== undefined
	) {
		if (ballTracks.length) initBalls();
	}
	if (patch.flightMs !== undefined) onFlightChanged();
	// 起/终点线：距离改了要重画竖线（球轨重建），高度改了只重算弧（原地补顶点）
	if (patch.termLeadGap !== undefined || patch.termTailGap !== undefined) {
		onTermGapChanged();
	}
	if (
		patch.termLeadH !== undefined ||
		patch.termTailH !== undefined ||
		patch.termLeadHFollow !== undefined ||
		patch.termTailHFollow !== undefined
	) {
		refreshTrackArcs();
	}
	// 逐路径数值变了：材质（亮度）、球半径（scale 已在上面同步）、光晕尺寸（烘焙在
	// 网格里，必须重建）、点亮亮度/颜色全部按各自路径重算
	if (patch.pathNums !== undefined) {
		updateBallMaterials();
		refreshLitColors();
	}

	// ── 运动 · 拖尾 ──（meshline 丝带：宽度/透明度每帧读 surf，无须在此处理）
	if (patch.trailFollowBall !== undefined || patch.trailColor !== undefined)
		clearAllTrailHist();

	// ── 运动 · 点亮 / 路径颜色（pathColors 是唯一颜色来源）──
	if (
		patch.litEnabled !== undefined ||
		patch.litFollowBall !== undefined ||
		patch.litColor !== undefined
	) {
		refreshLitColors();
		refreshTieColors();
	}
	if (patch.pathColors !== undefined) {
		updateBallMaterials(); // 小球表面色
		refreshLitColors(); // 已点亮的符头
		refreshTieColors(); // 连音线点亮色跟随路径
		publishPathColors(); // 跟随下拉里的「路径N」
	}

	// 水面（背景组）
	const w = ensureWater();
	w.setVisible(surf.waterOn);
	w.setAmplitude(surf.waterAmp);
	w.setSpeed(surf.waterSpeed);
	w.setWaveLength(surf.waterWaveLen);
	w.setColor(surf.waterColor);

	// 三类辅助线（轨迹线 / 起点线 / 终点线）样式、透明度、颜色
	applyGuideStyles();

	// 轨迹形状 / 跳动高度改变 → 轨迹几何/球段需整体重建；
	// 仅小球材质（预设/发光/调参）改变 → 只换材质，不重建几何
	if (patch.trajShape !== undefined || patch.jumpHeight !== undefined) {
		// 只改曲线形状：原地重写每段轨迹线顶点（球位置下一帧自动跟上），
		// 不再 initBalls 全量重建球池/材质/分支状态
		refreshTrackArcs();
	}
	// 小球发光强度若未触发整材质重建，就地改 emissiveIntensity 兜底（逐路径）
	if (patch.brightBall !== undefined || patch.pathNums !== undefined) {
		for (const bt of ballTracks) {
			const e = effNum("brightBall", bt.pathIdx);
			for (const b of bt.pool) {
				const bm = b.material as THREE.MeshStandardMaterial;
				if (bm.emissive) bm.emissiveIntensity = e;
			}
		}
	}
	// 选择性 bloom：参数 + 四源光效权重 + 天空亮度一起同步
	applyBloomSurf();
	// 已点亮音符发光（litGlow 改变）
	if (
		patch.brightLit !== undefined ||
		patch.litFollowBall !== undefined ||
		patch.pathNums !== undefined
	) {
		for (let i = 0; i < litCount; i++) {
			const e = litBrightFor(i);
			for (const m of targetMeshes.get(i) ?? [])
				(m.material as THREE.MeshStandardMaterial).emissiveIntensity = e;
		}
		refreshTieColors(); // 连音线点亮亮度同步
	}
	// 乐谱本身（谱线/符干/符号 + 未点亮符头）自发光：白色自发光，0=不发光靠漫反射。
	// 未点亮符头是独立材质实例，必须一起同步，否则谱线亮了符头还是暗的（半截乐谱发光）。
	if (patch.scoreGlow !== undefined && inkMat) {
		const im = inkMat as THREE.MeshStandardMaterial;
		if (im.emissive) {
			im.emissive.setHex(0xffffff);
			im.emissiveIntensity = surf.scoreGlow;
		}
		for (const [i, list] of targetMeshes) {
			if (i < litCount) continue; // 已点亮：保持轨色发光，不吃乐谱自发光
			for (const m of list) {
				const mm = m.material as THREE.MeshStandardMaterial;
				mm.emissive.copy(im.emissive);
				mm.emissiveIntensity = surf.scoreGlow;
			}
		}
	}
	// 底面宽度 / 两侧边缘渐变
	if (patch.groundWidth !== undefined) rebuildGroundPlane();
	if (patch.groundFade !== undefined) refreshGroundFade();
	if (patch.viewFeather !== undefined) scheduleGroundFade();
	// 整个底面（背景板）自发光
	if (patch.brightGround !== undefined) {
		const gm = bgGroundMat as THREE.MeshStandardMaterial;
		if (gm.emissive) {
			gm.emissive.setHex(0xffffff);
			gm.emissiveIntensity = surf.brightGround;
		}
	}

	// 视野半径变化 → 元素裁剪 + 背景淡出重建
	if (patch.viewRadius !== undefined) {
		scheduleGroundFade();
	}
	applyViewCrop();

	// 渲染设备切换放在最后：会重建渲染器/谱面 mesh，避免与上面各项互相干扰
	if (patch.device !== undefined && surf.device !== prevDevice)
		rebuildRenderer();

	// 巡检设置本身变了：立刻重排定时器 + 刷新摘要（不等 1.5s 防抖）。
	// 其余任何设置改动 → 延后一拍扫一次：改参是残留问题最高发的时刻。
	if (patch.repair !== undefined) syncPatrolState();
	// 落盘收在这里，不留给各调用点自觉：修复页签的按钮、巡检开关都直接走
	// applySurf，靠面板回调里那句 saveSurf 的话，它们改的东西一刷新就没了。
	saveSurf();
	scheduleSettingPatrol();
}

/**
 * 就地更新单对象组的物理参数与颜色（滑杆/颜色高频路径）：
 * 不重建材质实例——网络贴图 map/normalMap/roughnessMap 原样保留，
 * 每次拖动只写几个标量，无 GPU 资源重建开销。
 */
function updateObjectMaterialParams(obj: "score" | "ground" | "ball"): void {
	const cfg = surf.mat[obj];
	const tune = surf.matTune[obj];
	const glass = isGlassPreset(cfg.preset);
	const patchOne = (m: THREE.MeshStandardMaterial): void => {
		m.roughness = tune.rough;
		m.metalness = tune.metal;
		if (glass) {
			m.opacity = tune.trans;
			m.transparent = true;
		}
		m.needsUpdate = true;
	};
	if (obj === "ground") {
		const m = bgGround.material as THREE.MeshStandardMaterial;
		patchOne(m);
		m.color.setHex(cfg.color ?? (m.map ? 0xffffff : baseColorOf(cfg.preset)));
		// 底板与地面同组：环境「地面」的颜色/粗糙度/金属度一起作用于底板
		const bm = backplate.material as THREE.MeshStandardMaterial;
		patchOne(bm);
		bm.color.setHex(cfg.color ?? (bm.map ? 0xffffff : baseColorOf(cfg.preset)));
		refreshTextPlanes(); // 文字块纸色跟随底板（地面）色
		return;
	}
	if (obj === "ball") {
		for (const bt of ballTracks) {
			const c = cfgBallColor(bt.color, bt.pathIdx);
			// 光晕颜色烘焙在材质里：仅颜色变化时才重建（避免滑杆高频重建）
			if (bt.glow.userData.color !== c) bt.glow = rebuildTrackGlow(bt, c);
			bt.light.color.setHex(c); // 小球灯也吃路径色：白灯会把谱面洗白
			for (const b of bt.pool) {
				const m = b.material as THREE.MeshStandardMaterial;
				patchOne(m);
				m.color.setHex(c);
				if (m.emissive) m.emissive.setHex(c);
				m.needsUpdate = true;
			}
		}
		return;
	}
	// score 组：整个挤出谱面（共享 inkMat + 符头 + 连音线 + 文字），不含底板（底板归环境地面）
	patchOne(inkMat);
	const inkBase =
		cfg.inkColor ?? (inkMat.map ? 0xffffff : inkColorOf(cfg.preset));
	inkMat.color.setHex(inkBase);
	for (const [i, list] of targetMeshes) {
		for (const m of list) {
			const mm = m.material as THREE.MeshStandardMaterial;
			patchOne(mm);
			// 未点亮符头跟墨色：按序号判定（i>=litCount），原来按 emissiveIntensity<=0
			// 在 scoreGlow>0 时未点亮符头自发光>0 → 墨色改了它却不跟
			if (i >= litCount) mm.color.setHex(inkBase);
		}
	}
	// 连音线 overlay 与乐谱同质感：粗糙度/金属度/玻璃透明度一起跟
	for (const tl of tieLights) patchOne(tl.mat);
	refreshTextPlanes(); // 文字块（CJK 回退）同步纸色/墨色 + PBR
}

/**
 * 重建单个对象组的全部材质（组内一起变、组间互不影响）：
 *   ground → 背景地面板
 *   score  → 乐谱底板 + 共享 inkMat（谱线/符干/符号）+ 点亮符头材质
 *   ball   → 全部小球材质
 * 只动了滑杆/颜色（预设/来源/贴图未变）→ 走就地更新（零重建）；
 * 结构变化（切预设/切来源/换贴图）→ 全量重建，网络贴图随后从缓存自动恢复。
 */
/** 带用户底色着色的覆盖（cfg.color 为 null 时不带 color 字段，回落预设默认色） */
function overridesWithColor(obj: "score" | "ground" | "ball"): MatOverrides {
	const ov = overridesFor(obj);
	const c = surf.mat[obj].color;
	if (c !== null) ov.color = c;
	return ov;
}
/** score 组墨色覆盖（inkColor 为 null 时回落预设墨色） */
function inkOverrides(): MatOverrides {
	const ov = overridesFor("score");
	const c = surf.mat.score.inkColor;
	if (c !== null) ov.color = c;
	return ov;
}

function rebuildObjectMaterial(
	obj: "score" | "ground" | "ball",
	prev?: ObjMatConfig,
): void {
	const cfg = surf.mat[obj];
	const structuralChange =
		!prev ||
		prev.source !== cfg.source ||
		prev.preset !== cfg.preset ||
		prev.tex !== cfg.tex;
	if (!structuralChange) {
		updateObjectMaterialParams(obj);
		return;
	}
	if (obj === "ground") {
		disposeMaterialOnly(bgGround.material);
		const m = makeBaseMaterial(cfg.preset, overridesWithColor("ground"));
		// 重建后补回视野淡出 alphaMap（它挂在旧材质上，已随 dispose 失效）
		if (groundFadeTex) {
			m.alphaMap = groundFadeTex;
			m.transparent = true;
		}
		bgGround.material = m;
		bgGroundMat = m; // 保持引用同步（groundGlow 就地生效靠它）
		m.emissive.setHex(0xffffff);
		m.emissiveIntensity = surf.brightGround;
		m.needsUpdate = true;
		// 底板与地面同预设/底色（不带地面淡出 alphaMap，底板是完整垫板）
		disposeMaterialOnly(backplate.material);
		const bm = makeBaseMaterial(cfg.preset, overridesWithColor("ground"));
		backplate.material = bm;
		bm.needsUpdate = true;
		refreshTextPlanes(); // 文字块纸色跟随底板（地面）色
		if (cfg.source === "network" && cfg.tex) applyTexAsync("ground", cfg);
		return;
	}
	if (obj === "ball") {
		updateBallMaterials();
		if (cfg.source === "network" && cfg.tex) applyTexAsync("ball", cfg);
		return;
	}
	// ── score 组：整个挤出谱面（共享 inkMat + 符头 + 连音线 + 文字），不含底板 ──
	// 玻璃切换检测看 inkMat（谱面材质），底板已归环境地面，不再参与乐谱预设重建
	const wasGlass =
		(inkMat as unknown as { isMeshPhysicalMaterial?: boolean })
			.isMeshPhysicalMaterial === true;
	const nowGlass = isGlassPreset(cfg.preset);
	if (nowGlass !== wasGlass) {
		// 线条材质需在 MeshStandard / MeshPhysical 之间切换：替换共享 inkMat 并重建谱面 mesh
		inkMat = makeInkMaterial(cfg.preset, inkOverrides());
		inkMat.emissive.setHex(0xffffff); // 新实例补回自发光（默认无光源靠它）
		inkMat.emissiveIntensity = surf.scoreGlow;
		if (allElems.length) {
			renderProg.show(t("p4.prog.mat"));
			requestAnimationFrame(() => {
				buildAll(); // buildAll 会 dispose 旧 mesh（含旧 inkMat）
				renderProg.done(t("p4.prog.matDone"));
			});
		}
	} else {
		// 同类材质：共享 inkMat（所有 mesh 共用此实例）就地更新参数，不新建临时材质
		const ink = makeInkMaterial(cfg.preset, inkOverrides());
		inkMat.color.copy(ink.color);
		inkMat.roughness = ink.roughness;
		inkMat.metalness = ink.metalness;
		inkMat.envMapIntensity = ink.envMapIntensity;
		if (
			inkMat instanceof THREE.MeshPhysicalMaterial &&
			ink instanceof THREE.MeshPhysicalMaterial
		) {
			inkMat.transparent = ink.transparent;
			inkMat.opacity = ink.opacity;
			inkMat.transmission = ink.transmission;
		}
		inkMat.needsUpdate = true;
		disposeMaterialOnly(ink);
	}
	// 已点亮音符是独立材质实例：按新预设/调参重建，保留当前点亮状态的颜色与发光
	rebuildLitMaterials();
	rebuildTieMaterials(); // 连音线 overlay 也按新预设重建（保留点亮色）
	refreshTextPlanes(); // 文字块同步新预设参数/纸色/墨色
	if (cfg.source === "network" && cfg.tex) applyTexAsync("score", cfg);
}

/** 连音线 overlay 材质按新预设重建（保留当前点亮色/亮度）；score 预设结构变化时调用。
 *  着色器随新材质下次渲染重新编译，点亮前沿 uniform 由 updateTieLights 每帧重写。 */
function rebuildTieMaterials(): void {
	for (const tl of tieLights) {
		const color = tl.mat.color.getHex();
		const glow = tl.mat.emissiveIntensity;
		const old = tl.mat;
		const nm = makeTieMaterial(color, glow);
		tl.overlay.material = nm;
		tl.mat = nm;
		disposeMaterialOnly(old);
	}
}

/** 异步加载（缓存）贴图集并应用到指定对象组；应用前二次确认配置未被切走 */
function applyTexAsync(
	obj: "score" | "ground" | "ball",
	cfg: ObjMatConfig,
): void {
	void getTexSet(obj, cfg.tex)
		.then((set) => {
			const cur = surf.mat[obj];
			if (cur.source !== "network" || cur.tex !== set.id) return;
			applyTextureSet(obj, set);
		})
		.catch((e) => {
			console.warn("[材质] 贴图加载失败", e);
		});
}

/** 重建符头材质（score 配置变化后）：遍历【全部】符头而非仅已点亮的前 litCount 个。
 *  原来只 loop i<litCount，暂停在开头（litCount=0）时改乐谱预设一个符头都不重建，
 *  谱线（inkMat）变了符头却不变——正是「乐谱设置只作用于部分乐谱」的根因。
 *  已点亮（i<litCount）保留当前点亮色与发光；未点亮跟随乐谱整体 inkMat。 */
function rebuildLitMaterials(): void {
	const cfg = surf.mat.score;
	const ov = overridesFor("score");
	for (const [i, list] of targetMeshes) {
		const isLit = i < litCount;
		for (const m of list) {
			const old = m.material as THREE.MeshStandardMaterial;
			const litColor = old.emissive.getHex();
			const nm = makeLitMaterial(
				cfg.preset,
				isLit ? litColor : 0x000000,
				isLit ? litBrightFor(i) : 0,
				ov,
			);
			if (!isLit) {
				// 未点亮符头跟随乐谱整体设置（材质/颜色/自发光），不再纯黑
				nm.color.copy(inkMat.color);
				nm.emissive.copy(inkMat.emissive);
				nm.emissiveIntensity = inkMat.emissiveIntensity;
			}
			m.material = nm;
			disposeMaterialOnly(old);
		}
	}
}

// ── Poly Haven 贴图集双层缓存 ──
// 底层 texBaseCache：同一资产 id 只下载一次（重复贴片包装、SRGB、分类元数据）。
// 上层 texObjCache：按「对象|id」克隆出独立 repeat 的贴图集（克隆共享 GPU 图像，
// 只多占极少显存）——贴图 1:1 覆盖不拉伸，缩放 = repeat 次数（surf.mat[obj].texScale）。
interface TexSet extends TexSetRef {
	cats: string[];
}
const texBaseCache = new Map<string, Promise<TexSet>>();
const texObjCache = new Map<string, Promise<TexSet>>();
/** 已解析完成的贴图集（统计 / 卸载用；失败的不进这里） */
const texBaseDone = new Map<string, TexSet>();
const texObjDone = new Map<string, TexSet>();
function loadTexBase(id: string): Promise<TexSet> {
	let p = texBaseCache.get(id);
	if (!p) {
		p = (async (): Promise<TexSet> => {
			const loader = new THREE.TextureLoader();
			loader.setCrossOrigin("anonymous");
			const load = (u: string): Promise<THREE.Texture> =>
				new Promise((resolve, reject) =>
					loader.load(u, resolve, undefined, reject),
				);
			// 优先用资源管理器里已下载的贴图 blob（全站共享）
			const stored = (await getStored(id)) as
				| { diff: Blob; nor: Blob; rough: Blob }
				| undefined;
			let diffUrl = phMapUrl(id, "diff");
			let norUrl = phMapUrl(id, "nor_gl");
			let roughUrl = phMapUrl(id, "rough");
			const objUrls: string[] = [];
			if (stored) {
				diffUrl = URL.createObjectURL(stored.diff);
				norUrl = URL.createObjectURL(stored.nor);
				roughUrl = URL.createObjectURL(stored.rough);
				objUrls.push(diffUrl, norUrl, roughUrl);
			}
			const [diff, nor, rough] = await Promise.all([
				load(diffUrl),
				load(norUrl),
				load(roughUrl),
			]);
			for (const u of objUrls) URL.revokeObjectURL(u);
			for (const t of [diff, nor, rough]) {
				t.wrapS = t.wrapT = THREE.RepeatWrapping;
				managedTextures.add(t);
			}
			diff.colorSpace = THREE.SRGBColorSpace;
			let cats: string[] = [];
			try {
				cats = (await fetchAssetInfo(id)).categories ?? [];
			} catch {
				cats = [];
			}
			return { id, diff, nor, rough, cats };
		})().then((set) => {
			texBaseDone.set(id, set);
			return set;
		});
		texBaseCache.set(id, p);
		p.catch(() => texBaseCache.delete(id));
	}
	return p;
}
function getTexSet(
	obj: "score" | "ground" | "ball",
	id: string,
): Promise<TexSet> {
	const key = `${obj}|${id}`;
	let p = texObjCache.get(key);
	if (!p) {
		p = loadTexBase(id).then((base) => {
			const scale = Math.max(0.05, surf.mat[obj].texScale || 4);
			const diff = base.diff.clone();
			const nor = base.nor.clone();
			const rough = base.rough.clone();
			diff.needsUpdate = nor.needsUpdate = rough.needsUpdate = true;
			diff.repeat.set(scale, scale);
			nor.repeat.copy(diff.repeat);
			rough.repeat.copy(diff.repeat);
			const set = { id: base.id, diff, nor, rough, cats: base.cats };
			texObjDone.set(key, set);
			return set;
		});
		texObjCache.set(key, p);
		p.catch(() => texObjCache.delete(key));
	}
	return p;
}

/** 贴图字节估算（RGBA + mipmap ≈ ×1.33） */
function texSetBytes(sets: Iterable<TexSet>): number {
	let bytes = 0;
	for (const set of sets) {
		for (const tx of [set.diff, set.nor, set.rough]) {
			const img = tx.image as { width?: number; height?: number } | null;
			if (img?.width && img?.height) bytes += img.width * img.height * 4 * 1.33;
		}
	}
	return bytes;
}

// 登记到「设置 → 缓存设置」：释放已上传显卡的网络贴图，并立即重贴当前场景
registerCache({
	id: "textures",
	labelKey: "cache.textures",
	descKey: "cache.textures.desc",
	stats: () => ({
		count: texBaseDone.size,
		bytes: texSetBytes(texBaseDone.values()) + texSetBytes(texObjDone.values()),
	}),
	clear: () => {
		const n = texBaseDone.size;
		for (const set of texObjDone.values()) {
			for (const tx of [set.diff, set.nor, set.rough]) tx.dispose();
		}
		texObjDone.clear();
		for (const set of texBaseDone.values()) {
			for (const tx of [set.diff, set.nor, set.rough]) {
				managedTextures.delete(tx);
				tx.dispose();
			}
		}
		texBaseDone.clear();
		texBaseCache.clear();
		texObjCache.clear();
		for (const obj of ["score", "ground", "ball"] as const) {
			const cfg = surf.mat[obj];
			if (cfg.source === "network" && cfg.tex) applyTexAsync(obj, cfg);
		}
		return n;
	},
});

// ── 资源管理器：网络贴图可手动下载，全站共用 ─────────────────────
// 分类注册已移至 ./texture-resource（shell 也会导入，保证非 3D 页能看到贴图）。
// 这里只注入 3D 专用的 inUse / deactivate（管理 GPU 贴图生命周期）。
function texInUse(id: string): boolean {
	return (["score", "ground", "ball"] as const).some(
		(o) => surf.mat[o].source === "network" && surf.mat[o].tex === id,
	);
}
setTextureHooks({
	inUse: texInUse,
	deactivate: (id) => {
		// 移除内存中的基础贴图集（若当前场景在用，会触发重新拉取）
		const set = texBaseDone.get(id);
		if (set) {
			for (const tx of [set.diff, set.nor, set.rough]) {
				managedTextures.delete(tx);
				tx.dispose();
			}
			texBaseDone.delete(id);
			texBaseCache.delete(id);
		}
		// 清理引用该 id 的对象克隆
		for (const [key, s] of texObjDone) {
			if (s.id === id) {
				for (const tx of [s.diff, s.nor, s.rough]) tx.dispose();
				texObjDone.delete(key);
				texObjCache.delete(key);
			}
		}
		if (texInUse(id)) {
			for (const obj of ["score", "ground", "ball"] as const) {
				const cfg = surf.mat[obj];
				if (cfg.source === "network" && cfg.tex === id) applyTexAsync(obj, cfg);
			}
		}
	},
});

// 拉取 Poly Haven 清单后回填到资源管理器（懒加载）
void ensureTextureCatalog();

/**
 * 把贴图集打到指定对象组内【全部】材质上（组概念：乐谱=底板+谱线/符号+符头；
 * 背景=地面板；小球=所有球）。贴图与颜色相乘（three 标准行为）：
 * 乐谱组未指定颜色时贴图原色显示，指定后做着色。
 * 只 dispose 材质、不 dispose 贴图（贴图由缓存统一管理、跨材质复用）。
 */
function applyTextureSet(obj: "score" | "ground" | "ball", set: TexSet): void {
	const cfg = surf.mat[obj];
	// 1:1 覆盖不拉伸：repeat = 平铺次数（texScale）；克隆集已按此设好，这里兜底刷新
	const scale = Math.max(0.05, cfg.texScale || 4);
	for (const t of [set.diff, set.nor, set.rough]) {
		t.wrapS = t.wrapT = THREE.RepeatWrapping;
		t.repeat.set(scale, scale);
		t.needsUpdate = true;
	}
	if (obj === "ground") {
		const m = bgGround.material as THREE.MeshStandardMaterial;
		stampTexSet(m, set);
		m.color.setHex(cfg.color ?? 0xffffff);
		if (groundFadeTex) {
			m.alphaMap = groundFadeTex;
			m.transparent = true;
		}
		m.needsUpdate = true;
		// 底板与地面同贴图（不带淡出 alphaMap）
		const bm = backplate.material as THREE.MeshStandardMaterial;
		stampTexSet(bm, set);
		bm.color.setHex(cfg.color ?? 0xffffff);
		bm.needsUpdate = true;
		return;
	}
	if (obj === "ball") {
		for (const bt of ballTracks) {
			for (const b of bt.pool) {
				const m = b.material as THREE.MeshStandardMaterial;
				stampTexSet(m, set);
				m.color.setHex(cfg.color ?? bt.color); // 贴图 × 轨道色（或底色覆盖）着色
				m.needsUpdate = true;
			}
		}
		return;
	}
	// score 组：整个挤出谱面（共享 inkMat + 全部符头），不含底板（底板归环境地面贴图）
	const texturedInk = cfg.inkColor ?? 0xffffff; // 贴图模式下墨色默认白色，让贴图原色可见
	inkMat.map = set.diff;
	inkMat.normalMap = set.nor;
	inkMat.roughnessMap = set.rough;
	inkMat.color.setHex(texturedInk);
	inkMat.needsUpdate = true;
	for (const [i, list] of targetMeshes) {
		for (const m of list) {
			const mm = m.material as THREE.MeshStandardMaterial;
			stampTexSet(mm, set);
			// 未点亮符头底色跟墨色（按序号判定）；点亮中保持轨色（emissive 已带色，map 相乘提亮质感）
			if (i >= litCount) mm.color.setHex(texturedInk);
			mm.needsUpdate = true;
		}
	}
}

/** 连续操作（按键 / 拖拽）后归一化到 -180..180，保证可以无限转 */
function normAngle(v: number): number {
	return ((((v + 180) % 360) + 360) % 360) - 180;
}
function readPanel(): void {
	if (camMode === "free") {
		// 自由相机：「应用」= 把 xyz + 三角度六个框写进相机，不碰时间轴那套球坐标
		freeTouched = true;
		applyFreePose();
		return;
	}
	camFollowing = false; // 手动输入相机参数 → 接管相机
	setFocusX(Number(focusInput.value) || 0);
	radius = clamp(Number(radiusInput.value) || 0, rMin, rMax);
	rotX = clampPitch(Number(rxInput.value) || 0);
	rotY = clampAngle(Number(ryInput.value) || 0);
	rotZ = clampAngle(Number(rzInput.value) || 0);
	applyCam();
}
function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
// 手动输入框：实时生效
for (const el of [focusInput, radiusInput, rxInput, ryInput, rzInput]) {
	el.addEventListener("input", readPanel);
}
// 滑轨：拖哪个改哪个，数字框由 syncPanel() 自动同步
const takeOver = (): void => {
	camFollowing = false; // 拖滑块 → 接管相机
};
// 统一自绘外观 + 拖动隐藏浮窗（这几条不走 bindSliderPair，单独装配）
for (const s of [radiusSlide, rxSlide, rySlide, rzSlide]) setupSlider(s);
radiusSlide.addEventListener("input", () => {
	takeOver();
	radius = clamp(Number(radiusSlide.value) || 0, rMin, rMax);
	applyCam();
});
rxSlide.addEventListener("input", () => {
	takeOver();
	rotX = clampPitch(Number(rxSlide.value) || 0);
	applyCam();
});
rySlide.addEventListener("input", () => {
	takeOver();
	rotY = Number(rySlide.value) || 0;
	applyCam();
});
rzSlide.addEventListener("input", () => {
	takeOver();
	rotZ = Number(rzSlide.value) || 0;
	applyCam();
});
document.getElementById("applyCam")!.addEventListener("click", readPanel);
/** 重置相机到预设（相机面板按钮 + 顶栏「工具 ▾」共用）。
 *  自由相机也走这里：清掉接管标记后由球坐标算出一个预设位姿，六个框随之回填。 */
function resetCam(): void {
	focusX = CAM_DEFAULT.focus;
	radius = clamp(CAM_DEFAULT.r, rMin, rMax);
	rotX = CAM_DEFAULT.rx;
	rotY = CAM_DEFAULT.ry;
	rotZ = CAM_DEFAULT.rz;
	freeTouched = false;
	applyCam();
}
document.getElementById("resetCam")!.addEventListener("click", resetCam);

// ←/→ 只改焦点 x（播放系统对接：进度 → focusX）
function moveTrack(delta: number): void {
	camFollowing = false; // 方向键移焦点 → 接管相机
	focusX = clamp(focusX - delta, 0, trackLength);
	applyCam();
	applyViewCrop(); // 视野裁剪跟随焦点，否则方向键移动后画面不更新
	water?.setCenterX(focusX); // 水面反射中心跟随焦点
	syncPanel();
}
window.addEventListener("keydown", (e) => {
	const el = e.target as HTMLElement | null;
	const tag = el?.tagName;
	// 输入框/下拉/文本域/contentEditable（曲名）聚焦时不抢键，否则编辑曲名按 a/w/s/d 会误转相机
	if (
		tag === "INPUT" ||
		tag === "SELECT" ||
		tag === "TEXTAREA" ||
		el?.isContentEditable ||
		// 自绘下拉是 <button>，不走 SELECT 分支：展开列表时左右方向键、列表外的字母键
		// 组件并不消费，会继续冒到 document 把相机一起带走
		isSelectUI(e.target)
	)
		return;
	// 带修饰键的一律交回浏览器/系统：Ctrl+A（全选）、Cmd+S（保存）、Alt+W 这些
	// 都会被下面的单键分支误当成「转视角」执行一遍
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	// 中文输入法合成期间（拼音还没上屏）按键不该动相机
	if (e.isComposing) return;
	if (e.key === "ArrowLeft") moveTrack(+TRACK_STEP);
	else if (e.key === "ArrowRight") moveTrack(-TRACK_STEP);
	else if (e.key === "a" || e.key === "A") {
		rotY = normAngle(rotY - 3);
		applyCam();
	} else if (e.key === "d" || e.key === "D") {
		rotY = normAngle(rotY + 3);
		applyCam();
	} else if (e.key === "w" || e.key === "W") {
		rotX = clampPitch(rotX + 3);
		applyCam();
	} else if (e.key === "s" || e.key === "S") {
		rotX = clampPitch(rotX - 3);
		applyCam();
	} else if (e.key === "q" || e.key === "Q") {
		rotZ = normAngle(rotZ - 3);
		applyCam();
	} else if (e.key === "e" || e.key === "E") {
		rotZ = normAngle(rotZ + 3);
		applyCam();
	}
});
// 滚轮调整 r（高度），clamp 到 r_min/r_max
container.addEventListener(
	"wheel",
	(e) => {
		e.preventDefault();
		camFollowing = false; // 滚轮缩放 → 接管相机
		if (camMode === "free") {
			// 自由相机：沿视线推近/拉远
			freeTouched = true;
			const fwd = new THREE.Vector3();
			camera.getWorldDirection(fwd);
			const step = radius * (e.deltaY > 0 ? 0.12 : -0.12);
			camera.position.addScaledVector(fwd, step);
			syncPanel();
			return;
		}
		radius = clamp(radius * (e.deltaY > 0 ? 1.08 : 1 / 1.08), rMin, rMax);
		applyCam();
	},
	{ passive: false },
);

// 按住拖拽 = 旋转视角（时间轴：绕锚点轨道；自由：绕相机自身任意角度）
// 双指 = 缩放：触屏没有滚轮，捏合是唯一的双指手势（下面 ptrs / pinch）
let dragging = false;
let dragButton = 0;
let lastPX = 0;
let lastPY = 0;
/** 当前按在画面上的指针（手指/鼠标）；两个即进入捏合缩放 */
const ptrs = new Map<number, { x: number; y: number }>();
let pinch: { d0: number; prevD: number; r0: number } | null = null;
const pinchDist = (): number => {
	const it = ptrs.values();
	const a = it.next().value;
	const b = it.next().value;
	return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};

container.addEventListener("pointerdown", (e) => {
	camFollowing = false;
	ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
	if (ptrs.size >= 2) {
		// 第二根手指落下：这一笔不再当旋转用，否则单指转视角会和捏合互相打架
		dragging = false;
		const d = pinchDist();
		pinch = { d0: d, prevD: d, r0: radius };
		return;
	}
	dragging = true;
	dragButton = e.button;
	lastPX = e.clientX;
	lastPY = e.clientY;
	container.classList.add("dragging");
	if (camMode === "free") freeTouched = true;
	try {
		container.setPointerCapture(e.pointerId);
	} catch {
		/* noop */
	}
});
window.addEventListener("pointermove", (e) => {
	if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
	if (pinch && ptrs.size >= 2) {
		const d = pinchDist();
		if (d < 2 || pinch.d0 < 2) return;
		if (camMode === "free") {
			// 自由相机：沿视线推近/拉远（增量式，跟滚轮同一套手感）
			freeTouched = true;
			const fwd = new THREE.Vector3();
			camera.getWorldDirection(fwd);
			camera.position.addScaledVector(fwd, radius * (1 - pinch.prevD / d));
			pinch.prevD = d;
			syncPanel(); // 位姿变了 → 自由相机的 xyz 框跟着回填
			return;
		}
		radius = clamp((pinch.r0 * pinch.d0) / d, rMin, rMax);
		applyCam();
		return;
	}
	if (!dragging) return;
	const dx = e.clientX - lastPX;
	const dy = e.clientY - lastPY;
	lastPX = e.clientX;
	lastPY = e.clientY;
	if (camMode === "free") {
		// 自由相机：左键=自由旋转；右键/中键=自由平移
		if (dragButton === 0) {
			const q = new THREE.Quaternion();
			// 绕世界 up 偏航
			q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.005);
			camera.quaternion.premultiply(q);
			// 绕相机右轴俯仰
			const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
			q.setFromAxisAngle(right, -dy * 0.005);
			camera.quaternion.premultiply(q);
		} else {
			// 平移：沿相机右/上方向
			const dist = 0.01 * radius;
			const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
			const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
			camera.position.addScaledVector(right, -dx * dist);
			camera.position.addScaledVector(up, dy * dist);
		}
		syncPanel(); // 拖完这一步就把位姿回填进六个框（下拉没开时内部直接返回）
		return;
	}
	if (dragButton !== 0) return;
	rotY = normAngle(rotY + dx * 0.25);
	rotX = clampPitch(rotX - dy * 0.25);
	applyCam();
});
/** 抬手/手势中断：剩下的一根手指继续当旋转拖拽，全部抬起才收摊 */
function endPointer(e: PointerEvent): void {
	ptrs.delete(e.pointerId);
	if (ptrs.size < 2) pinch = null;
	if (ptrs.size === 1) {
		const p = ptrs.values().next().value;
		if (p) {
			lastPX = p.x;
			lastPY = p.y;
			dragButton = 0;
			dragging = true;
		}
		return;
	}
	if (ptrs.size === 0) {
		dragging = false;
		container.classList.remove("dragging");
	}
}
window.addEventListener("pointerup", endPointer);
window.addEventListener("pointercancel", endPointer);

// 双击中键（自由相机模式下）→ 聚焦到当前小球位置
// 帮助文案里这条一直是承诺，但原来写成 container.addEventListener("dblclick", e =>
// e.button !== 1 → return)：dblclick 事件的 button 恒为 0，那个分支从没进去过。
// 中键单击走 auxclick。与「中键拖动=平移」共存的判据：两次轻点间隔 <350ms 且
// 位移 <8px 才算双击，平移收尾时那一下 auxclick 不会误触发。
let lastMidClick = { t: 0, x: 0, y: 0 };
container.addEventListener("auxclick", (e) => {
	if (e.button !== 1) return;
	e.preventDefault();
	const now = performance.now();
	const again =
		now - lastMidClick.t < 350 &&
		Math.hypot(e.clientX - lastMidClick.x, e.clientY - lastMidClick.y) < 8;
	lastMidClick = again ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
	if (!again) return;
	const dur = player?.duration ?? 0;
	if (dur > 0) setFocusX(focusXAtTime(visTime, dur), true);
});

// ── Verovio ───────────────────────────────────────────────────
let vtk: VrvToolkit | null = null;
async function initVerovio(): Promise<boolean> {
	try {
		const Module = await createVerovioModule();
		const t = new VrvToolkitClass(Module as never);
		vtk = t;
		t.setOptions({
			pageWidth: 1200,
			scale: 45,
			spacingLinear: 0.25, // 与第三页一致：回退自渲染时两页谱面完全相同
			spacingNonLinear: 0.6,
			breaks: "none",
			footer: "none",
			header: "none",
			font: "Bravura",
		});
		return true;
	} catch (err) {
		console.error("Verovio 初始化失败", err);
		return false;
	}
}

// ── 数据：SVG 解析 → 世界坐标（照搬 3dtest） ────────────────
type ElKind = "open" | "fill" | "text";
interface MappedEl {
	kind: ElKind;
	shapes: THREE.Shape[] | null; // fill 用（多子路径，SVG 坐标系）
	textPath?: boolean; // <text> 转来的 path：parseD 已按 winding 挂孔，makeFill 直接挤出（跳过 bbox 判孔）
	pts: { x: number; y: number }[] | null; // open 用（中心线点列，世界坐标）
	txt: string | null; // text 用
	w: number; // 世界尺寸
	h: number;
	worldX: number; // 世界坐标（元素中心）
	worldY: number;
	strokeW: number; // open 线宽（世界）
	sx: number; // SVG 屏幕坐标（调试/对照）
	sy: number;
	sw: number;
	sh: number;
	tag: string;
	el: Element;
	noteId: string | null; // 所属 <g class="note"> 的 id（演奏标记：notehead/artic 等共享同一 noteId）
	staffIdx: number; // 所属谱行的 getBBox().y 取整（聚类键：同一声部谱行 = 同一值，跨小节稳定）
	staffLine?: boolean; // 五线谱线（凸起 depth × 0.7）
	barLine?: boolean; // 小节线（凸起 depth × 0.85）
	anchor?: string | undefined; // <text> 的 text-anchor（start/middle/end，矢量文字 x 定位用）
}

let scoreH = 2.6; // 谱面世界高度
let allElems: MappedEl[] = [];
const renderProg = createRenderProgress();
const staffLineYCache = new WeakMap<Element, number>();
// 调试钩子（验证用）
(window as unknown as { __mideeDebug: unknown }).__mideeDebug = (limit = 200) => ({
	elems: allElems.map((e) => ({
		kind: e.kind,
		wx: Math.round(e.worldX * 100) / 100,
		wy: Math.round(e.worldY * 100) / 100,
		w: Math.round(e.w * 1000) / 1000,
		h: Math.round(e.h * 1000) / 1000,
		txt: e.kind === "text" ? (e.txt || "").slice(0, 8) : undefined,
		sw: Math.round(e.strokeW * 10000) / 10000,
		sk: (e.tag || "").slice(0, 12),
		np: e.pts?.length ?? 0,
		p0:
			e.pts && e.pts.length
				? `${Math.round(e.pts[0]!.x * 100) / 100},${Math.round(e.pts[0]!.y * 100) / 100}`
				: "",
		pL:
			e.pts && e.pts.length
				? `${Math.round(e.pts[e.pts.length - 1]!.x * 100) / 100},${Math.round(e.pts[e.pts.length - 1]!.y * 100) / 100}`
				: "",
	})),
	scoreH,
	trackLength,
	focusX,
	radius,
	rise: surf.rise,
	nElem: allElems.length,
	targets: playTargets.slice(0, limit).map((t, i) => ({
		i: i + 1,
		id: t.id,
		x: Math.round(t.x * 100) / 100,
		y: Math.round(t.y * 100) / 100,
		time: Math.round(t.time * 100) / 100,
		ch: t.channel,
		mk: t.mark,
	})),
	events: playEvents.length,
	ballSegs: ballTracks.map((bt) =>
		bt.segs.map((s) => ({
			kind: s.kind,
			ta: Math.round(s.ta * 100) / 100,
			tb: Math.round(s.tb * 100) / 100,
		})),
	),
	repeats: repeatInfo,
	// 材质调试：地面/底板/球是否已应用贴图（网络贴图验证用）
	groundMat: {
		hasMap: !!(bgGround.material as THREE.MeshStandardMaterial).map,
		metalness: (bgGround.material as THREE.MeshStandardMaterial).metalness,
		roughness: (bgGround.material as THREE.MeshStandardMaterial).roughness,
	},
	scoreMat: {
		hasMap: !!(backplate.material as THREE.MeshStandardMaterial).map,
	},
	// 时间线：每小节矫正锚点 + 画面秒换算（音画同步验证用）
	corrAnchors: corrAnchors.map((p) => ({
		a: Math.round(p.a * 1000) / 1000,
		c: Math.round(p.c * 10000) / 10000,
	})),
	avOffset,
	toVisTime,
	audioFloor,
});
(window as unknown as { __mideeScene: unknown }).__mideeScene = () => {
	// 诊断：遍历整个 scene，按 x 区间过滤（定位"X 方块"真身用）
	const out: {
		type: string;
		src: string;
		x: number;
		y: number;
		z: number;
		visible: boolean;
		gtype: string;
		parent: string;
	}[] = [];
	scene.traverse((o) => {
		const ox = o.position.x;
		if (ox > 0.5 && ox < 3.5) {
			out.push({
				type: o.type,
				src:
					o.name ||
					(o as unknown as { userData?: { src?: string; kind?: string } })
						.userData?.src ||
					(o as unknown as { userData?: { kind?: string } }).userData?.kind ||
					"",
				x: Math.round(o.position.x * 100) / 100,
				y: Math.round(o.position.y * 100) / 100,
				z: Math.round(o.position.z * 100) / 100,
				visible: o.visible,
				gtype:
					(o as unknown as { geometry?: { type?: string } }).geometry?.type ??
					"",
				parent: o.parent?.type ?? "",
			});
		}
	});
	return out.slice(0, 120);
};
(window as unknown as { __mideeMesh: unknown }).__mideeMesh = () => {
	const out: {
		x: number;
		y: number;
		w: number;
		h: number;
		d: number;
		v: number;
		src: string;
		gtype: string;
	}[] = [];
	stage.traverse((o) => {
		const m = o as THREE.Mesh;
		if (!(m as unknown as { isMesh?: boolean }).isMesh) return;
		m.geometry.computeBoundingBox();
		const bb = m.geometry.boundingBox;
		const s = bb ? bb.getSize(new THREE.Vector3()) : new THREE.Vector3();
		out.push({
			x: Math.round(m.position.x * 100) / 100,
			y: Math.round(m.position.y * 100) / 100,
			w: Math.round(s.x * 1000) / 1000,
			h: Math.round(s.y * 1000) / 1000,
			d: Math.round(s.z * 1000) / 1000,
			v: m.geometry.attributes.position?.count ?? 0,
			src: (m.userData.src as string) || "",
			gtype: m.geometry.type,
		});
	});
	return out;
};

// ── SVG transform 解析（matrix/translate/scale/rotate，按出现顺序连乘） ──
function parseTransformToMatrix(s: string | null): {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
} {
	let a = 1,
		b = 0,
		c = 0,
		d = 1,
		e = 0,
		f = 0;
	if (!s) return { a, b, c, d, e, f };
	const re = /(matrix|translate|scale|rotate)\(([^)]*)\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const vals = (m[2] ?? "")
			.split(/[,\s]+/)
			.map((v) => parseFloat(v))
			.filter((v) => !Number.isNaN(v));
		const a0 = a,
			b0 = b,
			c0 = c,
			d0 = d,
			e0 = e,
			f0 = f;
		switch (m[1]) {
			case "matrix": {
				const [ma = 1, mb = 0, mc = 0, md = 1, me = 0, mf = 0] = vals;
				a = a0 * ma + c0 * mb;
				b = b0 * ma + d0 * mb;
				c = a0 * mc + c0 * md;
				d = b0 * mc + d0 * md;
				e = a0 * me + c0 * mf + e0;
				f = b0 * me + d0 * mf + f0;
				break;
			}
			case "translate": {
				const tx = vals[0] ?? 0,
					ty = vals[1] ?? 0;
				e = a0 * tx + c0 * ty + e0;
				f = b0 * tx + d0 * ty + f0;
				break;
			}
			case "scale": {
				const sx = vals[0] ?? 1,
					sy = vals[1] ?? sx;
				a = a0 * sx;
				b = b0 * sx;
				c = c0 * sy;
				d = d0 * sy;
				break;
			}
			case "rotate": {
				const ang = ((vals[0] ?? 0) * Math.PI) / 180;
				const ca = Math.cos(ang),
					sa = Math.sin(ang);
				a = a0 * ca + c0 * sa;
				b = b0 * ca + d0 * sa;
				c = -a0 * sa + c0 * ca;
				d = -b0 * sa + d0 * ca;
				break;
			}
		}
	}
	return { a, b, c, d, e, f };
}

/** SVG path 的 d → { shapes, pts, closed }（照搬 3dtest）
 *  groupWinding=true：<text> 转来的 path（data-text-path），按 nonzero 绕向 + 点在多边形内
 *    直接在本函数挂好孔（修复中文相交笔画"田/日/中/目"误填，见下）。
 *  groupWinding=false（默认）：Verovio 原始 path（谱号/升降号/拍号等 SMuFL），每个闭合环
 *    独立成 Shape，孔洞交 makeFill 按 bbox 归属——保持原管线，避免文字补丁影响音乐符号。 */
function parseD(
	d: string,
	transform?: string | null,
	groupWinding = false,
): {
	shapes: THREE.Shape[] | null;
	pts: { x: number; y: number }[] | null;
	closed: boolean;
} {
	// 按 M 拆分子路径（Bravura 字形 path 是多段独立闭合轮廓，合并会破坏三角化）
	const segs: { pts: { x: number; y: number }[]; closed: boolean }[] = [];
	let cur: { pts: { x: number; y: number }[]; closed: boolean } | null = null;
	let cx = 0,
		cy = 0,
		sx = 0,
		sy = 0;
	const nums = d.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
	const cmds = d.replace(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/g, " ").trim();
	let ni = 0;
	const rd = (): number => {
		const v = Number(nums[ni]);
		ni++;
		return Number.isFinite(v) ? v : 0;
	};
	const pushT = (x: number, y: number): void => {
		if (!cur) return;
		const last = cur.pts[cur.pts.length - 1];
		if (!last || Math.abs(last.x - x) > 1e-3 || Math.abs(last.y - y) > 1e-3)
			cur.pts.push({ x, y });
	};
	const cubic = (
		c1x: number,
		c1y: number,
		c2x: number,
		c2y: number,
		ex: number,
		ey: number,
	): void => {
		const p0x = cx,
			p0y = cy;
		const len =
			Math.hypot(c1x - p0x, c1y - p0y) +
			Math.hypot(c2x - c1x, c2y - c1y) +
			Math.hypot(ex - c2x, ey - c2y);
		const n = Math.max(6, Math.ceil(len / 10));
		for (let i = 1; i <= n; i++) {
			const t = i / n,
				mt = 1 - t;
			pushT(
				mt * mt * mt * p0x +
					3 * mt * mt * t * c1x +
					3 * mt * t * t * c2x +
					t * t * t * ex,
				mt * mt * mt * p0y +
					3 * mt * mt * t * c1y +
					3 * mt * t * t * c2y +
					t * t * t * ey,
			);
		}
		cx = ex;
		cy = ey;
	};
	const quad = (c1x: number, c1y: number, ex: number, ey: number): void => {
		const p0x = cx,
			p0y = cy;
		const len =
			Math.hypot(c1x - p0x, c1y - p0y) + Math.hypot(ex - c1x, ey - c1y);
		const n = Math.max(6, Math.ceil(len / 10));
		for (let i = 1; i <= n; i++) {
			const t = i / n,
				mt = 1 - t;
			pushT(
				mt * mt * p0x + 2 * mt * t * c1x + t * t * ex,
				mt * mt * p0y + 2 * mt * t * c1y + t * t * ey,
			);
		}
		cx = ex;
		cy = ey;
	};
	for (const c of cmds) {
		const rel = c !== c.toUpperCase() && c !== "z" && c !== "Z";
		switch (c.toUpperCase()) {
			case "M":
				if (rel) {
					cx += rd();
					cy += rd();
				} else {
					cx = rd();
					cy = rd();
				}
				sx = cx;
				sy = cy;
				cur = { pts: [], closed: false };
				segs.push(cur);
				pushT(cx, cy);
				break;
			case "L":
				if (rel) {
					cx += rd();
					cy += rd();
				} else {
					cx = rd();
					cy = rd();
				}
				pushT(cx, cy);
				break;
			case "H":
				if (rel) {
					cx += rd();
				} else {
					cx = rd();
				}
				pushT(cx, cy);
				break;
			case "V":
				if (rel) {
					cy += rd();
				} else {
					cy = rd();
				}
				pushT(cx, cy);
				break;
			case "C": {
				let c1x, c1y, c2x, c2y, ex, ey;
				if (rel) {
					c1x = cx + rd();
					c1y = cy + rd();
					c2x = cx + rd();
					c2y = cy + rd();
					ex = cx + rd();
					ey = cy + rd();
				} else {
					c1x = rd();
					c1y = rd();
					c2x = rd();
					c2y = rd();
					ex = rd();
					ey = rd();
				}
				cubic(c1x, c1y, c2x, c2y, ex, ey);
				break;
			}
			case "S":
			case "Q": {
				let c1x, c1y, ex, ey;
				if (rel) {
					c1x = cx + rd();
					c1y = cy + rd();
					ex = cx + rd();
					ey = cy + rd();
				} else {
					c1x = rd();
					c1y = rd();
					ex = rd();
					ey = rd();
				}
				if (c.toUpperCase() === "S") {
					const c2x = c1x,
						c2y = c1y;
					cubic(cx, cy, c2x, c2y, ex, ey);
				} else {
					quad(c1x, c1y, ex, ey);
				}
				break;
			}
			case "T":
				if (rel) {
					cx += rd();
					cy += rd();
				} else {
					cx = rd();
					cy = rd();
				}
				pushT(cx, cy);
				break;
			case "A": {
				rd();
				rd();
				rd();
				rd();
				rd();
				if (rel) {
					cx += rd();
					cy += rd();
				} else {
					cx = rd();
					cy = rd();
				}
				pushT(cx, cy);
				break;
			}
			case "Z":
			case "z":
				if (cur) {
					cur.closed = true;
					pushT(sx, sy);
				}
				break;
		}
	}
	if (!segs.length) return { shapes: null, pts: null, closed: false };
	// 应用 path 自身 transform（如 scale(1,-1)）：让 shape/pts 与 getBBox（渲染几何）同坐标系
	const tf = parseTransformToMatrix(transform ?? null);
	const applyPts = (
		pts: { x: number; y: number }[],
	): { x: number; y: number }[] =>
		pts.map((p) => ({
			x: tf.a * p.x + tf.c * p.y + tf.e,
			y: tf.b * p.x + tf.d * p.y + tf.f,
		}));
	// 逐轮廓独立判定闭合。opentype 文字 path（toPathData）对 TrueType 字体不写 Z，
	// 靠首末点重合隐式闭合，且一个 <path> 常含多个轮廓（外轮廓/内孔/多个字符）。
	// 旧逻辑要求所有子路径都显式 Z 才判 fill，否则把所有轮廓拼成一条做闭合判定——
	// 多轮廓的首末点分属不同轮廓、相距很远，必然误判 open，文字被拉成只有侧壁、
	// 没有顶底的细管。这里每个 M 轮廓单独按面积判定——围出面积即闭合区域（无 Z
	// 也强制封口）；面积≈0 的往返细线才是开放线（ribbon）。
	//
	// 孔洞归类（关键，修复中文相交笔画"田/日/中/目"误填）：字体按 nonzero winding
	// 成字——正绕（面积同号于外框）的环各自是独立填充笔画，反绕环才是真正的孔。
	// 中文的中空（口/田外框）不是独立孔环，而是"接缝式凹多边形"单环（外框顶部留
	// 缝，另配横条笔画），田字横/竖笔画的 bbox 虽被外框 bbox 包住，但其中心落在
	// 外框凹口（非多边形内部），绝不能当孔。因此：
	//   1) 面积符号分外环 / 孔候选（外框方向由 transform 行列式决定，兼容 scale(1,-1)）；
	//   2) 孔候选只在"中心真实落在某外环多边形内（点在多边形内，非 bbox）"时挂为该外环的洞；
	//   3) 每个外环独立 Shape 挤出，相交/重叠的独立笔画几何重叠 → 视觉并集（nonzero 效果）。
	const contourArea2 = (pts: { x: number; y: number }[]): number => {
		let a = 0;
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i]!;
			const q = pts[(i + 1) % pts.length]!;
			a += p.x * q.y - q.x * p.y;
		}
		return a;
	};
	/** 点是否在多边形内（射线法，含凹多边形；pts 首尾可重合） */
	const pointInRing = (
		px: number,
		py: number,
		pts: { x: number; y: number }[],
	): boolean => {
		let inside = false;
		for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
			const xi = pts[i]!.x,
				yi = pts[i]!.y,
				xj = pts[j]!.x,
				yj = pts[j]!.y;
			if (
				yi > py !== yj > py &&
				px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
			)
				inside = !inside;
		}
		return inside;
	};
	interface Ring {
		pts: { x: number; y: number }[];
		area: number; // 带符号面积（鞋带公式，未除 2）
		cx: number;
		cy: number;
	}
	const closedRings: Ring[] = [];
	const openPts: { x: number; y: number }[] = [];
	for (const s of segs) {
		if (s.pts.length < 2) continue;
		const raw = s.pts;
		const first = raw[0]!;
		const last = raw[raw.length - 1]!;
		// 显式 Z 已在 Z 分支补过首点；未显式闭合则把首点追加到末尾强制封口
		const closedPts =
			Math.hypot(first.x - last.x, first.y - last.y) > 1e-6
				? [...raw, { x: first.x, y: first.y }]
				: raw;
		if (closedPts.length >= 3) {
			const ap = applyPts(closedPts);
			const a2 = contourArea2(ap);
			const area = Math.abs(a2) / 2;
			let minX = Infinity,
				maxX = -Infinity,
				minY = Infinity,
				maxY = -Infinity,
				cx = 0,
				cy = 0;
			for (const p of ap) {
				minX = Math.min(minX, p.x);
				maxX = Math.max(maxX, p.x);
				minY = Math.min(minY, p.y);
				maxY = Math.max(maxY, p.y);
				cx += p.x;
				cy += p.y;
			}
			const span = Math.hypot(maxX - minX, maxY - minY) || 1e-9;
			if (area > span * span * 0.005) {
				closedRings.push({ pts: ap, area: a2, cx: cx / ap.length, cy: cy / ap.length });
				continue;
			}
		}
		// 开放线：用未封口的原始点（避免首尾多出一条闭合边）
		openPts.push(...raw);
	}
	// 只要有闭合区域就按 fill 渲染（文字/符号场景，混入的零散开放线无意义）；
	// 否则全是开放线，保持原行为拼成一条点列交 ribbon（makeRibbon 会按折返断开）。
	if (closedRings.length) {
		const buildShape = (pts: { x: number; y: number }[]): THREE.Shape => {
			const sh = new THREE.Shape();
			sh.moveTo(pts[0]!.x, pts[0]!.y);
			for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i]!.x, pts[i]!.y);
			sh.closePath();
			return sh;
		};
		// Verovio 原始 path（谱号/升降号/拍号等 SMuFL）：每环独立 Shape，孔洞交 makeFill
		// 按 bbox 归属——保持原管线，不套用文字的 winding 补丁。
		if (!groupWinding) {
			return {
				shapes: closedRings.map((r) => buildShape(r.pts)),
				pts: null,
				closed: true,
			};
		}
		// path 自身 transform（如 SMuFL 的 scale(1,-1)）会翻转绕向：负行列式时外框符号取反
		const flipped = tf.a * tf.d - tf.b * tf.c < 0;
		const outerSign = flipped ? -1 : 1;
		const outerRings = closedRings.filter((r) => r.area * outerSign > 0);
		const holeRings = closedRings.filter((r) => r.area * outerSign < 0);
		const closedShapes = outerRings.map((o) => buildShape(o.pts));
		// 每个孔挂到"中心落在其内部、且面积最小（最内层）"的外环；反转点序使孔绕向与外框一致
		for (const h of holeRings) {
			let bestIdx = -1;
			let bestArea = Infinity;
			for (let oi = 0; oi < outerRings.length; oi++) {
				const o = outerRings[oi]!;
				if (
					pointInRing(h.cx, h.cy, o.pts) &&
					Math.abs(o.area) < bestArea
				) {
					bestArea = Math.abs(o.area);
					bestIdx = oi;
				}
			}
			if (bestIdx >= 0) {
				const rev = [...h.pts].reverse();
				const path = new THREE.Path();
				path.moveTo(rev[0]!.x, rev[0]!.y);
				for (let i = 1; i < rev.length; i++) path.lineTo(rev[i]!.x, rev[i]!.y);
				path.closePath();
				closedShapes[bestIdx]!.holes.push(path);
			} else {
				// 兜底：找不到所属外环（极少，退化/接缝），按独立外环挤出避免消失
				closedShapes.push(buildShape([...h.pts].reverse()));
			}
		}
		return { shapes: closedShapes, pts: null, closed: true };
	}
	return {
		shapes: null,
		pts: openPts.length >= 2 ? applyPts(openPts) : null,
		closed: false,
	};
}

/** 元素屏幕左上角 + 尺寸（getBoundingClientRect 含祖先 transform 与 CSS 缩放；返回左上角，parseScore 自行取中心） */
function screenRect(el: Element): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	const r = (el as SVGGraphicsElement).getBoundingClientRect();
	return { x: r.left, y: r.top, w: r.width, h: r.height };
}

// ── SVG 解析（照搬 3dtest parseScore + 谱面 y 居中） ──────────
// 入口预处理：<text> → <path>（用户方案，一步到位）：文字在进入解析管线前就
// 转成字体轮廓 path，之后与拍号/三连音数字等 SMuFL 字形走**完全同一条 fill
// 管线**（bbox→世界映射 + fillFlip + 裁剪 + 凸起 + 材质），不再有任何 text
// 特殊映射。轮廓由 opentype.js 从 Liberation.ttf 生成（toPathData 直接输出
// SVG path d，y-down 与 SVG 同向）。规则：
//   · 按叶子 tspan 取文本与字号（font-family=Bravura 的 SMuFL 部分跳过——
//     和弦延续线等私有区字符系统字体画不出，是"X 豆腐框"的根因）
//   · 剔除换行与缺字形字符（glyph.index===0，含 CJK——无字形的 text 保留，
//     由 makeTextPlane 贴图字块回退）
//   · x 按 text-anchor（start/middle/end）+ 基线 y 定位，与 2D 渲染同语义
function svgTextsToPaths(host: HTMLElement): void {
	if (!textFont) return;
	const SVG_NS = "http://www.w3.org/2000/svg";
	/**
	 * 一段文本（叶子 tspan）→ path d。按字符选字体（SMuFL→Leland、拉丁→Liberation、
	 * 中文→Noto 7000 子集），同字体连续段合串（保留 kerning），跨字体段按 advance 推进。
	 * 返回 { d, x1, x2 }（字形墨迹水平范围，供 text-anchor 定位）。
	 */
	const runToPath = (
		txt: string,
		fs2: number,
		bx: number,
		by: number,
	): string | null => {
		// 字符 → 字体 分段
		const segs: { font: NonNullable<typeof textFont>; chars: string[] }[] = [];
		for (const ch of txt) {
			if (/\s/.test(ch) && !/[\uE000-\uF8FF]/.test(ch)) {
				// 空白：advance 推进（挂到当前段外单独处理）
				const tail = segs[segs.length - 1];
				if (tail) tail.chars.push(ch);
				else segs.push({ font: textFont!, chars: [ch] });
				continue;
			}
			const font = fontForChar(ch);
			if (!font) continue; // 三套字体都缺字形 → 跳过该字符
			const last = segs[segs.length - 1];
			if (last && last.font === font) last.chars.push(ch);
			else segs.push({ font, chars: [ch] });
		}
		let x = bx;
		let any = false;
		let dAll = "";
		for (const seg of segs) {
			const str = seg.chars.join("");
			// 段内 path（起点 x、基线 by；opentype y-down 与 SVG 同向）
			try {
				const p = seg.font.getPath(str, x, by, fs2);
				if (p.commands.length) {
					dAll += (dAll ? " " : "") + p.toPathData(2);
					any = true;
				}
				x += seg.font.getAdvanceWidth(str, fs2);
			} catch {
				/* 段失败跳过 */
			}
		}
		return any ? dAll : null;
	};
	const inkWidth = (
		txt: string,
		fs2: number,
	): number => {
		let w = 0;
		let cur = "";
		let curFont: NonNullable<typeof textFont> | null = null;
		const flush = (): void => {
			if (cur && curFont) w += curFont.getAdvanceWidth(cur, fs2);
			cur = "";
		};
		for (const ch of txt) {
			const font = /[\uE000-\uF8FF]/.test(ch) ? musicFont : fontForChar(ch);
			if (font && font === curFont) cur += ch;
			else {
				flush();
				curFont = font;
				cur = ch;
			}
		}
		flush();
		return w;
	};
	for (const t of [...host.querySelectorAll("text")]) {
		const x = parseFloat(t.getAttribute("x") ?? "0") || 0;
		const y = parseFloat(t.getAttribute("y") ?? "0") || 0;
		const anchor = t.getAttribute("text-anchor") ?? "start";
		let replacedAny = false;
		for (const leaf of t.querySelectorAll("tspan")) {
			if (leaf.querySelector("tspan")) continue; // 只取叶子
			const isBravura = (leaf.getAttribute("font-family") ?? "").includes("Bravura");
			const fs = parseFloat(leaf.getAttribute("font-size") ?? "0");
			if (!(fs > 0)) continue;
			// Bravura tspan = SMuFL 音乐字形（和弦延续线等）：Leland 轮廓渲染（不再跳过）
			// 常规 tspan = 文本：剔换行制表，逐字符选字体（Leland/Noto 兜底后仍缺的跳过）
			const raw = [...(leaf.textContent ?? "")]
				.filter((ch) => !(ch === "\n" || ch === "\r" || ch === "\t"))
				.join("");
			const usable = [...raw].filter((ch) => /[\uE000-\uF8FF]/.test(ch) ? !!musicFont : !!fontForChar(ch)).join("");
			if (!usable.trim() && !/[\uE000-\uF8FF]/.test(usable)) continue;
			const w = inkWidth(usable, fs);
			let x0 = x; // start：直接从锚点排
			if (anchor === "middle") x0 = x - w / 2;
			else if (anchor === "end") x0 = x - w;
			const d = runToPath(usable, fs, x0, y);
			if (!d) continue;
			const pathEl = document.createElementNS(SVG_NS, "path");
			pathEl.setAttribute("d", d);
			pathEl.setAttribute("data-text-path", "1"); // 标记：文字轮廓，3D 走 winding 判孔补丁
			t.before(pathEl);
			replacedAny = true;
		}
		if (replacedAny) t.remove(); // 原文本元素移除（已全部转成 path）
	}
}

function parseScore(svgStr: string): {
	elems: MappedEl[];
	natW: number;
	natH: number;
} {
	const host = document.createElement("div");
	host.innerHTML = svgStr;
	// 不重编号 g.note id：导入流水线已为每个音符注入稳定 id（msN…，score-preprocess.ts），
	// Verovio 原样透传 → 与第 3 页连线存储的 id 完全一致，跨页直接映射，无需翻译。
	document.body.appendChild(host); // 挂载后 getBBox/getComputedStyle 才有布局
	try {
		svgTextsToPaths(host); // <text> → <path>：文字从此走 fill 管线（与拍号/三连音数字同一条）
		const svg = host.querySelector("svg") as unknown as SVGSVGElement;

		// defs 字形
		const defShapes = new Map<
			string,
			{ shapes: THREE.Shape[]; w: number; h: number }
		>();
		// Verovio 对字体缺字符（如 CJK）渲染的占位：一个"带 X 的方框" symbol
		// （def 轮廓仅两条对角线）——记录其 id，use 分支跳过（文字本体由 text 管线渲染）
		const placeholderIds = new Set<string>();
		for (const g of host.querySelectorAll("defs g[id]")) {
			const p = g.querySelector("path");
			const d = p?.getAttribute("d");
			if (!d) continue;
			const pd = parseD(d, p?.getAttribute("transform"));
			if (pd.shapes) {
				const b = (p as SVGGraphicsElement).getBBox();
				defShapes.set(g.id, { shapes: pd.shapes, w: b.width, h: b.height });
				// X 占位特征：恰好两条直线段（M+L ×2，无曲线），且接近正方形
				const cmds = (d.match(/[MLCQZ]/gi) || []).length;
				const ms = (d.match(/M/gi) || []).length;
				if (ms === 2 && cmds === 4 && b.width > 0 && Math.abs(b.width - b.height) < b.width * 0.3) {
					placeholderIds.add(g.id);
				}
			}
		}

		interface RawEl {
			kind: ElKind;
			shapes: THREE.Shape[] | null;
			pts: { x: number; y: number }[] | null;
			txt: string | null;
			el: Element;
			textPath?: boolean;
			oW: number;
			oH: number;
			oCX: number;
			oCY: number;
			strokeW: number;
			flipY: boolean;
			anchor?: string | undefined;
		}
		const raws: RawEl[] = [];
		const push = (r: {
			kind: ElKind;
			shapes: THREE.Shape[] | null;
			pts: { x: number; y: number }[] | null;
			txt: string | null;
			el: Element;
			textPath?: boolean;
			oW?: number;
			oH?: number;
			oCX?: number;
			oCY?: number;
			strokeW: number;
			flipY?: boolean;
			anchor?: string | undefined;
		}): void => {
			const rc = screenRect(r.el);
			const oW = (r.oW ?? 0) > 0 ? (r.oW ?? 0) : 1;
			const oH = (r.oH ?? 0) > 0 ? (r.oH ?? 0) : 1;
			raws.push({
				kind: r.kind,
				shapes: r.shapes,
				pts: r.pts,
				txt: r.txt,
				el: r.el,
				textPath: r.textPath === true,
				oW,
				oH,
				oCX: r.oCX ?? 0,
				oCY: r.oCY ?? 0,
				strokeW: r.strokeW,
				flipY: r.flipY !== false,
				anchor: r.anchor,
			});
		};

		for (const p of host.querySelectorAll("path")) {
			if (p.closest("defs")) continue;
			const d = p.getAttribute("d");
			if (!d) continue;
			const b = (p as SVGGraphicsElement).getBBox();
			// data-text-path：<text> 转来的文字轮廓走 winding 判孔补丁；无此标记的 Verovio
			// 原始 path（谱号/升降号等 SMuFL）走原 bbox 管线。
			const isTextPath = p.getAttribute("data-text-path") === "1";
			const pd = parseD(d, p.getAttribute("transform"), isTextPath);
			const swC = parseFloat(getComputedStyle(p).strokeWidth) || 0;
			const strokeAttr =
				swC > 0
					? swC
					: parseFloat(p.getAttribute("stroke-width") ?? "0") || 0.3;
			push({
				kind: pd.closed ? "fill" : "open",
				shapes: pd.closed ? pd.shapes : null,
				pts: pd.closed ? null : pd.pts,
				txt: null,
				el: p,
				textPath: isTextPath,
				oW: b.width,
				oH: b.height,
				oCX: b.x + b.width / 2,
				oCY: b.y + b.height / 2,
				strokeW: strokeAttr,
			});
		}
		for (const u of host.querySelectorAll("use")) {
			const href = u.getAttribute("href") ?? u.getAttribute("xlink:href") ?? "";
			const sh = defShapes.get(href.replace(/^#/, ""));
			if (!sh) continue;
			if (placeholderIds.has(href.replace(/^#/, ""))) continue; // 缺字符 X 占位框：跳过（文字本体走 text 管线）
			push({
				kind: "fill",
				shapes: sh.shapes.map((s) => s.clone()),
				pts: null,
				txt: null,
				el: u,
				oW: sh.w,
				oH: sh.h,
				oCX: 0,
				oCY: 0,
				strokeW: 0,
				flipY: false,
			});
		}
		for (const t of host.querySelectorAll("text")) {
			// 按叶子 tspan 逐个解析：Verovio 的 <text> 常含多层 tspan（外层仅定位、
			// 叶子带真实字号），有的一个 <text> 里拼了多个不同位置的文本——
			// 用整段 <text> 的 rect/内容会得到跨小节的大框 + 拼接串（渲染成
			// 巨型长条）。叶子 tspan 各有精确 rect，逐个入列。
			const leaves = [...t.querySelectorAll("tspan")].filter(
				(ts) =>
					(ts.textContent?.trim() ?? "") !== "" &&
					!ts.querySelector("tspan"),
			);
			const nodes: Element[] = leaves.length ? leaves : [t];
			for (const node of nodes) {
				// 剔除 SMuFL 私有区字符（U+E000–F8FF）：Verovio 会把和弦的 Bravura
				// 音乐字形部分（延续线等）放进独立 tspan——canvas fillText 用系统
				// 字体画不出这些字符，会渲染成"X 豆腐框"；只保留常规文本部分
				//（其余字符由 use/fill 管线按矢量字形处理）。
				const txt = (node.textContent ?? "")
					.replace(/[\uE000-\uF8FF]/g, "")
					.trim();
				if (!txt) continue;
				push({
					kind: "text",
					shapes: null,
					pts: null,
					txt,
					el: node,
					oW: 1,
					oH: 1,
					oCX: 0,
					oCY: 0,
					strokeW: 0,
					anchor:
						t.getAttribute("text-anchor") ?? undefined, // 矢量文字 x 定位（start/middle/end）
				});
			}
		}
		for (const e of host.querySelectorAll("ellipse")) {
			const rx = parseFloat(e.getAttribute("rx") ?? "0") || 1;
			const ry = parseFloat(e.getAttribute("ry") ?? "0") || rx;
			const b = (e as SVGGraphicsElement).getBBox();
			push({
				kind: "fill",
				shapes: [makeCircleShape(rx, ry)],
				pts: null,
				txt: null,
				el: e,
				oW: b.width,
				oH: b.height,
				oCX: b.x + b.width / 2,
				oCY: b.y + b.height / 2,
				strokeW: 0,
			});
		}
		for (const r of host.querySelectorAll("rect")) {
			const wA = parseFloat(r.getAttribute("width") ?? "0") || 0;
			const hA = parseFloat(r.getAttribute("height") ?? "0") || 0;
			if (!wA && !hA) continue;
			const b = (r as SVGGraphicsElement).getBBox();
			const swC = parseFloat(getComputedStyle(r).strokeWidth) || 0;
			const vertical = hA > wA;
			push({
				kind: "open",
				shapes: null,
				pts: vertical
					? [
							{ x: b.x + b.width / 2, y: b.y },
							{ x: b.x + b.width / 2, y: b.y + b.height },
						]
					: [
							{ x: b.x, y: b.y + b.height / 2 },
							{ x: b.x + b.width, y: b.y + b.height / 2 },
						],
				txt: null,
				el: r,
				oW: b.width,
				oH: b.height,
				oCX: b.x + b.width / 2,
				oCY: b.y + b.height / 2,
				strokeW: swC > 0 ? swC : Math.min(wA, hA),
			});
		}
		// <line>：Verovio 小节线/谱线常用 <line x1 y1 x2 y2> 画，之前漏遍历导致部分小节线消失
		for (const l of host.querySelectorAll("line")) {
			if (l.closest("defs")) continue;
			const swC = parseFloat(getComputedStyle(l).strokeWidth) || 0;
			const b = (l as SVGGraphicsElement).getBBox();
			const vertical = b.height > b.width;
			push({
				kind: "open",
				shapes: null,
				pts: vertical
					? [
							{ x: b.x + b.width / 2, y: b.y },
							{ x: b.x + b.width / 2, y: b.y + b.height },
						]
					: [
							{ x: b.x, y: b.y + b.height / 2 },
							{ x: b.x + b.width, y: b.y + b.height / 2 },
						],
				txt: null,
				el: l,
				oW: b.width,
				oH: b.height,
				oCX: b.x + b.width / 2,
				oCY: b.y + b.height / 2,
				strokeW: swC > 0 ? swC : 0.3,
			});
		}
		// <polyline>：Verovio 三连音括号（tupletBracket）用 polyline 画，之前漏遍历
		// 导致三连音细线在 3D 缺失。points="x1,y1 x2,y2 ..." → 折线 pts（open 丝带）。
		for (const pl of host.querySelectorAll("polyline")) {
			if (pl.closest("defs")) continue;
			const rawPts = (pl.getAttribute("points") ?? "")
				.trim()
				.split(/[\s,]+/)
				.map((v) => parseFloat(v))
				.filter((v) => Number.isFinite(v));
			if (rawPts.length < 4) continue;
			const pts: { x: number; y: number }[] = [];
			for (let pi = 0; pi + 1 < rawPts.length; pi += 2)
				pts.push({ x: rawPts[pi]!, y: rawPts[pi + 1]! });
			const swC = parseFloat(getComputedStyle(pl).strokeWidth) || 0;
			const b = (pl as SVGGraphicsElement).getBBox();
			push({
				kind: "open",
				shapes: null,
				pts,
				txt: null,
				el: pl,
				oW: b.width,
				oH: b.height,
				oCX: b.x + b.width / 2,
				oCY: b.y + b.height / 2,
				strokeW: swC > 0 ? swC : 0.3,
			});
		}
		// 注意：不能在此 remove host——下方归一化/映射还要用 getBoundingClientRect（脱离 DOM 返回 0）→ 在 finally 统一移除

		if (!raws.length) return { elems: [], natW: 0, natH: 0 };
		// 归一化：内容屏幕范围 → 世界尺寸
		const xs = raws.map((r) => screenRect(r.el).x);
		const ys = raws.map((r) => screenRect(r.el).y);
		const xMin = Math.min(...xs);
		const yMin = Math.min(...ys);
		const xMax = Math.max(
			...xs.map(
				(_, i) => screenRect(raws[i]!.el).x + screenRect(raws[i]!.el).w,
			),
		);
		const yMax = Math.max(
			...ys.map(
				(_, i) => screenRect(raws[i]!.el).y + screenRect(raws[i]!.el).h,
			),
		);
		const spanX = Math.max(1e-6, xMax - xMin);
		const spanY = Math.max(1e-6, yMax - yMin);
		// 世界尺寸基准 = 内容范围（Verovio 的 width/height 只是页面尺寸，元素坐标带偏移且溢出）
		const natW = spanX;
		const natH = spanY;
		// 谱面 y 居中：内容顶部为 0 → 平移使中线（内容中心）与 x 轴重合（用户坐标轴规则）
		const yOff = natH / 2 / PX_PER_UNIT;

		// 锚点换算映射：世界 Y = (内容中线 − 屏幕Y)/PX_PER_UNIT，屏幕Y 与 SVG 用户Y 成比例。
		// 内容顶（SVG bb.y）→ 世界 +scoreH/2，内容底 → −scoreH/2，据此拟合 a/b。
		try {
			const bb = svg.getBBox();
			const scoreHLocal = natH / PX_PER_UNIT;
			if (bb.height > 1e-6) {
				const a = -scoreHLocal / bb.height;
				anchorYMap = { a, b: scoreHLocal / 2 - a * bb.y };
			} else {
				anchorYMap = null;
			}
		} catch {
			anchorYMap = null;
		}

		const elems: MappedEl[] = raws.map((r) => {
			const rc = screenRect(r.el);
			const scaleX = r.oW > 0 ? rc.w / r.oW : 1;
			const scaleY =
				r.oH > 0 ? (r.flipY ? -rc.h / r.oH : rc.h / r.oH) : r.flipY ? -1 : 1;
			// 线元素（bbox 某一维为 0）的缩放：取非零维度比例（竖线宽 0 → 用高度比例，横线高 0 → 用宽度比例）
			const sScale =
				r.oW > 0 && rc.w > 0
					? rc.w / r.oW
					: r.oH > 0 && rc.h > 0
						? Math.abs(rc.h / r.oH)
						: 1;
			const cx = rc.x + rc.w / 2;
			const cy = rc.y + rc.h / 2;
			const wx = (((cx - xMin) / spanX) * natW) / PX_PER_UNIT;
			const wy = (((yMax - cy) / spanY) * natH) / PX_PER_UNIT - yOff;
			let pts: { x: number; y: number }[] | null = null;
			if (r.kind === "open" && r.pts && r.pts.length >= 2) {
				pts = r.pts.map((pt) => ({
					x: wx + ((pt.x - r.oCX) * scaleX) / PX_PER_UNIT,
					y: wy + ((pt.y - r.oCY) * scaleY) / PX_PER_UNIT,
				}));
			}
			return {
				kind: r.kind,
				worldX: wx,
				worldY: wy,
				w: ((rc.w / spanX) * natW) / PX_PER_UNIT,
				h: ((rc.h / spanY) * natH) / PX_PER_UNIT,
				strokeW: (r.strokeW * sScale) / PX_PER_UNIT,
				pts,
				shapes: r.kind === "fill" ? r.shapes : null,
				textPath: r.textPath === true,
				txt: r.kind === "text" ? r.txt : null,
				anchor: r.anchor,
				sx: rc.x,
				sy: rc.y,
				sw: rc.w,
				sh: rc.h,
				tag: r.el.tagName,
				el: r.el,
				// 小节线：Verovio 输出形式为 <g class="barLine"> 内多条垂直单段 path/line
				barLine: r.kind === "open" && !!r.el.closest("g.barLine"),
				noteId: r.el.closest("g.note")
					? r.el.closest("g.note")!.getAttribute("id")
					: null,
				staffIdx: (() => {
					const s = r.el.closest("g.staff");
					if (!s) return -1;
					// 谱行标识：谱行内五线谱线（横向细长 path）的最小 y（跨小节稳定）→ 后续按 y 聚类分链
					let v = staffLineYCache.get(s);
					if (v === undefined) {
						const lines = Array.from(s.querySelectorAll("path")).filter((p) => {
							const bb = (p as SVGGraphicsElement).getBBox();
							return bb.width > 50 && bb.height < 1;
						});
						v = lines.length
							? Math.min(
									...lines.map((l) => (l as SVGGraphicsElement).getBBox().y),
								)
							: (s as SVGGraphicsElement).getBBox().y;
						staffLineYCache.set(s, v);
					}
					return Math.round(v);
				})(),
			};
		});
		return { elems, natW, natH };
	} finally {
		// 无论解析成功/中途抛异常（getBBox 等），都移除挂载的隐藏 host，避免残留 DOM
		host.remove();
	}
}

/** 谱线合并：Verovio 把每条五线谱线画成多段（段间留缝 ~0.1 世界），3D 局部放大时"隔一段断开"。
 *  把同 y 的横长线（谱线）段按 x 排序后首尾相连成一条连续线；短横线（加线/小节内装饰）不动。 */
function mergeStaffLines(elems: MappedEl[]): MappedEl[] {
	const lines = elems.filter(
		(e) =>
			e.kind === "open" &&
			e.pts &&
			e.pts.length >= 2 &&
			Math.abs(e.pts[0]!.y - e.pts[e.pts.length - 1]!.y) < 0.0005 && // 水平线
			e.w > 0.5, // 谱线级长线（加线短，跳过）
	);
	if (lines.length < 2) return elems;
	// 按 y 分组（同一谱线所有段的 y 中心一致；容差 0.001 世界）
	const groups: MappedEl[][] = [];
	for (const l of lines) {
		const y = l.pts![0]!.y;
		const g = groups.find((gr) => Math.abs(gr[0]!.pts![0]!.y - y) < 0.001);
		if (g) g.push(l);
		else groups.push([l]);
	}
	const merged = groups
		.filter((g) => g.length > 1)
		.map((g) => {
			g.sort((a, b) => a.pts![0]!.x - b.pts![0]!.x);
			// 段的 pts 是绝对世界坐标（parseScore 已含 wx/wy）——直接拼接，不能再加 seg.worldX（否则双重偏移）
			const abs: { x: number; y: number }[] = [];
			for (const seg of g) {
				for (const pt of seg.pts!) abs.push({ x: pt.x, y: pt.y });
			}
			const clean: { x: number; y: number }[] = [];
			for (const pt of abs) {
				const last = clean[clean.length - 1];
				if (
					!last ||
					Math.abs(last.x - pt.x) > 1e-6 ||
					Math.abs(last.y - pt.y) > 1e-6
				)
					clean.push(pt);
			}
			if (clean.length < 2) return null;
			const minX = Math.min(...clean.map((p) => p.x));
			const maxX = Math.max(...clean.map((p) => p.x));
			const cX = (minX + maxX) / 2;
			const baseY = g[0]!.worldY;
			const m = { ...g[0]! };
			m.staffLine = true; // 合并后的长横线 = 五线谱线（凸起 depth × 0.7）
			m.pts = clean.map((p) => ({ x: p.x - cX, y: p.y - baseY }));
			m.worldX = cX;
			m.w = maxX - minX;
			return m;
		})
		.filter((m): m is MappedEl => !!m);
	if (!merged.length) return elems;
	const lineSet = new Set(lines);
	return [...elems.filter((e) => !lineSet.has(e)), ...merged];
}

function makeCircleShape(rx: number, ry: number): THREE.Shape {
	const s = new THREE.Shape();
	const k = 0.5522847498;
	const cx = 0,
		cy = 0;
	s.moveTo(cx + rx, cy);
	s.bezierCurveTo(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry);
	s.bezierCurveTo(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy);
	s.bezierCurveTo(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry);
	s.bezierCurveTo(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy);
	return s;
}

// ═══════════ 演奏打标（识别"需要演奏"的音符/和弦 → 小球跳目标） ═══════════
// 数据来源：
//   SVG 层：<g class="note"> 是演奏单位（notehead use 是位置锚点）——3D 位置（worldX/worldY）
//   MIDI 层：演奏事件（音高/时间/时值）——将来小球跳动的规则数据（MIDI 优先，无则从 XML 提取）
interface PlayTarget {
	x: number;
	y: number;
	id: string | null;
	time: number; // 演奏时间（秒；绑定自 MIDI 事件或 x 线性映射）
	channel: number; // 轨号（决定点亮颜色）
	mark: number; // 轨道标记（谱行聚类）：轨迹线/球只连接标记相同的音符
	staffY: number; // 所属 g.staff 的 getBBox().y（聚类键）
}
//   MIDI 层：演奏事件（音高/时间/时值）——小球跳动规则数据（统一来自 score/midiEvents）
interface RepeatInfo {
	type: "forward" | "backward";
	measure: number;
}

let playTargets: PlayTarget[] = [];
let playEvents: PlayEvent[] = [];
let repeatInfo: RepeatInfo[] = [];

/** 从 3D 元素（带 noteId 标记）提取演奏目标：每个 g.note = 一个演奏单位 */
function extractPlayTargets(elems: MappedEl[]): PlayTarget[] {
	const byNote = new Map<string, MappedEl[]>();
	for (const e of elems) {
		if (!e.noteId) continue;
		const a = byNote.get(e.noteId) ?? [];
		a.push(e);
		byNote.set(e.noteId, a);
	}
	const targets: PlayTarget[] = [];
	for (const [id, list] of byNote) {
		const nh = list.find((e) => e.el.closest(".notehead")) ?? list[0]!;
		targets.push({
			x: nh.worldX,
			y: nh.worldY,
			id,
			time: 0,
			channel: 0,
			mark: 0,
			staffY: nh.staffIdx,
		});
	}
	// 谱行聚类：staffY（谱线 y，fallback 内容顶）按 800 桶归并（谱行间距>1500 分开、内容浮动<800 合并）→ 每谱行唯一 mark（钢琴左右手=两条链）
	const ys = [...new Set(targets.map((t) => Math.floor(t.staffY / 800)))];
	ys.sort((a, b) => a - b);
	const mkMap = new Map(ys.map((y, i) => [y, i]));
	targets.forEach((t) => {
		t.mark = mkMap.get(Math.floor(t.staffY / 800))!;
	});
	targets.sort((a, b) => a.x - b.x);
	return targets;
}

function midiFromStep(step: string, alter: number, octave: number): number {
	const base: Record<string, number> = {
		C: 0,
		D: 2,
		E: 4,
		F: 5,
		G: 7,
		A: 9,
		B: 11,
	};
	return (octave + 1) * 12 + (base[step] ?? 0) + alter;
}

/** XML 提取演奏事件（MusicXML/MEI；MIDI 缺失时的 fallback；多声部按文档序合流） */
function extractXmlEvents(xmlStr: string): PlayEvent[] {
	const doc = new DOMParser().parseFromString(xmlStr, "application/xml");
	const out: PlayEvent[] = [];
	if (doc.querySelector("score-partwise, score-timewise")) {
		// MusicXML：pitch/duration/divisions；rest 只推进时间
		const notes = doc.getElementsByTagName("note");
		const divisions =
			parseFloat(doc.querySelector("divisions")?.textContent ?? "1") || 1;
		let t = 0;
		for (let i = 0; i < notes.length; i++) {
			const n = notes[i]!;
			const d =
				parseFloat(n.querySelector("duration")?.textContent ?? "0") || 0;
			if (n.querySelector("grace")) continue; // 装饰音：跳过且不推进
			const p = n.querySelector("pitch");
			if (!p) {
				t += d / divisions;
				continue;
			}
			const step = p.querySelector("step")?.textContent ?? "C";
			const alter =
				parseFloat(p.querySelector("alter")?.textContent ?? "0") || 0;
			const octave = parseInt(p.querySelector("octave")?.textContent ?? "4", 10);
			out.push({
				midi: midiFromStep(step, alter, octave),
				time: t,
				dur: d / divisions,
				vel: 90,
				channel: 0,
			});
			t += d / divisions;
		}
	} else if (doc.querySelector("mei")) {
		// MEI：pname/oct/dur/dots（dur="4" = 四分音符 1 拍）
		const durBeats: Record<string, number> = {
			"1": 4,
			"2": 2,
			"4": 1,
			"8": 0.5,
			"16": 0.25,
			"32": 0.125,
			"64": 0.0625,
			breve: 8,
			long: 16,
		};
		const base: Record<string, number> = {
			c: 0,
			d: 2,
			e: 4,
			f: 5,
			g: 7,
			a: 9,
			b: 11,
		};
		const notes = doc.getElementsByTagName("note");
		let t = 0;
		for (let i = 0; i < notes.length; i++) {
			const n = notes[i]!;
			const dr = n.getAttribute("dur");
			if (!dr) continue; // 无 dur（grace 等）跳过
			const pname = (n.getAttribute("pname") ?? "c").toLowerCase();
			const oct = parseInt(n.getAttribute("oct") ?? "4", 10);
			const dots = parseInt(n.getAttribute("dots") ?? "0", 10) || 0;
			let beats = durBeats[dr] ?? 1;
			for (let k = 0; k < dots; k++)
				beats += (durBeats[dr] ?? 1) / (2 * (k + 1));
			out.push({
				midi: (oct + 1) * 12 + (base[pname] ?? 0),
				time: t,
				dur: beats,
				vel: 90,
				channel: 0,
			});
			t += beats;
		}
	}
	return out;
}

/** 反复记号识别（MusicXML <barline repeat> / MEI measure left/right 属性）——为"展开反复"准备 */
function extractRepeats(xmlStr: string): RepeatInfo[] {
	const doc = new DOMParser().parseFromString(xmlStr, "application/xml");
	const out: RepeatInfo[] = [];
	const measures = doc.getElementsByTagName("measure");
	for (let i = 0; i < measures.length; i++) {
		const m = measures[i]!;
		const rep = m.querySelector("barline repeat");
		if (rep)
			out.push({
				type:
					rep.getAttribute("direction") === "backward" ? "backward" : "forward",
				measure: i + 1,
			});
		const right = m.getAttribute("right") ?? "";
		const left = m.getAttribute("left") ?? "";
		if (right.includes("rptend"))
			out.push({ type: "backward", measure: i + 1 });
		if (left.includes("rptstart"))
			out.push({ type: "forward", measure: i + 1 });
	}
	return out;
}

/** 演奏事件：唯一事件源 score/midiEvents（MIDI 精确时间/音高）；无 MIDI 时才从 XML 提取 */
function loadPlayEvents(): PlayEvent[] {
	const evs = parseMidiEvents(sessionStorage.getItem("midee.midi"));
	if (evs.length) return evs;
	const xml = sessionStorage.getItem("midee.xml");
	return xml ? extractXmlEvents(xml) : [];
}

// ── 演奏点亮（进度驱动：演奏过的音符变轨色，进度回退恢复黑色） ──
// 颜色预设照搬 midee 瀑布流 theme.ts 的 trackColors（5 套）+ 每轨可自定义
const LIT_THEMES: Record<string, number[]> = {
	Dark: [
		0x6366f1, 0x818cf8, 0x60a5fa, 0xa78bfa, 0xf472b6, 0x34d399, 0xfbbf24,
		0xfb923c,
	],
	Midnight: [
		0xa78bfa, 0xc084fc, 0x818cf8, 0xe879f9, 0x7dd3fc, 0xf9a8d4, 0x93c5fd,
		0x6ee7b7,
	],
	Neon: [
		0x00ffaa, 0x00e5ff, 0x39ff14, 0xff6bff, 0xffe600, 0xff4040, 0x00bfff,
		0xff9100,
	],
	Sunset: [
		0xf97316, 0xfbbf24, 0xef4444, 0xec4899, 0xff8c5a, 0xfde68a, 0xff6b9d,
		0xfca5a5,
	],
	Ocean: [
		0x38bdf8, 0x06b6d4, 0x6366f1, 0x34d399, 0xa78bfa, 0x4ade80, 0x22d3ee,
		0x67e8f9,
	],
};
/** 把每条路径的当前色注册+广播到 ColorBus（跟随下拉里看到的就是「路径1..N」） */
function publishPathColors(): void {
	surf.pathNames.forEach((name, i) => {
		const c = pathColorFor(i, i);
		const id = `path.${i}`;
		ColorBus.register(id, name, c);
		ColorBus.publish(id, c);
	});
}
const targetMeshes = new Map<number, THREE.Mesh[]>(); // targetIdx → 它的所有 mesh（notehead/artic 等）
let litCount = 0; // 已点亮数量（递增/递减增量更新）

/** 播放进度 → 点亮状态（二分定位边界，只改变化的区间） */
function setLitProgress(t: number): void {
	let k = 0;
	while (k < playTargets.length && playTargets[k]!.time <= t) k++;
	if (k === litCount) return;
	const from = Math.min(k, litCount);
	const to = Math.max(k, litCount);
	for (let i = from; i < to; i++) {
		const on = surf.litEnabled && i < k;
		for (const m of targetMeshes.get(i) ?? []) {
			const mm = m.material as THREE.MeshStandardMaterial;
			if (on) {
				const color = litColorFor(i);
				mm.color.setHex(color);
				mm.emissive.setHex(color);
				mm.emissiveIntensity = litBrightFor(i);
			} else {
				// 未点亮：跟随乐谱整体材质/颜色/自发光
				mm.color.copy(inkMat.color);
				mm.emissive.copy(inkMat.emissive);
				mm.emissiveIntensity = inkMat.emissiveIntensity;
			}
		}
	}
	litCount = k;
}
function resetLit(): void {
	for (const [, list] of targetMeshes) {
		for (const m of list) {
			const mm = m.material as THREE.MeshStandardMaterial;
			mm.color.copy(inkMat.color);
			mm.emissive.copy(inkMat.emissive);
			mm.emissiveIntensity = inkMat.emissiveIntensity;
		}
	}
	for (const tl of tieLights) {
		tl.overlay.visible = false;
		const sh = tl.mat.userData.shader as
			| { uniforms: { uLitX: { value: number } } }
			| undefined;
		if (sh) sh.uniforms.uLitX.value = -1e9;
	}
	litCount = 0;
}

/** target ↔ 演奏事件关联：
 *  1) 每个符头绑到它自己的 MIDI 事件秒（时间唯一权威 = MIDI，见 score/midiEvents）；
 *  2) 绑不上的（tie 延续/装饰音/两源差异）退 Verovio timemap，再退 x 线性；
 *  3) 顺带算出每小节软矫正锚点；同 time 桶内按 y 升序绑 channel（球按轨分组不乱跳） */
function bindTargetTimes(): void {
	// ── 时间绑定（与第三页 buildTimeAndTracks 完全同源） ──
	// XML 可发声符头（parseXmlHeads，排除休止/tie 延续/装饰音）逐个绑到 MIDI 事件秒。
	// 旧写法要求「符头数 == tie 合并后事件数」才绑，差一个就整体退回 Verovio
	// timemap —— 那是第二时间源，网格对不上时会整段跑偏，正是「第五页球到端点
	// 与点亮/音乐对不齐」的根因。现在改成逐个头绑，绑得上的全绑。
	const headTime = new Map<string, number>();
	const xml = sessionStorage.getItem("midee.xml") ?? "";
	const soundingHeads = xml
		? parseXmlHeads(xml).filter(
				(h) =>
					!h.rest && !h.tieCont && !h.grace && h.midi !== null && h.noteId,
			)
		: [];
	if (soundingHeads.length) {
		const gridB64 = sessionStorage.getItem("midee.midi");
		const midiEvs = parseMidiEvents(gridB64);
		if (midiEvs.length)
			for (const [id, t] of alignHeadsToEvents(soundingHeads, midiEvs))
				headTime.set(id, t);
		// 每小节软矫正：只有「播放源 ≠ 连线用的量化 MIDI」（设置里选了原始演奏 MIDI）
		// 才可能有整段相位差；同一份数据时锚点恒为 0，直接留空表——既省一次解析，
		// 也杜绝矫正层凭空挪画面的可能。
		const playB64 = playbackMidiB64();
		corrAnchors =
			playB64 && playB64 !== gridB64
				? measureCorrectionAnchors(
						soundingHeads,
						headTime,
						parseMidiEvents(playB64),
					)
				: [];
	} else corrAnchors = [];
	// timemap 兜底/补齐：只为 MIDI 没覆盖的符头（tie 延续/装饰音，它们的 g.note
	// 也是 playTarget）补时间，不覆盖已绑定的
	if (playTargets.some((t) => !t.id || !headTime.has(t.id)) && vtk) {
		try {
			for (const row of vtk.renderToTimemap?.() ?? []) {
				if (!row.on || row.tstamp === undefined) continue;
				const sec = row.tstamp / 1000;
				for (const id of row.on) if (!headTime.has(id)) headTime.set(id, sec);
			}
		} catch {
			/* timemap 不可用 → 未覆盖符头走线性兜底 */
		}
	}
	const dur = playEvents.length
		? Math.max(...playEvents.map((e) => e.time + e.dur))
		: 0;
	const fallbackDur = dur > 0 ? dur : trackLength / 1.5;
	for (const t of playTargets) {
		const hit = t.id ? headTime.get(t.id) : undefined;
		t.time = hit !== undefined ? hit : (t.x / Math.max(1e-6, trackLength)) * fallbackDur;
	}
	// time 升序；同 time 按 y 升序（高音谱表在上）
	playTargets.sort((a, b) => a.time - b.time || a.y - b.y);
	// 同 time 桶内按序绑定 channel（events 原始轨序 = staff 顺序，与 y 顺序对应）
	const eps = 0.005;
	const tgByTime = new Map<number, PlayTarget[]>();
	for (const t of playTargets) {
		const key = Math.round(t.time / eps);
		const a = tgByTime.get(key) ?? [];
		a.push(t);
		tgByTime.set(key, a);
	}
	const evByTime = new Map<number, PlayEvent[]>();
	for (const e of mergeTieEvents(playEvents)) {
		const key = Math.round(e.time / eps);
		const a = evByTime.get(key) ?? [];
		a.push(e);
		evByTime.set(key, a);
	}
	for (const [key, tgList] of tgByTime) {
		const evList = evByTime.get(key);
		if (!evList) continue;
		// 桶内按音高升序（events 按 midi、targets 按 y）→ 高音对高音、低音对低音，避免跨轨错绑
		evList.sort((a, b) => (a.midi ?? 0) - (b.midi ?? 0));
		for (let k = 0; k < Math.min(tgList.length, evList.length); k++) {
			tgList[k]!.channel = evList[k]!.channel ?? 0;
		}
	}
	// 轨道标记统一：同一 staff（mark）的音符强制同一 channel（点亮颜色整轨一致，球链严格按 mark 分组）
	const markCh = new Map<number, number>();
	for (const t of playTargets) {
		const m = t.mark >= 0 ? t.mark : 0;
		if (!markCh.has(m)) markCh.set(m, t.channel);
	}
	for (const t of playTargets)
		t.channel = markCh.get(t.mark >= 0 ? t.mark : 0) ?? 0;
}
/** MusicXML tie 语义 → 延续音 noteId 挂回它延续的那颗音的 noteId（一条 tie 链统一指向链首）。
 *  分组键与 auto-links 的 tie 链合并完全一致（part|staff|voice|midi）；这里只读 XML，
 *  不动连线逻辑。 */
function tieSourceById(xml: string): Map<string, string> {
	const src = new Map<string, string>();
	const open = new Map<string, string>();
	for (const h of parseXmlHeads(xml)) {
		if (h.rest || !h.noteId) continue;
		const key = `${h.part}|${h.staff}|${h.voice}|${h.midi}`;
		if (h.tieStart && !h.tieStop) open.set(key, h.noteId);
		else if (h.tieStop) {
			const from = open.get(key);
			if (from) src.set(h.noteId, from);
			if (!h.tieStart) open.delete(key);
		}
	}
	return src;
}
/** 多个路径色叠加（screen 混合：越叠越亮，模拟两束光打在同一符头上） */
function blendPathColors(pathIdxs: number[]): number {
	if (pathIdxs.length <= 1) return pathColorFor(pathIdxs[0] ?? -1);
	let r = 0,
		g = 0,
		b = 0;
	for (const pi of pathIdxs) {
		const c = pathColorFor(pi);
		const cr = (c >> 16) & 255,
			cg = (c >> 8) & 255,
			cb = c & 255;
		// screen: 1 - (1-a)(1-b)
		r = 255 - ((255 - r) * (255 - cr)) / 255;
		g = 255 - ((255 - g) * (255 - cg)) / 255;
		b = 255 - ((255 - b) * (255 - cb)) / 255;
	}
	return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}
/** 点亮色：跟随小球（默认）= 该音符所在路径的路径色；多条路径同落一音时取叠加色 */
function litColorFor(i: number): number {
	if (!surf.litFollowBall) return surf.litColor;
	const ps = targetPaths[i];
	if (ps && ps.length > 1) return blendPathColors(ps);
	return pathColorFor(targetPath[i] ?? -1, playTargets[i]!.channel ?? 0);
}
/** 重刷当前进度已点亮的音符颜色（主题/模式/自定义色改变时；未点亮的保持黑） */
function refreshLitColors(): void {
	for (let i = 0; i < litCount; i++) {
		const color = litColorFor(i);
		for (const m of targetMeshes.get(i) ?? []) {
			const mm = m.material as THREE.MeshStandardMaterial;
			mm.color.setHex(color);
			mm.emissive.setHex(color);
			mm.emissiveIntensity = litBrightFor(i);
		}
	}
}
/** 预设点亮主题 → 音轨颜色表（音轨面板同步刷新） */
function applyLitTheme(key: string): void {
	const th = LIT_THEMES[key] ?? LIT_THEMES.Dark!;
	// 主题不再维护第二张色表：直接把各路径重配成这套色，仍然只有 pathColors 一个来源
	surf.pathColors = surf.pathNames.map((_, i) => th[i % th.length]!);
	refreshLitColors();
	publishPathColors();
}

// ── 小球轨迹系统（每轨一主球 + 和弦并行球） ───────────────────────
// 规则：小球不跨轨道（按 channel 分组）；同轨和弦（同刻多符头）拆成多个球并行飞向各自符头；
//       同轨同刻同音高（重复音）合并为一次点亮；球在点亮时刻前 axisLead（起始留白）起飞，
//       到达时刻 = 音符点亮时刻；弧线高度与音符间距成正比（离得越远飞得越高）
/** 一个谱线间距（内部世界单位）：构建后按谱线实测。球/圆片这类"贴在谱面上"的尺寸一律以它为基准，
 *  否则换个谱子或改映射缩放，绝对值就对不上符头了。 */
let staffSpace = 0.05;
let ballRadius = staffSpace * 0.5; // 球半径 = 球大小倍数 × 谱线间距
/** 第三页起点/终点锚点（ayStart/ayEnd）存的是 SVG 用户坐标 Y；本页符头 worldY 经过
 *  「内容居中 + 上下翻转 + ÷PX_PER_UNIT」归一化，量纲不同。此仿射映射把锚点 SVG Y 换算成
 *  世界 Y（parseScore 按内容包围盒拟合）。缺它时头/尾段会把 SVG 锚点当世界 Y，竖直跨度暴涨
 *  → 起落弧高、起终点竖线范围全部失真（不同宽高/多谱表/休止开头的谱各有异常的共同根因）。 */
let anchorYMap: { a: number; b: number } | null = null;
/** 谱线 = 又宽又扁的 open 元素；取相邻 y 的中位差即一个谱线间距 */
function measureStaffSpace(): void {
	const ys = [
		...new Set(
			allElems
				.filter((e) => e.kind === "open" && e.h < 0.02 && e.w > 0.3)
				.map((e) => Math.round(e.worldY * 1e4) / 1e4),
		),
	].sort((a, b) => a - b);
	const gaps: number[] = [];
	for (let i = 1; i < ys.length; i++) {
		const g = ys[i]! - ys[i - 1]!;
		if (g > 1e-4 && g < 1) gaps.push(g);
	}
	if (!gaps.length) return;
	gaps.sort((a, b) => a - b);
	const med = gaps[Math.floor(gaps.length / 2)]!;
	if (med > 0) staffSpace = med;
	ballRadius = clamp(surf.ballSize * staffSpace, 1e-4, 10);
	recalcBallBaseZ();
}
const MAX_PARALLEL = 8; // 每轨最大并行球（和弦拆球上限）

/** 抛物线插值点：peak 随两点距离增大（近音低飞、远音高飞） */
function arcPoint(
	px: number,
	py: number,
	tx: number,
	ty: number,
	u: number,
	zBase = 0.02,
): THREE.Vector3 {
	const dist = Math.hypot(tx - px, ty - py);
	const peak = Math.min(0.7, 0.08 + dist * 0.3);
	return new THREE.Vector3(
		px + (tx - px) * u,
		py + (ty - py) * u,
		zBase + peak * 4 * (u - u * u),
	);
}

// ── 分裂分支（一拆二 → 副球去中线落点 → 同时飞下一落点会合） ──
interface SplitState {
	phase: "normal" | "split1" | "split2"; // 测试台同款三态
	triggered: boolean; // 到达落点3已触发分裂（一次循环一次；seek/重播复位）
	splitBall: THREE.Mesh; // 副球（分裂时可见）
	trailB: TrailObj; // 副球拖尾
	histB: HistPt[]; // 副球拖尾采样
	centerPos: THREE.Vector3; // 中心点（副球分道目的地）
	splitFrom: THREE.Vector3; // 副球当前起跳点
	splitTo: THREE.Vector3; // 副球当前目标
	p3: THREE.Vector3; // 落点3（分裂点）
	p5: THREE.Vector3; // 落点5（会合点）
	mainSeg: number; // 分裂期主球当前 seg 索引（split1=第3edge，split2=第4edge）
	mainSeg2: number; // split2 主球 seg 索引（第4edge）
	/** 副球并回主球的时刻（绝对播放时间；-1 = 尚未合并）。合并后副球拖尾不截断，
	 *  而是按「点龄」把每一环逐步折到主球同一时刻的位置上（见 renderTrailPipe 的 bend）。 */
	joinT: number;
}

interface BallTrack {
	segs: BallSeg[];
	prevSeg: number[]; // 与 segs 同序的上游段下标（拖尾段间接力用，见 loadLinkTracks）
	pool: THREE.Mesh[]; // 每个 seg 一个球，常驻、仅活动时可见
	color: number; // 该轨颜色（用于不重建几何、仅换材质）
	pathIdx: number; // 路径序号（= ballTracks 下标 = 面板「路径N」）；per-path 颜色按它取
	glow: THREE.Mesh; // 该轨球光晕（three-glow-mesh；跟随最前可见球，样式/范围见 光源·小球）
	light: THREE.PointLight; // 该轨小球点光源（照亮周围谱面，颜色=路径色，强度=「照亮强度」）
	lastBurstT?: number; // 上一次粒子迸发的播放时刻（和弦同刻只放一记用）
	split?: SplitState; // 分裂分支（该轨 edge 段不足时不挂载）
}
let ballTracks: BallTrack[] = [];
/** playTarget 下标 → 所属路径序号（-1 = 不在任何球轨上），点亮色按它取 */
let targetPath: number[] = [];
/** playTarget 下标 → 所有经过它的路径序号（手动跨轨连线时同一音符可被多条路径串到）；
 *  点亮色取这些路径色的叠加，避免「两球同落一音却只显一色」的歧义 */
let targetPaths: number[][] = [];
// ── 时间线首尾偏移（权威数据 = 第三页 links store.offStart/offEnd） ──
// axisLead：音乐开始前的留白 = 小球下落时间（surf.flightMs，两者同源）；
// axisTail：末音后的留白 = 尾球飞出时间。第三页「播放 → 首尾留白」输入框
// 改动后 persist() 落盘，本页读入保持两页显示轴/球弧完全一致；本页改
// 「下落时间」也写回 store，回第三页时生效。
// 同源的还有起/终点线「远离乐谱距离」（store.termStartGap/termEndGap，SVG 用户
// 单位）：第三页拖竖线、本页「路径」页拖滑轨，写的都是同一个数。
let axisLead = Math.max(0.1, surf.flightMs / 1000);
let axisTail = axisLead;
/** 从 sessionStorage midee.links 读第三页的首尾偏移（无数据/旧格式用本页默认） */
function readOffsets(): void {
	try {
		const raw = sessionStorage.getItem("midee.links");
		if (!raw) return;
		const o = JSON.parse(raw) as {
			offStart?: number;
			offEnd?: number;
			termStartGap?: number;
			termEndGap?: number;
		};
		const lead = Number(o.offStart);
		const tail = Number(o.offEnd);
		if (Number.isFinite(lead) && lead >= 0) axisLead = Math.min(5, Math.max(0.1, lead));
		if (Number.isFinite(tail) && tail >= 0) axisTail = Math.min(5, tail);
		surf.flightMs = Math.round(axisLead * 1000); // 面板「下落时间」回显为生效值
		const gl = Number(o.termStartGap);
		const gt = Number(o.termEndGap);
		if (Number.isFinite(gl) && gl > 0) surf.termLeadGap = Math.min(600, Math.max(12, gl));
		if (Number.isFinite(gt) && gt > 0) surf.termTailGap = Math.min(600, Math.max(12, gt));
	} catch {
		/* 无 links 数据：维持默认 */
	}
}
/** 把首尾偏移/首尾线距离写回第三页 store（只合并这几个字段，不动 paths/removed） */
function writeOffsets(lead?: number, tail?: number): void {
	try {
		const raw = sessionStorage.getItem("midee.links");
		const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		if (lead !== undefined) o.offStart = lead;
		if (tail !== undefined) o.offEnd = tail;
		o.termStartGap = surf.termLeadGap;
		o.termEndGap = surf.termTailGap;
		sessionStorage.setItem("midee.links", JSON.stringify(o));
	} catch {
		/* 写不进就只在本地生效 */
	}
}
let ballEnded = false; // 播放自然结束 → 球跳终点线并保持；重新播放/手动停止时重置
const TERM_GAP_DEF = 90; // 默认起终点线「远离乐谱距离」（SVG 用户单位，=第三页 TERM_MARGIN）
/** 起点/终点线「远离乐谱距离」（内部单位）：吃面板滑轨，与第三页竖线拖拽同一份数据。
 *  所有轨共用同一条竖线（下面的归一保证这一点）。 */
const gapLeadU = (): number => Math.max(12, surf.termLeadGap || TERM_GAP_DEF) / PX_PER_UNIT;
const gapTailU = (): number => Math.max(12, surf.termTailGap || TERM_GAP_DEF) / PX_PER_UNIT;
/** 开着「跟随主路径高度」时，把生效弧高（抛物线高度 × 本段水平距离）写回高度滑轨的
 *  数值：面板显示的就是当前真实高度，关掉跟随或直接拖滑轨都不会凭空跳一段。 */
function syncTermHeights(): void {
	if (staffSpace <= 0) return;
	const h = Math.max(0, surf.jumpHeight);
	if (surf.termLeadHFollow) surf.termLeadH = (h * gapLeadU()) / staffSpace;
	if (surf.termTailHFollow) surf.termTailH = (h * gapTailU()) / staffSpace;
}
const ballGroup = new THREE.Group();
world.add(ballGroup);
let flightRebuildTimer: number | undefined;
/** 防抖重建球轨：head/tail 段的起止时刻与起点/终点线位置都依赖这些值 */
function scheduleTrackRebuild(): void {
	if (!playTargets.length) return;
	window.clearTimeout(flightRebuildTimer);
	flightRebuildTimer = window.setTimeout(() => {
		if (playTargets.length) initBalls();
	}, 150);
}
/** 下落时间（surf.flightMs）→ axisLead（=第三页 offStart）并防抖重建球轨（head/tail 段起止时间依赖它） */
function onFlightChanged(): void {
	axisLead = Math.max(0.1, surf.flightMs / 1000);
	writeOffsets(axisLead); // 起始留白同源回写第三页（尾留白只在第三页调）
	scheduleTrackRebuild();
}
/** 起点/终点线「远离乐谱距离」改了（面板滑轨）：写回第三页 + 重建球轨与两条竖线 */
function onTermGapChanged(): void {
	writeOffsets();
	refreshTermSegs(); // 拖动期间先把 head/tail 球端点挪到新距离，避免残留小球
	scheduleTrackRebuild();
}
/** 首偏移量（=第三页 offStart）：顶栏「工具 ▾」滑轨与面板「下落时间」都走这里 */
function setAxisLead(v: number): void {
	axisLead = Math.min(5, Math.max(0.1, v));
	surf.flightMs = Math.round(axisLead * 1000);
	writeOffsets(axisLead);
	scheduleTrackRebuild();
}
/** 尾偏移量（=第三页 offEnd）：所有尾球用这么久同时抵达终点线 */
function setAxisTail(v: number): void {
	axisTail = Math.min(5, Math.max(0.1, v));
	writeOffsets(undefined, axisTail);
	scheduleTrackRebuild();
}
/** 读回第三页的值之后，把首尾偏移量刷进顶栏下拉里的滑轨/数字框 */
function syncAxisInputs(): void {
	for (const [el, v] of [
		[axisLeadSlide, axisLead],
		[axisLeadNum, axisLead],
		[axisTailSlide, axisTail],
		[axisTailNum, axisTail],
	] as const) {
		el.value = String(Math.round(v * 100) / 100);
	}
}

// ── 小球运动拖尾（播放条第 12 项控制；3D 页此项不改乐谱） ───────
// 每个球一条 Points 拖尾：沿播放时间轴等间隔采样，越旧越淡。
// 谱面是白底，不能用加色混合（彩色加到白上会变白消失），故用自定义
// ShaderMaterial：per-vertex 颜色 + alpha，圆形软边点，普通 alpha 混合。
const TRAIL_MAX_SEC = 2.0; // 滑杆 200% 时的最长拖尾时长（照搬测试台滑块上限 2s）
const TRAIL_REF_SEC = 0.8; // 滑杆 100% 对应的拖尾时长（照搬测试台默认 0.8s）
const TRAIL_SAMPLE_DT = 0.012; // 采样间隔（播放时间轴秒）：短抛物线也要有足够环数，否则拖尾成多边形
const TRAIL_KEY = "midee.trailPct";
const TRAIL_PCT_MIN = 0;
const TRAIL_PCT_MAX = 200;
// 恢复上次拖尾长度偏好（拖尾长度/强度由 3D 设置悬浮窗控制）
try {
	// 注意：Number(null) 和 Number("") 都是 0（不是 NaN），必须用 parseFloat 让空值返回 NaN
	const n = parseFloat(localStorage.getItem(TRAIL_KEY) ?? "");
	if (Number.isFinite(n))
		surf.trailPct = Math.min(TRAIL_PCT_MAX, Math.max(TRAIL_PCT_MIN, n));
} catch {
	/* noop */
}
const TRAIL_CAPACITY = Math.ceil(TRAIL_MAX_SEC / TRAIL_SAMPLE_DT) + 2;
const trailGroup = new THREE.Group();
world.add(trailGroup);

/** 拖尾采样点回收池：hist.shift()/清空时把对象还回来，热路径不再产生垃圾 */
const histPool: HistPt[] = [];
function takeHist(): HistPt {
	return histPool.pop() ?? { t: 0, p: new THREE.Vector3() };
}
function recycleHist(list: HistPt[]): void {
	for (const h of list) if (histPool.length < TRAIL_CAPACITY * 8) histPool.push(h);
	list.length = 0;
}
/** 丢掉最老的环（回收对象，不产生临时数组） */
function dropOldest(hist: HistPt[]): void {
	const h = hist.shift();
	if (h && histPool.length < TRAIL_CAPACITY * 8) histPool.push(h);
}
interface HistPt {
	t: number;
	p: THREE.Vector3;
}
/** 采一个拖尾点：按「绝对时间」间隔追加；未到间隔就把头环钉在当前球位（环距不随帧率变） */
function sampleHist(hist: HistPt[], time: number, pos: THREE.Vector3): void {
	const last = hist.length ? hist[hist.length - 1]! : null;
	if (last) {
		const dt = time - last.t;
		if (dt < TRAIL_SAMPLE_DT) {
			if (dt > 0) {
				last.t = time;
				last.p.copy(pos);
			}
			return;
		}
	}
	const h = takeHist();
	h.t = time;
	h.p.copy(pos);
	hist.push(h);
	while (hist.length > TRAIL_CAPACITY) dropOldest(hist);
}

// 拖尾（照搬测试台：水滴形变截面 3D 管道——头大尾尖，实体网格）
const TRAIL_RADIAL_SEGS = 24; // 横截面圆分段（14 段在球缩小后能看出一棱一棱的）
const TRAIL_TAPER_POWER = 1.6; // 锥度：越大尾越尖
const TRAIL_JOIN_MAX_DIST = 2.0; // 段间拖尾继承的最大落点间距（世界单位）——音符连续时新段球接过前段拖尾，整条不断节
const trailColorObj = new THREE.Color();
const trailResolution = new THREE.Vector2(
	window.innerWidth,
	window.innerHeight,
);
interface TrailObj {
	mesh: THREE.Mesh;
	geo: THREE.BufferGeometry;
	mat: THREE.MeshBasicMaterial;
}

/** 为一个球创建水滴形拖尾管道（固定容量，drawRange 裁剪） */
function makeTrail(): TrailObj {
	const capacity = TRAIL_CAPACITY;
	const verts = new Float32Array(capacity * TRAIL_RADIAL_SEGS * 3);
	const geo = new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
	// 索引一次构建：相邻两圈之间三角化
	const idx: number[] = [];
	for (let i = 0; i < capacity - 1; i++) {
		for (let k = 0; k < TRAIL_RADIAL_SEGS; k++) {
			const a = i * TRAIL_RADIAL_SEGS + k;
			const b = i * TRAIL_RADIAL_SEGS + ((k + 1) % TRAIL_RADIAL_SEGS);
			const c = (i + 1) * TRAIL_RADIAL_SEGS + k;
			const d = (i + 1) * TRAIL_RADIAL_SEGS + ((k + 1) % TRAIL_RADIAL_SEGS);
			idx.push(a, c, b, b, c, d);
		}
	}
	geo.setIndex(idx);
	geo.setDrawRange(0, 0);
	const mat = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		// 测试台同款：不透明实体 3D 管道（非半透明特效）
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.visible = false;
	mesh.frustumCulled = false;
	mesh.renderOrder = 6;
	mesh.layers.enable(BLOOM_LAYER); // 拖尾随小球一起进发光缓冲
	trailGroup.add(mesh);
	return { mesh, geo, mat };
}

function disposeTrails(): void {
	while (trailGroup.children.length) {
		const mesh = trailGroup.children[0] as THREE.Mesh;
		trailGroup.remove(mesh);
		mesh.geometry.dispose();
		(mesh.material as THREE.Material).dispose();
	}
}

// 水滴管道渲染公共段（主球/副球共用；hist[0]=尾 oldest、hist[n-1]=头 最新采样）
const _tUp = new THREE.Vector3(0, 1, 0);
const _tTan = new THREE.Vector3();
const _tRight = new THREE.Vector3();
const _tUp2 = new THREE.Vector3();
const _tBent = new THREE.Vector3();
// 环心暂存（预分配，逐帧只覆写有效前缀，不 new）
const _ringX = new Float32Array(TRAIL_CAPACITY);
const _ringY = new Float32Array(TRAIL_CAPACITY);
const _ringZ = new Float32Array(TRAIL_CAPACITY);

/** 会合处折回参数（方案一）：副球并回主球后，拖尾不截断，而是按「点龄」把每一环
 *  逐步折到主球同一时刻的位置上 —— 折完的那一段与主球拖尾完全重合，就不再画。 */
interface TrailBend {
	bt: BallTrack;
	joinT: number; // 合并时刻（绝对播放时间，不用帧数）
	now: number; // 当前时刻
}
const _bend: TrailBend = { bt: null as unknown as BallTrack, joinT: 0, now: 0 };

/** 主球在任意时刻的位置：按时间选段 + 弧长参数二分重算，不遍历主球历史数组 */
function mainBallPosAt(bt: BallTrack, sp: SplitState, time: number, out: THREE.Vector3): void {
	const s4 = bt.segs[sp.mainSeg2];
	const s = (s4 && time >= s4.ta ? s4 : bt.segs[sp.mainSeg])!;
	const dist = Math.hypot(s.bx - s.ax, s.by - s.ay);
	const par = Math.min(1, Math.max(0, (time - s.ta) / Math.max(1e-6, s.tb - s.ta)));
	const u = arcParamAt(segArc(s, dist), par);
	out.set(
		s.ax + (s.bx - s.ax) * u,
		s.ay + (s.by - s.ay) * u,
		BALL_Z + arcHeightAt(s.kind, u, dist),
	);
}

function renderTrailPipe(
	trail: TrailObj,
	hist: HistPt[],
	headR: number,
	headScale: number,
	followColor: THREE.Color | null,
	fallbackColor: number,
	bend?: TrailBend,
): void {
	const n = hist.length;
	if (n < 2 || headScale < 0.01) {
		trail.mesh.visible = false;
		return;
	}
	// 拖尾颜色：跟随小球色（测试页同款）或自定义
	if (followColor) trail.mat.color.copy(followColor);
	else trail.mat.color.copy(trailColorObj.setHex(fallbackColor));

	// hist 按 t 升序 ⇒ 点龄 a=joinT-t 降序 ⇒ "已折完"总是靠头的一段后缀，二分找分界
	let rings = n;
	const el = bend ? bend.now - bend.joinT : 0;
	if (bend) {
		let lo = 0;
		let hi = n;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const a = bend.joinT - hist[mid]!.t;
			if (a <= 1e-6 || el >= a) hi = mid;
			else lo = mid + 1;
		}
		rings = lo; // 只画 [0, rings)：折完的环与主球拖尾重合，不再重复绘制
		if (rings < 2) {
			trail.mesh.visible = false;
			return;
		}
	}

	// ──  环心 ──
	for (let j = 0; j < rings; j++) {
		const p = hist[j]!.p;
		let x = p.x;
		let y = p.y;
		let z = p.z;
		if (bend) {
			const a = bend.joinT - hist[j]!.t; // 该环在合并那一刻已经存在多久
			const w = Math.min(1, el / Math.max(a, 1e-6)); // 折回进度：0=原位 1=贴上主路径
			// lerp 两端分清：起点=副球历史点，终点=主球「同一时刻」的位置（同年龄→同半径，接缝不跳）
			mainBallPosAt(bend.bt, bend.bt.split!, hist[j]!.t + el, _tBent);
			x += (_tBent.x - x) * w;
			y += (_tBent.y - y) * w;
			z += (_tBent.z - z) * w;
		}
		_ringX[j] = x;
		_ringY[j] = y;
		_ringZ[j] = z;
	}

	// ──  横截面：平行输运 ──
	// 每环 cross(切线, 固定参考轴) 在切线转向参考轴时会退化（叉积→0，归一化出 NaN/翻转），
	// 这就是原来一棱一棱和折痕的来源；改成把上一环的 right 投到新切平面上连续搬运。
	const posAttr = trail.geo.attributes.position as THREE.BufferAttribute;
	for (let j = 0; j < rings; j++) {
		const i0 = j === 0 ? 0 : j - 1;
		const i1 = j === rings - 1 ? rings - 1 : j + 1;
		_tTan.set(
			_ringX[i1]! - _ringX[i0]!,
			_ringY[i1]! - _ringY[i0]!,
			_ringZ[i1]! - _ringZ[i0]!,
		);
		if (_tTan.lengthSq() > 1e-12) _tTan.normalize(); // 重合点（暂停/折回末端）沿用上一环切线
		if (j === 0) {
			_tRight.crossVectors(_tTan, _tUp);
			if (_tRight.lengthSq() < 1e-8) _tRight.set(1, 0, 0);
			else _tRight.normalize();
		} else {
			_tRight.addScaledVector(_tTan, -_tRight.dot(_tTan)); // 去掉切线分量 → 仍在垂直面内
			if (_tRight.lengthSq() < 1e-8) _tRight.crossVectors(_tTan, _tUp);
			_tRight.normalize();
		}
		_tUp2.crossVectors(_tRight, _tTan).normalize();
		const t = j / (n - 1); // 0=尾，1=头（按原始环数归一，折完掉点不再改变轮廓形状）
		const taper = headR * Math.pow(t, TRAIL_TAPER_POWER);
		// 头几环贴球轮廓：管道半径取「锥度」与「球在该环平面的截面」的较大值，
		// 于是拖尾是从球体表面连续长出来的水滴，而不是比球细一截的管子。
		let d = 0;
		for (let k = j + 1; k < rings; k++) {
			const dx = _ringX[k]! - _ringX[k - 1]!;
			const dy = _ringY[k]! - _ringY[k - 1]!;
			const dz = _ringZ[k]! - _ringZ[k - 1]!;
			d += Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (d > headR) break;
		}
		const Rh = headR * headScale;
		// 折回态下画出来的末端不是球头（头环已经并进主拖尾），不能再按球轮廓撑一个整圆
		// 截面，否则会鼓出一块；那里只让锥度接管，半径自然和主拖尾对齐。
		const sph =
			bend || d >= Rh ? 0 : Math.sqrt(Math.max(0, Rh * Rh - d * d));
		const r = Math.max(0.001, Math.max(sph, taper * headScale));
		for (let k = 0; k < TRAIL_RADIAL_SEGS; k++) {
			const ang = (k / TRAIL_RADIAL_SEGS) * Math.PI * 2;
			const ox = Math.cos(ang) * r;
			const oy = Math.sin(ang) * r;
			posAttr.setXYZ(
				j * TRAIL_RADIAL_SEGS + k,
				_ringX[j]! + _tRight.x * ox + _tUp2.x * oy,
				_ringY[j]! + _tRight.y * ox + _tUp2.y * oy,
				_ringZ[j]! + _tRight.z * ox + _tUp2.z * oy,
			);
		}
	}
	posAttr.needsUpdate = true;
	trail.geo.setDrawRange(0, (rings - 1) * TRAIL_RADIAL_SEGS * 6);
	trail.mesh.visible = true;
}

function clearAllTrailHist(): void {
	for (const bt0 of ballTracks) {
		for (const b of bt0.pool) {
			const hist = b.userData.hist as HistPt[] | undefined;
			const trail = b.userData.trail as TrailObj | undefined;
			if (hist) recycleHist(hist);
			if (trail) trail.mesh.visible = false;
		}
		// 测试台副球：清采样 + 复位分裂状态（跳转/重播/切歌后从零重来）
		const sp = bt0.split;
		if (sp) {
			if (sp.histB.length) recycleHist(sp.histB);
			sp.trailB.mesh.visible = false;
			sp.phase = "normal";
			sp.triggered = false;
			sp.joinT = -1;
			sp.splitBall.visible = false;
			sp.splitBall.userData.hit = false;
		}
	}
}

let prevTrailT: number | null = null;

/** 每帧：记录可见球的历史位置，按当前拖尾时长重画水滴管道（照搬测试页逻辑） */
function updateTrails(time: number, active: boolean, frozen = false): void {
	const sec = (surf.trailPct / 100) * TRAIL_REF_SEC; // 照搬测试页滑块：拖尾时长（0~2s，默认 0.8）
	// 跳转/切歌 → 旧轨迹会横穿画面，直接清空
	if (
		prevTrailT !== null &&
		(time < prevTrailT - 0.05 || time > prevTrailT + 0.4)
	) {
		clearAllTrailHist();
	}
	prevTrailT = time;
	// 照搬测试台"暂停冻结"：paused 时 tick 直接 return，拖尾不采样、不老化、不裁剪，
	// 原地保留（测试台暂停尾巴还在，主项目此前暂停态仍走老化路径 → 尾巴消失）
	if (frozen) return;
	for (const bt0 of ballTracks) {
		// 水滴头部半径 = 该路径的球半径（照搬测试台 headR=BALL_RADIUS*scale；大小逐路径一份）
		const headR = ballRadiusOf(bt0.pathIdx);
		for (let bi = 0; bi < bt0.pool.length; bi++) {
			const ball = bt0.pool[bi]!;
			const hist = ball.userData.hist as HistPt[] | undefined;
			const trail = ball.userData.trail as TrailObj | undefined;
			if (!hist || !trail) continue;
			if (!active || sec <= 0.001) {
				recycleHist(hist);
				trail.mesh.visible = false;
				continue;
			}
			// 采样按绝对时间间隔（见 sampleHist）：帧率变了环距不变，拖尾长度也不会随帧率缩水
			let headScale = 1;
			if (ball.visible) {
				// 段间拖尾继承（照搬测试台"单球连续拖尾"）：新段球第一帧把前一段球的
				// 采样接过来，音符连续时整条路径的拖尾不断节（原来每段独立重长 = 一节一节）
				if (hist.length === 0) {
					// 上游段按节点身份查（prevSeg），不再只看 pool[bi-1]：head 段原先追加在
					// 数组尾，和它自己的第一条 edge 永不相邻，起点线→首音那一段拖尾必断
					const pi = bt0.prevSeg[bi] ?? -1;
					const prev = pi >= 0 ? bt0.pool[pi] : null;
					const ph = prev?.userData.hist as HistPt[] | undefined;
					if (ph && ph.length > 0) {
						const lastP = ph[ph.length - 1]!.p;
						if (lastP.distanceTo(ball.position) < TRAIL_JOIN_MAX_DIST) {
							for (const h of ph) hist.push(h);
							ph.length = 0; // 移交后前段不再渲染自己的拖尾
							const pt = prev!.userData.trail as TrailObj | undefined;
							if (pt) pt.mesh.visible = false;
						}
					}
				}
				sampleHist(hist, time, ball.position);
			} else {
				// 球 hidden：不采样，headR 按剩余寿命整体缩小消失（测试页 pos=null 逻辑）
				if (hist.length > 0) {
					const age = time - hist[hist.length - 1]!.t; // 头部（最新采样）已存在时间（照搬测试台 times[0]=头部）
					const remain = Math.max(0, 1 - age / Math.max(sec, 1e-6));
					headScale = remain;
				}
			}
			// 按时间窗口裁剪旧点
			const cutoff = time - sec;
			while (hist.length > 1 && hist[0]!.t < cutoff) dropOldest(hist);
			const n = hist.length;
			if (n < 2 || headScale < 0.01) {
				// 注意：n<2 时不能清空 hist（测试页同款）——每帧只采到 1 个点，
				// 清了就永远凑不齐 2 个点，拖尾永远画不出来（自我死锁）
				trail.mesh.visible = false;
				continue;
			}
			// 水滴管道渲染（公共函数，测试台副球同款）
			renderTrailPipe(
				trail,
				hist,
				headR,
				headScale,
				surf.trailFollowBall
					? (ball.material as THREE.MeshStandardMaterial).color
					: null,
				surf.trailColor,
			);
		}
	}
	// ── 副球拖尾：分裂期正常采样；会合后不截断，按点龄把管道折回主球路径（方案一） ──
	for (const bt0 of ballTracks) {
		const sp = bt0.split;
		if (!sp) continue;
		const headR = ballRadiusOf(bt0.pathIdx);
		if (!active || sec <= 0.001) {
			if (sp.histB.length) recycleHist(sp.histB);
			sp.trailB.mesh.visible = false;
			sp.joinT = -1;
			continue;
		}
		let bend: TrailBend | undefined;
		if (sp.splitBall.visible) {
			sampleHist(sp.histB, time, sp.splitBall.position);
		} else if (sp.histB.length > 0 && sp.joinT >= 0) {
			// 全部环都已折完（最老一环的点龄也追平了）→ 整条交给主球拖尾，副球管收工
			if (time - sp.joinT >= sp.joinT - sp.histB[0]!.t) {
				recycleHist(sp.histB);
				sp.joinT = -1;
				sp.trailB.mesh.visible = false;
				continue;
			}
			_bend.bt = bt0;
			_bend.joinT = sp.joinT;
			_bend.now = time;
			bend = _bend;
		} else if (sp.histB.length > 0) {
			// 没记录到合并时刻（seek/重建后落入）：退回老逻辑，按剩余寿命整体收缩消失
			const age = time - sp.histB[sp.histB.length - 1]!.t;
			renderTrailPipe(
				sp.trailB,
				sp.histB,
				headR,
				Math.max(0, 1 - age / Math.max(sec, 1e-6)),
				surf.trailFollowBall
					? (sp.splitBall.material as THREE.MeshStandardMaterial).color
					: null,
				surf.trailColor,
			);
			continue;
		}
		// 按时间窗口裁剪旧点
		const cutoff = time - sec;
		while (sp.histB.length > 1 && sp.histB[0]!.t < cutoff) dropOldest(sp.histB);
		renderTrailPipe(
			sp.trailB,
			sp.histB,
			headR,
			1,
			surf.trailFollowBall
				? (sp.splitBall.material as THREE.MeshStandardMaterial).color
				: null,
			surf.trailColor,
			bend,
		);
	}
}

// ── 碰撞粒子（three.quarks）：小球到达符头点亮瞬间的一记迸发 ──
let fxRenderer: BatchedRenderer | null = null;
const fxMat = new THREE.MeshBasicMaterial({
	transparent: true,
	depthWrite: false,
	// 不能用 AdditiveBlending：白底上"白上加白"等于隐形（实测），普通 alpha 混合彩色火花才可见
	blending: THREE.NormalBlending,
});
interface BurstFx {
	ps: ParticleSystem;
	age: number;
}
const activeBursts: BurstFx[] = [];

function initFx(): void {
	fxRenderer = new BatchedRenderer();
	scene.add(fxRenderer);
	// 柔边圆点贴图（粒子精灵）
	const c = document.createElement("canvas");
	c.width = c.height = 64;
	const ctx = c.getContext("2d")!;
	const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
	g.addColorStop(0, "rgba(255,255,255,1)");
	g.addColorStop(0.4, "rgba(255,255,255,0.7)");
	g.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 64, 64);
	fxMat.map = new THREE.CanvasTexture(c);
	fxMat.needsUpdate = true;
}

/** 符头位置迸发一记彩色粒子（世界坐标）。默认关闭（surf.hitFx），
 *  「小球」页的「撞击音符特效」开着才建粒子系统。 */
function spawnNoteHit(pos: THREE.Vector3, color: number): void {
	if (!surf.hitFx) return;
	if (!fxRenderer) initFx();
	const col = new THREE.Color(color);
	const ps = new ParticleSystem({
		autoDestroy: false,
		looping: false,
		duration: 0.9,
		worldSpace: true,
		shape: new PointEmitter(),
		startLife: new IntervalValue(0.25, 0.6),
		startSpeed: new IntervalValue(0.35 * SCORE_SCALE, 1.0 * SCORE_SCALE),
		startSize: new IntervalValue(0.02 * SCORE_SCALE, 0.05 * SCORE_SCALE),
		startColor: new ConstantColor(new Vector4(col.r, col.g, col.b, 1)),
		emissionBursts: [
			{
				time: 0,
				count: new ConstantValue(18),
				cycle: 1,
				interval: 0.01,
				probability: 1,
			},
		],
		renderMode: RenderMode.BillBoard,
		rendererEmitterSettings: {
			startTileIndex: 0,
			uTileCount: 1,
			vTileCount: 1,
		} as never,
		material: fxMat,
		instancingGeometry: new THREE.PlaneGeometry(1, 1),
	});
	ps.emitter.position.copy(pos).multiplyScalar(SCORE_SCALE); // 粒子在 scene 里，不在放大的 world 内
	scene.add(ps.emitter);
	fxRenderer!.addSystem(ps);
	activeBursts.push({ ps, age: 0 });
}

function updateFx(dt: number): void {
	if (!fxRenderer) return;
	fxRenderer.update(dt);
	for (let i = activeBursts.length - 1; i >= 0; i--) {
		const b = activeBursts[i]!;
		b.age += dt;
		if (b.age > 1.5) {
			fxRenderer.deleteSystem(b.ps);
			b.ps.dispose();
			scene.remove(b.ps.emitter);
			activeBursts.splice(i, 1);
		}
	}
}

interface ArcProfile {
	/** 曲线参数序列（单调递增，首 0 尾 1）：轨迹线顶点和球定位共用这一份 */
	us: Float32Array;
	/** 对应的累计弧长（与 us 同长，只有前 n 个有效） */
	slen: Float64Array;
	n: number;
	total: number;
}
interface BallSeg {
	kind: "head" | "edge" | "tail";
	/** 本段的自适应弧采样（惰性构建；jumpHeight/段长变了才重填，数组本身复用） */
	arc?: ArcProfile;
	/** 上次采样时的弧高/段水平距离：变了就重填 */
	arcH?: number;
	arcD?: number;
	/** 本段的轨迹线（与球共用 arc）：改弧高时原地重写顶点 + drawRange */
	line?: THREE.Line;
	lineBuf?: Float32Array;
	ta: number;
	tb: number; // 起止 MIDI 时间
	ax: number;
	ay: number; // 起点（平躺 XZ 平面）
	bx: number;
	by: number; // 终点
	/** 两端对应的 playTarget 下标（-1 = 起点线/终点线这种"不是音符"的端点）。
	 *  有了它，链上的相邻关系可以按节点身份查，不必依赖 segs 数组的顺序。 */
	aNode: number;
	bNode: number;
}
interface LinkTrack {
	color: string;
	segs: BallSeg[]; // 供球走的段：每条真实连线一条 + 无入边头段 + 无出边尾段（按 ta 排序）
	/** segs[i] 的上游段下标（同一 track 里 bNode === segs[i].aNode 的那一段；-1 = 没有）。
	 *  拖尾段间接力用它找"前一颗球"，head→edge、edge→tail 才不会断。 */
	prevSeg: number[];
	edges: [number, number][]; // 该 path 全部连线（含同刻），用于画静态轨迹线
	manualEdges: [number, number][]; // 用户手动连线（第三页手动加的线）
	/** 预计算分支（loadLinkTracks 一次性分析出度>1节点；无分叉时为 undefined） */
	branches?: {
		splitX: number; splitY: number;   // 分裂点位置（世界坐标）
		centerX: number; centerY: number; // 分支目标（中心点，副球分道目的地）
		joinX: number; joinY: number;     // 会合点位置
		mainSeg: number;  // split1 主球 seg 索引
		mainSeg2: number; // split2 主球 seg 索引
	};
}
/** 球轨加载：与第三页 link2d.ballPositionsAt 完全一致——每条连线边对应一个球，
 *  沿两端点时间匀速插值；无入边头端点从起点线飞入、无出边尾端点飞向终点线。
 *  不做 DFS/声线猜测：分叉/合并/琶音完全由连线本身决定。 */
function loadLinkTracks(): LinkTrack[] {
	// 下面多处提前 return（没 links 数据/解析失败），先把跟随窗清掉，
	// 否则上一张谱的窗口会留着把镜头冻在错误的时间段。
	mainWin = null;
	const byId = new Map<string, number>();
	playTargets.forEach((t, i) => {
		if (t.id) byId.set(t.id, i);
	});
	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem("midee.links");
	} catch {
		/* noop */
	}
	if (!raw) {
		console.warn("[球轨] sessionStorage 无 midee.links");
		return [];
	}
	let store: {
		paths?: {
			id?: string;
			color?: string;
			auto?: [string, string][];
			manual?: [string, string][];
			/** 第三页起点/终点竖线上的锚点 Y（用户可拖拽，球从这里起飞/抵达） */
			ayStart?: number[];
			ayEnd?: number[];
		}[];
		removed?: [string, string][];
	};
	try {
		store = JSON.parse(raw);
	} catch {
		console.warn("[球轨] midee.links JSON 解析失败");
		return [];
	}
	const removed = new Set((store.removed ?? []).map((r) => r[0] + "|" + r[1]));
	// ── 全曲最早/最晚发音时刻：head/tail 段的出发·抵达要全局统一（与第三页
	// ballPositionsAt 同一口径），而统一时刻必须在下面按时间排序之前就定好，
	// 否则段序和时刻不一致，「最后一条可见球 = 最新那段」的前提就塌了。
	let firstSound = Infinity;
	let lastSound = -Infinity;
	for (const p of store.paths ?? []) {
		for (const e of [...(p.auto ?? []), ...(p.manual ?? [])]) {
			if (removed.has(e[0] + "|" + e[1])) continue;
			const fi = byId.get(e[0]);
			const ti = byId.get(e[1]);
			if (fi === undefined || ti === undefined) continue;
			if (playTargets[fi]!.time < firstSound) firstSound = playTargets[fi]!.time;
			if (playTargets[ti]!.time > lastSound) lastSound = playTargets[ti]!.time;
		}
	}
	const departT = Number.isFinite(firstSound) ? firstSound - axisLead : -axisLead;
	const arriveT = Number.isFinite(lastSound) ? lastSound + axisTail : axisTail;
	// 第三页起点/终点竖线上每个路径可拖拽的锚点 Y：球从最近的锚点起飞/抵达
	// （与第三页 ballPositionsAt 的 nearestAnchor 同一口径）。没有锚点时退回音符自身 Y。
	const nearestY = (ys: number[] | undefined, y: number): number => {
		if (!ys || !ys.length) return y;
		// 锚点是第三页 SVG 用户 Y，先换算成本页世界 Y 再与符头 Y 比较/取值，
		// 否则头/尾段竖直跨度混入 SVG 量纲（弧高与竖线范围暴涨）。
		const toWorldY = (svgY: number): number =>
			anchorYMap ? anchorYMap.a * svgY + anchorYMap.b : svgY;
		let best = toWorldY(ys[0]!);
		let bd = Infinity;
		for (const a of ys) {
			const aw = toWorldY(a);
			const d = Math.abs(aw - y);
			if (d < bd) {
				bd = d;
				best = aw;
			}
		}
		return best;
	};
	const out: LinkTrack[] = [];
	for (const p of store.paths ?? []) {
		const edges: [number, number][] = [];
		const pushEdge = (e: [string, string]) => {
			if (removed.has(e[0] + "|" + e[1])) return;
			const fi = byId.get(e[0]);
			const ti = byId.get(e[1]);
			if (fi === undefined || ti === undefined) return;
			edges.push([fi, ti]);
		};
		(p.auto ?? []).forEach(pushEdge);
		(p.manual ?? []).forEach(pushEdge);
		if (!edges.length) continue;
		const manualEdges: [number, number][] = [];
		(p.manual ?? []).forEach((e) => {
			if (removed.has(e[0] + "|" + e[1])) return;
			const fi = byId.get(e[0]);
			const ti = byId.get(e[1]);
			if (fi === undefined || ti === undefined) return;
			manualEdges.push([fi, ti]);
		});
		const segs: BallSeg[] = [];
		const nodes = new Set<number>();
		const indeg = new Set<number>();
		const outdeg = new Set<number>();
		for (const [fi, ti] of edges) {
			const A = playTargets[fi]!,
				B = playTargets[ti]!;
			nodes.add(fi);
			nodes.add(ti);
			indeg.add(ti);
			outdeg.add(fi);
			// 真实连线：每条边一个球，沿两端点时间匀速，到达 B 时刻 = B.time
			segs.push({
				kind: "edge",
				ta: A.time,
				tb: B.time,
				ax: A.x,
				ay: A.y,
				bx: B.x,
				by: B.y,
				aNode: fi,
				bNode: ti,
			});
		}
		for (const ni of nodes) {
			const E = playTargets[ni]!;
			// 无入边 = 路径头：所有轨都在「全曲最早发音 − axisLead」同一时刻从
			// 唯一起点线起飞（休止符开头 → 球沿留白一路飘到第一个音，不再半路冒出来），
			// 各自在自己首音时刻落点。手工反向边可能让首音早于全曲最早，夹一下保证 tb≥ta。
			if (!indeg.has(ni)) {
				segs.push({
					kind: "head",
					ta: Math.min(E.time, departT),
					tb: E.time,
					ax: E.x - gapLeadU(),
					ay: nearestY(p.ayStart, E.y),
					bx: E.x,
					by: E.y,
					aNode: -1, // 起点线不是音符
					bNode: ni,
				});
			}
			// 无出边 = 路径尾：所有轨都在「全曲最晚发音 + axisTail」同一时刻抵达
			// 唯一终点线（先结束的轨慢慢飘过去，不是各飞各的）。
			if (!outdeg.has(ni)) {
				segs.push({
					kind: "tail",
					ta: E.time,
					tb: Math.max(E.time, arriveT),
					ax: E.x,
					ay: E.y,
					bx: E.x + gapTailU(),
					by: nearestY(p.ayEnd, E.y),
					aNode: ni,
					bNode: -1, // 终点线不是音符
				});
			}
		}
		// 段按时间排序：pool 与 segs 同序，"最后一条可见球"就等于"时间上最新的那一段"，
		// 光晕/小球点光源的取值不再靠数组顺序碰运气。
		segs.sort((p, q) => p.ta - q.ta || p.tb - q.tb);
		// 上游段：按节点身份查（head 段原先追加在数组尾，和它自己的第一条 edge 永不相邻，
		// 段间拖尾只能靠数组相邻去猜就必然断在这里）
		const byB = new Map<number, number>();
		segs.forEach((s, i) => {
			if (s.bNode >= 0) byB.set(s.bNode, i);
		});
		const prevSeg = segs.map((s) =>
			s.aNode >= 0 ? (byB.get(s.aNode) ?? -1) : -1,
		);
		out.push({ color: p.color ?? "#888", segs, prevSeg, edges, manualEdges });
	}
	// ── 分支预计算（一次性分析出度>1节点，每 track 只取第一个分叉） ──
	for (const t of out) {
		const outdeg1 = new Map<number, number>();
		for (const [fi] of t.edges) outdeg1.set(fi, (outdeg1.get(fi) ?? 0) + 1);
		const segIdx1 = new Map<string, number>();
		// 分支要的是 seg 下标；segs 现在按时间排过序，edges 的下标已经不是它了
		t.segs.forEach((s, i) => {
			if (s.aNode >= 0 && s.bNode >= 0) segIdx1.set(s.aNode + "|" + s.bNode, i);
		});
		for (const [fi] of t.edges) {
			if ((outdeg1.get(fi) ?? 0) <= 1) continue;
			const outs1 = t.edges
				.filter((e) => e[0] === fi)
				.sort((a, b) => playTargets[a[1]]!.time - playTargets[b[1]]!.time);
			const main1 = outs1[0]!;
			const branch1 = outs1[1];
			if (!branch1) continue;
			const p4n1 = main1[1];
			const p4next1 = t.edges
				.filter((e) => e[0] === p4n1)
				.sort((a, b) => playTargets[a[1]]!.time - playTargets[b[1]]!.time)[0];
			if (!p4next1) continue;
			const bp2 = playTargets[branch1[1]]!;
			t.branches = {
				splitX: playTargets[fi]!.x, splitY: playTargets[fi]!.y,
				centerX: bp2.x, centerY: bp2.y,
				joinX: playTargets[p4next1[1]]!.x, joinY: playTargets[p4next1[1]]!.y,
				mainSeg: segIdx1.get(fi + "|" + main1[1]) ?? -1,
				mainSeg2: segIdx1.get(p4n1 + "|" + p4next1[1]) ?? -1,
			};
			break;
		}
	}
	// ── 起点/终点归一（用户规则）：不管各轨首音前有多少休止/空拍，起点线只画
	// 一条 = MIDI 最早发音符头的位置（所有 head 段都从这条线起飞）；终点线同理
	// = 最晚发音符头位置（所有 tail 段都飞向这条线）。多轨/两手首音 x 不同时
	// 不再出现两条起点线。
	const headXs = out.flatMap((t) =>
		t.segs.filter((s) => s.kind === "head").map((s) => s.ax),
	);
	const tailXs = out.flatMap((t) =>
		t.segs.filter((s) => s.kind === "tail").map((s) => s.bx),
	);
	if (headXs.length) {
		const startX = Math.min(...headXs);
		for (const t of out)
			for (const s of t.segs) if (s.kind === "head") s.ax = startX;
	}
	if (tailXs.length) {
		const endX = Math.max(...tailXs);
		for (const t of out)
			for (const s of t.segs) if (s.kind === "tail") s.bx = endX;
	}
	// ── 主路径时间窗（镜头跟随范围）：第一条连线的出发时刻 → 最后一条连线的到达
	// 时刻。起点线→首音、末音→终点线那两段都在窗外，相机不跟（用户要求）。
	let winLo = Infinity;
	let winHi = -Infinity;
	let winX0 = 0;
	for (const t of out) {
		for (const s of t.segs) {
			if (s.kind !== "edge") continue;
			if (s.ta < winLo) {
				winLo = s.ta;
				winX0 = s.ax;
			}
			if (s.tb > winHi) winHi = s.tb;
		}
	}
	// 起点线 x = 最早 head 段起点（已归一为全曲最早发音符头位置）。
	// 镜头进入/首段前应对准这条起点线，而不是首音 x0（首音前有大段休止时
	// x0 会落在谱面中间，正是「进入时在中间」的根因）。
	const startLineX = headXs.length ? Math.min(...headXs) : winX0;
	mainWin = Number.isFinite(winLo)
		? { lo: winLo, hi: winHi, x0: winX0, startX: startLineX }
		: null;
	if (typeof console !== "undefined") {
		console.log(
			`[球轨] ${out.length} 个 track，共 ${out.reduce((n, t) => n + t.segs.length, 0)} 个运动段（每条连线一个球）`,
		);
	}
	return out;
}

// 球/轨迹线在乐谱平面上的基准高度（内部 z；经 world 旋转后贴谱面）。
// 动态 = 符头高度 9/10×rise + 球半径：轻微穿模，更容易触发碰撞特效。
let BALL_Z = 0.02;
function recalcBallBaseZ(): void {
	BALL_Z = surf.rise * 0.9 + ballRadius;
}
recalcBallBaseZ();

/** 抛物线高度（内部 z，world 旋转后 = 世界竖直向上）。
 *  edge：两端点间整弧，u=0.5 最高 H；head：从空中最高点落下 H→0；tail：抛出 0→H。
 *  弧高 H = jumpHeight × 该段水平距离（比例可调）；trajShape=line 时恒为 0。 */
function arcHeightAt(kind: BallSeg["kind"], u: number, dist: number): number {
	const H = arcHeightOf(dist, kind); // 拱高 ∝ 段水平距离（head/tail 可改吃绝对高度）
	return arcZ(kind, u, dist, H);
}
/** 弧段对 parameter u 的 z 导数（dz/du）：edge 4H(1-2u)、head -2H(1-u)、tail 2Hu */
function arcDz(kind: BallSeg["kind"], u: number, H: number): number {
	if (kind === "edge") return 4 * H * (1 - 2 * u);
	if (kind === "head") return -2 * H * (1 - u);
	return 2 * H * u;
}
/**
 * 球弧长参数化（64 段中点积分累计弧长表）：
 * 轨迹 = 水平直线插值 + 竖直抛物线 z(u)，段长 ∫√(dist² + z'(u)²) du。
 * 小球在弧上按「弧长匀速」推进（各落点时刻仍锚定 MIDI 时间不变）。
 * H≈0 / 非抛物线时弧即直线，返回 null（u=p 直接线性推进）。
 * 表按 (trajShape, jumpHeight, kind, dist) 缓存：播放中每帧大量段反复求同一张表，
 * 无缓存的 64×N 次分配会产生明显 GC 压力（偶发掉帧）。
 */
const ARC_MAX_PTS = 128; // 每段预分配上限（细分再密也不会超）
const ARC_REFINE_MAX = 14; // 递归深度硬上限
/** 弧高（世界单位）：edge = jumpHeight × 段水平距离；非抛物线时为 0（直线）。
 *  head/tail（起点/终点线那一段）默认「跟随主路径高度」= 与 edge 同一算法；
 *  关掉跟随就吃面板里的绝对高度（×谱线间距）。 */
function arcHeightOf(dist: number, kind: BallSeg["kind"] = "edge"): number {
	if (surf.trajShape !== "parabola") return 0;
	if (kind === "edge") return Math.max(0, surf.jumpHeight) * dist;
	const follow = kind === "head" ? surf.termLeadHFollow : surf.termTailHFollow;
	if (follow) return Math.max(0, surf.jumpHeight) * dist;
	return Math.max(0, kind === "head" ? surf.termLeadH : surf.termTailH) * staffSpace;
}
/** 曲线上的高度（内部 z）：与 arcHeightAt 同一条曲线，抽出来给细分用 */
function arcZ(kind: BallSeg["kind"], u: number, dist: number, H: number): number {
	if (H <= 0) return 0;
	if (kind === "edge") return 4 * H * u * (1 - u);
	if (kind === "head") return H * (1 - u) * (1 - u);
	return H * u * u;
}
/**
 * 双重自适应采样：先按固定份数粗分，再对「弦中点与曲线的偏离 > 容差」的区间递归劈半。
 * 抛物线曲率在弧顶最大 → 弧顶自动变密、平直段自动变疏，总点数比定长采样少而贴线得多。
 */
function refineArc(
	a: ArcProfile,
	kind: BallSeg["kind"],
	dist: number,
	H: number,
	tol: number,
	u0: number,
	u1: number,
	depth: number,
): void {
	const um = (u0 + u1) * 0.5;
	const dev = Math.abs((arcZ(kind, u0, dist, H) + arcZ(kind, u1, dist, H)) * 0.5 - arcZ(kind, um, dist, H));
	if (dev > tol && depth < ARC_REFINE_MAX && a.n < ARC_MAX_PTS - 1) {
		refineArc(a, kind, dist, H, tol, u0, um, depth + 1);
		refineArc(a, kind, dist, H, tol, um, u1, depth + 1);
		return;
	}
	const i = a.n++;
	a.us[i] = u1;
	const seg = Math.hypot(dist * (u1 - a.us[i - 1]!), Math.abs(arcZ(kind, u1, dist, H) - arcZ(kind, a.us[i - 1]!, dist, H)));
	a.slen[i] = a.slen[i - 1]! + seg;
}
/** 填一条弧（数组复用，只改有效部分） */
function fillArc(a: ArcProfile, kind: BallSeg["kind"], dist: number, H: number): void {
	// 容差 = 2% 个谱线间距：贴着"看不看得出折角"定，而不是拍一个绝对小数
	const tol = Math.max(1e-5, staffSpace * 0.02);
	a.n = 1;
	a.us[0] = 0;
	a.slen[0] = 0;
	const coarse = 8; // 粗分份数：先保证有基本形状，再靠偏差细分
	for (let k = 0; k < coarse; k++) {
		refineArc(a, kind, dist, H, tol, k / coarse, (k + 1) / coarse, 0);
	}
	a.us[a.n - 1] = 1;
	a.total = a.slen[a.n - 1]!;
}
function makeArc(): ArcProfile {
	return { us: new Float32Array(ARC_MAX_PTS), slen: new Float64Array(ARC_MAX_PTS), n: 0, total: 0 };
}
/** 取本段的弧采样：弧高或段长没变就直接复用 */
function segArc(s: BallSeg, dist: number): ArcProfile {
	const H = arcHeightOf(dist, s.kind);
	let a = s.arc;
	if (!a) {
		a = s.arc = makeArc();
		fillArc(a, s.kind, dist, H);
		s.arcH = H;
		s.arcD = dist;
		return a;
	}
	if (s.arcH !== H || s.arcD !== dist) {
		fillArc(a, s.kind, dist, H);
		s.arcH = H;
		s.arcD = dist;
	}
	return a;
}
/** 弧长比例 p∈[0,1] → 曲线参数 u（球沿轨迹线等速走，到达时刻仍 = 锚定的 MIDI 时间） */
function arcParamAt(a: ArcProfile, p: number): number {
	if (a.n < 2 || a.total <= 0) return p;
	const target = Math.min(1, Math.max(0, p)) * a.total;
	let lo = 0;
	let hi = a.n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (a.slen[mid]! < target) lo = mid;
		else hi = mid;
	}
	const l0 = a.slen[lo]!;
	const l1 = a.slen[hi]!;
	const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
	return a.us[lo]! + (a.us[hi]! - a.us[lo]!) * f;
}
/** 分裂分支用的临时弧（距离每帧可能不同，写进一块 scratch，不缓存、不分配） */
const _arcScratch = makeArc();
function arcScratch(kind: BallSeg["kind"], dist: number, p: number): number {
	const H = arcHeightOf(dist);
	if (H <= 0) return p;
	const key = `${kind}|${dist.toFixed(4)}|${H.toFixed(5)}`;
	if (_arcScratchKey !== key) {
		_arcScratchKey = key;
		fillArc(_arcScratch, kind, dist, H);
	}
	return arcParamAt(_arcScratch, p);
}
let _arcScratchKey = "";
/** 一段运动（连线/头/尾）对应的抛物轨迹采样点（轨迹线与球共用同一曲线） */
/** 把本段弧写进 xyz 数组（内部坐标系），返回顶点数——轨迹线和球读的是同一份采样 */
function writeSegPoints(s: BallSeg, out: Float32Array): number {
	const dx = s.bx - s.ax;
	const dy = s.by - s.ay;
	const dist = Math.hypot(dx, dy);
	const a = segArc(s, dist);
	for (let i = 0; i < a.n; i++) {
		const u = a.us[i]!;
		const o = i * 3;
		out[o] = s.ax + dx * u;
		out[o + 1] = s.ay + dy * u;
		out[o + 2] = BALL_Z + arcHeightAt(s.kind, u, dist);
	}
	return a.n;
}
/** Vector3 版：只给导出/关键帧用，渲染热路径一律走 writeSegPoints */
function segPoints(s: BallSeg): THREE.Vector3[] {
	const buf = new Float32Array(ARC_MAX_PTS * 3);
	const n = writeSegPoints(s, buf);
	const out: THREE.Vector3[] = [];
	for (let i = 0; i < n; i++) {
		out.push(new THREE.Vector3(buf[i * 3]!, buf[i * 3 + 1]!, buf[i * 3 + 2]!));
	}
	return out;
}
/** 弧高/凸起变了：原地重写每段轨迹线顶点 + drawRange（不重建几何、不换材质） */
function refreshTrackArcs(): void {
	for (const bt of ballTracks)
		for (const s of bt.segs) {
			if (!s.line || !s.lineBuf) continue;
			const n = writeSegPoints(s, s.lineBuf);
			const attr = s.line.geometry.getAttribute("position") as THREE.BufferAttribute;
			attr.needsUpdate = true;
			s.line.geometry.setDrawRange(0, n);
			s.line.geometry.computeBoundingSphere();
		}
}
/** 起点/终点线距离变了：head/tail 段的线外侧端点依赖 gapLeadU/gapTailU，但整段重建
 *  （initBalls）有 150ms 防抖——拖动期间竖线已实时移动、球却停在旧端点，看起来就是
 *  「谱面残留小球」。这里就地把 head/tail 端点挪到新距离并重写弧线（不动 edge 段、
 *  不重建网格），球下一帧自动跟上；防抖到期仍会整段重建以刷新 mainWin 时间窗。 */
function refreshTermSegs(): void {
	const lead = gapLeadU();
	const tail = gapTailU();
	for (const bt of ballTracks)
		for (const s of bt.segs) {
			if (s.kind === "head") s.ax = s.bx - lead;
			else if (s.kind === "tail") s.bx = s.ax + tail;
			else continue;
			s.arcD = -1; // 段长变了，强制 segArc 重算弧采样
		}
	refreshTrackArcs();
}
type LineStyle = "solid" | "dashed" | "none";
function setLineMaterial(
	line: THREE.Line,
	style: LineStyle,
	color: number,
	opacity: number,
): void {
	const cur = line.material as THREE.LineBasicMaterial &
		THREE.LineDashedMaterial;
	const isDashed =
		(cur as { isLineDashedMaterial?: boolean }).isLineDashedMaterial === true;
	if (style === "dashed" && !isDashed) {
		cur.dispose(); // 反复切换线形时释放旧材质，避免材质泄漏
		line.material = new THREE.LineDashedMaterial({
			color,
			transparent: true,
			opacity,
			dashSize: 0.18,
			gapSize: 0.12,
		});
		line.computeLineDistances();
	} else if (style === "solid" && isDashed) {
		cur.dispose();
		line.material = new THREE.LineBasicMaterial({
			color,
			transparent: true,
			opacity,
		});
	} else {
		cur.color.setHex(color);
		cur.opacity = opacity;
	}
	line.userData.hiddenByStyle = style === "none";
}
/** 按 surf 设置刷新三类辅助线（轨迹线 / 起点线 / 终点线）的线形/透明度/颜色 */
function applyGuideStyles(): void {
	for (const ch of ballGroup.children) {
		const kind = ch.userData.kind as string;
		if (kind !== "trackArc" && kind !== "startLine" && kind !== "endLine")
			continue;
		const line = ch as THREE.Line;
		const g =
			kind === "trackArc"
				? surf.trackLine
				: kind === "startLine"
					? surf.startLine
					: surf.endLine;
		const color =
			kind === "trackArc" && surf.trackLine.followTrack
				? (line.userData.trackColor as number)
				: g.color;
		setLineMaterial(line, g.style, color, g.opacity);
	}
}

// 所有球共享一个几何体（重建时跨实例复用）；球半径由 surf.ballSize 控制
const BALL_GEO_R = 0.035; // 共享球几何的固定半径：尺寸一律靠 scale，避免几何半径和 scale 双重放大
let sharedBallGeo: THREE.SphereGeometry | null = null;
function ensureBallGeo(): THREE.SphereGeometry {
	if (!sharedBallGeo) sharedBallGeo = new THREE.SphereGeometry(BALL_GEO_R, 32, 32); // 照搬测试台分段
	return sharedBallGeo;
}
/** 每轨球光晕（three-glow-mesh）：包裹球的菲涅尔外壳，颜色随轨道色 */
const trackGlows: THREE.Mesh[] = [];
function createTrackGlow(color: number, pathIdx: number): THREE.Mesh {
	const style =
		surf.ballGlowStyle === "halo"
			? { coefficient: 2.2, power: 3.6 }
			: { coefficient: 1.1, power: 2.6 };
	const mesh = createGlowMesh(
		ensureBallGeo().clone(),
		{
			backside: true,
			coefficient: style.coefficient,
			color: `#${color.toString(16).padStart(6, "0")}`,
			size: effNum("ballGlowRange", pathIdx), // 光晕范围逐路径一份
			power: style.power,
		} as never,
	);
	mesh.userData.color = color;
	mesh.visible = surf.ballGlowStyle !== "off";
	mesh.frustumCulled = false;
	scene.add(mesh);
	trackGlows.push(mesh);
	return mesh;
}
/** 球颜色变化 → 重建该轨光晕（光晕颜色烘焙在材质里），返回新光晕 */
function rebuildTrackGlow(bt: BallTrack, color: number): THREE.Mesh {
	scene.remove(bt.glow);
	const i = trackGlows.indexOf(bt.glow);
	if (i >= 0) trackGlows.splice(i, 1);
	bt.glow.geometry.dispose();
	(bt.glow.material as THREE.Material).dispose();
	bt.glow = createTrackGlow(color, bt.pathIdx);
	return bt.glow;
}
/** 球大小改变 → 重建共享球几何 + 弧线落点高度（拖尾宽度每帧按半径刷新） */
function applyBallSize(): void {
	if (sharedBallGeo) {
		sharedBallGeo.dispose();
		sharedBallGeo = null;
	}
	recalcBallBaseZ();
	initBalls();
}

function initBalls(): void {
	const geos = new Set<THREE.BufferGeometry>();
	const mats = new Set<THREE.Material>();
	for (const child of ballGroup.children) {
		const m = child as THREE.Mesh;
		ballGroup.remove(m);
		if (m.geometry) geos.add(m.geometry);
		if (m.material)
			Array.isArray(m.material)
				? m.material.forEach((x) => mats.add(x))
				: mats.add(m.material);
	}
	geos.forEach((g) => {
		if (g !== sharedBallGeo) g.dispose(); // 共享球几何跨重建复用
	});
	mats.forEach((m) => m.dispose());
	followBallRef = null; // 旧球池要没了，别留着引用
	for (const g of trackGlows) {
		scene.remove(g);
		g.geometry.dispose();
		(g.material as THREE.Material).dispose();
	}
	trackGlows.length = 0;
	// 旧路径的点光源摘出场景（Light 无 GPU 资源，摘掉即可被回收）
	for (const bt of ballTracks) world.remove(bt.light);
	disposeTrails();
	ballTracks = [];
	// 重建一开始就清掉旧的主路径时间窗：下面任一 early-return（无符头/无连线）若
	// 留着旧 mainWin，updateFollowFocus 会以为还有主路径却取不到球（followBallX=null）
	// → 镜头原地冻住（用户反馈「改设置后镜头不跟随」）。loadLinkTracks 成功时重新算回。
	mainWin = null;
	if (!playTargets.length) return;

	const linkTracks = loadLinkTracks();
	if (!linkTracks.length) return; // 第四页连线还没保存，不画球
	refreshTieColors(); // loadLinkTracks 已填好 targetPath，连音线点亮色此刻才能跟对路径

	// 一条轨迹线（trackArc）：默认跟随轨道色，关闭“跟随轨道色”后用自定义颜色
	const makeTrackLine = (
		s: BallSeg,
		trackColor: number,
		worldX0: number,
		worldX1: number,
	): THREE.Line => {
		const useColor = surf.trackLine.followTrack
			? trackColor
			: surf.trackLine.color;
		// 一条段的顶点缓冲一次分配到底，之后改弧高只重写有效部分（见 refreshTrackArcs）
		const buf = new Float32Array(ARC_MAX_PTS * 3);
		const n = writeSegPoints(s, buf);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(buf, 3));
		geo.setDrawRange(0, n);
		const line = new THREE.Line(
			geo,
			new THREE.LineBasicMaterial({
				color: useColor,
				transparent: true,
				opacity: surf.trackLine.opacity,
			}),
		);
		s.line = line;
		s.lineBuf = buf;
		line.userData.kind = "trackArc";
		line.userData.trackColor = trackColor;
		line.userData.worldX0 = worldX0; // 视野裁剪：区间重叠判据
		line.userData.worldX1 = worldX1;
		ballGroup.add(line);
		return line;
	};

	// 路径色表必须先于材质建立填好：小球材质在下面循环里就调 pathColorFor，
	// 晚一步就全部落到兜底色（这就是"所有球同一个颜色"的根因）
	surf.pathNames = linkTracks.map((_, i) => t("sp.pathN", { n: i + 1 }));
	surf.pathDefaultColors = linkTracks.map((lt) =>
		parseColorHex(lt.color, LIT_THEMES.Dark![0]!),
	);
	surf.pathColors = linkTracks.map((_, i) => surf.pathColors[i] ?? null);
	// 每个 track（一种颜色）共享一个材质，避免几百份重复资源
	const ballGeo = ensureBallGeo();
	for (let pi = 0; pi < linkTracks.length; pi++) {
	const lt = linkTracks[pi]!;
		const c = parseColorHex(lt.color, 0x4aa3ff);
		// 轨迹线：逐段画抛物轨迹（连线整弧 + 起点落弧 + 终点抛弧），球严格沿它走。
		// 这是“从头到尾连接所有音符的小球轨迹”，与拖尾（运动残影）是两个东西。
		for (const s of lt.segs) {
			makeTrackLine(s, c, Math.min(s.ax, s.bx), Math.max(s.ax, s.bx));
		}
		const mat = makeBallMaterial(
			surf.mat.ball.preset,
			cfgBallColor(c, pi), // 路径自定义色优先
			effNum("brightBall", pi), // 小球亮度逐路径一份
			overridesFor("ball"),
		);
		// 共享几何体半径固定，尺寸一律靠 scale → 每条路径可以各大各的
		const scaleK = ballRadiusOf(pi) / BALL_GEO_R;
		// 每路径一盏点光源：只跟着「本路径」的可见球，不再用全局单灯跨轨挑最近球
		// （那是"灯在两条路径之间来回抖"的根因）。颜色取路径色，白色灯会把白谱面洗白。
		const ballColor = cfgBallColor(c, pi);
		const light = new THREE.PointLight(ballColor, 0, 0, 1);
		light.visible = false;
		world.add(light);
		const bt: BallTrack = {
			segs: lt.segs,
			prevSeg: lt.prevSeg,
			pool: [],
			color: c,
			pathIdx: pi,
			glow: createTrackGlow(ballColor, pi),
			light,
		};
		// 每个运动段一个球（每条连线一个），常驻、仅在其时间窗内可见
		for (const s of lt.segs) {
			const ball = new THREE.Mesh(ballGeo, mat);
			// 共享几何体半径是固定基准，必须在这里就按该路径的半径缩放：
			// 以前只有拖滑轨那条分支会设 scale，于是首屏/重建后球恒为旧基准 0.035，
			// 而拖尾头读的是 ballRadius → 拖尾天生比球小一圈。
			ball.scale.setScalar(scaleK);
			ball.visible = false;
			ball.userData.kind = "ball";
			ball.userData.segKind = s.kind; // 镜头只跟主路径（edge）球，见 followBall()
			ball.layers.enable(BLOOM_LAYER); // 小球是四条发光源之一
			ball.userData.hist = [] as HistPt[];
			ball.userData.trail = makeTrail();
			ball.userData.hit = false; // 到达端点已触发碰撞粒子（一次/段）
			ballGroup.add(ball);
			bt.pool.push(ball);
		}
			// 消费 loadLinkTracks 预计算的分支信息（分离/合并是功能，不随测试台开关）
			if (lt.branches && lt.branches.mainSeg >= 0 && lt.branches.mainSeg2 >= 0) {
				const br = lt.branches;
				const p3 = new THREE.Vector3(br.splitX, br.splitY, BALL_Z);
				const p5 = new THREE.Vector3(br.joinX, br.joinY, BALL_Z);
				const centerPos = new THREE.Vector3(br.centerX, br.centerY, BALL_Z);
				const splitBall = new THREE.Mesh(ballGeo, mat);
				splitBall.scale.setScalar(scaleK);
				splitBall.layers.enable(BLOOM_LAYER);
				splitBall.visible = false;
				splitBall.userData.kind = "splitBall";
				ballGroup.add(splitBall);
				bt.split = {
					phase: "normal",
					triggered: false,
					splitBall,
					trailB: makeTrail(),
					histB: [],
					centerPos,
					splitFrom: new THREE.Vector3(),
					splitTo: new THREE.Vector3(),
					p3,
					p5,
					mainSeg: br.mainSeg,
					mainSeg2: br.mainSeg2,
					joinT: -1,
				};
			}
		ballTracks.push(bt);
	}
	surf.selectedPaths = []; // 默认全选（路径名/色表已在建材质前填好）
	// 音符 → 路径序号（点亮颜色按路径走；没被任何路径串到的音符 = -1，回落音轨色）
	// 路径色注册进 ColorBus：跟随下拉里要能看到「路径1..N」（以前首屏一个都没有）
	publishPathColors();
	targetPath = new Array<number>(playTargets.length).fill(-1);
	targetPaths = Array.from({ length: playTargets.length }, () => [] as number[]);
	linkTracks.forEach((lt, pi) => {
		for (const [a, b] of lt.edges) {
			targetPath[a] = pi;
			targetPath[b] = pi;
			if (!targetPaths[a]!.includes(pi)) targetPaths[a]!.push(pi);
			if (!targetPaths[b]!.includes(pi)) targetPaths[b]!.push(pi);
		}
	});
	// 同音连音线的延续音不发音，link2d 把它从节点里剔了 → 它永远不在任何 edges 上，
	// targetPath=-1，点亮色只能走 channel 兜底，于是"颜色挂到了别的路径"。
	// 按 XML 的 tie 语义把它挂回链首所在路径（点亮仍会多次，只是颜色跟对轨道）。
	{
		const idIdx = new Map<string, number>();
		playTargets.forEach((t, i) => {
			if (t.id) idIdx.set(t.id, i);
		});
		const xml = sessionStorage.getItem("midee.xml") ?? "";
		if (xml && idIdx.size) {
			for (const [contId, headId] of tieSourceById(xml)) {
				const ci = idIdx.get(contId);
				if (ci === undefined || (targetPath[ci] ?? -1) >= 0) continue;
				const hi = idIdx.get(headId);
				if (hi !== undefined && (targetPath[hi] ?? -1) >= 0) {
					targetPath[ci] = targetPath[hi]!;
					const hp = targetPaths[hi] ?? [];
					targetPaths[ci] = [...hp];
				}
			}
		}
	}

	// 起点线 / 终点线：loadLinkTracks 已把所有 head/tail 段归一到 MIDI 最早/最晚
	// 发音符头位置（用户规则：不管前面空多少休止，只画一条起点/终点线），这里
	// 的集合因此只会各含一个 x。
	let minY = Infinity,
		maxY = -Infinity;
	for (const tg of playTargets) {
		minY = Math.min(minY, tg.y);
		maxY = Math.max(maxY, tg.y);
	}
	// 起点/终点锚点（第三页可拖拽）可能落在符头范围之外：竖线必须覆盖到锚点，
	// 否则球会飞向一根"够不着"的线。
	for (const lt of linkTracks) {
		for (const s of lt.segs) {
			if (s.kind === "head") {
				minY = Math.min(minY, s.ay);
				maxY = Math.max(maxY, s.ay);
			} else if (s.kind === "tail") {
				minY = Math.min(minY, s.by);
				maxY = Math.max(maxY, s.by);
			}
		}
	}
	const startXs = new Set<number>();
	const endXs = new Set<number>();
	for (const lt of linkTracks) {
		for (const s of lt.segs) {
			if (s.kind === "head") startXs.add(s.ax);
			else if (s.kind === "tail") endXs.add(s.bx);
		}
	}
	if (Number.isFinite(minY)) {
		// 上下留白按谱线间距取相对值：原来固定下限 1.2（≈25 个谱线间距）在小谱子上
		// 会把竖线撑到符头簇的数倍高，不同宽高/多谱表的谱各自失真。改用 staffSpace 基准统一。
		const termPad = Math.max(staffSpace * 3, (maxY - minY) * 0.25);
		const makeTermLine = (kind: "startLine" | "endLine", x: number): void => {
			const g = kind === "startLine" ? surf.startLine : surf.endLine;
			const line = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([
					new THREE.Vector3(x, minY - termPad, BALL_Z),
					new THREE.Vector3(x, maxY + termPad, BALL_Z),
				]),
				new THREE.LineBasicMaterial({
					color: g.color,
					transparent: true,
					opacity: g.opacity,
				}),
			);
			line.userData.kind = kind;
			line.userData.worldX0 = x; // 竖线：区间=自身位置
			line.userData.worldX1 = x;
			ballGroup.add(line);
		};
		for (const x of startXs) makeTermLine("startLine", x);
		for (const x of endXs) makeTermLine("endLine", x);
	}

	applyGuideStyles();
}

/** 播放进度 → 球严格沿连线做抛物线运动，与第三页 link2d 时间映射一一对应：
 *  ① 同 path = 同轨；② 每段到达终点时刻 = 该音 MIDI time；③ 轨迹 = 两端点直线插值 +
 *  竖直抛物线弧（轨迹线同曲线），球按「弧长匀速」推进（arcU：时间比例→弧长比例→u），
 *  直线/零弧高时退化为两点直线匀速。
 *  每条连线一个球：和弦并行、琶音错峰则各球在自己的终点音时刻到达，汇入端点自然重合。
 *  播放前（t<=0）头段球悬在起点线上空（下落半弧最高点）；结束后尾段球抛向终点线。 */
const _hitPos = new THREE.Vector3(); // 粒子迸发位置（spawnNoteHit 内部会复制）
function updateBalls(t: number): void {
	for (const bt of ballTracks) {
		for (let i = 0; i < bt.segs.length; i++) {
			const s = bt.segs[i]!;
			const b = bt.pool[i];
			if (!b) continue;
			const dist = Math.hypot(s.bx - s.ax, s.by - s.ay);
			// 负段（lead-in 留白）：head 段 ta=E.time-axisLead 可为负 → 播放头
			// 从 -axisLead 起走时球正好从起点线上空落下，0 时刻落到首个符头。
			// （旧版 t<=0 特例会把球冻在弧顶——与留白下落动画冲突，已删。）
			let active: boolean;
			if (s.kind === "head")
				active = t >= s.ta - 1e-6 && t <= s.tb + 1e-6; // [ta,首音] 从起点线上空落下
			// tail 以前只写下界 → 飞越终点线后那颗球永远停在终点线上不消失；补上上界
			else if (s.kind === "tail")
				active = t >= s.ta - 1e-6 && t <= s.tb + 1e-6;
			else active = t >= s.ta - 1e-6 && t <= s.tb + 1e-6;
			if (!active) {
				// 入场球在「画面秒还没走到入场点」时不能凭空消失：整体音画对齐往回挪
				// 之后，起播若干秒内 t < ta 而播放头仍在音乐开始之前，这段静默期就该
				// 看见球停在起点线上（否则到 ta 那一帧球会从空气里冒出来）。
				// 只看播放头是否还没进音乐，中途 seek 进来不会在起点线上留一颗残球。
				if (s.kind === "head" && (player?.currentTime ?? 0) <= 0) {
					b.visible = true;
					b.position.set(s.ax, s.ay, BALL_Z + arcHeightAt(s.kind, 0, dist));
					continue;
				}
				b.visible = false;
				continue;
			}
			const span = Math.max(1e-6, s.tb - s.ta);
			// 水平匀速：曲线参数 u 直接 = 时间比例 par（球 x 随时间线性推进）。
			// 原来用 arcParamAt 做「弧长匀速」：抛物线两端陡峭处水平慢、弧顶水平快，
			// 球视觉上提前贴近终点符头，而点亮按 MIDI 时间累计 → 「发光和小球位置不符」。
			// 改水平匀速后球 x ∝ 时间，与按时间累计的点亮前沿对齐；竖直仍是抛物线
			// （arcHeightAt，弧顶自然减速＝抛体感），到达终点时刻仍 = 锚定的 MIDI 时间。
			const par = Math.min(1, Math.max(0, (t - s.ta) / span));
			const u = par;
			b.visible = true;
			b.position.set(
				s.ax + (s.bx - s.ax) * u,
				s.ay + (s.by - s.ay) * u,
				BALL_Z + arcHeightAt(s.kind, u, dist),
			);
			// 到达端点（点亮该符头的瞬间）→ 触发一次碰撞粒子迸发（three.quarks）。
			// 段的终点 = 下一颗球的起点，而帧点几乎不可能正好踩中 tb（低帧率下更是
			// 如此，实测等于把特效永久关死），所以挂在"本段球第一帧激活、且窗口起点
			// 就在眼前"上：head 段的起点是起点线不是音符，跳过；第一帧离 ta 超过
			// 0.5s（中途 seek 进段）不补发。
			if (!b.userData.hit && s.kind !== "head" && t - s.ta < 0.5) {
				b.userData.hit = true;
				// 同刻并行的和弦球只放第一颗（一拍内不重复迸发）
				if (t - (bt.lastBurstT ?? -9) > 0.12) {
					bt.lastBurstT = t;
					_hitPos.set(
						s.bx,
						BALL_Z + arcHeightAt(s.kind, 1, dist),
						-s.by,
					);
					spawnNoteHit(_hitPos, cfgBallColor(bt.color, bt.pathIdx));
				}
			}
		}
	}
	// ── 分裂分支（normal→split1→split2：落点一拆二、中心会合） ──
	for (const bt of ballTracks) {
		const sp = bt.split;
		if (!sp) continue;
		const s3 = bt.segs[sp.mainSeg];
		const s4 = bt.segs[sp.mainSeg2];
		if (!s3 || !s4) continue;
		const span3 = Math.max(1e-6, s3.tb - s3.ta);
		const span4 = Math.max(1e-6, s4.tb - s4.ta);
		// normal → split1：主球进入主链 p3→p4 段（= 落点3 到达瞬间）弹出副球
		if (sp.phase === "normal" && t >= s3.ta - 1e-6 && !sp.triggered) {
			sp.triggered = true;
			sp.phase = "split1";
			sp.splitBall.userData.hit = false;
			sp.splitBall.position.copy(sp.p3);
			sp.splitBall.position.z = BALL_Z;
			sp.splitBall.visible = true;
			recycleHist(sp.histB);
			sp.joinT = -1; // 新一轮分裂：拖尾折回计时清零
			sp.trailB.mesh.visible = false;
		}
		if (sp.phase === "split1") {
			// 副球沿 p3→o（中心）同相位抛物线；主球走 s3（主循环已 set 位置）
			const par = Math.min(1, Math.max(0, (t - s3.ta) / span3));
			const dC = sp.centerPos.distanceTo(sp.p3);
			const du = arcScratch("edge", dC, par);
			sp.splitBall.position.set(
				sp.p3.x + (sp.centerPos.x - sp.p3.x) * du,
				sp.p3.y + (sp.centerPos.y - sp.p3.y) * du,
				BALL_Z + arcHeightAt("edge", du, dC),
			);
			if (par >= 1 - 1e-6 && !sp.splitBall.userData.hit) {
				sp.splitBall.userData.hit = true;
				sp.phase = "split2";
				sp.splitFrom.copy(sp.centerPos);
				sp.splitTo.copy(sp.p5);
				sp.splitBall.position.copy(sp.centerPos);
				sp.splitBall.position.z = BALL_Z;
			}
		} else if (sp.phase === "split2") {
			// 副球沿 o→p5 同相位抛物线；主球走 s4（主循环已 set 位置），两球同时落 p5 合并
			const par = Math.min(1, Math.max(0, (t - s4.ta) / span4));
			const dC = sp.splitTo.distanceTo(sp.splitFrom);
			const du = arcScratch("edge", dC, par);
			sp.splitBall.position.set(
				sp.splitFrom.x + (sp.splitTo.x - sp.splitFrom.x) * du,
				sp.splitFrom.y + (sp.splitTo.y - sp.splitFrom.y) * du,
				BALL_Z + arcHeightAt("edge", du, dC),
			);
			if (par >= 1 - 1e-6 && !sp.splitBall.userData.hit) {
				sp.splitBall.userData.hit = true;
				// 合并：副球不再画自己那颗球，拖尾交给 bend 按点龄折回主路径（不再硬截断）
				sp.joinT = t;
				sp.splitBall.visible = false;
				sp.phase = "normal";
			}
		}
	}
	// 视野裁剪：球按当前 x（点），三类辅助线按 x 区间重叠（长弧线按中心会被误杀）
	const r = Math.max(0.5, surf.viewRadius);
	const lo = focusX - r;
	const hi = focusX + r;
	for (const bt of ballTracks) {
		for (const b of bt.pool) {
			if (b.visible && (b.position.x < lo || b.position.x > hi))
				b.visible = false;
		}
	}
	for (const ch of ballGroup.children) {
		const kind = ch.userData.kind as string;
		if (kind !== "trackArc" && kind !== "startLine" && kind !== "endLine")
			continue;
		if (ch.userData.hiddenByStyle) {
			ch.visible = false;
			continue;
		}
		const x0 =
			(ch.userData.worldX0 as number | undefined) ??
			(ch.userData.worldX as number | undefined) ??
			ch.position.x;
		const x1 = (ch.userData.worldX1 as number | undefined) ?? x0;
		ch.visible = x1 >= lo && x0 <= hi;
	}
	// 该轨最前（时间上最新开始的那条连线）可见球：光晕和小球点光源都跟它
	for (const bt of ballTracks) {
		let last: THREE.Mesh | null = null;
		for (const b of bt.pool) if (b.visible) last = b;
		const g = bt.glow;
		if (surf.ballGlowStyle === "off" || !last) {
			g.visible = false;
		} else {
			// 内部 (x,y,z) → 世界 (x, z, −y)：z 正向 = 凸起高度方向
			g.position.set(last.position.x, last.position.z, -last.position.y);
			g.visible = true;
		}
		// 小球点光源（照亮强度）：本路径此刻没有可见球、或强度为 0 就关灯。
		// 挂在 world 里 → 位置直接用球的内部坐标；照程按世界单位算所以要乘 SCORE_SCALE。
		const lamp = bt.light;
		const gain = effNum("ballLightIntensity", bt.pathIdx);
		if (!last || gain <= 0) {
			lamp.visible = false;
		} else {
			lamp.visible = true;
			lamp.distance = staffSpace * SCORE_SCALE * 12; // ≈ 12 个谱线间距
			lamp.intensity = gain * 40;
			lamp.position.copy(last.position);
		}
	}
}

/**
 * 进度显示轴（与第三页同构且同源）：leadIn(axisLead=第三页 offStart) + 音乐(dur)
 * + tail(axisTail=第三页 offEnd)。两页同一 MusicTime（0..dur 播放头），首尾留白
 * 是同一口径、同一份数据的显示偏移——「单 MusicTime 轴」：进度条同百分比处
 * 两页指向同一音乐时刻。
 */
function dispTotal(): number {
	return (player?.duration ?? 0) + axisLead + axisTail;
}
function toDisp(t: number): number {
	// 负段（lead-in 留白）：显示从 0 推进到 axisLead（播放头 -axisLead..0 → 0..axisLead）
	return axisLead + Math.max(-axisLead, Math.min(t, player?.duration ?? 0));
}
/**
 * 播放时间 → 镜头焦点 x：按进度条（含首尾留白）比例从头到尾线性匀速（用户要求镜头
 * 不跟随小球——小球仍沿连线按 MIDI 时间运动，镜头只吃进度比例，无任何校正逻辑）。
 */
/** 黏住的跟随球：只在它消失时才换球，避免多轨同时可见时逐帧在两颗粒子间来回跳 */
let followBallRef: THREE.Mesh | null = null;
function followBall(): THREE.Mesh | null {
	// 只跟主路径球：起点线→首音（head）、末音→终点线（tail）那两段不接管镜头
	if (followBallRef && followBallRef.visible && followBallRef.userData.segKind === "edge")
		return followBallRef;
	let best: THREE.Mesh | null = null;
	for (const bt of ballTracks)
		for (const b of bt.pool) {
			if (!b.visible || b.userData.segKind !== "edge") continue;
			if (
				!best ||
				Math.abs(b.position.x - focusX) < Math.abs(best.position.x - focusX)
			)
				best = b;
		}
	followBallRef = best;
	return best;
}
function followBallX(): number | null {
	const b = followBall();
	return b ? b.position.x : null;
}
/** 时间轴推进 + 居中容忍度：容忍度内完全不动；超出后按「超出量」平滑拉回（不是按全误差，
 *  否则一出容忍度就猛冲，看起来就是一抖一抖的） */
function followToward(want: number, dt: number): void {
	if (camCenterTol <= 0) {
		setFocusX(want, true);
		return;
	}
	const err = want - focusX;
	const excess = Math.abs(err) - camCenterTol; // 容忍度外多少：连续量，没有硬开关
	if (excess <= 0) return;
	const k = 1 - Math.exp(-dt * 6); // 帧率无关的平滑系数
	setFocusX(focusX + Math.sign(err) * excess * k, true);
}
function updateFollowFocus(linearX: number, rawDt: number, t = 0): void {
	const dt = Math.min(rawDt, 1 / 30); // 掉帧时别一帧跨到位
	if (mainWin) {
		// 镜头只跟主路径（用户要求）：起点线→首音那段待命在首音处，最后一个音之后
		// 停止跟随、冻在原地；段间空隙（没有球在飞）也原地不动——跳回线性位置就是猛抖一下。
		if (t < mainWin.lo) {
			// 首音前的留白段：镜头待在谱面开头（x=0），不拿起点线 startX 当焦点
			// （首音前有大段休止时 startX 会落在谱面中间）
			setFocusX(0, true);
			return;
		}
		if (t > mainWin.hi) return;
		const bx = followBallX();
		if (bx !== null) followToward(bx + camCenterOffset, dt);
		return;
	}
	// 一张连线都没有（没进过第三页/路径全删）：退回按进度线性平移
	const bx = followBallX();
	if (bx === null) {
		setFocusX(linearX, true);
		return;
	}
	followToward(bx + camCenterOffset, dt);
}
function focusXAtTime(t: number, dur: number): number {
	// 时长未知（播放器 load 中途 stop() 会回传 onProgress(0)，此刻 duration 还是 0）：
	// 若按 total=axisLead+axisTail 算，p=axisLead/(axisLead+axisTail)=0.5 会把镜头甩到
	// 谱面正中（用户反馈「刚进页面聚焦中间」）。无音乐时长时焦点应在开头。
	if (dur <= 0) return 0;
	const total = dur + axisLead + axisTail;
	const p = (axisLead + Math.max(0, Math.min(t, dur))) / total;
	return Math.min(1, Math.max(0, p)) * trackLength;
}
/** 镜头焦点 x → 播放时间（纯线性逆映射：与 focusXAtTime 互逆，手动拖相机即 seek） */
function xToTime(x: number): number | null {
	const dur = player?.duration ?? 0;
	const total = dur + axisLead + axisTail;
	if (trackLength <= 0 || total <= 0) return null;
	const disp = (Math.max(0, Math.min(x, trackLength)) / trackLength) * total;
	return Math.max(0, Math.min(dur, disp - axisLead));
}

// ── 3D 构建（照搬 3dtest：ribbon / 轮廓挤出 / 文字薄片） ──────
// 谱面线/面材质：跟随 surf.mat.score 的 PBR 质感（makeInkMaterial）；
// 点亮音符单独建材质（见 buildAll 里 notehead 分支）。
let inkMat: THREE.MeshStandardMaterial = makeInkMaterial(surf.mat.score.preset);
// 默认无光源：谱线/符号靠白色自发光呈现（scoreGlow=0 时等效关闭）；
// 未点亮符头的材质在 resetLit/setLitProgress 里拷贝 inkMat 的自发光，同样生效
inkMat.emissive.setHex(0xffffff);
inkMat.emissiveIntensity = surf.scoreGlow;
const fillFlip = -1; // 谱号 fill 方向：Three y 向上，字形 d 为设计坐标（y 向上）→ 渲染时需翻转对齐 bbox（SVG y 向下）

function mergeSafe(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
	// 简易 merge：全部转非索引（index 兼容问题兜底）
	const converted = geos.map((g) => {
		if (g.index) {
			const non = g.toNonIndexed();
			g.dispose();
			return non;
		}
		return g;
	});
	const merged = new THREE.BufferGeometry();
	const pos: number[] = [];
	for (const g of converted) {
		const p = g.getAttribute("position");
		for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
	}
	merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	merged.computeVertexNormals();
	return merged;
}

// 单段实心条：扁管（上下/左右四壁）+ 首尾端面封口
function ribbonSegment(
	pts: { x: number; y: number }[],
	strokeW: number,
	r: number,
): THREE.BufferGeometry {
	const n = pts.length;
	const half = Math.max(0.0002, strokeW / 2);
	const depth = Math.max(0.001, r);
	const norms: { x: number; y: number }[] = [];
	for (let i = 0; i < n; i++) {
		const a = pts[Math.max(0, i - 1)]!;
		const b = pts[Math.min(n - 1, i + 1)]!;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy) || 1e-9;
		norms.push({ x: -dy / len, y: dx / len });
	}
	const pos: number[] = [];
	for (let i = 0; i < n; i++) {
		const p = pts[i]!;
		const nm = norms[i]!;
		pos.push(
			p.x + nm.x * half,
			p.y + nm.y * half,
			depth,
			p.x - nm.x * half,
			p.y - nm.y * half,
			depth,
			p.x + nm.x * half,
			p.y + nm.y * half,
			0,
			p.x - nm.x * half,
			p.y - nm.y * half,
			0,
		);
	}
	const idx: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		const a = i * 4,
			b = (i + 1) * 4;
		idx.push(a, a + 1, b + 1, a, b + 1, b);
		idx.push(a + 2, b + 2, b + 3, a + 2, b + 3, a + 3);
		idx.push(a, a + 2, b + 2, a, b + 2, b);
		idx.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3);
	}
	// 端面封口（首尾两端），挤出成有厚度的实心条
	const last = (n - 1) * 4;
	idx.push(0, 1, 3, 0, 3, 2); // 首端
	idx.push(last, last + 2, last + 3, last, last + 3, last + 1); // 尾端
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

function makeRibbon(
	pts: { x: number; y: number }[],
	strokeW: number,
	r: number,
): THREE.BufferGeometry {
	// 按方向突变（折返 >120°）断开：往返曲线（如大括号去程+回程）在折返点 ribbon 自交成乱线网格
	const segs: { x: number; y: number }[][] = [];
	let cur: { x: number; y: number }[] = [pts[0]!];
	for (let i = 1; i < pts.length - 1; i++) {
		const a = pts[i - 1]!,
			b = pts[i]!,
			c = pts[i + 1]!;
		const v1x = b.x - a.x,
			v1y = b.y - a.y;
		const v2x = c.x - b.x,
			v2y = c.y - b.y;
		const l1 = Math.hypot(v1x, v1y) || 1e-9;
		const l2 = Math.hypot(v2x, v2y) || 1e-9;
		const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
		cur.push(b);
		if (cos < -0.5) {
			segs.push(cur);
			cur = [b];
		}
	}
	cur.push(pts[pts.length - 1]!);
	segs.push(cur);
	const geos = segs
		.filter((s) => s.length >= 2)
		.map((s) => ribbonSegment(s, strokeW, r));
	if (!geos.length) return new THREE.BufferGeometry();
	const g = geos.length === 1 ? geos[0]! : mergeSafe(geos)!;
	g.computeBoundingBox();
	const bb = g.boundingBox!;
	g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);
	return g;
}

const fillCache = new Map<string, THREE.BufferGeometry>();
function makeFill(el: MappedEl, r: number): THREE.BufferGeometry {
	// 键含凸起深度 r：符头 1.1× 与同 bbox 其他 fill 的缓存互不串用；textPath 区分两种判孔管线
	const key = `${el.tag}:${el.textPath ? "t" : "f"}:${el.sx.toFixed(1)}:${el.sy.toFixed(1)}:${el.sw.toFixed(1)}:${el.sh.toFixed(1)}:${r.toFixed(4)}`;
	const cached = fillCache.get(key);
	if (cached) return cached;
	const shapes = el.shapes ?? [];
	if (!shapes.length) return new THREE.PlaneGeometry(el.w, el.h);
	const depth = Math.max(0.001, r);
	// 整体 bbox（所有子路径本地坐标，保留相对布局）
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (const shape of shapes) {
		for (const p of shape.getPoints()) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
		}
	}
	const sw2 = Math.max(1e-6, maxX - minX);
	const sh2 = Math.max(1e-6, maxY - minY);
	const geos: THREE.BufferGeometry[] = [];
	if (el.textPath) {
		// 文字 path：parseD 已按 nonzero 绕向 + 点在多边形内把真孔挂到 shape.holes，
		// 每个 Shape 即一个外环，直接逐 Shape 挤出。独立笔画（多个外环）几何重叠即视觉
		// 并集，同深度同材质无 z-fighting。不能用 bbox 判孔——那会把中文"田"里被外框
		// bbox 包住的横/竖笔画误当孔，填死镂空格子。
		for (const sh0 of shapes) {
			try {
				geos.push(
					new THREE.ExtrudeGeometry(sh0.clone(), { depth, bevelEnabled: false }),
				);
			} catch {
				// 坏 Shape 跳过
			}
		}
	} else {
		// Verovio 原始 path（谱号/升降号/拍号等 SMuFL）：原 bbox 判孔管线——
		// 不被任何段 bbox 包含的 = 外轮廓；被包含的 = 孔（反转挂到外轮廓）。
		const bboxOf = (
			shape: THREE.Shape,
		): { x: number; y: number; w: number; h: number } => {
			let mnx = Infinity,
				mxx = -Infinity,
				mny = Infinity,
				mxy = -Infinity;
			for (const p of shape.getPoints()) {
				mnx = Math.min(mnx, p.x);
				mxx = Math.max(mxx, p.x);
				mny = Math.min(mny, p.y);
				mxy = Math.max(mxy, p.y);
			}
			return { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny };
		};
		const contains = (
			a: { x: number; y: number; w: number; h: number },
			b: { x: number; y: number; w: number; h: number },
		): boolean =>
			a.x <= b.x &&
			a.y <= b.y &&
			a.x + a.w >= b.x + b.w &&
			a.y + a.h >= b.y + b.h;
		const boxes = shapes.map(bboxOf);
		const groups: { outer: THREE.Shape; holes: THREE.Shape[] }[] = [];
		for (let i = 0; i < shapes.length; i++) {
			let isHole = false;
			for (let j = 0; j < shapes.length; j++) {
				if (i !== j && contains(boxes[j]!, boxes[i]!)) {
					isHole = true;
					break;
				}
			}
			if (isHole) continue;
			const holes = shapes.filter(
				(_, k) => k !== i && contains(boxes[i]!, boxes[k]!),
			);
			groups.push({ outer: shapes[i]!, holes });
		}
		for (const g0 of groups) {
			try {
				const s = g0.outer.clone();
				for (const h of g0.holes) {
					const pts = h.getPoints();
					if (pts.length < 3) continue;
					const path = new THREE.Path();
					path.moveTo(pts[0]!.x, pts[0]!.y);
					for (let k = pts.length - 1; k > 0; k--)
						path.lineTo(pts[k]!.x, pts[k]!.y);
					path.closePath();
					s.holes.push(path);
				}
				geos.push(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false }));
			} catch {
				// 坏组跳过
			}
		}
	}
	if (!geos.length) return new THREE.PlaneGeometry(el.w, el.h);
	const geo = (geos.length === 1 ? geos[0] : mergeSafe(geos))!;
	// 整体居中 → 缩放（shape 已应用 path 自身 transform，与 SVG bbox 同坐标系 → 正 scaleY 用 fillFlip 翻转）
	geo.computeBoundingBox();
	const bb0 = geo.boundingBox!;
	geo.translate(-(bb0.min.x + bb0.max.x) / 2, -(bb0.min.y + bb0.max.y) / 2, 0);
	geo.scale(el.w / sw2, (el.h / sh2) * fillFlip, 1);
	// 缩放后再居中（负 scaleY 后中心仍可能偏移）
	geo.computeBoundingBox();
	const bb = geo.boundingBox!;
	geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);
	fillCache.set(key, geo);
	return geo;
}

// ── 文字矢量挤出：opentype.js 解析 Liberation 字体轮廓 ──────────
// 指法/和弦名在 Verovio SVG 里是 <text>（浏览器字体渲染，非矢量）——之前只能
// 贴图字块；现在把字体轮廓转成 THREE.Shape 挤出，与音符同材质同厚度。
// （拍号/三连音数字本就是 SMuFL 矢量字形 <use>，无需此处理。）
// CJK 等 Liberation 没有的字形 → 轮廓为空 → 回退贴图字块。
// 字体取 public/fonts/Liberation.ttf（构建期已随包发布，无需运行时解压 woff2）。
// 字体三件套（用户字体方案）：Liberation = 拉丁文本；Leland Text（VexFlow 团队打包的
// MuseScore 字体，43KB）= SMuFL 音乐字形（Bravura tspan 的私有区字符）；
// Noto Sans SC 7000 子集（pyftsubset 本地裁剪，ttf 2.3MB）= 中文兜底。
let textFont: import("opentype.js").Font | null = null;
let musicFont: import("opentype.js").Font | null = null;
let cjkFont: import("opentype.js").Font | null = null;
let fontsTried = false;
async function loadOtf(url: string): Promise<import("opentype.js").Font | null> {
	try {
		const resp = await fetch(new URL(url, document.baseURI).href)
		if (!resp.ok) return null
		const ot = await import("opentype.js")
		return ot.parse(await resp.arrayBuffer())
	} catch {
		return null
	}
}
async function ensureTextFont(): Promise<boolean> {
	if (textFont || fontsTried) return !!textFont
	fontsTried = true
	const [latin, music, cjk] = await Promise.all([
		loadOtf("../../fonts/Liberation.ttf"),
		loadOtf("../../fonts/leland.otf"),
		loadOtf("../../fonts/noto-7000.ttf"),
	])
	textFont = latin
	musicFont = music
	cjkFont = cjk
	if (!latin) console.warn("[3D] Liberation 加载失败，文字转 path 退回贴图字块")
	return !!latin
}

/** 字符 → 字体选择：SMuFL → Leland；文本类（歌词/标题/标注/和弦名）统一无衬线
 * 优先 NotoSC 拉丁（Noto Sans 设计），Liberation（衬线）仅作 Noto 缺字形时的兜底 */
function fontForChar(ch: string): import("opentype.js").Font | null {
	if (/[\uE000-\uF8FF]/.test(ch)) return musicFont
	if (ch.trim() === "") return null
	if (cjkFont) {
		const g2 = cjkFont.charToGlyph(ch)
		if (g2 && g2.index !== 0) return cjkFont
	}
	if (textFont) {
		const g = textFont.charToGlyph(ch)
		if (g && g.index !== 0) return textFont
	}
	return null
}
function textToShapeGroups(
	txt: string,
): { outer: THREE.Vector2[]; holes: THREE.Vector2[][] }[] | null {
	if (!textFont || !txt) return null;
	// 剔除换行与缺字形字符：MuseScore 导出的 harm/reh 文本含换行+尾部空白，
	// 换行符经 charToGlyph 落到 .notdef 方框字形，与字母一起挤出 = 又大又长的
	// 方框（单字母和弦名"玄学"的根因）。.notdef 的 glyph.index === 0。
	const clean = [...txt]
		.filter((ch) => {
			if (ch === "\n" || ch === "\r") return false;
			const g = textFont!.charToGlyph(ch);
			return !!g && g.index !== 0;
		})
		.join("")
		.trim();
	if (!clean) return null;
	const path = textFont.getPath(clean, 0, 0, 100); // 100upm 采样精度
	if (!path.commands.length) return null;
	const contours: THREE.Vector2[][] = [];
	let cur: THREE.Vector2[] | null = null;
	const pushPt = (x: number, y: number): void => {
		if (!cur) cur = [];
		const last = cur[cur.length - 1];
		if (!last || last.distanceTo(new THREE.Vector2(x, y)) > 1e-4)
			cur.push(new THREE.Vector2(x, y));
	};
	for (const c of path.commands) {
		switch (c.type) {
			case "M":
				if (cur && cur.length > 1) contours.push(cur);
				cur = [];
				pushPt(c.x!, c.y!);
				break;
			case "L":
				pushPt(c.x!, c.y!);
				break;
			case "C": {
				const p0 = cur![cur!.length - 1]!;
				for (let i = 1; i <= 14; i++) {
					const t = i / 14,
						mt = 1 - t;
					pushPt(
						mt * mt * mt * p0.x +
							3 * mt * mt * t * c.x1! +
							3 * mt * t * t * c.x2! +
							t * t * t * c.x!,
						mt * mt * mt * p0.y +
							3 * mt * mt * t * c.y1! +
							3 * mt * t * t * c.y2! +
							t * t * t * c.y!,
					);
				}
				break;
			}
			case "Q": {
				const p0 = cur![cur!.length - 1]!;
				for (let i = 1; i <= 12; i++) {
					const t = i / 12,
						mt = 1 - t;
					pushPt(
						mt * mt * p0.x + 2 * mt * t * c.x1! + t * t * c.x!,
						mt * mt * p0.y + 2 * mt * t * c.y1! + t * t * c.y!,
					);
				}
				break;
			}
			case "Z":
				break;
		}
	}
	if (cur && cur.length > 1) contours.push(cur);
	const valid = contours.filter((c) => c.length >= 3);
	if (!valid.length) return null;
	// 分类：bbox 被其他轮廓包含 = 洞；否则 = 外轮廓（挂到最小的包含者）
	const boxes = valid.map((pts) => {
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		for (const p of pts) {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x);
			y1 = Math.max(y1, p.y);
		}
		return { x0, y0, x1, y1 };
	});
	const contains = (
		a: ReturnType<() => { x0: number; y0: number; x1: number; y1: number }>,
		b: { x0: number; y0: number; x1: number; y1: number },
	): boolean =>
		a.x0 <= b.x0 &&
		a.y0 <= b.y0 &&
		a.x1 >= b.x1 &&
		a.y1 >= b.y1 &&
		(a.x1 - a.x0) * (a.y1 - a.y0) >= (b.x1 - b.x0) * (b.y1 - b.y0);
	const groups: { outer: THREE.Vector2[]; holes: THREE.Vector2[][] }[] = [];
	for (let i = 0; i < valid.length; i++) {
		let holder = -1;
		let holderArea = Infinity;
		for (let j = 0; j < valid.length; j++) {
			if (i === j) continue;
			if (contains(boxes[j]!, boxes[i]!)) {
				const area =
					(boxes[j]!.x1 - boxes[j]!.x0) * (boxes[j]!.y1 - boxes[j]!.y0);
				if (area < holderArea) {
					holderArea = area;
					holder = j;
				}
			}
		}
		if (holder === -1) groups.push({ outer: valid[i]!, holes: [] });
	}
	for (let i = 0; i < valid.length; i++) {
		let holder = -1;
		let holderArea = Infinity;
		for (let j = 0; j < valid.length; j++) {
			if (i === j) continue;
			if (contains(boxes[j]!, boxes[i]!)) {
				const area =
					(boxes[j]!.x1 - boxes[j]!.x0) * (boxes[j]!.y1 - boxes[j]!.y0);
				if (area < holderArea) {
					holderArea = area;
					holder = j;
				}
			}
		}
		if (holder >= 0) {
			const g = groups.find((x) => x.outer === valid[holder]!);
			if (g) g.holes.push(valid[i]!);
		}
	}
	return groups.length ? groups : null;
}

/** 文字矢量挤出（与音符同 inkMat 材质；Liberation 无字形时返回 null 走贴图字块） */
// 文字块（CJK 等 Liberation 无字形文本的回退）：正面纸色底+墨字、侧面墨色，与乐谱同 PBR。
// 登记进 textPlanes，乐谱颜色/粗糙度变化时由 refreshTextPlanes 重绘 canvas + 同步参数，
// 不再用 MeshBasicMaterial（那样完全不吃粗糙度/金属度/预设，纸色也烘焙死）。
interface TextPlane {
	el: MappedEl;
	front: THREE.MeshStandardMaterial;
	side: THREE.MeshStandardMaterial;
	canvas: HTMLCanvasElement;
	tex: THREE.CanvasTexture;
	cw: number;
	ch: number;
	lastPaper: number;
	lastInk: number;
}
const textPlanes: TextPlane[] = [];
function scorePaperColor(): number {
	// 文字块正面纸色 = 底板色（底板归环境「地面」），让字块底板与垫板一致
	const c = surf.mat.ground;
	const bm = backplate.material as THREE.MeshStandardMaterial;
	return c.color ?? (bm.map ? 0xffffff : baseColorOf(c.preset));
}
function scoreInkColor(): number {
	const c = surf.mat.score;
	return c.inkColor ?? (inkMat.map ? 0xffffff : inkColorOf(c.preset));
}
function paintTextCanvas(
	tp: { canvas: HTMLCanvasElement; cw: number; ch: number; el: MappedEl },
	paper: number,
	ink: number,
): void {
	const ctx = tp.canvas.getContext("2d")!;
	const s = 3;
	ctx.clearRect(0, 0, tp.cw, tp.ch);
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	let fs = Math.max(8, Math.round(tp.el.h * PX_PER_UNIT * s * 0.92));
	ctx.font = `${fs}px 'Liberation', serif`;
	const tw = ctx.measureText(tp.el.txt ?? "").width;
	if (tw > tp.cw * 0.92) {
		fs = Math.max(8, Math.floor((fs * tp.cw * 0.92) / tw));
		ctx.font = `${fs}px 'Liberation', serif`;
	}
	ctx.fillStyle = `#${paper.toString(16).padStart(6, "0")}`;
	ctx.fillRect(0, 0, tp.cw, tp.ch);
	ctx.fillStyle = `#${ink.toString(16).padStart(6, "0")}`;
	ctx.fillText(tp.el.txt ?? "", tp.cw / 2, tp.ch / 2);
}
/** 乐谱设置变了：文字块同步 PBR 参数；纸色/墨色变了才重绘 canvas（粗糙度高频拖动不重绘） */
function refreshTextPlanes(): void {
	if (!textPlanes.length) return;
	const tune = surf.matTune.score;
	const paper = scorePaperColor();
	const ink = scoreInkColor();
	for (const tp of textPlanes) {
		tp.front.roughness = tune.rough;
		tp.front.metalness = tune.metal;
		tp.side.roughness = tune.rough;
		tp.side.metalness = tune.metal;
		tp.side.color.setHex(ink);
		tp.front.needsUpdate = true;
		tp.side.needsUpdate = true;
		if (tp.lastPaper !== paper || tp.lastInk !== ink) {
			paintTextCanvas(tp, paper, ink);
			tp.tex.needsUpdate = true;
			tp.lastPaper = paper;
			tp.lastInk = ink;
		}
	}
}
function makeTextPlane(el: MappedEl, r: number): THREE.Mesh {
	const s = 3;
	const cw = Math.max(8, Math.ceil(el.w * PX_PER_UNIT * s));
	const ch = Math.max(8, Math.ceil(el.h * PX_PER_UNIT * s));
	const canvas = document.createElement("canvas");
	canvas.width = cw;
	canvas.height = ch;
	const paper = scorePaperColor();
	const ink = scoreInkColor();
	paintTextCanvas({ canvas, cw, ch, el }, paper, ink);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	// 立体字块：正面 = 纸色底板 + 墨字，四周/背面 = 墨色侧面（与音符一样有凸起厚度）。
	// 用 MeshStandardMaterial 吃乐谱粗糙度/金属度/预设光照，与谱面其余部分同质感。
	const tune = surf.matTune.score;
	const front = new THREE.MeshStandardMaterial({
		map: tex,
		roughness: tune.rough,
		metalness: tune.metal,
	});
	const side = new THREE.MeshStandardMaterial({
		color: ink,
		roughness: tune.rough,
		metalness: tune.metal,
	});
	const depth = Math.max(0.001, r);
	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(el.w, el.h, depth),
		[side, side, side, side, front, side], // +z 面为文字正面
	);
	mesh.position.set(el.worldX, el.worldY, depth / 2);
	textPlanes.push({ el, front, side, canvas, tex, cw, ch, lastPaper: paper, lastInk: ink });
	return mesh;
}

// ── 全量构建（无 LOD、无底纹理；照搬 3dtest build） ──────────
// ── 连音线（tie/slur）流式点亮 ──────────────────────────────────
// 连音线在 Verovio SVG 里是 <g class="tie/slur"> 下的曲线（闭合填充透镜形或开放 stroke），
// 与谱线/符干共用 inkMat，没有 noteId。给每条连音线叠一层「点亮 overlay」（克隆几何 +
// 着色器前沿材质）：片元世界 x ≤ 前沿处发光，前沿按播放时间从曲线左端推到右端＝小球流式点亮。
interface TieLight {
	overlay: THREE.Mesh;
	geo: THREE.BufferGeometry;
	mat: THREE.MeshStandardMaterial;
	x0: number;
	x1: number;
	ai: number; // 曲线左端最近的演奏目标（取路径色/亮度）
	bi: number; // 曲线右端最近的演奏目标（决定点亮结束时刻）
	wx0: number; // 世界 x 区间：逐帧视野裁剪用（与 applyViewCrop 同一判据）
	wx1: number;
}
let tieLights: TieLight[] = [];
/** playTargets 下标按内部 x 升序（x 只在 buildAll 变，time 随时可能被重新绑定） */
let targetsByX: number[] = [];
/** 内部 x → 演奏时间：按 x 排序的音符表插值，两端就近取常数。
 *  连音线端点落在休止/找不到对应音符时用它兜底，避免 ta==tb 让线一开播就整条全亮。 */
function timeAtInternalX(x: number): number {
	const n = targetsByX.length;
	if (!n) return 0;
	const first = playTargets[targetsByX[0]!]!;
	const last = playTargets[targetsByX[n - 1]!]!;
	if (x <= first.x) return first.time;
	if (x >= last.x) return last.time;
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (playTargets[targetsByX[mid]!]!.x < x) lo = mid + 1;
		else hi = mid;
	}
	const pi = playTargets[targetsByX[lo - 1]!]!;
	const pj = playTargets[targetsByX[lo]!]!;
	const f = Math.min(1, Math.max(0, (x - pi.x) / Math.max(1e-6, pj.x - pi.x)));
	return pi.time + (pj.time - pi.time) * f;
}
/** 连音线几何最左/最右顶点（内部坐标）。月牙形的 bbox 中心常落在两弧之间的空档，
 *  拿它去匹配音符会挑到别的轨 → 取色不对；曲线的真实端点才贴着头音/尾音。 */
function tieEndInternalPts(
	geo: THREE.BufferGeometry,
	mesh: THREE.Mesh,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
	const pos = geo.getAttribute("position");
	let li = 0,
		ri = 0,
		lx = Infinity,
		rx = -Infinity;
	for (let i = 0; i < pos.count; i++) {
		const x = pos.getX(i);
		if (x < lx) {
			lx = x;
			li = i;
		}
		if (x > rx) {
			rx = x;
			ri = i;
		}
	}
	return {
		start: { x: mesh.position.x + pos.getX(li), y: mesh.position.y + pos.getY(li) },
		end: { x: mesh.position.x + pos.getX(ri), y: mesh.position.y + pos.getY(ri) },
	};
}
/** 按平面距离（x 与 y 一起）反查最近演奏目标：同 x 的和弦/别轨音不会误命中 */
function nearestTargetBy2D(x: number, y: number): number {
	let best = -1;
	let bd = Infinity;
	for (let i = 0; i < playTargets.length; i++) {
		const p = playTargets[i]!;
		const d = Math.hypot(p.x - x, p.y - y);
		if (d < bd) {
			bd = d;
			best = i;
		}
	}
	return best;
}
/** 连音线点亮色/亮度跟随路径（与符头点亮同源）；路径色/点亮设置变化时刷新 */
function refreshTieColors(): void {
	for (const tl of tieLights) {
		const c = litColorFor(tl.ai);
		tl.mat.color.setHex(c);
		tl.mat.emissive.setHex(c);
		tl.mat.emissiveIntensity = litBrightFor(tl.ai);
	}
}
/** 连音线点亮材质：片元世界 x ≤ 前沿 uLitX 处发光，前沿随播放时间从左端推到右端。
 *  Verovio 连音线是闭合填充透镜形（非开放 stroke），drawRange 无法干净地按 x 揭示，
 *  故用着色器前沿：未点亮区 alpha=0 透出底 mesh（inkMat 常态），点亮区显轨色+自发光。 */
function makeTieMaterial(color: number, glow: number): THREE.MeshStandardMaterial {
	const mat = makeLitMaterial(
		surf.mat.score.preset,
		color,
		glow,
		overridesFor("score"),
	);
	mat.transparent = true;
	mat.depthWrite = false;
	mat.polygonOffset = true;
	mat.polygonOffsetFactor = -1;
	mat.polygonOffsetUnits = -1;
	// 前沿先存材质上：着色器首帧编译时直接取它，避免编译那帧 uLitX 还是默认 -1e9
	// 导致连音线闪一帧黑（用户看到「没跟着头音点亮」）
	mat.userData.pendingLitX = -1e9;
	mat.onBeforeCompile = (shader) => {
		shader.uniforms.uLitX = { value: (mat.userData.pendingLitX as number) ?? -1e9 };
		shader.uniforms.uFeather = { value: 0.06 * SCORE_SCALE };
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", "#include <common>\nvarying float vWorldX;")
			.replace(
				"#include <begin_vertex>",
				"#include <begin_vertex>\nvWorldX = (modelMatrix * vec4(transformed, 1.0)).x;",
			);
		shader.fragmentShader = shader.fragmentShader
			.replace(
				"#include <common>",
				"#include <common>\nvarying float vWorldX;\nuniform float uLitX;\nuniform float uFeather;",
			)
			.replace(
				"#include <emissivemap_fragment>",
				"#include <emissivemap_fragment>\nfloat tieLit = 1.0 - smoothstep(uLitX - uFeather, uLitX + uFeather, vWorldX);\ntotalEmissiveRadiance *= tieLit;",
			)
			.replace(
				"#include <opaque_fragment>",
				"gl_FragColor = vec4(outgoingLight, diffuseColor.a * tieLit);",
			);
		mat.userData.shader = shader;
	};
	return mat;
}
/** 每帧按播放时间推进连音线点亮前沿（与符头点亮同一时钟；水平匀速后球 x∝时间）
 *  起止时刻一律现取现算，不缓存：反复展开、音画对齐、首尾留白都会重绑
 *  playTargets[].time，缓存过的 ta/tb 会留在旧时刻上（连音线点亮错位的根因）。 */
function updateTieLights(t: number): void {
	const r = Math.max(0.5, surf.viewRadius);
	const lo = focusX - r;
	const hi = focusX + r;
	for (const tl of tieLights) {
		const a = playTargets[tl.ai];
		const b = playTargets[tl.bi];
		// 取「音符时刻」与「按 x 内插的时刻」的包络：端点找不到对应音符（跨休止、
		// 两端撞到同一个音）时也不会退化成 ta==tb —— 那会让线在开播瞬间整条全亮
		const ta = Math.min(a ? a.time : Infinity, timeAtInternalX(tl.x0));
		const tbRaw = Math.max(b ? b.time : -Infinity, timeAtInternalX(tl.x1));
		const tb = tbRaw > ta ? tbRaw : ta + 1e-3;
		const span = tb - ta;
		const p = surf.litEnabled ? Math.min(1, Math.max(0, (t - ta) / span)) : 0;
		const litX = p <= 0 ? -1e9 : (tl.x0 + (tl.x1 - tl.x0) * p) * SCORE_SCALE;
		// 两个地方都写：已编译的走 uniform，首帧编译中的走 userData（见 makeTieMaterial）
		tl.mat.userData.pendingLitX = litX;
		const sh = tl.mat.userData.shader as
			| { uniforms: { uLitX: { value: number } } }
			| undefined;
		if (sh) sh.uniforms.uLitX.value = litX;
		// visible 同时受「点亮进度」和「视野窗口」约束：只看前者的话，已点亮的线
		// 会跑到裁剪线以外还赖在画面里，边缘就出现「别的都没了它还在」的分界
		tl.overlay.visible = p > 0 && tl.wx1 >= lo && tl.wx0 <= hi;
	}
}
function buildAll(): void {
	recalcBallBaseZ(); // 凸起高度影响弧线落点/起终点线基准
	while (stage.children.length) {
		const m = stage.children[0] as THREE.Mesh;
		stage.remove(m);
		m.geometry?.dispose();
		const mm = m.material as THREE.Material | THREE.Material[];
		if (Array.isArray(mm))
			mm.forEach((x) => {
				(x as THREE.MeshBasicMaterial).map?.dispose();
				x.dispose();
			});
		else {
			(mm as THREE.MeshBasicMaterial)?.map?.dispose();
			(mm as THREE.Material)?.dispose();
		}
	}
	fillCache.clear();
	targetMeshes.clear();
	litCount = 0;
	tieLights = []; // overlay 已随上面的 stage 清空循环 dispose，这里只重置引用
	// 连音线兜底用的 x→时间表：x 只在这里变（时刻由 bindTargetTimes 随时改，现取现算）
	targetsByX = playTargets
		.map((_, i) => i)
		.sort((p, q) => playTargets[p]!.x - playTargets[q]!.x);
	textPlanes.length = 0; // 文字块 mesh/材质/贴图 likewise 已随 stage 清空 dispose
	// 演奏目标索引：noteId → targetIdx（点亮改色用）
	const noteIdx = new Map<string, number>();
	playTargets.forEach((t, i) => {
		if (t.id) noteIdx.set(t.id, i);
	});
	for (const el of allElems) {
		try {
			let mesh: THREE.Mesh | null = null;
			// 凸起厚度按元素类型缩放：合并五线谱线 ×0.7、小节线 ×0.85、符头 ×1.1
			// （符头比符杆高出 1/10，避免同高 z-fighting 导致贴图跳动）、其余 ×1
			const noteheadEl =
				el.kind === "fill" && el.noteId ? el.el.closest(".notehead") : null;
			const rDepth = Math.max(
				0.001,
				surf.rise *
					(el.staffLine
						? 0.7
						: el.barLine
							? 0.85
							: noteheadEl
								? 1.1
								: 1),
			);
			if (el.kind === "open" && el.pts && el.pts.length >= 2) {
				// 线宽加粗补偿：SVG stroke 归一化到世界后过细；保持相对粗细（谱线/符干/连谱号比例不变），整体 ×2；
				// 连谱号（粗 stroke 长曲线）保留 ×1.5 后再 ×2。
				const base =
					el.strokeW > 0.09 && el.pts.length > 100
						? el.strokeW * 1.5
						: el.strokeW;
				const sw = base * 2;
				mesh = new THREE.Mesh(makeRibbon(el.pts, sw, rDepth), inkMat);
			} else if (el.kind === "fill" && el.shapes) {
				mesh = new THREE.Mesh(makeFill(el, rDepth), inkMat);
			} else if (el.kind === "text" && el.txt) {
				// 常规文字已在 parseScore 入口被 svgTextsToPaths 转成 path（走 fill 管线）；
				// 走到这里的只剩 CJK 等 Liberation 无字形的文本 → 贴图字块回退
				mesh = makeTextPlane(el, rDepth);
			}
			if (mesh) {
				// 几何在生成时做了 translate 居中，boundingSphere 指向原始绝对坐标导致 culling 全剔除
				mesh.geometry.computeBoundingSphere();
				mesh.frustumCulled = false;
				mesh.castShadow = surf.rt; // 光追模式：谱面元素投阴影
				mesh.position.set(el.worldX, el.worldY, 0);
				// 视野裁剪：按元素 x 区间 [worldX0, worldX1] 与视野窗口的重叠判断
				// （合并谱线横贯全谱、中心点在谱中间，按中心裁剪会整条误杀）
				mesh.userData.src = `${el.kind}@${el.worldX.toFixed(2)},${el.worldY.toFixed(2)}`;
				mesh.userData.worldX = el.worldX;
				mesh.userData.worldX0 = el.worldX - el.w / 2;
				mesh.userData.worldX1 = el.worldX + el.w / 2;
				// 演奏目标：只对符头（notehead）mesh 做独立材质（点亮只变符头，符杆/符尾/变音记号不变）
				if (el.noteId && noteIdx.has(el.noteId) && el.el.closest(".notehead")) {
					const ti = noteIdx.get(el.noteId)!;
					// 符头：同乐谱 PBR 质感；未点亮跟随 inkMat（墨色+自发光，
					// 默认无光源时与谱线一起靠自发光可见），点亮=轨色+自发光
					const lm = makeLitMaterial(
						surf.mat.score.preset,
						0x000000,
						0,
						overridesFor("score"),
					);
					lm.color.copy(inkMat.color);
					lm.emissive.copy(inkMat.emissive);
					lm.emissiveIntensity = inkMat.emissiveIntensity;
					mesh.material = lm;
					const arr = targetMeshes.get(ti) ?? [];
					arr.push(mesh);
					targetMeshes.set(ti, arr);
					mesh.layers.enable(BLOOM_LAYER); // 符头进发光缓冲（未点亮=墨色，低于阈值）
				}
				stage.add(mesh);
				// 连音线/圆滑线：叠一层流式点亮 overlay。Verovio 把 tie/slur 画成闭合填充
				// 透镜形（kind=fill）或开放曲线（kind=open），两者都接住。底 mesh 仍是 inkMat
				// 常态外观；overlay 克隆几何 + 着色器前沿材质，点亮前沿随小球推进（见 makeTieMaterial）。
				if (
					(el.kind === "open" || el.kind === "fill") &&
					el.el.closest(".tie, .slur, .ties, .slurs")
				) {
					const geo = mesh.geometry.clone();
					// 端点取曲线几何的真实左右顶点（不是 bbox 边），2D 最近匹配音符，
					// 这样连音线的取色一定来自它自己那条轨的头音
					const ends = tieEndInternalPts(geo, mesh);
					const ai = nearestTargetBy2D(ends.start.x, ends.start.y);
					const bi = nearestTargetBy2D(ends.end.x, ends.end.y);
					const mat = makeTieMaterial(0xffffff, 0.5);
					// 前沿按曲线真实左右端点推进（不是 bbox 边），点亮正好铺满整条连音线
					const x0 = Math.min(ends.start.x, ends.end.x);
					const x1 = Math.max(ends.start.x, ends.end.x);
					const overlay = new THREE.Mesh(geo, mat);
					overlay.position.copy(mesh.position);
					overlay.frustumCulled = false;
					overlay.userData.worldX = el.worldX;
					overlay.userData.worldX0 = el.worldX - el.w / 2;
					overlay.userData.worldX1 = el.worldX + el.w / 2;
					overlay.layers.enable(BLOOM_LAYER);
					overlay.visible = false;
					stage.add(overlay);
					tieLights.push({
						overlay,
						geo,
						mat,
						x0,
						x1,
						// 取色端点钳到 0：playTargets 为空时 nearestTargetBy2D 返回 -1，
						// refreshTieColors 的 litColorFor(-1) 会越界
						ai: Math.max(0, ai),
						bi: Math.max(0, bi),
						// 裁剪区间直接取 overlay 自己那份 userData，别留第二处真值
						wx0: overlay.userData.worldX0 as number,
						wx1: overlay.userData.worldX1 as number,
					});
				}
			}
		} catch (e) {
			console.error("elem fail", el.tag, e);
		}
	}
	// 网络贴图模式：buildAll 重建了全部谱面材质（底板/ink/符头都是新实例），
	// 若该组已选贴图且有缓存，立即重新打上（改 rise / 玻璃切换后贴图不丢）
	const scfg = surf.mat.score;
	if (scfg.source === "network" && scfg.tex) {
		void getTexSet("score", scfg.tex).then((set) => {
			const cur = surf.mat.score;
			if (cur.source !== "network" || cur.tex !== set.id) return;
			applyTextureSet("score", set);
		});
	}
	// 自检基线：这一轮之后 stage 应该正好有这么多子节点
	stageBuiltCount = stage.children.length;
}

// ── 数据加载 ──────────────────────────────────────────────────
const yieldUI = (): Promise<void> => new Promise((r) => setTimeout(r, 16));
async function renderScore(name: string, xml: string): Promise<void> {
	resetPlayer(); // 新谱 → 重置播放
	bootXmlLen = xml.length; // 自检用它判断上游（第 2/3 页）是否改过谱
	if (!vtk) throw new Error(t("p4.err.noVerovio"));
	setInfo(() => t("p4.info.rendering"));
	renderProg.show(t("p4.prog.build"));
	renderProg.set(0.05, t("p4.prog.font"));
	await yieldUI(); // 让"渲染中…"先刷出来
	await ensureTextFont(); // 文字矢量挤出依赖 Liberation 轮廓（失败回退贴图字块）
	renderProg.set(0.15, t("p4.prog.parse"));
	// 优先消费第三页存的纯 path 谱面（midee.pathSvg：第二页编辑已原样应用、
	// 全部 <text> 已冻结为矢量轮廓）——进入本页前只处理 path 元素，文字相关
	// 问题从源头消除。无缓存（未经第三页 / 序列化超限）则自渲染回退，并走
	// 同一份编辑应用 + text→path 转换，保证与第三页谱面完全一致。
	let svgStr: string | null = null;
	try {
		svgStr = sessionStorage.getItem("midee.pathSvg");
	} catch {
		svgStr = null;
	}
	vtk.loadData(ensureNoteTypes(xml)); // 补 <type>：Verovio 无 type 不画符杆/符尾；pathSvg 命中时也加载（renderToTimemap 等下游仍依赖）
	if (!svgStr) {
		renderProg.set(0.25, t("p4.prog.layout"));
		let fallback = vtk.renderToSVG(1);
		await yieldUI();
		try {
			const doc = new DOMParser().parseFromString(fallback, "image/svg+xml");
			const srcSvg = doc.documentElement as unknown as SVGSVGElement;
			const edits = loadSymbolEdits();
			if (edits) applySymbolEdits(srcSvg, edits);
			const fonts = await ensurePathFonts();
			// 第二页给文字指定的网络字体（MiSans）：先拉齐 woff2 分片再同步转 path
			await preloadTextFonts(srcSvg);
			if (fonts) convertSvgTextsToPaths(srcSvg, fonts);
			fallback = new XMLSerializer().serializeToString(srcSvg);
		} catch {
			/* 应用/转换失败：保留原始 SVG，旧 svgTextsToPaths 管线兜底 */
		}
		svgStr = fallback;
	}
	await yieldUI();
	renderProg.set(0.45, t("p4.prog.map"));
	const parsed = parseScore(svgStr);
	allElems = mergeStaffLines(parsed.elems); // 谱线段间有 Verovio 留缝（2D 整页不可见，3D 局部放大断开）→ 同 y 段首尾相连
	scoreH = parsed.natH / PX_PER_UNIT;
	measureStaffSpace(); // 先量谱线间距，再建球轨（中心圆片要用它）
	trackLength = parsed.natW / PX_PER_UNIT;
	readOffsets(); // 第三页「播放 → 首尾留白」为权威：读入 axisLead/axisTail（并回显到面板下落时间）
	syncAxisInputs(); // 顶栏「工具 ▾」的首尾偏移量跟着第三页的值显示（默认从第三页映射）
	syncTermHeights(); // 谱线间距刚量好：把跟随中的首尾高度换算成面板显示的倍数
	// 乐谱底板缩放到谱面实际大小并居中（内部坐标 x∈[0,trackLength], y 居中）
	backplate.scale.set(trackLength, scoreH, 1);
	backplate.position.set(trackLength / 2, 0, -0.02);
	// 演奏打标：识别需要演奏的音符/和弦 + 演奏事件 + 反复记号
	playTargets = extractPlayTargets(allElems);
	playEvents = loadPlayEvents();
	repeatInfo = extractRepeats(xml);
	bindTargetTimes(); // target ↔ MIDI 时间绑定（数量一致按序；否则 x 线性兜底）
	paintRepeatInfo();
	// 相机参数绑定谱宽
	rMin = R_FACTOR_MIN * scoreH * SCORE_SCALE; // scoreH 是内部单位，相机在世界坐标里 → 同乘
	rMax = R_FACTOR_MAX * scoreH * SCORE_SCALE;
	radius = clamp(CAM_DEFAULT.r, rMin, rMax);
	shell.setTitle(name);
	setInfo(
		() =>
			`${escapeHtml(name)}<br>` +
			escapeHtml(
				t("p4.info.stats", {
					h: scoreH.toFixed(2),
					n: allElems.length,
					len: trackLength.toFixed(1),
				}),
			),
		true,
	);
	document.getElementById("empty")!.hidden = true;
	focusX = CAM_DEFAULT.focus;
	renderProg.set(0.7, t("p4.prog.geom"));
	await yieldUI();
	buildAll();
	renderProg.set(0.9, t("p4.prog.balls"));
	initBalls(); // 小球轨迹（按轨分组 + 弧线链 + 球池），球初始停第一个音符
	updateBalls(0);
	// 进入本页相机落在谱面开头（x=0）。起点线 startX=首音x−留白，首音前有大段休止时
	// 它会落在谱面中间，不能拿它当初始焦点（用户反馈「进来聚焦中间而不是开头」）。
	focusX = 0;
	applyCam();
	ensureWater(); // 水面（反射，默认关；由悬浮窗开启）
	water?.setCenterX(focusX);
	applyViewCrop();
	renderProg.done(t("p4.prog.ready"));
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

// ── UI ────────────────────────────────────────────────────────
document.getElementById("goImport")!.addEventListener("click", () => {
	goStep(1);
});

// ── 外壳接线：顶栏（含音轨下拉）+ 工具下拉 + 悬浮播放条 ────────
// 相机面板、渲染信息收纳在「工具 ▾」；播放条为共享的一行 13 项组件；
// 音轨面板挂在顶栏「音轨」下拉里（2D / 3D 共享组件，3D 额外显示点亮颜色）。
const camPanelEl = document.getElementById("camPanel")!;
const infoEl = document.getElementById("info")!;

// #info 由本页独占：外壳切语言时会对打开的工具下拉重跑 applyI18n，留着
// data-i18n 会把渲染结果刷回「等待导入乐谱」。首屏词条仍写在 HTML 里（两种
// 语言都能正确首绘），挂载后立刻摘掉绑定，改由这个重画闭包跟随语言。
let repaintInfo: () => void = () => {
	infoEl.textContent = t("p4.info.waiting");
};
infoEl.removeAttribute("data-i18n");
repaintInfo();
/** 写 #info 并记住怎么重画；html=true 时文案里的 {msg} 必须已转义 */
function setInfo(
	paint: () => string,
	asHtml = false,
): void {
	repaintInfo = () => {
		const text = paint();
		if (asHtml) infoEl.innerHTML = text;
		else infoEl.textContent = text;
	};
	repaintInfo();
}

/** 反复区间：数据在 renderScore 里解析，文案随语言重画 */
function paintRepeatInfo(): void {
	const el = document.getElementById("repeatInfo");
	if (!el) return;
	el.textContent = repeatInfo.length
		? t("cam.repeat.list", {
				list: repeatInfo
					.map((r) => `M${r.measure}${r.type === "forward" ? "‖:" : ":‖"}`)
					.join(" "),
			})
		: t("cam.repeat.none");
}

/** 从第三页 midee.links 读用户给路径起的自定义名，按 trackKey 't<N>' 映射到音轨索引 */
function linkPathName(trackIndex: number): string | undefined {
	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem("midee.links");
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		const store = JSON.parse(raw) as {
			paths?: { trackKey?: string; name?: string }[];
		};
		const key = `t${trackIndex}`;
		for (const p of store.paths ?? []) {
			if (p.trackKey === key) {
				const n = p.name?.trim();
				return n || undefined;
			}
		}
	} catch {
		/* noop */
	}
	return undefined;
}

/** 从第三页 midee.links 读路径自定义颜色，按 trackKey 't<N>' 映射到音轨索引。
 *  测试台模式不创建（场景冻结：音轨改色/换音色入口全部隐藏）。 */
let trackPanel: TrackPanelHandle | null = null;
if (!BENCH) {
	trackPanel = createTrackPanel({
		getPlayer: () => player,
		showColor: true,
		getColor: (i) => pathColorFor(i, i),
		onColor: (i, hex) => {
			// 音轨面板改色 = 改这条路径的颜色（小球与点亮同时跟着变）
			const next = [...surf.pathColors];
			next[i] = parseInt(hex.slice(1), 16);
			applySurf({ pathColors: next });
		},
		getTrackName: (i) => linkPathName(i),
		onOpenCache: () => shell.openCache(),
	});
	tracksSlot.append(trackPanel.el);
}

// 播放条：测试台模式不建（暂无播放控件，也不加载音色）
let bar: PlayerBarHandle | null = null;
if (!BENCH) {
	bar = createPlayerBar({
		shell,
		storageKey: "midee.float.player",
		getPlayer: () => player,
		togglePlay: () => void togglePlay(),
		// 竖屏底栏 / 超宽侧栏的「场景设置」：面板是贴边抽屉，按钮只管开合
		// （抽屉已经卡在两条栏之间，不需要再抬 z-index 压过它们）
		action: {
			label: () => t("p4.sceneSettings"),
			run: () => {
				const host = document.querySelector<HTMLElement>(".sp-host");
				const win = host?.closest<HTMLElement>(".sh-float");
				if (win) win.hidden = !win.hidden;
			},
		},
		// 进度条 = 显示轴（leadIn axisLead + 音乐 + tail axisTail，与第三页时间线同构同源）：
		// 拖动按显示轴换算回音乐时间 seek。不传 seekFrac 时播放条默认按
		// frac×dur（纯音乐轴）定位，与本页含首尾留白的显示轴错位最多 ±axisLead
		// （拖 1/4 处偏早、3/4 处偏晚，且拖动中进度条会被 animate 重画"打滑"）。
		seekFrac: (frac) => {
			const dur = player?.duration ?? 0;
			ballEnded = false;
			clearAllTrailHist();
			// frac=0 = 留白起点：从静默段开始播，球从头下落
			// 进度条显示的是可视轴，落点要减回音画对齐偏移才是音频时刻；
			// 下限用 audioFloor()（含对齐偏移加长的那截留白），否则拖到最左会把
			// 播放头停在音乐中间，起点动画照样不入场。
			player?.seek(
				clamp(
					frac * dispTotal() - axisLead - avOffset,
					audioFloor(),
					dur,
				),
			);
		},
		nudge: (delta) => {
			const p0 = player;
			if (!p0) return;
			ballEnded = false;
			clearAllTrailHist();
			p0.seek(clamp(p0.currentTime + delta, audioFloor(), p0.duration));
		},
	});
}

// ── 3D 场景设置悬浮窗（材质/水面/拖尾/轨迹线/视野，按作用对象折叠） ──
// 测试台模式：不建面板，用同形状桩占位（panelHandle?.syncDerived() 等调用点照常通过）
const settingsPanel: SettingsPanelHandle = BENCH
	? { el: document.createElement("div"), refresh: () => {}, syncDerived: () => {} }
	: createSettingsPanel(surf, (patch) => {
			surfaceDirty = true;
			if (patch.trailPct !== undefined) {
				try {
					localStorage.setItem(TRAIL_KEY, String(patch.trailPct));
				} catch {
					/* noop */
				}
			}
			applySurf(patch); // 落盘在 applySurf 里统一做（saveSurf）
		}, () => shell.openCache(), () => player?.playing === true, shell);
panelHandle = settingsPanel;
// 竖屏（底栏）与超宽（侧栏）两种收纳态：设置面板当贴边抽屉用，默认收起，
// 由「场景设置」按钮就地展开。回到横屏/中窄那两档时把它放回来——
// 那两档底栏按钮是隐藏的，不收回来就没有任何入口了（用户自己 × 关掉的不管）。
const spWin = document
	.querySelector<HTMLElement>(".sp-host")
	?.closest<HTMLElement>(".sh-float");
const drawerBands = [
	window.matchMedia("(max-aspect-ratio: 1/1)"),
	window.matchMedia("(min-aspect-ratio: 2/1)"),
];
let stowedByBand = false;
/** 图钉钉住 = 常驻：既不随档位收摊，也不因回到画面操作而折叠 */
const panelPinned = (): boolean => spWin?.dataset.pinned === "true";
function syncPanelStow(): void {
	if (!spWin || panelPinned()) return;
	if (drawerBands.some((m) => m.matches)) {
		if (!spWin.hidden) {
			spWin.hidden = true;
			stowedByBand = true;
		}
	} else if (stowedByBand) {
		spWin.hidden = false;
		stowedByBand = false;
	}
}
syncPanelStow();
window.addEventListener("resize", syncPanelStow);
for (const m of drawerBands) m.addEventListener("change", syncPanelStow);
// 抽屉态下没钉住：手一回到画布上就把抽屉折起来（悬浮窗那两档不掺和）
container.addEventListener("pointerdown", () => {
	if (!spWin || spWin.hidden || panelPinned()) return;
	if (!drawerBands.some((m) => m.matches)) return;
	spWin.hidden = true;
});

// 超宽屏那一段没有顶栏底栏，标题行与控件条是无背板直接压在画面上，
// 按画面实际亮度换前景色（星空黑→浅字，白底谱面→深字）
const contrast = createContrastProbe(() => renderer.domElement);

const buildTools = (): ShellTool[] => [
	{ id: "cam", label: t("p4.camera"), node: camPanelEl },
	{ id: "resetCam", label: t("p4.resetCam"), run: resetCam },
	{ id: "info", label: t("p4.info"), node: infoEl },
];

// 外壳已在文件开头挂载（先于 WebGL 初始化），这里补上页面专属工具
shell.setTools(buildTools());

applyI18n(document.body);
onLocaleChange(() => {
	applyI18n(document.body);
	shell.setTools(buildTools());
	// 自绘下拉的选项与 aria-label 是建控件时写死的，applyI18n 扫不到
	camModePick.setOptions(camModeOptions());
	camModePick.el.setAttribute("aria-label", t("cam.mode"));
	repaintInfo();
	paintRepeatInfo();
	// 路径名是按序号生成的，切语言得重译。只更新 ColorBus 的登记名、不 publish：
	// 广播会把「跟随」订阅者的回调再跑一遍，等于白重设一次材质。
	surf.pathNames = surf.pathNames.map((_, i) => t("sp.pathN", { n: i + 1 }));
	surf.pathNames.forEach((name, i) => {
		ColorBus.register(`path.${i}`, name, pathColorFor(i, i));
	});
	// 面板自己的语言监听先跑，那会儿路径名还是旧语言，这里补一次重画
	settingsPanel.refresh();
});

function resize(): void {
	const w = container.clientWidth;
	const h = container.clientHeight;
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h);
	bloom.setSize(w, h);
	trailResolution.set(w, h); // meshline 材质分辨率（线宽像素换算依赖它）
}
window.addEventListener("resize", resize);
// 从后台切回前台：节流期间的贴图/时钟/上下文都可能已经不一致，补扫一次
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") patrol("visible");
});
// 顶栏/侧栏内缩（--sh-canvas-top / --sh-side-inset）变化时容器尺寸跟着变，
// 不一定伴随 window resize，用 ResizeObserver 保证渲染器始终贴合可视区
new ResizeObserver(() => resize()).observe(container);

// 视觉播放位置（秒）。播放中直接锁相 AudioContext 时钟（p.currentTime，与
// Tone.Transport 发声调度同源），墙钟只在结束飞行/暂停回显时兜底——不做墙钟
// 累加 + 漂移硬校正：双时钟斜率差会周期性触发「画面抖一下矫正」。
let visTime = 0; // 视觉播放位置（秒）
let lastDriveT = -1; // 上一帧驱动给焦点/点亮的时间（非播放时仅在进度变化时驱动，避免抢手动相机）

let lastAudioT = 0; // 上一帧的音频时钟读数（全站唯一时钟：平滑/水面/结束飞行增量全用它）
let exportHold = false; // 导出期间挂起 animate 的场景更新与渲染，把 renderer 独占给逐帧循环
/** 上一次 animate 真正跑起来的墙钟时刻（ms）：修复页签用它判断画面是不是冻住了 */
let lastFrameAt = 0;
let lastThrSyncAt = 0; // 上一次量发光缓冲峰值的时刻（peakLuma 不逐帧跑，见 animate）
let rafId = 0;
/** rAF 链断掉时的手动重挂：先取消还在排的那一帧，保证永远只有一条循环 */
function ensureLoop(): void {
	cancelAnimationFrame(rafId);
	rafId = requestAnimationFrame(animate);
}
function animate(): void {
	rafId = requestAnimationFrame(animate);
	lastFrameAt = performance.now();
	if (exportHold) return; // 视频导出期间挂起实时动画，renderer 交给逐帧导出循环独占
	const nowA = audioClockNow();
	const dt = lastAudioT ? Math.min(0.05, Math.max(0, nowA - lastAudioT)) : 0.016;
	lastAudioT = nowA;

	const p = player;
	const dur = p?.duration ?? 0;
	const playing = p?.playing === true;

	// 结束态下用户拖进度条 / 点 ±10s 回看（currentTime 离开结尾）→ 退出结束态，
	// 否则 visTime 每帧被强行拉回终点，无法回看（只有重新播放才会清 ballEnded）。
	if (ballEnded && p && !playing && dur > 0 && p.currentTime < dur - 0.05) {
		ballEnded = false;
		clearAllTrailHist();
	}

	if (ballEnded) {
		// 自然结束：从末音沿半弧匀速飞到终点线上空（尾留白 axisTail=第三页 offEnd），停住。
		// 起点取「播放头收尾那一刻的画面秒」而不是硬邦邦的 dur —— 画面整体挪了
		// （avOffset/小节矫正）时从这里接管，才不会把飞行中的尾球瞬移到终点线。
		visTime = Math.min(dur + axisTail, Math.max(visTime, toVisTime(dur)) + dt);
	} else if (playing) {
		// 视觉时间直接锁相播放器音频时钟（p.currentTime 与 Tone.Transport 调度同源）：
		// 球/镜头/点亮永远与发声进度一致（含变速 speed）。此前用墙钟 dt 累加 + err 阈值
		// 硬校正的双时钟方案，会因 AudioContext 与墙钟的斜率漂移而周期性触发
		// 「画面抖一下矫正」且球速阶段性偏离音频——正是用户反馈的抖动根因。
		// 真 seek（拖进度条/±10s）的大位移由下方 jumpTh 平滑切换兜底，无需 err 硬对齐。
		// 音画对齐（顶栏「工具 ▾ → 时间」）+ 每小节以 MIDI 为准的软矫正都在 toVisTime 里。
		visTime = toVisTime(p.currentTime);
		if (dur > 0) visTime = Math.min(visTime, dur + axisTail);
	} else {
		// 暂停 / 未播放：跟随播放器位置（拖进度条、进退 10s 均经 player.seek 改 currentTime）
		visTime = toVisTime(p ? p.currentTime : 0);
	}

	updateBalls(visTime);
	updateTieLights(visTime); // 连音线随播放进度流式点亮（与小球同一时钟）
	// 照搬测试台暂停冻结：暂停/未播放且非结束态 → 拖尾原地保留（不采样不老化不裁剪），
	// 与测试台 paused 尾巴还在一致；seek 大跳仍走 updateTrails 内的跳变清空
	updateTrails(visTime, true, !playing && !ballEnded && p !== null);

	// 焦点 / 点亮 / 播放条统一吃视觉时间（播放中每帧跟随；非播放时仅在进度变化时跟随，
	// 暂停静止不写焦点，避免覆盖用户手动拖相机）。
	const driveT = ballEnded ? dur : visTime;
	const targetX = focusXAtTime(visTime, dur);
	// 相机 = 进度条线性位置：从头到尾匀速直给（用户明确要求镜头不跟随小球），
	// 不做指数平滑/水位线/jumpTh 等任何跟随校正——线性映射天然单调无回退。
	if (playing || ballEnded) {
		// 时间轴相机：自动跟随；自由相机：不跟随，用户自由视角
		if (camMode === "timeline") updateFollowFocus(targetX, dt, visTime);
		setLitProgress(dur > 0 ? Math.min(visTime, dur) : 0);
		bar?.setProgress(toDisp(driveT), dispTotal());
	} else if (Math.abs(visTime - lastDriveT) > 1e-6) {
		if (camMode === "timeline") updateFollowFocus(targetX, dt, visTime);
		setLitProgress(dur > 0 ? Math.min(visTime, dur) : 0);
		bar?.setProgress(toDisp(driveT), dispTotal());
	}
	lastDriveT = driveT;

	bgGround.position.x = focusX; // 背景组（地面/水面）跟随焦点平移，配合边缘淡出
	if (surf.rt) keyLight.target.position.x = focusX * SCORE_SCALE; // 主光阴影随焦点平移（target 已入场景，矩阵自动更新）
	// 任何更新环节抛错都不能跳过 renderer.render——preserveDrawingBuffer:false 下
	// 漏一帧 = 画面闪黑一下（用户反馈的「时不时频闪」根因）。
	try {
		water?.update(dt);
	} catch {
		/* 水面异常不阻塞渲染 */
	}
	try {
		updateFx(dt); // 碰撞粒子（three.quarks BatchedRenderer）
	} catch {
		/* 粒子异常不阻塞渲染 */
	}
	// 自动阈值按 200ms 一拍补算：峰值会在 applyBloomSurf 之外变化（buildAll 重建
	// mesh、点亮改色），而 peakLuma 要遍历上千个材质，逐帧量不划算。
	if (lastFrameAt - lastThrSyncAt > 200) {
		lastThrSyncAt = lastFrameAt;
		syncBloomThreshold();
	}
	bloom.renderFrame();
	contrast.sample(); // 与 render 同帧读亮度，隔帧读到的会是空缓冲
}
animate();

// 初始 bloom 参数与四源光效权重：放在全部模块状态就位之后、首帧之前调用一次
// （它要读 ballTracks / targetMeshes，早于这里会踩 TDZ）。
applyBloomSurf();

// ── 启动 ───────────────────────────────────────────────────────
async function boot(): Promise<void> {
	const xml = sessionStorage.getItem("midee.xml");
	const name = sessionStorage.getItem("midee.name");
	const ok = await initVerovio();
	if (!ok) {
		setInfo(() => t("p4.info.engineFail"));
		return;
	}
	if (xml) {
		try {
			await renderScore(name ?? t("common.untitled"), xml);
		} catch (err) {
			// 解析/构建异常不能让页面永远停在“渲染中…”：给出可见错误并在控制台留痕
			renderProg.done(t("p4.prog.renderFail"));
			console.error("乐谱渲染失败", err);
			const msg = (err as Error)?.message || String(err);
			setInfo(() => t("p4.err.render", { msg: escapeHtml(msg) }), true);
		}
	} else {
		// 没有乐谱数据就是没有：保留空状态卡片（顶栏照常可用），不塞示例谱
		setInfo(() => t("p4.info.waiting"));
	}
	if (!BENCH) await initPlayer(); // MIDI 播放器（采样钢琴；无 MIDI 时静默跳过）。测试台暂无播放控件，跳过（不加载音色）
	// 载入完这张谱扫一次。延后一拍：首帧还在补贴图/补几何，立刻扫到的全是中间态。
	setTimeout(() => patrol("boot"), 600);
}
void boot().catch((err) => {
	renderProg.done(t("p4.prog.initFail"));
	console.error("启动失败", err);
	const msg = (err as Error)?.message || String(err);
	setInfo(() => t("p4.err.init", { msg }));
});

// ═══════════ 播放系统（Tone 采样钢琴 + Part 调度 + 时钟；UI 走共享播放条） ═══════════
// 链路：sessionStorage.midee.midi(base64) → @tonejs/midi 解析 → Tone.Sampler 采样
// → Tone.Part 单入口调度（播放/seek 复用一次构建）→ AudioContext 时钟 → 焦点 x 绑定
// 播放/暂停、进退 10s、进度、音量、速度等控件全部由 shell/playerbar.ts 统一构建，
// 这里只负责把播放器回调转发给播放条与 3D 场景（焦点跟随 / 点亮 / 小球）。

function playerProgress(pt: number): void {
	// 播放中视觉一律由 animate() 逐帧读播放时钟驱动（避免与这里的回调抢焦点）；
	// 仅在非播放（暂停态拖进度条 / 进退）时，用播放器回传的准确位置即时刷一次。
	if (player && player.playing) return;
	const dur = player?.duration ?? 0;
	// 播放器回传的是音频秒，画面侧一律先换算成画面秒再驱动（与 animate 同一口径）
	const vt = toVisTime(pt);
	bar?.setProgress(toDisp(vt), dispTotal());
	// 自然播完时播放器先 setState('ready')（playing=false）再回传 onProgress(duration)，
	// 随后才 onEnd。此刻若再线性 setFocusX，会把镜头从末音猛拽到谱尾（用户反馈的
	// 「球一到终点线相机立刻吸附过去」）。镜头只跟主路径：末音后冻在原地，让尾球自己
	// 飞出屏幕，结束态的镜头交给 animate 的 ballEnded 分支（窗外不跟）。
	if (dur > 0 && pt >= dur - 1e-3) {
		setLitProgress(vt);
		return;
	}
	setFocusX(focusXAtTime(vt, dur), true);
	setLitProgress(vt);
}

function playerEnd(): void {
	// 播放头走完音乐 → 进度条停在结尾（不归零）：尾留白 axisTail 内球飞向终点线，
	// 动画由 animate 的 ballEnded 分支推进；重播时 togglePlay 会 seek 到留白起点归位
	bar?.setPlaying(false);
	bar?.setProgress(toDisp(toVisTime(player?.duration ?? 0)), dispTotal());
	ballEnded = true;
}

function resetPlayer(): void {
	player?.stop();
	bar?.setPlaying(false);
	bar?.setProgress(0, dispTotal());
	resetLit(); // 新谱 → 全部音符恢复黑色
	clearAllTrailHist();
}

/** 从 sessionStorage 加载 MIDI 并初始化播放器；播放源遵循设置。
 *  注释里写的「幂等」原来并不成立：player 在 await load 之前就已经赋值，
 *  第二个调用者（boot 还在采样加载时用户点了播放）走的是 `if (player) player.dispose()`
 *  分支 —— 把第一个人正在加载的实例 dispose 掉再建第二个，两边一起抢音频上下文。
 *  这里用在途 promise 合并成一次加载。 */
let playerInit: Promise<void> | null = null
async function initPlayer(): Promise<void> {
	if (playerInit) return playerInit
	playerInit = (async () => {
		const b64 = playbackMidiB64();
		if (!b64) return;
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		if (player) {
			player.dispose();
		}
		player = new MideePlayer({
			onProgress: playerProgress,
			onEnd: playerEnd,
			onState: () => bar?.setPlaying(player?.playing === true),
		});
		(window as unknown as { __mideePlayer: MideePlayer | null }).__mideePlayer =
			player;
		try {
			await player.load(bytes, sessionStorage.getItem("midee.name") ?? undefined);
			bar?.attachPlayer(); // 灌入持久化的音量 / 速度
			bar?.setProgress(0, dispTotal());
			trackPanel?.refresh();
		} catch (e) {
			console.error("player load failed:", e);
			player = null;
		}
	})()
	try {
		await playerInit
	} finally {
		playerInit = null
	}
}

async function togglePlay(): Promise<void> {
	if (!player) {
		await initPlayer();
	}
	if (!player) return;
	if (player.playing) player.pause();
	else {
		ballEnded = false; // 重新播放 → 球回到播放进度（起点线飞入）
		clearAllTrailHist();
		// 未开始（0）/已播到结尾 → 从留白起点起播：播放头先在静默段推进
		// （球正好从起点线落到首个符头），0 时刻音乐才开始响——与第三页时间线同构。
		// 静默段要随音画对齐加长：画面秒 = 播放头 + avOffset，avOffset>0 时若还只留
		// axisLead，起播第一帧画面秒就已经越过入场段的 ta → 整段起点动画被跳过、
		// 球直接出现在符头上（用户反馈的「起点动画不偏移导致音画不同步」）。
		if (
			player.duration > 0 &&
			(player.currentTime <= audioFloor() + 1e-6 ||
				player.currentTime === 0 ||
				player.currentTime >= player.duration - 0.05)
		)
			player.seek(audioFloor());
		await player.play();
	}
	bar?.setPlaying(player.playing);
}

// ═══════════════════════════════════════════════════════════════════════
// 导出：视频（WebCodecs MP4，逐帧离线渲染 + 音轨离线合成）/ 模型（GLB/OBJ/STL）
//   视频：临时切渲染分辨率 → VideoExporter 逐帧回调里定位场景并 render → 恢复；
//         音频用 Tone.OfflineContext 离线渲染（与画面分开计算），前垫 axisLead 静音对齐。
//   模型：组装一个只含「白膜 / 路径 / 小球」的临时导出根（套用 world 的 -90°X 旋转），
//         几何/material 均为新建或共享（不污染场景），导出后 dispose 新建资源。
// ═══════════════════════════════════════════════════════════════════════

function openExportDialog(): void {
	openExportModal(exportApi);
}

function exportBaseName(): string {
	const raw = sessionStorage.getItem("midee.name") ?? "lumiscore";
	const clean = raw.replace(/[\\/:*?"<>|]+/g, "_").trim();
	return clean || "lumiscore";
}

function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const exportApi: ExportApi = {
	hasScore: () => allElems.length > 0,
	captureThumbnail: () => {
		try {
			// 与实时画面一致：走选择性 bloom 后处理再抓帧（同一同步任务内，
			// preserveDrawingBuffer=false 也有效）。此前直接 renderer.render
			// 会丢掉辉光/对比度，预览图与实际画面不符。
			bloom.renderFrame();
			return renderer.domElement.toDataURL("image/png");
		} catch {
			return null;
		}
	},
	exportModel: (opts, on) => exportModelFile(opts, on),
	exportVideo: (opts, on, cancelled) => exportVideoFile(opts, on, cancelled),
	exportImage: (opts, on) => exportImageFile(opts, on),
	exportProject: async (opts, on) => {
		on("preparing", 0.2, undefined);
		await downloadProjectZip(5, {
			includeOrigMidi: opts.includeOrigMidi,
			includeMidi: opts.includeMidi,
			includeXml: opts.includeXml,
			includeConfig: opts.includeConfig,
			includePrefs: opts.includePrefs,
			includeResources: opts.includeResources,
		});
		on("finalizing", 1, undefined);
	},
};

// ── 模型导出 ──────────────────────────────────────────────────────
interface BuiltModel {
	root: THREE.Group;
	clips: THREE.AnimationClip[];
	disposables: Array<{
		geometry?: THREE.BufferGeometry;
		material?: THREE.Material | THREE.Material[];
	}>;
	/** 点亮动画数据（GLB 后处理注入 KHR_animation_pointer 用）：每颗点亮符头一条 */
	litAnim: { ti: number; on: number; off: number; color: number }[];
}

/** 一段运动在 MIDI 时间 t 时的局部位置（复刻 updateBalls 的核心，绕过视野裁剪） */
function segPosition(s: BallSeg, t: number): THREE.Vector3 {
	const dist = Math.hypot(s.bx - s.ax, s.by - s.ay);
	const span = Math.max(1e-6, s.tb - s.ta);
	const par = Math.min(1, Math.max(0, (t - s.ta) / span));
	const u = arcParamAt(segArc(s, dist), par);
	return new THREE.Vector3(
		s.ax + (s.bx - s.ax) * u,
		s.ay + (s.by - s.ay) * u,
		BALL_Z + arcHeightAt(s.kind, u, dist),
	);
}

/** 一串轨迹点 → 锥形"彗尾"管（头粗尾细，沿点序从尾到头按幂放大半径）：
 *  静态模型里代表拖尾的水滴锥。平行输运定截面方向，细点数也不会翻。 */
function cometFromPoints(
	points: THREE.Vector3[],
	rHead: number,
	power: number,
	rTail = 0.002,
): THREE.BufferGeometry | null {
	const n = points.length;
	if (n < 2) return null;
	const RAD = 8;
	const pos: number[] = [];
	const idx: number[] = [];
	const tan = new THREE.Vector3();
	const right = new THREE.Vector3();
	const up2 = new THREE.Vector3();
	for (let i = 0; i < n; i++) {
		const u = i / (n - 1);
		const r = Math.max(rTail, rHead * Math.pow(u, power));
		tan.subVectors(
			points[Math.min(n - 1, i + 1)]!,
			points[Math.max(0, i - 1)]!,
		);
		if (tan.lengthSq() < 1e-12) tan.set(1, 0, 0);
		tan.normalize();
		if (i === 0) {
			right.crossVectors(tan, _tUp);
			if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
			else right.normalize();
		} else {
			right.addScaledVector(tan, -right.dot(tan));
			if (right.lengthSq() < 1e-8) right.crossVectors(tan, _tUp);
			right.normalize();
		}
		up2.crossVectors(right, tan).normalize();
		for (let k = 0; k < RAD; k++) {
			const a = (k / RAD) * Math.PI * 2;
			const ox = Math.cos(a) * r;
			const oy = Math.sin(a) * r;
			pos.push(
				points[i]!.x + right.x * ox + up2.x * oy,
				points[i]!.y + right.y * ox + up2.y * oy,
				points[i]!.z + right.z * ox + up2.z * oy,
			);
		}
	}
	for (let i = 0; i < n - 1; i++)
		for (let k = 0; k < RAD; k++) {
			const a = i * RAD + k;
			const b = i * RAD + ((k + 1) % RAD);
			const c = (i + 1) * RAD + k;
			const d = (i + 1) * RAD + ((k + 1) % RAD);
			idx.push(a, c, b, b, c, d);
		}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

/** 分裂副球在 MIDI 时间 t 的位置（复刻 updateBalls 的 split1/split2 两段抛物线） */
function splitBallPosAt(
	sp: SplitState,
	s3: BallSeg,
	s4: BallSeg,
	t: number,
	out: THREE.Vector3,
): void {
	if (t < s4.ta) {
		const span = Math.max(1e-6, s3.tb - s3.ta);
		const par = Math.min(1, Math.max(0, (t - s3.ta) / span));
		const dC = sp.centerPos.distanceTo(sp.p3);
		const du = arcScratch("edge", dC, par);
		out.set(
			sp.p3.x + (sp.centerPos.x - sp.p3.x) * du,
			sp.p3.y + (sp.centerPos.y - sp.p3.y) * du,
			BALL_Z + arcHeightAt("edge", du, dC),
		);
	} else {
		const span = Math.max(1e-6, s4.tb - s4.ta);
		const par = Math.min(1, Math.max(0, (t - s4.ta) / span));
		const dC = sp.p5.distanceTo(sp.centerPos);
		const du = arcScratch("edge", dC, par);
		out.set(
			sp.centerPos.x + (sp.p5.x - sp.centerPos.x) * du,
			sp.centerPos.y + (sp.p5.y - sp.centerPos.y) * du,
			BALL_Z + arcHeightAt("edge", du, dC),
		);
	}
}

/** 一串轨迹点 → 细管（≥3 点走 CatmullRom；2 点退化为圆柱，用于起终点直线） */
function tubeFromPoints(points: THREE.Vector3[], radius: number): THREE.BufferGeometry {
	if (points.length >= 3) {
		const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.4);
		return new THREE.TubeGeometry(
			curve,
			Math.min(800, points.length * 2),
			radius,
			6,
			false,
		);
	}
	const [a, b] = points as [THREE.Vector3, THREE.Vector3];
	const dir = new THREE.Vector3().subVectors(b, a);
	const len = dir.length() || 1;
	const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
	geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
	const quat = new THREE.Quaternion().setFromUnitVectors(
		new THREE.Vector3(0, 1, 0),
		dir.clone().normalize(),
	);
	geo.applyQuaternion(quat);
	return geo;
}

function buildModelScene(opts: ModelExportOpts): BuiltModel {
	const disposables: BuiltModel["disposables"] = [];
	const litAnim: BuiltModel["litAnim"] = [];
	const root = new THREE.Group();
	root.name = "LumiScore";
	root.rotation.x = -Math.PI / 2; // 烘焙 world 的立式→平躺旋转

	// ① 白膜：stage 的挤出谱面。材质颜色带真实值（墨色/点亮路径色/自发光都照抄场景），
	// 导出的就是用户调好的配色，而不是一律灰白
	const meshToTarget = new Map<THREE.Object3D, number>();
	for (const [ti, list] of targetMeshes) for (const m of list) meshToTarget.set(m, ti);
	const litMatCache = new Map<number, THREE.MeshStandardMaterial>();
	if (opts.includeModel) {
		const group = new THREE.Group();
		group.name = "Score";
		for (const child of stage.children) {
			const mesh = child as THREE.Mesh;
			if (!mesh.geometry) continue;
			const isPlate = child === backplate || mesh.userData.keepVisible === true;
			const src = !Array.isArray(mesh.material)
				? (mesh.material as THREE.MeshStandardMaterial)
				: null;
			// 点亮符头：底色=墨色、自发光=0（动画的"灭"态），材质按 ti 缓存命名
			// `lit${ti}`，GLB 后处理按这个名字挂 emissiveFactor 通道
			const ti = meshToTarget.get(mesh);
			let mat: THREE.MeshStandardMaterial;
			if (ti !== undefined && litMatCache.has(ti)) {
				mat = litMatCache.get(ti)!;
			} else if (ti !== undefined) {
				mat = new THREE.MeshStandardMaterial({
					color: inkMat.color.clone(),
					roughness: 0.78,
					metalness: 0,
					side: THREE.DoubleSide,
				});
				mat.emissive = new THREE.Color(0, 0, 0);
				mat.emissiveIntensity = 0;
				mat.name = `lit${ti}`;
				litMatCache.set(ti, mat);
				disposables.push({ material: mat });
			} else {
				mat = new THREE.MeshStandardMaterial({
					color:
						src && src.color
							? src.color.clone()
							: new THREE.Color(isPlate ? 0xdfe3ea : 0xf4f4f7),
					roughness: 0.78,
					metalness: 0,
					side: THREE.DoubleSide,
				});
				if (src && src.emissive) {
					mat.emissive.copy(src.emissive);
					mat.emissiveIntensity = src.emissiveIntensity;
				}
				disposables.push({ material: mat }); // 几何与场景共享，不 dispose
			}
			const m = new THREE.Mesh(mesh.geometry, mat);
			m.position.copy(mesh.position);
			m.rotation.copy(mesh.rotation);
			m.scale.copy(mesh.scale);
			group.add(m);
		}
		root.add(group);
		// 点亮动画时刻表：与页面同一口径（单调前缀——到达时刻亮、保持到结尾）。
		// 双关键帧（on + 结尾同值）让动画时长覆盖整条时间轴，结尾不回落到灭态。
		{
			const endT = dispTotal();
			for (const ti of litMatCache.keys()) {
				const t0 = playTargets[ti]!.time + axisLead;
				if (t0 >= endT) continue;
				litAnim.push({ ti, on: t0, off: endT, color: litColorFor(ti) });
			}
		}
	}

	// ② 路径：把 THREE.Line（GLTF 不支持 line-strip、OBJ 不支持线）转成细管网格
	if (opts.includePaths) {
		const group = new THREE.Group();
		group.name = "Paths";
		// 管子粗细跟着所属路径的球大小走（球大小已逐路径一份）；
		// 起点/终点线不属于任何路径，吃全局默认半径
		const lineRadius = new Map<THREE.Object3D, number>();
		for (const bt of ballTracks)
			for (const s of bt.segs) if (s.line) lineRadius.set(s.line, ballRadiusOf(bt.pathIdx));
		for (const ch of ballGroup.children) {
			const kind = ch.userData.kind as string;
			if (kind !== "trackArc" && kind !== "startLine" && kind !== "endLine")
				continue;
			const line = ch as THREE.Line;
			const posAttr = line.geometry.getAttribute("position") as
				| THREE.BufferAttribute
				| undefined;
			if (!posAttr) continue;
			const pts: THREE.Vector3[] = [];
			for (let i = 0; i < posAttr.count; i++)
				pts.push(
					new THREE.Vector3(
						posAttr.getX(i),
						posAttr.getY(i),
						posAttr.getZ(i),
					),
				);
			if (pts.length < 2) continue;
			const lineColor = (line.material as THREE.LineBasicMaterial).color;
			const colorHex = lineColor ? lineColor.getHex() : 0x9aa3b2;
			const r = lineRadius.get(line) ?? ballRadius;
			const radius = kind === "trackArc" ? Math.max(0.008, r * 0.22) : r * 0.16;
			const geometry = tubeFromPoints(pts, radius);
			const material = new THREE.MeshStandardMaterial({
				color: colorHex,
				roughness: 0.45,
				emissive: colorHex,
				emissiveIntensity: 0.18,
			});
			group.add(new THREE.Mesh(geometry, material));
			disposables.push({ geometry, material });
		}
		root.add(group);
	}

	// ②b 拖尾：沿每段轨迹烘一根锥形"彗尾"管（头粗尾细，颜色/亮度按该路径）。
	// 拖尾本身是逐帧效果，静态模型取"沿整段路径的水滴锥"作为它的烘焙形态。
	if (opts.includeTrails) {
		const group = new THREE.Group();
		group.name = "Trails";
		const buf = new Float32Array(ARC_MAX_PTS * 3);
		for (const bt of ballTracks) {
			const color = cfgBallColor(bt.color, bt.pathIdx);
			const rHead = ballRadiusOf(bt.pathIdx) * 0.85;
			for (const s of bt.segs) {
				const n = writeSegPoints(s, buf);
				if (n < 2) continue;
				const pts: THREE.Vector3[] = [];
				for (let i = 0; i < n; i++)
					pts.push(
						new THREE.Vector3(
							buf[i * 3]!,
							buf[i * 3 + 1]!,
							buf[i * 3 + 2]!,
						),
					);
				const geo = cometFromPoints(pts, rHead, TRAIL_TAPER_POWER);
				if (!geo) continue;
				const material = new THREE.MeshStandardMaterial({
					color,
					roughness: 0.45,
					emissive: color,
					emissiveIntensity: effNum("brightBall", bt.pathIdx) * 0.12,
				});
				const tm = new THREE.Mesh(geo, material);
				tm.name = "trail";
				group.add(tm);
				disposables.push({ geometry: geo, material });
			}
		}
		root.add(group);
	}

	// ③ 小球运动关键帧：每段一个球 + 位置动画 + 时段内显示/隐藏（仅 GLB）
	const clips: THREE.AnimationClip[] = [];
	if (opts.includeBalls && opts.format === "glb") {
		const group = new THREE.Group();
		group.name = "Balls";
		// 大小/颜色/亮度都已逐路径一份 → 球几何按半径缓存，同半径的路径共用
		const geoByRadius = new Map<number, THREE.SphereGeometry>();
		const end = dispTotal();
		const tracks: THREE.KeyframeTrack[] = [];

		for (const bt of ballTracks) {
			const color = cfgBallColor(bt.color, bt.pathIdx); // 面板改过的路径色
			const r = ballRadiusOf(bt.pathIdx);
			let ballGeo = geoByRadius.get(r);
			if (!ballGeo) {
				ballGeo = new THREE.SphereGeometry(r, 20, 14);
				geoByRadius.set(r, ballGeo);
				disposables.push({ geometry: ballGeo });
			}
			const material = new THREE.MeshStandardMaterial({
				color,
				roughness: 0.32,
				emissive: color,
				emissiveIntensity: effNum("brightBall", bt.pathIdx) * 0.22,
			});
			disposables.push({ material });
			for (const s of bt.segs) {
				const ball = new THREE.Mesh(ballGeo, material);
				ball.name = "ball";
				group.add(ball);

				// 位置关键帧（显示轴时间 = 音乐 t + axisLead，与视频时间轴一致）
				const tA = s.ta + axisLead;
				const tB = Math.max(tA + 0.001, s.tb + axisLead);
				const steps = Math.max(2, Math.ceil((tB - tA) * 30));
				const pTimes: number[] = [];
				const pVals: number[] = [];
				for (let k = 0; k <= steps; k++) {
					const t = s.ta + (s.tb - s.ta) * (k / steps);
					const p = segPosition(s, t);
					pTimes.push(t + axisLead);
					pVals.push(p.x, p.y, p.z);
				}
				ball.position.copy(segPosition(s, s.ta));
				tracks.push(
					new THREE.VectorKeyframeTrack(
						"." + ball.uuid + ".position",
						pTimes,
						pVals,
					),
				);

				// 显示/隐藏：时段外 scale≈0（关键帧严格递增，用 2ms 做硬切）
				const sTimes: number[] = [];
				const sVals: number[] = [];
				const H = 0.0001;
				if (tA > 0.002) {
					sTimes.push(0, tA - 0.002);
					sVals.push(H, H, H, H, H, H);
				}
				sTimes.push(tA, tB);
				sVals.push(1, 1, 1, 1, 1, 1);
				if (tB < end - 0.002) {
					sTimes.push(tB + 0.002, end);
					sVals.push(H, H, H, H, H, H);
				}
				tracks.push(
					new THREE.VectorKeyframeTrack(
						"." + ball.uuid + ".scale",
						sTimes,
						sVals,
					),
				);
			}

			// ③b 副球（分裂分支）：p3→中心→p5 两段抛物线，与主球同刻会合。
			// 以前模型导出漏了它，画面里一拆二在 GLB 里就没了。
			const sp = bt.split;
			if (sp) {
				const s3 = bt.segs[sp.mainSeg];
				const s4 = bt.segs[sp.mainSeg2];
				if (s3 && s4) {
					const sb = new THREE.Mesh(ballGeo, material);
					sb.name = "ball";
					group.add(sb);
					const winA = s3.ta;
					const winB = Math.max(winA + 0.001, s4.tb);
					const span = winB - winA;
					const steps = Math.max(2, Math.ceil(span * 30));
					const pTimes: number[] = [];
					const pVals: number[] = [];
					const pos = new THREE.Vector3();
					for (let k = 0; k <= steps; k++) {
						const t = winA + span * (k / steps);
						splitBallPosAt(sp, s3, s4, t, pos);
						pTimes.push(t + axisLead);
						pVals.push(pos.x, pos.y, pos.z);
					}
					splitBallPosAt(sp, s3, s4, winA, pos);
					sb.position.copy(pos);
					tracks.push(
						new THREE.VectorKeyframeTrack(
							"." + sb.uuid + ".position",
							pTimes,
							pVals,
						),
					);
					// 显隐：分裂开始才出现，会合后收起（其余时段 scale≈0 硬切）
					const H0 = 0.0001;
					const sTimes2: number[] = [];
					const sVals2: number[] = [];
					const a = winA + axisLead;
					const b = winB + axisLead;
					if (a > 0.002) {
						sTimes2.push(0, a - 0.002);
						sVals2.push(H0, H0, H0, H0, H0, H0);
					}
					sTimes2.push(a, b);
					sVals2.push(1, 1, 1, 1, 1, 1);
					if (b < end - 0.002) {
						sTimes2.push(b + 0.002, end);
						sVals2.push(H0, H0, H0, H0, H0, H0);
					}
					tracks.push(
						new THREE.VectorKeyframeTrack(
							"." + sb.uuid + ".scale",
							sTimes2,
							sVals2,
						),
					);
				}
			}
		}
		root.add(group);
		if (tracks.length)
			clips.push(new THREE.AnimationClip("BallMotion", end, tracks));
	}

	return { root, clips, disposables, litAnim };
}

function runGLTF(
	root: THREE.Object3D,
	clips: THREE.AnimationClip[],
): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		new GLTFExporter().parse(
			root,
			(g) => resolve(g as ArrayBuffer),
			(err) => reject(new Error((err as ErrorEvent)?.message ?? t("ex.err.gltf"))),
			{ binary: true, animations: clips, onlyVisible: true },
		);
	});
}

async function exportModelFile(
	opts: ModelExportOpts,
	onProgress: ExportProgress,
): Promise<void> {
	if (
		!opts.includeModel &&
		!opts.includePaths &&
		!opts.includeBalls &&
		!opts.includeTrails
	)
		throw new Error(t("ex.err.pickOne"));
	onProgress("preparing", 0.1, t("ex.note.gather"));
	await yieldUI();
	const built = buildModelScene(opts);
	built.root.updateMatrixWorld(true);
	try {
		const base = exportBaseName();
		if (opts.format === "glb") {
			onProgress("finalizing", 0.35, t("ex.note.packGlb"));
			let buf = await runGLTF(built.root, built.clips);
			// 点亮动画：GLTFExporter 原生不支持 KHR_animation_pointer，后处理注入
			if (built.litAnim.length) {
				buf = injectLitAnimation(buf, built.litAnim);
				onProgress("finalizing", 0.5, t("ex.note.anim"));
			}
			downloadBlob(new Blob([buf], { type: "model/gltf-binary" }), base + ".glb");
		} else if (opts.format === "obj") {
			onProgress("finalizing", 0.6, t("ex.note.obj"));
			const txt = new OBJExporter().parse(built.root);
			downloadBlob(
				new Blob([txt], { type: "text/plain;charset=utf-8" }),
				base + ".obj",
			);
		} else {
			onProgress("finalizing", 0.6, t("ex.note.stl"));
			const txt = new STLExporter().parse(built.root);
			downloadBlob(
				new Blob([txt], { type: "text/plain;charset=utf-8" }),
				base + ".stl",
			);
		}
		onProgress("done", 1);
	} finally {
		for (const d of built.disposables) {
			d.geometry?.dispose();
			if (Array.isArray(d.material)) d.material.forEach((m) => m.dispose());
			else d.material?.dispose();
		}
	}
}

// ── 视频导出 ──────────────────────────────────────────────────────
const QUALITY_HEIGHT: Record<VideoExportOpts["quality"], number> = {
	"720p": 720,
	"1080p": 1080,
	"1440p": 1440,
	"2160p": 2160,
};
const HEIGHT_TIERS = [720, 1080, 1440, 2160];
/** 码率档（面板 低/中/高）：中 = 原自动值 */
const BITRATE_TIER_MUL: Record<VideoExportOpts["bitrateTier"], number> = {
	low: 0.6,
	mid: 1,
	high: 1.6,
};

function isLowPerf(): boolean {
	const nav = navigator as Navigator & { deviceMemory?: number };
	const cores = navigator.hardwareConcurrency ?? 8;
	const mem = nav.deviceMemory ?? 8;
	return (
		cores <= 4 ||
		mem <= 4 ||
		/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
	);
}

/** 探测某组 H.264 参数是否被当前浏览器/硬件编码支持 */
async function probeH264(
	w: number,
	h: number,
	fps: number,
	bitrate: number,
): Promise<boolean> {
	if (typeof VideoEncoder === "undefined" || !VideoEncoder.isConfigSupported)
		return false;
	try {
		const res = await VideoEncoder.isConfigSupported({
			codec: "avc1.42001f",
			width: w,
			height: h,
			bitrate,
			framerate: fps,
		});
		return !!res?.supported;
	} catch {
		return false;
	}
}

function bitrateFor(h: number, fps: number): number {
	const base =
		h <= 720
			? 6_000_000
			: h <= 1080
				? 10_000_000
				: h <= 1440
					? 18_000_000
					: 32_000_000;
	return Math.round(base * (fps >= 60 ? 1.5 : 1));
}

/** 从用户期望档位出发，按硬件能力逐级降级，返回实际可用的尺寸/帧率/码率 */
async function pickVideoConfig(
	wantH: number,
	wantFps: number,
	aspect: number,
	bitrateMul = 1,
): Promise<{ w: number; h: number; fps: number; bitrate: number; downgraded: string[] }> {
	const low = isLowPerf();
	const downgraded: string[] = [];
	const maxH = low ? Math.min(wantH, 1080) : wantH;
	const maxFps = low ? Math.min(wantFps, 30) : wantFps;
	if (low && (wantH > 1080 || wantFps > 30))
		downgraded.push("低性能设备，已封顶 1080p / 30fps");

	for (let hi = HEIGHT_TIERS.indexOf(maxH); hi >= 0; hi--) {
		const h = HEIGHT_TIERS[hi]!;
		let w = Math.round(h * aspect);
		w -= w % 2;
		if (w > 4096) w = 4096 - (4096 % 2);
		for (const fps of [maxFps, 30, 24]) {
			if (fps > maxFps) continue;
			const bitrate = Math.round(bitrateFor(h, fps) * bitrateMul);
			if (await probeH264(w, h, fps, bitrate)) {
				if (h < wantH) downgraded.push(`画质已降级到 ${h}p`);
				if (fps < wantFps) downgraded.push(`帧率已降级到 ${fps}fps`);
				return { w, h, fps, bitrate, downgraded };
			}
		}
	}
	throw new Error(t("ex.err.h264"));
}

/** 把第五页 ParsedMidi 离线渲染成 AudioBuffer（前垫 axisLead 静音，与视频画面轴对齐） */
async function renderExportAudio(
	tracks: import("./player").MidiTrack[],
	lead: number,
	musicDur: number,
	onProgress: ExportProgress,
): Promise<AudioBuffer> {
	const sampleRate = 44_100;
	const tail = 1.5;
	const total = lead + musicDur + tail;
	const raw = new OfflineAudioContext(
		2,
		Math.ceil(total * sampleRate),
		sampleRate,
	);
	const offline = new OfflineContext(raw);
	const prev = getContext();
	setContext(offline);
	try {
		const master = new Gain(0.9);
		master.connect(getDestination());
		for (const tr of tracks) {
			const inst = await createInstrument(
				tr.instrumentId,
				tr.sfName,
				tr.notes.map((n) => n.pitch),
			);
			try {
				inst.output.connect(
					master as unknown as Parameters<typeof inst.output.connect>[0],
				);
			} catch {
				/* 接线失败最坏该轨无声，不拖垮渲染 */
			}
			for (const n of tr.notes) {
				const t = n.time + lead;
				if (t >= total) continue;
				try {
					inst.triggerAttackRelease(
						midiToNoteName(n.pitch),
						n.duration,
						t,
						n.velocity,
					);
				} catch {
					/* 单音符失败跳过 */
				}
			}
		}
		// 离线渲染进度点
		if (typeof raw.suspend === "function") {
			for (let i = 1; i <= 10; i++) {
				const st = Math.min((i / 10) * total, total - 0.001);
				try {
					void raw.suspend(st).then(() => {
						onProgress("audio", i / 20 + 0.05);
						void raw.resume();
					});
				} catch {
					break;
				}
			}
		}
		const toneBuf = await offline.render();
		const native = toneBuf.get();
		if (!native) throw new Error(t("ex.err.audioEmpty"));
		return native;
	} finally {
		setContext(prev);
	}
}

/** 逐帧定位到视频时间 videoT（含首尾留白）并渲染一帧；与 animate 的更新顺序一致 */
function renderExportFrame(videoT: number, fps: number): void {
	const dur = player?.duration ?? 0;
	const t = videoT - axisLead;
	updateBalls(t);
	updateTrails(t, true);
	// 导出镜头与实时完全一致：timeline 模式复用 updateFollowFocus（跟主路径球 /
	// 起点线），free 模式保持用户视角不动。此前这里一律用 focusXAtTime 纯线性平移，
	// 导致导出的视频镜头轨迹和实时预览对不上（导出严重问题根因之一）。
	const targetX = focusXAtTime(t, dur);
	if (camMode === "timeline") updateFollowFocus(targetX, 1 / fps, t);
	setLitProgress(Math.min(Math.max(t, 0), dur));
	bgGround.position.x = focusX;
	if (surf.rt) keyLight.target.position.x = focusX * SCORE_SCALE;
	water?.update(1 / fps);
	updateFx(1 / fps);
	bloom.renderFrame(); // 导出帧同样走选择性 bloom
}

async function exportVideoFile(
	opts: VideoExportOpts,
	onProgress: ExportProgress,
	isCancelled: () => boolean,
): Promise<void> {
	const dur = player?.duration ?? 0;
	const total = dispTotal();
	if (!allElems.length) throw new Error(t("ex.noScore"));
	if (total <= 0.05) throw new Error(t("ex.err.emptyTimeline"));
	if (typeof VideoEncoder === "undefined") {
		const ios =
			/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
			(/Safari/i.test(navigator.userAgent) && !/Chrom|Edg/i.test(navigator.userAgent));
		throw new Error(t(ios ? "ex.err.webcodecsIos" : "ex.err.webcodecs"));
	}

	const cancel = () => {
		if (isCancelled()) {
			const e = new Error(t("ex.cancelled"));
			e.name = "AbortError";
			throw e;
		}
	};

	// 挂起交互播放与动画循环，独占 renderer
	player?.pause();
	const savedTime = player?.currentTime ?? 0;
	clearAllTrailHist();
	ballEnded = false;
	for (const bt of ballTracks)
		for (const b of bt.pool) b.userData.hit = false;

	const view = visibleViewRect();
	// 画面比例框（与顶栏辅助虚线同一 contain 口径，画在「顶栏以下可视区」里）：
	// source = 整个可视区；其余 = 按比例居中裁掉两边
	const rc = (() => {
		const ar = opts.ratio === "source" ? null : aspectById(opts.ratio);
		if (!ar) return { x: view.x, y: view.y, w: view.w, h: view.h };
		const c = cropRectFor(view.w, view.h, ar.ratio);
		return { x: view.x + c.x, y: view.y + c.y, w: c.w, h: c.h };
	})();
	const cfg = await pickVideoConfig(
		QUALITY_HEIGHT[opts.quality],
		opts.fps,
		rc.w / rc.h,
		BITRATE_TIER_MUL[opts.bitrateTier],
	);
	if (cfg.downgraded.length)
		console.info("[导出] 视频参数降级：", cfg.downgraded.join("；"));

	// 音频（与画面分开计算）
	let audio: AudioBuffer | undefined;
	if (opts.includeAudio && player && player.tracks.length) {
		try {
			onProgress("audio", 0.02, t("ex.note.audio"));
			audio = await renderExportAudio(
				player.tracks,
				axisLead,
				dur,
				onProgress,
			);
		} catch (e) {
			console.warn("[导出] 音频离线渲染失败，将导出无声视频：", e);
			audio = undefined;
		}
	}

	const exporter = new VideoExporter(renderer.domElement);
	const prevPixelRatio = renderer.getPixelRatio();
	exportHold = true;
	try {
		// 临时切到导出分辨率（updateStyle=false：只改 drawing buffer，不动 CSS 尺寸）
		renderer.setPixelRatio(1);
		renderer.setSize(cfg.w, cfg.h, false);
		bloom.setSize(cfg.w, cfg.h);
		// GPU 只渲染裁剪区域：全画面按 cfg.h/rc.h 等比放大后，用 viewOffset 取中间那块
		{
			const scale = cfg.h / rc.h;
			const fullW = Math.max(2, Math.round(container.clientWidth * scale));
			const fullH = Math.max(2, Math.round(container.clientHeight * scale));
			camera.aspect = fullW / fullH;
			camera.setViewOffset(
				fullW,
				fullH,
				rc.x * scale,
				rc.y * scale,
				rc.w * scale,
				rc.h * scale,
			);
		}
		camera.updateProjectionMatrix();
		clearAllTrailHist();

		onProgress(
			"video",
			0,
			`${cfg.w}×${cfg.h} · ${cfg.fps}fps${audio ? "" : t("ex.note.muted")}`,
		);
		await exporter.export({
			fps: cfg.fps,
			duration: total,
			bitrate: cfg.bitrate,
			mode: audio ? "av" : "video-only",
			...(audio ? { audio } : {}),
			filename: exportBaseName() + ".mp4",
			codec: "h264",
			onProgress: (stage: string, pct: number) => {
				if (stage.includes("audio")) onProgress("audio", 0.95, t("ex.note.encAudio"));
				else if (stage === "Encoding") onProgress("video", pct);
				else if (stage === "Done") onProgress("done", 1);
				else onProgress("finalizing", pct, t("ex.note.packMp4"));
			},
			onSeek: (time: number) => {
				cancel();
				renderExportFrame(time, cfg.fps);
			},
			onRenderFrame: async (time: number) => {
				cancel();
				// 隔帧让出一次主线程，使进度条/取消可响应（不至于把导出拖慢太多）
				if (Math.round(time * cfg.fps) % 2 === 0) await yieldUI();
			},
		});
		onProgress("done", 1);
	} catch (e) {
		if (isCancelled()) {
			try {
				exporter.cancel(); // 主动关闭编码器，避免 abort 后仍在排队
			} catch {
				/* noop */
			}
		}
		throw e;
	} finally {
		exportHold = false;
		camera.clearViewOffset(); // 裁剪偏移只属于本次导出，必须摘掉
		renderer.setPixelRatio(prevPixelRatio);
		resize();
		clearAllTrailHist();
		for (const bt of ballTracks)
			for (const b of bt.pool) b.userData.hit = false;
		ballEnded = false;
		player?.seek(savedTime);
		player?.pause();
		updateBalls(Math.min(savedTime, dur));
	}
}

/**
 * 当前画面图片导出：把可视区（或按比例居中裁剪后的区域）以 DPI 倍率
 * 直接渲染成 PNG。做法与视频导出同源——临时放大 drawing buffer、
 * 用 viewOffset 只渲染裁剪区，再同步 toDataURL 抓帧（保证与实时画面
 * 完全一致，含 bloom 后处理）。
 */
async function exportImageFile(
	opts: ImageExportOpts,
	onProgress: ExportProgress,
): Promise<void> {
	if (!allElems.length) throw new Error(t("ex.noScore"));

	const savedTime = player?.currentTime ?? 0;
	player?.pause();

	const view = visibleViewRect();
	// 画面比例：source = 整个可视区；其余 = 按比例居中裁掉两边（与视频同一口径）
	const rc = (() => {
		const ar = opts.ratio === "source" ? null : aspectById(opts.ratio);
		if (!ar) return { x: view.x, y: view.y, w: view.w, h: view.h };
		const c = cropRectFor(view.w, view.h, ar.ratio);
		return { x: view.x + c.x, y: view.y + c.y, w: c.w, h: c.h };
	})();

	// DPI 以 96 为 1×；输出像素 = 可视区 CSS 像素 × 倍率
	const mul = Math.max(1, opts.dpi / 96);
	const maxDim = Math.min(8192, renderer.capabilities.maxTextureSize || 8192);
	let outW = Math.max(2, Math.round(rc.w * mul));
	let outH = Math.max(2, Math.round(rc.h * mul));
	if (outW > maxDim || outH > maxDim) {
		// 超显卡上限时等比缩到上限（避免 toDataURL 出空白图）
		const k = Math.min(maxDim / outW, maxDim / outH);
		outW = Math.max(2, Math.floor(outW * k));
		outH = Math.max(2, Math.floor(outH * k));
	}

	const prevPixelRatio = renderer.getPixelRatio();
	const prevTrailX = trailResolution.x;
	const prevTrailY = trailResolution.y;
	exportHold = true; // 独占 renderer，暂停实时动画循环
	try {
		onProgress("preparing", 0.25, `${outW}×${outH}`);
		renderer.setPixelRatio(1);
		renderer.setSize(outW, outH, false);
		bloom.setSize(outW, outH);
		trailResolution.set(outW, outH);
		{
			const scale = outH / rc.h;
			const fullW = Math.max(2, Math.round(container.clientWidth * scale));
			const fullH = Math.max(2, Math.round(container.clientHeight * scale));
			camera.aspect = fullW / fullH;
			camera.setViewOffset(
				fullW,
				fullH,
				rc.x * scale,
				rc.y * scale,
				rc.w * scale,
				rc.h * scale,
			);
		}
		camera.updateProjectionMatrix();

		// 与实时画面一致：走选择性 bloom 后处理再同步抓帧
		bloom.renderFrame();
		const dataUrl = renderer.domElement.toDataURL("image/png");
		onProgress("finalizing", 0.9, t("ex.note.packImage"));
		const blob = await (await fetch(dataUrl)).blob();
		downloadBlob(blob, exportBaseName() + ".png");
		onProgress("done", 1);
	} finally {
		exportHold = false;
		camera.clearViewOffset();
		renderer.setPixelRatio(prevPixelRatio);
		trailResolution.set(prevTrailX, prevTrailY);
		resize();
		clearAllTrailHist();
		player?.seek(savedTime);
		player?.pause();
		updateBalls(Math.min(savedTime, player?.duration ?? savedTime));
	}
}


// 装配完成上报：模块顶层求值到此全部走完。中途抛错时这两行不会执行，
// index.html 里的内联看门狗据此把「本页控件没装上」显式报出来（横幅 + 修复页签自检项），
// 而不是留下「页面看着正常、下拉全没了」的静默半初始化状态。
const reportAssembled = (window as unknown as { __lumiReady?: () => void })
	.__lumiReady;
reportAssembled?.();
