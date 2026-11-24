import { Application, Container, Graphics, Sprite, Text, Texture, type Ticker } from 'pixi.js'
import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiFile, MidiTrack } from '../core/midi/types'
import type { LiveNoteStore } from '../midi/LiveNoteStore'
import type { SubtitleCue } from '../services/LyricsParser'
import { BeatGrid } from './BeatGrid'
import { type EmitCadence, scheduleEmissions } from './emitSchedule'
import { KeyboardRenderer } from './KeyboardRenderer'
import { LiveNoteRenderer } from './LiveNoteRenderer'
import { GlowFilter } from 'pixi-filters'
import { NoteRenderer } from './NoteRenderer'
import { ParticleSystem } from './ParticleSystem'
import type { RenderContext, RenderLayer } from './RenderLayer'
import { applyVelocityShade, brightenForKeyboard, darkTheme, getTrackColor, type BorderStyle, type Theme } from './theme'
import { Viewport, visibleNoteRange } from './viewport'

// Must match the `--keyboard-h` value in main.css :root and the reset value
// in KeyboardResizer.onDoubleClick 隆陋 all three describe the same default,
// and drift between them shows up as a gap under the resize handle on first
// load (before any saved preference or user drag has synced the CSS var).
const DEFAULT_KEYBOARD_HEIGHT = 120
export const KEYBOARD_HEIGHT_MIN = 80
// Raised from 220 so portrait phones can host a substantial keyboard 隆陋
// a 220px cap on an 844px-tall iPhone only gives 26% of the screen to the
// keys. Desktop users rarely drag above ~200px, so this is purely headroom.
export const KEYBOARD_HEIGHT_MAX = 360

// Floor for the *auto* (width-proportional) height only. KEYBOARD_HEIGHT_MIN
// stays the floor for user-dragged heights, but the proportional formula must
// be allowed to keep falling on very narrow screens — otherwise a portrait
// phone bottoms out at 80px no matter how small its width gets. 40px keeps the
// keys visible/playable while still tracking the aspect ratio down.
export const KEYBOARD_HEIGHT_AUTO_MIN = 40

// Keyboard height derives from key WIDTH (a piano-like aspect ratio) instead
// of a fixed pixel height: narrow screens get proportionally shorter keys and
// wide screens taller ones. 5× the white-key width keeps the old 120px default
// on a ~1280px desktop canvas showing the full 88-key range, and on a portrait
// phone the formula falls toward KEYBOARD_HEIGHT_AUTO_MIN — the intended
// behaviour (compact keys so the falling-notes area keeps room).
export const KEYBOARD_ASPECT_RATIO = 5

const WHITE_KEY_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11])

/**
 * Background painting modes for the waterfall area.
 * - `theme`    : plain fill of the current theme's background (default)
 * - `solid`    : plain fill of a user-picked solid colour
 * - `grid`     : theme fill + pitch/bar grid texture
 * - `dots`     : theme fill + soft dot matrix texture
 * - `gradient` : theme fill + radial brightness falloff (centered haze)
 * - `glow`     : theme fill + coloured radial glow (user colour + intensity)
 * - `themeGlow`: theme fill + radial glow that follows the theme accent
 */
export type BackgroundMode =
  | 'theme'
  | 'solid'
  | 'grid'
  | 'dots'
  | 'gradient'
  | 'glow'
  | 'themeGlow'

export const BACKGROUND_MODES: ReadonlyArray<{ id: BackgroundMode; key: string }> = [
  { id: 'theme', key: 'background.mode.theme' },
  { id: 'solid', key: 'background.mode.solid' },
  { id: 'grid', key: 'background.mode.grid' },
  { id: 'dots', key: 'background.mode.dots' },
  { id: 'gradient', key: 'background.mode.gradient' },
  { id: 'glow', key: 'background.mode.glow' },
  { id: 'themeGlow', key: 'background.mode.themeGlow' },
]

// A soft '#rrggbb' / '#rgb' CSS colour → PIXI number. Falls back to a neutral
// blue so a malformed theme value never crashes the painter.
function cssHexToNumber(css: string, fallback = 0x3b82f6): number {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(css.trim())
  if (!m) return fallback
  const hex = m[1]!
  if (hex.length === 3) {
    return parseInt(hex[0]! + hex[0] + hex[1]! + hex[1] + hex[2]! + hex[2], 16)
  }
  return parseInt(hex, 16)
}

function isWhiteKey(pitch: number): boolean {
  return WHITE_KEY_CLASSES.has(((pitch % 12) + 12) % 12)
}

function countWhiteKeys(min: number, max: number): number {
  let n = 0
  for (let p = Math.floor(min); p <= Math.ceil(max); p++) if (isWhiteKey(p)) n++
  return Math.max(1, n)
}

// Auto keyboard height from the current canvas width + pitch range, clamped to
// [KEYBOARD_HEIGHT_AUTO_MIN, KEYBOARD_HEIGHT_MAX] 隆陋 the auto floor is lower
// than the user-drag floor so narrow screens keep shrinking proportionally.
function computeAutoKeyboardHeight(
  canvasWidth: number,
  pitchMin: number,
  pitchMax: number,
): number {
  const whiteKeyWidth = canvasWidth / countWhiteKeys(pitchMin, pitchMax)
  const raw = whiteKeyWidth * KEYBOARD_ASPECT_RATIO
  return Math.max(
    KEYBOARD_HEIGHT_AUTO_MIN,
    Math.min(KEYBOARD_HEIGHT_MAX, Math.round(raw)),
  )
}
const DEFAULT_PIXELS_PER_SECOND = 200

// Sustained emission cadence for held notes. Initial burst fires on note-on
// (full preset count); subsequent tiny puffs emit every `SUSTAIN_INTERVAL_SEC`
// while the key stays held. Puff density is per-style (see ParticleSystem).
const SUSTAIN_INITIAL_DELAY_SEC = 0.18
const SUSTAIN_INTERVAL_SEC = 0.14
const SUSTAIN_CADENCE: EmitCadence = {
  initialDelaySec: SUSTAIN_INITIAL_DELAY_SEC,
  intervalSec: SUSTAIN_INTERVAL_SEC,
}

// Consecutive non-animating ticks rendered before the ticker stops itself.
// The grace window absorbs bursts (scrub gestures, rapid note on/off) so we
// don't thrash stop/start, and guarantees the final state is presented before
// the loop goes quiet. ~0.25 s at 120 Hz, ~0.5 s at 60 Hz 隆陋 the render work in
// that window is negligible next to an always-on loop.
const IDLE_GRACE_FRAMES = 30

export class PianoRollRenderer {
  private app!: Application
  private viewport!: Viewport
  private noteRenderer!: NoteRenderer
  private velocityThreshold = 0
  private keyboardRenderer!: KeyboardRenderer
  private liveNoteRenderer!: LiveNoteRenderer
  private particles!: ParticleSystem
  private beatGrid!: BeatGrid
  private nowLineGraphics!: Graphics
  private backgroundGraphics!: Graphics
  private videoSprite: Sprite | null = null
  private videoElement: HTMLVideoElement | null = null
  private videoTexture: Texture | null = null
  private videoOpacity = 1
  private overlayOpacity = 1
  private hasVideoBackground = false
  /** Whether a video background is currently loaded. */
  get isVideoLoaded(): boolean { return this.hasVideoBackground }
  private videoSyncEnabled = false  // false until user explicitly plays
  // Video trim range (seconds in the ORIGINAL file). (0, 0) means untrimmed.
  // The clock/export timeline maps onto the video as [trimStart, trimEnd], so
  // playback and export both honor the front/back trim applied in the
  // customize menu.
  private videoTrimStart = 0
  private videoTrimEnd = 0

  // Image background (static image / SVG / animated GIF). Mutually exclusive
  // with the video visual layer, but an audio-only import (hidden video
  // element) can coexist with an image.
  private imageSprite: Sprite | null = null
  private imageTexture: Texture | null = null
  private imageScale = 1
  private imageOffsetX = 0
  private hasImageBackground = false
  /** Animated (GIF) background — texture re-uploaded every frame. */
  private isGifImage = false
  /** Whether an image background is currently loaded. */
  get isImageLoaded(): boolean { return this.hasImageBackground }

  // Subtitle overlay (LRC/SRT). Rendered as a top-layer Text sprite that is
  // centered by default, can be double-clicked to zoom and dragged to move.
  private subtitleText: Text | null = null
  private subtitleCues: SubtitleCue[] = []
  private subtitleScale = 1
  // Position as fractions of the canvas (0.5 = center) so resize keeps it put.
  private subtitleX = 0.5
  private subtitleY = 0.5
  private subtitleDrag: { startGlobalX: number; startGlobalY: number; startX: number; startY: number } | null = null
  private lastSubtitlePointerDown = 0
  /** Whether subtitles are currently imported. */
  get hasSubtitle(): boolean { return this.subtitleCues.length > 0 }

  private midi: MidiFile | null = null
  private liveNoteStore: LiveNoteStore | null = null
  private loopNoteStore: LiveNoteStore | null = null
  visibleTrackIds = new Set<string>()
  // Called after loadMidi rebuilds per-track state so callers (app.ts) can
  // inject saved per-track particle/border settings. Optional to keep the
  // renderer usable standalone (e.g. in tests).
  onLoadMidi?: (tracks: MidiTrack[]) => void
  private practiceFocusTrackIds: Set<string> | null = null
  private trackColorOverrides = new Map<string, number>()
  private keyboardColorMode: 'note' | 'border' = 'note'
  // Bar-line drag state. When non-null, the user is actively dragging a bar line.
  private barLineDrag: {
    barIndex: number       // which bar line is being dragged (1-based: between bar N-1 and bar N)
    originalTime: number   // original time position of this bar line
    startY: number         // pixel Y where the drag started
    shiftKey: boolean      // whether shift was held at drag start
    ctrlKey: boolean       // whether ctrl was held at drag start
  } | null = null
  // Per-bar-line time overrides. Key = bar index (0=first bar line, 1=second, ...).
  // Value = time in seconds. When a bar line is dragged, its time is stored here
  // and used instead of the computed `barIndex * barDuration`.
  private barLineOverrides = new Map<number, number>()
  private theme: Theme = darkTheme
  // ── Waterfall background painting state ───────────────────────────────
  private backgroundMode: BackgroundMode = 'theme'
  private backgroundSolidColor = 0x0b0e14
  private backgroundGlowColor = 0x3b82f6
  private backgroundGlowIntensity = 0.5   // 0-1
  private backgroundOpacity = 1           // 0-1 opacity of the painted layer
  private backgroundDrift = 0             // 0-1 horizontal drift speed (0 = static)
  private backgroundDriftOffset = 0       // accumulated px offset applied while painting
  // The bitmap/video layer (image/video background) sits ABOVE the painted
  // layer and is unaffected by backgroundOpacity — its own controls exist.
  /** Whether the painted background layer has a pattern (needs per-frame repaint on drift). */
  private backgroundIsAnimated = false
  private pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND
  private keyboardHeight = DEFAULT_KEYBOARD_HEIGHT
  // True once the user drags the resize handle or restoreSaved applies a saved
  // height 隆陋 from then on, window/resize re-derivation (applyAutoKeyboardHeight)
  // is skipped so their choice sticks.
  private keyboardUserOverride = false
  private lastRenderTime = 0

  // Two pooled Sets swapped each frame. Keys are packed `trackIndex * 128 + pitch`
  // so comparisons never allocate strings in the hot path.
  private prevActive = new Set<number>()
  private currActive = new Set<number>()
  // Map pitch 隆煤 color so the keyboard overlay picks up each track's own hue
  // rather than a single accent. Last-write-wins when multiple tracks sound
  // the same pitch 隆陋 acceptable; the rest of the visualization already does
  // the same.
  private activeKeyColors = new Map<number, number>()
  private exportMode = false

  // Next time (in seconds of clock-time) to emit a sustained trail-burst for
  // each active note. Held keys keep breathing out particles at this cadence;
  // entries get reaped when the note ends.
  private scheduledEmitNext = new Map<number, number>()
  private liveEmitNext = new Map<number, number>()
  // Per-frame scratch reused by the scheduled-MIDI emit pass: the keys eligible
  // to emit particles this frame and their burst geometry/color. Pooled to keep
  // the hot path allocation-free; cleared at the top of each frame.
  private emitEligible = new Set<number>()
  private emitGeom = new Map<number, { cx: number; w: number; color: number; trackId: string }>()

  // Practice-mode hints (pitches that should glow on the keyboard as "play
  // these to advance"). `pending` is what's still required, `accepted` is what
  // the user has already pressed for the current step.
  private practiceHintPending: ReadonlySet<number> | null = null
  private practiceHintAccepted: ReadonlySet<number> | null = null

  // External RenderLayers (Learn-mode overlays, future sheet-music cursor,
  // etc.) kept sorted by `zIndex` ascending so a single forward iteration
  // draws them in the right order.
  private externalLayers: RenderLayer[] = []
  // Whether to draw the upward-floating live-note sprites. True in Play/Live
  // where the user expects their keypresses to animate up the roll; false
  // in Learn where the scheduled MIDI is what matters and user presses
  // should only manifest as a keyboard-key highlight.
  private liveNotesVisible = true

  // Idle-stop bookkeeping (see onTick). Unsub closures for the wake
  // subscriptions on the clock and the live/loop note stores.
  private idleFrames = 0
  private clockUnsub: (() => void) | null = null
  private liveStoreUnsub: (() => void) | null = null
  private loopStoreUnsub: (() => void) | null = null

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.app = new Application()

    await this.app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: darkTheme.background,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    // Pick a width-proportional keyboard height before building the scene 隆陋
    // the full 88-key range at this canvas width gives the right piano-like
    // aspect from the very first paint (a later resize would cause a flash).
    // The pitch range defaults to 21-108 here because the Viewport below is
    // not constructed yet; setPitchRange re-derives the height on change.
    this.keyboardHeight = computeAutoKeyboardHeight(this.app.screen.width, 21, 108)

    this.viewport = new Viewport({
      canvasWidth: this.app.screen.width,
      canvasHeight: this.app.screen.height,
      keyboardHeight: this.keyboardHeight,
      pixelsPerSecond: this.pixelsPerSecond,
    })

    // Keep the CSS --keyboard-h in lockstep with the JS-side height from the
    // very first paint 隆陋 the resize handle + HUD positioning reads this var
    // and would otherwise drift until the first setKeyboardHeight() call.
    document.documentElement.style.setProperty('--keyboard-h', `${this.keyboardHeight}px`)

    this.buildScene()
    // handleResize calls resize() 隆煤 rebuildStaticLayers() + renderStaticFrame(0),
    // so buildScene must not call rebuildStaticLayers itself.
    this.handleResize()

    window.addEventListener('resize', this.handleResize)
  }

  private buildScene(): void {
    const stage = this.app.stage

    // Layer order (bottom 隆煤 top):
    // 1. background  2. beat-grid  3. notes  4. live-notes  5. now-line  6. keyboard  7. particles

    this.backgroundGraphics = new Graphics()
    this.backgroundGraphics.label = 'background'
    stage.addChild(this.backgroundGraphics)

    this.beatGrid = new BeatGrid()
    stage.addChild(this.beatGrid.graphics)

    this.noteRenderer = new NoteRenderer(this.theme)
    stage.addChild(this.noteRenderer.container)

    this.liveNoteRenderer = new LiveNoteRenderer(this.theme)
    stage.addChild(this.liveNoteRenderer.container)

    this.nowLineGraphics = new Graphics()
    this.nowLineGraphics.label = 'now-line'
    stage.addChild(this.nowLineGraphics)

    this.keyboardRenderer = new KeyboardRenderer(this.app, this.theme)
    stage.addChild(this.keyboardRenderer.container)

    this.particles = new ParticleSystem()
    stage.addChild(this.particles.container)
  }

  // Redraw every layer whose contents don't change per frame: background, now-line,
  // keyboard texture. Follow with `renderStaticFrame()` if the current frame also
  // needs to be re-presented. External layers get rebuilt too so overlays that
  // cache viewport-derived geometry stay in sync.
  private rebuildStaticLayers(): void {
    this.drawBackground()
    this.drawNowLine()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
    this.rebuildExternalLayers()
  }

  private drawBackground(): void {
    const { canvasWidth, canvasHeight } = this.viewport.config
    const rollHeight = this.viewport.rollHeight
    const g = this.backgroundGraphics
    g.clear()

    const mode = this.backgroundMode
    const base =
      mode === 'solid'
        ? this.backgroundSolidColor
        : this.theme.background
    const alpha = this.backgroundOpacity

    // Plain fill always paints (with the opacity multiplier); pattern modes
    // layer their texture on top.
    g.rect(0, 0, canvasWidth, canvasHeight)
    g.fill({ color: base, alpha })

    // Patterns are translated by the accumulated drift (wrapped) so a slow
    // horizontal crawl can animate behind the falling notes.
    const hasPattern = mode !== 'theme' && mode !== 'solid'
    const dx = hasPattern && this.backgroundDrift > 0 ? this.backgroundDriftOffset : 0

    // Subtle vertical lines at C notes (theme + solid keep the classic look)
    for (let pitch = 24; pitch <= 108; pitch += 12) {
      const x = this.viewport.pitchToX(pitch) + dx
      g.rect(x, 0, 1, rollHeight)
      g.fill({ color: 0xffffff, alpha: 0.025 * alpha })
    }

    if (mode === 'grid') {
      // Denser pitch lines + bar lines read as sheet-music paper.
      for (let pitch = 24; pitch <= 108; pitch++) {
        const isC = pitch % 12 === 0
        if (isC) continue
        const x = this.viewport.pitchToX(pitch) + dx
        g.rect(x, 0, 1, rollHeight)
        g.fill({ color: 0xffffff, alpha: 0.012 * alpha })
      }
      const barS = this.barDurationSec
      if (barS > 0) {
        const yStep = barS * this.pixelsPerSecond
        if (yStep >= 6) {
          for (let y = yStep; y < rollHeight; y += yStep) {
            g.rect(0, y, canvasWidth, 1)
            g.fill({ color: 0xffffff, alpha: 0.05 * alpha })
          }
        }
      }
    } else if (mode === 'dots') {
      // Even dot matrix, both axes, large pitch so it stays subtle.
      const spacing = 42
      for (let y = spacing / 2; y < rollHeight; y += spacing) {
        for (let x = spacing / 2; x < canvasWidth; x += spacing) {
          g.circle(x + dx, y, 1.1)
          g.fill({ color: 0xffffff, alpha: 0.055 * alpha })
        }
      }
    } else if (mode === 'gradient' || mode === 'glow' || mode === 'themeGlow') {
      // Radial haze: concentric circles centred slightly above the middle of
      // the roll area, alpha falling off outward. The colour comes from the
      // theme accent (themeGlow), the user pick (glow), or a cool white-blue
      // (gradient) — intensity scales the peak alpha.
      let glowColor = 0xbfd9ff
      if (mode === 'glow') glowColor = this.backgroundGlowColor
      else if (mode === 'themeGlow') {
        glowColor = cssHexToNumber(this.theme.uiAccentCSS)
      }
      const intensity = this.backgroundGlowIntensity
      const cx = canvasWidth / 2 + dx
      const cy = rollHeight * 0.35
      const maxR = Math.max(canvasWidth, rollHeight) * 0.75
      const rings = 10
      for (let i = 0; i < rings; i++) {
        const t = i / (rings - 1) // 0 near centre → 1 at edge
        const r = maxR * (0.08 + 0.92 * t)
        const a = (1 - t) * 0.16 * intensity * alpha
        if (a <= 0.002) continue
        g.circle(cx, cy, r)
        g.fill({ color: glowColor, alpha: a })
      }
    }

    // Separator line between roll and keyboard
    g.rect(0, rollHeight, canvasWidth, 1)
    g.fill({ color: 0x000000, alpha })
  }

  // Public background controls (waterfall background dropdown).
  setBackgroundMode(mode: BackgroundMode): void {
    if (mode === this.backgroundMode) return
    this.backgroundMode = mode
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  getBackgroundMode(): BackgroundMode {
    return this.backgroundMode
  }

  setBackgroundSolidColor(color: number): void {
    this.backgroundSolidColor = color
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  setBackgroundGlowColor(color: number): void {
    this.backgroundGlowColor = color
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  setBackgroundGlowIntensity(v: number): void {
    this.backgroundGlowIntensity = Math.max(0, Math.min(1, v))
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  setBackgroundOpacity(v: number): void {
    this.backgroundOpacity = Math.max(0.05, Math.min(1, v))
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  getBackgroundOpacity(): number {
    return this.backgroundOpacity
  }

  // 0 = static; >0 = slow horizontal crawl (speed in 0-1 units, ~ 0-60 px/s).
  setBackgroundDrift(v: number): void {
    this.backgroundDrift = Math.max(0, Math.min(1, v))
    const patternAnimated = this.backgroundDrift > 0
    if (patternAnimated !== this.backgroundIsAnimated) {
      this.backgroundIsAnimated = patternAnimated
      // Kick the loop when the crawl turns on. Turning it off leaves the
      // ticker to idle-stop naturally on the next non-animating frame.
      if (patternAnimated && !this.app.ticker.started) this.app.ticker.start()
    }
    this.presentFrame()
  }

  getBackgroundDrift(): number {
    return this.backgroundDrift
  }

  // Bar duration in seconds — the vertical spacing for the grid texture.
  private get barDurationSec(): number {
    if (!this.midi) return 0
    const beat = 60 / this.midi.bpm
    return beat * (this.midi.timeSignature[0] ?? 4)
  }

  private drawNowLine(): void {
    const g = this.nowLineGraphics
    g.clear()
    const y = this.viewport.nowLineY
    const w = this.viewport.config.canvasWidth
    const glow = this.theme.nowLineGlow

    // Layered soft glow above the now-line
    g.rect(0, y - 14, w, 14)
    g.fill({ color: glow, alpha: 0.01 })
    g.rect(0, y - 8, w, 8)
    g.fill({ color: glow, alpha: 0.022 })
    g.rect(0, y - 4, w, 4)
    g.fill({ color: glow, alpha: 0.04 })
    g.rect(0, y - 2, w, 2)
    g.fill({ color: glow, alpha: 0.065 })

    g.rect(0, y, w, 1.5)
    g.fill({ color: this.theme.nowLine, alpha: this.theme.nowLineAlpha })
  }


  // Per-track border decoration. NoteRenderer owns the per-track Maps;
  // PianoRollRenderer forwards and presents the frame.
  setBorderStyleForTrack(trackId: string, style: BorderStyle): void {    this.noteRenderer.setBorderStyleForTrack(trackId, style)
    this.presentFrame()
  }

  getBorderStyleForTrack(trackId: string): BorderStyle {
    return this.noteRenderer.getBorderStyleForTrack(trackId)
  }

  // Note-block corner radius as a fraction (0-0.5) of the shortest side.
  setNoteCornerRatio(ratio: number): void {
    this.noteRenderer.setCornerRatio(ratio)
    this.presentFrame()
  }

  getNoteCornerRatio(): number {
    return this.noteRenderer.getCornerRatio()
  }

  // Note colour mode: 'track' (per-track hue) or 'custom' (one flat colour).
  setNoteColorMode(mode: 'track' | 'custom', customColor?: number): void {
    this.noteRenderer.setColorMode(mode, customColor)
    this.presentFrame()
  }

  getNoteColorMode(): 'track' | 'custom' {
    return this.noteRenderer.getColorMode()
  }

  getCustomNoteColor(): number {
    return this.noteRenderer.getCustomNoteColor()
  }

  setBorderColorForTrack(trackId: string, color: number | null): void {
    this.noteRenderer.setBorderColorForTrack(trackId, color)
    this.presentFrame()
  }

  getBorderColorForTrack(trackId: string): number | null {
    return this.noteRenderer.getBorderColorForTrack(trackId)
  }

  // Apply border style/colour to all currently visible MIDI tracks.
  // Called by app.ts when CustomizeMenu changes; hidden tracks keep their
  // preserved state in NoteRenderer's per-track Maps.
  applyBorderStyleToVisibleTracks(style: BorderStyle): void {
    for (const trackId of this.visibleTrackIds) {
      this.noteRenderer.setBorderStyleForTrack(trackId, style)
    }
    this.presentFrame()
  }

  applyBorderColorToVisibleTracks(color: number | null): void {
    for (const trackId of this.visibleTrackIds) {
      this.noteRenderer.setBorderColorForTrack(trackId, color)
    }
    this.presentFrame()
  }

  // Per-track particle systems. Each MIDI track gets its own ParticleSystem
  // so style/colour can diverge per track. Toggling a track off preserves
  // its system (and its preserved style/colour); the system just stops
  // receiving bursts. this.particles is the fallback for live input.
  private particleSystems = new Map<string, ParticleSystem>()

  particleSystemForTrack(trackId: string): ParticleSystem {
    let ps = this.particleSystems.get(trackId)
    if (!ps) {
      ps = new ParticleSystem()
      this.app.stage.addChild(ps.container)
      this.particleSystems.set(trackId, ps)
    }
    return ps
  }

  rebuildParticleSystems(tracks: MidiTrack[]): void {
    const incoming = new Set(tracks.map((t) => t.id))
    for (const [id, ps] of this.particleSystems) {
      if (!incoming.has(id)) {
        ps.clear()
        ps.container.destroy({ children: true })
        this.particleSystems.delete(id)
      }
    }
    for (const track of tracks) this.particleSystemForTrack(track.id)
  }

  destroyAllParticleSystems(): void {
    for (const ps of this.particleSystems.values()) {
      ps.clear()
      ps.container.destroy({ children: true })
    }
    this.particleSystems.clear()
  }

  private clearAllParticles(): void {
    this.particles.clear()
    for (const ps of this.particleSystems.values()) ps.clear()
  }

  private updateAllParticles(dt: number): void {
    this.particles.update(dt)
    for (const ps of this.particleSystems.values()) ps.update(dt)
  }

  private anyParticlesActive(): boolean {
    if (this.particles.hasActive) return true
    for (const ps of this.particleSystems.values()) if (ps.hasActive) return true
    return false
  }

  setParticleStyleForTrack(trackId: string, style: import('./ParticleSystem').ParticleStyle): void {
    this.particleSystemForTrack(trackId).setStyle(style)
  }

  setParticleColorForTrack(trackId: string, color: number | null): void {
    this.particleSystemForTrack(trackId).setColorOverride(color)
  }

  // Fallback setters (live input / no track context). Follows the latest
  // CustomizeMenu choice so live bursts always use the current global style.
  setFallbackParticleStyle(style: import('./ParticleSystem').ParticleStyle): void {
    this.particles.setStyle(style)
  }

  setFallbackParticleColor(color: number | null): void {
    this.particles.setColorOverride(color)
  }

  // Apply style/colour to fallback + all visible MIDI tracks (CustomizeMenu
  // change path). Hidden tracks keep their preserved state.
  applyParticleStyleToVisibleTracks(style: import('./ParticleSystem').ParticleStyle): void {
    this.particles.setStyle(style)
    for (const trackId of this.visibleTrackIds) {
      this.particleSystemForTrack(trackId).setStyle(style)
    }
  }

  applyParticleColorToVisibleTracks(color: number | null): void {
    this.particles.setColorOverride(color)
    for (const trackId of this.visibleTrackIds) {
      this.particleSystemForTrack(trackId).setColorOverride(color)
    }
  }

  loadMidi(midi: MidiFile): void {
    this.midi = midi
    this.visibleTrackIds = new Set(midi.tracks.map((t) => t.id))
    this.practiceFocusTrackIds = null
    this.noteRenderer.setTracks(midi.tracks)
    this.rebuildParticleSystems(midi.tracks)
    this.clearAllParticles()
    this.prevActive.clear()
    this.currActive.clear()
    this.renderStaticFrame(0)
    this.onLoadMidi?.(midi.tracks)
  }

  clearMidi(): void {
    this.midi = null
    this.visibleTrackIds.clear()
    this.practiceFocusTrackIds = null
    this.noteRenderer.setTracks([])
    this.noteRenderer.clear()
    this.liveNoteRenderer.clear()
    this.destroyAllParticleSystems()
    this.prevActive.clear()
    this.currActive.clear()
    this.scheduledEmitNext.clear()
    this.liveEmitNext.clear()
    this.beatGrid.clear()
    this.renderStaticFrame(0)
  }

  setKeyboardColorMode(mode: 'note' | 'border'): void {
    this.keyboardColorMode = mode
    this.presentFrame()
  }

  getKeyboardColorMode(): 'note' | 'border' {
    return this.keyboardColorMode
  }

  setTrackVisible(trackId: string, visible: boolean): void {
    if (visible) this.visibleTrackIds.add(trackId)
    else this.visibleTrackIds.delete(trackId)
    // Repaint immediately 隆陋 with the idle-stopped ticker there is no "next
    // frame" to pick the change up while paused.
    this.presentFrame()
  }

  /** Set or clear a per-track color override. Pass null to reset to theme color. */
  setTrackColorOverride(trackId: string, color: number | null): void {
    if (color === null) this.trackColorOverrides.delete(trackId)
    else this.trackColorOverrides.set(trackId, color)
    this.noteRenderer.setTrackColorOverrides(this.trackColorOverrides)
    this.presentFrame()
  }

  /** Bulk-set all overrides at once (used when restoring from persistence). */
  setTrackColorOverrides(overrides: Map<string, number>): void {
    this.trackColorOverrides = new Map(overrides)
    this.noteRenderer.setTrackColorOverrides(this.trackColorOverrides)
    this.presentFrame()
  }

  /** Get the current color override for a track, or null if none. */
  getTrackColorOverride(trackId: string): number | null {
    return this.trackColorOverrides.get(trackId) ?? null
  }

  setPracticeTrackFocus(trackIds: Iterable<string> | null): void {
    this.practiceFocusTrackIds = trackIds ? new Set(trackIds) : null
    if (this.midi) this.presentFrame()
  }

  setZoom(pixelsPerSecond: number): void {
    this.pixelsPerSecond = pixelsPerSecond
    // Key layout and keyboard texture are width-dependent, not zoom-dependent 隆陋
    // no need to rebuild them when only pixelsPerSecond changes. External layers
    // may cache timeOffsetToY-derived positions though, so notify them.
    this.viewport.update({ pixelsPerSecond })
    this.rebuildExternalLayers()
    this.presentFrame()
  }

  // Narrows or widens the visible pitch range. Used during vertical/square
  // export so the keyboard zooms onto the piece's actual range instead of
  // squeezing all 88 keys into a 1080px-wide canvas.
  setPitchRange(min: number, max: number): void {
    this.viewport.update({ pitchMin: min, pitchMax: max })
    // A narrower range means wider keys 隆陋 re-derive the height to keep the
    // piano-like aspect, unless the user has pinned their own height via the
    // drag handle or a saved preference (setKeyboardHeightUser).
    if (!this.keyboardUserOverride) this.applyAutoKeyboardHeight()
    this.rebuildStaticLayers()
  }

  get pitchRange(): { min: number; max: number } {
    return {
      min: this.viewport.config.pitchMin ?? 21,
      max: this.viewport.config.pitchMax ?? 108,
    }
  }

  get currentPixelsPerSecond(): number {
    return this.pixelsPerSecond
  }

  setKeyboardHeight(px: number, min = KEYBOARD_HEIGHT_MIN): void {
    const clamped = Math.max(min, Math.min(KEYBOARD_HEIGHT_MAX, Math.round(px)))
    if (clamped === this.keyboardHeight) return
    this.keyboardHeight = clamped
    this.viewport.update({ keyboardHeight: clamped })
    document.documentElement.style.setProperty('--keyboard-h', `${clamped}px`)
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  // User drag / saved preference 隆陋 pins the height so width changes don't
  // re-derive it. Only the resize handle and restoreSaved call this (they keep
  // the KEYBOARD_HEIGHT_MIN floor, unlike the auto path below).
  setKeyboardHeightUser(px: number): void {
    this.keyboardUserOverride = true
    this.setKeyboardHeight(px)
  }

  // Double-click on the resizer resets to the width-proportional auto height.
  clearKeyboardHeightOverride(): void {
    this.keyboardUserOverride = false
    this.applyAutoKeyboardHeight()
  }

  private applyAutoKeyboardHeight(): void {
    const { min, max } = this.pitchRange
    this.setKeyboardHeight(
      computeAutoKeyboardHeight(this.app.screen.width, min, max),
      KEYBOARD_HEIGHT_AUTO_MIN,
    )
  }

  get currentKeyboardHeight(): number {
    return this.keyboardHeight
  }

  setVelocityThreshold(v: number): void {
    this.velocityThreshold = v
    this.noteRenderer.setVelocityThreshold(v)
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    this.app.renderer.background.color = theme.background
    this.noteRenderer.updateTheme(theme)
    this.noteRenderer.setTrackColorOverrides(this.trackColorOverrides)
    this.liveNoteRenderer.updateTheme(theme)
    this.keyboardRenderer.updateTheme(theme)
    // Particle motion is intentionally theme-independent 隆陋 only the color
    // changes (via the caller's trackColors[0]). Behaviour stays consistent.
    this.rebuildStaticLayers()
    this.presentFrame()
  }

  // Set video background. If isAudio is true, the video element is hidden but
  // still plays audio. The video sprite is added to the stage behind all other
  // elements.
  setVideoBackground(url: string, isAudio: boolean): void {
    // Clean up existing video
    this.clearVideoBackground()

    // Video visual and image background are mutually exclusive; an audio-only
    // import keeps the image visible underneath.
    if (!isAudio) this.clearImageBackground()

    // Create video element
    const video = document.createElement('video')
    video.src = url
    video.loop = false
    video.autoplay = false  // 虏禄脳脭露炉虏楼路脜拢卢脫脡 MIDI 脢卤脰脫驴脴脰脝
    video.muted = false     // 卤拢脕么脪么脝碌拢卢脫脡虏楼路脜驴脴脰脝戮枚露篓
    video.playsInline = true
    // 虏禄脡猫脰脙 crossOrigin - blob URL 虏禄脨猫脪陋拢卢脟脪驴脡脛脺碌录脰脗脦脢脤芒
    video.preload = 'auto'
    
    // 脤铆录脫麓铆脦贸麓娄脌铆
    video.addEventListener('error', (e) => {
      console.error('[PianoRollRenderer] Video load error:', video.error)
      console.error('[PianoRollRenderer] Video URL:', url)
    })
    
    video.addEventListener('loadeddata', () => {
      console.log('[PianoRollRenderer] Video loaded successfully:', video.videoWidth, 'x', video.videoHeight)
    })
    
    if (isAudio) {
      video.style.display = 'none'
    } else {
      video.style.position = 'absolute'
      video.style.top = '-9999px'
      video.style.left = '-9999px'
      video.style.width = '320px'
      video.style.height = '180px'
      video.style.opacity = '0'
      video.style.pointerEvents = 'none'
    }

    this.videoElement = video
    this.videoSyncEnabled = false  // reset on new import

    // Add video to DOM FIRST so it can start loading
    document.body.appendChild(video)

    if (isAudio) {
      // Audio: just play, no sprite needed
      // Audio: 虏禄脕垄录麓虏楼路脜拢卢脫脡 MIDI 脢卤脰脫驴脴脰脝
      this.wake()
      return
    }

    // Video: wait for data to load, then create texture/sprite
    const setupSprite = () => {
      // Create texture from video (now that data is loaded)
      const texture = Texture.from(video)
      // Use nearest-neighbor scaling for pixel-perfect stretching when video resolution < export resolution
      texture.source.scaleMode = 'nearest'
      this.videoTexture = texture

      const sprite = new Sprite(texture)
      // zIndex 脭脷 PixiJS v8 脰脨脨猫脪陋 sortChildren
      this.videoSprite = sprite
      this.app.stage.addChildAt(sprite, 0)
      this.updateVideoSize()

      // Hide the dark background so video shows through
      this.hasVideoBackground = true
      if (this.backgroundGraphics) this.backgroundGraphics.alpha = 0

      // 虏禄脕垄录麓虏楼路脜拢卢脫脡 MIDI 脢卤脰脫驴脴脰脝
      sprite.alpha = this.videoOpacity
      console.log('[PianoRollRenderer] Video sprite created, waiting for play signal')

      // Keep renderer running for video frames
      this.wake()
    }

    if (video.readyState >= 2) {
      // HAVE_CURRENT_DATA or better - ready to go
      setupSprite()
    } else {
      video.addEventListener('loadeddata', setupSprite, { once: true })
      // Fallback: if loadeddata doesn't fire within 5s, try anyway
      setTimeout(() => {
        if (!this.videoSprite && this.videoElement === video) {
          setupSprite()
        }
      }, 5000)
    }
  }

  /** Swap the video element's source for export (e.g., load original quality video). Returns a promise that resolves when the new source is loaded. */
  async swapVideoSrc(url: string): Promise<void> {
    if (!this.videoElement) return
    return new Promise<void>((resolve) => {
      const onLoaded = () => {
        this.videoElement?.removeEventListener('loadeddata', onLoaded)
        resolve()
      }
      this.videoElement?.addEventListener('loadeddata', onLoaded)
      this.videoElement!.src = url
      this.videoElement!.load()
      // Fallback timeout
      setTimeout(() => {
        this.videoElement?.removeEventListener('loadeddata', onLoaded)
        resolve()
      }, 5000)
    })
  }

  clearVideoBackground(): void {
    if (this.videoSprite) {
      this.videoSprite.destroy()
      this.videoSprite = null
    }
    if (this.videoTexture) {
      this.videoTexture.destroy()
      this.videoTexture = null
    }
    if (this.videoElement) {
      this.videoElement.pause()
      this.videoElement.src = ''
      // Remove from DOM
      if (this.videoElement.parentNode) {
        this.videoElement.parentNode.removeChild(this.videoElement)
      }
      this.videoElement = null
    }
    // A new import is untrimmed by default.
    this.videoTrimStart = 0
    this.videoTrimEnd = 0
    // Restore background opacity when video is removed
    if (this.hasVideoBackground) {
      this.hasVideoBackground = false
      if (this.backgroundGraphics) this.backgroundGraphics.alpha = this.overlayOpacity
    }
  }

  /**
   * Set an image background (static image / SVG / animated GIF). Clears the
   * video visual layer (they are mutually exclusive) but leaves an audio-only
   * import playing. Images are decoded through an HTMLImageElement so blob
   * URLs (no extension) work for every format; GIFs are re-uploaded per frame
   * to show the animation.
   */
  async setImageBackground(url: string, isAnimated = false): Promise<void> {
    // A video visual layer can't share the stage bottom slot with an image.
    // Audio-only imports (no sprite) are kept — image + audio is a valid combo.
    if (this.hasVideoBackground) this.clearVideoBackground()

    this.clearImageBackground()
    try {
      const img = new Image()
      img.src = url
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('image decode failed'))
      })
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        throw new Error('image has no size')
      }
      const texture = Texture.from(img)
      const sprite = new Sprite(texture)
      this.imageSprite = sprite
      this.imageTexture = texture
      this.isGifImage = isAnimated
      this.imageSprite.alpha = 1
      this.app.stage.addChildAt(sprite, 0)
      this.updateImageSize()
      this.hasImageBackground = true
      if (this.backgroundGraphics) this.backgroundGraphics.alpha = 0
      this.wake()
    } catch (err) {
      console.error('[PianoRollRenderer] Image background load failed:', err)
      this.clearImageBackground()
      throw err
    }
  }

  clearImageBackground(): void {
    if (this.imageSprite) {
      this.imageSprite.destroy()
      this.imageSprite = null
    }
    if (this.imageTexture) {
      this.imageTexture.destroy()
      this.imageTexture = null
    }
    this.isGifImage = false
    if (this.hasImageBackground) {
      this.hasImageBackground = false
      if (this.backgroundGraphics) this.backgroundGraphics.alpha = this.overlayOpacity
    }
  }

  // Scale (around the bottom-center, like the video layer) and horizontal
  // shift (in multiples of canvas width, e.g. 0.25 = a quarter screen right).
  setImageTransform(scale: number, offsetX: number): void {
    this.setImageScale(scale)
    this.setImageOffsetX(offsetX)
  }

  setImageScale(scale: number): void {
    this.imageScale = Math.max(0.1, Math.min(10, scale))
    this.updateImageSize()
    this.wake()
    this.presentFrame()
  }

  setImageOffsetX(offsetX: number): void {
    this.imageOffsetX = Math.max(-2, Math.min(2, offsetX))
    this.updateImageSize()
    this.wake()
    this.presentFrame()
  }

  private updateImageSize(): void {
    if (!this.imageSprite) return
    const canvasWidth = this.viewport.config.canvasWidth
    const canvasHeight = this.viewport.config.canvasHeight
    // Same 16:9 cover fit as the video layer, then scale around the
    // bottom-center and shift horizontally.
    const targetRatio = 16 / 9
    const canvasRatio = canvasWidth / canvasHeight
    let displayWidth: number
    let displayHeight: number
    if (canvasRatio > targetRatio) {
      displayWidth = canvasWidth
      displayHeight = canvasWidth / targetRatio
    } else {
      displayHeight = canvasHeight
      displayWidth = canvasHeight * targetRatio
    }
    const s = this.imageScale
    displayWidth *= s
    displayHeight *= s
    this.imageSprite.width = displayWidth
    this.imageSprite.height = displayHeight
    this.imageSprite.x = (canvasWidth - displayWidth) / 2 + this.imageOffsetX * canvasWidth
    this.imageSprite.y = canvasHeight - displayHeight
  }

  // ── Subtitles (LRC/SRT) ──────────────────────────────────────────────
  setSubtitle(cues: SubtitleCue[]): void {
    this.subtitleCues = cues
    if (cues.length > 0 && !this.subtitleText) {
      const text = new Text({
        text: '',
        style: {
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
          fontSize: 34,
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 6 },
          align: 'center',
          wordWrap: true,
          wordWrapWidth: 1400,
        },
      })
      text.anchor.set(0.5)
      text.eventMode = 'static'
      text.cursor = 'move'
      // Double-click zooms the subtitle; drag moves it (kept as canvas
      // fractions so resize doesn't lose the position).
      text.on('pointerdown', (e) => {
        const now = performance.now()
        if (this.subtitleDrag === null && now - this.lastSubtitlePointerDown < 350) {
          // double-click → zoom in
          this.lastSubtitlePointerDown = 0
          this.subtitleScale = Math.min(6, this.subtitleScale * 1.5)
          this.applySubtitleLayout()
          this.wake()
          this.presentFrame()
          return
        }
        this.lastSubtitlePointerDown = now
        this.subtitleDrag = {
          startGlobalX: e.global.x,
          startGlobalY: e.global.y,
          startX: this.subtitleX,
          startY: this.subtitleY,
        }
      })
      text.on('pointermove', (e) => {
        if (!this.subtitleDrag) return
        const canvasWidth = this.viewport.config.canvasWidth
        const canvasHeight = this.viewport.config.canvasHeight
        if (canvasWidth <= 0 || canvasHeight <= 0) return
        this.subtitleX = this.subtitleDrag.startX + (e.global.x - this.subtitleDrag.startGlobalX) / canvasWidth
        this.subtitleY = this.subtitleDrag.startY + (e.global.y - this.subtitleDrag.startGlobalY) / canvasHeight
        this.subtitleX = Math.max(0.02, Math.min(0.98, this.subtitleX))
        this.subtitleY = Math.max(0.02, Math.min(0.98, this.subtitleY))
        this.applySubtitleLayout()
      })
      text.on('pointerup', () => { this.subtitleDrag = null })
      text.on('pointerupoutside', () => { this.subtitleDrag = null })
      this.subtitleText = text
      this.app.stage.addChild(text) // top-most layer
    }
    this.updateSubtitle(this.lastRenderTime)
    this.wake()
    this.presentFrame()
  }

  clearSubtitle(): void {
    this.subtitleCues = []
    if (this.subtitleText) {
      this.subtitleText.visible = false
      this.subtitleText.text = ''
    }
  }

  setSubtitleTransform(scale: number): void {
    this.subtitleScale = Math.max(0.5, Math.min(6, scale))
    this.applySubtitleLayout()
    this.wake()
    this.presentFrame()
  }

  private applySubtitleLayout(): void {
    if (!this.subtitleText) return
    const canvasWidth = this.viewport.config.canvasWidth
    const canvasHeight = this.viewport.config.canvasHeight
    this.subtitleText.scale.set(this.subtitleScale)
    this.subtitleText.x = this.subtitleX * canvasWidth
    this.subtitleText.y = this.subtitleY * canvasHeight
  }

  private updateSubtitle(time: number): void {
    if (!this.subtitleText) return
    let found = false
    for (const cue of this.subtitleCues) {
      if (time >= cue.start && time < cue.end) {
        if (this.subtitleText.text !== cue.text) {
          this.subtitleText.text = cue.text
          this.applySubtitleLayout()
        }
        this.subtitleText.visible = true
        found = true
        break
      }
    }
    if (!found && this.subtitleText.visible) {
      this.subtitleText.visible = false
      this.subtitleText.text = ''
    }
  }

  setVideoOpacity(opacity: number): void {
    this.videoOpacity = Math.max(0, Math.min(1, opacity))
    if (this.videoSprite) {
      this.videoSprite.alpha = this.videoOpacity
    }
  }

  setVolume(volume: number): void {
    if (this.videoElement) {
      this.videoElement.volume = Math.max(0, Math.min(1, volume))
    }
  }

  setVideoPlaybackRate(rate: number): void {
    if (this.videoElement) {
      this.videoElement.playbackRate = Math.max(0.25, Math.min(4, rate))
    }
  }

  setVideoSyncEnabled(enabled: boolean): void {
    this.videoSyncEnabled = enabled
    if (!enabled && this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause()
    }
  }

  // Set the trim window (seconds in the original file) that maps onto the
  // clock/export timeline. (0, 0) = untrimmed (whole file). Called after the
  // customize menu's front/back trim is applied so playback AND export show
  // the same cut.
  setVideoTrimRange(start: number, end: number): void {
    this.videoTrimStart = Math.max(0, start)
    this.videoTrimEnd = Math.max(0, end)
  }

  pauseVideo(): void {
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause()
    }
  }

  setOverlayOpacity(opacity: number): void {
    this.overlayOpacity = Math.max(0, Math.min(1, opacity))
    // Apply to all overlay elements
    // When video background is present, keep it transparent so video shows through
    if (this.backgroundGraphics) this.backgroundGraphics.alpha = this.hasVideoBackground ? 0 : this.overlayOpacity
    if (this.beatGrid?.graphics) this.beatGrid.graphics.alpha = this.overlayOpacity
    if (this.noteRenderer?.container) this.noteRenderer.container.alpha = this.overlayOpacity
    if (this.liveNoteRenderer?.container) this.liveNoteRenderer.container.alpha = this.overlayOpacity
    if (this.nowLineGraphics) this.nowLineGraphics.alpha = this.overlayOpacity
    if (this.keyboardRenderer?.container) this.keyboardRenderer.container.alpha = this.overlayOpacity
    if (this.particles?.container) this.particles.container.alpha = this.overlayOpacity
    for (const ps of this.particleSystems.values()) {
      ps.container.alpha = this.overlayOpacity
    }
    // Force a repaint so the change is visible even when the ticker is idle
    this.wake()
    this.presentFrame()
  }

  private updateVideoSize(): void {
    if (!this.videoSprite || !this.videoElement) return
    const canvasWidth = this.viewport.config.canvasWidth
    const canvasHeight = this.viewport.config.canvasHeight

    // 脛驴卤锚卤脠脌媒 16:9
    const targetRatio = 16 / 9
    const canvasRatio = canvasWidth / canvasHeight

    let displayWidth: number, displayHeight: number

    if (canvasRatio > targetRatio) {
      // 禄颅虏录赂眉驴铆拢卢脪脭驴铆露脠脦陋脳录拢卢赂脽露脠掳麓卤脠脌媒录脝脣茫
      displayWidth = canvasWidth
      displayHeight = canvasWidth / targetRatio
    } else {
      // 禄颅虏录赂眉赂脽拢卢脪脭赂脽露脠脦陋脳录拢卢驴铆露脠掳麓卤脠脌媒录脝脣茫
      displayHeight = canvasHeight
      displayWidth = canvasHeight * targetRatio
    }

    // 碌脳虏驴露脭脝毛
    this.videoSprite.width = displayWidth
    this.videoSprite.height = displayHeight
    this.videoSprite.x = (canvasWidth - displayWidth) / 2
    this.videoSprite.y = canvasHeight - displayHeight // 碌脳虏驴露脭脝毛
  }

  // Public reads of renderer internals for Learn-mode overlays that compute
  // their own geometry (celebration swell position, target-zone color).
  // Kept narrow 隆陋 exercises shouldn't need more than these.
  get currentTheme(): Theme {
    return this.theme
  }
  get currentViewport(): Viewport {
    return this.viewport
  }

  attachClock(clock: MasterClock): void {
    this.app.ticker.add(this.onTick.bind(this, clock))
    // Every clock emission is a wake signal: play() ticks at frame rate, and
    // seek() emits synchronously even while paused 隆陋 so scrubbing a paused
    // piece restarts the (possibly idle-stopped) ticker and repaints at the
    // new position before the loop idles out again.
    this.clockUnsub = clock.subscribe((time) => {
      this.wake()
      this.syncVideoToClock(clock)
    })
  }

  private syncVideoToClock(clock: MasterClock): void {
    if (!this.videoElement) return
    const isPlaying = clock.playing
    const clockTime = clock.currentTime

    if (isPlaying) {
      const dur = this.videoElement.duration || 0
      // Trim window on the clock timeline. The element is the (compressed)
      // full-length import, so its playhead = trimStart + clockTime — playback,
      // seek and export all map through the same window. Untrimmed (0,0)
      // behaves exactly like the old direct mapping (target = clockTime).
      const winLen = this.videoTrimEnd > 0 ? this.videoTrimEnd - this.videoTrimStart : dur
      // If clock has passed the trimmed media duration, stop playing instead
      // of looping.
      if (winLen > 0 && clockTime >= winLen) {
        if (!this.videoElement.paused) {
          this.videoElement.pause()
        }
        return
      }
      const target = this.videoTrimStart + clockTime
      if (this.videoSyncEnabled && this.videoElement.paused) {
        if (dur > 0) {
          this.videoElement.currentTime = Math.min(target, dur)
        }
        this.videoElement.play().catch(err => {
          console.warn('[PianoRollRenderer] Video play failed:', err)
        })
      } else {
        if (dur > 0) {
          const diff = Math.abs(this.videoElement.currentTime - target)
          if (diff > 0.5) {
            this.videoElement.currentTime = target
          }
        }
      }
    } else {
      if (!this.videoElement.paused) {
        this.videoElement.pause()
      }
    }
  }

  // Restart the render loop after an idle stop. No-op while exporting 隆陋
  // the exporter owns the ticker via pauseAutoRender/resumeAutoRender and
  // drives frames manually.
  wake(): void {
    if (this.exportMode) return
    this.idleFrames = 0
    if (!this.app.ticker.started) this.app.ticker.start()
  }

  private onTick(clock: MasterClock, ticker: Ticker): void {
    if (this.exportMode) return
    const hasLive =
      (this.liveNoteStore?.hasRenderableNotes ?? false) ||
      (this.loopNoteStore?.hasRenderableNotes ?? false)
    // Anything that changes frame-to-frame without an external event: a
    // running clock (notes scroll), live/loop note trails (rise and decay),
    // in-flight particles, or external layers. Layers count as always
    // animating 隆陋 Learn overlays run per-frame countdowns/celebrations even
    // on the hub screen, so Learn mode never idle-stops (same as before).
    const videoPlaying = this.videoElement != null && !this.videoElement.paused && !this.videoElement.ended
    const animating =
      clock.playing || hasLive || this.anyParticlesActive() || this.externalLayers.length > 0 || videoPlaying || this.backgroundIsAnimated
    if (animating) {
      this.idleFrames = 0
      this.renderFrame(clock.currentTime, ticker.deltaMS / 1000, clock.playing)
      return
    }
    // Static scene. Render through a short grace window so the settled state
    // is definitely presented, then stop the ticker entirely 隆陋 a static
    // screen otherwise redraws identical pixels at display refresh rate
    // (~170 ms/s main-thread on a 120 Hz laptop; see
    // docs/IDLE_RENDER_LOOP_2026-07-02.md). Every mutation path either calls
    // wake() (clock emits, live-note store changes, layer adds) or presents
    // a frame manually (presentFrame / renderStaticFrame call sites).
    if (this.idleFrames < IDLE_GRACE_FRAMES) {
      this.idleFrames++
      if (this.midi) this.renderFrame(clock.currentTime, ticker.deltaMS / 1000, false)
      return
    }
    this.app.ticker.stop()
  }

  // Drives rendering during video export. `emitParticles: true` so note-on
  // bursts appear in the captured output 隆陋 the exporter steps time forward
  // monotonically from t=0, so prev/curr note tracking works just like live
  // playback.
  async renderManualFrame(time: number, dt: number): Promise<void> {
    if (!this.midi) return
    // Sync video background to export timeline — map through the trim window so
    // an exported video shows exactly the same cut as playback. The element
    // (trimmed transcode or original file) starts at trimStart, so its playhead
    // is (trimStart + time), clamped to the window end.
    if (this.videoElement && this.hasVideoBackground) {
      const dur = this.videoElement.duration || 0
      const winLen = this.videoTrimEnd > 0 ? this.videoTrimEnd - this.videoTrimStart : dur
      let target: number
      if (winLen > 0 && time >= winLen) {
        target = this.videoTrimEnd > 0 ? this.videoTrimEnd : dur
      } else {
        target = this.videoTrimStart + time
      }
      if (dur > 0) target = Math.min(target, dur)
      if (Math.abs(this.videoElement.currentTime - target) > 0.05) {
        this.videoElement.currentTime = target
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            this.videoElement?.removeEventListener('seeked', onSeeked)
            resolve()
          }
          this.videoElement?.addEventListener('seeked', onSeeked)
          setTimeout(() => {
            this.videoElement?.removeEventListener('seeked', onSeeked)
            resolve()
          }, 200)
        })
      }
    }
    this.renderFrame(time, dt, true)
    this.app.renderer.render(this.app.stage)
  }

  renderStaticFrame(currentTime: number): void {
    this.renderFrame(currentTime, 0, false)
    this.app.renderer.render(this.app.stage)
  }

  // Re-present the scene at the last rendered playhead position. This is the
  // correct one-shot repaint for mutations that don't move time (zoom, theme,
  // resize, track visibility): rendering at t=0 instead only *looked* right
  // historically because the always-on ticker repainted at clock time one
  // frame later 隆陋 with the idle-stopped ticker, a t=0 frame would stick.
  private presentFrame(): void {
    this.renderStaticFrame(this.lastRenderTime)
  }

  private renderFrame(currentTime: number, dt: number, emitParticles: boolean): void {
    this.lastRenderTime = currentTime
    // Advance the background drift pattern (wrapped) and repaint the static
    // background layer — only while a crawl is actually enabled.
    if (this.backgroundIsAnimated && this.backgroundDrift > 0) {
      const span = this.viewport.config.canvasWidth + 200
      this.backgroundDriftOffset =
        (this.backgroundDriftOffset + this.backgroundDrift * 60 * dt) % span
      this.drawBackground()
    }
    const curr = this.currActive
    const activeColors = this.activeKeyColors
    curr.clear()
    activeColors.clear()

    // 漏陇漏陇 Scheduled MIDI notes 漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇
    // Single pass collects active pitches and emits note-on particle bursts.
    // `prev`/`curr` swap at the end 隆陋 no per-frame Set or string allocations.
    if (this.midi) {
      const tracks = this.midi.tracks
      const prev = this.prevActive
      const nowLineY = this.viewport.nowLineY
      // Collect this frame's emit-eligible keys + their burst geometry, then let
      // the pure scheduler (emitSchedule.ts) decide onset vs sustain vs reap.
      const eligible = this.emitEligible
      const geom = this.emitGeom
      eligible.clear()
      geom.clear()
      // Don't light up the keyboard for scheduled notes when the clock is
      // paused at the very start of the timeline 隆陋 nothing has actually
      // sounded yet. The classic case this guards against: opening a session
      // recording in file mode where the user held a key at recording start
      // (note.time === 0). Without this gate the keyboard would show that
      // key as pressed before the user has touched play.
      // Once playback has started or the playhead has moved past 0, the
      // normal "sounds now" rule applies 隆陋 pausing mid-piece still shows
      // sustained notes correctly.
      const beforeFirstPlay = !emitParticles && currentTime === 0

      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti]!
        if (!this.visibleTrackIds.has(track.id)) continue
        const practiceInactive =
          this.practiceFocusTrackIds !== null && !this.practiceFocusTrackIds.has(track.id)
        // Always compute the track color 隆陋 we now use it for the keyboard
        // overlay too, not just particle bursts.
        // Keyboard highlight uses the SAME colour as the waterfall note
        // (override ?? DEFAULT_TRACK_COLORS), so pressed keys match notes.
        // When keyboardColorMode is 'border', use border color instead.
        const trackColor = this.keyboardColorMode === 'border'
          ? (this.noteRenderer.getBorderColorForTrack(track.id) ?? getTrackColor(track, this.theme, this.trackColorOverrides))
          : getTrackColor(track, this.theme, this.trackColorOverrides)
        const keyBase = ti * 128

        const [alo, ahi] = visibleNoteRange(track.notes, currentTime, currentTime)
        for (let ni = alo; ni < ahi; ni++) {
          const note = track.notes[ni]!

          const key = keyBase + note.pitch
          const awaitingPracticePress = this.practiceHintPending?.has(note.pitch) ?? false
          if (!practiceInactive && !awaitingPracticePress) {
            curr.add(key)
            if (!beforeFirstPlay)
              activeColors.set(
                note.pitch,
                brightenForKeyboard(applyVelocityShade(trackColor, note.velocity, this.velocityThreshold), 0.15),
              )
          }

          if (!emitParticles || practiceInactive || awaitingPracticePress) continue

          const w = this.viewport.pitchWidth(note.pitch)
          const cx = this.viewport.pitchToX(note.pitch) + w / 2
          eligible.add(key)
          geom.set(key, { cx, w, color: trackColor, trackId: track.id })
        }
      }

      // Pure scheduler decides onset/sustain/reap and updates scheduledEmitNext;
      // here we only draw the resulting bursts using the captured geometry.
      const { emits } = scheduleEmissions({
        prev,
        curr,
        eligible,
        schedule: this.scheduledEmitNext,
        currentTime,
        cadence: SUSTAIN_CADENCE,
      })
      for (const { key, kind } of emits) {
        const g = geom.get(key)
        if (!g) continue
        const ps = this.particleSystemForTrack(g.trackId)
        if (kind === 'onset') ps.burst(g.cx, nowLineY, g.color, g.w)
        else ps.sustainBurst(g.cx, nowLineY, g.color, g.w)
      }

      this.beatGrid.draw(
        currentTime,
        this.midi.bpm,
        this.midi.timeSignature[0] ?? 4,
        this.viewport,
        this.theme,
      )
      this.noteRenderer.draw(
        tracks,
        currentTime,
        this.viewport,
        this.visibleTrackIds,
        this.practiceFocusTrackIds,
      )
    } else {
      this.noteRenderer.clear()
    }

    // Swap prev ? curr for next frame (prev's contents are now stale)
    const tmp = this.prevActive
    this.prevActive = this.currActive
    this.currActive = tmp

    // 漏陇漏陇 Live MIDI keyboard notes 漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇
    if (this.liveNoteStore) {
      const maxReleasedAge = this.viewport.nowLineY / this.viewport.config.pixelsPerSecond
      this.liveNoteStore.pruneInvisible(currentTime, maxReleasedAge)
      this.loopNoteStore?.pruneInvisible(currentTime, maxReleasedAge)

      const held = this.liveNoteStore.heldNotes
      const loopHeld = this.loopNoteStore?.heldNotes
      const liveColor = this.theme.trackColors[0] ?? this.theme.nowLine
      const nowLineY = this.viewport.nowLineY

      for (const [pitch] of held) {
        activeColors.set(pitch, liveColor)
        if (!emitParticles) continue

        const nextAt = this.liveEmitNext.get(pitch)
        if (nextAt === undefined) {
          // First frame we see this held note 隆陋 note-on was already bursted
          // synchronously via burstParticleAt. Schedule the first sustain puff.
          this.liveEmitNext.set(pitch, currentTime + SUSTAIN_INITIAL_DELAY_SEC)
        } else if (currentTime >= nextAt) {
          const w = this.viewport.pitchWidth(pitch)
          const cx = this.viewport.pitchToX(pitch) + w / 2
          this.particles.sustainBurst(cx, nowLineY, liveColor, w)
          this.liveEmitNext.set(pitch, currentTime + SUSTAIN_INTERVAL_SEC)
        }
      }

      // Loop-held notes still light up the keyboard but don't emit particles 隆陋
      // keeps the "me vs my loop" visual distinction clear. Use the live color
      // unless a live note is also active on the same pitch (already set).
      if (loopHeld) {
        for (const [pitch] of loopHeld) {
          if (!activeColors.has(pitch)) activeColors.set(pitch, liveColor)
        }
      }

      // Reap released notes.
      for (const pitch of this.liveEmitNext.keys()) {
        if (!held.has(pitch)) this.liveEmitNext.delete(pitch)
      }

      if (this.liveNotesVisible) {
        this.liveNoteRenderer.draw(
          this.liveNoteStore,
          this.loopNoteStore,
          currentTime,
          this.viewport,
        )
      } else {
        // Keyboard highlight (above) still uses `held` 隆陋 we only suppress
        // the floating-up sprites. Learn mode uses this so user input
        // registers on the keyboard without polluting the piano roll.
        this.liveNoteRenderer.clear()
      }
    } else {
      this.liveNoteRenderer.clear()
      if (this.liveEmitNext.size > 0) this.liveEmitNext.clear()
    }

    this.keyboardRenderer.drawActiveKeys(activeColors, this.viewport)
    this.updateAllParticles(dt)

    // Animated GIF backgrounds: re-upload the current frame every frame so the
    // browser's built-in GIF playback shows through. Static images skip this.
    if (this.isGifImage && this.imageTexture) {
      this.imageTexture.source.update()
    }
    this.updateSubtitle(currentTime)

    if (this.externalLayers.length > 0) {
      const ctx: RenderContext = {
        viewport: this.viewport,
        theme: this.theme,
        time: currentTime,
        dt,
      }
      for (const layer of this.externalLayers) layer.update?.(ctx)
    }
  }

  // Register an additive visual layer on top of the built-in scene. Layers are
  // drawn in `zIndex` order; callers are expected to pick a z that matches the
  // intended stacking (see RenderLayer for the conventional zones). Registering
  // the same layer twice is a no-op.
  addLayer(layer: RenderLayer): void {
    if (this.externalLayers.includes(layer)) return
    layer.mount(this.app.stage)
    this.externalLayers.push(layer)
    this.externalLayers.sort((a, b) => a.zIndex - b.zIndex)
    layer.rebuild?.(this.makeLayerCtx(0))
    // Re-present so a layer added while the clock is paused paints immediately,
    // and wake the ticker 隆陋 layers animate per frame, so their presence keeps
    // the loop out of idle-stop until they're removed.
    this.presentFrame()
    this.wake()
  }

  removeLayer(layer: RenderLayer): void {
    const i = this.externalLayers.indexOf(layer)
    if (i < 0) return
    this.externalLayers.splice(i, 1)
    layer.unmount()
    this.presentFrame()
  }

  private makeLayerCtx(time: number): RenderContext {
    return { viewport: this.viewport, theme: this.theme, time, dt: 0 }
  }

  private rebuildExternalLayers(): void {
    if (this.externalLayers.length === 0) return
    const ctx = this.makeLayerCtx(0)
    for (const layer of this.externalLayers) layer.rebuild?.(ctx)
  }

  burstParticleAt(pitch: number): void {
    const w = this.viewport.pitchWidth(pitch)
    const cx = this.viewport.pitchToX(pitch) + w / 2
    const color = this.theme.trackColors[0] ?? this.theme.nowLine
    this.particles.burst(cx, this.viewport.nowLineY, color, w)
    // Particles animate over the next ~1 s 隆陋 make sure the loop is running.
    this.wake()
  }

  setLiveNoteStore(store: LiveNoteStore): void {
    this.liveStoreUnsub?.()
    this.liveNoteStore = store
    // A press/release/reset can arrive while the ticker is idle-stopped
    // (e.g. first key tap on the home screen) 隆陋 wake so the next frame
    // draws it, and so trails/particles keep animating afterwards.
    this.liveStoreUnsub = store.onChange(() => this.wake())
  }

  // Suppress (or restore) the upward-floating live-note sprites without
  // touching the keyboard-highlight path. A mode that wants the keyboard
  // to highlight presses without streaking notes up the roll (e.g. a
  // practice surface) flips this off on enter and restores on exit.
  setLiveNotesVisible(visible: boolean): void {
    if (this.liveNotesVisible === visible) return
    this.liveNotesVisible = visible
    if (!visible) this.liveNoteRenderer.clear()
    this.presentFrame()
  }

  // Hide/show the entire stage. Skips per-frame draw work (stage.visible=false
  // short-circuits child rendering in Pixi) and hides the underlying canvas so
  // nothing leaks through DOM layers above. The body class lets CSS hide
  // canvas-coupled chrome (e.g. the keyboard-resizer drag seam) in lockstep.
  // Layout is preserved.
  setVisible(visible: boolean): void {
    this.app.stage.visible = visible
    this.app.canvas.style.visibility = visible ? '' : 'hidden'
    document.body.classList.toggle('canvas-hidden', !visible)
    // Coming back from hidden (sheet-music exercise 隆煤 roll), the ticker may
    // be idle-stopped with a stale backbuffer 隆陋 present the current state.
    if (visible) this.presentFrame()
  }

  setLoopNoteStore(store: LiveNoteStore | null): void {
    this.loopStoreUnsub?.()
    this.loopStoreUnsub = null
    this.loopNoteStore = store
    if (store) this.loopStoreUnsub = store.onChange(() => this.wake())
  }

  // Pitch 隆煤 track color map of every key currently lit on the on-screen
  // keyboard. Re-populated each frame in `renderFrame`, so callers (chord
  // overlay, MIDI exporter sidebars, etc.) can read it once per tick.
  get currentActivePitches(): ReadonlyMap<number, number> {
    return this.activeKeyColors
  }

  // Set of MIDI pitches a "play these next" hint should highlight on the
  // keyboard. The renderer overlays them with a soft pulse, distinct from the
  // press-state colour so the hint reads as guidance rather than playback.
  setPracticeHints(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ): void {
    this.practiceHintPending = pending && pending.size > 0 ? pending : null
    this.practiceHintAccepted = accepted && accepted.size > 0 ? accepted : null
    this.keyboardRenderer.setPracticeHints(
      this.practiceHintPending,
      this.practiceHintAccepted,
      this.theme,
    )
    // Paint once so the hint appears immediately 隆陋 the ticker may be
    // idle-stopped (paused practice step), so there is no next tick to
    // rely on. Cheap and unconditional beats guessing the loop's state.
    this.presentFrame()
  }

  isTrackVisible(trackId: string): boolean {
    return this.visibleTrackIds.has(trackId)
  }

  pauseAutoRender(): void {
    this.exportMode = true
    this.app.ticker.stop()
    this.clearAllParticles()
    this.prevActive.clear()
    this.currActive.clear()
    this.liveNoteRenderer.clear()
  }

  resumeAutoRender(): void {
    this.exportMode = false
    // wake() rather than a bare ticker.start() so the idle countdown also
    // resets 隆陋 the post-export scene then presents and idles out normally.
    this.wake()
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement
  }

  // Convert a client-space (canvas) point into a MIDI pitch if it lands on a key.
  pitchAtClientPoint(clientX: number, clientY: number): number | null {
    const rect = this.app.canvas.getBoundingClientRect()
    return this.viewport.pitchAtPoint(clientX - rect.left, clientY - rect.top)
  }

  // ── Bar-line dragging ──────────────────────────────────────────────────

  // Hit-test: is the given canvas-space Y near a bar line?
  // Returns the bar index (0-based: 0 = first bar line at t=0, 1 = second, ...)
  // if within HIT_PX pixels, or null otherwise.
  // Only bar lines between two bars (index >= 1) are draggable.
  hitTestBarLine(clientX: number, clientY: number): number | null {
    if (!this.midi) return null
    const rect = this.app.canvas.getBoundingClientRect()
    const y = clientY - rect.top
    const currentTime = this.lastRenderTime
    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator

    // Scan visible bar lines
    const visStart = currentTime - this.viewport.trailSeconds - 0.5
    const visEnd = currentTime + this.viewport.lookaheadSeconds + 0.5
    const firstBar = Math.max(1, Math.floor(visStart / barDuration))
    const lastBar = Math.ceil(visEnd / barDuration)

    const HIT_PX = 6
    for (let i = firstBar; i <= lastBar; i++) {
      const barTime = this.barLineOverrides.get(i) ?? i * barDuration
      const barY = this.viewport.timeOffsetToY(barTime - currentTime)
      if (Math.abs(y - barY) <= HIT_PX) {
        return i
      }
    }
    return null
  }

  // Start dragging a bar line.
  startBarLineDrag(barIndex: number, clientY: number, shiftKey: boolean, ctrlKey: boolean): void {
    if (!this.midi) return
    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator
    const originalTime = this.barLineOverrides.get(barIndex) ?? barIndex * barDuration

    const rect = this.app.canvas.getBoundingClientRect()
    this.barLineDrag = {
      barIndex,
      originalTime,
      startY: clientY - rect.top,
      shiftKey,
      ctrlKey,
    }
  }

  // Update bar line position during drag.
  updateBarLineDrag(clientY: number): void {
    if (!this.barLineDrag || !this.midi) return
    const rect = this.app.canvas.getBoundingClientRect()
    const y = clientY - rect.top
    const currentTime = this.lastRenderTime
    const pps = this.viewport.config.pixelsPerSecond

    // Convert pixel delta to time delta
    const deltaY = y - this.barLineDrag.startY
    let deltaTime = -deltaY / pps  // negative because up = future = smaller Y

    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator

    // The dragged bar line's new time
    let newTime = this.barLineDrag.originalTime + deltaTime

    // Ctrl: snap to grid
    if (this.barLineDrag.ctrlKey) {
      newTime = this.snapToGrid(newTime)
    }

    // Constrain: the bar line must stay between its neighbors
    const prevBarTime = this.barLineOverrides.get(this.barLineDrag.barIndex - 1)
      ?? (this.barLineDrag.barIndex - 1) * barDuration
    const nextBarTime = this.barLineOverrides.get(this.barLineDrag.barIndex + 1)
      ?? (this.barLineDrag.barIndex + 1) * barDuration
    // Minimum bar width: 1 beat
    const minBarTime = prevBarTime + beatDuration
    const maxBarTime = nextBarTime - beatDuration
    newTime = Math.max(minBarTime, Math.min(maxBarTime, newTime))

    this.barLineOverrides.set(this.barLineDrag.barIndex, newTime)

    // Shift: sync-move all subsequent bar lines by the same delta
    if (this.barLineDrag.shiftKey) {
      const delta = newTime - this.barLineDrag.originalTime
      // Only stretch/compress one bar: move all subsequent bar lines by the same delta
      for (let i = this.barLineDrag.barIndex + 1; ; i++) {
        const existing = this.barLineOverrides.get(i)
        const computed = i * barDuration
        if (existing !== undefined) {
          this.barLineOverrides.set(i, existing + delta)
        } else {
          // Only move if the computed time is within the visible range + some margin
          if (computed > currentTime + this.viewport.lookaheadSeconds + 5) break
          this.barLineOverrides.set(i, computed + delta)
        }
      }
    }

    this.presentFrame()
  }

  // Snap to grid based on zoom level.
  // At normal zoom: quarter note. Zoomed in: eighth or sixteenth. Zoomed out: half note.
  private snapToGrid(time: number): number {
    if (!this.midi) return time
    const beatDuration = 60 / this.midi.bpm
    const pps = this.viewport.config.pixelsPerSecond

    // Pixel width of a quarter note
    const quarterPx = beatDuration * pps
    const eighthPx = (beatDuration / 2) * pps
    const sixteenthPx = (beatDuration / 4) * pps

    // Choose snap resolution based on pixel width
    let snapDuration: number
    if (sixteenthPx >= 12) {
      snapDuration = beatDuration / 4  // sixteenth note
    } else if (eighthPx >= 12) {
      snapDuration = beatDuration / 2  // eighth note
    } else if (quarterPx >= 12) {
      snapDuration = beatDuration       // quarter note
    } else {
      snapDuration = beatDuration * 2   // half note
    }

    return Math.round(time / snapDuration) * snapDuration
  }

  // End the drag.
  endBarLineDrag(): void {
    this.barLineDrag = null
  }

  // Check if a bar line drag is in progress.
  get isDraggingBarLine(): boolean {
    return this.barLineDrag !== null
  }

  // Get the effective bar time for a given bar index, considering overrides.
  getBarTime(barIndex: number): number {
    if (!this.midi) return 0
    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator
    return this.barLineOverrides.get(barIndex) ?? barIndex * barDuration
  }

  // Clear all bar line overrides (e.g. when loading a new MIDI file).
  clearBarLineOverrides(): void {
    this.barLineOverrides.clear()
    this.barLineDrag = null
  }

  // Compute the adjusted duration considering bar line overrides.
  getAdjustedDuration(): number {
    if (!this.midi) return 0
    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator
    const totalBars = Math.ceil(this.midi.duration / barDuration)
    // The last bar line override or the computed last bar time
    const lastBarOverride = this.barLineOverrides.get(totalBars)
    if (lastBarOverride !== undefined) {
      return lastBarOverride + barDuration
    }
    // Check if any override affects the total duration
    let maxTime = this.midi.duration
    for (const [, time] of this.barLineOverrides) {
      if (time + barDuration > maxTime) {
        maxTime = time + barDuration
      }
    }
    return maxTime
  }

  // Remap a time value based on bar line overrides.
  // Uses linear interpolation between bar boundaries.
  remapTime(time: number): number {
    if (!this.midi || this.barLineOverrides.size === 0) return time
    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator

    // Find which bar this time falls in
    const barIndex = Math.floor(time / barDuration)
    const barStart = barIndex * barDuration
    const offsetInBar = time - barStart

    // Get the adjusted start of this bar
    const adjustedBarStart = this.barLineOverrides.get(barIndex) ?? barStart

    // Get the adjusted start of the next bar
    const nextBarIndex = barIndex + 1
    const nextBarStart = nextBarIndex * barDuration
    const adjustedNextBarStart = this.barLineOverrides.get(nextBarIndex) ?? nextBarStart

    // Linear interpolation within the bar
    const originalBarDuration = barDuration
    const adjustedBarDuration = adjustedNextBarStart - adjustedBarStart
    const ratio = adjustedBarDuration / originalBarDuration

    return adjustedBarStart + offsetInBar * ratio
  }

  // Inverse of remapTime: map adjusted time back to original time.
  inverseRemapTime(adjustedTime: number): number {
    if (!this.midi || this.barLineOverrides.size === 0) return adjustedTime
    const beatDuration = 60 / this.midi.bpm
    const timeSigNumerator = this.midi.timeSignature[0] ?? 4
    const barDuration = beatDuration * timeSigNumerator

    // Find which adjusted bar this time falls in
    // We need to find the bar where adjustedBarStart <= adjustedTime < adjustedNextBarStart
    let barIndex = 0
    let adjustedBarStart = this.barLineOverrides.get(0) ?? 0
    let adjustedNextBarStart = this.barLineOverrides.get(1) ?? barDuration

    // Linear search for the correct bar
    while (adjustedTime >= adjustedNextBarStart) {
      barIndex++
      adjustedBarStart = adjustedNextBarStart
      const nextIdx = barIndex + 1
      const nextOriginalStart = nextIdx * barDuration
      adjustedNextBarStart = this.barLineOverrides.get(nextIdx) ?? nextOriginalStart
    }

    // Calculate offset within the adjusted bar
    const offsetInAdjustedBar = adjustedTime - adjustedBarStart
    const adjustedBarDuration = adjustedNextBarStart - adjustedBarStart
    const originalBarDuration = barDuration

    // Map back to original time
    const ratio = originalBarDuration / adjustedBarDuration
    const originalBarStart = barIndex * barDuration
    return originalBarStart + offsetInAdjustedBar * ratio
  }

  // Get all bar line overrides (for export).
  getBarLineOverrides(): ReadonlyMap<number, number> {
    return this.barLineOverrides
  }

  // Current backing-store size + render resolution. Used by the exporter to
  // snapshot state before swapping in a custom export resolution.
  get canvasSize(): { width: number; height: number; resolution: number } {
    return {
      width: this.app.canvas.width,
      height: this.app.canvas.height,
      resolution: this.app.renderer.resolution,
    }
  }

  // Public resize 隆陋 lets the exporter target an exact pixel size independent
  // of the window. Pass `resolution = 1` when exporting so the canvas backing
  // store matches the requested output dimensions exactly.
  resize(width: number, height: number, resolution?: number): void {
    if (resolution !== undefined && resolution !== this.app.renderer.resolution) {
      this.app.renderer.resolution = resolution
    }
    this.app.renderer.resize(width, height)
    this.viewport.update({ canvasWidth: width, canvasHeight: height })
    this.rebuildStaticLayers()
    // Keep the image background fitted and the subtitle anchored to its
    // canvas-fraction position across resizes.
    this.updateImageSize()
    this.applySubtitleLayout()
    // Present at the *current* playhead, not t=0 隆陋 a window resize while
    // paused mid-piece must not repaint the piece's start. (Under the old
    // always-on ticker the t=0 frame was overwritten a frame later; now it
    // would stick.)
    this.presentFrame()
  }

  private handleResize = (): void => {
    // Ignore viewport events during export 隆陋 the exporter owns canvas size
    // until it restores it in its own finally block.
    if (this.exportMode) return
    this.resize(window.innerWidth, window.innerHeight)
    // Keep the piano-like aspect on width changes unless the user pinned a
    // height via the drag handle / saved preference.
    if (!this.keyboardUserOverride) this.applyAutoKeyboardHeight()
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize)
    this.clockUnsub?.()
    this.liveStoreUnsub?.()
    this.loopStoreUnsub?.()
    this.clearVideoBackground()
    this.app.destroy()
  }
}


