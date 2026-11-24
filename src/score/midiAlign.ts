// ── 符头 ↔ 演奏事件对齐 + 每小节软矫正锚点（纯函数，零 DOM 依赖）────────
// 「单事件源」原则的落地：画面上每颗可发声符头都要绑到它自己的 MIDI 事件秒。
// 绑不上才允许调用方用第二时间源（Verovio timemap）兜底单个符头——一旦让第二
// 时间源接管整曲，两份网格的差异就表现为「球和音乐越听越不合」。

import type { XmlHead } from "../shared/auto-links";
import type { PlayEvent } from "./midiEvents";

/** 单处小节矫正的上限（秒）：再大就当作没对上，绝不允许把画面整段挪走 */
export const CORR_MAX = 1.5;
/** 矫正斜率上限：visTime = t + c(t) 对 t 的导数必须 ≥ 1−本值，否则小球会倒退 */
export const CORR_SLOPE = 0.5;
/** 锚点少于这个数量就不矫正（单点平移交给「音画对齐」滑轨） */
const CORR_MIN_ANCHORS = 2;

/**
 * 符头 ↔ 演奏事件单调对齐：同音高、且拍位×速度标量落在同一个时间窗内才算同一个音。
 *
 * `h.onset` 是四分音符拍数、`e.time` 是秒，两者只差一个全曲速度标量：先按 1 试，
 * 命中率不到一半再按同位时间差的中位数标定速度重跑一次（不假设拍号/速度）。
 * 两侧都允许多余项：符头多（tie 延续/装饰音没进 MIDI）就跳符头，事件多（MIDI 里
 * tie 拆成两个音）就跳事件，谁在前由时间决定，因此错一处不会带歪整条链。
 */
export function alignHeadsToEvents(
	hs: readonly XmlHead[],
	evs: readonly PlayEvent[],
): Map<string, number> {
	const out = new Map<string, number>();
	if (!hs.length || !evs.length) return out;
	const byTime = evs.slice().sort((a, b) => a.time - b.time || a.midi - b.midi);
	const heads = hs
		.slice()
		.sort((a, b) => a.onset - b.onset || (a.midi ?? 0) - (b.midi ?? 0));
	// 容差 = 最小非零事件间隔的一半：错开一拍不算同一个音，网格浮点误差算
	const gaps: number[] = [];
	for (let k = 1; k < byTime.length; k++) {
		const d = byTime[k]!.time - byTime[k - 1]!.time;
		if (d > 1e-6) gaps.push(d);
	}
	gaps.sort((a, b) => a - b);
	const tol = gaps.length ? Math.max(0.02, gaps[0]! * 0.5) : 0.05;
	const run = (scale: number): number => {
		out.clear();
		let i = 0,
			j = 0;
		while (i < heads.length && j < byTime.length) {
			const h = heads[i]!,
				e = byTime[j]!;
			const ht = h.onset * scale;
			if (h.midi === e.midi && Math.abs(ht - e.time) <= tol) {
				if (h.noteId) out.set(h.noteId, e.time);
				i++;
				j++;
				continue;
			}
			if (ht <= e.time + tol) i++;
			else j++;
		}
		return out.size;
	};
	if (run(1) * 2 >= heads.length) return out;
	const n = Math.min(heads.length, byTime.length);
	const rs: number[] = [];
	for (let k = 0; k < n; k++) {
		const o = heads[k]!.onset;
		if (o > 1e-6) rs.push(byTime[k]!.time / o);
	}
	rs.sort((a, b) => a - b);
	if (rs.length) run(rs[Math.floor(rs.length / 2)]!);
	return out;
}

export interface CorrAnchor {
	/** 播放头秒（实际发声网格上的锚点位置） */
	a: number;
	/** 该处画面秒要额外加的量 */
	c: number;
}

/** 中位数（就地排序） */
function median(xs: number[]): number {
	xs.sort((a, b) => a - b);
	return xs[Math.floor(xs.length / 2)] ?? 0;
}

/**
 * 每小节软矫正锚点：画面时间（连线用的量化网格）− 实际发声时间（播放源，
 * 可能是「原始演奏 MIDI」）。两源同一份数据时全为 0 → 矫正层等价不存在。
 * 一个小节取该小节内所有对得上号的符头的中位数差，锚在小节的发声起点上：
 * 单音的演奏处理不影响整段相位，整小节齐走才代表两源真的错开了。
 */
export function measureCorrectionAnchors(
	hs: readonly XmlHead[],
	visById: ReadonlyMap<string, number>,
	playedEvs: readonly PlayEvent[],
): CorrAnchor[] {
	if (!hs.length || !visById.size || !playedEvs.length) return [];
	const audById = alignHeadsToEvents(hs, playedEvs);
	if (!audById.size) return [];
	const byMeas = new Map<number, { a: number; d: number[] }>();
	for (const h of hs) {
		if (!h.noteId) continue;
		const v = visById.get(h.noteId);
		const a = audById.get(h.noteId);
		if (v === undefined || a === undefined) continue;
		const g = byMeas.get(h.measure) ?? { a, d: [] };
		g.a = Math.min(g.a, a);
		g.d.push(v - a);
		byMeas.set(h.measure, g);
	}
	const list: CorrAnchor[] = [];
	for (const g of byMeas.values())
		list.push({
			a: g.a,
			c: Math.max(-CORR_MAX, Math.min(CORR_MAX, median(g.d))),
		});
	list.sort((x, y) => x.a - y.a);
	// 相邻锚点之间限速，保证画面秒单调不减（小球不会往回走）
	for (let k = 1; k < list.length; k++) {
		const maxD = CORR_SLOPE * Math.max(1e-3, list[k]!.a - list[k - 1]!.a);
		const d = list[k]!.c - list[k - 1]!.c;
		if (Math.abs(d) > maxD) list[k]!.c = list[k - 1]!.c + Math.sign(d) * maxD;
	}
	// 只有一处锚 = 整体平移，那是「音画对齐」滑轨的活；两处以上才谈得上「每小节」
	return list.length >= CORR_MIN_ANCHORS ? list : [];
}

/** 播放头秒 → 矫正量：锚点之间线性过渡（位置连续、只有斜率折角，永不跳变） */
export function corrAt(A: readonly CorrAnchor[], t: number): number {
	if (!A.length) return 0;
	if (t <= A[0]!.a) return A[0]!.c;
	const n = A.length;
	if (t >= A[n - 1]!.a) return A[n - 1]!.c;
	let lo = 0,
		hi = n - 1;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (A[mid]!.a <= t) lo = mid;
		else hi = mid;
	}
	const p = A[lo]!,
		q = A[hi]!;
	const span = q.a - p.a;
	if (span <= 1e-6) return p.c;
	return p.c + ((t - p.a) / span) * (q.c - p.c);
}
