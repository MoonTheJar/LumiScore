import { createSignal, For, Show } from 'solid-js'
import { Portal, render } from 'solid-js/web'
import type { ExportStage } from '../export/VideoExporter'
import { t } from '../i18n'
import { icons } from './icons'

// Supported export resolution presets.
export type ExportResolution = 'match' | 'video-native' | '720p' | '1080p' | '2k' | '4k' | 'vertical' | 'square' | 'custom'
export type ExportOutput = 'av' | 'video-only' | 'audio-only' | 'midi'
export type ExportFocus = 'fit' | 'all'
export type ExportSpeed = 'compact' | 'standard' | 'drama'
export type ExportAudioFormat = 'mp3' | 'wav'

// Export mode: quick (single export) or batch (multiple exports)
export type ExportMode = 'quick' | 'batch'

// Quick export preset types
export type QuickPreset = 'waterfall-only' | 'mixed' | 'video-waterfall' | 'midi'

// Custom export options for quick mode
export interface ExportCustomOptions {
  video: boolean
  audio: boolean
  waterfall: boolean
  instrument: boolean
}

// Batch export item
export interface ExportBatchItem {
  id: number
  video: boolean
  audio: boolean
  waterfall: boolean
  instrument: boolean
}

export interface ExportSettings {
  fps: number
  resolution: ExportResolution
  output: ExportOutput
  focus: ExportFocus
  speed: ExportSpeed
  audioFormat: ExportAudioFormat
  matchCanvasToVideo?: boolean
  codec?: 'h264' | 'h265'
  // New fields for batch/custom export
  mode?: ExportMode
  customOptions?: ExportCustomOptions
  batchItems?: ExportBatchItem[]
  midiName?: string
}
// Built lazily inside the view so each t() call is reactive.
interface PresetCard {
  id: ExportResolution
  label: string
  dim: string
  aspect: 'landscape' | 'vertical' | 'square' | 'match'
  hint?: string
}

function buildPresets(): readonly PresetCard[] {
  return [
    { id: '1080p', label: '1080p', dim: '1920 × 1080', aspect: 'landscape' },
    { id: '720p', label: '720p', dim: '1280 × 720', aspect: 'landscape' },
    {
      id: '2k',
      label: '2K',
      dim: '2560 × 1440',
      aspect: 'landscape',
      hint: t('export.preset.2k.hint'),
    },
    {
      id: '4k',
      label: '4K',
      dim: '3840 × 2160',
      aspect: 'landscape',
      hint: t('export.preset.4k.hint'),
    },
    {
      id: 'vertical',
      label: t('export.preset.vertical'),
      dim: '1080 × 1920',
      aspect: 'vertical',
      hint: t('export.preset.vertical.hint'),
    },
    {
      id: 'square',
      label: t('export.preset.square'),
      dim: '1080 × 1080',
      aspect: 'square',
      hint: t('export.preset.square.hint'),
    },
    {
      id: 'match',
      label: t('export.preset.match'),
      dim: t('export.preset.match.dim'),
      aspect: 'match',
    },
  ]
}

function buildVideoNativePreset(label: string, dim: string): PresetCard {
  return {
    id: 'video-native',
    label,
    dim,
    aspect: 'landscape',
    hint: t('export.preset.videoNative.hint'),
  }
}

const FPS_OPTIONS = [24, 30, 60] as const

type Phase = 'settings' | 'progress'

interface ViewProps {
  container: HTMLElement
  isOpen: () => boolean
  phase: () => Phase
  fps: () => number
  setFps: (v: number) => void
  resolution: () => ExportResolution
  setResolution: (v: ExportResolution) => void
  output: () => ExportOutput
  setOutput: (v: ExportOutput) => void
  audioFormat: () => ExportAudioFormat
  setAudioFormat: (v: ExportAudioFormat) => void
  focus: () => ExportFocus
  setFocus: (v: ExportFocus) => void
  speed: () => ExportSpeed
  setSpeed: (v: ExportSpeed) => void
  stage: () => string
  pct: () => number
  indeterminate: () => boolean
  hasVideo: () => boolean
  hasAudio: () => boolean
  matchCanvasToVideo: () => boolean
  setMatchCanvasToVideo: (v: boolean) => void
  setCodec: (v: 'h264' | 'h265') => void
  readCodec: () => 'h264' | 'h265'
  hevcSupported: () => boolean
  videoDimensions: () => { width: number; height: number } | null
  videoNativeFps: () => number
  videoNativeLabel: () => string
  capturePreviewFrame: () => string | null
  mode: () => ExportMode
  setMode: (v: ExportMode) => void
  quickPreset: () => QuickPreset | 'custom'
  setQuickPreset: (v: QuickPreset | 'custom') => void
  customOptions: () => ExportCustomOptions
  setCustomOptions: (v: ExportCustomOptions) => void
  customExpanded: () => boolean
  setCustomExpanded: (v: boolean) => void
  batchItems: () => ExportBatchItem[]
  setBatchItems: (v: ExportBatchItem[]) => void
  onDismiss: () => void
  onStart: () => void
  onCancelProgress: () => void
}
function ExportView(props: ViewProps) {
  const noVideo = (): boolean => props.output() === 'audio-only' || props.output() === 'midi'
  const isSocial = (): boolean =>
    !noVideo() && (props.resolution() === 'vertical' || props.resolution() === 'square')

  // Apply quick preset
  const applyQuickPreset = (preset: QuickPreset): void => {
    props.setQuickPreset(preset)
    switch (preset) {
      case 'waterfall-only':
        props.setCustomOptions({ video: false, audio: false, waterfall: true, instrument: true })
        props.setOutput('av')
        break
      case 'mixed':
        props.setCustomOptions({ video: true, audio: true, waterfall: true, instrument: true })
        props.setOutput('av')
        break
      case 'video-waterfall':
        props.setCustomOptions({ video: true, audio: false, waterfall: true, instrument: true })
        props.setOutput('av')
        break
      case 'midi':
        props.setCustomOptions({ video: false, audio: false, waterfall: false, instrument: false })
        props.setOutput('midi')
        break
    }
  }

  // Toggle batch item checkbox
  const toggleBatchItem = (id: number, field: 'video' | 'audio' | 'waterfall' | 'instrument'): void => {
    const items = props.batchItems()
    const newItems = items.map(item =>
      item.id === id ? { ...item, [field]: !item[field] } : item
    )
    props.setBatchItems(newItems)
  }

  // Add batch item
  const addBatchItem = (): void => {
    const items = props.batchItems()
    const newId = items.length > 0 ? Math.max(...items.map(i => i.id)) + 1 : 1
    props.setBatchItems([...items, { id: newId, video: false, audio: false, waterfall: false, instrument: false }])
  }

  // Remove batch item
  const removeBatchItem = (id: number): void => {
    props.setBatchItems(props.batchItems().filter(item => item.id !== id))
  }

  // Check if two batch items are identical
  const isDuplicateItem = (item: ExportBatchItem, items: ExportBatchItem[]): boolean => {
    return items.some(other =>
      other.id !== item.id &&
      other.video === item.video &&
      other.audio === item.audio &&
      other.waterfall === item.waterfall &&
      other.instrument === item.instrument
    )
  }

  return (
    <Portal mount={props.container}>
      <div
        id="export-modal"
        classList={{ open: props.isOpen() }}
        onClick={(e) => {
          if (e.target === e.currentTarget && props.phase() === 'settings') props.onDismiss()
        }}
      >
        <div class="export-card modal-scroll">
          <div class="export-phase" classList={{ hidden: props.phase() !== 'settings' }}>
            {/* Title bar with mode toggle */}
            <header class="export-header">
              <div class="export-card-icon" innerHTML={icons.film()} />
              <div class="export-header-text">
                <h2 class="export-card-title">
                  {props.mode() === 'quick' ? t('export.mode.quick') : t('export.mode.batch')}
                </h2>
                <p class="export-card-sub">{t('export.mode.hint')}</p>
              </div>
              {/* Mode toggle tabs — right-aligned in the header on the wide card */}
              <div class="export-mode-tabs">
                <button
                  type="button"
                  class="mode-tab"
                  classList={{ 'mode-tab--active': props.mode() === 'quick' }}
                  onClick={() => props.setMode('quick')}
                  onDblClick={() => props.setMode('batch')}
                >
                  {t('export.mode.quick')}
                </button>
                <button
                  type="button"
                  class="mode-tab"
                  classList={{ 'mode-tab--active': props.mode() === 'batch' }}
                  onClick={() => props.setMode('batch')}
                  onDblClick={() => props.setMode('quick')}
                >
                  {t('export.mode.batch')}
                </button>
              </div>
            </header>

            {/* Two-column horizontal layout: mode-specific options on the left,
                picture-quality settings on the right, actions spanning the bottom. */}
            <div class="export-settings-grid">
              {/* Left column — content-source options */}
              <div class="export-col">
                {/* Quick Export Mode */}
                <Show when={props.mode() === 'quick'}>
                  {/* Quick presets */}
                  <section class="export-section">
                    <span class="export-section-label">{t('export.quickPresets')}</span>
                    <div class="quick-presets-grid">
                      <button
                        type="button"
                        class="quick-preset-btn"
                        classList={{ 'quick-preset-btn--active': props.quickPreset() === 'waterfall-only' }}
                        onClick={() => applyQuickPreset('waterfall-only')}
                      >
                        {t('export.preset.waterfallOnly')}
                      </button>
                      <button
                        type="button"
                        class="quick-preset-btn"
                        classList={{ 'quick-preset-btn--active': props.quickPreset() === 'mixed' }}
                        onClick={() => applyQuickPreset('mixed')}
                      >
                        {t('export.preset.mixed')}
                      </button>
                      <button
                        type="button"
                        class="quick-preset-btn"
                        classList={{ 'quick-preset-btn--active': props.quickPreset() === 'video-waterfall' }}
                        onClick={() => applyQuickPreset('video-waterfall')}
                      >
                        {t('export.preset.videoWaterfall')}
                      </button>
                      <button
                        type="button"
                        class="quick-preset-btn"
                        classList={{ 'quick-preset-btn--active': props.quickPreset() === 'midi' }}
                        onClick={() => applyQuickPreset('midi')}
                      >
                        MIDI
                      </button>
                    </div>
                  </section>

                  {/* Custom options collapsible */}
                  <section class="export-section">
                    <button
                      type="button"
                      class="custom-collapse-toggle"
                      onClick={() => props.setCustomExpanded(!props.customExpanded())}
                    >
                      <span>{t('export.customOptions')}</span>
                      <span class="collapse-arrow" classList={{ 'collapse-arrow--open': props.customExpanded() }}>▼</span>
                    </button>
                    <Show when={props.customExpanded()}>
                      <div class="custom-options-grid">
                        <Show when={props.hasVideo()}>
                          <label class="custom-checkbox">
                            <input
                              type="checkbox"
                              checked={props.customOptions().video}
                              onChange={(e) => {
                                const opts = props.customOptions()
                                props.setCustomOptions({ ...opts, video: e.currentTarget.checked })
                                props.setQuickPreset('custom')
                              }}
                            />
                            <span>{t('export.option.video')}</span>
                          </label>
                        </Show>
                        <Show when={props.hasAudio()}>
                          <label class="custom-checkbox">
                            <input
                              type="checkbox"
                              checked={props.customOptions().audio}
                              onChange={(e) => {
                                const opts = props.customOptions()
                                props.setCustomOptions({ ...opts, audio: e.currentTarget.checked })
                                props.setQuickPreset('custom')
                              }}
                            />
                            <span>{t('export.option.audio')}</span>
                          </label>
                        </Show>
                        <label class="custom-checkbox">
                          <input
                            type="checkbox"
                            checked={props.customOptions().waterfall}
                            onChange={(e) => {
                              const opts = props.customOptions()
                              props.setCustomOptions({ ...opts, waterfall: e.currentTarget.checked })
                              props.setQuickPreset('custom')
                            }}
                          />
                          <span>{t('export.option.waterfall')}</span>
                        </label>
                        <label class="custom-checkbox">
                          <input
                            type="checkbox"
                            checked={props.customOptions().instrument}
                            onChange={(e) => {
                              const opts = props.customOptions()
                              props.setCustomOptions({ ...opts, instrument: e.currentTarget.checked })
                              props.setQuickPreset('custom')
                            }}
                          />
                          <span>{t('export.option.instrument')}</span>
                        </label>
                      </div>
                    </Show>
                  </section>
                </Show>

                {/* Batch Export Mode */}
                <Show when={props.mode() === 'batch'}>
                  <section class="export-section">
                    <div class="batch-header">
                      <span class="export-section-label">{t('export.batchItems')}</span>
                      <button
                        type="button"
                        class="batch-add-btn"
                        onClick={addBatchItem}
                        title={t('export.batch.add')}
                      >
                        + {t('export.batch.add')}
                      </button>
                    </div>
                    <div class="batch-items-list">
                      <For each={props.batchItems()}>
                        {(item, index) => (
                          <div class="batch-item" classList={{ 'batch-item--duplicate': isDuplicateItem(item, props.batchItems()) }}>
                            <span class="batch-item-index">{index() + 1}</span>
                            <div class="batch-item-checkboxes">
                              {/*
                                Batch items export the MIDI itself: the waterfall
                                visual (canvas-recorded video) and the offline-rendered
                                MIDI audio. Neither depends on imported video/audio
                                files, so unlike the quick-mode custom options these
                                two checkboxes are always available — gating them on
                                hasVideo()/hasAudio() would leave batch export unusable
                                in the common MIDI-only case.
                              */}
                              <label class="batch-checkbox">
                                <input
                                  type="checkbox"
                                  checked={item.video}
                                  onChange={() => toggleBatchItem(item.id, 'video')}
                                />
                                <span>{t('export.option.video')}</span>
                              </label>
                              <label class="batch-checkbox">
                                <input
                                  type="checkbox"
                                  checked={item.audio}
                                  onChange={() => toggleBatchItem(item.id, 'audio')}
                                />
                                <span>{t('export.option.audio')}</span>
                              </label>
                              <label class="batch-checkbox">
                                <input
                                  type="checkbox"
                                  checked={item.waterfall}
                                  onChange={() => toggleBatchItem(item.id, 'waterfall')}
                                />
                                <span>{t('export.option.waterfall')}</span>
                              </label>
                              <label class="batch-checkbox">
                                <input
                                  type="checkbox"
                                  checked={item.instrument}
                                  onChange={() => toggleBatchItem(item.id, 'instrument')}
                                />
                                <span>{t('export.option.instrument')}</span>
                              </label>
                            </div>
                            <button
                              type="button"
                              class="batch-item-remove"
                              onClick={() => removeBatchItem(item.id)}
                              title={t('export.batch.remove')}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </For>
                      <Show when={props.batchItems().length === 0}>
                        <div class="batch-empty">{t('export.batch.empty')}</div>
                      </Show>
                    </div>
                  </section>
                </Show>

                {/* Imported-file source options — shared, sit under the mode block */}
                <Show when={props.hasVideo() && props.output() === 'av'}>
                  <section class="export-section">
                    <label class="export-checkbox-label">
                      <input
                        type="checkbox"
                        checked={props.matchCanvasToVideo()}
                        onChange={(e) => props.setMatchCanvasToVideo(e.currentTarget.checked)}
                      />
                      <span>{t('export.matchCanvasToVideo')}</span>
                    </label>
                    <Show when={props.videoDimensions()}>
                      <div class="export-video-dims">
                        {t('export.videoDimensions', { width: props.videoDimensions()!.width, height: props.videoDimensions()!.height })}
                      </div>
                    </Show>
                  </section>
                </Show>

                <Show when={props.output() === 'audio-only'}>
                  <section class="export-section">
                    <span class="export-section-label">{t('export.formatLabel')}</span>
                    <div class="fps-group">
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.audioFormat() === 'mp3' }}
                        onClick={() => props.setAudioFormat('mp3')}
                      >
                        MP3
                      </button>
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.audioFormat() === 'wav' }}
                        onClick={() => props.setAudioFormat('wav')}
                      >
                        WAV
                      </button>
                    </div>
                  </section>
                </Show>

                {/* Preview sits at the bottom of the left column — balances the
                    two-column heights against the taller right column
                    (resolution + fps + focus/speed). */}
                <Show when={!noVideo()}>
                  <section class="export-section export-preview-section">
                    <span class="export-section-label">{t('export.preview.label')}</span>
                    <div class="export-preview-canvas">
                      <Show when={props.capturePreviewFrame() !== null}>
                        <img
                          src={props.capturePreviewFrame()!}
                          alt="Preview"
                          style="width: 100%; max-width: 320px; height: auto; border-radius: 8px; border: 1px solid var(--border); display: block"
                        />
                      </Show>
                    </div>
                    <div class="export-preview-info">
                      <span>{t('export.preview.resolution', { res: props.resolution() })}</span>
                      <span>{t('export.preview.fps', { fps: props.fps() })}</span>
                    </div>
                  </section>
                </Show>
              </div>

              {/* Right column — picture-quality settings */}
              <div class="export-col">
                <section class="export-section" classList={{ 'export-section--disabled': noVideo() }}>
                  <span class="export-section-label">{t('export.resolutionLabel')}</span>
                  <div class="res-grid res-grid--3x4">
                    <Show when={props.hasVideo()}>
                      {(() => {
                        const vp = buildVideoNativePreset(t('export.preset.videoNative'), props.videoNativeLabel())
                        return (
                          <button
                            type="button"
                            class="res-card"
                            classList={{ 'res-card--on': props.resolution() === vp.id }}
                            title={vp.hint}
                            onClick={() => props.setResolution(vp.id)}
                          >
                            <div class={`res-preview res-preview--${vp.aspect}`} aria-hidden="true" />
                            <div class="res-card-label">{vp.label}</div>
                            <div class="res-card-dim">{vp.dim}</div>
                          </button>
                        )
                      })()}
                    </Show>
                    <For each={buildPresets()}>
                      {(p) => (
                        <button
                          type="button"
                          class="res-card"
                          classList={{ 'res-card--on': props.resolution() === p.id }}
                          title={p.hint}
                          onClick={() => props.setResolution(p.id)}
                        >
                          <div class={`res-preview res-preview--${p.aspect}`} aria-hidden="true" />
                          <div class="res-card-label">{p.label}</div>
                          <div class="res-card-dim">{p.dim}</div>
                        </button>
                      )}
                    </For>
                    {/* Custom resolution option */}
                    <button
                      type="button"
                      class="res-card"
                      classList={{ 'res-card--on': props.resolution() === 'custom' }}
                      title={t('export.preset.custom.hint')}
                      onClick={() => props.setResolution('custom')}
                    >
                      <div class="res-preview res-preview--match" aria-hidden="true" />
                      <div class="res-card-label">{t('export.preset.custom')}</div>
                      <div class="res-card-dim">{t('export.preset.custom.dim')}</div>
                    </button>
                  </div>
                </section>

                <section class="export-section" classList={{ 'export-section--disabled': noVideo() }}>
                  <span class="export-section-label">{t('export.fpsLabel')}</span>
                  <div class="fps-group">
                    <Show when={props.hasVideo() && props.videoNativeFps() > 0}>
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.fps() === props.videoNativeFps() }}
                        onClick={() => props.setFps(props.videoNativeFps())}
                        title={t('export.fps.native.tip')}
                      >
                        {t('export.fps.native', { fps: Math.round(props.videoNativeFps()) })}
                      </button>
                    </Show>
                    <For each={FPS_OPTIONS}>
                      {(fps) => (
                        <button
                          type="button"
                          class="fps-btn"
                          classList={{ 'fps-btn--on': props.fps() === fps }}
                          onClick={() => props.setFps(fps)}
                        >
                          {t('export.fps.unit', { fps })}
                        </button>
                      )}
                    </For>
                  </div>
                </section>

                <Show when={isSocial()}>
                  <section class="export-section">
                    <span class="export-section-label">{t('export.focusLabel')}</span>
                    <div class="fps-group">
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.focus() === 'fit' }}
                        title={t('export.focus.fit.tip')}
                        onClick={() => props.setFocus('fit')}
                      >
                        {t('export.focus.fit')}
                      </button>
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.focus() === 'all' }}
                        title={t('export.focus.all.tip')}
                        onClick={() => props.setFocus('all')}
                      >
                        {t('export.focus.all')}
                      </button>
                    </div>
                  </section>

                  <section class="export-section">
                    <span class="export-section-label">{t('export.speedLabel')}</span>
                    <div class="fps-group">
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.speed() === 'compact' }}
                        title={t('export.speed.compact.tip')}
                        onClick={() => props.setSpeed('compact')}
                      >
                        {t('export.speed.compact')}
                      </button>
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.speed() === 'standard' }}
                        title={t('export.speed.standard.tip')}
                        onClick={() => props.setSpeed('standard')}
                      >
                        {t('export.speed.standard')}
                      </button>
                      <button
                        type="button"
                        class="fps-btn"
                        classList={{ 'fps-btn--on': props.speed() === 'drama' }}
                        title={t('export.speed.drama.tip')}
                        onClick={() => props.setSpeed('drama')}
                      >
                        {t('export.speed.drama')}
                      </button>
                    </div>
                  </section>
                </Show>
              </div>
            </div>

            <div class="export-actions">
              <button type="button" class="modal-btn" onClick={() => props.onDismiss()}>
                {t('export.cancel')}
              </button>
              <button
                type="button"
                class="modal-btn modal-btn--accent"
                onClick={() => props.onStart()}
              >
                <span innerHTML={icons.exportArrow()} />
                <span>{t('export.action')}</span>
              </button>
            </div>
          </div>

          <div
            class="export-phase"
            classList={{
              hidden: props.phase() !== 'progress',
              indeterminate: props.indeterminate(),
            }}
          >
            <div class="export-spinner"></div>
            <div class="export-stage">{props.stage()}</div>
            <div class="export-progress-wrap">
              <div
                class="export-progress-bar"
                style={{ width: props.indeterminate() ? '' : `${Math.round(props.pct() * 100)}%` }}
              />
            </div>
            <div class="export-pct">
              {props.indeterminate() ? '' : `${Math.round(props.pct() * 100)}%`}
            </div>
            <button type="button" class="modal-btn" onClick={() => props.onCancelProgress()}>
              {t('export.cancel')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
/**
 * Detect if the browser supports HEVC/H.265 hardware encoding.
 */
async function detectHEVCSupport(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  const hevcCodecs = [
    'hev1.1.6.L93.B0',
    'hev1.1.6.L63.B0',
    'hvc1.1.6.L93.B0',
  ]
  for (const codec of hevcCodecs) {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec,
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 30,
        hardwareAcceleration: 'prefer-hardware',
      })
      if (result.supported) return true
    } catch {
      // Codec not supported, try next
    }
  }
  return false
}

export class ExportModal {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  private readonly setIsOpen: (v: boolean) => void
  private readonly readIsOpen: () => boolean
  private readonly setPhase: (v: Phase) => void
  private readonly readPhase: () => Phase
  private readonly setFps: (v: number) => void
  private readonly readFps: () => number
  private readonly setResolution: (v: ExportResolution) => void
  private readonly readResolution: () => ExportResolution
  private readonly setOutput: (v: ExportOutput) => void
  private readonly readOutput: () => ExportOutput
  private readonly setAudioFormat: (v: ExportAudioFormat) => void
  private readonly readAudioFormat: () => ExportAudioFormat
  private readonly setFocus: (v: ExportFocus) => void
  private readonly readFocus: () => ExportFocus
  private readonly setSpeed: (v: ExportSpeed) => void
  private readonly readSpeed: () => ExportSpeed
  private readonly setStage: (v: string) => void
  private readonly setPct: (v: number) => void
  private readonly setIndet: (v: boolean) => void
  private readonly setHasVideo: (v: boolean) => void
  private readonly readHasVideo: () => boolean
  private readonly setHasAudio: (v: boolean) => void
  private readonly readHasAudio: () => boolean
  private readonly setMatchCanvasToVideo: (v: boolean) => void
  private readonly readMatchCanvasToVideo: () => boolean
  private readonly setCodec: (v: 'h264' | 'h265') => void
  private readonly readCodec: () => 'h264' | 'h265'
  private readonly setHevcSupported: (v: boolean) => void
  private readonly readHevcSupported: () => boolean
  private readonly setVideoDimensions: (v: { width: number; height: number } | null) => void
  private readonly readVideoDimensions: () => { width: number; height: number } | null
  private readonly setVideoNativeFps: (v: number) => void
  private readonly readVideoNativeFps: () => number
  private readonly setVideoNativeLabel: (v: string) => void
  private readonly readVideoNativeLabel: () => string
  private readonly setPreviewFrame: (v: string | null) => void
  private readonly readPreviewFrame: () => string | null
  private readonly setMode: (v: ExportMode) => void
  private readonly readMode: () => ExportMode
  private readonly setQuickPreset: (v: QuickPreset | 'custom') => void
  private readonly readQuickPreset: () => QuickPreset | 'custom'
  private readonly setCustomOptions: (v: ExportCustomOptions) => void
  private readonly readCustomOptions: () => ExportCustomOptions
  private readonly setCustomExpanded: (v: boolean) => void
  private readonly readCustomExpanded: () => boolean
  private readonly setBatchItems: (v: ExportBatchItem[]) => void
  private readonly readBatchItems: () => ExportBatchItem[]

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.readIsOpen()) return
    if (this.readPhase() !== 'settings') return
    this.close()
  }

  onStart?: (settings: ExportSettings) => void
  onCancel?: () => void

  setPreviewFrameCallback(callback: () => string | null): void {
    this.setPreviewFrame(callback());
  }

  private renderAudioProgressDeterminate: boolean | null = null

  constructor(container: HTMLElement) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [phase, setPhase] = createSignal<Phase>('settings')
    const [fps, setFps] = createSignal(30)
    const [resolution, setResolution] = createSignal<ExportResolution>('1080p')
    const [output, setOutput] = createSignal<ExportOutput>('av')
    const [audioFormat, setAudioFormat] = createSignal<ExportAudioFormat>('mp3')
    const [focus, setFocus] = createSignal<ExportFocus>('fit')
    const [speed, setSpeed] = createSignal<ExportSpeed>('drama')
    const [stage, setStage] = createSignal(t('export.preparing'))
    const [pct, setPct] = createSignal(0)
    const [indeterminate, setIndet] = createSignal(false)
    const [hasVideo, setHasVideo] = createSignal(false)
    const [hasAudio, setHasAudio] = createSignal(false)
    const [matchCanvasToVideo, setMatchCanvasToVideo] = createSignal(false)
    const [codec, setCodec] = createSignal<'h264' | 'h265'>('h264')
    const [hevcSupported, setHevcSupported] = createSignal(false)
    detectHEVCSupport().then(setHevcSupported)
    const [videoDimensions, setVideoDimensions] = createSignal<{ width: number; height: number } | null>(null)
    const [videoNativeFps, setVideoNativeFps] = createSignal(0)
    const [videoNativeLabel, setVideoNativeLabel] = createSignal('')
    const [previewFrame, setPreviewFrame] = createSignal<string | null>(null)
    const [mode, setMode] = createSignal<ExportMode>('quick')
    const [quickPreset, setQuickPreset] = createSignal<QuickPreset | 'custom'>('mixed')
    const [customOptions, setCustomOptions] = createSignal<ExportCustomOptions>({ video: true, audio: true, waterfall: true, instrument: true })
    const [customExpanded, setCustomExpanded] = createSignal(false)
    const [batchItems, setBatchItems] = createSignal<ExportBatchItem[]>([])

    this.setIsOpen = setIsOpen
    this.readIsOpen = isOpen
    this.setPhase = setPhase
    this.readPhase = phase
    this.setFps = setFps
    this.readFps = fps
    this.setResolution = setResolution
    this.readResolution = resolution
    this.setOutput = setOutput
    this.readOutput = output
    this.setAudioFormat = setAudioFormat
    this.readAudioFormat = audioFormat
    this.setFocus = setFocus
    this.readFocus = focus
    this.setSpeed = setSpeed
    this.readSpeed = speed
    this.setStage = setStage
    this.setPct = setPct
    this.setIndet = setIndet
    this.setHasVideo = setHasVideo
    this.readHasVideo = hasVideo
    this.setHasAudio = setHasAudio
    this.readHasAudio = hasAudio
    this.setMatchCanvasToVideo = setMatchCanvasToVideo
    this.readMatchCanvasToVideo = matchCanvasToVideo
    this.setCodec = codec
    this.readCodec = codec
    this.setHevcSupported = hevcSupported
    this.readHevcSupported = hevcSupported
    this.setVideoDimensions = setVideoDimensions
    this.readVideoDimensions = videoDimensions
    this.setVideoNativeFps = setVideoNativeFps
    this.readVideoNativeFps = videoNativeFps
    this.setVideoNativeLabel = setVideoNativeLabel
    this.readVideoNativeLabel = videoNativeLabel
    this.setPreviewFrame = setPreviewFrame
    this.readPreviewFrame = previewFrame
    this.setMode = setMode
    this.readMode = mode
    this.setQuickPreset = setQuickPreset
    this.readQuickPreset = quickPreset
    this.setCustomOptions = setCustomOptions
    this.readCustomOptions = customOptions
    this.setCustomExpanded = setCustomExpanded
    this.readCustomExpanded = customExpanded
    this.setBatchItems = setBatchItems
    this.readBatchItems = batchItems

    const wrapper = document.createElement('div')
    wrapper.style.display = 'contents'
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.disposeRoot = render(
      () => (
        <ExportView
          container={container}
          isOpen={isOpen}
          phase={phase}
          fps={fps}
          setFps={(v) => this.setFps(v)}
          resolution={resolution}
          setResolution={(v) => {
            this.setResolution(v)
            this.applyResolutionDefaults()
          }}
          output={output}
          setOutput={(v) => {
            this.setOutput(v)
            this.applyResolutionDefaults()
          }}
          audioFormat={audioFormat}
          setAudioFormat={(v) => this.setAudioFormat(v)}
          focus={focus}
          setFocus={(v) => this.setFocus(v)}
          speed={speed}
          setSpeed={(v) => this.setSpeed(v)}
          stage={stage}
          pct={pct}
          indeterminate={indeterminate}
          hasVideo={hasVideo}
          hasAudio={hasAudio}
          matchCanvasToVideo={matchCanvasToVideo}
          setMatchCanvasToVideo={(v) => this.setMatchCanvasToVideo(v)}
          setCodec={(v) => this.setCodec(v)}
          readCodec={() => this.readCodec()}
          hevcSupported={() => this.readHevcSupported()}
          videoDimensions={videoDimensions}
          videoNativeFps={videoNativeFps}
          videoNativeLabel={videoNativeLabel}
          capturePreviewFrame={previewFrame}
          mode={mode}
          setMode={(v) => this.setMode(v)}
          quickPreset={quickPreset}
          setQuickPreset={(v) => this.setQuickPreset(v)}
          customOptions={customOptions}
          setCustomOptions={(v) => this.setCustomOptions(v)}
          customExpanded={customExpanded}
          setCustomExpanded={(v) => this.setCustomExpanded(v)}
          batchItems={batchItems}
          setBatchItems={(v) => this.setBatchItems(v)}
          onDismiss={() => this.close()}
          onStart={() => {
            this.setPhase('progress')
            this.onStart?.({
              fps: this.readFps(),
              resolution: this.readResolution(),
              output: this.readOutput(),
              audioFormat: this.readAudioFormat(),
              focus: this.readFocus(),
              speed: this.readSpeed(),
              matchCanvasToVideo: this.readMatchCanvasToVideo(),
              codec: this.readCodec(),
              mode: this.readMode(),
              customOptions: this.readCustomOptions(),
              batchItems: this.readBatchItems(),
            })
          }}
          onCancelProgress={() => this.onCancel?.()}
        />
      ),
      wrapper,
    )

    document.addEventListener('keydown', this.onKey)
  }

  setVideoInfo(info: { width: number; height: number; fps: number } | null): void {
    if (info && info.width > 0) {
      this.setHasVideo(true)
      this.setVideoNativeFps(info.fps)
      this.setVideoNativeLabel(`${info.width} × ${info.height}`)
      this.setVideoDimensions({ width: info.width, height: info.height })
    } else {
      this.setHasVideo(false)
      this.setVideoNativeFps(0)
      this.setVideoNativeLabel('')
      this.setVideoDimensions(null)
    }
  }

  setAudioInfo(hasAudio: boolean): void {
    this.setHasAudio(hasAudio)
  }

  open(): void {
    this.renderAudioProgressDeterminate = null
    this.setPhase('settings')
    this.setPct(0)
    this.setIndet(false)
    this.setStage(t('export.preparing'))
    this.setIsOpen(true)
  }

  close(): void {
    this.setIsOpen(false)
  }

  setRenderAudioProgressMode(determinate: boolean): void {
    this.renderAudioProgressDeterminate = determinate
    this.setIndet(!determinate)
    if (determinate) this.setPct(0)
  }

  updateProgress(stage: ExportStage, pct: number): void {
    this.setStage(`${stageLabel(stage)}—${Math.round(pct * 100)}%`)
    if (stage === 'Rendering audio') {
      if (this.renderAudioProgressDeterminate === true) {
        this.setIndet(false)
        this.setPct(pct)
        return
      }
      this.setIndet(true)
      this.setPct(0)
      return
    }
    this.setIndet(false)
    this.setPct(pct)
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey)
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }

  private applyResolutionDefaults(): void {
    // placeholder for future defaults
  }
}

function stageLabel(stage: ExportStage): string {
  switch (stage) {
    case 'Preparing video': return t('export.stage.preparingVideo')
    case 'Rendering audio': return t('export.stage.renderingAudio')
    case 'Encoding audio': return t('export.stage.encodingAudio')
    case 'Encoding': return t('export.stage.encoding')
    case 'Finalizing': return t('export.stage.finalizing')
    case 'Saving': return t('export.stage.saving')
    case 'Done': return t('export.stage.done')
    default: return ''
  }
}
