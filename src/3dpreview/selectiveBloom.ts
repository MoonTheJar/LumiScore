// ── 选择性 Bloom（照测试台「环形轨迹小球基础场景.html」的四源结构移植）────────
// 全局 UnrealBloomPass 会把整幅画面（含白底）当光源，加色合成后把符头颜色糊掉。
// 这里改成：只有登记过的材质进发光缓冲，再与正常画面加色合成。
//
// 四条源：小球(含拖尾) / 点亮符头 / 底面 / 背景天空。
// 每条源两条滑轨：「亮度」改它在正式画面里的颜色，「光效」只改它在发光缓冲里的
// HDR 倍率（倍率 = 1 + 光效 × GLOW_GAIN），因此两者互不干扰。
// 光效为 0 的源会被置黑后才进发光缓冲 —— 不是跳过它：跳过的话它原本的亮度会直接
// 漏进缓冲，白底/亮底场景下等于把整幅糊成纯白（测试台实测：天空 100% + 光效 0.5
// → 全帧白；底面进缓冲时轨道线被提亮到白，等于擦掉谱面）。
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/** 发光层：只有该层上的物体参与 bloom pass */
export const BLOOM_LAYER = 1;

/** 光效权重 → 发光缓冲里的 HDR 倍率增益 */
const GLOW_GAIN = 3;

/** 发光缓冲的明度口径（与 UnrealBloom 高通 / peakLuma 一致：Rec.601 luma）。
 *  红/暖色 luma≈0.3、纯蓝 luma≈0.11——同一光效下两者亮度差近 3 倍，高阈值时
 *  暖色过阈值出光晕、冷色被滤掉，这就是左右手光晕不一致的根因。 */
function bloomLuma(c: THREE.Color | undefined): number {
	return c ? 0.299 * c.r + 0.587 * c.g + 0.114 * c.b : 0;
}

export type GlowSource = "ball" | "lit" | "ground";

/** 一条要进发光缓冲的材质 + 它自己的光效权重。
 *  同一条源里不同材质可以不同（小球/点亮都能按路径各一份）。 */
export interface GlowMat {
	mat: THREE.Material;
	w: number;
}

/** 带自发光的那类材质（MeshStandardMaterial）；拖尾等 MeshBasicMaterial 没有 emissive */
type MaybeEmissive = THREE.Material & Partial<THREE.MeshStandardMaterial>;

export interface SelectiveBloom {
	/** 四条源的光效权重（0~1），由设置面板驱动 */
	glow: Record<GlowSource | "sky", number>;
	/** 一帧：发光缓冲 → 还原材质 → 正常画面 + 加色合成 */
	renderFrame: () => void;
	setSize: (w: number, h: number) => void;
	setParams: (p: {
		strength?: number;
		radius?: number;
		threshold?: number;
	}) => void;
	params: () => { strength: number; radius: number; threshold: number };
	/** 发光缓冲里本帧最亮源的亮度（高通着色器同一口径）。
	 *  阈值高于它 = bloom 整层输出纯黑，strength/radius 全成空转——自动阈值靠这个数判定。 */
	peakLuma: () => number;
	/** 释放两个 composer 的渲染目标；renderer 被重建（切换设备）后必须调用 */
	dispose: () => void;
}

const BloomMixShader = {
	uniforms: { tBase: { value: null }, tBloom: { value: null } },
	vertexShader: /* glsl */ `
		varying vec2 vUv;
		void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
	fragmentShader: /* glsl */ `
		uniform sampler2D tBase;
		uniform sampler2D tBloom;
		varying vec2 vUv;
		void main() {
			vec4 b = texture2D(tBloom, vUv);
			vec4 s = texture2D(tBase, vUv);
			gl_FragColor = vec4(s.rgb + b.rgb, 1.0);
		}`,
};

/** 一帧内被改写的材质 + 还原所需信息 */
type GlowShot = {
	mat: MaybeEmissive;
	color: THREE.Color;
	emissive: THREE.Color | undefined;
	emissiveIntensity: number;
};

export function createSelectiveBloom(opts: {
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	camera: THREE.Camera;
	width: number;
	height: number;
	/** 某条源本帧要发光的材质 + 各自光效权重（小球/点亮可按路径不同） */
	matsOf: (which: GlowSource) => Iterable<GlowMat>;
}): SelectiveBloom {
	const { renderer, scene, camera, matsOf } = opts;
	const glow: Record<GlowSource | "sky", number> = {
		ball: 0,
		lit: 0,
		ground: 0,
		sky: 0,
	};

	// 相机同时看普通层与发光层
	camera.layers.enable(BLOOM_LAYER);

	const bloomComposer = new EffectComposer(renderer);
	bloomComposer.renderToScreen = false;
	const bloomRenderPass = new RenderPass(scene, camera);
	bloomRenderPass.clearAlpha = 1;
	bloomComposer.addPass(bloomRenderPass);
	const bloomPass = new UnrealBloomPass(
		new THREE.Vector2(opts.width, opts.height),
		1,
		0.5,
		0.25,
	);
	bloomComposer.addPass(bloomPass);

	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	const mixPass = new ShaderPass(BloomMixShader, "tBase");
	const tBloom = mixPass.uniforms["tBloom"] as THREE.IUniform;
	tBloom.value = bloomComposer.renderTarget2.texture;
	composer.addPass(mixPass);

	/** 把三类发光源的颜色按各自光效写进材质，返回还原所需的原始值 */
	function boostBloomColors(): GlowShot[] {
		const shots: GlowShot[] = [];
		const seen = new Set<THREE.Material>();
		for (const which of ["ball", "lit", "ground"] as GlowSource[]) {
			for (const g of matsOf(which)) {
				const raw = g.mat;
				if (seen.has(raw)) continue;
				seen.add(raw);
				const w = g.w; // 逐材质的光效权重（同一条源里也能不同）
				const f = 1 + w * GLOW_GAIN;
				const mat = raw as MaybeEmissive;
				const shot: GlowShot = {
					mat,
					color: mat.color?.clone() ?? new THREE.Color(),
					emissive: mat.emissive?.clone(),
					emissiveIntensity: mat.emissiveIntensity ?? 1,
				};
				shots.push(shot);
				if (w <= 0) {
					// 光效 0：置黑，完全不进发光缓冲
					mat.color?.setRGB(0, 0, 0);
					mat.emissive?.setRGB(0, 0, 0);
					if (mat.emissiveIntensity !== undefined) mat.emissiveIntensity = 0;
					continue;
				}
				// 颜色明度归一化：发光缓冲里的亮度只由光效 f 决定，与色相无关。
				// 只缩放量、不改 RGB 比例 → 色相保留（光晕仍是各自颜色），但各色亮度一致。
				// 修复左右手（路径色不同）同一光效下光晕强弱不一致：暖色过阈值、冷色被滤掉。
				const normColor = 1 / Math.max(bloomLuma(shot.color), 1e-4);
				mat.color?.copy(shot.color).multiplyScalar(f * normColor);
				if (mat.emissive && shot.emissive) {
					const normEm = 1 / Math.max(bloomLuma(shot.emissive), 1e-4);
					mat.emissive.copy(shot.emissive).multiplyScalar(normEm);
					mat.emissiveIntensity = shot.emissiveIntensity * f;
				}
			}
		}
		return shots;
	}

	/** 用提亮前抓下的原始值还原（必须拿 boostBloomColors 的返回值，不能二次采样） */
	function restoreBloomColors(shots: GlowShot[]): void {
		for (const s of shots) {
			if (s.mat.color) s.mat.color.copy(s.color);
			if (s.mat.emissive && s.emissive) s.mat.emissive.copy(s.emissive);
			if (s.mat.emissiveIntensity !== undefined)
				s.mat.emissiveIntensity = s.emissiveIntensity;
		}
	}

	function renderFrame(): void {
		const shots = boostBloomColors();
		const prevBg = scene.background;
		const prevMask = camera.layers.mask;
		// 天空：开了光效才把背景色当发光缓冲的底色，否则一律黑底
		bloomRenderPass.clearColor =
			glow.sky > 0 && prevBg instanceof THREE.Color
				? prevBg.clone().multiplyScalar(1 + glow.sky * GLOW_GAIN)
				: new THREE.Color(0x000000);
		scene.background = null; // 否则 three 会用背景色清屏，盖掉上面的 clearColor
		camera.layers.mask = 1 << BLOOM_LAYER;
		bloomComposer.render();

		restoreBloomColors(shots);
		scene.background = prevBg;
		camera.layers.mask = prevMask;

		tBloom.value = bloomComposer.renderTarget2.texture;
		composer.render();
	}

	return {
		glow,
		renderFrame,
		setSize: (w, h) => {
			bloomComposer.setSize(w, h);
			composer.setSize(w, h);
		},
		setParams: (p) => {
			if (p.strength !== undefined) bloomPass.strength = p.strength;
			if (p.radius !== undefined) bloomPass.radius = p.radius;
			if (p.threshold !== undefined) bloomPass.threshold = p.threshold;
		},
		params: () => ({
			strength: bloomPass.strength,
			radius: bloomPass.radius,
			threshold: bloomPass.threshold,
		}),
		peakLuma: () => {
			// 与 boostBloomColors 同一算法，但不写回材质：只算「进缓冲后会多亮」
			let peak = 0;
			for (const which of ["ball", "lit", "ground"] as GlowSource[]) {
				for (const g of matsOf(which)) {
					if (g.w <= 0) continue; // 光效 0 会被置黑，根本不进缓冲
					const f = 1 + g.w * GLOW_GAIN;
					const m = g.mat as MaybeEmissive;
					// 与 boostBloomColors 同口径：颜色已按 luma 归一化，
					// color 贡献恒为 f、emissive 贡献恒为 ei×f，与色相无关。
					peak = Math.max(peak, f, (m.emissiveIntensity ?? 0) * f);
				}
			}
			// 天空：背景色被当光源加回时的亮度
			if (glow.sky > 0 && scene.background instanceof THREE.Color) {
				const c = scene.background;
				peak = Math.max(
					peak,
					(0.299 * c.r + 0.587 * c.g + 0.114 * c.b) * (1 + glow.sky * GLOW_GAIN),
				);
			}
			return peak;
		},
		dispose: () => {
			bloomPass.dispose();
			mixPass.dispose();
			bloomComposer.dispose();
			composer.dispose();
		},
	};
}
