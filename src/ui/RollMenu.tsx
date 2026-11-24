import { createSignal, For, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { t } from '../i18n'
import type { ParticleStyleInfo } from '../renderer/ParticleSystem'
import { PARTICLE_STYLES } from '../renderer/ParticleSystem'
import { hexToCSS, isNarrowViewport } from './utils'
import { icons } from './icons'
import { TrackPanelView, type TrackPanel } from './TrackPanel'

// Waterfall & keyboard dropdown — a pill trigger + popover. Bundles the
// falling-note look (corner radius / colour / particle effect) together with
// the per-track visibility toggles, replacing the old standalone Tracks pill.
// The track list is a second TrackPanelView embedded in this popover and
// sharing the TrackPanel instance's signals, so both stay in sync.

interface TriggerProps {
  isOpen: () => boolean
  onToggle: () => void
  registerEl: (el: HTMLButtonElement) => void
}

function TriggerView(props: TriggerProps) {
  return (
    <button
      ref={(el) => props.registerEl(el)}
      class="ts-pill ts-pill--roll"
      classList={{ 'ts-pill--open': props.isOpen() }}
      id="ts-roll"
      type="button"
      title={t('topStrip.roll')}
      aria-label={t('topStrip.roll')}
      onClick={() => props.onToggle()}
    >
      <span innerHTML={icons.waterfall(14)} />
      <span>{t('topStrip.roll')}</span>
      <span innerHTML={icons.chevronDown(10)} />
    </button>
  )
}

interface MenuProps {
  isOpen: () => boolean
  isSheet: () => boolean
  cornerRatio: () => number
  colorMode: () => 'track' | 'custom'
  customColorCss: () => string
  particleIndex: () => number
  particleColorCss: () => string | null
  hasTracks: () => boolean
  embedTracks: () => ReturnType<TrackPanel['getEmbedProps']> | null
  onCornerRatioChange: (v: number) => void
  onColorModeChange: (mode: 'track' | 'custom') => void
  onOpenCustomColor: () => void
  onSelectParticle: (i: number) => void
  onOpenParticleColor: () => void
  registerEl: (el: HTMLElement) => void
}

function MenuView(props: MenuProps) {
  return (
    <div
      ref={(el) => props.registerEl(el)}
      class="ts-popover ts-roll-menu"
      classList={{
        'ts-popover--open': props.isOpen(),
        'popover--sheet': props.isSheet(),
      }}
    >
      <div class="panel-header">
        <span class="panel-label">{t('roll.title')}</span>
      </div>
      <div class="ts-customize-body">
        {/* Note corner radius (share of the shortest side) */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('roll.corner')}</span>
          </div>
          <div class="customize-opacity-row">
            <input
              type="range"
              class="customize-media-slider"
              min="0"
              max="0.5"
              step="0.01"
              value={props.cornerRatio()}
              style={{ '--pct': `${(props.cornerRatio() / 0.5) * 100}%` }}
              onInput={(e) => props.onCornerRatioChange(parseFloat(e.currentTarget.value))}
            />
            <span class="roll-corner-value">
              {Math.round(props.cornerRatio() * 100)}%
            </span>
          </div>
          <p class="customize-advanced-hint">{t('roll.cornerHint')}</p>
        </div>

        {/* Note colour: per-track or one flat colour */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('roll.color')}</span>
          </div>
          <div class="customize-particle-row">
            <button
              class="customize-particle-chip"
              classList={{
                'customize-particle-chip--on': props.colorMode() === 'track',
              }}
              type="button"
              onClick={() => props.onColorModeChange('track')}
            >
              <span class="customize-particle-chip-label">{t('roll.color.track')}</span>
            </button>
            <button
              class="customize-particle-chip"
              classList={{
                'customize-particle-chip--on': props.colorMode() === 'custom',
              }}
              type="button"
              onClick={() => props.onColorModeChange('custom')}
            >
              <span class="customize-particle-chip-label">{t('roll.color.custom')}</span>
            </button>
            <button
              class="customize-color-swatch"
              classList={{
                'customize-color-swatch--off': props.colorMode() !== 'custom',
              }}
              type="button"
              title={t('roll.color.custom')}
              aria-label={t('roll.color.custom')}
              style={{ background: props.customColorCss() }}
              onClick={() => props.onOpenCustomColor()}
            />
          </div>
        </div>

        {/* Particle effect */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('roll.effect')}</span>
          </div>
          <div class="customize-particle-row">
            <button
              class="customize-color-swatch"
              classList={{
                'customize-color-swatch--off': props.particleColorCss() === null,
              }}
              type="button"
              title={t('customize.particleColor')}
              aria-label={t('customize.particleColor')}
              style={{ background: props.particleColorCss() ?? 'transparent' }}
              onClick={() => props.onOpenParticleColor()}
            />
            <For each={PARTICLE_STYLES}>
              {(p: ParticleStyleInfo, i) => (
                <button
                  class="customize-particle-chip"
                  classList={{
                    'customize-particle-chip--on': props.particleIndex() === i(),
                  }}
                  type="button"
                  title={p.name}
                  aria-label={`${p.name} particles`}
                  onClick={() => props.onSelectParticle(i())}
                >
                  <span
                    class="customize-particle-chip-glyph"
                    data-style={p.id}
                    aria-hidden="true"
                    innerHTML={p.id === 'none' ? icons.close(12) : ''}
                  />
                  <span class="customize-particle-chip-label">{p.name}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Track visibility — embedded TrackPanelView */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('roll.tracks')}</span>
          </div>
          <Show when={props.embedTracks()} fallback={<p class="customize-advanced-hint">—</p>}>
            {(e) => <TrackPanelView {...e()} />}
          </Show>
        </div>
      </div>
    </div>
  )
}

export class RollMenu {
  readonly trigger!: HTMLButtonElement
  private menu!: HTMLElement
  private isOpen = false
  private disposeTrigger: (() => void) | null = null
  private disposeMenu: (() => void) | null = null
  private menuWrapper: HTMLDivElement | null = null
  private triggerWrapper: HTMLDivElement | null = null

  private readonly writeCornerRatio: (v: number) => void
  private readonly readCornerRatio: () => number
  private readonly writeColorMode: (v: 'track' | 'custom') => void
  private readonly readColorMode: () => 'track' | 'custom'
  private readonly writeCustomColor: (v: string) => void
  private readonly readCustomColor: () => string
  private readonly writeParticleIdx: (v: number) => void
  private readonly readParticleIdx: () => number
  private readonly writeParticleColor: (v: string | null) => void
  private readonly readParticleColor: () => string | null
  private readonly writeTracks: (v: ReturnType<TrackPanel['getEmbedProps']> | null) => void
  private readonly setIsOpen: (v: boolean) => void
  private readonly setIsSheet: (v: boolean) => void

  onCornerRatioChange?: (v: number) => void
  onColorModeChange?: (mode: 'track' | 'custom', customColor?: number) => void
  onOpenCustomColor?: () => void
  onSelectParticle?: (i: number) => void
  onOpenParticleColor?: () => void

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.menu.contains(target)) return
    if (this.trigger.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpen) return
    if (this.menu.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  constructor(triggerHost: HTMLElement, popoverHost: HTMLElement) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [isSheet, setIsSheet] = createSignal(false)
    const [cornerRatio, setCornerRatio] = createSignal(0.35)
    const [colorMode, setColorMode] = createSignal<'track' | 'custom'>('track')
    const [customColor, setCustomColor] = createSignal('#3b82f6')
    const [particleIdx, setParticleIdx] = createSignal(0)
    const [particleColor, setParticleColor] = createSignal<string | null>(null)
    const [tracks, setTracks] = createSignal<ReturnType<TrackPanel['getEmbedProps']> | null>(null)

    this.writeCornerRatio = setCornerRatio
    this.readCornerRatio = cornerRatio
    this.writeColorMode = setColorMode
    this.readColorMode = colorMode
    this.writeCustomColor = setCustomColor
    this.readCustomColor = customColor
    this.writeParticleIdx = setParticleIdx
    this.readParticleIdx = particleIdx
    this.writeParticleColor = setParticleColor
    this.readParticleColor = particleColor
    this.writeTracks = setTracks
    this.setIsOpen = setIsOpen
    this.setIsSheet = setIsSheet

    const triggerWrapper = document.createElement('div')
    triggerWrapper.style.display = 'contents'
    triggerHost.appendChild(triggerWrapper)
    this.triggerWrapper = triggerWrapper
    let triggerEl!: HTMLButtonElement
    this.disposeTrigger = render(
      () => (
        <TriggerView
          isOpen={isOpen}
          onToggle={() => this.toggle()}
          registerEl={(el) => {
            triggerEl = el
          }}
        />
      ),
      triggerWrapper,
    )
    ;(this as { trigger: HTMLButtonElement }).trigger = triggerEl

    const menuWrapper = document.createElement('div')
    popoverHost.appendChild(menuWrapper)
    this.menuWrapper = menuWrapper
    this.disposeMenu = render(
      () => (
        <MenuView
          isOpen={isOpen}
          isSheet={isSheet}
          cornerRatio={cornerRatio}
          colorMode={colorMode}
          customColorCss={() => hexToCSS(customColor())}
          particleIndex={particleIdx}
          particleColorCss={particleColor}
          hasTracks={() => tracks() !== null}
          embedTracks={tracks}
          onCornerRatioChange={(v) => {
            setCornerRatio(v)
            this.onCornerRatioChange?.(v)
          }}
          onColorModeChange={(mode) => {
            setColorMode(mode)
            this.onColorModeChange?.(mode, customColor())
          }}
          onOpenCustomColor={() => this.onOpenCustomColor?.()}
          onSelectParticle={(i) => {
            setParticleIdx(i)
            this.onSelectParticle?.(i)
          }}
          onOpenParticleColor={() => this.onOpenParticleColor?.()}
          registerEl={(el) => {
            this.menu = el
          }}
        />
      ),
      menuWrapper,
    )
  }

  // Keep the embedded track list in sync with the loaded MIDI.
  setEmbedProps(props: ReturnType<TrackPanel['getEmbedProps']> | null): void {
    this.writeTracks(props)
  }

  setCornerRatio(v: number): void {
    this.writeCornerRatio(v)
  }
  setColorMode(mode: 'track' | 'custom'): void {
    this.writeColorMode(mode)
  }
  setCustomColorCss(css: string): void {
    this.writeCustomColor(css)
  }
  setParticleIndex(i: number): void {
    this.writeParticleIdx(i)
  }
  setParticleColorCss(css: string | null): void {
    this.writeParticleColor(css)
  }

  private toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.setIsOpen(true)
    if (isNarrowViewport()) {
      this.setIsSheet(true)
      this.menu.style.top = ''
      this.menu.style.right = ''
      this.menu.style.left = ''
    } else {
      this.setIsSheet(false)
      this.positionUnder()
    }
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  private close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.setIsOpen(false)
    this.setIsSheet(false)
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  private positionUnder(): void {
    const rect = this.trigger.getBoundingClientRect()
    const menuW = this.menu.offsetWidth || 300
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    this.menu.style.right = `${right}px`
    this.menu.style.top = `${top}px`
    this.menu.style.left = ''
    const desiredLeft = window.innerWidth - right - menuW
    if (desiredLeft < 12)
      this.menu.style.right = `${Math.max(12, window.innerWidth - menuW - 12)}px`
  }

  dispose(): void {
    this.close()
    this.disposeTrigger?.()
    this.disposeMenu?.()
    this.disposeTrigger = null
    this.disposeMenu = null
    this.triggerWrapper?.remove()
    this.menuWrapper?.remove()
    this.triggerWrapper = null
    this.menuWrapper = null
  }
}
