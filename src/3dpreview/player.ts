// ═══════════════════════════════════════════════════════════════════════
// 播放系统（音频执行器）：
//   MIDI 解析（@tonejs/midi，保留轨名/乐器标记）→ 每轨独立音色（采样/合成器补丁）
//   → 每轨 Gain（音量/静音）→ 音符按 (事件秒 / speed) 直接投递到 AudioContext 时间轴
//   （唯一事件源 + 单处变速；进度/时间一律读 playbackEngine 单一播放头）
//   音色自动对应：导入轨标记（轨名/乐器名）→ midee 音色；未识别自动回退钢琴
// ═══════════════════════════════════════════════════════════════════════
import { Gain, Limiter, getContext, getDestination, start as toneStart } from 'tone'
import { playbackEngine } from '../playback/PlaybackEngine'
import { setSoundfontInUseProvider } from './smplr-soundfont'
import { createInstrument, gmProgramToInstrumentId, matchInstrumentName, resolveSoundfontName, type CreateInstrumentOptions, type InstrumentId, type InstrumentRuntime, type SoundSourceKind } from './instruments'

export type PlayerState = 'idle' | 'loading' | 'ready' | 'playing'

/** 音色选择（音轨面板下拉）：auto=三级兜底链，其余为强制音源/在线音色 */
export type SoundTarget =
  | { kind: 'auto' }
  | { kind: 'online'; sfName: string }
  | { kind: 'pianoSample' }
  | { kind: 'synth' }

/** 每轨音色状态（供面板显示当前生效音源与下载进度） */
export interface TrackSoundState {
  source: SoundSourceKind | 'loading'
  /** 0-1 在线逐音下载进度；null = 无进行中的下载 */
  progress: number | null
  target: SoundTarget
}

export interface MidiNote {
  pitch: number // 0-127
  time: number // 秒
  duration: number // 秒
  velocity: number // 0-1
}
export interface MidiTrack {
  id: string
  name: string // 轨名/乐器名（原始标记）
  instrumentId: InstrumentId // 自动映射结果
  /** smplr 在线 soundfont 音色名；null = 鼓组或无对应采样（用合成器） */
  sfName: string | null
  /** 轨名是否命中已知乐器（false 时界面显示原名） */
  instrumentKnown: boolean
  channel: number // 轨索引（点亮颜色 trackColors[channel]）
  notes: MidiNote[]
}
export interface ParsedMidi {
  name: string
  duration: number // 秒
  bpm: number
  timeSignature: [number, number]
  tracks: MidiTrack[]
}

export interface PlayerCallbacks {
  onProgress(t: number): void
  onEnd(): void
  onState(s: PlayerState): void
}

// ── MIDI 解析（照抄 midee src/core/midi/parser.ts） ───────────────
/**
 * 播放源选择：默认标准 MIDI（XML 生成）；用户在设置里显式选择后才用原始 MIDI。
 * 原 MIDI 永远不用于连线 / 3D 计算（量化往返会拉伸演奏事件）。
 */
export function playbackMidiB64(): string | null {
  const std = sessionStorage.getItem('midee.midi')
  if (!std) return sessionStorage.getItem('midee.midiOrig')
  let useOrig = false
  try {
    useOrig = localStorage.getItem('midee.playOriginal') === '1'
  } catch {
    /* noop */
  }
  return useOrig ? sessionStorage.getItem('midee.midiOrig') ?? std : std
}

let midiModuleLoad: Promise<typeof import('@tonejs/midi')> | null = null
function loadMidiModule(): Promise<typeof import('@tonejs/midi')> {
  if (!midiModuleLoad) midiModuleLoad = import('@tonejs/midi')
  return midiModuleLoad
}

/**
 * 修复轨名编码：xmlToMidi 按 SMF 惯例写 UTF-8 字节，而 @tonejs/midi 把
 * meta 文本当 Latin-1 逐字节读（「右手」会变成 å³æ）。能按合法 UTF-8
 * 解回就解回，否则保留原始串（真实 Latin-1 名字如 café 会校验失败而原样保留）。
 */
function decodeTrackName(raw: string): string {
  if (!raw) return raw
  const bytes = Uint8Array.from([...raw].map((c) => c.charCodeAt(0) & 0xff))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return raw
  }
}

export async function parseMidiBytes(bytes: Uint8Array, name = 'Untitled'): Promise<ParsedMidi> {
  const { Midi } = await loadMidiModule()
  const midi = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  const tracks = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => {
      const notes: MidiNote[] = t.notes.map((n) => ({
        pitch: n.midi,
        time: n.time,
        duration: Math.max(n.duration, 0.05), // 最小可视时长
        velocity: n.velocity,
      }))
      notes.sort((a, b) => a.time - b.time) // 升序不变量（调度二分依赖）
      const rawName = decodeTrackName(t.name ?? t.instrument?.name ?? '')
      const family = t.instrument?.family ?? ''
      // 归类顺序：轨名关键词（最具体）→ GM 音色号（弦乐/提琴/铜管等不再误挂钢琴）→ 钢琴兜底
      let matched = matchInstrumentName(rawName || family) ?? gmProgramToInstrumentId(t.instrument?.number)
      // 「右手 / 左手」是钢琴大谱表的声部名：归入钢琴组（音色也是钢琴）
      if (!matched && /(右手|左手|\bright\b|\bleft\b|\br\s*h\b|\bl\s*h\b)/i.test(rawName)) {
        matched = 'piano'
      }
      const instrumentId: InstrumentId = family && /drum|perc|鼓|打击/i.test(family)
        ? 'drums'
        : matched ?? 'piano' // 未识别 → 音色自动回退钢琴
      // 在线音色：MIDI program change 优先（作者指定），轨名关键词兜底
      const sfName = resolveSoundfontName(
        typeof t.instrument?.number === 'number' ? t.instrument.number : null,
        family,
        rawName,
      )
      return {
        id: `track-${i}`,
        name: rawName,
        instrumentId,
        sfName: instrumentId === 'drums' ? null : sfName,
        instrumentKnown: matched !== null,
        channel: i,
        notes,
      }
    })
  if (!tracks.length) throw new Error('MIDI contains no playable notes.')
  const bpm = midi.header.tempos[0]?.bpm ?? 120
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4]
  return {
    name: name.replace(/\.mid[i]?$/i, ''),
    duration: midi.duration,
    bpm,
    timeSignature: [ts[0] ?? 4, ts[1] ?? 4],
    tracks,
  }
}

// 把乐器出口接到每轨 Gain：原生节点（smplr）与 Tone 节点混用，
// 任何连接异常都不允许向上抛（接不上最坏只是该轨无声，不能拖死播放）
function safeConnectOutput(inst: InstrumentRuntime, gain: Gain): void {
  try {
    inst.output.connect(gain)
  } catch {
    try {
      const ng = (gain as unknown as { _gainNode?: AudioNode })._gainNode
      if (ng) inst.output.connect(ng)
    } catch { /* 放弃接线，保证不抛 */ }
  }
}

// 并发受限的 map：最多同时跑 limit 个任务，结果与 Promise.allSettled 同构。
// 大总谱同时建 20 条音色会把网络/解码/主线程一起打满，这是卡顿与进度停滞的主因。
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!, i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ── 播放器（照抄 midee SynthEngine：Part 单入口 + latest-wins 守卫） ─
interface TrackRuntime {
  inst: InstrumentRuntime
  gain: Gain
  volume: number // 0-1.5（用户音量，100% 默认 = 1.0）
  muted: boolean
}

export class MideePlayer {
  private midi: ParsedMidi | null = null
  private trackMap = new Map<string, TrackRuntime>()
  private master: Gain | null = null
  private limiter: Limiter | null = null
  private masterVol = 1.0
  private callbacks: PlayerCallbacks
  private state: PlayerState = 'idle'
  // 播放进度（MusicTime）一律来自唯一播放头 playbackEngine（单播放头原则），
  // 本类只做「音频执行器」：把 lookahead 窗口内的未来音符按 (事件秒 / speed) 投递到
  // AudioContext 时间轴，不在画面侧二次变速。
  private offset = 0 // seek 落点（非播放态回显；播放中实际进度读引擎）
  private playGeneration = 0
  private rafId: number | null = null
  private ended = false
  // 增量调度状态：每轨「下一个待调度音符」索引（notes 升序不变量）+ 兜底定时器。
  // 不能一次性调度全曲：pause/seek 后已排队的未来音符无法取消（smplr 内部
  // Scheduler 队列 stop() 不清、Tone 合成器 release 只作用于已发声 voice），
  // 会表现为暂停后音乐继续响、seek 后新旧两套音符叠加。lookahead 窗口取
  // 0.18s < smplr 内部 lookahead(200ms)，音符总是立即建 voice，releaseAll
  // 能把窗口内全部取消（Sampler 路径 source.stop(t<start) 天然取消）。
  private schedIdx: number[] = []
  private schedTimer: number | null = null
  // 音色状态（每轨当前生效音源 / 在线下载进度 / 用户选择），面板订阅刷新
  private soundState = new Map<string, TrackSoundState>()
  private soundListeners = new Set<(trackIds: string[]) => void>()
  /** load/dispose 代数：热切换异步完成后校验，防止把旧结果接进新谱 */
  private loadGen = 0

  constructor(cb: PlayerCallbacks) {
    this.callbacks = cb
    // 资源面板「使用中」= 某轨显式选用了该在线音色；
    // 自动兜底拉取不算，避免「刚下载完还没选就显示使用中」
    setSoundfontInUseProvider((sfName) => this.isSoundfontAssigned(sfName))
  }

  /** 该在线音色是否被某轨显式选用且已生效（音轨面板下拉指定） */
  private isSoundfontAssigned(sfName: string): boolean {
    for (const st of this.soundState.values()) {
      if (st.source === 'online' && st.target.kind === 'online' && st.target.sfName === sfName) return true
    }
    return false
  }

  get duration(): number { return this.midi?.duration ?? 0 }
  get playing(): boolean { return this.state === 'playing' }
  get tracks(): MidiTrack[] { return this.midi?.tracks ?? [] }
  get currentTime(): number { return playbackEngine.now() }

  private setState(s: PlayerState): void {
    this.state = s
    this.callbacks.onState(s)
  }

  /** 加载 MIDI + 各轨音色（幂等）。onProgress 用于把音色加载并入界面加载弹窗 */
  async load(bytes: Uint8Array, name?: string, onProgress?: (frac: number, label?: string) => void): Promise<void> {
    this.stop()
    this.loadGen++
    this.soundState.clear()
    this.setState('loading')
    try {
      this.midi = await parseMidiBytes(bytes, name)
      this.disposeTracks()
      if (!this.master) {
        // 主链：各轨 Gain → master → Limiter → 输出。
        // Limiter 兜住多轨叠加的瞬时峰值（爆音/削波），-1dB 阈值对听感几乎无损。
        this.limiter = new Limiter(-1)
        this.limiter.toDestination()
        this.master = new Gain(this.masterVol).connect(this.limiter)
      }
      const gen = this.loadGen
      // 音量策略：每轨固定 100%（1.0），不做按轨数衰减（那会让总谱整体过小）。
      // 多轨叠加的峰值交给主链 limiter 做「上限固定的动态调节」：
      // 超过 -1dB 的瞬时按比例压缩，既不削波爆音，也不会把正常音量压得很小。
      const perTrackGain = 1.0
      // 各轨音色（三级兜底链：在线竞速 → 钢琴采样 → 合成器）。
      // 单轨任何环节失败都不能阻断整曲：createInstrument 自身永不抛错，
      // 这里再用 allSettled 兜一层，失败轨用基础音色重建（可视化优先，播放必须可用）。
      //
      // 并发限制：20 轨总谱若全部同时去抢网络/解码，会把连接池打满、
      // 进度条乱跳、CPU 尖峰导致播放断续。这里限制同时构建 4 轨，
      // 其余排队，并按「已完成轨数」推进加载弹窗。
      const trackList = this.midi.tracks
      const total = Math.max(1, trackList.length)
      let doneCount = 0
      const report = (): void => {
        const frac = doneCount / total
        onProgress?.(frac, `正在加载音色 ${doneCount}/${total}`)
      }
      report()
      const built = await mapLimit(trackList, 4, async (tr) => {
        this.soundState.set(tr.id, { source: 'loading', progress: null, target: { kind: 'auto' } })
        const inst = await this.buildInstrument(tr, { kind: 'auto' })
        const gain = new Gain(perTrackGain).connect(this.master!)
        safeConnectOutput(inst, gain)
        doneCount++
        report()
        return { tr, inst, gain }
      })
      const rts = await Promise.all(
        built.map(async (r, i) => {
          if (r.status === 'fulfilled') return r.value
          console.warn('[播放] 音轨音色初始化失败，使用基础音色：', r.reason)
          const tr = this.midi!.tracks[i]!
          const inst = await createInstrument('piano', null, tr.notes.map((n) => n.pitch))
          const gain = new Gain(perTrackGain).connect(this.master!)
          safeConnectOutput(inst, gain)
          return { tr, inst, gain }
        }),
      )
      if (gen !== this.loadGen) {
        // 期间被新 load/dispose 打断：释放刚建好的音色，避免残留占用
        for (const { inst, gain } of rts) {
          try { inst.dispose(); gain.dispose() } catch { /* noop */ }
        }
        return
      }
      for (const { tr, inst, gain } of rts) {
        this.trackMap.set(tr.id, { inst, gain, volume: 1.0, muted: false })
      }
      this.offset = 0
      this.ended = false
      playbackEngine.setDuration(this.midi.duration)
      playbackEngine.stop() // MusicTime = 0，非播放态（播放头随新谱归零）
      this.setState('ready')
    } catch (e) {
      this.setState('idle')
      throw e
    }
  }

  /** 按目标构建一轨音色（三级兜底链），过程进度/落点写 soundState 并广播 */
  private async buildInstrument(tr: MidiTrack, target: SoundTarget): Promise<InstrumentRuntime> {
    const setState = (patch: Partial<TrackSoundState>): void => {
      const cur = this.soundState.get(tr.id)
      if (!cur) return
      Object.assign(cur, patch)
      this.emitSound([tr.id])
    }
    setState({ source: 'loading', progress: null, target })
    const opts: CreateInstrumentOptions = {
      onProgress: (l, t) => setState({ progress: t > 0 ? Math.min(1, l / t) : null }),
      onSource: (src) => setState({ source: src, progress: null }),
    }
    if (target.kind === 'pianoSample') opts.force = 'pianoSample'
    else if (target.kind === 'synth') opts.force = 'synth'
    else if (target.kind === 'online') opts.force = 'online'
    const sfName = target.kind === 'online' ? target.sfName : target.kind === 'auto' ? tr.sfName : null
    return createInstrument(tr.instrumentId, sfName, tr.notes.map((n) => n.pitch), opts)
  }

  /** 读取每轨音色状态（当前生效音源 / 下载进度 / 用户选择） */
  getTrackSoundState(trackId: string): TrackSoundState | null {
    return this.soundState.get(trackId) ?? null
  }

  /** 订阅音色状态变化（进度/落点/手动切换）；返回取消函数 */
  onTrackSound(cb: (trackIds: string[]) => void): () => void {
    this.soundListeners.add(cb)
    return () => this.soundListeners.delete(cb)
  }

  private emitSound(ids: string[]): void {
    for (const fn of this.soundListeners) {
      try { fn(ids) } catch { /* 面板回调异常不拖播放 */ }
    }
  }

  /**
   * 手动切换一组轨的音色（音轨面板下拉）：热替换 inst，gain/音量/静音保留，
   * 播放中可切换（调度读 trackMap，替换是同步原子）。失败自动走兜底链。
   */
  setTrackSound(trackIds: string[], target: SoundTarget): void {
    if (!this.midi) return
    const gen = this.loadGen
    for (const id of trackIds) {
      const tr = this.midi.tracks.find((t) => t.id === id)
      if (!tr) continue
      void (async () => {
        try {
          const inst = await this.buildInstrument(tr, target)
          if (gen !== this.loadGen) { try { inst.dispose() } catch { /* noop */ } return }
          const old = this.trackMap.get(tr.id)
          if (!old) { try { inst.dispose() } catch { /* noop */ } return }
          safeConnectOutput(inst, old.gain)
          try { old.inst.dispose() } catch { /* noop */ }
          this.trackMap.set(tr.id, { inst, gain: old.gain, volume: old.volume, muted: old.muted })
          this.emitSound([tr.id])
        } catch (err) {
          console.warn('[播放] 手动切换音色失败：', err)
        }
      })()
    }
  }

  /** 主音量（0-1.5，100% 默认），播放条音量滑杆。上限由主链 limiter 固定 */
  setMasterVolume(v: number): void {
    this.masterVol = Math.max(0, Math.min(1.5, v))
    this.master?.gain.rampTo(this.masterVol, 0.05)
  }

  /** 每轨音量（0-1.5 线性，100% 默认，平滑过渡） */
  setTrackVolume(trackId: string, v: number): void {
    const tr = this.trackMap.get(trackId)
    if (!tr) return
    tr.volume = Math.max(0, Math.min(1.5, v))
    if (!tr.muted) tr.gain.gain.rampTo(tr.volume, 0.05)
  }

  /** 读取每轨当前音量（0-1.5；不存在返回默认 1.0），供音量滑杆回显 */
  getTrackVolume(trackId: string): number {
    return this.trackMap.get(trackId)?.volume ?? 1.0
  }

  /** 每轨静音开关（播放控制） */
  setTrackMute(trackId: string, muted: boolean): void {
    const tr = this.trackMap.get(trackId)
    if (!tr) return
    tr.muted = muted
    tr.gain.gain.rampTo(muted ? 0 : tr.volume, 0.05)
  }

  async play(fromTime?: number): Promise<void> {
    if (!this.midi) return
    const gen = ++this.playGeneration
    // 允许负 startFrom（lead-in 留白）：播放头在留白段静默推进，音乐 0 时刻才响
    const startFrom = fromTime ?? (this.ended ? 0 : playbackEngine.now())
    await toneStart()
    if (gen !== this.playGeneration) return // 期间被 pause/stop/seek 打断

    // 增量调度：只初始化各轨起始索引，音符由 scheduleUpcoming() 按 lookahead
    // 窗口逐帧投递（见字段注释——全量调度会让 pause/seek 留下无法取消的队列）。
    this.releaseAll()
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId) // 播放中 seek/变速：旧 tick 链作废，只留新链
      this.rafId = null
    }
    // 显式起点与播放头不一致（如从 -axisLead 起播）→ 先锚定播放头
    if (fromTime !== undefined && Math.abs(playbackEngine.now() - startFrom) > 1e-6) {
      playbackEngine.seek(startFrom)
    }
    this.schedIdx = this.midi.tracks.map((tr) => {
      const notes = tr.notes
      let lo = 0, hi = notes.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (notes[mid]!.time < startFrom - 1e-6) lo = mid + 1; else hi = mid }
      return lo
    })
    this.offset = startFrom
    this.ended = false
    playbackEngine.play() // 播放头锚定当前音频钟：MusicTime 从此按 speed 连续前进
    this.setState('playing')
    this.startSchedTimer()
    this.scheduleUpcoming()
    this.tick()
  }

  /** 音频秒 lookahead：窗口内音符提前投递到 AudioContext 时间轴 */
  private static SCHEDULE_AHEAD = 0.18

  /** 把 (musicNow, musicNow + ahead] 窗口内的音符投递出去（幂等：schedIdx 单调推进） */
  private scheduleUpcoming(): void {
    if (!this.midi || this.state !== 'playing') return
    const spd = playbackEngine.speed
    const ctxNow = getContext().currentTime
    const musicNow = playbackEngine.now()
    const horizon = musicNow + MideePlayer.SCHEDULE_AHEAD * spd // 音乐秒
    for (let ti = 0; ti < this.midi.tracks.length; ti++) {
      const track = this.midi.tracks[ti]!
      const inst = this.trackMap.get(track.id)?.inst
      if (!inst) continue
      const notes = track.notes
      let i = this.schedIdx[ti] ?? 0
      while (i < notes.length && notes[i]!.time < horizon) {
        const n = notes[i]!
        const at = ctxNow + Math.max(0, n.time - musicNow) / spd
        inst.triggerAttackRelease(
          midiToNoteName(n.pitch),
          Math.max(0.02, n.duration / spd),
          at,
          Math.min(1, Math.max(0.001, n.velocity)),
        )
        i++
      }
      this.schedIdx[ti] = i
    }
  }

  /** 调度兜底定时器：rAF 被节流/卡顿时保证音符照常投递（幂等，与 tick 并存安全） */
  private startSchedTimer(): void {
    this.stopSchedTimer()
    this.schedTimer = window.setInterval(() => this.scheduleUpcoming(), 120)
  }
  private stopSchedTimer(): void {
    if (this.schedTimer !== null) {
      window.clearInterval(this.schedTimer)
      this.schedTimer = null
    }
  }

  pause(): void {
    if (this.state !== 'playing') return
    this.playGeneration++
    this.stopSchedTimer()
    playbackEngine.pause()
    this.offset = playbackEngine.now()
    this.releaseAll()
    this.setState('ready')
  }

  stop(): void {
    this.playGeneration++
    this.stopSchedTimer()
    this.ended = false
    playbackEngine.stop()
    this.offset = 0
    this.releaseAll()
    this.setState('idle')
    this.callbacks.onProgress(0)
  }

  seek(t: number): void {
    const wasPlaying = this.state === 'playing'
    this.playGeneration++
    // 允许负目标（lead-in 留白）：第五页从 -axisLead 起播——留白段播放头静默推进，
    // 0 时刻音乐才开始响（球正好从起点线落到首个符头）。下限放宽到 -1000s。
    const target = Math.max(-1e3, Math.min(t, this.duration))
    playbackEngine.seek(target)
    this.offset = target
    this.releaseAll()
    if (this.ended && this.offset < this.duration - 0.01) this.ended = false
    if (wasPlaying) void this.play(this.offset)
    else this.callbacks.onProgress(this.offset)
  }

  setSpeed(s: number): void {
    const ns = s > 0 ? s : 1
    if (ns === playbackEngine.speed) return
    const wasPlaying = this.state === 'playing'
    playbackEngine.setSpeed(ns) // 旧速下取样当前 MusicTime，新速从同一点继续（不跳变）
    if (wasPlaying && this.midi) {
      // 以新速重算余下音符的音频时间并重投递（offset 已在引擎内锚定）
      const pos = playbackEngine.now()
      this.offset = pos
      this.releaseAll()
      void this.play(pos)
    }
  }

  private releaseAll(): void {
    for (const tr of this.trackMap.values()) {
      try { tr.inst.releaseAll() } catch { /* noop */ }
    }
  }

  private disposeTracks(): void {
    for (const tr of this.trackMap.values()) {
      try { tr.inst.dispose(); tr.gain.dispose() } catch { /* noop */ }
    }
    this.trackMap.clear()
  }

  private tick = (): void => {
    if (this.state !== 'playing') return
    this.scheduleUpcoming() // 帧级增量投递（与 120ms 兜底定时器双保险，幂等）
    const t = playbackEngine.now()
    if (t >= this.duration && this.duration > 0) {
      this.playGeneration++
      this.stopSchedTimer()
      playbackEngine.end()
      this.releaseAll()
      this.offset = this.duration
      this.ended = true
      this.setState('ready')
      this.callbacks.onProgress(this.duration)
      this.callbacks.onEnd()
      return
    }
    this.callbacks.onProgress(t)
    this.rafId = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    this.playGeneration++
    this.loadGen++
    this.stopSchedTimer()
    playbackEngine.stop()
    this.releaseAll()
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.disposeTracks()
    this.soundState.clear()
    this.soundListeners.clear()
    try { this.master?.dispose() } catch { /* noop */ }
    this.master = null
    try { this.limiter?.dispose() } catch { /* noop */ }
    this.limiter = null
    this.setState('idle')
  }
}

// 音名转换（同 midee midiNoteName）
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export function midiToNoteName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1
  return `${NOTE_NAMES[pitch % 12]}${octave}`
}

export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 默认导出 AudioContext 引用保持（树摇优化提示）
export { getDestination as _dest }
