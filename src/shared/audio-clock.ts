// ── 全站唯一播放时钟 ─────────────────────────────────────────
// 所有与播放同步的时间消费点统一读 Tone AudioContext 时钟：
//   · 第 5 页（3dpreview）：小球/镜头/点亮/拖尾/结束飞行/平滑增量
//   · 第 3 页（link2d）：圆点/视野推进、播放进度
// 该时钟与 Tone.Transport 发声调度同源 → 画面与声音永远同一进度，
// 不再允许页面本地墙钟（performance.now / rAF 时间戳）充当播放时钟。
import { getContext } from "tone";

/** 当前音频时钟（秒）。Tone Context 惰性创建；未启动时 currentTime 停走属正常。 */
export function audioClockNow(): number {
	return getContext().currentTime;
}