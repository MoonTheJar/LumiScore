// ── 本地钢琴采样（音色兜底第二级） ────────────────────────────────
// 打包在静态包里的真实钢琴采样（8 个 A 基音 + C8，≈1.2MB，取自 MIT 项目
// nbrosowsky/tonejs-instruments，与 midee 同源）。Tone Sampler 在采样音高之
// 间自动插值变调，覆盖全音域。在线 soundfont 失败时用它兜底钢琴类音色，
// 绝不让钢琴退回合成器。采样本体只 fetch + decode 一次，模块级缓存共享。
import { getContext, Sampler } from 'tone'
import { registerCache } from '../shared/cache-registry'
import { PUB_ROOT } from '../shared/pub-root'
import type { InstrumentRuntime } from './smplr-soundfont'

// 文件名约定：A1..A7 + C8（A 音基采样，八度间插值变调）
const FILES = ['A1.mp3', 'A2.mp3', 'A3.mp3', 'A4.mp3', 'A5.mp3', 'A6.mp3', 'A7.mp3', 'C8.mp3'] as const
const BASE = `${PUB_ROOT}instrument-samples/piano/`

// 解码后的 AudioBuffer 缓存：多轨并发 / 反复换音色不重复拉取解码
const bufCache = new Map<string, AudioBuffer>()
let pending: Promise<void> | null = null

/** 预取并解码全部采样（并发；任一失败整体抛错，由上层回退合成器） */
function ensureBuffers(): Promise<void> {
  if (bufCache.size === FILES.length) return Promise.resolve()
  pending ??= (async () => {
    const ctx = getContext().rawContext as AudioContext
    await Promise.all(
      FILES.map(async (f) => {
        if (bufCache.has(f)) return
        const res = await fetch(BASE + f)
        if (!res.ok) throw new Error(`钢琴采样 HTTP ${res.status}: ${f}`)
        const arr = await res.arrayBuffer()
        bufCache.set(f, await ctx.decodeAudioData(arr))
      }),
    )
  })().finally(() => { pending = null })
  return pending
}

/** 用本地钢琴采样构建 runtime（Sampler 插值变调覆盖全音域） */
export async function createPianoSampleRuntime(): Promise<InstrumentRuntime> {
  await ensureBuffers()
  const urls: Record<string, AudioBuffer> = {}
  for (const f of FILES) urls[f.replace('.mp3', '')] = bufCache.get(f)!
  // release 1.1 / -3dB 与 midee 立式钢琴补丁一致：接近原声衰减
  const sampler = new Sampler({ urls, release: 1.1, attack: 0, volume: -3 })
  return {
    triggerAttackRelease: (note, duration, time, velocity) =>
      sampler.triggerAttackRelease(note, duration, time, velocity),
    releaseAll: () => sampler.releaseAll(),
    dispose: () => sampler.dispose(),
    output: sampler,
  }
}

// 登记到「设置 → 缓存设置」：统计解码后的采样占用，支持卸载
registerCache({
  id: 'piano',
  labelKey: 'cache.piano',
  descKey: 'cache.piano.desc',
  stats: () => {
    let bytes = 0
    for (const b of bufCache.values()) bytes += b.length * b.numberOfChannels * 4
    return { count: bufCache.size, bytes }
  },
  clear: () => {
    const n = bufCache.size
    bufCache.clear()
    return n
  },
})
