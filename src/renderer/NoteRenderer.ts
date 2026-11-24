import { Container, Graphics } from 'pixi.js'
import { GlowFilter } from 'pixi-filters'
import { isBlackKey, type MidiTrack } from '../core/midi/types'
import { applyVelocityShade, getTrackColor, type BorderStyle, type Theme } from './theme'
import { type Viewport, visibleNoteRange } from './viewport'

// One Graphics object per track — same-color draws are batched together.
// Each track has its own glow container + GlowFilter so multi-track
// notes glow with their own colour instead of being averaged.

const PRACTICE_INACTIVE_ALPHA_SCALE = 0.24

interface TrackGlow {
  container: Container
  graphics: Graphics
  filter: GlowFilter
}

export class NoteRenderer {
  readonly container: Container

  private trackGraphics = new Map<string, Graphics>()
  private trackGlows = new Map<string, TrackGlow>()
  private trackColorOverrides: Map<string, number> = new Map()
  private velocityThreshold = 0
  // Most recent active-notes average colour (null when nothing is sounding).
  // PianoRollRenderer reads this to tint the waterfall border.
  lastAvgColor: number | null = null
  // Per-track sounding-note decoration. Each track stores its own
  // BorderStyle + colour override; the CustomizeMenu writes to all
  // currently visible tracks at once, so toggling a track off isolates
  // its state (preserved in the map), and toggling it back on restores
  // the saved look. Default (track not in map): glow style, null colour
  // = follow the track colour / sounding-notes average.
  private borderStyleByTrack = new Map<string, BorderStyle>()
  private borderColorByTrack = new Map<string, number | null>()
  // Corner radius as a fraction (0-0.5) of the note block's SHORTEST side, so
  // pill-shaped blocks track their own size instead of a fixed pixel radius.
  private cornerRatio = 0.35
  // Note colour mode: 'track' = per-track colour (default); 'custom' = one
  // flat colour for every note block.
  private colorMode: 'track' | 'custom' = 'track'
  private customNoteColor = 0x3b82f6

  constructor(private theme: Theme) {
    this.container = new Container()
    this.container.label = 'notes'
  }

  setCornerRatio(ratio: number): void {
    this.cornerRatio = Math.max(0, Math.min(0.5, ratio))
  }

  getCornerRatio(): number {
    return this.cornerRatio
  }

  setColorMode(mode: 'track' | 'custom', customColor?: number): void {
    this.colorMode = mode
    if (customColor !== undefined) this.customNoteColor = customColor
  }

  getColorMode(): 'track' | 'custom' {
    return this.colorMode
  }

  getCustomNoteColor(): number {
    return this.customNoteColor
  }

  // Call once when tracks are loaded — sets up one Graphics per track
  setTracks(tracks: MidiTrack[]): void {
    const incomingIds = new Set(tracks.map((t) => t.id))

    // Remove stale graphics and glow containers
    for (const [id, g] of this.trackGraphics) {
      if (!incomingIds.has(id)) {
        this.container.removeChild(g)
        g.destroy()
        this.trackGraphics.delete(id)
      }
    }
    for (const [id, glow] of this.trackGlows) {
      if (!incomingIds.has(id)) {
        this.container.removeChild(glow.container)
        glow.container.destroy({ children: true })
        this.trackGlows.delete(id)
      }
    }

    for (const track of tracks) {
      if (!this.trackGraphics.has(track.id)) {
        const g = new Graphics()
        g.label = `notes-${track.id}`
        this.container.addChild(g)
        this.trackGraphics.set(track.id, g)
      }
      if (!this.trackGlows.has(track.id)) {
        const glowContainer = new Container()
        glowContainer.label = `glow-${track.id}`
        const glowFilter = new GlowFilter({
          distance: this.theme.noteGlowDistance,
          outerStrength: this.theme.noteGlowStrength,
          innerStrength: 0,
          color: 0xffffff,
          quality: 0.3,
        })
        glowContainer.filters = [glowFilter]
        const glowGraphics = new Graphics()
        glowContainer.addChild(glowGraphics)
        this.container.addChild(glowContainer)
        this.trackGlows.set(track.id, {
          container: glowContainer,
          graphics: glowGraphics,
          filter: glowFilter,
        })
        glowContainer.visible = false
      }
    }

    // Ensure glow containers render on top of note graphics
    this.refreshChildOrder()
  }

  private refreshChildOrder(): void {
    // Note graphics first, then glow containers on top
    let idx = 0
    for (const g of this.trackGraphics.values()) {
      this.container.setChildIndex(g, idx++)
    }
    for (const glow of this.trackGlows.values()) {
      this.container.setChildIndex(glow.container, idx++)
    }
  }

  // Called every frame from the main render loop.
  draw(
    tracks: MidiTrack[],
    currentTime: number,
    viewport: Viewport,
    visibleTrackIds: Set<string>,
    practiceFocusTrackIds: ReadonlySet<string> | null,
  ): void {
    const nowLineY = viewport.nowLineY
    // Radius = fraction of the SHORTEST side, so wide-but-flat blocks get
    // pill caps and tall narrow blocks stay nearly square — matches the
    // user's "rounded by the note block's shortest side" spec.
    const cornerRatio = this.cornerRatio
    const flatColor = this.colorMode === 'custom' ? this.customNoteColor : null

    let activeCount = 0
    let sumR = 0,
      sumG = 0,
      sumB = 0

    const visStart = currentTime - viewport.trailSeconds - 0.5
    const visEnd = currentTime + viewport.lookaheadSeconds + 0.5

    // Reset all glow graphics for visible tracks
    for (const track of tracks) {
      const glow = this.trackGlows.get(track.id)
      if (glow) {
        glow.graphics.clear()
        glow.container.visible = false
      }
    }

    for (const track of tracks) {
      const g = this.trackGraphics.get(track.id)
      if (!g) continue

      g.clear()

      if (!visibleTrackIds.has(track.id)) continue

      const noteColor = flatColor ?? getTrackColor(track, this.theme, this.trackColorOverrides)
      const bs = this.borderStyleByTrack.get(track.id) ?? 'glow'
      const bco = this.borderColorByTrack.get(track.id) ?? null
      const practiceInactive =
        practiceFocusTrackIds !== null && !practiceFocusTrackIds.has(track.id)

      const glow = this.trackGlows.get(track.id)
      const [lo, hi] = visibleNoteRange(track.notes, visStart, visEnd)
      for (let ni = lo; ni < hi; ni++) {
        const note = track.notes[ni]!

        const baseX = viewport.pitchToX(note.pitch)
        const baseW = viewport.pitchWidth(note.pitch)
        const wMargin = isBlackKey(note.pitch) ? 0 : 1
        const x = baseX + wMargin
        const w = Math.max(baseW - wMargin * 2, 2)
        const timeDelta = note.time - currentTime
        const noteBottom = Math.min(viewport.timeOffsetToY(timeDelta), nowLineY)
        const noteTop = viewport.timeOffsetToY(timeDelta + note.duration)
        if (noteTop >= nowLineY) continue
        const h = Math.max(noteBottom - noteTop, 3)
        const y = noteTop

        const alpha =
          (0.5 + note.velocity * 0.5) * (practiceInactive ? PRACTICE_INACTIVE_ALPHA_SCALE : 1)

        const shadedColor = applyVelocityShade(noteColor, note.velocity, this.velocityThreshold)
        const radius = Math.min(w, h) * cornerRatio
        g.roundRect(x, y, w, h, radius)
        g.fill({ color: shadedColor, alpha })

        if (
          !practiceInactive &&
          note.time <= currentTime &&
          note.time + note.duration >= currentTime
        ) {
          const decorColor = bco ?? shadedColor
          if (bs === 'glow') {
            // Draw into this track's own glow container
            if (glow) {
              glow.graphics.roundRect(x, y, w, h, radius)
              glow.graphics.fill({ color: decorColor, alpha: 0.9 })
              glow.container.visible = true
              // Per-track glow filter uses this track's decoration color
              glow.filter.color = decorColor
            }
            sumR += (decorColor >> 16) & 0xff
            sumG += (decorColor >> 8) & 0xff
            sumB += decorColor & 0xff
            activeCount++
          } else if (bs === 'solid') {
            g.roundRect(x, y, w, h, radius)
            g.stroke({
              color: decorColor,
              width: 2,
              alpha: 0.95,
            })
          }
        }
      }
    }

    // Compute average color for waterfall border tint
    if (activeCount > 0) {
      this.lastAvgColor =
        (Math.round(sumR / activeCount) << 16) |
        (Math.round(sumG / activeCount) << 8) |
        Math.round(sumB / activeCount)
    } else {
      this.lastAvgColor = null
    }
  }

  setTrackColorOverrides(overrides: Map<string, number>): void {
    this.trackColorOverrides = overrides
  }

  setBorderStyleForTrack(trackId: string, style: BorderStyle): void {
    this.borderStyleByTrack.set(trackId, style)
  }

  getBorderStyleForTrack(trackId: string): BorderStyle {
    return this.borderStyleByTrack.get(trackId) ?? 'glow'
  }

  setBorderColorForTrack(trackId: string, color: number | null): void {
    this.borderColorByTrack.set(trackId, color)
  }

  getBorderColorForTrack(trackId: string): number | null {
    return this.borderColorByTrack.get(trackId) ?? null
  }

  setVelocityThreshold(v: number): void {
    this.velocityThreshold = v
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    for (const glow of this.trackGlows.values()) {
      glow.filter.distance = theme.noteGlowDistance
      glow.filter.outerStrength = theme.noteGlowStrength
    }
  }

  clear(): void {
    this.trackGraphics.forEach((g) => {
      g.clear()
    })
    for (const glow of this.trackGlows.values()) {
      glow.graphics.clear()
      glow.container.visible = false
    }
  }
}
