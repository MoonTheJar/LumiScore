import { createSignal, For, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { INSTRUMENTS, type InstrumentId } from '../audio/SynthEngine'
import { t } from '../i18n'
import { icons } from './icons'
import { isNarrowViewport } from './utils'

// Audio control dropdown — a pill trigger + popover. Replaces the old
// standalone Instrument pill and adds per-track voice toggles, the
// metronome and a global reverb dial.

interface TriggerProps {
  isOpen: () => boolean
  onToggle: () => void
  registerEl: (el: HTMLButtonElement) => void
}

function TriggerView(props: TriggerProps) {
  return (
    <button
      ref={(el) => props.registerEl(el)}
      class="ts-pill ts-pill--audio"
      classList={{ 'ts-pill--open': props.isOpen() }}
      id="ts-audio"
      type="button"
      title={t('topStrip.audio')}
      aria-label={t('topStrip.audio')}
      onClick={() => props.onToggle()}
    >
      <span innerHTML={icons.waveform(14)} />
      <span>{t('topStrip.audio')}</span>
      <span innerHTML={icons.chevronDown(10)} />
    </button>
  )
}

interface MenuProps {
  isOpen: () => boolean
  isSheet: () => boolean
  current: () => InstrumentId
  loading: () => InstrumentId | null
  tracks: () => readonly { id: string; name: string }[]
  enabledState: () => Record<string, boolean>
  onSelectInstrument: (id: InstrumentId) => void
  onTrackEnabledChange: (trackId: string, enabled: boolean) => void
  metronomeOn: () => boolean
  metronomeBpm: () => number
  onMetronomeToggle: () => void
  onMetronomeBpmChange: (bpm: number) => void
  reverb: () => number
  onReverbChange: (v: number) => void
  registerEl: (el: HTMLElement) => void
}

function MenuView(props: MenuProps) {
  return (
    <div
      ref={(el) => props.registerEl(el)}
      class="ts-popover ts-audio-menu"
      classList={{
        'ts-popover--open': props.isOpen(),
        'popover--sheet': props.isSheet(),
      }}
    >
      <div class="panel-header">
        <span class="panel-label">{t('audio.title')}</span>
      </div>
      <div class="ts-customize-body">
        {/* Instrument (bulk-apply voice to every audible track) */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('audio.instrument')}</span>
          </div>
          <div class="instrument-items">
            <For each={INSTRUMENTS}>
              {(inst) => (
                <button
                  class="instrument-item"
                  classList={{
                    'instrument-item--on': props.current() === inst.id,
                    'instrument-item--loading': props.loading() === inst.id,
                  }}
                  data-id={inst.id}
                  type="button"
                  onClick={() => props.onSelectInstrument(inst.id)}
                >
                  <span class="instrument-item-dot" aria-hidden="true"></span>
                  <span class="instrument-item-body">
                    <span class="instrument-item-name">{t(inst.nameKey)}</span>
                    <span class="instrument-item-sub">{t(inst.descriptionKey)}</span>
                  </span>
                  <span class="instrument-item-check" aria-hidden="true" innerHTML={icons.check()} />
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Per-track voice toggles */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('audio.tracks')}</span>
          </div>
          <div class="audio-track-rows">
            <Show when={props.tracks().length > 0} fallback={<p class="customize-advanced-hint">—</p>}>
              <For each={props.tracks()}>
                {(tr) => {
                  const enabled = (): boolean => props.enabledState()[tr.id] ?? true
                  return (
                    <label class="audio-track-row">
                      <span class="audio-track-name">{tr.name}</span>
                      <button
                        type="button"
                        class="track-toggle-btn track-toggle-btn--audible"
                        classList={{ on: enabled() }}
                        aria-label={t('tracks.audible')}
                        aria-pressed={enabled()}
                        title={t('tracks.audible')}
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          props.onTrackEnabledChange(tr.id, !enabled())
                        }}
                        innerHTML={enabled() ? icons.volume(13) : icons.volumeMute(13)}
                      />
                    </label>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>

        {/* Metronome */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('audio.metronome')}</span>
          </div>
          <div class="customize-section customize-section--toggle">
            <button
              class="customize-toggle"
              classList={{ 'customize-toggle--on': props.metronomeOn() }}
              type="button"
              aria-pressed={props.metronomeOn() ? 'true' : 'false'}
              onClick={() => props.onMetronomeToggle()}
            >
              <span class="customize-toggle-body">
                <span class="customize-toggle-name">{t('audio.metronome')}</span>
                <span class="customize-toggle-sub">{t('audio.metronome.bpm')} · {props.metronomeBpm()}</span>
              </span>
              <span class="customize-toggle-switch" aria-hidden="true">
                <span class="customize-toggle-knob"></span>
              </span>
            </button>
          </div>
          <div class="customize-opacity-row">
            <span class="customize-opacity-row-label">{t('audio.metronome.bpm')}</span>
            <input
              type="range"
              class="customize-media-slider"
              min="40"
              max="240"
              step="1"
              value={props.metronomeBpm()}
              style={{ '--pct': `${((props.metronomeBpm() - 40) / 200) * 100}%` }}
              onInput={(e) => props.onMetronomeBpmChange(parseInt(e.currentTarget.value, 10))}
            />
          </div>
        </div>

        {/* Global reverb */}
        <div class="customize-section">
          <div class="customize-section-head">
            <span class="customize-section-label">{t('audio.reverb')}</span>
          </div>
          <div class="customize-opacity-row">
            <span class="customize-opacity-row-label">{t('audio.reverb')}</span>
            <input
              type="range"
              class="customize-media-slider"
              min="0"
              max="1"
              step="0.01"
              value={props.reverb()}
              style={{ '--pct': `${props.reverb() * 100}%` }}
              onInput={(e) => props.onReverbChange(parseFloat(e.currentTarget.value))}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export class AudioMenu {
  readonly trigger!: HTMLButtonElement
  private menu!: HTMLElement
  private isOpen = false
  private disposeTrigger: (() => void) | null = null
  private disposeMenu: (() => void) | null = null
  private menuWrapper: HTMLDivElement | null = null
  private triggerWrapper: HTMLDivElement | null = null

  private readonly writeCurrent: (v: InstrumentId) => void
  private readonly readCurrent: () => InstrumentId
  private readonly writeLoading: (v: InstrumentId | null) => void
  private readonly writeMetronomeOn: (v: boolean) => void
  private readonly writeMetronomeBpm: (v: number) => void
  private readonly writeReverb: (v: number) => void
  private readonly readReverb: () => number
  private readonly setIsOpen: (v: boolean) => void
  private readonly setIsSheet: (v: boolean) => void
  private readonly writeTracks: (v: readonly { id: string; name: string }[]) => void
  private readonly writeEnabledState: (v: Record<string, boolean>) => void

  // Real signals (not captured field accessors): the menu mounts once at boot,
  // so a plain `this.tracks` accessor would freeze props.tracks() at the boot
  // value and the rows would never appear after a MIDI load. Assigned in the
  // constructor from the createSignal pair.
  private tracks: () => readonly { id: string; name: string }[] = () => []
  private enabledState: () => Record<string, boolean> = () => ({})

  onSelect?: (id: InstrumentId) => void
  onTrackEnabledChange?: (trackId: string, enabled: boolean) => void
  onMetronomeToggle?: () => void
  onMetronomeBpmChange?: (bpm: number) => void
  onReverbChange?: (v: number) => void

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
    const [current, setCurrent] = createSignal<InstrumentId>('piano')
    const [loading, setLoading] = createSignal<InstrumentId | null>(null)
    const [metronomeOn, setMetronomeOn] = createSignal(false)
    const [metronomeBpm, setMetronomeBpm] = createSignal(120)
    const [reverb, setReverb] = createSignal(0.2)
    const [isOpen, setIsOpen] = createSignal(false)
    const [isSheet, setIsSheet] = createSignal(false)
    const [tracks, setTracksSig] = createSignal<readonly { id: string; name: string }[]>([])
    const [enabledState, setEnabledStateSig] = createSignal<Record<string, boolean>>({})

    this.writeCurrent = setCurrent
    this.readCurrent = current
    this.writeLoading = setLoading
    this.writeMetronomeOn = setMetronomeOn
    this.writeMetronomeBpm = setMetronomeBpm
    this.writeReverb = setReverb
    this.readReverb = reverb
    this.setIsOpen = setIsOpen
    this.setIsSheet = setIsSheet
    this.tracks = tracks
    this.enabledState = enabledState
    this.writeTracks = setTracksSig
    this.writeEnabledState = setEnabledStateSig

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
          current={current}
          loading={loading}
          tracks={this.tracks}
          enabledState={this.enabledState}
          onSelectInstrument={(id) => {
            this.writeCurrent(id)
            this.close()
            this.onSelect?.(id)
          }}
          onTrackEnabledChange={(trackId, enabled) => {
            this.onTrackEnabledChange?.(trackId, enabled)
          }}
          metronomeOn={metronomeOn}
          metronomeBpm={metronomeBpm}
          onMetronomeToggle={() => {
            const next = !metronomeOn()
            setMetronomeOn(next)
            this.onMetronomeToggle?.()
          }}
          onMetronomeBpmChange={(bpm) => {
            setMetronomeBpm(bpm)
            this.onMetronomeBpmChange?.(bpm)
          }}
          reverb={reverb}
          onReverbChange={(v) => {
            setReverb(v)
            this.onReverbChange?.(v)
          }}
          registerEl={(el) => {
            this.menu = el
          }}
        />
      ),
      menuWrapper,
    )
  }

  setCurrent(id: InstrumentId): void {
    this.writeCurrent(id)
  }

  // Drives the loading indicator on the matching instrument row.
  setLoading(id: InstrumentId | null): void {
    this.writeLoading(id)
  }

  getCurrent(): InstrumentId {
    return this.readCurrent()
  }

  // Track list + enabled state come from the shared TrackPanel so the voice
  // toggles here stay in sync with the waterfall panel. Written through the
  // signals so the mounted menu re-renders its rows. The accessor is kept so
  // the app can push fresh snapshots after a per-track voice change.
  setTracks(tracks: readonly { id: string; name: string }[]): void {
    this.writeTracks(tracks)
  }

  private enabledStateAccessor: () => Record<string, boolean> = () => ({})

  setEnabledState(state: () => Record<string, boolean>): void {
    this.enabledStateAccessor = state
    this.writeEnabledState(state())
  }

  refreshEnabledState(): void {
    this.writeEnabledState(this.enabledStateAccessor())
  }

  setMetronomeOn(on: boolean): void {
    this.writeMetronomeOn(on)
  }

  setMetronomeBpm(bpm: number): void {
    this.writeMetronomeBpm(bpm)
  }

  setReverb(v: number): void {
    this.writeReverb(v)
  }

  getReverb(): number {
    return this.readReverb()
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
