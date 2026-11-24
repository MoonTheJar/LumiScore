import {
  gainToDb,
  getContext,
  getDestination,
  getTransport,
  immediate,
  Part,
  start as toneStart,
} from 'tone'
import type { MidiFile } from '../core/midi/types'
import { gmProgramToInstrument } from '../core/midi/gmInstruments'
import { createEventSignal } from '../store/eventSignal'
import type { AudioEngine } from './AudioEngine'
import {
  createInstrument,
  type InstrumentId,
  type InstrumentRuntime,
  midiToNoteName,
} from './instruments'

export type { InstrumentId, InstrumentInfo } from './instruments'
export { INSTRUMENTS } from './instruments'

interface NoteEvent {
  note: string
  duration: number
  velocity: number
  trackId: string
}

export class SynthEngine implements AudioEngine {
  private instruments = new Map<InstrumentId, InstrumentRuntime>()
  private loadingPromises = new Map<InstrumentId, Promise<InstrumentRuntime>>()
  // Default voice is Upright (1.2 MB of our own samples) instead of the 30 MB
  // Salamander Grand set that @tonejs/piano pulls from an external CDN —
  // 25× lighter first-load, bulletproof against upstream CDN outages, still
  // musically pleasing. Users who specifically want the concert grand are
  // one tap away in the instrument dropdown.
  private currentId: InstrumentId = 'upright'
  // Global ambience wet level (0-1). Every loaded voice's internal Reverb is
  // rewritten to this value; voices created later adopt it at load time.
  // Default 0.2 ≈ the room-level wet most built-in voices ship with.
  private reverbWet = 0.2
  // Emits the currently-active instrument id while its samples/patch are
  // loading, null otherwise. Only tracks the *current* instrument — background
  // preloads of other voices don't flicker the signal.
  readonly loadingInstrument = createEventSignal<InstrumentId | null>(null)
  private midi: MidiFile | null = null
  // Tone.Part holding every note as a single transport entry. Replaces N×2
  // transport.schedule calls on play/seek — O(N) work to build, but building a
  // Part is ~10× faster than N individual schedules on dense MIDIs (tested
  // 10k+ notes), and seek reuses the same Part via `part.start(0, offset)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scheduledPart: any | null = null
  private _speed = 1
  private scheduledFromTime = 0
  private readyPromise: Promise<void> = Promise.resolve()
  private liveWarmupStarted = false
  // Latest-wins guard for `play()`. `play()` is async (awaits readyPromise +
  // Tone.start) and can be racing against a subsequent `pause()`. Without
  // this, calling pause during the async window lets the next transport.start
  // at the tail of play() fire after we thought we paused — audio leaks.
  // Each play() call increments; if a newer call or a pause() ran, the older
  // play() bails before hitting transport.start.
  private playGeneration = 0
  // Tracks the user has muted via the Tracks panel. Checked at trigger time
  // inside the scheduled Part — new notes from a disabled track are skipped,
  // notes already in flight finish their natural decay (we don't track per-track
  // voice handles, and stealing them mid-note would click).
  private disabledTrackIds = new Set<string>()
  // Per-track instrument assignment. Filled from the MIDI's GM program numbers
  // on load (see assignTrackInstruments); the global `currentId` is the
  // fallback for tracks without an entry (e.g. live input has no tracks).
  // A track keeps its assigned instrument across open/close toggles — closing
  // never clears this map, and the global instrument menu only rewrites entries
  // for tracks that are currently audible.
  private trackInstruments = new Map<string, InstrumentId>()

  async load(source: MidiFile | AudioBuffer): Promise<void> {
    if (!(source instanceof AudioBuffer)) {
      const next = source as MidiFile
      // Only reassign per-track instruments when this is a genuinely NEW
      // piece. Re-loading the same MIDI (e.g. Learn mode re-feeding the
      // current file) must NOT reset the voices the user assigned via the
      // instrument menu — a track keeps its chosen instrument until the song
      // actually changes.
      const samePiece =
        this.midi?.name === next.name &&
        this.midi.tracks.length === next.tracks.length &&
        this.midi.tracks.every((tr, i) => tr.id === next.tracks[i]?.id)
      this.midi = next
      // A new file's tracks are unrelated to whatever the user muted previously,
      // and its GM program numbers determine the per-track voices.
      this.disabledTrackIds.clear()
      if (!samePiece) this.assignTrackInstruments(this.midi)
    }
    this.readyPromise = this.ensureInstrument(this.currentId).then(() => undefined)
    return this.readyPromise
  }

  // Assign each track its GM-derived instrument, kicking off background loads
  // for every voice that will actually be used. Tracks with no usable program
  // identifier fall back to the default piano.
  assignTrackInstruments(midi: MidiFile): void {
    this.trackInstruments.clear()
    const needed = new Set<InstrumentId>()
    for (const track of midi.tracks) {
      const id = gmProgramToInstrument(track.instrument, track.isDrum)
      this.trackInstruments.set(track.id, id)
      needed.add(id)
    }
    for (const id of needed) {
      void this.ensureInstrument(id).catch(() => undefined)
    }
  }

  setTrackInstrument(trackId: string, id: InstrumentId): void {
    this.trackInstruments.set(trackId, id)
    // Warm the new voice so the switch doesn't drop the first notes on a
    // sampled instrument that hasn't been fetched yet.
    void this.ensureInstrument(id).catch(() => undefined)
  }

  getTrackInstrument(trackId: string): InstrumentId {
    return this.trackInstruments.get(trackId) ?? this.currentId
  }

  getTrackInstrumentMap(): ReadonlyMap<string, InstrumentId> {
    return this.trackInstruments
  }

  setTrackEnabled(trackId: string, enabled: boolean): void {
    if (enabled) this.disabledTrackIds.delete(trackId)
    else this.disabledTrackIds.add(trackId)
  }

  getDisabledTrackIds(): ReadonlySet<string> {
    return this.disabledTrackIds
  }

  // Kick off piano sample download in the background — safe to call at app
  // boot. AudioContext still requires a user gesture before `play()`.
  preloadDefault(): void {
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  // Switch the active instrument for both scheduled and live playback.
  // Loading is lazy; selecting an unloaded instrument kicks off its init.
  async setInstrument(id: InstrumentId): Promise<void> {
    if (id === this.currentId) return
    // Release anything currently sounding on the old instrument
    this.instruments.get(this.currentId)?.releaseAll()
    this.currentId = id
    await this.ensureInstrument(id)
  }

  get instrument(): InstrumentId {
    return this.currentId
  }

  // Rewrite every loaded voice's reverb wet to the given 0-1 level. Voices
  // that have no internal Reverb ignore the call.
  setReverbWet(wet: number): void {
    this.reverbWet = Math.max(0, Math.min(1, wet))
    for (const inst of this.instruments.values()) {
      inst.setReverbWet?.(this.reverbWet)
    }
  }

  getReverbWet(): number {
    return this.reverbWet
  }

  private ensureInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
    const cached = this.instruments.get(id)
    if (cached) return Promise.resolve(cached)
    const existing = this.loadingPromises.get(id)
    if (existing) return existing

    // Reflect loading in the signal only when we're loading the *current*
    // instrument — preloads of others happen silently in the background.
    if (id === this.currentId) this.loadingInstrument.set(id)

    const clearIfCurrent = (): void => {
      if (this.loadingInstrument.value === id) this.loadingInstrument.set(null)
    }
    const promise = createInstrument(id).then(
      (inst) => {
        inst.setReverbWet?.(this.reverbWet)
        this.instruments.set(id, inst)
        this.loadingPromises.delete(id)
        clearIfCurrent()
        return inst
      },
      (err) => {
        this.loadingPromises.delete(id)
        clearIfCurrent()
        throw err
      },
    )
    this.loadingPromises.set(id, promise)
    return promise
  }

  async play(fromTime: number): Promise<void> {
    if (!this.midi) return
    const gen = ++this.playGeneration
    await this.readyPromise
    await toneStart()
    // A pause() or a newer play() happened during the awaits — abandon this
    // invocation so we don't resurrect transport audio against user intent.
    if (gen !== this.playGeneration) return

    const transport = getTransport()
    if (transport.state === 'paused' && Math.abs(fromTime - this.scheduledFromTime) < 0.05) {
      transport.start()
      return
    }

    this.clearScheduled()
    transport.stop()
    transport.position = 0
    this.scheduledFromTime = fromTime

    // Tone converts seconds→ticks using the *current* bpm at schedule time.
    // We schedule at the nominal tempo so every event's tick position encodes
    // the note's original musical moment, then reapply the speed-scaled bpm
    // right before start(). The transport then ticks `speed ×` faster and
    // events fire at `t / speed` wall time — matching MasterClock.currentTime,
    // which advances at `speed × wall`. If we schedule while bpm is already
    // `midi.bpm × speed`, the two scalings cancel and audio plays at 1× while
    // the visual clock is at `speed ×` → desync on fresh play / seek.
    const nominalBpm = this.midi.bpm
    transport.bpm.value = nominalBpm

    // Build (or rebuild) a single Tone.Part containing every note from fromTime
    // onward. One transport entry instead of 2×N — on a 10k-note MIDI, seek
    // goes from "visible stall" to "imperceptible".
    //
    // Notes are time-sorted (parser invariant) so binary-search skips past
    // events before fromTime without scanning them.
    const partEvents: [number, NoteEvent][] = []
    for (const track of this.midi.tracks) {
      const notes = track.notes
      let lo = 0
      let hi = notes.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (notes[mid]!.time < fromTime) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < notes.length; i++) {
        const note = notes[i]!
        partEvents.push([
          note.time - fromTime,
          {
            note: midiToNoteName(note.pitch),
            duration: note.duration,
            velocity: note.velocity,
            trackId: track.id,
          },
        ])
      }
    }

    // Tone's Part type wants events with a `time` field, but the runtime also
    // accepts `[time, payload]` tuples — cheaper for our 2-key payload. Cast
    // at the boundary; the named import still tree-shakes unused synths.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const part = new (Part as any)((time: number, ev: NoteEvent) => {
      // Re-resolve the instrument each tick so mid-playback switches take
      // effect without rebuilding the Part. setInstrument() releases the old
      // voice so overlapping notes from the previous instrument don't linger.
      // Each track now has its own assigned voice (set via the Tracks panel /
      // global instrument menu); the global currentId only backs live input
      // and unassigned tracks.
      if (this.disabledTrackIds.has(ev.trackId)) return
      const id = this.trackInstruments.get(ev.trackId) ?? this.currentId
      const inst = this.instruments.get(id)
      inst?.triggerAttackRelease(ev.note, ev.duration, time, ev.velocity)
    }, partEvents)
    part.start(0)
    this.scheduledPart = part

    transport.bpm.value = nominalBpm * this._speed
    transport.start()
  }

  pause(): void {
    // Bump the generation so any in-flight `play()` aborts before it can
    // reach `transport.start()` and resurrect audio after the pause.
    this.playGeneration++
    getTransport().pause()
    this.releaseAllInstruments()
  }

  seek(time: number): void {
    const wasPlaying = getTransport().state === 'started'
    // Same latest-wins guard — a concurrent play() racing with a seek would
    // otherwise restart transport at a stale fromTime.
    this.playGeneration++
    getTransport().stop()
    this.clearScheduled()
    this.releaseAllInstruments()
    if (wasPlaying) void this.play(time)
  }

  setVolume(v: number): void {
    getDestination().volume.value = gainToDb(v)
  }

  setSpeed(s: number): void {
    this._speed = s
    getTransport().bpm.value = (this.midi?.bpm ?? 120) * s
  }

  // ── Live MIDI keyboard input ───────────────────────────────────────────

  primeLiveInput(): void {
    if (this.liveWarmupStarted) return
    this.liveWarmupStarted = true
    void toneStart().catch(() => undefined)
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  liveNoteOn(pitch: number, velocity: number): void {
    this.primeLiveInput()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return // still loading — first notes may drop, acceptable tradeoff
    inst.triggerAttack(midiToNoteName(pitch), immediate(), velocity)
  }

  liveNoteOff(pitch: number): void {
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), immediate())
  }

  liveReleaseAll(): void {
    this.releaseAllInstruments()
  }

  // Scheduled variants for loop playback. Caller supplies an AudioContext time
  // so notes land sample-accurately even if the UI thread stalls.
  scheduleNoteOn(pitch: number, velocity: number, ctxTime: number): void {
    this.primeLiveInput()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerAttack(midiToNoteName(pitch), ctxTime, velocity)
  }

  scheduleNoteOff(pitch: number, ctxTime: number): void {
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), ctxTime)
  }

  // Exposed so non-audio modules (UI, visuals) can convert AudioContext time
  // into a setTimeout delay without pulling Tone into their imports.
  get audioContextTime(): number {
    return getContext().currentTime
  }

  // ── Scheduled playback (internal) ──────────────────────────────────────

  private clearScheduled(): void {
    if (this.scheduledPart) {
      this.scheduledPart.stop(0)
      this.scheduledPart.clear()
      this.scheduledPart.dispose()
      this.scheduledPart = null
    }
  }

  private releaseAllInstruments(): void {
    for (const inst of this.instruments.values()) inst.releaseAll()
  }

  dispose(): void {
    this.clearScheduled()
    getTransport().stop()
    for (const inst of this.instruments.values()) inst.dispose()
    this.instruments.clear()
  }
}
