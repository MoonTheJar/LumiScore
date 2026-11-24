// ── 多音色 ─────────────────────────────────────────────────────
// 三级兜底链：在线 smplr soundfont（多镜像竞速，按需下载）→ 本地钢琴采样
// （piano-samples.ts，仅钢琴类）→ 内置 Tone 合成器，绝不让音符静默。
// 所有音色暴露 output 节点：播放器把每轨 output → Gain（音量/静音）→ destination
import { Chorus, Filter, FMSynth, Gain, MembraneSynth, MetalSynth, NoiseSynth, PolySynth, Reverb, Synth } from 'tone'
import { createSoundfontRuntime, GM_PROGRAM_NAMES, resolveSoundfontName, type InstrumentRuntime } from './smplr-soundfont'
import { createPianoSampleRuntime } from './piano-samples'
import { getAutoSoundfont } from '../shared/audio-prefs'

export type { InstrumentRuntime }

/** 音色实际生效的音源（三级兜底链的落点） */
export type SoundSourceKind = 'online' | 'pianoSample' | 'synth'

export interface CreateInstrumentOptions {
  /** 强制音源：跳过在线直接用本地采样/合成器；online = 用户显式选用的在线音色（不受全局自动开关限制） */
  force?: 'pianoSample' | 'synth' | 'online'
  /** 在线逐音下载进度（loaded/total；整包成功统一报 1/1） */
  onProgress?: (loaded: number, total: number) => void
  /** 最终生效音源（加载完成时上报一次） */
  onSource?: (src: SoundSourceKind) => void
}

export type InstrumentId =
  | 'piano' | 'digital' | 'rhodes' | 'pad' | 'pluck' | 'marimba' | 'bells' | 'strings' | 'bass' | 'violin' | 'flute' | 'guitar' | 'drums'
  | 'organ' | 'brass' | 'sax' | 'reed' | 'choir' | 'harp' | 'xylophone' | 'timpani'

export const INSTRUMENT_NAMES: Record<InstrumentId, string> = {
  piano: '钢琴', digital: '电钢', rhodes: 'Rhodes', pad: 'Pad', pluck: '拨弦', marimba: '马林巴',
  bells: '铃', strings: '弦乐', bass: '贝斯', violin: '小提琴', flute: '长笛', guitar: '吉他', drums: '鼓',
  organ: '风琴', brass: '铜管', sax: '萨克斯', reed: '簧管', choir: '人声', harp: '竖琴',
  xylophone: '木琴', timpani: '定音鼓',
}

type ToneNode = { connect(dest: unknown): void }

// ── 合成器补丁（无网络时的本地音色） ────────────────────────────
type PolyToneSource = {
  triggerAttackRelease(note: string, duration: number, time: number, velocity: number): void
  releaseAll(): void
  dispose(): void
}
function wrapPolySynth(synth: PolyToneSource, output: ToneNode): InstrumentRuntime {
  return {
    triggerAttackRelease: (note, duration, time, velocity) => synth.triggerAttackRelease(note, duration, time, velocity),
    releaseAll: () => synth.releaseAll(),
    dispose: () => synth.dispose(),
    output,
  }
}
function createDigitalPiano(): InstrumentRuntime {
  const synth = new PolySynth(FMSynth, {
    harmonicity: 1.0, modulationIndex: 2.6, oscillator: { type: 'sine' },
    envelope: { attack: 0.003, decay: 0.9, sustain: 0.25, release: 0.85 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.003, decay: 0.35, sustain: 0, release: 0.3 },
  })
  synth.volume.value = 2
  const chorus = new Chorus(1.1, 2.0, 0.2).start()
  const reverb = new Reverb({ decay: 1.1, wet: 0.14 })
  synth.chain(chorus, reverb)
  return wrapPolySynth(synth, reverb)
}
function createRhodes(): InstrumentRuntime {
  const synth = new PolySynth(FMSynth, {
    harmonicity: 3.2, modulationIndex: 6, oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 0.9, sustain: 0.12, release: 1.0 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.004, decay: 0.6, sustain: 0.05, release: 0.4 },
  })
  const chorus = new Chorus(0.8, 2.5, 0.35).start()
  synth.chain(chorus)
  return wrapPolySynth(synth, chorus)
}
function createPad(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
    envelope: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.6 },
  })
  synth.volume.value = -10
  const filter = new Filter({ frequency: 1600, type: 'lowpass', rolloff: -12 })
  const reverb = new Reverb({ decay: 3.5, wet: 0.35 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}
function createPluck(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.9 },
  })
  synth.volume.value = -6
  const filter = new Filter({ frequency: 3800, type: 'highpass', rolloff: -12, Q: 0.5 })
  const lowpass = new Filter({ frequency: 6500, type: 'lowpass', rolloff: -24 })
  synth.chain(filter, lowpass)
  return wrapPolySynth(synth, lowpass)
}
function createMarimba(): InstrumentRuntime {
  const synth = new PolySynth(FMSynth, {
    harmonicity: 4.2, modulationIndex: 12, oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.25 },
    modulation: { type: 'triangle' },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.08 },
  })
  synth.volume.value = -4
  const reverb = new Reverb({ decay: 1.2, wet: 0.2 })
  synth.chain(reverb)
  return wrapPolySynth(synth, reverb)
}
function createBells(): InstrumentRuntime {
  const synth = new PolySynth(FMSynth, {
    harmonicity: 3.01, modulationIndex: 8, oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 2.4, sustain: 0, release: 2.8 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 1.8 },
  })
  synth.volume.value = -8
  const reverb = new Reverb({ decay: 4.0, wet: 0.4 })
  synth.chain(reverb)
  return wrapPolySynth(synth, reverb)
}
function createStrings(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'fatsawtooth', count: 5, spread: 40 },
    envelope: { attack: 0.35, decay: 0.25, sustain: 0.85, release: 1.4 },
  })
  synth.volume.value = -12
  const filter = new Filter({ frequency: 2400, type: 'lowpass', rolloff: -12 })
  const reverb = new Reverb({ decay: 2.4, wet: 0.32 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}
function createBass(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.3, sustain: 0.75, release: 0.35 },
  })
  synth.volume.value = -4
  const filter = new Filter({ frequency: 1200, type: 'lowpass', rolloff: -24, Q: 0.8 })
  synth.chain(filter)
  return wrapPolySynth(synth, filter)
}
function createTriangleFallback(): InstrumentRuntime {
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.08, sustain: 0.55, release: 0.5 },
  })
  return wrapPolySynth(synth, synth)
}

// ── 扩展乐器补丁（纯合成，不加载任何采样，不增加包体积） ───────────
function createOrgan(): InstrumentRuntime {
  // 拉杆风琴：多个固定泛音叠加，快起快落无延音尾
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'custom', partials: [1, 0.5, 0.75, 0.25, 0.4, 0.15, 0.25, 0.1] } as never,
    envelope: { attack: 0.008, decay: 0.05, sustain: 0.95, release: 0.12 },
  })
  synth.volume.value = -14
  const filter = new Filter({ frequency: 3200, type: 'lowpass', rolloff: -12 })
  synth.chain(filter)
  return wrapPolySynth(synth, filter)
}
function createBrass(): InstrumentRuntime {
  // 铜管：锯齿波 + 起音瞬时打开的低通（模拟铜管的「吹开」瞬间）
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.06, decay: 0.2, sustain: 0.8, release: 0.28 },
  })
  synth.volume.value = -14
  const filter = new Filter({ frequency: 1800, type: 'lowpass', rolloff: -24, Q: 1.2 })
  const reverb = new Reverb({ decay: 1.6, wet: 0.2 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}
function createSax(): InstrumentRuntime {
  // 萨克斯：方波偏暖 + 中频突出，略带鼻音
  const synth = new PolySynth(FMSynth, {
    harmonicity: 1.5, modulationIndex: 3.4, oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.04, decay: 0.25, sustain: 0.75, release: 0.3 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.05, decay: 0.4, sustain: 0.3, release: 0.3 },
  })
  synth.volume.value = -15
  const filter = new Filter({ frequency: 2200, type: 'lowpass', rolloff: -12, Q: 2 })
  const reverb = new Reverb({ decay: 1.4, wet: 0.18 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}
function createReed(): InstrumentRuntime {
  // 双簧/单簧：窄带宽的方波 + 高 Q 低通，接近木管「细亮」的音色
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'square' },
    envelope: { attack: 0.03, decay: 0.2, sustain: 0.85, release: 0.22 },
  })
  synth.volume.value = -17
  const filter = new Filter({ frequency: 2600, type: 'lowpass', rolloff: -24, Q: 3 })
  const reverb = new Reverb({ decay: 1.2, wet: 0.16 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}
function createChoir(): InstrumentRuntime {
  // 人声「啊」：多锯齿失谐 + 低通 + 长混响，最接近合唱铺底
  const synth = new PolySynth(Synth, {
    oscillator: { type: 'fatsawtooth', count: 4, spread: 30 },
    envelope: { attack: 0.5, decay: 0.5, sustain: 0.9, release: 1.8 },
  })
  synth.volume.value = -20
  const filter = new Filter({ frequency: 1100, type: 'lowpass', rolloff: -24 })
  const reverb = new Reverb({ decay: 3.2, wet: 0.4 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}
function createHarp(): InstrumentRuntime {
  // 竖琴：拨弦 + 明亮的短衰减 + 琴体共鸣
  const synth = new PolySynth(FMSynth, {
    harmonicity: 2, modulationIndex: 4, oscillator: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.6, sustain: 0.05, release: 1.2 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.4 },
  })
  synth.volume.value = -8
  const reverb = new Reverb({ decay: 2.0, wet: 0.28 })
  synth.chain(reverb)
  return wrapPolySynth(synth, reverb)
}
function createXylophone(): InstrumentRuntime {
  // 木琴：比马林巴更短更硬的敲击
  const synth = new PolySynth(FMSynth, {
    harmonicity: 6, modulationIndex: 18, oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.14 },
    modulation: { type: 'square' },
    modulationEnvelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.05 },
  })
  synth.volume.value = -10
  const reverb = new Reverb({ decay: 0.9, wet: 0.18 })
  synth.chain(reverb)
  return wrapPolySynth(synth, reverb)
}
function createTimpani(): InstrumentRuntime {
  // 定音鼓：膜式鼓体 + 低通，滚奏/重音都能立住
  const synth = new PolySynth(MembraneSynth, {
    pitchDecay: 0.06, octaves: 3, oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 0.7, sustain: 0.02, release: 1.2 },
  })
  synth.volume.value = -3
  const filter = new Filter({ frequency: 900, type: 'lowpass', rolloff: -12 })
  const reverb = new Reverb({ decay: 2.2, wet: 0.25 })
  synth.chain(filter, reverb)
  return wrapPolySynth(synth, reverb)
}

// ── 鼓组（GM 鼓映射：无采样 → 合成器，按音高分发） ─────────────────
function createDrumKit(): InstrumentRuntime {
  const out = new Gain(0.85)
  // 底鼓（35-36）
  const kick = new MembraneSynth({
    pitchDecay: 0.05, octaves: 5, oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 1.1 },
  })
  kick.volume.value = 0
  kick.connect(out)
  // 军鼓（37-40）
  const snare = new NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.32 },
  })
  snare.volume.value = -6
  snare.connect(out)
  const snareBody = new MembraneSynth({
    pitchDecay: 0.02, octaves: 4, oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.2 },
  })
  snareBody.volume.value = -10
  snareBody.connect(out)
  // 镲片（42/44/46/49/51/53/55/57）
  const hat = new MetalSynth({
    envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.09 },
    harmonicity: 6, modulationIndex: 60, resonance: 1100, octaves: 1,
  })
  hat.volume.value = -14
  hat.connect(out)
  const ride = new MetalSynth({
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.9 },
    harmonicity: 5, modulationIndex: 40, resonance: 800, octaves: 1,
  })
  ride.volume.value = -16
  ride.connect(out)
  // 嗵鼓（41/43/45/47/48/50）
  const tom = new MembraneSynth({
    pitchDecay: 0.07, octaves: 4, oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.75 },
  })
  tom.volume.value = -5
  tom.connect(out)

  const KICK = new Set([35, 36])
  const SNARE = new Set([37, 38, 40])
  const HAT = new Set([42, 44, 46, 54, 56, 58, 70, 71, 72, 80, 81, 82])
  const RIDE = new Set([49, 51, 53, 55, 57, 59, 61, 63, 65, 67, 69, 73, 74, 75, 76, 77, 78, 79])
  return {
    triggerAttackRelease: (note, duration, time, velocity) => {
      const p = noteToMidi(note)
      const vel = Math.max(0.2, velocity)
      if (KICK.has(p)) kick.triggerAttackRelease('C1', duration, time, vel)
      else if (SNARE.has(p)) { snare.triggerAttackRelease(duration, time, vel); snareBody.triggerAttackRelease('A1', duration, time, vel * 0.7) }
      else if (HAT.has(p)) hat.triggerAttackRelease('A5', duration, time, vel)
      else if (RIDE.has(p)) ride.triggerAttackRelease('A5', duration, time, vel)
      else tom.triggerAttackRelease(p <= 35 ? 'C1' : p >= 51 ? 'D2' : 'G1', duration, time, vel)
    },
    releaseAll: () => {
      // 合成器类（Membrane/Noise/Metal）无 releaseAll；只有 Sampler 有
      try { (kick as unknown as { releaseAll?: () => void }).releaseAll?.() } catch { /* noop */ }
      try { (snare as unknown as { releaseAll?: () => void }).releaseAll?.() } catch { /* noop */ }
      try { (snareBody as unknown as { releaseAll?: () => void }).releaseAll?.() } catch { /* noop */ }
      try { (hat as unknown as { releaseAll?: () => void }).releaseAll?.() } catch { /* noop */ }
      try { (ride as unknown as { releaseAll?: () => void }).releaseAll?.() } catch { /* noop */ }
      try { (tom as unknown as { releaseAll?: () => void }).releaseAll?.() } catch { /* noop */ }
    },
    dispose: () => { try { kick.dispose(); snare.dispose(); snareBody.dispose(); hat.dispose(); ride.dispose(); tom.dispose(); out.dispose() } catch { /* noop */ } },
    output: out,
  }
}
const DRUM_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function noteToMidi(note: string): number {
  const m = /^([A-G]#?)(-?\d+)$/.exec(note)
  if (!m) return 0
  const pc = DRUM_NOTE_NAMES.indexOf(m[1]!)
  return pc + (parseInt(m[2]!, 10) + 1) * 12
}

// ── 统一入口：smplr 在线 soundfont 优先，网络失败回落本地合成器 ───────
/** InstrumentId → GM soundfont 音色名（pluck/drums 无合适采样，直接用合成器） */
const ID_TO_SF: Partial<Record<InstrumentId, string>> = {
  piano: 'acoustic_grand_piano',
  digital: 'electric_piano_1',
  rhodes: 'electric_piano_2',
  pad: 'pad_2_warm',
  marimba: 'marimba',
  bells: 'glockenspiel',
  strings: 'string_ensemble_1',
  bass: 'acoustic_bass',
  violin: 'violin',
  flute: 'flute',
  guitar: 'acoustic_guitar_steel',
  organ: 'drawbar_organ',
  brass: 'brass_section',
  sax: 'alto_sax',
  reed: 'clarinet',
  choir: 'choir_aahs',
  harp: 'orchestral_harp',
  xylophone: 'xylophone',
  timpani: 'timpani',
}
/** 在线音色加载失败时的本地合成器 */
function synthFallback(id: InstrumentId): InstrumentRuntime {
  switch (id) {
    case 'violin':
    case 'strings': return createStrings()
    case 'guitar':
    case 'pluck': return createPluck()
    case 'bass': return createBass()
    case 'digital': return createDigitalPiano()
    case 'rhodes': return createRhodes()
    case 'pad': return createPad()
    case 'marimba': return createMarimba()
    case 'bells': return createBells()
    case 'drums': return createDrumKit()
    case 'organ': return createOrgan()
    case 'brass': return createBrass()
    case 'sax': return createSax()
    case 'reed': return createReed()
    case 'choir': return createChoir()
    case 'harp': return createHarp()
    case 'xylophone': return createXylophone()
    case 'timpani': return createTimpani()
    case 'piano':
    case 'flute':
    default: return createTriangleFallback()
  }
}

/**
 * 创建音色（三级兜底链）：在线 soundfont（整包/逐音竞速）→ 本地钢琴采样
 * （仅钢琴类：真实采样，绝不退合成器）→ 本地合成器。可选 force 跳过在线。
 * pitches = 本轨实际音高（MIDI 0-127），逐音方案只下载这些音。
 * 本函数【永不抛错】：任何环节失败都保证返回一个能出声的 runtime，
 * 因为这是可视化工具，播放不能被音色阻断。
 */
export async function createInstrument(
  id: InstrumentId,
  sfName?: string | null,
  pitches: Iterable<number> = [],
  opts?: CreateInstrumentOptions,
): Promise<InstrumentRuntime> {
  const { force, onProgress, onSource } = opts ?? {}
  if (id === 'drums') {
    onSource?.('synth')
    try { return createDrumKit() } catch { return safeBasicVoice() }
  }
  if (id === 'pluck') {
    onSource?.('synth')
    try { return createPluck() } catch { return safeBasicVoice() }
  }
  // 手动强制音源（音轨面板下拉选择）
  if (force === 'synth') {
    onSource?.('synth')
    try { return synthFallback(id) } catch { return safeBasicVoice() }
  }
  if (force === 'pianoSample') {
    try {
      const rt = await createPianoSampleRuntime()
      onSource?.('pianoSample')
      return rt
    } catch (err) {
      console.warn('[音色] 本地钢琴采样不可用，回退合成器：', err)
      onSource?.('synth')
      try { return synthFallback(id) } catch { return safeBasicVoice() }
    }
  }
  // 一级：在线 soundfont（多镜像竞速）
  // 全局开关关闭时跳过在线下载，直接走本地兜底（省流量）；
  // 但用户在下拉里显式选用的在线音色不受该开关限制（否则选了也不生效）
  const want = sfName ?? ID_TO_SF[id] ?? null
  if (want && (force === 'online' || getAutoSoundfont())) {
    try {
      const rt = await createSoundfontRuntime(want, pitches, onProgress)
      onSource?.('online')
      return rt
    } catch (err) {
      console.warn(`[音色] 在线音色 ${want} 不可用，走本地兜底：`, err)
    }
  }
  // 二级：钢琴类 → 本地真实钢琴采样（不退合成器）
  if (id === 'piano') {
    try {
      const rt = await createPianoSampleRuntime()
      onSource?.('pianoSample')
      return rt
    } catch (err) {
      console.warn('[音色] 本地钢琴采样不可用，最终回退合成器：', err)
    }
  }
  // 三级：合成器
  onSource?.('synth')
  try {
    return synthFallback(id)
  } catch (err) {
    console.warn('[音色] 合成器初始化失败，使用基础音色：', err)
    return safeBasicVoice()
  }
}

/** 最终兜底：零效果器的最简合成器（连它都失败时用裸振荡器），保证绝不静默/抛错 */
function safeBasicVoice(): InstrumentRuntime {
  try {
    const synth = new PolySynth(Synth, { oscillator: { type: 'triangle' } })
    return {
      triggerAttackRelease: (note, duration, time, velocity) => {
        try { synth.triggerAttackRelease(note, duration, time, velocity) } catch { /* noop */ }
      },
      releaseAll: () => { try { synth.releaseAll() } catch { /* noop */ } },
      dispose: () => { try { synth.dispose() } catch { /* noop */ } },
      output: synth,
    }
  } catch {
    return {
      triggerAttackRelease: () => undefined,
      releaseAll: () => undefined,
      dispose: () => undefined,
      output: { connect: () => undefined },
    }
  }
}

export { resolveSoundfontName }

// ── GM 音色号 → 乐器大类（音轨分组用）────────────────────────
// 轨名识别不到时按作者指定的音色号归类：弦乐(48-51)/提琴(40-43) 等
// 不再误挂到钢琴。具体音色号优先，族兜底在后。
const GM_PROGRAM_INST: Record<number, InstrumentId> = {
  8: 'bells', 9: 'bells', 10: 'bells', 11: 'bells', 12: 'marimba', 13: 'xylophone', 14: 'bells', 15: 'bells',
  24: 'guitar', 25: 'guitar', 26: 'guitar',
  32: 'bass', 33: 'bass', 34: 'bass', 35: 'bass', 36: 'bass', 37: 'bass', 38: 'bass', 39: 'bass',
  40: 'violin', 41: 'strings', 42: 'strings', 43: 'bass', 44: 'strings', 45: 'strings', 46: 'harp', 47: 'timpani',
  48: 'strings', 49: 'strings', 50: 'strings', 51: 'strings', 52: 'choir', 53: 'choir', 54: 'choir', 55: 'brass',
  65: 'sax', 66: 'sax', 67: 'sax', 68: 'reed', 69: 'reed', 70: 'reed', 71: 'reed', 72: 'flute', 73: 'flute',
  74: 'reed', 75: 'flute', 76: 'flute', 77: 'flute', 78: 'flute', 79: 'flute',
  106: 'guitar', 107: 'harp', 108: 'pluck', 109: 'reed', 110: 'violin', 111: 'reed',
  112: 'drums', 113: 'drums', 114: 'drums', 115: 'drums', 116: 'drums', 117: 'drums', 118: 'drums', 119: 'drums',
  120: 'drums', 121: 'drums', 122: 'drums', 123: 'drums', 124: 'drums', 125: 'drums', 126: 'drums', 127: 'drums',
}
export function gmProgramToInstrumentId(program: number | null | undefined): InstrumentId | null {
  if (typeof program !== 'number' || program < 0 || program > 127) return null
  const hit = GM_PROGRAM_INST[program]
  if (hit) return hit
  switch (Math.floor(program / 8)) {
    case 1: return 'bells'
    case 2: return 'organ'
    case 3: return 'guitar'
    case 4: return 'bass'
    case 5: return 'strings'
    case 6: return 'choir'
    case 7: return 'brass'
    case 8: return 'reed'
    case 9: return 'flute'
    case 10: return 'pad'
    case 11: return 'pad'
    case 12: return 'pad'
    case 13: return 'pluck'
    case 0: return 'piano'
    default: return 'drums'
  }
}

// ── 轨道名/乐器名 → 音色（导入什么就播什么；未识别回退钢琴） ──────
// 顺序即优先级：具体乐器在前，族类兜底在后。中英文别名都要覆盖，
// 否则大总谱里「Cello / 大提琴 / Vc.」这类写法会被漏成钢琴。
const NAME_RULES: [RegExp, InstrumentId][] = [
  // 键盘 / 电钢
  [/piano|grand|upright|钢琴|pno|pf\b/i, 'piano'],
  [/harpsichord|clavinet|大键琴|拨弦古钢/i, 'pluck'],
  [/digital|电钢|synth\s*piano/i, 'digital'],
  [/rhodes|electric\s*piano|e\.?p\.?\b/i, 'rhodes'],
  // 弦乐（具体乐器优先于族类）
  [/violin|小提琴|vln|vl\b/i, 'violin'],
  [/viola|中提琴|vla\b/i, 'strings'],
  [/cello|大提琴|vc\b|vlc\b/i, 'strings'],
  [/contrabass|double\s*bass|低音提琴|cb\b/i, 'bass'],
  [/fiddle|古提琴/i, 'violin'],
  [/strings|弦乐|弦乐组|str\b|ensemble\s*strings|tremolo|pizzicato/i, 'strings'],
  // 木管
  [/piccolo|短笛/i, 'flute'],
  [/flute|长笛|fl\b|wind|吹管|recorder|竖笛|shakuhachi|尺八|ocarina|陶笛|pan\s*flute|排箫/i, 'flute'],
  [/oboe|双簧|english\s*horn|英国管|bassoon|大管|巴松|clarinet|单簧|bcl\b/i, 'reed'],
  // 铜管
  [/trumpet|小号|tpt\b|cornet|flugel/i, 'brass'],
  [/trombone|长号|tbn\b|tuba|大号|french\s*horn|圆号|horn\b|brass|铜管/i, 'brass'],
  // 萨克斯
  [/sax|萨克|saxophone/i, 'sax'],
  // 吉他 / 弹拨
  [/guitar|吉他|ukulele|尤克里里|banjo|班卓|mandolin|曼陀林|bass\s*guitar|贝斯吉他/i, 'guitar'],
  [/harp|竖琴|koto|古筝|guzheng|sitar|西塔尔/i, 'harp'],
  [/pluck|拨弦|pizz/i, 'pluck'],
  // 人声
  [/choir|合唱|人声|vocal|voice|aahs|oohs|vox|颂歌/i, 'choir'],
  // 风琴
  [/organ|风琴|管风琴|harmonica|口琴|accordion|手风琴|accordéon|bandoneon/i, 'organ'],
  // 打击（有音高的在前，鼓组在最后）
  [/timpani|定音鼓|kettle\s*drum/i, 'timpani'],
  [/xylophone|木琴/i, 'xylophone'],
  [/marimba|马林巴/i, 'marimba'],
  [/vibraphone|颤音琴|glock|钟琴|celesta|钢片琴|music\s*box|八音盒/i, 'bells'],
  [/bell|铃|tubular|管钟|chime/i, 'bells'],
  [/drum|perc|鼓|打击|hit\s*kit|cymbals?|镲/i, 'drums'],
  // 合成 / 氛围
  [/pad|氛围|synth\s*pad|atmosphere/i, 'pad'],
  [/bass|贝斯|低音/i, 'bass'],
]
/** 严格识别：未命中规则返回 null（显示层用原名；音色层再自行回退钢琴） */
export function matchInstrumentName(name: string | null | undefined): InstrumentId | null {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return null
  for (const [re, id] of NAME_RULES) {
    if (re.test(n)) return id
  }
  return null
}
export function mapInstrumentName(name: string | null | undefined): InstrumentId {
  // 未识别 → 自动回退钢琴
  return matchInstrumentName(name) ?? 'piano'
}

// ── GM 128 音色目录（音轨面板「音色」下拉） ─────────────────────
// 中文名与 GM 族名已移至 smplr-soundfont.ts（与 GM_PROGRAM_NAMES 同处），
// 此处再导出供 tracks.ts 等使用。
export { GM_CHINESE_NAMES, GM_FAMILY_NAMES } from './smplr-soundfont'
