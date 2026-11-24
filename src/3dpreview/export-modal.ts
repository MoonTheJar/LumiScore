// 最后一页「导出」弹窗：左右分栏。
//   左栏：导出类型（视频 / 图片 / 模型 / 工程文件）+ 简介 + 实时预览缩略图。
//   右栏：格式下拉 + 导出内容/参数；底部「取消 / 导出」。
// 本模块只负责 UI 与选项收集，真正的导出逻辑由 main.ts 通过 ExportApi 注入。
// 视觉复用 shell 的 CSS 变量（--sh-*）与基础类（sh-modal / sh-btn）。
import { buildExportShell, h } from '../shell/export-shell'
import { t } from '../shell/i18n'
import { createSelect } from '../shell/select'
import { ASPECT_RATIOS } from './aspect-ratio'

export type ModelFormat = 'glb' | 'obj' | 'stl'
export type VideoFps = 24 | 30 | 60
export type VideoQuality = '720p' | '1080p' | '1440p' | '2160p'
export type ExportKind = 'video' | 'model' | 'image' | 'project'

/** 工程文件导出：勾选要打进 zip 的内容 */
export interface ProjectExportOpts {
  /** 用户原始 MIDI（仅当导入时带原始 MIDI 才存在） */
  includeOrigMidi: boolean
  /** 标准 MIDI（由 MusicXML 转换而来） */
  includeMidi: boolean
  /** MusicXML 乐谱 */
  includeXml: boolean
  /** 各页配置的 md 说明 */
  includeConfig: boolean
  /** 本机偏好 + 3D 场景设置 */
  includePrefs: boolean
  /** 已下载资源清单（重下链接） */
  includeResources: boolean
}

/** 图片导出：以 96 DPI 为基准倍率，DPI 越高输出像素越大（96→1×，192→2×，384→4×） */
export interface ImageExportOpts {
  dpi: number
  /** 画面比例：source = 跟随当前画布；其余 = 按比例居中裁掉两边（与视频同一口径） */
  ratio: string
}

export interface ModelExportOpts {
  format: ModelFormat
  includeModel: boolean // 白膜（谱面挤出体）
  includePaths: boolean // 小球轨迹路径
  includeBalls: boolean // 小球运动关键帧（动画）
  includeTrails: boolean // 拖尾（沿轨迹烘成锥形"彗尾"管，静态）
}
export type VideoBitrateTier = 'low' | 'mid' | 'high'
export interface VideoExportOpts {
  format: 'mp4'
  fps: VideoFps
  quality: VideoQuality
  includeAudio: boolean
  /** 画面比例：source = 跟随当前画布；其余 = 按该比例居中裁掉两边（与顶栏辅助线同一口径） */
  ratio: string
  /** 码率档：低 / 中 / 高（中 = 原自动值） */
  bitrateTier: VideoBitrateTier
}
export type ExportStage =
  | 'preparing'
  | 'audio'
  | 'video'
  | 'finalizing'
  | 'done'

/** 导出进度回调：stage 当前阶段；pct 该阶段内进度 0..1；note 可显示在进度条下 */
export type ExportProgress = (stage: ExportStage, pct: number, note?: string) => void

export interface ExportApi {
  /** 是否有可导出的乐谱（无乐谱时禁用导出） */
  hasScore(): boolean
  /** 用当前 3D 画布生成一张预览图（dataURL）；失败返回 null */
  captureThumbnail(): string | null
  exportModel(opts: ModelExportOpts, onProgress: ExportProgress): Promise<void>
  exportVideo(opts: VideoExportOpts, onProgress: ExportProgress, isCancelled: () => boolean): Promise<void>
  exportImage(opts: ImageExportOpts, onProgress: ExportProgress): Promise<void>
  /** 导出工程 zip：MIDI / MusicXML / 各页配置说明 */
  exportProject(opts: ProjectExportOpts, onProgress: ExportProgress): Promise<void>
}

// 各模型格式对「导出内容」的支持矩阵（用户口径：模型不支持贴图）。
// 文案存 key，渲染时再 t()：模块常量在 import 时就固化了，切语言不会重算。
const MODEL_CAPS: Record<
  ModelFormat,
  { label: string; model: boolean; paths: boolean; balls: boolean; trails: boolean; hint: string }
> = {
  glb: {
    label: 'ex.fmt.glb',
    model: true,
    paths: true,
    balls: true,
    trails: true,
    hint: 'ex.fmt.glb.hint',
  },
  obj: {
    label: 'ex.fmt.obj',
    model: true,
    paths: true,
    balls: false,
    trails: true,
    hint: 'ex.fmt.obj.hint',
  },
  stl: {
    label: 'ex.fmt.stl',
    model: true,
    paths: false,
    balls: false,
    trails: false,
    hint: 'ex.fmt.stl.hint',
  },
}

let modal: HTMLElement | null = null
// 上一个弹窗里可能还有导出在跑：DOM 被摘掉之后循环并不会停，它继续占着 renderer /
// exportHold，而且「取消」按钮已经不在页面上，用户只能看着两路导出抢同一个渲染器。
// 所以在重建之前先叫停它。
let abortRunning: (() => void) | null = null

export function openExportModal(api: ExportApi): void {
  // 每次打开都新建：彻底重建状态，避免上次导出异常后按钮 disabled/进度残留导致“有概率失效”
  if (modal) {
    abortRunning?.()
    abortRunning = null
    modal.remove()
    modal = null
  }
  modal = buildModal(api)
  document.body.append(modal)
}

function buildModal(api: ExportApi): HTMLElement {
  const state: {
    kind: ExportKind
    model: ModelExportOpts
    video: VideoExportOpts
    image: ImageExportOpts
    project: ProjectExportOpts
    exporting: boolean
  } = {
    kind: 'video',
    model: {
      format: 'glb',
      includeModel: true,
      includePaths: true,
      includeBalls: true,
      includeTrails: false,
    },
    video: { format: 'mp4', fps: 30, quality: '1080p', includeAudio: true, ratio: 'source', bitrateTier: 'mid' },
    image: { dpi: 192, ratio: 'source' },
    project: { includeOrigMidi: true, includeMidi: true, includeXml: true, includeConfig: true, includePrefs: true, includeResources: true },
    exporting: false,
  }

  const { wrap, body, closeBtn, cancelBtn, exportBtn, progWrap, progFill, progNote } = buildExportShell()

  // ── 左栏：类型切换 + 简介 + 预览 ──
  const left = h('div', 'ex-left')
  const kindLabel = h('div', 'ex-sec-label')
  kindLabel.textContent = t('ex.options')
  const kindList = h('div', 'ex-kinds')
  const kindDefs: Array<{ id: ExportKind; nameKey: string; icon: string }> = [
    { id: 'video', nameKey: 'ex.kind.video', icon: ICON_VIDEO },
    { id: 'image', nameKey: 'ex.kind.image', icon: ICON_IMAGE },
    { id: 'model', nameKey: 'ex.kind.model', icon: ICON_MODEL },
    { id: 'project', nameKey: 'ex.kind.project', icon: ICON_PROJECT },
  ]
  const kindButtons = new Map<ExportKind, HTMLButtonElement>()
  for (const k of kindDefs) {
    const b = h('button', 'ex-kind')
    b.type = 'button'
    b.innerHTML = `<span class="ex-kind__icon">${k.icon}</span><span>${t(k.nameKey)}</span>`
    b.addEventListener('click', () => {
      if (state.exporting) return
      state.kind = k.id
      syncKind()
      syncRight()
    })
    kindList.append(b)
    kindButtons.set(k.id, b)
  }

  const descLabel = h('div', 'ex-sec-label')
  descLabel.textContent = t('ex.about')
  const desc = h('div', 'ex-desc')
  const prevLabel = h('div', 'ex-sec-label')
  prevLabel.textContent = t('ex.preview')
  const prevBox = h('div', 'ex-preview')
  const prevImg = h('img', 'ex-preview__img') as HTMLImageElement
  prevImg.alt = ''
  const prevPlaceholder = h('div', 'ex-preview__ph')
  prevPlaceholder.textContent = t('ex.noPreview')
  prevBox.append(prevImg, prevPlaceholder)
  left.append(kindLabel, kindList, descLabel, desc, prevLabel, prevBox)

  // ── 右栏：设置（每次切换类型/格式重建） ──
  const right = h('div', 'ex-right')

  body.append(left, right)

  // ── 交互逻辑 ──
  let cancelled = false
  // 成功收尾标记：自动关窗只认它，不认提示文案（文案会随语言变，也不该当状态用）
  let finished = false
  let autoClose = 0
  abortRunning = () => { cancelled = true }
  function close(): void {
    if (state.exporting) return
    clearTimeout(autoClose)
    // 只在自己还是「当前弹窗」时才交还全局引用：否则旧弹窗那个 1.2s 定时器
    // 会把新开的弹窗一起关掉 / 把 modal 置空，第三次打开就叠出两层
    if (modal === wrap) {
      modal = null
      abortRunning = null
    }
    wrap.remove()
  }
  closeBtn.addEventListener('click', close)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
  cancelBtn.addEventListener('click', () => {
    if (state.exporting) {
      cancelled = true // 导出中：取消导出
      return
    }
    close()
  })

  function syncKind(): void {
    for (const [id, b] of kindButtons)
      b.classList.toggle('ex-kind--on', id === state.kind)
    desc.textContent = t(
      state.kind === 'video'
        ? 'ex.videoDesc'
        : state.kind === 'image'
          ? 'ex.imageDesc'
          : state.kind === 'project'
            ? 'ex.projectDesc'
            : 'ex.modelDesc',
    )
  }

  function setExporting(on: boolean): void {
    state.exporting = on
    exportBtn.disabled = on
    cancelBtn.disabled = false
    cancelBtn.textContent = on ? t('ex.cancelExport') : t('confirm.cancel')
    progWrap.hidden = !on
    right.classList.toggle('ex-right--busy', on)
    if (!on) {
      progFill.style.width = '0%'
      progNote.textContent = ''
    }
  }

  const onProgress: ExportProgress = (stage, pct, note) => {
    const p = Math.round(Math.max(0, Math.min(1, pct)) * 100)
    progFill.style.width = `${p}%`
    const label = t(`ex.stage.${stage}`)
    progNote.textContent = note
      ? t('ex.progressNote', { stage: label, pct: p, note })
      : t('ex.progress', { stage: label, pct: p })
  }

  exportBtn.addEventListener('click', async () => {
    if (state.exporting) return
    if (!api.hasScore()) {
      showNote(t('ex.noScore'))
      return
    }
    cancelled = false
    finished = false
    clearTimeout(autoClose) // 上一次导出残留的自动关窗别把这次的结果窗口关掉
    setExporting(true)
    try {
      if (state.kind === 'model') {
        onProgress('preparing', 0.02, t('ex.gatherModel'))
        await api.exportModel(state.model, onProgress)
      } else if (state.kind === 'image') {
        onProgress('preparing', 0.05, t('ex.gatherImage'))
        await api.exportImage(state.image, onProgress)
      } else if (state.kind === 'project') {
        onProgress('preparing', 0.05, t('ex.gatherProject'))
        await api.exportProject(state.project, onProgress)
      } else {
        await api.exportVideo(state.video, onProgress, () => cancelled)
      }
      onProgress('done', 1)
      setExporting(false)
      showNote(t('ex.done'))
      progFill.style.width = '100%'
      finished = true
      autoClose = window.setTimeout(() => {
        if (finished) close()
      }, 1200)
    } catch (err) {
      const aborted = /cancel|abort/i.test((err as Error)?.name ?? '')
      setExporting(false)
      showNote(
        aborted
          ? t('ex.cancelled')
          : t('ex.failed', { msg: (err as Error)?.message || String(err) }),
      )
    }
  })

  // setExporting(false) 会收起进度区并清空提示，结果文案必须在它之后重新挂上，
  // 否则「完成 / 失败 / 无乐谱」三种收尾用户一个字都看不到。
  function showNote(text: string): void {
    progWrap.hidden = false
    progNote.textContent = text
  }

  // 重建右栏设置
  function syncRight(): void {
    right.innerHTML = ''
    if (state.kind === 'video') right.append(buildVideoSettings())
    else if (state.kind === 'image') right.append(buildImageSettings())
    else if (state.kind === 'project') right.append(buildProjectSettings())
    else right.append(buildModelSettings())
  }

  function row(label: string, control: HTMLElement): HTMLElement {
    const r = h('div', 'ex-row')
    const s = h('span', 'ex-row__label')
    s.textContent = label
    r.append(s, control)
    return r
  }

  /** 下拉统一走外壳自绘组件：原生 <select> 的弹层在触屏上是系统 UI（不吃主题、
   *  也逃不出弹窗的滚动容器），而这里的选项要带「高性能」这类标注，需要自己排版。 */
  function selectFrom<T extends string>(
    options: Array<{ value: T; label: string; tag?: string }>,
    current: T,
    onPick: (v: T) => void,
  ): HTMLElement {
    const ctl = createSelect({
      options: options.map((o) => ({
        v: o.value,
        l: o.tag ? t('ex.withTag', { label: o.label, tag: o.tag }) : o.label,
      })),
      value: current,
      onChange: (v) => onPick(v as T),
    })
    ctl.el.classList.add('ex-select')
    return ctl.el
  }

  function sectionTitle(text: string): HTMLElement {
    const s = h('div', 'ex-sec-label')
    s.textContent = text
    return s
  }

  // ── 视频设置 ──
  function buildVideoSettings(): HTMLElement {
    const box = h('div', 'ex-form')
    box.append(
      sectionTitle(t('ex.sec.format')),
      row(
        t('ex.row.format'),
        selectFrom(
          [{ value: 'mp4' as const, label: 'MP4 · H.264 + AAC' }],
          state.video.format,
          () => undefined,
        ),
      ),
      sectionTitle(t('ex.sec.content')),
    )

    // 声音选择
    const audioSel = selectFrom(
      [
        { value: 'on' as const, label: t('ex.audio.on') },
        { value: 'off' as const, label: t('ex.audio.off') },
      ],
      state.video.includeAudio ? 'on' : 'off',
      (v) => (state.video.includeAudio = v === 'on'),
    )
    box.append(row(t('ex.row.audio'), audioSel))

    // 帧率（最高 60，低性能自动降级）
    const fpsSel = selectFrom(
      [
        { value: '24' as const, label: '24 fps' },
        { value: '30' as const, label: '30 fps' },
        { value: '60' as const, label: '60 fps', tag: t('ex.tag.highPerf') },
      ],
      String(state.video.fps) as '24' | '30' | '60',
      (v) => (state.video.fps = Number(v) as VideoFps),
    )
    box.append(row(t('ex.row.fps'), fpsSel))

    // 画质（最高 4K，低性能自动降级）
    const qSel = selectFrom(
      [
        { value: '720p' as const, label: t('ex.quality.720p') },
        { value: '1080p' as const, label: t('ex.quality.1080p') },
        { value: '1440p' as const, label: '2K QHD' },
        { value: '2160p' as const, label: t('ex.quality.2160p'), tag: t('ex.tag.highPerf') },
      ],
      state.video.quality,
      (v) => (state.video.quality = v),
    )
    box.append(row(t('ex.row.quality'), qSel))

    // 画面比例：居中裁掉两边（与顶栏辅助虚线同一 contain 口径）
    const ratioSel = selectFrom(
      [
        { value: 'source', label: t('ex.ratio.source') },
        ...ASPECT_RATIOS.map((r) => ({ value: r.id, label: r.id })),
      ],
      state.video.ratio,
      (v) => (state.video.ratio = v),
    )
    box.append(row(t('ex.row.ratio'), ratioSel))

    // 码率档
    const brSel = selectFrom(
      [
        { value: 'low' as const, label: t('ex.bitrate.low') },
        { value: 'mid' as const, label: t('ex.bitrate.mid') },
        { value: 'high' as const, label: t('ex.bitrate.high') },
      ],
      state.video.bitrateTier,
      (v) => (state.video.bitrateTier = v),
    )
    box.append(row(t('ex.row.bitrate'), brSel))

    const note = h('div', 'ex-note')
    note.textContent = t('ex.videoNote')
    box.append(note)
    return box
  }

  // ── 图片设置（当前画面渲染导出）──
  function buildImageSettings(): HTMLElement {
    const box = h('div', 'ex-form')
    box.append(sectionTitle(t('ex.sec.format')))
    box.append(
      row(
        t('ex.row.imageFormat'),
        selectFrom([{ value: 'png' as const, label: 'PNG · 无损' }], 'png', () => undefined),
      ),
    )

    box.append(sectionTitle(t('ex.sec.imageSize')))
    // DPI：以 96 DPI 为基准倍率，输出像素 = 画布像素 × (DPI / 96)
    const dpiSel = selectFrom(
      [
        { value: '96' as const, label: t('ex.dpi.96') },
        { value: '192' as const, label: t('ex.dpi.192') },
        { value: '288' as const, label: t('ex.dpi.288') },
        { value: '384' as const, label: t('ex.dpi.384') },
      ],
      String(state.image.dpi) as '96' | '192' | '288' | '384',
      (v) => (state.image.dpi = Number(v)),
    )
    box.append(row(t('ex.row.dpi'), dpiSel))

    // 画面比例：source = 跟随当前画布；其余按比例居中裁掉两边（与视频同一口径）
    const ratioSel = selectFrom(
      [
        { value: 'source', label: t('ex.ratio.source') },
        ...ASPECT_RATIOS.map((r) => ({ value: r.id, label: r.id })),
      ],
      state.image.ratio,
      (v) => (state.image.ratio = v),
    )
    box.append(row(t('ex.row.ratio'), ratioSel))

    const note = h('div', 'ex-note')
    note.textContent = t('ex.imageNote')
    box.append(note)
    return box
  }

  // ── 工程文件设置（zip）──
  function buildProjectSettings(): HTMLElement {
    const box = h('div', 'ex-form')
    box.append(sectionTitle(t('ex.sec.format')))
    box.append(
      row(
        t('ex.row.projectFormat'),
        selectFrom([{ value: 'zip' as const, label: 'ZIP · 工程包' }], 'zip', () => undefined),
      ),
    )
    box.append(sectionTitle(t('ex.sec.content')))

    const hasOrig = !!sessionStorage.getItem('midee.midiOrig')
    const items: Array<{
      key: keyof ProjectExportOpts
      labelKey: string
      supported: boolean
    }> = [
      { key: 'includeXml', labelKey: 'ex.inc.xml', supported: !!sessionStorage.getItem('midee.xml') },
      { key: 'includeMidi', labelKey: 'ex.inc.midi', supported: !!sessionStorage.getItem('midee.midi') },
      { key: 'includeOrigMidi', labelKey: 'ex.inc.origMidi', supported: hasOrig },
      { key: 'includeConfig', labelKey: 'ex.inc.config', supported: true },
      { key: 'includePrefs', labelKey: 'ex.inc.prefs', supported: true },
      { key: 'includeResources', labelKey: 'ex.inc.resources', supported: true },
    ]
    for (const it of items) {
      const lab = h('label', 'ex-check' + (it.supported ? '' : ' ex-check--off'))
      const input = h('input') as HTMLInputElement
      input.type = 'checkbox'
      input.checked = state.project[it.key] && it.supported
      input.disabled = !it.supported
      input.addEventListener('change', () => {
        state.project[it.key] = input.checked
      })
      const span = h('span')
      span.textContent = `${t(it.labelKey)}${it.supported ? '' : t('ex.unsupported')}`
      lab.append(input, span)
      box.append(lab)
    }

    const note = h('div', 'ex-note')
    note.textContent = t('ex.projectNote')
    box.append(note)
    return box
  }

  // ── 模型设置 ──
  function buildModelSettings(): HTMLElement {
    const box = h('div', 'ex-form')
    const fmt = state.model.format
    const caps = MODEL_CAPS[fmt]

    box.append(sectionTitle(t('ex.sec.format')))
    const fmtSel = selectFrom(
      (Object.keys(MODEL_CAPS) as ModelFormat[]).map((f) => ({
        value: f,
        label: t(MODEL_CAPS[f].label),
      })),
      fmt,
      (v) => {
        state.model.format = v
        // 新格式不支持的内容自动取消
        const c = MODEL_CAPS[v]
        if (!c.paths) state.model.includePaths = false
        if (!c.balls) state.model.includeBalls = false
        if (!c.trails) state.model.includeTrails = false
        syncRight()
      },
    )
    box.append(row(t('ex.row.modelFormat'), fmtSel))
    box.append(sectionTitle(t('ex.sec.content')))

    const checkboxes: Array<{
      key: 'includeModel' | 'includePaths' | 'includeBalls' | 'includeTrails'
      labelKey: string
      supported: boolean
    }> = [
      { key: 'includeModel', labelKey: 'ex.inc.model', supported: caps.model },
      { key: 'includePaths', labelKey: 'ex.inc.paths', supported: caps.paths },
      { key: 'includeBalls', labelKey: 'ex.inc.balls', supported: caps.balls },
      { key: 'includeTrails', labelKey: 'ex.inc.trails', supported: caps.trails },
    ]
    for (const c of checkboxes) {
      const lab = h('label', 'ex-check' + (c.supported ? '' : ' ex-check--off'))
      const input = h('input') as HTMLInputElement
      input.type = 'checkbox'
      input.checked = state.model[c.key] && c.supported
      input.disabled = !c.supported
      input.addEventListener('change', () => {
        state.model[c.key] = input.checked
      })
      const span = h('span')
      span.textContent = `${t(c.labelKey)}${c.supported ? '' : t('ex.unsupported')}`
      lab.append(input, span)
      box.append(lab)
    }

    const note = h('div', 'ex-note')
    note.textContent = `${t(caps.hint)} ${t('ex.noTexture')}`
    box.append(note)
    return box
  }

  syncKind()
  syncRight()

  // 预览缩略图
  const thumb = api.captureThumbnail()
  if (thumb) {
    prevImg.src = thumb
    prevImg.style.display = 'block'
    prevPlaceholder.hidden = true
  } else {
    prevImg.style.display = 'none'
    prevPlaceholder.hidden = false
  }

  return wrap
}

const ICON_VIDEO =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.5" width="14" height="13" rx="2.5"/><path d="M16.5 10l5-3v10l-5-3z"/></svg>'
const ICON_MODEL =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l7.5 4.2v8.4L12 19.6l-7.5-4.2V7z"/><path d="M4.8 7.2L12 11.3l7.2-4.1M12 11.3v8.2"/></svg>'
const ICON_IMAGE =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 16.5l4.5-4 3.5 3 3-2.5 5 4.5"/></svg>'
const ICON_PROJECT =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2.2h7.8a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/><path d="M8 12.5h8M8 15.8h5"/></svg>'

