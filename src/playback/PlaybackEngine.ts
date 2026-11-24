// ── 唯一播放头（Playback Engine v1） ───────────────────────────
// 全站 MusicTime 的唯一来源：「单时钟、单 MusicTime 轴、单播放头、单事件源」中的
// 播放头。所有页面/相机/进度条/点亮/粒子只允许从这里读时间：
//   · playing: now() = pausedMusic + (AudioContext.currentTime - anchor) × speed
//   · 其他:     now() = pausedMusic（暂停/seek 后冻结在锚定位置）
// MusicTime = 已流逝音频秒 × speed（变速乘在播放头这一处；音频侧不再二次变速）。
// AudioContext 挂起时 currentTime 冻结 → now() 自然冻结（画面跟着音频停，无双时钟漂移）。
// 本类不持有任何视图/相机/进度条引用；状态变化通过 onState 订阅广播。
import { getContext } from "tone";

export type EngineState =
	| "idle"
	| "prepared"
	| "playing"
	| "paused"
	| "ended"
	| "interrupted";

export class PlaybackEngine {
	/** 最近一次 play/seek/setSpeed 时的音频时钟读数（playing 态才参与 now()） */
	private anchor = 0;
	/** 锚定时刻已累计的 MusicTime（暂停/结束/seek 后固化的位置） */
	private pausedMusic = 0;
	private speedMul = 1;
	private st: EngineState = "idle";
	private total = 0; // totalMusicDuration（= 音频执行器的 duration）
	private listeners = new Set<(s: EngineState) => void>();

	get state(): EngineState {
		return this.st;
	}
	get speed(): number {
		return this.speedMul;
	}
	get duration(): number {
		return this.total;
	}

	setDuration(d: number): void {
		this.total = Math.max(0, d);
	}

	/** 当前 MusicTime（秒，已乘 speed）。唯一合法读数入口。 */
	now(): number {
		if (this.st === "playing") {
			return (
				this.pausedMusic +
				(getContext().currentTime - this.anchor) * this.speedMul
			);
		}
		return this.pausedMusic;
	}

	/** 开播/续播：以当前音频时钟为锚，MusicTime 从此连续前进（含 speed） */
	play(): void {
		this.anchor = getContext().currentTime;
		if (this.st === "ended" && this.pausedMusic >= this.total - 1e-6) {
			this.pausedMusic = 0; // 播完再按播放 = 从头
		}
		this.st = "playing";
		this.emit();
	}

	/** 暂停：固化当前 MusicTime；恢复用 play()（锚重置，时间连续不跳） */
	pause(): void {
		if (this.st !== "playing") return;
		this.pausedMusic = this.now();
		this.st = "paused";
		this.emit();
	}

	/** 幂等 seek：MusicTime 立即 = target；playing 态继续从 target 前进。
	 *  允许负值（lead-in 留白：播放头在负段静默推进，0 时刻音乐才开始）。 */
	seek(target: number): void {
		this.pausedMusic = target;
		this.anchor = getContext().currentTime;
		this.emit();
	}

	/** 停止并归零（不重置 total/speed）：MusicTime=0，非播放态 */
	stop(): void {
		this.pausedMusic = 0;
		this.st = "paused";
		this.emit();
	}

	/** 变速：先在旧速下取样当前 MusicTime，再以新速从同一点继续（不跳变） */
	setSpeed(s: number): void {
		const ns = s > 0 ? s : 1;
		if (ns === this.speedMul) return;
		const t = this.now();
		this.pausedMusic = Math.min(t, this.total);
		this.anchor = getContext().currentTime;
		this.speedMul = ns;
		this.emit();
	}

	/** 到达 totalMusicDuration（尾留白走完）时由外层调用一次 */
	end(): void {
		if (this.st === "ended") return;
		this.pausedMusic = this.total;
		this.st = "ended";
		this.emit();
	}

	reset(): void {
		this.st = "idle";
		this.pausedMusic = 0;
		this.anchor = 0;
		this.speedMul = 1;
		this.total = 0;
		this.emit();
	}

	/** AudioContext 中断/恢复通知：冻结读数即可（now() 天然随 ctx 冻结），仅供 UI 状态 */
	interrupted(v: boolean): void {
		this.st = v ? "interrupted" : this.st === "interrupted" ? "paused" : this.st;
		this.emit();
	}

	onState(fn: (s: EngineState) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) {
			try {
				fn(this.st);
			} catch {
				/* 订阅者异常不影响播放头 */
			}
		}
	}
}

/** 全站唯一播放头实例（单例：第三页/第五页/播放条共用同一对象） */
export const playbackEngine = new PlaybackEngine();