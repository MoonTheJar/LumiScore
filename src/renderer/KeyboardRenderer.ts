import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Sprite,
  Texture,
  TilingSprite,
} from 'pixi.js'
import { MIDI_MIN, MIDI_MAX, isBlackKey } from '../core/midi/types'
import { brightenForKeyboard, type Theme } from './theme'
import type { Viewport } from './viewport'

// ── Ivory-grain noise texture ──────────────────────────────────────────────
// A tiny canvas filled with warm-toned noise, tiled across the white keys to
// simulate the subtle grain of real ivory.  Bias brightness high so the grain
// reads as "ivory", not "static".  Alpha is ~8% — subtle but visible on
// close inspection.
function getIvoryNoiseCanvas(): HTMLCanvasElement {
  const size = 128
  const cvs = document.createElement('canvas')
  cvs.width = size
  cvs.height = size
  const ctx = cvs.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + Math.random() * 55
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 20
  }
  ctx.putImageData(img, 0, 0)
  return cvs
}

// ── White-key path builder ─────────────────────────────────────────────────
// Build the final white key shape as a single path using moveTo/lineTo/
// quadraticCurveTo.  The path traces the perimeter clockwise: top edge (with
// notches where black keys overlap), right side, bottom (with rounded
// corners), left side.  This gives correct outer rounded corners and sharp
// inner notches without cut().
function buildWhiteKeyPath(
  g: Graphics,
  outerX: number,
  outerY: number,
  outerW: number,
  outerH: number,
  wRadius: number,
  merged: Array<{ x1: number; x2: number }>,
  blackKeyH: number,
): void {
  const bottomY = outerY + outerH
  g.moveTo(outerX + wRadius, outerY)
  let curX = outerX + wRadius

  // Top edge: walk right, dipping down at black key overlaps
  for (const b of merged) {
    if (curX !== b.x1) {
      g.lineTo(b.x1, outerY)
      curX = b.x1
    }
    g.lineTo(curX, blackKeyH)
    g.lineTo(b.x2, blackKeyH)
    g.lineTo(b.x2, outerY)
    curX = b.x2
  }
  // Final segment to just before top-right corner
  g.lineTo(outerX + outerW - wRadius, outerY)

  // Right side: rounded top-right and bottom-right corners
  g.quadraticCurveTo(outerX + outerW, outerY, outerX + outerW, outerY + wRadius)
  g.lineTo(outerX + outerW, bottomY - wRadius)
  g.quadraticCurveTo(outerX + outerW, bottomY, outerX + outerW - wRadius, bottomY)

  // Bottom edge
  g.lineTo(outerX + wRadius, bottomY)

  // Bottom-left corner
  g.quadraticCurveTo(outerX, bottomY, outerX, bottomY - wRadius)

  // Left side
  g.lineTo(outerX, outerY + wRadius)

  // Top-left corner
  g.quadraticCurveTo(outerX, outerY, outerX + wRadius, outerY)
  g.closePath()
}

export class KeyboardRenderer {
  readonly container: Container

  // Static baked layers
  private whiteSprite: Sprite | null = null
  private whiteTexture: RenderTexture | null = null
  private blackSprite: Sprite | null = null
  private blackTexture: RenderTexture | null = null

  // Dynamic overlay layers (redrawn each frame for active keys)
  private whiteActiveLayer: Graphics
  private blackActiveLayer: Graphics
  private whitePracticeHintLayer: Graphics
  private blackPracticeHintLayer: Graphics

  private lastBuildSignature = ''

  // Practice-hint state
  private practiceTheme: Theme
  private practiceSignature = ''
  private lastPositions: Map<number, { x: number; width: number }> | null = null

  // Active-key caching
  private lastSignature = ''
  private activeLayerDirty = false

  constructor(
    private app: Application,
    private theme: Theme,
  ) {
    this.practiceTheme = theme
    this.container = new Container()
    this.container.label = 'keyboard'

    this.whiteActiveLayer = new Graphics()
    this.whiteActiveLayer.label = 'keyboard-active-white'
    this.blackActiveLayer = new Graphics()
    this.blackActiveLayer.label = 'keyboard-active-black'
    this.whitePracticeHintLayer = new Graphics()
    this.whitePracticeHintLayer.label = 'keyboard-practice-hint-white'
    this.blackPracticeHintLayer = new Graphics()
    this.blackPracticeHintLayer.label = 'keyboard-practice-hint-black'

    this.container.addChild(this.whitePracticeHintLayer)
    this.container.addChild(this.whiteActiveLayer)
    this.container.addChild(this.blackPracticeHintLayer)
    this.container.addChild(this.blackActiveLayer)
  }

  // ── Build / rebuild the static keyboard textures ───────────────────────
  build(viewport: Viewport, yOffset: number): void {
    const { keyboardHeight, canvasWidth, pitchMin, pitchMax } = viewport.config
    const positions = viewport.getAllKeyPositions()
    this.lastPositions = new Map(positions)

    const sig =
      `${canvasWidth}x${keyboardHeight}|${pitchMin ?? 21}-${pitchMax ?? 108}|` +
      `${0xffffff}.${0x000000}.${0x000000}|y=${yOffset}`
    if (sig === this.lastBuildSignature && this.whiteSprite && this.blackSprite) {
      if (!this.lastPositions) this.lastPositions = new Map(positions)
      return
    }

    this.lastBuildSignature = sig
    this.lastPositions = new Map(positions)

    this.whiteTexture?.destroy()
    this.whiteSprite?.destroy()
    this.blackTexture?.destroy()
    this.blackSprite?.destroy()

    // ── White bake ──────────────────────────────────────────────────────
    const whiteBake = new Container()
    const whiteLayer = new Graphics()
    const seamLayer = new Graphics()
    const wMargin = 1
    const wRadius = 3
    const blackKeyH = keyboardHeight * 0.62

    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue

      const overlaps: Array<{ x1: number; x2: number }> = []
      for (let bp = MIDI_MIN; bp <= MIDI_MAX; bp++) {
        if (!isBlackKey(bp)) continue
        const bpos = positions.get(bp)
        if (!bpos) continue
        if (bpos.x < pos.x + pos.width && bpos.x + bpos.width > pos.x) {
          overlaps.push({
            x1: Math.max(bpos.x, pos.x),
            x2: Math.min(bpos.x + bpos.width, pos.x + pos.width),
          })
        }
      }
      overlaps.sort((a, b) => a.x1 - b.x1)
      const merged: Array<{ x1: number; x2: number }> = []
      for (const b of overlaps) {
        if (merged.length > 0 && b.x1 <= merged[merged.length - 1]!.x2) {
          merged[merged.length - 1]!.x2 = Math.max(merged[merged.length - 1]!.x2, b.x2)
        } else {
          merged.push({ ...b })
        }
      }

      // Notch width = (black key width - gap) / 2 on each side
      // Centered on the black key, depth = black key height (original)
      const gap = 2
      const notchMerged: Array<{ x1: number; x2: number }> = []
      for (let bp = MIDI_MIN; bp <= MIDI_MAX; bp++) {
        if (!isBlackKey(bp)) continue
        const bpos = positions.get(bp)
        if (!bpos) continue
        if (bpos.x < pos.x + pos.width && bpos.x + bpos.width > pos.x) {
          const bCenter = bpos.x + bpos.width / 2
          const notchHalfW = (bpos.width - gap) / 2
          notchMerged.push({
            x1: Math.round(bCenter - notchHalfW),
            x2: Math.round(bCenter + notchHalfW),
          })
        }
      }
      notchMerged.sort((a, b) => a.x1 - b.x1)
      const notchDepth = blackKeyH

      const outerX = pos.x + wMargin
      const outerW = pos.width - wMargin * 2

      // Clip notch coordinates to white key visible bounds
      const clippedNotchMerged = notchMerged
        .map((n) => ({
          x1: Math.max(n.x1, outerX),
          x2: Math.min(n.x2, outerX + outerW),
        }))
        .filter((n) => n.x1 < n.x2)

      const outerY = 2
      const outerH = keyboardHeight - 4

      // White key body
      buildWhiteKeyPath(whiteLayer, outerX, outerY, outerW, outerH, wRadius, clippedNotchMerged, notchDepth)
      whiteLayer.fill({ color: 0xffffff })

      // Ivory warmth wash
      buildWhiteKeyPath(whiteLayer, outerX, outerY, outerW, outerH, wRadius, clippedNotchMerged, notchDepth)
      whiteLayer.fill({ color: 0xfff1d8, alpha: 0.05 })

      // Top highlight (only on parts not under black keys)
      let curX = pos.x
      for (const b of merged) {
        if (curX < b.x1) {
          const segX = curX + wMargin
          const segW = b.x1 - curX - wMargin * 2
          if (segW > 0) {
            whiteLayer.rect(segX + wRadius, outerY, segW - wRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.35 })
            whiteLayer.rect(segX + 1, outerY + 1, segW - 2, 2).fill({ color: 0xffffff, alpha: 0.18 })
            whiteLayer.rect(segX + 1, outerY + 3, segW - 2, 2).fill({ color: 0xffffff, alpha: 0.08 })
          }
        }
        curX = Math.max(curX, b.x2)
      }
      if (curX < pos.x + pos.width) {
        const segX = curX + wMargin
        const segW = pos.x + pos.width - curX - wMargin * 2
        if (segW > 0) {
          whiteLayer.rect(segX + wRadius, outerY, segW - wRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.35 })
          whiteLayer.rect(segX + 1, outerY + 1, segW - 2, 2).fill({ color: 0xffffff, alpha: 0.18 })
          whiteLayer.rect(segX + 1, outerY + 3, segW - 2, 2).fill({ color: 0xffffff, alpha: 0.08 })
        }
      }

      // Bottom shadow
      whiteLayer.rect(outerX + 1, outerY + outerH - 5, outerW - 2, 3).fill({ color: 0x000000, alpha: 0.07 })
      whiteLayer.rect(outerX + 1, outerY + outerH - 2, outerW - 2, 1).fill({ color: 0x000000, alpha: 0.18 })
      whiteLayer
        .rect(outerX + wRadius, outerY + outerH - 1, outerW - wRadius * 2, 1)
        .fill({ color: 0x000000, alpha: 0.3 })

      // Seam lines between white keys
      const leftSeamTop = merged.length > 0 && merged[0]!.x1 <= pos.x ? blackKeyH : outerY + wRadius
      seamLayer.rect(pos.x, leftSeamTop, 1, outerY + outerH - leftSeamTop - 1).fill({ color: 0x000000, alpha: 0.15 })
      const rightSeamTop = merged.length > 0 && merged[merged.length - 1]!.x2 >= pos.x + pos.width ? blackKeyH : outerY + wRadius
      seamLayer.rect(pos.x + pos.width - 1, rightSeamTop, 1, outerY + outerH - rightSeamTop - 1).fill({ color: 0x000000, alpha: 0.15 })
    }

    whiteBake.addChild(whiteLayer)
    whiteBake.addChild(seamLayer)

    // Ivory grain noise
    const noiseTex = Texture.from(getIvoryNoiseCanvas())
    const noise = new TilingSprite({
      texture: noiseTex,
      width: canvasWidth,
      height: keyboardHeight,
    })
    whiteBake.addChild(noise)

    this.whiteTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: whiteBake, target: this.whiteTexture })
    whiteBake.destroy({ children: true })
    noiseTex.destroy(true)

    // ── Black bake ──────────────────────────────────────────────────────
    const blackBake = new Container()
    const blackLayer = new Graphics()
    const bRadius = 2
    const blackHeight = keyboardHeight * 0.62

    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (!isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const x = pos.x
      const y = 0
      const w = pos.width
      const h = blackHeight

      blackLayer.roundRect(x, y, w, h, bRadius).fill({ color: 0x000000 })

      // Top bevel
      blackLayer.rect(x + bRadius, y, w - bRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.28 })
      blackLayer.rect(x + 1, y + 1, w - 2, 2).fill({ color: 0xffffff, alpha: 0.12 })

      // Bottom lip
      blackLayer.rect(x + 1, y + h - 3, w - 2, 2).fill({ color: 0xffffff, alpha: 0.1 })
      blackLayer
        .rect(x + bRadius, y + h - 1, w - bRadius * 2, 1)
        .fill({ color: 0xffffff, alpha: 0.22 })

      // Side-edge rails
      const railY = y + bRadius
      const railH = h - bRadius * 2
      blackLayer.rect(x, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.44 })
      blackLayer.rect(x + 1, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.2 })
      blackLayer.rect(x + w - 1, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.28 })
      blackLayer.rect(x + w - 2, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.12 })
    }
    blackBake.addChild(blackLayer)

    this.blackTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: blackBake, target: this.blackTexture })
    blackBake.destroy({ children: true })

    // ── Assemble the z-stack ────────────────────────────────────────────
    this.whiteSprite = new Sprite(this.whiteTexture)
    this.whiteSprite.y = yOffset
    this.container.addChildAt(this.whiteSprite, 0)

    this.blackSprite = new Sprite(this.blackTexture)
    this.blackSprite.y = yOffset
    this.container.addChildAt(this.blackSprite, 3)

    this.whitePracticeHintLayer.y = yOffset
    this.whiteActiveLayer.y = yOffset
    this.blackPracticeHintLayer.y = yOffset
    this.blackActiveLayer.y = yOffset

    this.practiceSignature = ''
  }

  // ── Draw active (pressed) keys ──────────────────────────────────────────
  drawActiveKeys(activeByPitch: Map<number, number>, viewport: Viewport): void {
    const sig = this.signatureFor(activeByPitch)
    if (!this.activeLayerDirty && sig === this.lastSignature) return
    this.activeLayerDirty = false
    this.lastSignature = sig
    this.whiteActiveLayer.clear()
    this.blackActiveLayer.clear()

    const { keyboardHeight } = viewport.config
    const positions = viewport.getAllKeyPositions()
    const fallback = this.theme.trackColors[0] ?? this.theme.nowLine

    const halos: readonly [number, number][] = [
      [10, 0.05],
      [6, 0.1],
      [3, 0.18],
    ]

    for (const [pitch, color] of activeByPitch) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const tint = color ?? fallback
      const isBlack = isBlackKey(pitch)
      const layer = isBlack ? this.blackActiveLayer : this.whiteActiveLayer
      const radius = isBlack ? 2 : 3

      if (isBlack) {
        const h = keyboardHeight * 0.62
        const x = pos.x
        const w = pos.width
        const y = 0
        layer.roundRect(x, y, w, h, radius)
        layer.fill({ color: tint, alpha: 0.92 })
      } else {
        const blackKeyH = keyboardHeight * 0.62
        const wMargin = 1
        const wRadius = 3
        const overlaps: Array<{ x1: number; x2: number }> = []
        for (let bp = MIDI_MIN; bp <= MIDI_MAX; bp++) {
          if (!isBlackKey(bp)) continue
          const bpos = positions.get(bp)
          if (!bpos) continue
          if (bpos.x < pos.x + pos.width && bpos.x + bpos.width > pos.x) {
            overlaps.push({
              x1: Math.max(bpos.x, pos.x),
              x2: Math.min(bpos.x + bpos.width, pos.x + pos.width),
            })
          }
        }
        overlaps.sort((a, b) => a.x1 - b.x1)
        const merged: Array<{ x1: number; x2: number }> = []
        for (const b of overlaps) {
          if (merged.length > 0 && b.x1 <= merged[merged.length - 1]!.x2) {
            merged[merged.length - 1]!.x2 = Math.max(merged[merged.length - 1]!.x2, b.x2)
          } else {
            merged.push({ ...b })
          }
        }

        // Notch width = (black key width - gap) / 2 on each side
        const gap = 2
        const notchMerged: Array<{ x1: number; x2: number }> = []
        for (let bp = MIDI_MIN; bp <= MIDI_MAX; bp++) {
          if (!isBlackKey(bp)) continue
          const bpos = positions.get(bp)
          if (!bpos) continue
          if (bpos.x < pos.x + pos.width && bpos.x + bpos.width > pos.x) {
            const bCenter = bpos.x + bpos.width / 2
            const notchHalfW = (bpos.width - gap) / 2
            notchMerged.push({
              x1: Math.round(bCenter - notchHalfW),
              x2: Math.round(bCenter + notchHalfW),
            })
          }
        }
        notchMerged.sort((a, b) => a.x1 - b.x1)
        const notchDepth = blackKeyH

        const outerX = pos.x + wMargin
        const outerW = pos.width - wMargin * 2

        // Clip notch coordinates to white key visible bounds
        const clippedNotchMerged = notchMerged
          .map((n) => ({
            x1: Math.max(n.x1, outerX),
            x2: Math.min(n.x2, outerX + outerW),
          }))
          .filter((n) => n.x1 < n.x2)

        const outerY = 2
        const outerH = keyboardHeight - 4

        // Halos
        for (const [expand, alpha] of halos) {
          const expMerged = clippedNotchMerged.map((b) => ({
            x1: b.x1 - expand,
            x2: b.x2 + expand,
          }))
          buildWhiteKeyPath(layer, outerX - expand, outerY - expand, outerW + expand * 2, outerH + expand * 2, radius + expand, expMerged, notchDepth)
          layer.fill({ color: tint, alpha })
        }

        // Solid body
        buildWhiteKeyPath(layer, outerX, outerY, outerW, outerH, radius, clippedNotchMerged, notchDepth)
        layer.fill({ color: tint, alpha: 1.0 })
      }
    }
  }

  // ── Theme update ────────────────────────────────────────────────────────
  updateTheme(theme: Theme): void {
    this.theme = theme
    this.activeLayerDirty = true
    this.practiceTheme = theme
    this.practiceSignature = ''
  }

  // ── Practice hints ──────────────────────────────────────────────────────
  setPracticeHints(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
    theme: Theme,
  ): void {
    this.practiceTheme = theme
    const sig = this.hintSignature(pending, accepted)
    if (sig === this.practiceSignature) return
    this.practiceSignature = sig
    this.redrawPracticeHints(pending, accepted)
  }

  // ── Private helpers ─────────────────────────────────────────────────────
  private signatureFor(activeByPitch: Map<number, number>): string {
    if (activeByPitch.size === 0) return ''
    const parts: string[] = []
    for (const [pitch, color] of activeByPitch) {
      parts.push(`${pitch}:${color}`)
    }
    return parts.join(',')
  }

  private hintSignature(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ): string {
    const p = pending ? [...pending].sort((a, b) => a - b).join(',') : ''
    const a = accepted ? [...accepted].sort((a, b) => a - b).join(',') : ''
    return `${p}|${a}`
  }

  private redrawPracticeHints(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ): void {
    this.whitePracticeHintLayer.clear()
    this.blackPracticeHintLayer.clear()
    if (!this.lastPositions) return

    const positions = this.lastPositions
    const theme = this.practiceTheme
    const fullKbHeight = this.whiteSprite?.height ?? 120
    const acceptedTint = theme.whiteKeyActive
    const pendingTint = theme.nowLine

    for (const pitch of accepted ?? []) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const isBlack = isBlackKey(pitch)
      const layer = isBlack ? this.blackPracticeHintLayer : this.whitePracticeHintLayer
      this.drawPracticeKey(layer, pitch, pos, fullKbHeight, acceptedTint, {
        bodyAlpha: isBlackKey(pitch) ? 0.36 : 0.25,
        stripAlpha: 0.58,
        haloScale: 0.55,
      })
    }

    for (const pitch of pending ?? []) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const isBlack = isBlackKey(pitch)
      const layer = isBlack ? this.blackPracticeHintLayer : this.whitePracticeHintLayer
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300)
      this.drawPracticeKey(layer, pitch, pos, fullKbHeight, pendingTint, {
        bodyAlpha: (isBlack ? 0.32 : 0.22) * pulse,
        stripAlpha: 0.55 * pulse,
        haloScale: pulse,
      })
    }
  }

  private drawPracticeKey(
    layer: Graphics,
    _pitch: number,
    pos: { x: number; width: number },
    fullKbHeight: number,
    tint: number,
    opts: { bodyAlpha: number; stripAlpha: number; haloScale: number },
  ): void {
    const x = pos.x + 1
    const y = 0
    const w = pos.width - 2
    const h = fullKbHeight
    const radius = 2

    const halos: [number, number][] = [
      [8 * opts.haloScale, 0.06],
      [4 * opts.haloScale, 0.12],
    ]
    for (const [expand, alpha] of halos) {
      layer.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius + expand)
      layer.fill({ color: tint, alpha })
    }

    layer.roundRect(x, y, w, h, radius)
    layer.fill({ color: tint, alpha: opts.bodyAlpha })

    layer.rect(x + radius, y, w - radius * 2, 2)
    layer.fill({ color: tint, alpha: opts.stripAlpha })
  }
}