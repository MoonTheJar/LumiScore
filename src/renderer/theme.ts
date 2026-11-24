import type { MidiTrack } from "../core/midi/types";

export interface Theme {
	name: string;
	background: number;

	noteRadius: number;
	noteGlowStrength: number;
	noteGlowDistance: number;

	whiteKey: number;
	whiteKeyActive: number;
	blackKey: number;
	blackKeyActive: number;
	keyBorder: number;

	nowLine: number;
	nowLineAlpha: number;
	nowLineGlow: number;

	beatLineAlpha: number;
	barLineAlpha: number;

	uiAccentCSS: string;

	trackColors: number[];
}

export function getTrackColor(
	track: MidiTrack,
	theme: Theme,
	overrides?: Map<string, number>,
): number {
	if (overrides) {
		const override = overrides.get(track.id);
		if (override !== undefined) return override;
	}
	return theme.trackColors[track.colorIndex % theme.trackColors.length]!;
}

export type BorderStyle = "none" | "solid" | "glow";

export const BORDER_STYLE_IDS: readonly BorderStyle[] = [
	"none",
	"solid",
	"glow",
];

export function applyVelocityShade(
	base: number,
	velocity01: number,
	threshold: number,
): number {
	if (threshold === 0) return base;
	const t = threshold < -1 ? -1 : threshold > 1 ? 1 : threshold;
	const mid = 64 / 127;
	const delta = velocity01 - mid;
	const intensity = Math.min(Math.abs(delta) / mid, 1);
	const towardWhite = delta < 0 === t > 0;
	const mixAmount = Math.min(intensity * Math.abs(t), 1);
	const target = towardWhite ? 0xffffff : 0x000000;
	const ar = (base >> 16) & 0xff;
	const ag = (base >> 8) & 0xff;
	const ab = base & 0xff;
	const br = (target >> 16) & 0xff;
	const bg = (target >> 8) & 0xff;
	const bb = target & 0xff;
	const r = Math.round(ar + (br - ar) * mixAmount);
	const g = Math.round(ag + (bg - ag) * mixAmount);
	const b = Math.round(ab + (bb - ab) * mixAmount);
	return (r << 16) | (g << 8) | b;
}

export function brightenForKeyboard(color: number, amount: number): number {
	if (amount <= 0) return color;
	const a = amount > 1 ? 1 : amount;
	const ar = (color >> 16) & 0xff;
	const ag = (color >> 8) & 0xff;
	const ab = color & 0xff;
	const r = Math.round(ar + (255 - ar) * a);
	const g = Math.round(ag + (255 - ag) * a);
	const b = Math.round(ab + (255 - ab) * a);
	return (r << 16) | (g << 8) | b;
}

function hslToRgb(h: number, s: number, l: number): number {
	h = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0,
		g = 0,
		b = 0;
	if (h < 60) {
		r = c;
		g = x;
	} else if (h < 120) {
		r = x;
		g = c;
	} else if (h < 180) {
		g = c;
		b = x;
	} else if (h < 240) {
		g = x;
		b = c;
	} else if (h < 300) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	return (
		(Math.round((r + m) * 255) << 16) |
		(Math.round((g + m) * 255) << 8) |
		Math.round((b + m) * 255)
	);
}

export function rgbToHex(r: number, g: number, b: number): string {
	return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export function hexToRgb(
	hex: string,
): { r: number; g: number; b: number } | null {
	const m = /^#?([a-f\d]{6})$/i.exec(hex);
	if (!m) return null;
	const n = parseInt(m[1]!, 16);
	return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHsl(
	r: number,
	g: number,
	b: number,
): { h: number; s: number; l: number } {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
	else if (max === g) h = ((b - r) / d + 2) * 60;
	else h = ((r - g) / d + 4) * 60;
	return { h, s, l };
}

export function trackColorsFromBase(baseHex: string): number[] {
	const rgb = hexToRgb(baseHex);
	if (!rgb) return [...DEFAULT_TRACK_COLORS];
	const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
	const colors: number[] = [];
	for (let i = 0; i < 12; i++) {
		const hue = (h + i * 30) % 360;
		const sat = Math.max(0.45, Math.min(0.92, s + ((i % 3) - 1) * 0.08));
		const lit = Math.max(
			0.48,
			Math.min(0.68, l + (i % 2 === 0 ? 0.04 : -0.04)),
		);
		colors.push(hslToRgb(hue, sat, lit));
	}
	return colors;
}

export const DEFAULT_TRACK_COLORS: readonly number[] = [
	0x6366f1, 0xef4444, 0x06b6d4, 0xf59e0b, 0x10b981, 0x8b5cf6, 0xf97316,
	0x3b82f6, 0xec4899, 0x14b8a6, 0xe11d48, 0x84cc16,
];
export const darkTheme: Theme = {
	name: "墨夜曲",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.5,
	noteGlowDistance: 12,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#6366f1",
	trackColors: [
		0x6366f1, 0x8b5cf6, 0x06b6d4, 0x3b82f6, 0x10b981, 0xa78bfa, 0x818cf8,
		0x60a5fa, 0x14b8a6, 0x7c3aed, 0x6d28d9, 0x4f46e5,
	],
};

export const midnightTheme: Theme = {
	name: "星夜蓝",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.8,
	noteGlowDistance: 14,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#a78bfa",
	trackColors: [
		0xa78bfa, 0x8b5cf6, 0x818cf8, 0x6366f1, 0x60a5fa, 0x3b82f6, 0xc084fc,
		0xa855f7, 0x7c3aed, 0x6d28d9, 0x4f46e5, 0x2563eb,
	],
};

export const neonTheme: Theme = {
	name: "霓虹光",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 3.2,
	noteGlowDistance: 16,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#00ffaa",
	trackColors: [
		0x00ffaa, 0x00e5ff, 0xffe600, 0xff6bff, 0x39ff14, 0xff9100, 0x00bfff,
		0xff00ff, 0x7fff00, 0x00ff00, 0xe879f9, 0x00ffff,
	],
};

export const sunsetTheme: Theme = {
	name: "晚霞橙",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.8,
	noteGlowDistance: 14,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#f97316",
	trackColors: [
		0xf97316, 0xfb923c, 0xfdba74, 0xec4899, 0xf472b6, 0xfb7185, 0xff8c5a,
		0xfde68a, 0xff6b9d, 0xe879f9, 0xd946ef, 0xf59e0b,
	],
};

export const oceanTheme: Theme = {
	name: "深海蓝",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.6,
	noteGlowDistance: 13,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#06b6d4",
	trackColors: [
		0x06b6d4, 0x0891b2, 0x0e7490, 0x155e75, 0x0ea5e9, 0x38bdf8, 0x7dd3fc,
		0x0284c7, 0x0369a1, 0x075985, 0x0c4a6e, 0x164e63,
	],
};

export const forestTheme: Theme = {
	name: "翠竹林",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.6,
	noteGlowDistance: 13,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#10b981",
	trackColors: [
		0x10b981, 0x34d399, 0x6ee7b7, 0xa7f3d0, 0x059669, 0x047857, 0x065f46,
		0x14b8a6, 0x2dd4bf, 0x5eead4, 0x99f6e4, 0xccfbf1,
	],
};

export const candyTheme: Theme = {
	name: "糖果粉",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.8,
	noteGlowDistance: 14,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#ec4899",
	trackColors: [
		0xec4899, 0xf472b6, 0xf9a8d4, 0xfbcfe8, 0xdb2777, 0xbe185d, 0x9d174d,
		0xf43f5e, 0xfb7185, 0xfda4af, 0xfee2e2, 0xff0066,
	],
};

export const monoTheme: Theme = {
	name: "素雅灰",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 2.4,
	noteGlowDistance: 11,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#6b7280",
	trackColors: [
		0x6b7280, 0x9ca3af, 0xd1d5db, 0xf3f4f6, 0x4b5563, 0x374151, 0x1f2937,
		0x111827, 0x030712, 0xa3a3a3, 0x737373, 0x525252,
	],
};

export const rainbowTheme: Theme = {
	name: "七彩光",
	background: 0x09090f,
	noteRadius: 4,
	noteGlowStrength: 3.0,
	noteGlowDistance: 15,
	whiteKey: 0xe8e8f0,
	whiteKeyActive: 0xb0b4ff,
	blackKey: 0x1a1a2e,
	blackKeyActive: 0x5558cc,
	keyBorder: 0x1e1e30,
	nowLine: 0xffffff,
	nowLineAlpha: 0.18,
	nowLineGlow: 0xffffff,
	beatLineAlpha: 0.028,
	barLineAlpha: 0.07,
	uiAccentCSS: "#6366f1",
	trackColors: [
		0xef4444, 0xf97316, 0xf59e0b, 0xeab308, 0x84cc16, 0x22c55e, 0x10b981,
		0x14b8a6, 0x06b6d4, 0x0ea5e9, 0x3b82f6, 0x8b5cf6,
	],
};

export const THEMES: readonly Theme[] = [
	darkTheme,
	midnightTheme,
	neonTheme,
	sunsetTheme,
	oceanTheme,
	forestTheme,
	candyTheme,
	monoTheme,
	rainbowTheme,
];

function tintedColor(baseRgb: { r: number; g: number; b: number }, ratio: number): number {
	const bgR = 0x09, bgG = 0x09, bgB = 0x0f;
	const r = Math.round(bgR + (baseRgb.r - bgR) * ratio);
	const g = Math.round(bgG + (baseRgb.g - bgG) * ratio);
	const b = Math.round(bgB + (baseRgb.b - bgB) * ratio);
	return (r << 16) | (g << 8) | b;
}

export function makeCustomTheme(baseHex: string): Theme {
	const rgb = hexToRgb(baseHex);
	const baseRgb = rgb ?? { r: 0x63, g: 0x66, b: 0xf1 };
	return {
		name: "Custom",
		background: tintedColor(baseRgb, 0.08),
		noteRadius: 4,
		noteGlowStrength: 2.8,
		noteGlowDistance: 14,
		whiteKey: tintedColor(baseRgb, 0.15),
		whiteKeyActive: tintedColor(baseRgb, 0.55),
		blackKey: tintedColor(baseRgb, 0.12),
		blackKeyActive: tintedColor(baseRgb, 0.4),
		keyBorder: tintedColor(baseRgb, 0.18),
		nowLine: tintedColor(baseRgb, 0.85),
		nowLineAlpha: 0.18,
		nowLineGlow: tintedColor(baseRgb, 0.9),
		beatLineAlpha: 0.028,
		barLineAlpha: 0.07,
		uiAccentCSS: baseHex,
		trackColors: trackColorsFromBase(baseHex),
	};
}

