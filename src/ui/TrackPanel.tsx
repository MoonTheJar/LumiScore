import { createMemo, createSignal, For } from 'solid-js'
import { render } from 'solid-js/web'
import type { MidiFile, MidiTrack } from '../core/midi/types'
import { t, tn } from '../i18n'
import type { PianoRollRenderer } from '../renderer/PianoRollRenderer'
import { getTrackColor, type Theme } from '../renderer/theme'
import { icons } from './icons'
import { hexToCSS, isNarrowViewport } from './utils'

// Popover dropdown anchored under the Tracks button in the top strip.
// Each track has a mute toggle; a "Load new file" footer reopens the Open
// MIDI modal for quick swap.

interface PanelProps {
  isOpen: () => boolean
  isSheet: () => boolean
  tracks: () => readonly MidiTrack[]
  theme: () => Theme
  renderer: PianoRollRenderer
  onTrackEnabledChange: (trackId: string, enabled: boolean) => void
  onTrackVisibleChange: (trackId: string, visible: boolean) => void
  onLoadNew: () => void
  registerPanelEl: (el: HTMLElement) => void
  onPickColor: (track: MidiTrack, anchorEl: HTMLElement) => void
  getColorOverride: (trackId: string) => number | null
  getTrackInstrumentName: (trackId: string) => string
  // Local reactive toggle state (default = on). Using Solid signals here means
  // the buttons re-render reliably on click; the external `version` signal
  // only drives swatch colours, which is insufficient for row re-renders.
  visibleState: () => Record<string, boolean>
  enabledState: () => Record<string, boolean>
  setVisibleState: (v: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void
  setEnabledState: (v: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void
  // Local version bumped by TrackPanel.refresh() (instrument changes, colour
  // overrides). Solid tracks this reliably inside <For> children, which is
  // what re-renders the per-track instrument names.
  instrumentVersion: () => number
  // Bumped by TrackPanel.refresh() after a track-colour override changes via
  // ColorPicker. getColorOverride reads a non-reactive renderer field, so
  // without subscribing to this signal the swatch colours would only refresh
  // when the panel is reopened.
  version: () => number
}

export function TrackPanelView(props: PanelProps) {
  return (
    <div
      id="track-panel"
      class="ts-popover"
      classList={{
        'ts-popover--open': props.isOpen(),
        'popover--sheet': props.isSheet(),
      }}
      ref={(el) => props.registerPanelEl(el)}
    >
      <div class="panel-header">
        <span class="panel-label">{t('tracks.title')}</span>
      </div>
      <div class="panel-items">
        <For each={props.tracks()}>
          {(tr) => {
            // Subscribe to BOTH local versions so external refresh() calls
            // re-evaluate the swatch, the two toggle buttons and the per-track
            // instrument name. `instrumentVersion` is a local signal Solid
            // tracks reliably inside <For> children — the external `version`
            // signal alone does not re-run rows.
            //
            // IMPORTANT: the per-track instrument name and the colour override
            // are computed from *external* functions (getTrackInstrumentName /
            // getColorOverride) that Solid's compiler cannot see. Calling the
            // version signal bare at the top of the children does NOT wire the
            // name/colour into reactivity (the compiler treats the JSX
            // expression as static). They must be wrapped in createMemo that
            // reads the signal, so a refresh() bump re-computes them.
            const instName = createMemo(() => {
              props.instrumentVersion()
              return props.getTrackInstrumentName(tr.id)
            })
            const color = createMemo(() => {
              props.version()
              const ov = props.getColorOverride(tr.id)
              return hexToCSS(ov !== null ? ov : getTrackColor(tr, props.theme(), undefined))
            })
            const hasOverride = createMemo(() => {
              props.version()
              return props.getColorOverride(tr.id) !== null
            })
            // Resolve to the SAME source the waterfall note uses
            // (override ?? theme.trackColors), so the swatch matches what
            // NoteRenderer paints and follows the active theme.
            const visible = (): boolean => props.visibleState()[tr.id] ?? true
            const enabled = (): boolean => props.enabledState()[tr.id] ?? true
            return (
              <label class="track-item">
                <span class="track-swatch" style={{ background: color() }} />
                <span class="track-info">
                  <span class="track-name">{tr.name}</span>
                  <span class="track-meta">
                    {tn('tracks.notes', tr.notes.length, { channel: tr.channel + 1 })}
                    <span class="track-meta-sep">·</span>
                    <span class="track-instrument-name">
                      {instName()}
                    </span>
                  </span>
                </span>
                <button
                  class="track-color-chip"
                  type="button"
                  aria-label={t('colorPicker.title')}
                  style={{ background: color() }}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    props.onPickColor(tr, e.currentTarget)
                  }}
                >
                  {hasOverride() && <span class="track-color-chip-dot" />}
                </button>
                <span class="track-toggle-wrap" style={{ '--track-color': color() }}>
                  <button
                    type="button"
                    class="track-toggle-btn track-toggle-btn--visible"
                    classList={{ on: visible() }}
                    aria-label={t('tracks.visible')}
                    aria-pressed={visible()}
                    title={t('tracks.visible')}
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      const next = !visible()
                      props.setVisibleState((s) => ({ ...s, [tr.id]: next }))
                      props.onTrackVisibleChange(tr.id, next)
                    }}
                    innerHTML={visible() ? icons.eye(13) : icons.eyeOff(13)}
                  />
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
                      const next = !enabled()
                      props.setEnabledState((s) => ({ ...s, [tr.id]: next }))
                      props.onTrackEnabledChange(tr.id, next)
                    }}
                    innerHTML={enabled() ? icons.volume(13) : icons.volumeMute(13)}
                  />
                </span>
              </label>
            )
          }}
        </For>
      </div>
      <div class="panel-footer">
        <button class="panel-load-btn" type="button" onClick={() => props.onLoadNew()}>
          <span innerHTML={icons.upload(11)} />
          {t('tracks.loadNew')}
        </button>
      </div>
    </div>
  )
}

export class TrackPanel {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null
  private panelEl: HTMLElement | null = null
  private trigger: HTMLElement | null = null

  private readonly setIsOpen: (v: boolean) => void
  private readonly isOpenFn: () => boolean
  // ── Embed surface (RollMenu renders a second TrackPanelView from these) ──
  readonly renderer: PianoRollRenderer
  readonly tracksFn: () => readonly MidiTrack[]
  readonly themeFn: () => Theme
  readonly visibleStateFn: () => Record<string, boolean>
  readonly enabledStateFn: () => Record<string, boolean>
  readonly setVisibleState: (v: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void
  readonly setEnabledState: (v: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void
  readonly instrumentVersionFn: () => number
  readonly versionFn: () => number
  readonly onTrackEnabledChange: (trackId: string, enabled: boolean) => void
  readonly onTrackVisibleChange: (trackId: string, visible: boolean) => void
  readonly onLoadNew: () => void
  readonly onPickColor: (track: MidiTrack, anchorEl: HTMLElement) => void
  readonly getColorOverride: (trackId: string) => number | null
  readonly getTrackInstrumentName: (trackId: string) => string
  private readonly setIsSheet: (v: boolean) => void
  private readonly setTracks: (v: readonly MidiTrack[]) => void
  private readonly setThemeSig: (v: Theme) => void
  // Solid setter accepts either a plain value or an updater function.
  private readonly bumpVersion: (v: number | ((prev: number) => number)) => number
  private bumpInstrumentVersion: (v: number | ((prev: number) => number)) => number =
    () => 0
  private resetStates: () => void = () => {}

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.panelEl?.contains(target)) return
    if (this.trigger?.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpenFn()) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpenFn()) return
    // Sheet mode is CSS-driven; if the breakpoint flipped while open, close
    // rather than present a half-styled popover.
    if (this.panelEl?.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  constructor(
    container: HTMLElement,
    renderer: PianoRollRenderer,
    onTrackEnabledChange: (trackId: string, enabled: boolean) => void,
    onTrackVisibleChange: (trackId: string, visible: boolean) => void,
    onLoadNew: () => void,
    onPickColor: (track: MidiTrack, anchorEl: HTMLElement) => void,
    getColorOverride: (trackId: string) => number | null,
    getTrackInstrumentName: (trackId: string) => string,
  ) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [isSheet, setIsSheet] = createSignal(false)
    const [tracks, setTracks] = createSignal<readonly MidiTrack[]>([])
    const [theme, setThemeSig] = createSignal<Theme>(renderer.currentTheme)
    const [version, bumpVersion] = createSignal(0)
    const [instrumentVersion, bumpInstrumentVersion] = createSignal(0)
    // Per-track toggle state, owned by this panel so clicks re-render the
    // buttons via Solid signals (external maps don't trigger For children).
    const [visibleState, setVisibleState] = createSignal<Record<string, boolean>>({})
    const [enabledState, setEnabledState] = createSignal<Record<string, boolean>>({})
    this.isOpenFn = isOpen
    this.setIsOpen = setIsOpen
    this.setIsSheet = setIsSheet
    this.setTracks = setTracks
    this.setThemeSig = setThemeSig
    this.bumpVersion = bumpVersion
    this.bumpInstrumentVersion = bumpInstrumentVersion
    this.renderer = renderer
    this.tracksFn = tracks
    this.themeFn = theme
    this.visibleStateFn = visibleState
    this.enabledStateFn = enabledState
    this.setVisibleState = setVisibleState
    this.setEnabledState = setEnabledState
    this.instrumentVersionFn = instrumentVersion
    this.versionFn = version
    this.onTrackEnabledChange = onTrackEnabledChange
    this.onTrackVisibleChange = onTrackVisibleChange
    this.onLoadNew = onLoadNew
    this.onPickColor = onPickColor
    this.getColorOverride = getColorOverride
    this.getTrackInstrumentName = getTrackInstrumentName
    this.resetStates = () => {
      setVisibleState({})
      setEnabledState({})
    }

    const wrapper = document.createElement('div')
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.disposeRoot = render(
      () => (
        <TrackPanelView
          isOpen={isOpen}
          isSheet={isSheet}
          tracks={tracks}
          theme={theme}
          renderer={renderer}
          onTrackEnabledChange={onTrackEnabledChange}
          onTrackVisibleChange={onTrackVisibleChange}
          onLoadNew={() => {
            this.close()
            onLoadNew()
          }}
          registerPanelEl={(el) => {
            this.panelEl = el
          }}
          onPickColor={onPickColor}
          getColorOverride={getColorOverride}
          getTrackInstrumentName={getTrackInstrumentName}
          visibleState={visibleState}
          enabledState={enabledState}
          setVisibleState={setVisibleState}
          setEnabledState={setEnabledState}
          instrumentVersion={instrumentVersion}
          version={version}
        />
      ),
      wrapper,
    )
  }

  render(midi: MidiFile): void {
    // A fresh file starts fully open: every track visible and audible.
    this.resetStates()
    this.setTracks(midi.tracks)
  }

  setTheme(theme: Theme): void {
    this.setThemeSig(theme)
  }

  // Full props for a SECOND TrackPanelView instance embedded inside the
  // waterfall dropdown (RollMenu). Both instances share the same signals and
  // callbacks, so the top-strip panel and the embedded list stay in sync.
  // The caller supplies its own onLoadNew so its popover can close too.
  getEmbedProps(overrides: { onLoadNew: () => void }): PanelProps {
    return {
      isOpen: () => true,
      isSheet: () => false,
      tracks: this.tracksFn,
      theme: this.themeFn,
      renderer: this.renderer,
      onTrackEnabledChange: this.onTrackEnabledChange,
      onTrackVisibleChange: this.onTrackVisibleChange,
      onLoadNew: overrides.onLoadNew,
      registerPanelEl: () => {},
      onPickColor: this.onPickColor,
      getColorOverride: this.getColorOverride,
      getTrackInstrumentName: this.getTrackInstrumentName,
      visibleState: this.visibleStateFn,
      enabledState: this.enabledStateFn,
      setVisibleState: this.setVisibleState,
      setEnabledState: this.setEnabledState,
      instrumentVersion: this.instrumentVersionFn,
      version: this.versionFn,
    }
  }

  // Bump the version signals so the per-track swatch colours and instrument
  // names re-evaluate live after a track-colour override changes via
  // ColorPicker or after the instrument menu bulk-applies a new voice.
  // Without this the rows only refresh when the panel is reopened, because
  // getColorOverride reads a non-reactive renderer field and instrument names
  // read the synth's per-track map.
  refresh(): void {
    this.bumpVersion((v) => v + 1)
    this.bumpInstrumentVersion((v) => v + 1)
  }

  setTrigger(el: HTMLElement): void {
    this.trigger = el
  }

  toggle(): void {
    if (this.isOpenFn()) this.close()
    else this.open()
  }

  open(): void {
    if (this.isOpenFn()) return
    this.setIsOpen(true)
    if (isNarrowViewport()) {
      this.setIsSheet(true)
      if (this.panelEl) {
        this.panelEl.style.top = ''
        this.panelEl.style.right = ''
        this.panelEl.style.left = ''
      }
    } else {
      this.setIsSheet(false)
      this.positionUnder()
    }
    // Defer listener attach so the click that opened us doesn't immediately
    // bubble and close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  close(): void {
    if (!this.isOpenFn()) return
    this.setIsOpen(false)
    this.setIsSheet(false)
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  hide(): void {
    this.close()
  }

  dispose(): void {
    this.close()
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }

  private positionUnder(): void {
    const trigger = this.trigger
    const panel = this.panelEl
    if (!trigger || !panel) return
    const rect = trigger.getBoundingClientRect()
    const panelW = panel.offsetWidth || 320
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    panel.style.right = `${right}px`
    panel.style.top = `${top}px`
    panel.style.left = ''
    const desiredLeft = window.innerWidth - right - panelW
    if (desiredLeft < 12) panel.style.right = `${Math.max(12, window.innerWidth - panelW - 12)}px`
  }
}
