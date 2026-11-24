import { describe, expect, it } from "vitest";
import type { XmlHead } from "../shared/auto-links";
import {
	alignHeadsToEvents,
	CORR_MAX,
	corrAt,
	measureCorrectionAnchors,
} from "./midiAlign";
import type { PlayEvent } from "./midiEvents";

/** 只填对齐用得上的字段，其余给安全的默认值 */
function head(
	p: Partial<XmlHead> & Pick<XmlHead, "noteId" | "onset" | "midi">,
): XmlHead {
	return {
		part: 0,
		measure: p.measure ?? 1,
		staff: p.staff ?? 1,
		voice: p.voice ?? "1",
		onset: p.onset,
		dur: p.dur ?? 0.5,
		chord: false,
		rest: false,
		grace: false,
		graceRole: null,
		graceMainId: null,
		graceOrder: 0,
		tieStart: false,
		tieStop: false,
		tieCont: false,
		noteId: p.noteId,
		midi: p.midi,
	};
}

function ev(time: number, midi: number, dur = 0.25): PlayEvent {
	return { midi, time, dur, vel: 0.8, channel: 0 };
}

/** 两小节 × 每小节四拍的网格：onset 用四分音符拍数 */
function grid(secPerQuarter: number): { hs: XmlHead[]; evs: PlayEvent[] } {
	const hs: XmlHead[] = [];
	const evs: PlayEvent[] = [];
	for (let m = 0; m < 2; m++)
		for (let q = 0; q < 4; q++) {
			const onset = m * 4 + q * 0.5;
			const midi = 60 + q;
			hs.push(head({ noteId: `n${m}-${q}`, onset, midi, measure: m + 1 }));
			evs.push(ev(onset * secPerQuarter, midi));
		}
	return { hs, evs };
}

describe("alignHeadsToEvents", () => {
	it("同网格逐头绑定", () => {
		const { hs, evs } = grid(0.5);
		const m = alignHeadsToEvents(hs, evs);
		expect(m.size).toBe(hs.length);
		expect(m.get("n1-2")).toBeCloseTo((4 + 1) * 0.5, 6);
	});

	it("拍位↔秒的速度标量不为 1 时自动标定（60/120 bpm 都绑得上）", () => {
		for (const spd of [1, 0.5, 0.4]) {
			const { hs, evs } = grid(spd);
			expect(alignHeadsToEvents(hs, evs).size).toBe(hs.length);
		}
	});

	it("多个声部交错也能按时间对齐（不是按数组下标）", () => {
		const hs = [
			head({ noteId: "a", onset: 0, midi: 60, measure: 1 }),
			head({ noteId: "b", onset: 0.25, midi: 72, measure: 1 }),
			head({ noteId: "c", onset: 0.5, midi: 64, measure: 1 }),
		];
		const evs = [ev(0, 60), ev(0.25, 72), ev(0.5, 64)];
		expect(alignHeadsToEvents(hs, evs).get("c")).toBeCloseTo(0.5, 6);
	});

	it("符头多出来（MIDI 里没有的 tie 延续）只丢它自己，后面不整体错位", () => {
		const hs = [
			head({ noteId: "a", onset: 0, midi: 60, measure: 1 }),
			head({ noteId: "ghost", onset: 0.25, midi: 59, measure: 1 }),
			head({ noteId: "b", onset: 0.5, midi: 64, measure: 1 }),
		];
		const m = alignHeadsToEvents(hs, [ev(0, 60), ev(0.5, 64)]);
		expect(m.has("ghost")).toBe(false);
		expect(m.get("b")).toBeCloseTo(0.5, 6);
	});

	it("事件多出来（MIDI 把 tie 拆成两个音）同样不带动后面", () => {
		const hs = [
			head({ noteId: "a", onset: 0, midi: 60, measure: 1 }),
			head({ noteId: "b", onset: 1, midi: 64, measure: 1 }),
		];
		const m = alignHeadsToEvents(hs, [ev(0, 60), ev(0.5, 60), ev(1, 64)]);
		expect(m.get("b")).toBeCloseTo(1, 6);
	});

	it("同拍不同音高不算同一个音", () => {
		const hs = [head({ noteId: "a", onset: 0, midi: 60, measure: 1 })];
		expect(alignHeadsToEvents(hs, [ev(0, 61)]).size).toBe(0);
	});

	it("空输入不抛错", () => {
		expect(alignHeadsToEvents([], [ev(0, 60)]).size).toBe(0);
		expect(
			alignHeadsToEvents([head({ noteId: "a", onset: 0, midi: 60 })], []).size,
		).toBe(0);
	});
});

describe("measureCorrectionAnchors", () => {
	it("两源同一份数据 → 矫正量恒为 0", () => {
		const { hs, evs } = grid(0.5);
		const vis = alignHeadsToEvents(hs, evs);
		const A = measureCorrectionAnchors(hs, vis, evs);
		for (const t of [-1, 0, 0.37, 2, 99])
			expect(corrAt(A, t)).toBeCloseTo(0, 9);
	});

	it("按小节取中位数：整小节齐走才矫正", () => {
		const hs = [
			head({ noteId: "a", onset: 0, midi: 60, measure: 1 }),
			head({ noteId: "b", onset: 1, midi: 62, measure: 1 }),
			head({ noteId: "c", onset: 2, midi: 64, measure: 2 }),
			head({ noteId: "d", onset: 3, midi: 66, measure: 2 }),
		];
		// 第 1 小节整段提前 0.2s 发声，第 2 小节整段滞后 0.1s
		const played = [ev(-0.2, 60), ev(0.7, 62), ev(2.1, 64), ev(3.1, 66)];
		const vis = new Map([
			["a", 0],
			["b", 1],
			["c", 2],
			["d", 3],
		]);
		const A = measureCorrectionAnchors(hs, vis, played);
		expect(A.length).toBeGreaterThanOrEqual(2);
		expect(corrAt(A, -9)).toBeCloseTo(A[0]!.c, 9);
		expect(corrAt(A, 99)).toBeCloseTo(A[A.length - 1]!.c, 9);
	});

	it("再乱的锚点也不许让画面倒退、不许超过上限", () => {
		const hs: XmlHead[] = [];
		const played: PlayEvent[] = [];
		const vis = new Map<string, number>();
		for (let m = 0; m < 12; m++) {
			hs.push(head({ noteId: `x${m}`, onset: m, midi: 60, measure: m + 1 }));
			played.push(ev(m + (m % 2 ? 1.4 : -1.4), 60));
			vis.set(`x${m}`, m);
		}
		const A = measureCorrectionAnchors(hs, vis, played);
		for (const p of A) expect(Math.abs(p.c)).toBeLessThanOrEqual(CORR_MAX);
		let prev = -Infinity;
		for (let t = -2; t <= 14; t += 0.01) {
			const v = t + corrAt(A, t);
			expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = v;
		}
	});

	it("只有一个小节（单点平移）→ 不做每小节矫正", () => {
		const hs = [
			head({ noteId: "a", onset: 0, midi: 60, measure: 1 }),
			head({ noteId: "b", onset: 1, midi: 62, measure: 1 }),
		];
		const played = [ev(0.4, 60), ev(1.4, 62)];
		const vis = new Map([
			["a", 0],
			["b", 1],
		]);
		expect(measureCorrectionAnchors(hs, vis, played)).toEqual([]);
	});
});

describe("corrAt", () => {
	const A = [
		{ a: 0, c: 0 },
		{ a: 10, c: 1 },
	];

	it("空表恒为 0", () => {
		expect(corrAt([], 5)).toBe(0);
	});

	it("两端取最近锚点、中间线性过渡，且处处连续", () => {
		expect(corrAt(A, -3)).toBe(0);
		expect(corrAt(A, 4.999)).toBeCloseTo(0.4999, 6);
		expect(corrAt(A, 5)).toBeCloseTo(0.5, 6);
		expect(corrAt(A, 10)).toBe(1);
		expect(corrAt(A, 99)).toBe(1);
		let prev = corrAt(A, -1);
		for (let t = -1; t <= 12; t += 0.001) {
			const v = corrAt(A, t);
			expect(Math.abs(v - prev)).toBeLessThan(1e-3); // 没有跳变
			prev = v;
		}
	});
});
