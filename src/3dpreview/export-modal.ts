// 最后一页「导出」弹窗：左右分栏。
//   左栏：导出类型（视频 / 图片 / 模型 / 工程文件）+ 简介 + 实时预览缩略图。
//   右栏：格式下拉 + 导出内容/参数；底部「取消 / 导出」。
// 本模块只负责 UI 与选项收集，真正的导出逻辑由 main.ts 通过 ExportApi 注入。
// 视觉复用 shell 的 CSS 变量（--sh-*）与基础类（sh-modal / sh-btn）。
import { buildExportShell, h } from '../shell/export-shell'
import { t } from '../shell/i18n'
import { createSelect } from '../shell/select'
import { ASPECT_RATIOS, aspectById } from './aspect-ratio'

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
  /** 相机状态（工具 ▾ → 相机：模式/视角/居中参数） */
  includeCam: boolean
  /** 时间设置（工具 ▾ → 时间：首尾留白/音画对齐） */
  includeTime: boolean
  /** 已下载资源清单（重下链接） */
  includeResources: boolean
}

/** 图片导出模式：raster = 位图（PNG/JPEG/WebP…，浏览器原生编码）；vector = 矢量 SVG */
export type ImageMode = 'raster' | 'vector'
export type SvgRenderMode = 'wireframe' | 'filled' | 'both'
export type SvgFillSource = 'material' | 'solid' | 'none'
export type SvgBackground = 'transparent' | 'solid' | 'scene'

/** 矢量 SVG 导出的高自由度设置 */
export interface SvgExportOpts {
  /** 渲染风格：线框 / 填充 / 线框+填充 */
  renderMode: SvgRenderMode
  includeModel: boolean // 谱面（音符立体层）
  includePaths: boolean // 小球轨迹路径线
  includeBalls: boolean // 小球
  includeTrails: boolean // 拖尾
  includeBackground: boolean // 背景（地面/背板/水面）
  includeHelpers: boolean // 辅助线/参考线
  /** 线条颜色（线框/描边用） */
  strokeColor: string
  strokeWidth: number
  /** 填充来源：材质原色 / 统一单色 / 不填充 */
  fillSource: SvgFillSource
  fillColor: string // fillSource=solid 时使用
  /** 背景：透明 / 纯色 / 跟随当前场景背景色 */
  background: SvgBackground
  bgColor: string // background=solid 时使用
  width: number
  height: number
}

/** SVG 导出中可勾选的布尔开关键（均为 boolean） */
export type SvgIncludeKey =
  | 'includeModel'
  | 'includePaths'
  | 'includeBalls'
  | 'includeTrails'
  | 'includeBackground'
  | 'includeHelpers'

/** 图片导出：以 96 DPI 为基准倍率，DPI 越高输出像素越大（96→1×，192→2×，384→4×） */
export interface ImageExportOpts {
  mode: ImageMode
  /** 位图模式：浏览器原生支持的 MIME（image/png / image/jpeg / image/webp …），由探测得出 */
  rasterFormat: string
  dpi: number
  /** 画面比例：source = 跟随当前画布；其余 = 按比例居中裁掉两边（与视频同一口径） */
  ratio: string
  /** 矢量模式的高自由度设置 */
  svg: SvgExportOpts
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
  /** 生成贴近实际导出的预览图（按当前图片模式/比例/设置渲染），失败返回 null */
  capturePreview(image: ImageExportOpts): string | null
  /** 探测浏览器原生支持的位图导出格式（MIME，如 image/png / image/jpeg / image/webp） */
  probeRasterFormats(): string[]
  exportModel(opts: ModelExportOpts, onProgress: ExportProgress): Promise<void>
  exportVideo(opts: VideoExportOpts, onProgress: ExportProgress, isCancelled: () => boolean): Promise<void>
  exportImage(opts: ImageExportOpts, onProgress: ExportProgress): Promise<void>
  /** 导出工程 zip：MIDI / MusicXML / 各页配置说明 */
  exportProject(opts: ProjectExportOpts, onProgress: ExportProgress): Promise<void>
  /** 导出弹窗开关时通知主场景：true=冻结实时动画循环并暂停播放，false=恢复 */
  setPreviewActive?(active: boolean): void
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

/** 颜色拾取控件 */
function colorInput(value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = h('div', 'ex-color')
  const input = h('input') as HTMLInputElement
  input.type = 'color'
  input.value = value
  input.addEventListener('input', () => onChange(input.value))
  wrap.append(input)
  return wrap
}

/** 数值输入控件 */
function numberInput(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const input = h('input') as HTMLInputElement
  input.type = 'number'
  input.className = 'ex-num'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  input.addEventListener('input', () => onChange(Number(input.value)))
  return input
}

/** 预览放大灯箱：点击遮罩或 × 或 Esc 关闭 */
function openPreviewLightbox(src: string): void {
  const overlay = h('div', 'ex-lightbox')
  const close = () => {
    overlay.remove()
    window.removeEventListener('keydown', onKey)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  overlay.addEventListener('click', close)
  const img = h('img', 'ex-lightbox__img') as HTMLImageElement
  img.src = src
  img.addEventListener('click', (e) => e.stopPropagation())
  const btn = h('div', 'ex-lightbox__close')
  btn.textContent = '×'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    close()
  })
  overlay.append(img, btn)
  document.body.append(overlay)
  window.addEventListener('keydown', onKey)
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
    image: {
      mode: 'raster',
      rasterFormat: 'image/png',
      dpi: 192,
      ratio: 'source',
      svg: {
        renderMode: 'both',
        includeModel: true,
        includePaths: true,
        includeBalls: true,
        includeTrails: false,
        includeBackground: true,
        includeHelpers: false,
        strokeColor: '#1a1a1a',
        strokeWidth: 1,
        fillSource: 'material',
        fillColor: '#cccccc',
        background: 'scene',
        bgColor: '#ffffff',
        width: 1920,
        height: 1080,
      },
    },
    project: { includeOrigMidi: true, includeMidi: true, includeXml: true, includeConfig: true, includePrefs: true, includeCam: true, includeTime: true, includeResources: true },
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
  const prevLabel = h('div', 'ex-sec-label ex-preview__head')
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
    clearTimeout(previewTimer)
    api.setPreviewActive?.(false)
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
    refreshPreview()
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

  // ── 图片设置（当前画面渲染导出）：位图 / 矢量 两模式 ──
  function buildImageSettings(): HTMLElement {
    const box = h('div', 'ex-form')

    // 模式切换：位图 / 矢量
    box.append(sectionTitle(t('ex.sec.mode')))
    const modeRow = h('div', 'ex-seg')
    const modeBtns: Record<ImageMode, HTMLButtonElement> = {
      raster: h('button', 'ex-seg__btn') as HTMLButtonElement,
      vector: h('button', 'ex-seg__btn') as HTMLButtonElement,
    }
    modeBtns.raster.textContent = t('ex.mode.raster')
    modeBtns.vector.textContent = t('ex.mode.vector')
    const syncMode = () => {
      for (const k of Object.keys(modeBtns) as ImageMode[]) {
        modeBtns[k].classList.toggle('ex-seg__btn--on', state.image.mode === k)
      }
    }
    modeBtns.raster.addEventListener('click', () => {
      state.image.mode = 'raster'
      syncMode()
      syncRight()
      schedulePreview()
    })
    modeBtns.vector.addEventListener('click', () => {
      state.image.mode = 'vector'
      applyRatioToSvgSize()
      syncMode()
      syncRight()
      schedulePreview()
    })
    modeRow.append(modeBtns.raster, modeBtns.vector)
    box.append(modeRow)
    syncMode()

    if (state.image.mode === 'raster') {
      box.append(sectionTitle(t('ex.sec.format')))
      // 位图格式：只列出浏览器原生编码支持的格式
      const fmts = api.probeRasterFormats()
      const fmtLabel = (mime: string): string =>
        ({
          'image/png': 'PNG · 无损',
          'image/jpeg': 'JPEG · 有损',
          'image/webp': 'WebP',
          'image/avif': 'AVIF · 高效',
          'image/bmp': 'BMP · 无压缩',
        })[mime] ?? mime
      if (!fmts.includes(state.image.rasterFormat)) state.image.rasterFormat = fmts[0] ?? 'image/png'
      const fmtSel = selectFrom(
        fmts.map((f) => ({ value: f, label: fmtLabel(f) })),
        state.image.rasterFormat,
        (v) => {
          state.image.rasterFormat = v
          schedulePreview()
        },
      )
      box.append(row(t('ex.row.imageFormat'), fmtSel))

      box.append(sectionTitle(t('ex.sec.imageSize')))
      const dpiSel = selectFrom(
        [
          { value: '96' as const, label: t('ex.dpi.96') },
          { value: '192' as const, label: t('ex.dpi.192') },
          { value: '288' as const, label: t('ex.dpi.288') },
          { value: '384' as const, label: t('ex.dpi.384') },
        ],
        String(state.image.dpi) as '96' | '192' | '288' | '384',
        (v) => {
          state.image.dpi = Number(v)
          schedulePreview()
        },
      )
      box.append(row(t('ex.row.dpi'), dpiSel))

      const ratioSel = selectFrom(
        [
          { value: 'source', label: t('ex.ratio.source') },
          ...ASPECT_RATIOS.map((r) => ({ value: r.id, label: r.id })),
        ],
        state.image.ratio,
        (v) => {
          state.image.ratio = v
          schedulePreview()
        },
      )
      box.append(row(t('ex.row.ratio'), ratioSel))

      const note = h('div', 'ex-note')
      note.textContent = t('ex.imageNote')
      box.append(note)
    } else {
      // ── 矢量 SVG 设置 ──
      const wip = h('div', 'ex-wip')
      wip.textContent = t('ex.svgWip')
      box.append(wip)
      box.append(sectionTitle(t('ex.sec.svgRender')))
      const rmSel = selectFrom<SvgRenderMode>(
        [
          { value: 'wireframe', label: t('ex.svg.wireframe') },
          { value: 'filled', label: t('ex.svg.filled') },
          { value: 'both', label: t('ex.svg.both') },
        ],
        state.image.svg.renderMode,
        (v) => {
          state.image.svg.renderMode = v
          schedulePreview()
        },
      )
      box.append(row(t('ex.svg.renderMode'), rmSel))

      box.append(sectionTitle(t('ex.sec.content')))
      const checks: Array<{ key: SvgIncludeKey; labelKey: string }> = [
        { key: 'includeModel', labelKey: 'ex.inc.model' },
        { key: 'includePaths', labelKey: 'ex.inc.paths' },
        { key: 'includeBalls', labelKey: 'ex.inc.balls' },
        { key: 'includeTrails', labelKey: 'ex.inc.trails' },
        { key: 'includeBackground', labelKey: 'ex.inc.background' },
        { key: 'includeHelpers', labelKey: 'ex.inc.helpers' },
      ]
      for (const c of checks) {
        const lab = h('label', 'ex-check')
        const input = h('input') as HTMLInputElement
        input.type = 'checkbox'
        input.checked = !!state.image.svg[c.key]
        input.addEventListener('change', () => {
          state.image.svg[c.key] = input.checked
          schedulePreview()
        })
        const span = h('span')
        span.textContent = t(c.labelKey)
        lab.append(input, span)
        box.append(lab)
      }

      box.append(sectionTitle(t('ex.sec.svgStyle')))
      box.append(
        row(
          t('ex.svg.strokeColor'),
          colorInput(state.image.svg.strokeColor, (v) => {
            state.image.svg.strokeColor = v
            schedulePreview()
          }),
        ),
      )
      box.append(
        row(
          t('ex.svg.strokeWidth'),
          numberInput(state.image.svg.strokeWidth, 0.2, 20, 0.1, (v) => {
            state.image.svg.strokeWidth = v
            schedulePreview()
          }),
        ),
      )
      const fsSel = selectFrom<SvgFillSource>(
        [
          { value: 'material', label: t('ex.svg.fillMaterial') },
          { value: 'solid', label: t('ex.svg.fillSolid') },
          { value: 'none', label: t('ex.svg.fillNone') },
        ],
        state.image.svg.fillSource,
        (v) => {
          state.image.svg.fillSource = v
          syncRight()
          schedulePreview()
        },
      )
      box.append(row(t('ex.svg.fillSource'), fsSel))
      if (state.image.svg.fillSource === 'solid') {
        box.append(
          row(
            t('ex.svg.fillColor'),
            colorInput(state.image.svg.fillColor, (v) => {
              state.image.svg.fillColor = v
              schedulePreview()
            }),
          ),
        )
      }

      box.append(sectionTitle(t('ex.sec.svgBg')))
      const bgSel = selectFrom<SvgBackground>(
        [
          { value: 'transparent', label: t('ex.svg.bgTransparent') },
          { value: 'solid', label: t('ex.svg.bgSolid') },
          { value: 'scene', label: t('ex.svg.bgScene') },
        ],
        state.image.svg.background,
        (v) => {
          state.image.svg.background = v
          syncRight()
          schedulePreview()
        },
      )
      box.append(row(t('ex.svg.background'), bgSel))
      if (state.image.svg.background === 'solid') {
        box.append(
          row(
            t('ex.svg.bgColor'),
            colorInput(state.image.svg.bgColor, (v) => {
              state.image.svg.bgColor = v
              schedulePreview()
            }),
          ),
        )
      }

      box.append(sectionTitle(t('ex.sec.imageSize')))
      const ratioSel = selectFrom(
        [
          { value: 'source', label: t('ex.ratio.source') },
          ...ASPECT_RATIOS.map((r) => ({ value: r.id, label: r.id })),
        ],
        state.image.ratio,
        (v) => {
          state.image.ratio = v
          applyRatioToSvgSize()
          syncRight()
          schedulePreview()
        },
      )
      box.append(row(t('ex.row.ratio'), ratioSel))
      box.append(
        row(
          t('ex.svg.width'),
          numberInput(state.image.svg.width, 100, 8000, 1, (v) => {
            state.image.svg.width = v
            schedulePreview()
          }),
        ),
      )
      box.append(
        row(
          t('ex.svg.height'),
          numberInput(state.image.svg.height, 100, 8000, 1, (v) => {
            state.image.svg.height = v
            schedulePreview()
          }),
        ),
      )

      const note = h('div', 'ex-note')
      note.textContent = t('ex.svgNote')
      box.append(note)
    }
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
      { key: 'includeCam', labelKey: 'ex.inc.cam', supported: true },
      { key: 'includeTime', labelKey: 'ex.inc.time', supported: true },
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

  // 预览防抖状态 + 手动刷新按钮：必须在 syncKind() 之前声明，
  // 避免初始化调用 refreshPreview→syncRefreshBtn 时命中 const/let 的 TDZ
  let previewTimer = 0
  let previewLast = 0
  let previewDirty = false
  const refreshBtn = h('button', 'ex-refresh') as HTMLButtonElement
  refreshBtn.type = 'button'
  refreshBtn.textContent = t('ex.previewRefresh')
  refreshBtn.title = t('ex.previewRefreshHint')
  function syncRefreshBtn(): void {
    refreshBtn.classList.toggle('ex-refresh--dirty', previewDirty)
    refreshBtn.textContent = previewDirty ? t('ex.previewRefreshPending') : t('ex.previewRefresh')
  }
  refreshBtn.addEventListener('click', () => {
    clearTimeout(previewTimer)
    refreshPreview()
  })

  syncKind()
  syncRight()

  // 切换比例时给矢量模式一个默认输出尺寸（基准宽 1920，按比例算高）
  function applyRatioToSvgSize(): void {
    const r = aspectById(state.image.ratio)
    if (r) {
      state.image.svg.width = 1920
      state.image.svg.height = Math.max(100, Math.round(1920 / r.ratio))
    }
  }

  // 预览：图片类按当前模式/比例/设置生成贴近导出的预览；其余类用全画面缩略图
  function refreshPreview(): void {
    previewDirty = false
    syncRefreshBtn()
    const thumb = state.kind === 'image' ? api.capturePreview(state.image) : api.captureThumbnail()
    if (thumb) {
      prevImg.src = thumb
      prevImg.style.display = 'block'
      prevPlaceholder.hidden = true
    } else {
      prevImg.style.display = 'none'
      prevPlaceholder.hidden = false
    }
  }

  // 防抖调度：拖动颜色/数字时高频触发会拖垮渲染，合并成 320ms 一次（首帧立即、末尾收尾）
  function schedulePreview(): void {
    previewDirty = true
    syncRefreshBtn()
    const now = Date.now()
    const remaining = 320 - (now - previewLast)
    if (remaining <= 0) {
      previewLast = now
      refreshPreview()
    } else {
      clearTimeout(previewTimer)
      previewTimer = window.setTimeout(() => {
        previewLast = Date.now()
        refreshPreview()
      }, remaining)
    }
  }
  prevLabel.append(refreshBtn)

  // 点击预览 → 放大查看
  prevImg.style.cursor = 'zoom-in'
  prevImg.title = t('ex.previewZoom')
  prevImg.addEventListener('click', () => {
    if (prevImg.src) openPreviewLightbox(prevImg.src)
  })

  // 打开弹窗即冻结场景（暂停实时动画循环），预览独占 renderer 且画面稳定；close 时恢复
  api.setPreviewActive?.(true)
  refreshPreview()

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

