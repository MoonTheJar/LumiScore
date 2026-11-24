// 画面比例：顶栏辅助虚线与视频导出裁剪共用同一张表、同一个"居中裁剪"口径。
// 辅助线本身只做参考，不参与任何导出；导出按同一 contain 规则裁掉两边。

export interface AspectRatio {
	id: string;
	/** 宽高比（w/h） */
	ratio: number;
	/** 辅助虚线颜色（写死，用户口径） */
	color: string;
}

export const ASPECT_RATIOS: AspectRatio[] = [
	{ id: "4:3", ratio: 4 / 3, color: "#FF6B35" },
	{ id: "16:9", ratio: 16 / 9, color: "#00A8FF" },
	{ id: "1.85:1", ratio: 1.85, color: "#2ECC71" },
	{ id: "2.39:1", ratio: 2.39, color: "#00B894" },
	{ id: "1:1", ratio: 1, color: "#95A5A6" },
	{ id: "9:16", ratio: 9 / 16, color: "#005B96" },
	{ id: "3:4", ratio: 3 / 4, color: "#A04000" },
	{ id: "4:5", ratio: 4 / 5, color: "#9B59B6" },
];

export function aspectById(id: string): AspectRatio | undefined {
	return ASPECT_RATIOS.find((r) => r.id === id);
}

/** 居中裁剪框：让裁剪画面至少两条对边贴满画布，另两条对边之外的是裁掉的。
 *  返回相对画布（0..w, 0..h）的矩形。 */
export function cropRectFor(
	w: number,
	h: number,
	ratio: number,
): { x: number; y: number; w: number; h: number } {
	const canvasRatio = w / Math.max(1e-6, h);
	let cw = w;
	let ch = h;
	if (canvasRatio > ratio) {
		ch = h; // 上下贴满，左右被裁
		cw = h * ratio;
	} else {
		cw = w; // 左右贴满，上下被裁
		ch = w / ratio;
	}
	return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}
