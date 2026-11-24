// ── 唯一事件源（score/midiEvents） ───────────────────────────
// 「单事件源」原则：第三页与第五页的音符时间必须来自同一份解析结果——
// 标准 MIDI `midee.midi`（@tonejs/midi 解析，时间单位秒）。任何页面不得再
// 自行解析 MIDI / 使用 Verovio timemap 之类第二份时间源。
import { Midi } from "@tonejs/midi";

export interface PlayEvent {
	midi: number;
	time: number; // 秒（MusicTime）
	dur: number;
	vel: number;
	channel: number; // 有音符的轨的索引（点亮颜色 trackColors[channel]）
}

/** 从 midee.midi(base64) 解析事件流；失败返回 []（上层可回退 XML 提取） */
export function parseMidiEvents(b64: string | null): PlayEvent[] {
	if (!b64) return [];
	try {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const parsed = new Midi(
			bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer,
		);
		const evs: PlayEvent[] = [];
		// 与播放器一致：只数有音符的轨，channel = 轨索引
		parsed.tracks
			.filter((t) => t.notes.length > 0)
			.forEach((tr, ti) => {
				for (const n of tr.notes)
					evs.push({
						midi: n.midi,
						time: n.time,
						dur: n.duration,
						vel: n.velocity,
						channel: ti,
					});
			});
		evs.sort((a, b) => a.time - b.time);
		return evs;
	} catch {
		return [];
	}
}

/** 合并同轨连续同音高事件（tie/同音延续）：后音被前音覆盖 → 只留前音（避免连音线处跳两次） */
export function mergeTieEvents(evs: PlayEvent[]): PlayEvent[] {
	const byKey = new Map<string, PlayEvent[]>();
	for (const e of evs) {
		const key = `${e.channel}|${e.midi}`;
		const a = byKey.get(key) ?? [];
		a.push(e);
		byKey.set(key, a);
	}
	const out: PlayEvent[] = [];
	for (const list of byKey.values()) {
		list.sort((a, b) => a.time - b.time);
		let prev: PlayEvent | null = null;
		for (const e of list) {
			if (prev && e.time - (prev.time + prev.dur) < 0.05) {
				prev.dur = Math.max(prev.dur, e.time + e.dur - prev.time); // 覆盖延伸
				continue; // tie 延续音不重复触发
			}
			out.push(e);
			prev = e;
		}
	}
	out.sort((a, b) => a.time - b.time);
	return out;
}