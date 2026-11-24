/** 取色面板内部按 HSV 操作（鼠标位置=饱和度/明度，符合直觉），
 * 项目里的颜色一律是 0xRRGGBB 整数，所以进出都要转换。 */
export interface HSV {
	h: number; // 0-360
	s: number; // 0-1
	v: number; // 0-1
}

export function hsvToRgb(
	h: number,
	s: number,
	v: number,
): [number, number, number] {
	const hh = ((h % 360) + 360) % 360;
	const c = v * s;
	const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
	const m = v - c;
	const seg = Math.min(5, Math.floor(hh / 60));
	const rgb: [number, number, number] =
		seg === 0
			? [c, x, 0]
			: seg === 1
				? [x, c, 0]
				: seg === 2
					? [0, c, x]
					: seg === 3
						? [0, x, c]
						: seg === 4
							? [x, 0, c]
							: [c, 0, x];
	return [
		Math.round((rgb[0] + m) * 255),
		Math.round((rgb[1] + m) * 255),
		Math.round((rgb[2] + m) * 255),
	];
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	let h = 0;
	if (d !== 0) {
		if (max === rn) h = 60 * (((gn - bn) / d) % 6);
		else if (max === gn) h = 60 * ((bn - rn) / d + 2);
		else h = 60 * ((rn - gn) / d + 4);
		if (h < 0) h += 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hexToHsv(hex: number): HSV {
	return rgbToHsv((hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
}

export function hsvToHex(c: HSV): number {
	const [r, g, b] = hsvToRgb(c.h, c.s, c.v);
	return (r << 16) | (g << 8) | b;
}

/** 0xRRGGBB → "#RRGGBB"（大写，和面板里现有显示一致） */
export function hexString(v: number): string {
	return `#${Math.max(0, Math.min(0xffffff, Math.round(v)))
		.toString(16)
		.padStart(6, "0")
		.toUpperCase()}`;
}

/** 接受 "#F47" / "F472B6" / "0xF472B6"，解析失败返回 null */
export function parseHex(text: string): number | null {
	const t = text.trim().replace(/^(#|0x)/i, "");
	if (!/^[0-9a-fA-F]+$/.test(t)) return null;
	if (t.length === 3) {
		const r = parseInt(t[0]! + t[0]!, 16);
		const g = parseInt(t[1]! + t[1]!, 16);
		const b = parseInt(t[2]! + t[2]!, 16);
		return (r << 16) | (g << 8) | b;
	}
	if (t.length !== 6) return null;
	return parseInt(t, 16);
}
