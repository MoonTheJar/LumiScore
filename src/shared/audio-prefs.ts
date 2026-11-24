// ── 全局音频偏好（localStorage 持久化，跨页面共享） ─────────────
// autoSoundfont：播放时是否自动拉取在线 GM 音色。关闭后直接走
//   本地钢琴采样 / 合成器兜底，不消耗流量下载音色包。
// autoPoll：音色镜像是否轮询（多镜像竞速）。关闭后只请求第一个
//   镜像源，失败即兜底，不再逐个尝试其余镜像。
// 两者默认开启，有需要的用户可在导入审核窗或「下载资源 → 音色」关闭。

const KEY_SF = 'midee.autoSoundfont'
const KEY_POLL = 'midee.autoPoll'
const KEY_MIRROR = 'midee.downloadMirror'
const KEY_NUDGE = 'midee.nudgeSec'

function readBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return def
    return v === '1'
  } catch {
    return def
  }
}
function writeBool(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? '1' : '0') } catch { /* noop */ }
}
function readNum(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return def
    const n = Number(v)
    return Number.isFinite(n) ? n : def
  } catch {
    return def
  }
}
function writeNum(key: string, v: number): void {
  try { localStorage.setItem(key, String(v)) } catch { /* noop */ }
}

const listeners = new Set<() => void>()
function emit(): void { for (const l of listeners) l() }

export function getAutoSoundfont(): boolean {
  return readBool(KEY_SF, true)
}
export function setAutoSoundfont(v: boolean): void {
  writeBool(KEY_SF, v)
  emit()
}
export function getAutoPoll(): boolean {
  return readBool(KEY_POLL, true)
}
export function setAutoPoll(v: boolean): void {
  writeBool(KEY_POLL, v)
  emit()
}
/** 手动下载时选用的镜像索引（autoPoll 关闭时生效；0 = 第一个镜像） */
export function getDownloadMirror(): number {
  return readNum(KEY_MIRROR, 0)
}
export function setDownloadMirror(i: number): void {
  writeNum(KEY_MIRROR, i)
  emit()
}
export function onAudioPrefChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 播放条「后退 / 前进」一次跳多少秒（0 = 不显示这两个按钮）。
 *  默认 10 秒 = 这个功能刚出现时的写死行为。 */
export const NUDGE_MIN = 0
export const NUDGE_MAX = 12
export function getNudgeSec(): number {
  const v = Math.round(readNum(KEY_NUDGE, 10))
  if (!Number.isFinite(v)) return 10
  return Math.min(NUDGE_MAX, Math.max(NUDGE_MIN, v))
}
export function setNudgeSec(v: number): void {
  const n = Math.round(Number(v))
  const ok = Number.isFinite(n) ? Math.min(NUDGE_MAX, Math.max(NUDGE_MIN, n)) : 10
  writeNum(KEY_NUDGE, ok)
  emit()
}
