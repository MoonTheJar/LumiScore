// Unified file picker modal: supports both MIDI and audio/video imports.
// Mode determines accepted file types and whether to show SamplesGrid.

import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js'
import { Portal, render } from 'solid-js/web'
import { t } from '../i18n'
import { icons } from './icons'
import { SamplesGrid } from './SamplesGrid'
import {
  detectSystemFFmpeg,
  detectWasmFFmpeg,
  detectCloudFFmpeg,
  detectBrowserDecoder,
  detectMidiDecoder,
  detectMuseScore,
  type DecoderInfo,
} from '../services/DecoderDetect'

export type PickerMode = 'midi' | 'media' | 'lyrics'
export type ProgressFn = (percent: number, status?: string) => void

interface OpenOpts {
  mode: PickerMode
  onFile: (file: File, progress: ProgressFn) => void | Promise<void>
  onSample?: (sampleId: string) => void
  onCancel?: () => void
}

interface ViewProps {
  container: HTMLElement
  isOpen: () => boolean
  mode: () => PickerMode
  onFile: (file: File, progress: ProgressFn) => void | Promise<void>
  onSample: (id: string) => void
  onClose: () => void
}

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

function isMuseScoreFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mscz') || lower.endsWith('.mscx') ||
    lower.endsWith('.xml') || lower.endsWith('.musicxml')
}

function isMediaFile(name: string, type: string): boolean {
  if (type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('image/')) return true
  const lower = name.toLowerCase()
  const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']
  const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.apng']
  return videoExts.some(ext => lower.endsWith(ext)) ||
    audioExts.some(ext => lower.endsWith(ext)) ||
    imageExts.some(ext => lower.endsWith(ext))
}

function isLyricsFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.lrc') || lower.endsWith('.srt') || lower.endsWith('.txt')
}

interface DecoderPanelProps {
  decoders: () => DecoderInfo[]
  loading: () => boolean
  expanded: () => boolean
  setExpanded: (v: boolean) => void
}

function DecoderStatusPanel(props: DecoderPanelProps) {
  const statusIcon = (status: string): string => {
    if (status === 'available') return '\u2713'
    if (status === 'checking') return '\u2022'
    if (status === 'decoding') return '\u25b6'
    return '\u2717'
  }

  return (
    <div class="decoder-status-panel">
      <button
        type="button"
        class="decoder-status-toggle"
        onClick={() => props.setExpanded(!props.expanded())}
      >
        <span>{props.expanded() ? '\u25be' : '\u25b8'} \u89e3\u7801\u5668</span>
        <span class="decoder-status-summary">
          {props.loading() ? '\u68c0\u6d4b\u4e2d...' : `${props.decoders().filter(d => d.status === 'available' || d.status === 'decoding').length}/${props.decoders().length} \u53ef\u7528`}
        </span>
      </button>
      <Show when={props.expanded()}>
        <div class="decoder-status-list">
          <For each={props.decoders()}>
            {(decoder) => (
              <div class={`decoder-status-item decoder-status-${decoder.status}`}>
                <span class="decoder-status-icon">{statusIcon(decoder.status)}</span>
                <div class="decoder-status-info">
                  <span class="decoder-status-name">{decoder.name}</span>
                  {decoder.detail ? <span class="decoder-status-detail">{decoder.detail}</span> : null}
                </div>
                {decoder.status === 'decoding' && decoder.progress != null ? (
                  <span class="decoder-status-progress">{decoder.progress}%</span>
                ) : null}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function PickerModalView(props: ViewProps) {
  let inputEl!: HTMLInputElement
  let samplesModalHost!: HTMLDivElement
  const [dragOver, setDragOver] = createSignal(false)
  const [showSamples, setShowSamples] = createSignal(false)
  const [processing, setProcessing] = createSignal(false)
  const [decoders, setDecoders] = createSignal<DecoderInfo[]>([])
  const [loading, setLoading] = createSignal(true)
  const [expanded, setExpanded] = createSignal(false)
  const [lastMode, setLastMode] = createSignal<PickerMode | null>(null)

  // React to mode changes AND modal open
  createEffect(() => {
    const mode = props.mode()
    const isOpen = props.isOpen()
    if (!isOpen) return
    if (mode === lastMode()) return
    setLastMode(mode)
    setLoading(true)
    setDecoders([])

    if (mode === 'media') {
      Promise.all([
        detectSystemFFmpeg().catch((): DecoderInfo => ({
          name: '\u7cfb\u7edf FFmpeg (Node)', status: 'unavailable', detail: '\u68c0\u6d4b\u5931\u8d25',
        })),
        detectWasmFFmpeg().catch((): DecoderInfo => ({
          name: '\u6d4f\u89c8\u5668 FFmpeg (WASM)', status: 'unavailable', detail: '\u68c0\u6d4b\u5931\u8d25',
        })),
        detectCloudFFmpeg().catch((): DecoderInfo => ({
          name: '\u4e91\u7aef FFmpeg', status: 'unavailable', detail: '\u68c0\u6d4b\u5931\u8d25',
        })),
        detectBrowserDecoder().catch((): DecoderInfo => ({
          name: '\u6d4f\u89c8\u5668\u89e3\u7801\u5668 (WebCodecs)', status: 'unavailable', detail: '\u68c0\u6d4b\u5931\u8d25',
        })),
      ]).then((results) => {
        setDecoders(results)
        setLoading(false)
      })
    } else if (mode === 'lyrics') {
      // No decoder probing for lyrics — text files parse instantly.
      setDecoders([])
      setLoading(false)
    } else {
      Promise.all([
        detectMidiDecoder().catch((): DecoderInfo => ({
          name: 'MIDI \u89e3\u6790\u5668', status: 'unavailable', detail: '\u68c0\u6d4b\u5931\u8d25',
        })),
        detectMuseScore().catch((): DecoderInfo => ({
          name: 'MuseScore (\u672c\u5730)', status: 'unavailable', detail: '\u68c0\u6d4b\u5931\u8d25',
        })),
      ]).then((results) => {
        setDecoders(results)
        setLoading(false)
      })
    }
  })

  let samplesModal: SamplesGrid | null = null
  onCleanup(() => {
    samplesModal?.dispose()
    samplesModal = null
  })

  const openSamplesModal = (): void => {
    setShowSamples(true)
    // Mount SamplesGrid into the modal host after the Show renders
    queueMicrotask(() => {
      if (samplesModalHost && !samplesModal) {
        samplesModal = new SamplesGrid()
        samplesModal.onSelect = (id) => { setShowSamples(false); props.onSample(id) }
        samplesModalHost.appendChild(samplesModal.root)
      }
    })
  }
  const closeSamplesModal = (): void => {
    setShowSamples(false)
    samplesModal?.dispose()
    samplesModal = null
    if (samplesModalHost) samplesModalHost.innerHTML = ''
  }

  const processFile = async (file: File): Promise<void> => {
    if (processing()) return
    setProcessing(true)

    // Mark the first available decoder as "decoding"
    setDecoders(prev => {
      const idx = prev.findIndex(d => d.status === 'available')
      if (idx < 0) return prev
      return prev.map((d, i) => i === idx ? { ...d, status: 'decoding' as const, progress: 0, detail: '\u89e3\u7801\u4e2d...' } : d)
    })

    const progressFn: ProgressFn = (percent, status) => {
      setDecoders(prev => prev.map(d =>
        d.status === 'decoding'
          ? { ...d, progress: percent, ...(status ? { detail: status } : {}) }
          : d
      ))
    }

    try {
      await props.onFile(file, progressFn)
    } catch (err) {
      console.error('File processing failed:', err)
    } finally {
      setProcessing(false)
      props.onClose()
    }
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const mode = props.mode()
    if (mode === 'midi' && (isMidiFile(file.name) || isMuseScoreFile(file.name))) {
      void processFile(file)
    } else if (mode === 'media' && isMediaFile(file.name, file.type)) {
      void processFile(file)
    } else if (mode === 'lyrics' && isLyricsFile(file.name)) {
      void processFile(file)
    }
  }

  const onDragEnter = (e: DragEvent): void => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    setDragOver(true)
  }

  const onDragLeave = (e: DragEvent): void => {
    if (e.currentTarget === e.target) setDragOver(false)
  }

  const onDragOver = (e: DragEvent): void => {
    e.preventDefault()
  }

  const title = (): string => {
    if (props.mode() === 'midi') return t('midiPicker.title')
    if (props.mode() === 'media') return t('midiPicker.mediaTitle')
    return t('midiPicker.lyricsTitle')
  }
  const subtitle = (): string => {
    if (props.mode() === 'midi') return t('midiPicker.sub')
    if (props.mode() === 'media') return t('midiPicker.mediaSub')
    return t('midiPicker.lyricsSub')
  }
  const dropTitle = (): string => {
    if (props.mode() === 'midi') return t('midiPicker.dropTitle')
    if (props.mode() === 'media') return t('midiPicker.mediaDropTitle')
    return t('midiPicker.lyricsDropTitle')
  }
  const dropSub = (): string => {
    if (props.mode() === 'midi') return t('midiPicker.dropSub')
    if (props.mode() === 'media') return t('midiPicker.mediaDropSub')
    return t('midiPicker.lyricsDropSub')
  }
  const accept = (): string => {
    if (props.mode() === 'midi') return '.mid,.midi,.mscz,.mscx,.xml,.musicxml'
    if (props.mode() === 'media') return 'video/*,audio/*,image/*,.gif,.svg'
    return '.lrc,.srt,.txt'
  }

  return (
    <Portal mount={props.container}>
      <div
        id="midi-picker-modal"
        classList={{ open: props.isOpen() }}
        onClick={(e) => {
          if (e.target === e.currentTarget && props.isOpen() && !processing()) props.onClose()
        }}
      >
        <div
          class="midi-picker-card"
          role="dialog"
          aria-label={title()}
          aria-hidden={!props.isOpen()}
        >
          <header class="midi-picker-head">
            <div>
              <h2 class="midi-picker-title">{title()}</h2>
              <p class="midi-picker-sub">{subtitle()}</p>
            </div>
            <button
              type="button"
              class="midi-picker-close"
              aria-label={t('midiPicker.close')}
              onClick={() => !processing() && props.onClose()}
              innerHTML={icons.close(14)}
            />
          </header>

          <button
            type="button"
            class="midi-picker-drop"
            classList={{ 'drag-over': dragOver() }}
            onClick={() => inputEl.click()}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
            disabled={processing()}
          >
            <span class="midi-picker-drop-icon" innerHTML={icons.upload(20)} />
            <span class="midi-picker-drop-title">{processing() ? '\u5904\u7406\u4e2d...' : dropTitle()}</span>
            <span class="midi-picker-drop-sub">{dropSub()}</span>
          </button>

          <Show when={props.mode() !== 'lyrics'}>
            <DecoderStatusPanel
              decoders={decoders}
              loading={loading}
              expanded={expanded}
              setExpanded={setExpanded}
            />
          </Show>

          <Show when={props.mode() === 'midi'}>
            <button type="button" class="midi-picker-samples-btn" onClick={openSamplesModal}>
              <span innerHTML={icons.sparkles(14)} />
              {t('midiPicker.samplesLabel')}
            </button>
          </Show>

          {/* Samples modal portal */}
          <Show when={showSamples()}>
            <Portal mount={props.container}>
              <div class="midi-picker-samples-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) closeSamplesModal() }}>
                <div class="midi-picker-samples-modal" role="dialog" aria-label={t('midiPicker.samplesLabel')}>
                  <header class="midi-picker-samples-modal-head">
                    <h3>{t('midiPicker.samplesLabel')}</h3>
                    <button type="button" class="midi-picker-close" aria-label={t('midiPicker.close')} onClick={closeSamplesModal} innerHTML={icons.close(14)} />
                  </header>
                  <div class="midi-picker-samples-modal-body" ref={samplesModalHost} />
                </div>
              </div>
            </Portal>
          </Show>

          <input
            type="file"
            ref={inputEl}
            accept={accept()}
            style={{ display: 'none' }}
            onChange={() => {
              const file = inputEl.files?.[0]
              if (!file) return
              const mode = props.mode()
              if (mode === 'midi' && (isMidiFile(file.name) || isMuseScoreFile(file.name))) {
                void processFile(file)
              } else if (mode === 'media' && isMediaFile(file.name, file.type)) {
                void processFile(file)
              } else if (mode === 'lyrics' && isLyricsFile(file.name)) {
                void processFile(file)
              }
              inputEl.value = ''
            }}
          />
        </div>
      </div>
    </Portal>
  )
}

export class MidiPickerModal {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null
  private readonly setIsOpen: (v: boolean) => void
  private readonly readIsOpen: () => boolean
  private readonly setMode: (v: PickerMode) => void
  private readonly readMode: () => PickerMode
  private currentOpts: OpenOpts | null = null

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (!this.readIsOpen()) return
    e.stopPropagation()
    this.cancel()
  }

  constructor(container: HTMLElement) {
    const [isOpen, setIsOpen] = createSignal(false)
    const [mode, setMode] = createSignal<PickerMode>('midi')
    this.setIsOpen = setIsOpen
    this.readIsOpen = isOpen
    this.setMode = setMode
    this.readMode = mode

    const wrapper = document.createElement('div')
    wrapper.style.display = 'contents'
    container.appendChild(wrapper)
    this.wrapper = wrapper

    this.disposeRoot = render(
      () => (
        <PickerModalView
          container={container}
          isOpen={isOpen}
          mode={mode}
          onFile={(f, p) => this.handleFile(f, p)}
          onSample={(id) => this.handleSample(id)}
          onClose={() => this.cancel()}
        />
      ),
      wrapper,
    )
    document.addEventListener('keydown', this.onKey)
  }

  open(opts: OpenOpts): void {
    this.currentOpts = opts
    this.setMode(opts.mode)
    this.setIsOpen(true)
  }

  close(): void {
    this.setIsOpen(false)
    this.currentOpts = null
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey)
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }

  private cancel(): void {
    const cb = this.currentOpts?.onCancel
    this.close()
    cb?.()
  }

  private async handleFile(file: File, progress: ProgressFn): Promise<void> {
    const opts = this.currentOpts
    if (!opts) return
    await opts.onFile(file, progress)
  }

  private handleSample(id: string): void {
    const opts = this.currentOpts
    if (!opts?.onSample) return
    this.close()
    opts.onSample(id)
  }
}

