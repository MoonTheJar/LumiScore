// ── 第 5 页材质系统 ───────────────────────────────────────────
// 预设：金属 / 纸张 / 木头 / 瓷砖（背景、乐谱、小球通用）
//       玻璃（仅乐谱、小球）；水面是背景专属，另见 water3d.ts。
// 全部走 PBR（MeshStandard/Physical）+ PMREM 室内环境贴图：金属与玻璃靠环境
// 反射才不会发黑。
// v2 架构：每个对象组（乐谱 / 背景 / 小球）持有一份独立的 ObjMatConfig
// （来源=预设或网络贴图、预设名、贴图 id、颜色着色），组内所有 mesh 的材质
// 都由这份配置派生——组内一起变、组间互不冲突；改滑杆/预设不会再把已应用的
// 网络贴图冲掉（重建后自动从缓存恢复贴图）。
import * as THREE from "three";

export type SurfacePreset = "metal" | "paper" | "wood" | "tile" | "flat";
export type AnyPreset = SurfacePreset | "glass";
export type MatObject = "score" | "ground" | "ball";

interface PresetDef {
	label: string;
	base: number; // 底板/大面积底色
	ink: number; // 音符深色
	roughness: number;
	metalness: number;
	glass?: boolean;
}

export const PRESET_DEFS: Record<SurfacePreset, PresetDef> = {
	metal: {
		label: "金属",
		base: 0xc7d0d8,
		ink: 0x5a646e,
		roughness: 0.22,
		metalness: 1,
	},
	paper: {
		label: "纸张",
		base: 0xf3eee3,
		ink: 0x1a1a1a,
		roughness: 0.92,
		metalness: 0,
	},
	wood: {
		label: "木头",
		base: 0x8a5a33,
		ink: 0x3d2713,
		roughness: 0.68,
		metalness: 0.05,
	},
	tile: {
		label: "瓷砖",
		base: 0xe9edf0,
		ink: 0x2b3239,
		roughness: 0.16,
		metalness: 0.02,
	},
	flat: {
		label: "纯色",
		base: 0x9aa7b5,
		ink: 0x1a1a1a,
		roughness: 1,
		metalness: 0,
	},
};
export const GLASS_DEF: PresetDef = {
	label: "玻璃",
	base: 0xbfe0ee,
	ink: 0x2f5d72,
	roughness: 0.06,
	metalness: 0,
	glass: true,
};

/** 材质物理参数微调（设置面板滑杆；字段为 undefined 时沿用预设默认值） */
export interface MatOverrides {
	roughness?: number;
	metalness?: number;
	/** 玻璃/透明材质的不透明度 0-1（越大越不透明） */
	opacity?: number;
	/** 底色着色（覆盖预设默认色）；undefined = 预设默认 */
	color?: number;
}

/** 每个对象（乐谱/地面/小球）独立保存的材质物理参数 */
export interface MatTune {
	rough: number;
	metal: number;
	/** 玻璃材质的不透明度 0-1（越大越不透明）；非玻璃材质忽略 */
	trans: number;
}

/** 单个对象组的完整材质配置（设置面板「材质」页驱动；三组互不影响） */
export interface ObjMatConfig {
	/** 预设材质 / 网络贴图（Poly Haven） */
	source: "preset" | "network";
	preset: AnyPreset;
	/** 网络模式选中的贴图 id（polyhaven asset id） */
	tex: string;
	/** 底色着色；null = 跟随预设默认（网络贴图时默认白色，让贴图原色显示） */
	color: number | null;
	/** 仅乐谱组：音符/谱线（墨色）着色；null = 跟随预设（网络贴图时默认白色） */
	inkColor: number | null;
	/** 网络贴图 1:1 等比覆盖缩放（= 平铺重复次数） */
	texScale: number;
}

export function defaultObjMat(preset: AnyPreset): ObjMatConfig {
	return {
		source: "preset",
		preset,
		tex: "",
		color: null,
		inkColor: null,
		texScale: 4,
	};
}

/** 某预设的默认物理参数（切换预设时重置滑杆用） */
export function presetDefaultTune(preset: AnyPreset): MatTune {
	const d = defOf(preset);
	return { rough: d.roughness, metal: d.metalness, trans: d.glass ? 0.55 : 1 };
}

let envTexture: THREE.Texture | null = null;

/** 生成一次 PMREM 环境贴图（金属反射/玻璃折射的照明来源）。
 * 用自绘等距柱状画布（柔光渐变 + 大半径软光斑）替代 RoomEnvironment：
 * 后者的 5 个内点光源经 PMREM 烘焙后会在地面反射出尖锐的五点白斑。 */
export function ensureEnvironment(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
): void {
	if (envTexture) return;
	try {
		const src = makeStudioEnvCanvasTexture();
		const pmrem = new THREE.PMREMGenerator(renderer);
		const rt = pmrem.fromEquirectangular(src);
		envTexture = rt.texture;
		scene.environment = envTexture;
		pmrem.dispose();
		src.dispose();
	} catch (err) {
		console.warn("[材质] 环境贴图生成失败，金属/玻璃反射会较弱：", err);
	}
}

/** 重置环境贴图（渲染器重建 / WebGL 上下文丢失后，旧 PMREM 与新上下文不兼容，
 * 必须清除后由 ensureEnvironment 重新烘焙） */
export function resetEnvironment(scene: THREE.Scene): void {
	if (envTexture) {
		envTexture.dispose();
		envTexture = null;
	}
	scene.environment = null;
}

/** 程序化等距柱状软光环境：上亮下暗的柔光渐变 + 三盏大半径「柔光箱」光斑
 * （顶光 / 右侧辅光 / 地面暖色反弹），均为大半径径向渐变，烘焙后无锐利高光点 */
function makeStudioEnvCanvasTexture(): THREE.Texture {
	const W = 1024;
	const H = 512;
	const cv = document.createElement("canvas");
	cv.width = W;
	cv.height = H;
	const g = cv.getContext("2d")!;
	// 底色：天花板亮 → 地平线灰 → 地面暗
	const base = g.createLinearGradient(0, 0, 0, H);
	base.addColorStop(0, "#98a3c2");
	base.addColorStop(0.42, "#4a5266");
	base.addColorStop(0.58, "#333945");
	base.addColorStop(1, "#1c1f28");
	g.fillStyle = base;
	g.fillRect(0, 0, W, H);
	// 柔光斑：径向渐变中心亮、边缘完全透明（大半径 → 反射里是柔和高光而非锐点）
	const blob = (
		x: number,
		y: number,
		r: number,
		rgb: string,
		a: number,
	): void => {
		const rg = g.createRadialGradient(x, y, 0, x, y, r);
		rg.addColorStop(0, `rgba(${rgb},${a})`);
		rg.addColorStop(1, "rgba(0,0,0,0)");
		g.fillStyle = rg;
		g.fillRect(0, 0, W, H);
	};
	// 主柔光箱（顶部偏左，冷白，大幅照亮）
	blob(W * 0.30, H * 0.16, W * 0.55, "255,250,240", 0.95);
	// 辅光（右侧偏中，柔和）
	blob(W * 0.82, H * 0.46, W * 0.60, "215,225,250", 0.55);
	// 地面反弹（下方暖色，浅浅一层）
	blob(W * 0.50, H * 0.95, W * 0.75, "190,160,120", 0.30);
	const tex = new THREE.CanvasTexture(cv);
	tex.mapping = THREE.EquirectangularReflectionMapping;
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

function standard(
	p: PresetDef,
	color: number,
	opts: {
		transparent?: boolean | undefined;
		opacity?: number | undefined;
		emissive?: number | undefined;
		emissiveIntensity?: number | undefined;
		overrides?: MatOverrides | undefined;
	} = {},
): THREE.MeshStandardMaterial {
	const ov = opts.overrides ?? {};
	const roughness = ov.roughness ?? p.roughness;
	const metalness = ov.metalness ?? p.metalness;
	const m = p.glass
		? new THREE.MeshPhysicalMaterial({
				color,
				roughness,
				metalness,
				transmission: 0.85,
				thickness: 0.06,
				ior: 1.45,
				transparent: true,
				opacity: ov.opacity ?? opts.opacity ?? 0.55,
				envMapIntensity: 1.2,
				side: THREE.DoubleSide,
			})
		: new THREE.MeshStandardMaterial({
				color,
				roughness,
				metalness,
				envMapIntensity: 0.9,
				side: THREE.DoubleSide,
				transparent: opts.transparent ?? false,
				opacity: ov.opacity ?? opts.opacity ?? 1,
			});
	if (opts.emissive !== undefined) {
		m.emissive = new THREE.Color(opts.emissive);
		m.emissiveIntensity = opts.emissiveIntensity ?? 1;
	}
	return m;
}

function defOf(preset: AnyPreset): PresetDef {
	return preset === "glass" ? GLASS_DEF : PRESET_DEFS[preset];
}

export function baseColorOf(preset: AnyPreset): number {
	return defOf(preset).base;
}
export function inkColorOf(preset: AnyPreset): number {
	return defOf(preset).ink;
}
export function isGlassPreset(preset: AnyPreset): boolean {
	return defOf(preset).glass === true;
}

/** 底板材质（乐谱底面/背景面） */
export function makeBaseMaterial(
	preset: AnyPreset,
	overrides?: MatOverrides,
): THREE.MeshStandardMaterial {
	const d = defOf(preset);
	const color = overrides?.color ?? d.base;
	return standard(d, color, { overrides });
}
/** 音符/谱线材质（同质感深色） */
export function makeInkMaterial(
	preset: AnyPreset,
	overrides?: MatOverrides,
): THREE.MeshStandardMaterial {
	const d = defOf(preset);
	const color = overrides?.color ?? d.ink;
	return standard(d, color, { overrides });
}
/** 小球材质（轨色 + 质感 + 发光强度）；flat=纯色 MeshBasicMaterial 无光照（测试页同款） */
export function makeBallMaterial(
	preset: AnyPreset,
	colorHex: number,
	glow: number,
	overrides?: MatOverrides,
): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial {
	if (preset === "flat") {
		// 测试页同款：纯色 + 自发光（bloom 发光靠颜色亮度，emissive 兜底照亮）
		const c = overrides?.color ?? colorHex;
		return new THREE.MeshBasicMaterial({
			color: c,
		});
	}
	const d = defOf(preset);
	return standard(d, colorHex, {
		emissive: colorHex,
		emissiveIntensity: glow,
		opacity: d.glass ? 0.7 : 1,
		transparent: d.glass,
		overrides,
	});
}
/** 点亮音符材质（轨色，保持乐谱质感参数） */
export function makeLitMaterial(
	preset: AnyPreset,
	colorHex: number,
	glow: number,
	overrides?: MatOverrides,
): THREE.MeshStandardMaterial {
	const d = defOf(preset);
	return standard(d, colorHex, {
		emissive: colorHex,
		emissiveIntensity: glow,
		overrides,
	});
}

/** 读取某预设的物理参数默认值（用于设置面板滑杆初始化） */
export function presetParam(
	preset: AnyPreset,
	key: "roughness" | "metalness",
): number {
	return defOf(preset)[key];
}

/** 把贴图集打到单个 PBR 材质上（diff/normal/rough）；不动物理参数（粗糙度/金属度滑杆继续生效，
 *  roughnessMap 与 roughness 相乘、map 与 color 相乘都是 three 标准行为） */
export function stampTexSet(
	m: THREE.Material | null | undefined,
	set: TexSetRef,
): void {
	if (!m || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
	const sm = m as THREE.MeshStandardMaterial;
	sm.map = set.diff;
	sm.normalMap = set.nor;
	sm.roughnessMap = set.rough;
	sm.needsUpdate = true;
}
/** 去掉单材质上的贴图（切回预设模式时用；颜色/参数由重建逻辑负责） */
export function clearTexSet(m: THREE.Material | null | undefined): void {
	if (!m || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
	const sm = m as THREE.MeshStandardMaterial;
	sm.map = null;
	sm.normalMap = null;
	sm.roughnessMap = null;
	sm.needsUpdate = true;
}

/** 贴图集引用（main.ts 的缓存加载后传入；避免本模块反向依赖加载器） */
export interface TexSetRef {
	id: string;
	diff: THREE.Texture;
	nor: THREE.Texture;
	rough: THREE.Texture;
}

export const SURFACE_OPTIONS: { value: AnyPreset; label: string }[] = [
	{ value: "metal", label: "金属" },
	{ value: "paper", label: "纸张" },
	{ value: "wood", label: "木头" },
	{ value: "tile", label: "瓷砖" },
];
export const SCORE_BALL_OPTIONS: { value: AnyPreset; label: string }[] = [
	...SURFACE_OPTIONS,
	{ value: "glass", label: "玻璃" },
];
