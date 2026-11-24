// GLB 后处理：注入点亮符头的发光动画（KHR_animation_pointer）。
// three r186 的 GLTFExporter 不支持该扩展（动画通道只能指向节点属性），所以这里
// 直接改 glTF JSON + 重排二进制块：每颗点亮符头一个材质（`lit${ti}` 命名），
// emissiveFactor 两帧 STEP —— 到达时刻亮（路径色），亮窗离开时刻灭（0）。
// 静止底色已是灭态（见 buildModelScene 的 lit 材质缓存）。
import { Color } from "three";

export interface LitAnimEntry {
	/** playTarget 下标；对应导出材质名 `lit${ti}` */
	ti: number;
	on: number;
	off: number;
	color: number;
}

const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"

export function injectLitAnimation(
	glb: ArrayBuffer,
	anims: LitAnimEntry[],
): ArrayBuffer {
	if (!anims.length || glb.byteLength < 20) return glb;
	const view = new DataView(glb);
	// GLB 头：[0] magic [4] version [8] 总长 [12] chunk0 长度 [16] chunk0 类型 "JSON"
	if (view.getUint32(16, true) !== JSON_CHUNK) return glb;
	const jsonLen = view.getUint32(12, true);
	const json = JSON.parse(
		new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)),
	) as {
		materials?: { name?: string }[];
		animations?: {
			name?: string;
			channels: unknown[];
			samplers: { input: number; output: number; interpolation?: string }[];
		}[];
		accessors?: unknown[];
		bufferViews?: unknown[];
		buffers?: { byteLength: number }[];
		extensionsUsed?: string[];
	};

	// BIN 块（可能不存在）
	let bin = new Uint8Array(0);
	{
		const off = 20 + jsonLen;
		if (off + 8 <= glb.byteLength) {
			const len = view.getUint32(off, true);
			if (view.getUint32(off + 4, true) === BIN_CHUNK)
				bin = new Uint8Array(glb, off + 8, len);
		}
	}

	// 材质名 → 下标
	const matIdx = new Map<string, number>();
	(json.materials ?? []).forEach((m, i) => {
		if (m.name) matIdx.set(m.name, i);
	});

	// 追加的二进制：每条通道 input[on,off] + output[rgb,000]，float32 小端
	const floats: number[] = [];
	const layout: {
		inOff: number;
		outOff: number;
		on: number;
		off: number;
		matIndex: number;
	}[] = [];
	const usedMat = new Set<number>();
	for (const a of anims) {
		const matIndex = matIdx.get(`lit${a.ti}`);
		if (matIndex === undefined || usedMat.has(matIndex)) continue;
		usedMat.add(matIndex);
		const c = new Color(a.color); // 与 GLTFExporter 同口径：线性空间直出
		const inOff = floats.length * 4;
		floats.push(a.on, a.off);
		const outOff = floats.length * 4;
		floats.push(c.r, c.g, c.b, 0, 0, 0);
		layout.push({ inOff, outOff, on: a.on, off: a.off, matIndex });
	}
	if (!layout.length) return glb;

	const binPad = (4 - (bin.length % 4)) % 4;
	const extraStart = bin.length + binPad;
	const extraBytes = new Uint8Array(floats.length * 4);
	const dv = new DataView(extraBytes.buffer);
	floats.forEach((f, i) => dv.setFloat32(i * 4, f, true));
	const newBin = new Uint8Array(extraStart + extraBytes.length);
	newBin.set(bin, 0);
	newBin.set(extraBytes, extraStart);

	const bufferViews = (json.bufferViews = json.bufferViews ?? []);
	const accessors = (json.accessors = json.accessors ?? []);
	const baseView = bufferViews.length;
	const baseAcc = accessors.length;
	const samplers: { input: number; output: number; interpolation: string }[] = [];
	const channels: unknown[] = [];
	layout.forEach((l, k) => {
		bufferViews.push({ buffer: 0, byteOffset: extraStart + l.inOff, byteLength: 8 });
		const accIn = baseAcc + k * 2;
		accessors.push({
			bufferView: baseView + k * 2,
			componentType: 5126,
			count: 2,
			type: "SCALAR",
			min: [l.on],
			max: [l.off],
		});
		bufferViews.push({
			buffer: 0,
			byteOffset: extraStart + l.outOff,
			byteLength: 24,
		});
		const accOut = baseAcc + k * 2 + 1;
		accessors.push({
			bufferView: baseView + k * 2 + 1,
			componentType: 5126,
			count: 2,
			type: "VEC3",
		});
		samplers.push({ input: accIn, output: accOut, interpolation: "STEP" });
		// pointer 指向缺省属性（emissiveFactor 默认 [0,0,0]）对合规阅读器是合法的
		channels.push({
			sampler: k,
			target: {
				extensions: {
					KHR_animation_pointer: {
						pointer: `/materials/${l.matIndex}/emissiveFactor`,
					},
				},
			},
		});
	});

	json.animations = json.animations ?? [];
	json.animations.push({ name: "LitMotion", channels, samplers });
	json.extensionsUsed = [
		...new Set([...(json.extensionsUsed ?? []), "KHR_animation_pointer"]),
	];
	if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length;

	// ── 重新封装 GLB（JSON 块空格补 4 字节对齐，BIN 块 0 补齐） ──
	const enc = new TextEncoder().encode(JSON.stringify(json));
	const jsonPad = (4 - (enc.length % 4)) % 4;
	const jsonChunkLen = enc.length + jsonPad;
	const total = 12 + 8 + jsonChunkLen + 8 + newBin.length;
	const out = new ArrayBuffer(total);
	const ov = new DataView(out);
	const ou8 = new Uint8Array(out);
	ov.setUint32(0, 0x46546c67, true); // "glTF"
	ov.setUint32(4, 2, true);
	ov.setUint32(8, total, true);
	ov.setUint32(12, jsonChunkLen, true);
	ov.setUint32(16, JSON_CHUNK, true);
	ou8.set(enc, 20);
	for (let i = 0; i < jsonPad; i++) ou8[20 + enc.length + i] = 0x20;
	let off = 20 + jsonChunkLen;
	ov.setUint32(off, newBin.length, true);
	ov.setUint32(off + 4, BIN_CHUNK, true);
	ou8.set(newBin, off + 8);
	return out;
}
