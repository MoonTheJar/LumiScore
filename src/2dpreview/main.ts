// ── 2D 检查页（第 2 步）──
// Verovio 渲染 MusicXML（内置 Bravura 音乐字体）
//
// 数据契约：
//   midee.xml      乐谱本体（MusicXML），本页只读，不修改
//   midee.midi     播放用 MIDI（base64），导入页生成，本页不改
//   midee.layout   排版偏好 { spacingLinear, spacingSystem, spacingStaff }
//                    · 乐谱宽度：spacingLinear（音符水平间距）
//                    · 总高间距：spacingSystem（系统行间距）
//                    · 谱表间距：spacingStaff（同系统内上下谱表间距）
//   midee.symbolEdits  视觉编辑 { o:偏移, h:删除, x:文字改写 }，全部只影响显示
//   midee.scoreMeta   标题覆盖 { title?, author? }
//
// 本页不提供「改音高」：所有编辑只动 SVG 显示，不写入 XML / MIDI。

import { MideePlayer, playbackMidiB64 } from '../3dpreview/player'
import createVerovioModule from 'verovio/wasm'
import { VerovioToolkit } from 'verovio/esm'
import { createPlayerBar, type PlayerBarHandle } from '../shell/playerbar'
import { createTrackPanel, type TrackPanelHandle } from '../shell/tracks'
import { createScrollRail } from '../shell/scrollrail'
import { applyI18n, onLocaleChange, t } from '../shell/i18n'
import { bindRangeTip, bindTip } from '../shell/tooltip'
import { bringToFront } from '../shell/layer'
import { confirmDialog, goStep, mountShell, paintDark2d } from '../shell/shell'
import { openProjectExportDialog } from '../shell/project-export'
import { createSelect, isSelectUI } from '../shell/select'
import { bindSliderPair } from '../shell/slider'
import {
  ALL_SEL,
  BAR_SEL,
  EDIT_SEL,
  LOCKED_SEL,
  NOTE_SEL,
  applySymbolFont,
  applyTextFace,
  composeSymbolTransform,
  rewriteSymbolText,
} from '../shared/symbol-text'
import { FONT_CHOICES, ensureFontReady } from '../shared/webfont'
import { createRenderProgress } from '../shared/render-progress'

interface TimemapRow {
  on?: string[]
  off?: string[]
  qstamp?: number
  /** 毫秒时间戳（已按 tempo 换算） */
  tstamp?: number
}
interface VerovioToolkitCtor {
  loadData(xml: string): boolean
  setOptions(opts: Record<string, unknown>): void
  renderToSVG(pageNo?: number, xmlDeclaration?: boolean): string
  renderToTimemap(): TimemapRow[]
  getPageCount(): number
  destroy(): void
}

// ── DOM ──────────────────────────────────────────────────────
const scoreEl = document.getElementById('score')!
const innerEl = document.getElementById('scoreInner')!
const cursorEl = document.getElementById('cursor')!
const cursorDot = document.getElementById('cursorDot')!
const scoreTitleEl = document.getElementById('scoreTitle')!
const statusEl = document.getElementById('statusText')!
const zoomEl = document.getElementById('zoom')!

// 渲染/计算小进度条弹窗（进入页面 + 重排版时弹出）
const renderProg = createRenderProgress()

// 黑底白谱（两 2D 页共享 sessionStorage；开关在顶栏设置下拉，仅深色模式生效）
paintDark2d()

// ── 排版状态 ────────────────────────────────────────────────────
const LAYOUT_KEY = 'midee.layout'
/** 本页是否有未保存（相对磁盘工程包）的改动：任何一次 save* 都会置真 */
let dirty = false
const SCALE_REF = 45 // Verovio 固定渲染字号

// Verovio 官方参数范围
const SPACING_LINEAR_DEF = 0.25; const SPACING_LINEAR_MIN = 0.00; const SPACING_LINEAR_MAX = 1.00
const SPACING_SYSTEM_DEF = 4;    const SPACING_SYSTEM_MIN = 0;     const SPACING_SYSTEM_MAX = 48
const SPACING_STAFF_DEF = 12;    const SPACING_STAFF_MIN = 0;     const SPACING_STAFF_MAX = 48

interface Layout {
  v?: number  // 版本标记：v2=存 Verovio 原始值
  /** 乐谱宽度 → spacingLinear (0.00–1.00) */
  spacingLinear: number
  /** 总高间距 → spacingSystem (0–48) */
  spacingSystem: number
  /** 谱表间距 → spacingStaff (0–48) */
  spacingStaff: number
}

function clampV(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function loadLayout(): Layout {
  const fallback: Layout = { v: 2, spacingLinear: SPACING_LINEAR_DEF, spacingSystem: SPACING_SYSTEM_DEF, spacingStaff: SPACING_STAFF_DEF }
  try {
    const raw = sessionStorage.getItem(LAYOUT_KEY)
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<Layout> & { heightPct?: number; widthPct?: number; lengthPct?: number }
    // v2+：直接存 Verovio 值
    if (p.v === 2 && typeof p.spacingLinear === 'number' && typeof p.spacingSystem === 'number' && typeof p.spacingStaff === 'number') {
      return {
        v: 2,
        spacingLinear: clampV(p.spacingLinear, SPACING_LINEAR_MIN, SPACING_LINEAR_MAX),
        spacingSystem: clampV(p.spacingSystem, SPACING_SYSTEM_MIN, SPACING_SYSTEM_MAX),
        spacingStaff: clampV(p.spacingStaff, SPACING_STAFF_MIN, SPACING_STAFF_MAX),
      }
    }
    // 旧版迁移：widthPct 60–180 → spacingLinear 0.15–0.45；heightPct 忽略
    const oldW = clampV(p.widthPct ?? p.lengthPct ?? 100, 60, 180)
    return {
      v: 2,
      spacingLinear: clampV(0.25 * oldW / 100, SPACING_LINEAR_MIN, SPACING_LINEAR_MAX),
      spacingSystem: SPACING_SYSTEM_DEF,
      spacingStaff: SPACING_STAFF_DEF,
    }
  } catch {
    return fallback
  }
}
function saveLayout(): void {
  dirty = true
  try {
    sessionStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    /* 隐私模式忽略 */
  }
}
let layout: Layout = loadLayout()

// ── 视觉编辑（偏移 / 删除 / 文字，均只影响显示） ─────────────────
const EDITS_KEY = 'midee.symbolEdits'
interface Pt {
  x: number
  y: number
}
/** 自由文字（右键空白添加，独立于谱面符号） */
interface FreeText {
  x: number // SVG 用户坐标锚点（左上）
  y: number
  txt: string
  dx: number // 拖动偏移
  dy: number
  hidden?: boolean
  isTitle?: boolean // 曲名标题（首进自动生成）
  sc?: number // 字号缩放（默认 1）
  bold?: boolean // 加粗
  face?: string // 字体（FONT_CHOICES key；空/缺省 = 默认）
}
interface Edits {
  /** 按统一符号列表序号：拖动偏移（SVG 用户单位） */
  o: (Pt | null)[]
  /** 被删除（隐藏）的序号 */
  h: number[]
  /** 文字改写 */
  x: Record<string, string>
  /** 自由文字列表（右键空白添加）；对应负 data-idx = -(i+1) */
  f: FreeText[]
  /** 文本字号缩放（idx → 因子，默认 1） */
  s: Record<string, number>
  /** 加粗的序号 */
  bw: number[]
  /** 文本元素字体（idx → FONT_CHOICES key） */
  fb: Record<string, string>
}
function emptyEdits(): Edits {
  return { o: [], h: [], x: {}, f: [], s: {}, bw: [], fb: {} }
}
let edits: Edits = loadEdits()
function loadEdits(): Edits {
  try {
    const raw = sessionStorage.getItem(EDITS_KEY)
    if (!raw) return emptyEdits()
    const p = JSON.parse(raw) as Partial<Edits>
    return {
      o: Array.isArray(p.o) ? p.o : [],
      h: Array.isArray(p.h) ? p.h : [],
      x: p.x && typeof p.x === 'object' ? p.x : {},
      f: Array.isArray(p.f) ? p.f : [],
      s: p.s && typeof p.s === 'object' ? p.s : {},
      bw: Array.isArray(p.bw) ? p.bw : [],
      fb: p.fb && typeof p.fb === 'object' ? p.fb : {},
    }
  } catch {
    return emptyEdits()
  }
}
function saveEdits(): void {
  dirty = true
  try {
    const hasO = edits.o.some((p) => p && (Math.abs(p.x) > 0.001 || Math.abs(p.y) > 0.001))
    const has = hasO || edits.h.length > 0 || Object.keys(edits.x).length > 0 || edits.f.length > 0 ||
      Object.keys(edits.s).length > 0 || edits.bw.length > 0 ||
      Object.keys(edits.fb).length > 0
    if (has) sessionStorage.setItem(EDITS_KEY, JSON.stringify(edits))
    else sessionStorage.removeItem(EDITS_KEY)
  } catch {
    /* noop */
  }
}

// ── 渲染状态 ──────────────────────────────────────────────────
let tk: VerovioToolkitCtor | null = null
let xmlDoc: Document | null = null
let svgScale = 1

// 结构锁定（映射锚点）：音符与小节线是第三页连线/第五页 3D 的定位锚——位置/存缺
// 一变，跨页映射就整体错位。它们不可拖、不可删（拍号/谱号/谱线/大括号本就不在
// ALL_SEL 里，天然锁定）。装饰类（力度/文字/指法……）仍自由编辑。
// 选择器统一来自 shared/symbol-text（第三页按同一序号应用编辑，跨页一致）。
const lockedSet = new Set<number>()

function setStatus(s: string, err = false): void {
  statusEl.textContent = s
  statusEl.style.color = err ? 'var(--sh-danger)' : ''
}
/** 谱面内容真正所在的 svg（Verovio 嵌套 definition-scale，坐标系≈外层的 22 倍大）
 *  自由文字挂这层、屏幕↔用户坐标换算用这层的 CTM */
function innerScoreSvg(): SVGSVGElement | null {
  const outer = svgEl()
  return (outer?.querySelector('svg') as SVGSVGElement | null) ?? outer
}
function svgEl(): SVGSVGElement | null {
  return innerEl.querySelector('svg')
}

// ── Verovio ───────────────────────────────────────────────────
function verovioOptions(): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    pageWidth: 1200,
    scale: SCALE_REF,
    spacingLinear: layout.spacingLinear,
    spacingNonLinear: 0.6,
    spacingSystem: layout.spacingSystem,
    spacingStaff: layout.spacingStaff,
    breaks: 'none',
    footer: 'none',
    header: 'none',
    font: 'Bravura',
  }
  return opts
}

async function initVerovio(): Promise<boolean> {
  try {
    const Module = await createVerovioModule()
    const inst = new VerovioToolkit(Module as never) as unknown as VerovioToolkitCtor
    tk = inst
    inst.setOptions(verovioOptions())
    return true
  } catch (err) {
    setStatus(t('p2.verovioFail', { err: String(err) }), true)
    return false
  }
}

function scrollFraction(): number {
  const span = scoreEl.scrollWidth - scoreEl.clientWidth
  return span > 8 ? scoreEl.scrollLeft / span : 0
}
function restoreScroll(frac: number): void {
  const span = scoreEl.scrollWidth - scoreEl.clientWidth
  if (span > 8) scoreEl.scrollLeft = Math.max(0, frac * span)
}

// ── 渐进式渲染：Verovio 一次性排版很快，但把整谱 SVG 一次性挂上 DOM 会让
// 大谱（数百音符）在解析/布局/绘制上卡顿。做法：解析出完整 SVG 后把各小节
// g.measure 拆下来，先挂骨架与前几小节，再按帧把小节依次向后铺开；
// 滚动接近右缘或播放光标接近前沿时同步提前补挂。 ─────────────────
let timemapRows: TimemapRow[] = []
let measureQueue: SVGGElement[] = []
let measureParent: SVGGElement | null = null
let measureAnchor: ChildNode | null = null
/** 全谱符号序号（data-idx）→ 已挂载 DOM，未挂载的不在表中 */
const groupMap = new Map<number, SVGGElement>()
let totalGroups = 0
let totalNotes = 0
let totalBars = 0
let totalEditable = 0
let revealGen = 0
let pumpQueued = false
const INITIAL_MEASURES = 6 // 首屏同步铺出的小节数
const MEASURES_PER_FRAME = 2 // 之后每帧补挂的小节数
const REVEAL_CHUNK = 4 // 滚动/播放追赶时一次补挂数
const REVEAL_GUARD = 24 // 单次追赶最多补挂的小节数（防止 seek 到结尾时一帧卡死）

function groupIdx(g: Element): number {
  const n = Number(g.getAttribute('data-idx'))
  return Number.isFinite(n) ? n : -1
}
function measureTranslateX(m: Element): number {
  const mm = /translate\(\s*(-?[\d.]+)/.exec(m.getAttribute('transform') ?? '')
  return mm && mm[1] !== undefined ? parseFloat(mm[1]) : 0
}

// 谱指纹：换谱（xml 变化）自动清空视觉编辑——元素偏移按序号存储，
// 换谱后同序号是别的元素，旧偏移会让它直接飞出视口（"乱跳/消失"根因之一）
let editsScoreHash = 0
function checkScoreFingerprint(): void {
  const xml = sessionStorage.getItem('midee.xml') ?? ''
  let h = 0
  for (let i = 0; i < xml.length; i++) h = (h * 31 + xml.charCodeAt(i)) | 0
  if (editsScoreHash !== 0 && editsScoreHash !== h) {
    edits = emptyEdits()
    svgEl()?.querySelectorAll('g.md-freetext').forEach((g) => g.remove())
    saveEdits()
  }
  editsScoreHash = h
}

function renderScore(): void {
  checkScoreFingerprint()
  const tool = tk
  if (!tool || !xmlDoc) return
  const gen = ++revealGen
  groupMap.clear()
  pumpQueued = false

  tool.loadData(new XMLSerializer().serializeToString(xmlDoc))
  const markup = tool.renderToSVG(1)
  timemapRows = tool.renderToTimemap()

  // 在脱离文档的解析文档里完成 DOM 解析（不触发绘制），再逐小节搬进活文档
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const srcSvg = parsed.documentElement as unknown as SVGSVGElement
  const allSrc = Array.from(srcSvg.querySelectorAll<SVGGElement>(ALL_SEL))
  allSrc.forEach((g, i) => {
    g.dataset.idx = String(i)
    g.dataset.baseTf = g.getAttribute('transform') ?? ''
  })
  totalGroups = allSrc.length
  totalNotes = srcSvg.querySelectorAll(NOTE_SEL).length
  totalBars = srcSvg.querySelectorAll(BAR_SEL).length
  totalEditable = srcSvg.querySelectorAll(EDIT_SEL).length

  const measures = Array.from(srcSvg.querySelectorAll<SVGGElement>('g.measure'))
  measureParent = (measures[0]?.parentNode as SVGGElement | null) ?? null
  const lastM = measures[measures.length - 1] ?? null
  measureAnchor = lastM?.nextSibling ?? null
  measureQueue = measures
  for (const m of measures) m.remove()

  const old = innerEl.querySelector('svg')
  if (old) old.remove()
  const liveSvg = document.adoptNode(srcSvg)
  innerEl.appendChild(liveSvg)
  innerEl.appendChild(cursorEl) // 光标始终最后，盖住符号
  initSkeleton(liveSvg)
  decorateStandalone(liveSvg)
  applyScale() // 按高度/页面缩放设置显示尺寸（尺寸来自引擎输出，与小节是否挂齐无关）
  setStatus(t('p2.status.laying'))
  revealMeasures(INITIAL_MEASURES, gen)
  queuePump(gen)
  ensureTitleText() // 曲名生成为可拖动自由文字元素（跟随乐谱到下一页）
  renderFreeTexts()
  updateCursorGeometry()
  // 进入页面自动把播放光标（起始位置）居中到视野
  requestAnimationFrame(() => requestAnimationFrame(() => centerCursor()))
}

function initSkeleton(svg: SVGSVGElement): void {
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/) ?? []
  const vbW = Number(vb[2]) || parseFloat(svg.getAttribute('width') ?? '') || 0
  const vbH = Number(vb[3]) || parseFloat(svg.getAttribute('height') ?? '') || 0
  svg.dataset.vbW = String(vbW)
  svg.dataset.vbH = String(vbH)
  // Verovio 输出无 viewBox（width/height 即用户单位）。显式设置 viewBox 并允许
  // 非等比缩放（preserveAspectRatio=none），这样 CSS 高度变化会纵向压缩/拉伸
  // 谱面内容，而不是只裁视口——宽度保持不变、只动上下高度。
  if (vbW > 0 && vbH > 0) {
    svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`)
    svg.setAttribute('preserveAspectRatio', 'none')
  }
}

/** 新挂上来的小节：记录符号、重放偏移/删除/文字 */
function decorateMeasure(m: SVGGElement): void {
  const gs = Array.from(m.querySelectorAll<SVGGElement>(ALL_SEL))
  for (const g of gs) {
    const i = groupIdx(g)
    if (i < 0) continue
    groupMap.set(i, g)
    const locked = g.matches(LOCKED_SEL)
    if (locked) {
      // 结构锚点：锁样式 + 清掉历史编辑数据（旧版本可能拖过/删过 → 映射错位源）
      lockedSet.add(i)
      g.classList.add('md-lock')
      if (edits.o[i]) edits.o[i] = null
      const hi = edits.h.indexOf(i)
      if (hi >= 0) edits.h.splice(hi, 1)
      g.classList.remove('md-hidden')
    } else {
      g.classList.add('md-drag')
    }
    if (g.matches(EDIT_SEL)) g.classList.add('md-edit')
    applyTransform(i)
    if (edits.h.includes(i)) g.classList.add('md-hidden')
    const txt = edits.x[String(i)]
    if (txt !== undefined) applyText(i, txt)
    const face = edits.fb[String(i)]
    if (face) {
      applySymbolFont(g, face)
      void ensureFontReady(face, g.querySelector('text')?.textContent ?? '')
    }
  }
}

/** 小节外的可编辑元素（g.label 谱名等 system 级）：小节流式挂载碰不到，这里一次性装饰 */
function decorateStandalone(svg: SVGSVGElement): void {
  const gs = Array.from(svg.querySelectorAll<SVGGElement>(ALL_SEL)).filter((g) => !g.closest('g.measure'))
  for (const g of gs) {
    const i = groupIdx(g)
    if (i < 0) continue
    groupMap.set(i, g)
    if (!lockedSet.has(i)) g.classList.add('md-drag')
    if (g.matches(EDIT_SEL)) g.classList.add('md-edit')
    applyTransform(i)
    if (edits.h.includes(i)) g.classList.add('md-hidden')
    const txt = edits.x[String(i)]
    if (txt !== undefined) applyText(i, txt)
    const face = edits.fb[String(i)]
    if (face) {
      applySymbolFont(g, face)
      void ensureFontReady(face, g.querySelector('text')?.textContent ?? '')
    }
  }
}

/** 从队列头部补挂若干小节并刷新与这些小节相关的状态 */
function revealMeasures(max: number, gen: number): number {
  if (gen !== revealGen || !measureParent) return 0
  let n = 0
  while (measureQueue.length && n < max) {
    const detached = measureQueue.shift()!
    const live = document.adoptNode(detached)
    measureParent.insertBefore(live, measureAnchor)
    decorateMeasure(live)
    n++
  }
  if (n) {
    renderSelection()
    buildAnchors()
    updateCursorGeometry()
    reportRevealProgress()
  }
  if (!measureQueue.length) {
    setStatus(t('p2.status.rendered', { bars: totalBars, notes: totalNotes, editable: totalEditable }))
    renderProg.set(1)
  }
  return n
}

function pump(): void {
  pumpQueued = false
  if (!measureQueue.length) return
  revealMeasures(MEASURES_PER_FRAME, revealGen)
  if (measureQueue.length) queuePump(revealGen)
}
function queuePump(gen: number): void {
  if (pumpQueued || gen !== revealGen) return
  pumpQueued = true
  requestAnimationFrame(pump)
}

/** 已挂载小节前沿的右缘 x（SVG 用户单位） */
function mountedFrontierX(): number {
  const svg = svgEl()
  const mounted = svg ? Array.from(svg.querySelectorAll<SVGGElement>('g.measure')) : []
  const last = mounted[mounted.length - 1]
  if (!last) return 0
  let w = 0
  try {
    w = last.getBBox().width
  } catch {
    w = 0
  }
  return measureTranslateX(last) + w
}

/** 保证小节铺到指定用户坐标（滚动/播放追赶用），有次数上限，其余交给帧泵 */
function ensureRevealToUserX(targetX: number): void {
  let guard = 0
  while (measureQueue.length && mountedFrontierX() < targetX && guard < REVEAL_GUARD) {
    revealMeasures(REVEAL_CHUNK, revealGen)
    guard++
  }
  if (measureQueue.length) queuePump(revealGen)
}

/** 把剩余小节全部同步挂完（导出 SVG 用） */
function revealAllNow(): void {
  while (measureQueue.length) revealMeasures(REVEAL_GUARD, revealGen)
}

function svgPxPerUnit(): { px: number; r: DOMRect } | null {
  const svg = svgEl()
  if (!svg) return null
  const r = svg.getBoundingClientRect()
  const vbW = Number(svg.dataset.vbW) || r.width
  return { px: r.width / vbW, r }
}

// 滚动接近前沿时提前补挂，保持「向后铺开」的连续感
scoreEl.addEventListener(
  'scroll',
  () => {
    if (!measureQueue.length) return
    const info = svgPxPerUnit()
    if (!info) return
    const targetUserX = (scoreEl.scrollLeft + scoreEl.clientWidth * 1.5) / info.px
    ensureRevealToUserX(targetUserX)
  },
  { passive: true },
)

function r3(n: number): number {
  return Math.round(n * 1000) / 1000
}
function applyTransform(i: number): void {
  const g = groupMap.get(i)
  if (!g) return
  // 偏移 + 围绕元素自身锚点的缩放（缩放绕 SVG 原点会把远离原点的文字甩飞，
  // Verovio 用户坐标上万，×1.2 即偏移数千单位）——合成逻辑与第三/五页共享
  composeSymbolTransform(g, edits.o[i] ?? null, edits.s[String(i)] ?? 1)
}
function applyText(i: number, val: string): void {
  const g = groupMap.get(i)
  if (!g) return
  // 真实字号在叶子 tspan 上（<text> 级是 font-size="0px" 兜底）——直接对
  // text.textContent 赋值会毁掉 tspan 使字号归零、文字消失；共享版替换叶子内容
  rewriteSymbolText(g, val)
  const txt = g.querySelector('text')
  if (txt) txt.style.fontWeight = edits.bw.includes(i) ? '700' : ''
  const face = edits.fb[String(i)]
  if (face) {
    applySymbolFont(g, face)
    void ensureFontReady(face, val)
  }
}

// ── 视图缩放（滚轮 / 双指；只改显示，与排版无关） ────────────────
function applyScale(): void {
  const svg = svgEl()
  if (!svg) return
  const vbW = Number(svg.dataset.vbW) || 0
  const vbH = Number(svg.dataset.vbH) || 0
  if (vbW > 0) svg.style.width = `${vbW * svgScale}px`
  // 必须同步设高度：svg 带 preserveAspectRatio="none"，只改宽度会让 viewBox 被
  // 横向拉伸（缩放只变宽不变高）；高度随同一系数缩放才是等比视图缩放。
  // 谱表间距/总高仍由 Verovio spacingStaff/spacingSystem 引擎排版（改 vbH 后重排）。
  if (vbH > 0) svg.style.height = `${vbH * svgScale}px`
  zoomEl.textContent = `${Math.round(svgScale * 100)}%`
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  const newScale = Math.min(50, Math.max(0.05, svgScale * factor))
  if (Math.abs(newScale - svgScale) < 0.001) return
  const sr = scoreEl.getBoundingClientRect()
  const ax = scoreEl.scrollLeft + (clientX - sr.left)
  const ay = scoreEl.scrollTop + (clientY - sr.top)
  svgScale = newScale
  applyScale()
  updateCursorGeometry()
  scoreEl.scrollLeft = ax * factor - (clientX - sr.left)
  scoreEl.scrollTop = ay * factor - (clientY - sr.top)
}

scoreEl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015))
  },
  { passive: false },
)

// 双指捏合缩放 + 中点平移（单指仍走原生滚动）
const pinchPointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0
let pinchMid = { x: 0, y: 0 }
// 中键（鼠标）/ 空白处拖动平移整个画布
let midDrag: {
  pointerId: number
  startX: number
  startY: number
  startL: number
  startT: number
} | null = null
scoreEl.addEventListener('pointerdown', (e) => {
  if (e.button === 1) {
    e.preventDefault()
    midDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startL: scoreEl.scrollLeft,
      startT: scoreEl.scrollTop,
    }
    try {
      scoreEl.setPointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    scoreEl.style.cursor = 'grabbing'
    return
  }
  // 只登记触摸/笔：鼠标只有一个 pointerId，登记进来只会积累幽灵条目，
  // 残留一条就会让之后每次单指落下都被当成「第二指捏合」而撤掉拖拽
  if (e.pointerType === 'mouse') return
  pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinchPointers.size === 2) {
    abortPointerDrags()
    const pts = Array.from(pinchPointers.values())
    const a = pts[0]!
    const b = pts[1]!
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
})
window.addEventListener('pointermove', (e) => {
  if (midDrag && e.pointerId === midDrag.pointerId) {
    scoreEl.scrollLeft = midDrag.startL - (e.clientX - midDrag.startX)
    scoreEl.scrollTop = midDrag.startT - (e.clientY - midDrag.startY)
  }
})
window.addEventListener('pointerup', (e) => {
  if (midDrag && e.pointerId === midDrag.pointerId) {
    midDrag = null
    scoreEl.style.cursor = ''
  }
})
scoreEl.addEventListener(
  'pointermove',
  (e) => {
    if (!pinchPointers.has(e.pointerId)) return
    pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchPointers.size === 2) {
      e.preventDefault()
      const pts = Array.from(pinchPointers.values())
      const a = pts[0]!
      const b = pts[1]!
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const newMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (pinchDist > 0) {
        // 以旧中点为锚点缩放
        zoomAt(pinchMid.x, pinchMid.y, d / pinchDist)
        // 中点位移 = 平移画布
        scoreEl.scrollLeft -= newMid.x - pinchMid.x
        scoreEl.scrollTop -= newMid.y - pinchMid.y
      }
      pinchDist = d
      pinchMid = newMid
    }
  },
  { passive: false },
)
const endPinch = (e: PointerEvent): void => {
  pinchPointers.delete(e.pointerId)
  if (pinchPointers.size < 2) pinchDist = 0
}
// 挂 window：手指滑出谱面再抬起时 scoreEl 收不到事件，会留下幽灵指针
window.addEventListener('pointerup', endPinch)
window.addEventListener('pointercancel', endPinch)

// ── 符号拖动（统一列表，只挪像素，不碰乐谱数据） ─────────────────
interface SymDrag {
  index: number
  role: 'note' | 'bar' | 'edit'
  pointerId: number
  startClientX: number
  startClientY: number
  baseX: number
  baseY: number
  /** SVG 用户空间 → 屏幕的逆矩阵（pointerdown 时取，拖动换算绝对精确，
   * 含 preserveAspectRatio/CSS 一切因素——之前用 rect.width/viewBox 推算，
   * 在超大 SVG 下布局宽与实际渲染宽脱节（实测差 22 倍），拖动严重不跟手） */
  ctmInv: DOMMatrix | null
  startSvgX: number
  startSvgY: number
  baseTf: string
  moved: boolean
  /** 手指起手：位移阈值要放宽，手指按住时坐标总会抖几像素，
   * 用鼠标的 2px 判定会把每一次轻点都误判成「拖动」，结果就是点不中元素 */
  touch: boolean
  /** 多选批量拖动：选区内每个成员的起始偏移（整组同 delta） */
  group: { i: number; base: Pt; baseTf: string }[]
}
let drag: SymDrag | null = null

// ── 框选（marquee）：右键空白拖出矩形（左键留给浏览器文字选择，避免冲突）。
// 拖动方向决定模式：上→下 = 与矩形相交即选；下→上 = 完全包含才选 ──
interface Marquee {
  pointerId: number
  x0: number
  y0: number
  el: HTMLDivElement
  additive: boolean
  moved: boolean
}
let marquee: Marquee | null = null

// 谱面内屏蔽浏览器右键菜单（右键 = 框选 / 空白右键 = 添加文字）
innerEl.addEventListener('contextmenu', (e) => e.preventDefault())

innerEl.addEventListener('pointerdown', (e) => {
  // 已有指针在拖/框选：第二根手指只用于捏合缩放，不接管，否则会换掉上一笔的状态
  if (drag && e.pointerId !== drag.pointerId) return
  if (marquee && e.pointerId !== marquee.pointerId) return
  // 触摸也走这条路径（原来在这里直接 return，导致手机上连选中都做不了）：
  // 可拖动符号本来就是 touch-action:none，不吃单指平移，所以
  // 轻点 = 选中、按住拖 = 移动，与鼠标同一套逻辑；只把位移判定放宽。
  const target = e.target as Element
  const editG =
    (target.closest?.(EDIT_SEL) as SVGGElement | null) ??
    (target.closest?.('.md-freetext') as SVGGElement | null)
  const noteG = target.closest?.(NOTE_SEL) as SVGGElement | null
  const barG = target.closest?.(BAR_SEL) as SVGGElement | null
  // 嵌套时最深的可编辑元素优先（音符里的歌词/演奏法）
  const g = (editG ?? noteG ?? barG) as SVGGElement | null
  const svg = svgEl()
  if (!g || !svg) {
    if (e.button === 2) {
      // 右键空白：拖动 = 框选；原地点击 = 添加自由文字
      startMarquee(e, e.ctrlKey || e.metaKey)
      return
    }
    clearSelection()
    return
  }
  if (e.button !== 0) return // 命中元素时仅左键可拖
  const index = groupIdx(g)
  if (index < 0) return
  if (!isFreeIdx(index) && edits.h.includes(index)) return
  // 结构锚点（音符/小节线）：不可拖——提示后直接返回（单击也不进入选择）
  if (lockedSet.has(index) || g.matches(LOCKED_SEL)) {
    setStatus(t('p2.lockedHint'), true)
    return
  }
  while (edits.o.length < totalGroups) edits.o.push(null)
  const off = isFreeIdx(index)
    ? { x: edits.f[freeOf(index)]?.dx ?? 0, y: edits.f[freeOf(index)]?.dy ?? 0 }
    : edits.o[index] ?? { x: 0, y: 0 }
  // 批量拖动：点在已选成员上且多选 → 整组同 delta；否则只拖点中的这个
  const idxs =
    selection.has(index) && selection.size > 1
      ? Array.from(selection)
      : [index]
  drag = {
    index,
    role: editG && g === editG ? 'edit' : 'bar',
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    touch: e.pointerType === 'touch',
    ctmInv: (() => {
      try {
        // 父层坐标系（translate 写在父系）：元素自身 CTM 含 baseTf（translate/scale），
        // 在其局部测得的位移再写到父系会错位（baseTf 带 scale 的谱会拖飞）
        const m = (g.parentElement as unknown as SVGGraphicsElement).getScreenCTM()
        return m ? m.inverse() : null
      } catch {
        return null
      }
    })(),
    startSvgX: 0,
    startSvgY: 0,
    baseX: off.x,
    baseY: off.y,
    baseTf: g.dataset.baseTf ?? '',
    moved: false,
    // 起始偏移：自由文字存于 ft.dx/dy（edits.o 没有它的槽位），普通元素存于 edits.o
    group: idxs.map((i) => ({
      i,
      base: isFreeIdx(i)
        ? { x: edits.f[freeOf(i)]?.dx ?? 0, y: edits.f[freeOf(i)]?.dy ?? 0 }
        : edits.o[i] ?? { x: 0, y: 0 },
      baseTf: groupMap.get(i)?.dataset.baseTf ?? '',
    })),
  }
  if (drag.ctmInv) {
    const p0 = new DOMPoint(e.clientX, e.clientY).matrixTransform(drag.ctmInv)
    drag.startSvgX = p0.x
    drag.startSvgY = p0.y
  }
  for (const m of drag.group)
    groupMap.get(m.i)?.classList.add('is-dragging')
  e.preventDefault()
})

window.addEventListener('pointermove', (e) => {
  if (marquee) {
    if (e.pointerId === marquee.pointerId) updateMarquee(e)
    return
  }
  if (!drag || e.pointerId !== drag.pointerId) return
  const d = drag
  let dx: number, dy: number
  if (d.ctmInv) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(d.ctmInv)
    dx = p.x - d.startSvgX
    dy = p.y - d.startSvgY
  } else {
    dx = (e.clientX - d.startClientX) / 3
    dy = (e.clientY - d.startClientY) / 3
  }
  // 手指按住时坐标天然会抖，阈值放宽到 9px：用鼠标的 2px 判定会把每一次轻点
  // 都算成「拖动过」，而 pointerup 里拖动过就不走选中分支 → 手机上点不中元素
  const th = d.touch ? 9 : 2
  if (Math.abs(e.clientX - d.startClientX) > th || Math.abs(e.clientY - d.startClientY) > th) {
    d.moved = true
  }
  if (!d.moved) return // 还没过阈值：元素保持原位，别跟着手的抖动微调
  for (const m of d.group) {
    const x = m.base.x + dx
    const y = m.base.y + dy
    const g = groupMap.get(m.i)
    if (isFreeIdx(m.i)) {
      // 自由文字的显示位置 = 锚点(ft.x/ft.y) + 偏移(dx/dy)：拖动写 transform 时
      // 必须带上锚点——只写 translate(dx dy) 会让文字瞬间飞向 SVG 原点
      const ft = edits.f[freeOf(m.i)]
      if (ft) {
        ft.dx = x
        ft.dy = y
        g?.setAttribute('transform', `translate(${r3(ft.x + x)} ${r3(ft.y + y)})`)
      }
    } else {
      edits.o[m.i] = { x, y }
      // 与 applyTransform 同一合成（拖动中保持缩放不丢；缩放围绕元素锚点）
      if (g) composeSymbolTransform(g, { x, y }, edits.s[String(m.i)] ?? 1)
    }
  }
})

window.addEventListener('pointerup', (e) => {
  if (marquee) {
    if (e.pointerId === marquee.pointerId) finishMarquee(e)
    return
  }
  if (!drag || e.pointerId !== drag.pointerId) return
  const d = drag
  drag = null
  for (const m of d.group)
    groupMap.get(m.i)?.classList.remove('is-dragging')
  const g = groupMap.get(d.index)
  if (!d.moved) {
    // 单击：edit 元素进入选择；音符 / 小节线不选
    if (d.role === 'edit') handleEditClick(d.index, e)
    return
  }
  while (edits.o.length < totalGroups) edits.o.push(null)
  saveEdits()
  if (d.role === 'edit' && selection.size === 0) selectOnly(d.index)
  setStatus(t('p2.dragMoved'))
})

// 手势被系统判成平移/中断（pointercancel），或第二根手指进入捏合：必须清掉
// drag/marquee，否则状态卡在上一笔上，之后每一次轻点都落在残留里——选不中，也拖不动。
function abortPointerDrags(): void {
  if (drag) {
    for (const m of drag.group) groupMap.get(m.i)?.classList.remove('is-dragging')
    drag = null
  }
  if (marquee) {
    marquee.el.remove()
    marquee = null
  }
}
window.addEventListener('pointercancel', (e) => {
  // 只是另一根手指（捏合的辅助指）被判成平移时，别打断正在进行的拖拽
  if (drag && e.pointerId !== drag.pointerId) return
  if (marquee && e.pointerId !== marquee.pointerId) return
  abortPointerDrags()
})

// ── 框选实现：屏幕坐标矩形；命中判定用 getBoundingClientRect。
// 方向双模式：上→下 = 相交即选；下→上 = 完全包含才选 ──
function startMarquee(e: PointerEvent, additive: boolean): void {
  if (marquee) return
  const el = document.createElement('div')
  el.className = 'md-marquee'
  document.body.appendChild(el)
  marquee = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, el, additive, moved: false }
  updateMarquee(e)
}
function updateMarquee(e: PointerEvent): void {
  if (!marquee) return
  // 位移超过阈值才算框选拖动（原地右键 = 添加文字）
  if (Math.abs(e.clientX - marquee.x0) > 3 || Math.abs(e.clientY - marquee.y0) > 3) marquee.moved = true
  if (!marquee.moved) return
  const x = Math.min(marquee.x0, e.clientX)
  const y = Math.min(marquee.y0, e.clientY)
  const w = Math.abs(e.clientX - marquee.x0)
  const h = Math.abs(e.clientY - marquee.y0)
  Object.assign(marquee.el.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  })
  // 模式由拖动方向决定（下→上 = 包含）
  const contain = e.clientY < marquee.y0
  marquee.el.classList.toggle('md-marquee--contain', contain)
  const rect = { l: x, t: y, r: x + w, b: y + h }
  groupMap.forEach((g, i) => {
    if (lockedSet.has(i) || edits.h.includes(i)) return
    if (!g.matches(EDIT_SEL) && !g.classList.contains('md-freetext')) return
    const bb = g.getBoundingClientRect()
    const hit = contain
      ? bb.left >= rect.l && bb.right <= rect.r && bb.top >= rect.t && bb.bottom <= rect.b
      : bb.left < rect.r && bb.right > rect.l && bb.top < rect.b && bb.bottom > rect.t
    g.classList.toggle('md-marquee-hit', hit)
  })
}
function finishMarquee(_e: PointerEvent): void {
  if (!marquee) return
  const m = marquee
  marquee = null
  const hits: number[] = []
  groupMap.forEach((g, i) => {
    if (g.classList.contains('md-marquee-hit')) {
      g.classList.remove('md-marquee-hit')
      hits.push(i)
    }
  })
  m.el.remove()
  if (!m.moved) {
    // 原地右键空白 = 添加自由文字（在按下点）
    startFreeText(m.x0, m.y0)
    return
  }
  if (m.additive) for (const i of hits) selection.add(i)
  else {
    selection.clear()
    for (const i of hits) selection.add(i)
  }
  renderSelection()
  if (hits.length) setStatus(t('p2.selected', { n: hits.length }))
}

// ── 自由文字（右键空白原地添加）：edits.f[i] ↔ data-idx = FREE_BASE + i ──
const FREE_BASE = 100000
const freeIdx = (i: number): number => FREE_BASE + i
const isFreeIdx = (i: number): boolean => i >= FREE_BASE
const freeOf = (i: number): number => i - FREE_BASE

/** 屏幕→SVG 用户坐标（getScreenCTM 精确逆变换） */
function clientToSvgUnit(cx: number, cy: number): Pt {
  const svg = innerScoreSvg()
  if (!svg) return { x: cx, y: cy }
  try {
    const m = svg.getScreenCTM()
    if (!m) return { x: cx, y: cy }
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  } catch {
    return { x: cx, y: cy }
  }
}

/** 原地右键空白：浮层输入 → 确认后新增自由文字 */
function startFreeText(clientX: number, clientY: number): void {
  const svg = svgEl()
  if (!svg) return
  const inp = document.createElement('input')
  inp.className = 'md-textedit'
  inp.placeholder = t('p2.freeTextPH')
  inp.style.left = `${clientX}px`
  inp.style.top = `${clientY - 14}px`
  inp.style.width = '180px'
  inp.style.height = '26px'
  document.body.appendChild(inp)
  bringToFront(inp)
  inp.focus()
  let done = false
  const finish = (commit: boolean): void => {
    if (done) return
    done = true
    const v = inp.value.trim()
    inp.remove()
    if (!commit || !v) return
    const p = clientToSvgUnit(clientX, clientY)
    edits.f.push({ x: p.x, y: p.y, txt: v, dx: 0, dy: 0 })
    saveEdits()
    renderFreeTexts()
    setStatus(t('p2.freeTextAdded'))
  }
  inp.addEventListener('blur', () => finish(true))
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  })
}

/** 确保「曲名标题」存在：首进谱面时把 midee.name 生成为左上角自由文字（与乐器名同行同字号），
 * 用户可拖/删/改（删了就不再自动出现——尊重用户编辑） */
function ensureTitleText(): void {
  if (edits.f.some((x) => x.isTitle)) return
  const name = sessionStorage.getItem('midee.name')?.trim()
  if (!name) return
  // 位置：与乐器名 label 同一基线（label 一般在首行上方）；字号与 label 相同（405）
  const svg0 = innerScoreSvg()
  let x = 400, y = 3043
  const label = svg0?.querySelector('g.label text')
  if (label) {
    x = parseFloat(label.getAttribute('x') ?? '400') - 20
    y = parseFloat(label.getAttribute('y') ?? '3043') - 420 // 比乐器名再高一行
  }
  // ── 自动向上避让 ──
  // 内层坐标系里谱顶上方其实有一段页面空当（实测 ≈587 单位，第一个谱表线在 618），
  // 而 label 本身嵌在系统里、「再高一行」的默认落点（基线 ≈1031）正好压在音符上。
  // 这里把第一个谱表系统的上沿映射回标题所在空间，基线抬到它上方；
  // 剩余空当不够一整行时就贴着音乐放，字顶绝不越出页面。
  const sys = svg0?.querySelector('g.system') as SVGGraphicsElement | null
  const ctm = svg0?.getScreenCTM()
  if (svg0 && sys && ctm && ctm.d) {
    const inv = ctm.inverse()
    const target = (sys.querySelector('g.staff') ?? sys) as SVGGraphicsElement
    const tr = target.getBoundingClientRect()
    const musicTop = new DOMPoint(tr.left, tr.top).matrixTransform(inv).y
    const fs = 405
    const ascent = fs * 1.16 // 实测字面：基线上方 ≈1.16×字号（含 CJK 行高）
    const descent = fs * 0.28
    const left = musicTop - ascent - descent // 顶边留 0 之后还能再往下让多少间距
    const gap = left > 0 ? Math.min(fs * 0.3, left) : 0
    const yWanted = musicTop - descent - gap
    y = Math.min(y, yWanted)
    y = Math.max(y, ascent * 0.9) // 字形别顶出页面
  }
  edits.f.push({ x, y, txt: name, dx: 0, dy: 0, isTitle: true })
}

/** 改名后把谱面上那条曲名自由文字就地换掉。
 *  renderScoreTitle() 如今只负责藏起早年那个「固定标题 DOM」，真正的谱面标题是
 *  ensureTitleText 生成的可拖动元素；而它只要已存在就直接 return，不重写文字 ——
 *  于是顶栏改名、标题面板改 title 都只改到 sessionStorage/meta，画面上永远是旧名。 */
function syncTitleFreeText(name: string): void {
  const ft = edits.f.find((x) => x.isTitle)
  if (!ft || ft.txt === name) return // 还没生成（或用户已删）：交给 ensureTitleText 下一次补
  ft.txt = name
  renderFreeTexts()
  saveEdits()
}

/** 把 edits.f 全部渲染成可拖可删的谱面元素（data-idx = FREE_BASE+i） */
function renderFreeTexts(): void {
  const svg = innerScoreSvg()
  if (!svg) return
  const SVG_NS = 'http://www.w3.org/2000/svg'
  svg.querySelectorAll('g.md-freetext').forEach((g) => g.remove())
  edits.f.forEach((ft, i) => {
    const idx = freeIdx(i)
    if (ft.hidden) {
      groupMap.delete(idx)
      return
    }
    const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
    g.setAttribute('data-idx', String(idx))
    g.setAttribute('data-baseTf', '')
    g.classList.add('md-freetext', 'md-drag', 'md-edit')
    const txt = document.createElementNS(SVG_NS, 'text')
    txt.textContent = ft.txt
    txt.setAttribute('font-size', String(Math.round(405 * (ft.sc ?? 1))))
    txt.setAttribute('font-weight', ft.bold ? '700' : '400')
    txt.setAttribute('fill', '#111')
    if (ft.face) {
      applyTextFace(txt, ft.face)
      void ensureFontReady(ft.face, ft.txt)
    }
    g.appendChild(txt)
    g.setAttribute('transform', `translate(${r3(ft.x + ft.dx)} ${r3(ft.y + ft.dy)})`)
    svg.appendChild(g)
    groupMap.set(idx, g)
  })
}

// ── 选择 / 操作小工具条 / 双击改文字 ────────────────────────────
const selection = new Set<number>()
let hoverIdx: number | null = null
let hoverTimer: number | undefined
let popKeep = false

const pop = document.createElement('div')
pop.className = 'md-editpop'
pop.hidden = true
pop.innerHTML = `
  <div class="md-editpop-row">
    <span data-slot="face" data-i18n-title="p2.font"></span>
    <button type="button" data-act="bigger" data-i18n-title="p2.fontBigger">A+</button>
    <button type="button" data-act="smaller" data-i18n-title="p2.fontSmaller">A−</button>
    <button type="button" data-act="bold" data-i18n-title="p2.fontBold"><b>B</b></button>
  </div>
  <div class="md-editpop-row">
    <button type="button" data-act="reset" data-i18n="p2.edit.reset"></button>
    <button type="button" data-act="similar" data-i18n="p2.edit.similar"></button>
    <button type="button" data-act="delete" class="is-danger" data-i18n="p2.edit.delete"></button>
  </div>`
document.body.appendChild(pop)
const popReset = pop.querySelector<HTMLButtonElement>('button[data-act="reset"]')!
const popSimilar = pop.querySelector<HTMLButtonElement>('button[data-act="similar"]')!
const popDel = pop.querySelector<HTMLButtonElement>('button[data-act="delete"]')!
const popBigger = pop.querySelector<HTMLButtonElement>('button[data-act="bigger"]')!
const popSmaller = pop.querySelector<HTMLButtonElement>('button[data-act="smaller"]')!
const popBold = pop.querySelector<HTMLButtonElement>('button[data-act="bold"]')!
// 字体下拉改用外壳自绘的 createSelect：原生 <select> 的弹层在触屏上是系统 UI，
// 既不跟主题也没有统一样式，而这条工具条是浮在谱面上的 HUD，更不能跟着跑偏。
const popFaceSlot = pop.querySelector<HTMLElement>('[data-slot="face"]')!
const popFace = createSelect({
  // FONT_CHOICES[0] 就是 key='' 的「默认」，不用再补一项
  options: FONT_CHOICES.map((c) => ({ v: c.key, l: c.label })),
  value: '',
  onChange: (key) => applyFace(key),
  ariaLabel: t('p2.font'),
})
popFaceSlot.append(popFace.el)
applyI18n(pop)

pop.addEventListener('pointerenter', () => {
  popKeep = true
})
pop.addEventListener('pointerleave', () => {
  popKeep = false
})
popReset.addEventListener('click', () => {
  for (const i of actionTargets()) {
    if (!isTextual(i)) continue // 音乐字形（tuplet 数字等）不缩放
    if (isFreeIdx(i)) {
      const ft = edits.f[freeOf(i)]
      if (ft) { ft.dx = 0; ft.dy = 0 }
    } else {
      edits.o[i] = null
      applyTransform(i)
    }
  }
  renderFreeTexts()
  saveEdits()
  setStatus(t('p2.resetDone'))
})
popSimilar.addEventListener('click', () => {
  const first = actionTargets()[0]
  const g = first !== undefined ? groupMap.get(first) : null
  if (first === undefined || !g) return
  const scope = g.closest('g.system') ?? svgEl()
  const cls = g.classList[0]
  selection.clear()
  if (scope && cls) {
    scope.querySelectorAll<SVGGElement>(EDIT_SEL).forEach((node) => {
      const ni = groupIdx(node)
      if (ni >= 0 && node.classList.contains(cls) && !node.classList.contains('md-hidden')) {
        selection.add(ni)
      }
    })
  }
  renderSelection()
  setStatus(t('p2.selected', { n: selection.size }))
})
popDel.addEventListener('click', deleteSelected)

// 文本缩放 / 加粗：普通符号写 edits.s/edits.bw；自由文字写 ft.sc/ft.bold
  const isTextual = (i: number): boolean => !!groupMap.get(i)?.querySelector('text')
const scaleTargets = (delta: number): void => {
  for (const i of actionTargets()) {
    if (!isTextual(i)) continue // 仅文本可缩放：音乐字形（use 矢量）无文字锚点，缩放会甩飞
    if (isFreeIdx(i)) {
      const ft = edits.f[freeOf(i)]
      if (ft) ft.sc = Math.min(4, Math.max(0.4, (ft.sc ?? 1) * delta))
    } else {
      const cur = edits.s[String(i)] ?? 1
      edits.s[String(i)] = Math.min(4, Math.max(0.4, cur * delta))
      applyTransform(i)
    }
  }
  renderFreeTexts()
  saveEdits()
}
popBigger.addEventListener('click', () => scaleTargets(1.2))
popSmaller.addEventListener('click', () => scaleTargets(1 / 1.2))
popBold.addEventListener('click', () => {
  for (const i of actionTargets()) {
    if (!isTextual(i)) continue // 音乐字形不加粗
    if (isFreeIdx(i)) {
      const ft = edits.f[freeOf(i)]
      if (ft) ft.bold = !ft.bold
    } else {
      const at = edits.bw.indexOf(i)
      if (at >= 0) edits.bw.splice(at, 1)
      else edits.bw.push(i)
      applyText(i, edits.x[String(i)] ?? groupMap.get(i)?.querySelector('text')?.textContent ?? '')
    }
  }
  renderFreeTexts()
  saveEdits()
})

/** 该 group 是否只有音乐字形文字（Bravura tspan / 无 text）——这类不支持换字体 */
function musicOnlyGroup(g: Element): boolean {
  if (isFreeIdx(Number(g.getAttribute('data-idx') ?? -1))) return false
  const text = g.querySelector('text')
  if (!text) return true
  const tspans = Array.from(text.querySelectorAll('tspan'))
  if (!tspans.length) return false
  return tspans.every((ts) => (ts.getAttribute('font-family') ?? '').includes('Bravura'))
}
/** 元素当前字体 key（自由文字读 ft.face，谱面符号读 edits.fb） */
function faceOf(i: number): string {
  if (isFreeIdx(i)) return edits.f[freeOf(i)]?.face ?? ''
  return edits.fb[String(i)] ?? ''
}
function setFace(i: number, key: string): void {
  if (isFreeIdx(i)) {
    const ft = edits.f[freeOf(i)]
    if (!ft) return
    if (key) ft.face = key
    else delete ft.face
    return
  }
  if (key) edits.fb[String(i)] = key
  else delete edits.fb[String(i)]
  const g = groupMap.get(i)
  if (g) applySymbolFont(g, key)
}
function applyFace(key: string): void {
  for (const i of actionTargets()) {
    if (!isTextual(i)) continue // 音乐字形没有可选字体
    setFace(i, key)
  }
  if (key) {
    // 用被改元素里真实出现的文字预热分片（换了语言就换对应的脚本字库）
    const sample = actionTargets()
      .map((i) =>
        isFreeIdx(i) ? (edits.f[freeOf(i)]?.txt ?? '') : (groupMap.get(i)?.textContent ?? ''),
      )
      .join('')
    void ensureFontReady(key, sample)
  }
  renderFreeTexts()
  saveEdits()
}

function actionTargets(): number[] {
  // 锁定项（音符/小节线）绝不进入操作目标——防止历史选择集/悬停索引带出结构锚点
  const out: number[] = []
  const push = (i: number): void => {
    if (!lockedSet.has(i) && !out.includes(i)) out.push(i)
  }
  if (selection.size) {
    for (const i of selection) push(i)
    return out
  }
  if (hoverIdx !== null) push(hoverIdx)
  return out
}

let rangeAnchor: number | null = null
function handleEditClick(index: number, e: PointerEvent): void {
  if (e.shiftKey && rangeAnchor !== null && rangeAnchor !== index) {
    // Shift = 从锚点到当前的范围内全选（可编辑元素，按统一序号）
    const lo = Math.min(rangeAnchor, index)
    const hi = Math.max(rangeAnchor, index)
    selection.clear()
    groupMap.forEach((g, i) => {
      if (i >= lo && i <= hi && !lockedSet.has(i) && !edits.h.includes(i)) {
        if (g.matches(EDIT_SEL) || g.classList.contains('md-freetext')) selection.add(i)
      }
    })
    renderSelection()
    setStatus(t('p2.selected', { n: selection.size }))
    return
  }
  rangeAnchor = index
  if (e.ctrlKey || e.metaKey) {
    if (selection.has(index)) selection.delete(index)
    else selection.add(index)
  } else if (selection.size !== 1 || !selection.has(index)) {
    selectOnly(index)
  }
  renderSelection()
}
function selectOnly(index: number): void {
  selection.clear()
  selection.add(index)
}
function clearSelection(): void {
  groupMap.forEach((g) => g.classList.remove('md-marquee-hit'))
  if (!selection.size) return
  selection.clear()
  renderSelection()
}
function renderSelection(): void {
  groupMap.forEach((g, i) => g.classList.toggle('md-sel', selection.has(i)))
}
function deleteSelected(): void {
  const targets = actionTargets()
  if (!targets.length) return
  for (const i of targets) {
    const ft = edits.f[freeOf(i)]
    if (ft) ft.hidden = true
    else if (!edits.h.includes(i)) edits.h.push(i)
    selection.delete(i)
    groupMap.get(i)?.classList.add('md-hidden')
  }
  renderFreeTexts()
  saveEdits()
  renderSelection()
  setStatus(t('p2.deleted', { n: targets.length }))
}

document.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement | null
  const typing =
    tgt?.tagName === 'INPUT' ||
    tgt?.tagName === 'TEXTAREA' ||
    tgt?.tagName === 'SELECT' ||
    !!tgt?.isContentEditable ||
    // 自绘下拉是 <button>：展开时 Delete/Esc 归它，不能再删符号/清选择集
    isSelectUI(e.target)
  if (typing) return
  if (document.querySelector('.sh-modal:not([hidden])')) return
  if (e.key === 'Delete' || e.key === 'Backspace' || (e.key === 'd' && (e.ctrlKey || e.metaKey))) {
    if (selection.size) {
      e.preventDefault()
      deleteSelected()
    }
    return
  }
  if (e.key === 'Escape') {
    clearSelection()
    return
  }
  const arrowMap: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const dir = arrowMap[e.key]
  if (dir) {
    // Alt+方向键：微调选中符号（SVG 用户单位；Shift=×10 加速）——不抢占纯方向键的滚动
    if (e.altKey && selection.size) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      while (edits.o.length < totalGroups) edits.o.push(null)
      for (const i of actionTargets()) {
        if (isFreeIdx(i)) {
          const ft = edits.f[freeOf(i)]
          if (ft) { ft.dx += dir[0] * step; ft.dy += dir[1] * step }
        } else {
          const base = edits.o[i] ?? { x: 0, y: 0 }
          edits.o[i] = { x: base.x + dir[0] * step, y: base.y + dir[1] * step }
          applyTransform(i)
        }
      }
      renderFreeTexts()
      saveEdits()
      return
    }
    e.preventDefault()
    const k = e.shiftKey ? 0.5 : 1 / 12
    scoreEl.scrollBy({ left: dir[0] * scoreEl.clientWidth * k, top: dir[1] * scoreEl.clientHeight * k })
  }
})

// 悬停可调整元素 → 小工具条延时出现
innerEl.addEventListener('pointerover', (e) => {
  const t0 = e.target as Element
  const g =
    (t0.closest?.(EDIT_SEL) as SVGGElement | null) ??
    (t0.closest?.('.md-freetext') as SVGGElement | null)
  if (!g || g.classList.contains('md-hidden')) {
    hoverIdx = null
    return
  }
  window.clearTimeout(hoverTimer)
  const idx = groupIdx(g)
  hoverTimer = window.setTimeout(() => {
    hoverIdx = idx
  }, 220)
})
innerEl.addEventListener('pointerout', () => {
  window.clearTimeout(hoverTimer)
  if (!popKeep) hoverIdx = null
})

// 双击文字类元素 → 浮层输入框
innerEl.addEventListener('dblclick', (e) => {
  const t0 = e.target as Element
  const g =
    (t0.closest?.(EDIT_SEL) as SVGGElement | null) ??
    (t0.closest?.('.md-freetext') as SVGGElement | null)
  if (!g || !g.querySelector('text')) return
  const idx = groupIdx(g)
  if (idx < 0) return
  startTextEdit(g, idx)
})

function startTextEdit(g: SVGGElement, idx: number): void {
  const txt = g.querySelector('text')
  if (!txt) return
  const cur = isFreeIdx(idx)
    ? (edits.f[freeOf(idx)]?.txt ?? '')
    : (edits.x[String(idx)] ?? txt.textContent ?? '').trim()
  const r = txt.getBoundingClientRect()
  const inp = document.createElement('input')
  inp.className = 'md-textedit'
  inp.value = cur
  inp.style.left = `${r.left}px`
  inp.style.top = `${r.top - 1}px`
  inp.style.width = `${Math.max(64, r.width + 14)}px`
  inp.style.height = `${r.height + 4}px`
  document.body.appendChild(inp)
  bringToFront(inp)
  inp.focus()
  inp.select()
  let done = false
  const finish = (commit: boolean): void => {
    if (done) return
    done = true
    if (commit) {
      const v = inp.value.trim()
      if (isFreeIdx(idx)) {
        const ft = edits.f[freeOf(idx)]
        if (ft && v) ft.txt = v
        renderFreeTexts()
      } else {
        if (v) edits.x[String(idx)] = v
        else delete edits.x[String(idx)]
        applyText(idx, v || (txt.textContent ?? ''))
      }
      saveEdits()
    }
    inp.remove()
  }
  inp.addEventListener('blur', () => finish(true))
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  })
}

// 小工具条定位（每帧跟随符号 / 滚动）
// ── 缩放手柄（选中文本的右下角小方块；拖动 = 缩放）──
const scaleHandle = document.createElement('div')
scaleHandle.className = 'md-scale-handle'
scaleHandle.hidden = true
bindTip(scaleHandle, () => t('p2.scaleHint'))
document.body.appendChild(scaleHandle)
interface ScaleDrag {
  idx: number
  pointerId: number
  cx0: number
  cy0: number
  d0: number
  base: number
}
let scaleDrag: ScaleDrag | null = null
scaleHandle.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  e.stopPropagation()
  if (scaleDrag && e.pointerId !== scaleDrag.pointerId) return
  const idx = Number(scaleHandle.dataset.idx)
  if (!Number.isFinite(idx)) return
  const g = groupMap.get(idx)
  if (!g) return
  const bb = g.getBoundingClientRect()
  const cx0 = bb.x + bb.width / 2
  const cy0 = bb.y + bb.height / 2
  const base = isFreeIdx(idx) ? edits.f[freeOf(idx)]?.sc ?? 1 : edits.s[String(idx)] ?? 1
  scaleDrag = { idx, pointerId: e.pointerId, cx0, cy0, d0: Math.max(8, Math.hypot(e.clientX - cx0, e.clientY - cy0)), base }
  try { scaleHandle.setPointerCapture(e.pointerId) } catch { /* 合成事件无活动指针 */ }
})
scaleHandle.addEventListener('pointermove', (e) => {
  if (!scaleDrag || e.pointerId !== scaleDrag.pointerId) return
  const d = Math.max(8, Math.hypot(e.clientX - scaleDrag.cx0, e.clientY - scaleDrag.cy0))
  const sc = Math.min(4, Math.max(0.4, scaleDrag.base * (d / scaleDrag.d0)))
  const i = scaleDrag.idx
  if (isFreeIdx(i)) {
    const ft = edits.f[freeOf(i)]
    if (ft) ft.sc = sc
    renderFreeTexts()
  } else {
    edits.s[String(i)] = sc
    applyTransform(i)
  }
})
const endScaleDrag = (e: PointerEvent): void => {
  if (!scaleDrag || e.pointerId !== scaleDrag.pointerId) return
  scaleDrag = null
  saveEdits()
}
scaleHandle.addEventListener('pointerup', endScaleDrag)
scaleHandle.addEventListener('pointercancel', endScaleDrag)

function updatePopover(): void {
  let anchorIdx: number | null = null
  if (selection.size) anchorIdx = Math.min(...selection)
  else if (hoverIdx !== null && !popKeep) anchorIdx = hoverIdx
  else if (hoverIdx !== null) anchorIdx = hoverIdx
  const g = anchorIdx !== null ? groupMap.get(anchorIdx) ?? null : null
  if (!g || g.classList.contains('md-hidden')) {
    pop.hidden = true
    scaleHandle.hidden = true
    return
  }
  pop.hidden = false
  bringToFront(pop)
  // 字体下拉：纯音乐字形（Bravura）与无文字的 group 不可换字体
  const canFace = !musicOnlyGroup(g)
  popFaceSlot.hidden = !canFace
  popFace.setValue(canFace ? faceOf(anchorIdx as number) : '')
  const r = g.getBoundingClientRect()
  // 缩放手柄：仅文本类（有 text 子元素；音乐字形不给）
  const textual = !!g.querySelector('text') && !g.classList.contains('md-hidden')
  if (textual && !pop.hidden) {
    scaleHandle.hidden = false
    scaleHandle.dataset.idx = String(anchorIdx)
    scaleHandle.style.left = `${r.right - 7}px`
    scaleHandle.style.top = `${r.bottom - 7}px`
  } else {
    scaleHandle.hidden = true
  }
  pop.style.visibility = r.width === 0 && r.height === 0 ? 'hidden' : ''
  const pw = pop.offsetWidth || 180
  const x = Math.min(window.innerWidth - pw / 2 - 8, Math.max(pw / 2 + 8, r.left + r.width / 2))
  // 两行工具条比原来高，按实际高度上翻，避免压住被点中的文字
  const ph = pop.offsetHeight || 34
  const above = r.top - ph - 8
  if (above > 8) {
    pop.style.top = `${above}px`
  } else {
    pop.style.top = `${r.bottom + 8}px`
  }
  pop.style.left = `${x}px`
}

// ── 标题（乐谱上一行靠左：名称 —— 作者；工具栏可添加） ──────────
const META_KEY = 'midee.scoreMeta'
interface ScoreMeta {
  title?: string
  author?: string
}
function loadMeta(): ScoreMeta {
  try {
    return (JSON.parse(sessionStorage.getItem(META_KEY) ?? '{}')) as ScoreMeta
  } catch {
    return {}
  }
}
function saveMeta(): void {
  dirty = true
  try {
    sessionStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {
    /* noop */
  }
}
let meta: ScoreMeta = loadMeta()

function xmlTitle(): string {
  const doc = xmlDoc
  if (!doc) return ''
  const pick = (tag: string): string =>
    doc.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ''
  return pick('work-title') || pick('movement-title') || pick('work-number')
}
function xmlAuthor(): string {
  const doc = xmlDoc
  if (!doc) return ''
  const creators = Array.from(doc.getElementsByTagName('creator'))
  const c =
    creators.find((n) => n.getAttribute('type') === 'composer') ??
    creators.find((n) => n.getAttribute('type') === 'lyricist') ??
    creators[0]
  return c?.textContent?.trim() ?? ''
}
function renderScoreTitle(): void {
  // 固定的非元素标题（与顶栏重复）已取消；曲名改由可拖动自由文字元素呈现（ensureTitleText）
  scoreTitleEl.hidden = true
}

function buildTitlePanel(): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sh-titleform'
  const mk = (key: 'title' | 'author', labelKey: string, phKey: string): void => {
    const lab = document.createElement('label')
    const k = document.createElement('span')
    k.className = 'k'
    k.textContent = t(labelKey)
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.value = meta[key] ?? (key === 'title' ? xmlTitle() : xmlAuthor())
    inp.placeholder = t(phKey)
    inp.addEventListener('input', () => {
      meta[key] = inp.value
      saveMeta()
      renderScoreTitle()
      // 曲名那条是谱面上的可拖动文字，必须同步；作者名仍只走 meta（由导出/别处消费）
      if (key === 'title') syncTitleFreeText(inp.value)
    })
    lab.append(k, inp)
    box.append(lab)
  }
  mk('title', 'p2.titleName', 'p2.titleNamePh')
  mk('author', 'p2.titleAuthor', 'p2.titleAuthorPh')
  return box
}

// ── 播放 + 光标（光标按音符时间对齐，不按总长平分） ─────────────
let player: MideePlayer | null = null
let bar: PlayerBarHandle | null = null
let trackPanel: TrackPanelHandle | null = null
interface Anchor {
  t: number
  x: number
}
let anchors: Anchor[] = []

/**
 * 时间→谱面 x 锚点：直接采用 Verovio timemap（id↔时间的权威映射），
 * 不再做「可视符头数 vs MIDI 事件数」的序号硬配对——webmscore 忠实处理
 * 延音线后，被 tie 的符头不重新起音，硬配对必然逐拍错位。
 * timemap 的 on[] 给的是该时刻发声/进入的符头 id（tie 延续音也在其小节
 * 边界时刻出现，正好对应它在新小节的符头位置）；装饰音不参与时间锚点。
 * 未挂载小节的 id 查不到 DOM，会在小节补挂后重新构建。
 */
function buildAnchors(): void {
  anchors = []
  const svg = svgEl()
  const p = player
  if (!svg || !p || !p.duration || !timemapRows.length) return
  const r = svg.getBoundingClientRect()
  const vbW = Number(svg.dataset.vbW) || r.width
  const pxPerUnit = r.width / vbW
  if (!pxPerUnit || !Number.isFinite(pxPerUnit)) return

  // tstamp(ms) → 该时刻所有锚点 x（和弦/多声部可能多点，取均值代表光标列）
  const byTime = new Map<number, number[]>()
  for (const row of timemapRows) {
    if (!row.on || row.tstamp === undefined) continue
    const xs: number[] = []
    for (const id of row.on) {
      const g = svg.querySelector<SVGGElement>(`#${CSS.escape(id)}`)
      if (!g) continue // 小节尚未挂载
      if (g.classList.contains('grace') || g.closest('g.grace')) continue // 装饰音不占时间锚点
      const nr = g.getBoundingClientRect()
      if (!nr.width) continue
      const idx = groupIdx(g)
      const off = idx >= 0 ? (edits.o[idx]?.x ?? 0) : 0
      // breaks=none 单长条：屏幕矩形反算根用户坐标，再扣掉拖动偏移
      xs.push((nr.left + nr.width / 2 - r.left) / pxPerUnit - off)
    }
    if (!xs.length) continue
    const arr = byTime.get(row.tstamp)
    if (arr) arr.push(...xs)
    else byTime.set(row.tstamp, xs)
  }
  const pairs: Anchor[] = [...byTime.entries()]
    .map(([ms, xs]) => ({ t: ms / 1000, x: xs.reduce((a, b) => a + b, 0) / xs.length }))
    .sort((a, b) => a.t - b.t)
  for (const pt of pairs) {
    const last = anchors[anchors.length - 1]
    if (!last || Math.abs(pt.x - last.x) > 3) anchors.push(pt)
  }
}

function timeToX(t: number): number | null {
  if (!anchors.length) return null
  if (t <= anchors[0]!.t) return anchors[0]!.x
  const last = anchors[anchors.length - 1]!
  if (t >= last.t) return last.x
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!
    const b = anchors[i]!
    if (t <= b.t) {
      const u = (t - a.t) / (b.t - a.t || 1)
      return a.x + (b.x - a.x) * u
    }
  }
  return last.x
}
function xToTime(x: number): number | null {
  if (!anchors.length) return null
  if (x <= anchors[0]!.x) return anchors[0]!.t
  const last = anchors[anchors.length - 1]!
  if (x >= last.x) return last.t
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!
    const b = anchors[i]!
    if (x <= b.x) {
      const u = (x - a.x) / (b.x - a.x || 1)
      return a.t + (b.t - a.t) * u
    }
  }
  return last.t
}

function cursorLeftForX(userX: number): number {
  const svg = svgEl()
  if (!svg) return 0
  const r = svg.getBoundingClientRect()
  const ir = innerEl.getBoundingClientRect()
  const vbW = Number(svg.dataset.vbW) || r.width
  return r.left - ir.left + (userX / vbW) * r.width
}

function updateCursorGeometry(): void {
  const svg = svgEl()
  if (!svg || !player || player.duration <= 0) {
    cursorEl.hidden = true
    return
  }
  const r = svg.getBoundingClientRect()
  cursorEl.style.top = `${r.top - innerEl.getBoundingClientRect().top}px`
  cursorEl.style.height = `${r.height}px`
  moveCursor(player.currentTime)
}

function moveCursor(time: number): void {
  const svg = svgEl()
  if (!svg || !player || player.duration <= 0) {
    cursorEl.hidden = true
    return
  }
  // 播放前沿：保证光标前方约 1.5 屏的小节已铺开，补挂后锚点刷新再取 x
  if (measureQueue.length) {
    const info = svgPxPerUnit()
    if (info) {
      const lastX = anchors.length ? anchors[anchors.length - 1]!.x : 0
      ensureRevealToUserX(lastX + (scoreEl.clientWidth * 1.5) / info.px)
    }
  }
  const ux = timeToX(time)
  const x = ux !== null ? cursorLeftForX(ux) : 0
  cursorEl.hidden = false
  cursorEl.style.left = `${x}px`
}

/** 光标越过视野边缘时自动带动谱面滚动（横向为主，纵向也保证不出视野） */
function followCursor(): void {
  const r = cursorEl.getBoundingClientRect()
  const sr = scoreEl.getBoundingClientRect()
  const mx = 64
  const my = 24
  if (r.left < sr.left + mx) scoreEl.scrollLeft += r.left - sr.left - mx
  else if (r.right > sr.right - mx) scoreEl.scrollLeft += r.right - sr.right + mx
  if (r.top < sr.top + my) scoreEl.scrollTop += r.top - sr.top - my
  else if (r.bottom > sr.bottom - my) scoreEl.scrollTop += r.bottom - sr.bottom + my
}

/** 把播放光标居中到视野中央（进入页面 / 双击谱面空白触发） */
function centerCursor(): void {
  if (cursorEl.hidden) return
  const r = cursorEl.getBoundingClientRect()
  const sr = scoreEl.getBoundingClientRect()
  scoreEl.scrollLeft += r.left - sr.left - sr.width / 2
  scoreEl.scrollTop += r.top - sr.top - sr.height / 2
}
// 双击谱面空白 → 聚焦到光标。
// 原来挂在 window 上且写成 `e.button === 1 || e.detail >= 2`：dblclick 的 button 恒为 0
// （中键早就被画布平移占用了），所以真正生效的只有 detail>=2 —— 于是双击任何面板、
// 按钮、输入框都会被抢走（双击选词、双击改文字全废）。这里限定在谱面内，并让位给
// 「双击文字就地改写」。
scoreEl.addEventListener('dblclick', (e) => {
  if (e.detail < 2) return
  const t0 = e.target as Element
  const g =
    (t0.closest?.(EDIT_SEL) as SVGGElement | null) ??
    (t0.closest?.('.md-freetext') as SVGGElement | null)
  if (g?.querySelector('text')) return // 交给 startTextEdit
  e.preventDefault() // 别顺手选中整页谱面文字
  centerCursor()
})

/** seek 后短时间内也要跟随（拖进度条时逐次 input 会持续续命） */
let followUntil = 0

// 光标小球：唯一可拖的部分（竖线完全穿透）
let dotDragging = false
// 发起这次拖拽的指针：等待播放器加载、以及多指同屏时都要认它
let dotPointerId: number | null = null
const endDotDrag = (): void => {
  dotPointerId = null
  if (!dotDragging) return
  dotDragging = false
  cursorDot.classList.remove('is-dragging')
}
cursorDot.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  dotPointerId = e.pointerId
  const pid = e.pointerId
  void (async () => {
    const p = await ensurePlayer()
    // 首帧要现造播放器（几百 ms）。这期间手指多半已经抬起来了，而抬起来那一刻
    // dotDragging 还是 false，pointerup 什么也没清 → 这里再置 true 就变成「松手了还跟手」。
    if (!p || p.duration <= 0 || dotPointerId !== pid) return
    dotDragging = true
    cursorDot.classList.add('is-dragging')
  })()
})
window.addEventListener('pointermove', (e) => {
  if (!dotDragging || e.pointerId !== dotPointerId) return
  const svg = svgEl()
  if (!svg || !player) return
  const r = svg.getBoundingClientRect()
  const vbW = Number(svg.dataset.vbW) || r.width
  const userX = ((e.clientX - r.left) / r.width) * vbW
  if (measureQueue.length) ensureRevealToUserX(userX + scoreEl.clientWidth * 0.5 / (r.width / vbW))
  const t = xToTime(userX)
  if (t !== null) {
    player.seek(Math.max(0, Math.min(player.duration, t)))
    moveCursor(player.currentTime)
    followCursor()
  }
})
window.addEventListener('pointerup', (e) => {
  if (dotPointerId !== null && e.pointerId !== dotPointerId) return
  endDotDrag()
})
window.addEventListener('pointercancel', (e) => {
  if (dotPointerId !== null && e.pointerId !== dotPointerId) return
  endDotDrag()
})

// 单一时间源：rAF 驱动进度文字 / 光标 / 跟随滚动
let lastTick = -1
function frame(): void {
  requestAnimationFrame(frame)
  updatePopover()
  const p = player
  if (!p) return
  const t = p.currentTime
  const d = p.duration
  bar?.setProgress(t, d)
  if (Math.abs(t - lastTick) > 0.002 || dotDragging) {
    moveCursor(t)
    if (p.playing || dotDragging || performance.now() < followUntil) followCursor()
    lastTick = t
  }
}
frame()

function playerEnd(): void {
  bar?.setEnded(player?.duration ?? 0)
  moveCursor(0)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// 播放器只该造一次：拖光标球、点播放、开页预热都可能同时打进来，而 new MideePlayer
// 到 player=p 之间要 await 音色加载（几百 ms~几秒）。没有锁的话每次调用都会各造一个，
// 后加载完的那个覆盖前一个 → 前一个的音频句柄和音色预取全成了打不完的野火。
let playerLoading: Promise<MideePlayer | null> | null = null
let loadProg: ((frac: number, label: string) => void) | null = null
async function ensurePlayer(prog?: (frac: number, label: string) => void): Promise<MideePlayer | null> {
  if (player) return player
  if (prog) loadProg = prog // 并发时以最新登记进度的人为准
  if (playerLoading) return playerLoading
  const b64 = playbackMidiB64()
  if (!b64) {
    setStatus(t('p2.noMidi'), true)
    return null
  }
  const p = new MideePlayer({
    onProgress: () => {
      // 暂停态 seek（拖进度条 / 点跳转）后让谱面跟随一小段时间
      if (player === null || !player.playing) followUntil = performance.now() + 1200
    },
    onEnd: playerEnd,
    onState: () => undefined,
  })
  // 音色加载并入启动弹窗：这里把 0→1 的音色进度映射到弹窗的 0.6→1.0 段，
  // 避免「谱面看起来好了但声音还没准备好」的空窗。
  playerLoading = (async () => {
    try {
      await p.load(
        base64ToBytes(b64),
        sessionStorage.getItem('midee.name') ?? undefined,
        (frac, label) => loadProg?.(0.6 + frac * 0.4, label ?? t('p2.soundLoading')),
      )
    } catch (err) {
      setStatus(t('l3.playFail', { err: String(err) }), true)
      return null
    }
    player = p
    bar?.attachPlayer()
    bar?.setProgress(0, p.duration)
    trackPanel?.refresh()
    buildAnchors()
    updateCursorGeometry()
    return p
  })()
  try {
    return await playerLoading
  } finally {
    playerLoading = null
  }
}

async function togglePlay(): Promise<void> {
  const p = await ensurePlayer()
  if (!p) return
  if (p.playing) p.pause()
  else {
    if (p.duration > 0 && p.currentTime >= p.duration - 0.05) p.seek(0)
    await p.play()
  }
  bar?.setPlaying(p.playing)
}

function revertVisual(): void {
  edits = emptyEdits()
  svgEl()?.querySelectorAll('g.md-freetext').forEach((g) => g.remove())
  saveEdits()
  clearSelection()
  layout = { v: 2, spacingLinear: SPACING_LINEAR_DEF, spacingSystem: SPACING_SYSTEM_DEF, spacingStaff: SPACING_STAFF_DEF }
  saveLayout()
  syncPanelSliders() // 排版面板也得跟着回位，否则画面回到默认、滑轨还停在旧数值
  relayoutScore(t('p2.prog.relayout'))
  setStatus(t('p2.status.reverted'))
}

/** 「恢复原状」丢弃全部视觉修改且不可撤销，必须先确认再动手 */
function confirmRevert(): void {
  void confirmDialog({
    message: t('p2.revertConfirm'),
    confirmText: t('p2.revert'),
    danger: true,
  }).then((ok) => {
    if (ok) revertVisual()
  })
}

function exportSvg(): void {
  const svg = svgEl()
  if (!svg) {
    setStatus(t('p2.noSvg'), true)
    return
  }
  revealAllNow() // 渐进渲染可能尚未挂齐，导出前补完整谱
  const clone = svg.cloneNode(true) as SVGSVGElement
  const vbW = Number(svg.dataset.vbW)
  const vbH = Number(svg.dataset.vbH)
  clone.removeAttribute('style')
  if (vbW) clone.setAttribute('width', String(vbW))
  if (vbH) clone.setAttribute('height', String(vbH))
  clone.querySelectorAll('.md-hidden').forEach((n) => n.remove())
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
    type: 'image/svg+xml;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(sessionStorage.getItem('midee.name') || 'score').replace(/[\\/:*?"<>|]/g, '_')}.svg`
  a.click()
  URL.revokeObjectURL(url)
  setStatus(t('p2.svgExported'))
}

function goNext(): void {
  if (!xmlDoc) {
    setStatus(t('p2.noScore'), true)
    return
  }
  saveLayout()
  goStep(3)
}

// ── 排版面板（顶栏「工具 ▾」）：一行文字 + 一条拖动条 ───────────

/** 排版面板的滑轨 + 数值输入框（拖哪个改哪个，数字框同步） */
function sliderRow(
  labelText: string,
  min: number,
  max: number,
  step: number,
  getValue: () => number,
  onInput: (v: number) => void,
  fmt: (v: number) => string = (v) => (Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2)),
): PanelLine & { row: HTMLElement } {
  const row = document.createElement('label')
  row.className = 'sh-sliderrow'
  const lab = document.createElement('span')
  lab.className = 'sh-sliderrow__label'
  lab.textContent = labelText
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'sh-sliderrow__range'
  input.min = String(min); input.max = String(max); input.step = String(step)
  input.value = String(getValue())
  const numInput = document.createElement('input')
  numInput.type = 'number'
  numInput.className = 'sh-sliderrow__value'
  numInput.min = String(min); numInput.max = String(max); numInput.step = String(step)
  numInput.value = fmt(getValue())
  numInput.style.width = '56px'
  numInput.style.textAlign = 'right'
  const sync = bindSliderPair(input, numInput, onInput, { fmt, min, max, commitOnChange: true })
  row.append(lab, input, numInput)
  return {
    row,
    input,
    numInput,
    // 从模型回读一次：外部改了 layout（复位、「恢复原状」）时滑轨要跟着走，
    // 数字格式各行的 fmt 已经封在闭包里，不必由调用方猜下标
    sync: (): void => sync(getValue()),
  }
}

interface PanelLine { input: HTMLInputElement; numInput: HTMLInputElement; sync: () => void }
let panelLines: PanelLine[] = []
let applyBtn: HTMLButtonElement | null = null

/** 显示「重排版/加载」小进度条弹窗；renderScore 流式铺开时会按小节进度推进 */
function showLayoutProgress(msg: string): void {
  setStatus(msg)
  renderProg.show(msg)
}
function hideLayoutProgress(): void {
  renderProg.done()
}
/** 流式铺开过程中按「已挂小节 / 总小节」推进弹窗进度 */
function reportRevealProgress(): void {
  if (!totalBars) return
  const mounted = svgEl()?.querySelectorAll('g.measure').length ?? 0
  const frac = totalBars ? Math.min(1, mounted / totalBars) : 0
  renderProg.set(frac)
}

/** Verovio 全量重排的固定一段：记住当前视野 → 改参数 → 重画 → 回位。
 *  排版面板的「应用」、播放条的宽度滑杆、「恢复原状」都走这里（口径统一）。 */
function relayoutScore(msg = t('p2.prog.relayoutDefault')): void {
  const frac = scrollFraction()
  showLayoutProgress(msg)
  tk?.setOptions(verovioOptions())
  renderScore()
  restoreScroll(frac)
  bar?.refreshZoom()
  setTimeout(hideLayoutProgress, 600)
}

/** 宽度滑杆每挪一像素都会触发上面那套全量重排（几十~几百 ms），拖动时直接卡死。
 *  面板里的同类滑杆本来就是「改数值 + 点应用」，这里对齐语义：拖动只记值，
 *  停手 180ms 合并成一次重排。 */
let relayoutTimer = 0
function scheduleRelayout(): void {
  if (relayoutTimer) clearTimeout(relayoutTimer)
  relayoutTimer = window.setTimeout(() => {
    relayoutTimer = 0
    relayoutScore()
  }, 180)
}

/** layout 被外部改动后（复位、「恢复原状」）把三个滑轨回读一遍。
 *  不这么做的话面板还显示旧数值，跟实际排版对不上，用户以为没生效再点一次应用又改回来。 */
function syncPanelSliders(): void {
  for (const pl of panelLines) pl.sync()
}

function buildLayoutPanel(): HTMLElement {
  panelLines = []
  const box = document.createElement('div')
  box.className = 'sh-dd-scroll sh-panel-sliders'

  const wRow = sliderRow(
    t('p2.scoreWidth'), SPACING_LINEAR_MIN, SPACING_LINEAR_MAX, 0.01,
    () => layout.spacingLinear,
    (v) => { layout.spacingLinear = clampV(v, SPACING_LINEAR_MIN, SPACING_LINEAR_MAX); saveLayout() },
  )
  const sysRow = sliderRow(
    t('p2.scoreSysSpacing'), SPACING_SYSTEM_MIN, SPACING_SYSTEM_MAX, 1,
    () => layout.spacingSystem,
    (v) => { layout.spacingSystem = clampV(v, SPACING_SYSTEM_MIN, SPACING_SYSTEM_MAX); saveLayout() },
    (v) => String(Math.round(v)),
  )
  const staffRow = sliderRow(
    t('p2.scoreStaffSpacing'), SPACING_STAFF_MIN, SPACING_STAFF_MAX, 1,
    () => layout.spacingStaff,
    (v) => { layout.spacingStaff = clampV(v, SPACING_STAFF_MIN, SPACING_STAFF_MAX); saveLayout() },
    (v) => String(Math.round(v)),
  )
  panelLines = [wRow, sysRow, staffRow]

  bindRangeTip(wRow.input, () => `${t('player.width')}-${wRow.numInput.value}`)
  bindRangeTip(sysRow.input, () => `${t('player.length')}-${sysRow.numInput.value}`)
  bindRangeTip(staffRow.input, () => `${t('player.length')}-${staffRow.numInput.value}`)

  box.append(wRow.row, sysRow.row, staffRow.row)

  // 「应用」按钮：触发 Verovio 重排版
  applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'sh-btn sh-btn--primary sh-btn--sm'
  applyBtn.style.cssText = 'width:100%;margin-top:6px'
  applyBtn.textContent = t('p2.applyLayout')
  applyBtn.addEventListener('click', () => relayoutScore())
  box.append(applyBtn)

  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'sh-dd-item'
  reset.style.cssText = 'margin-top:4px;width:100%'
  reset.textContent = t('p2.resetSize')
  reset.addEventListener('click', () => {
    layout = { v: 2, spacingLinear: SPACING_LINEAR_DEF, spacingSystem: SPACING_SYSTEM_DEF, spacingStaff: SPACING_STAFF_DEF }
    saveLayout()
    syncPanelSliders()
    relayoutScore(t('p2.prog.resetLayout'))
  })
  box.append(reset)
  return box
}

// ── 外壳接线 ──────────────────────────────────────────────────
let openCache: (() => void) | null = null
trackPanel = createTrackPanel({
  getPlayer: () => player,
  onOpenCache: () => openCache?.(),
})

const buildTools = () => [
  { id: 'layout', label: t('p2.layout'), node: buildLayoutPanel() },
  { id: 'title', label: t('p2.titlePanel'), node: buildTitlePanel() },
  { id: 'revert', label: t('p2.revert'), run: confirmRevert },
]

const shell = mountShell({
  step: 2,
  title: sessionStorage.getItem('midee.name') ?? t('common.untitled'),
  tools: buildTools(),
  tracks: trackPanel.el,
  onTitleRename: (text) => {
    try {
      sessionStorage.setItem('midee.name', text)
    } catch {
      /* noop */
    }
    // 顶栏改名同步到谱面上一行标题与标题面板（midee.scoreMeta.title）
    meta.title = text
    saveMeta()
    renderScoreTitle()
    syncTitleFreeText(text)
  },
  next: {
    onNext: goNext,
    items: [
      { label: t('p2.exportSvg'), labelKey: 'p2.exportSvg', run: exportSvg },
      {
        label: t('p2.exportProject'),
        labelKey: 'p2.exportProject',
        run: () => openProjectExportDialog(2),
      },
    ],
  },
  isDirty: () => dirty,
  onExport: () => openProjectExportDialog(2),
})
openCache = shell.openCache
// 超宽/竖屏两段的底部拖动条（滚动时出条、静止时出提示，见 shell/scrollrail.ts）
createScrollRail(() => scoreEl)

// 播放悬浮条：第 12 项 = 乐谱宽度（spacingLinear）
const SPACING_LINEAR_PCT_MIN = 0
const SPACING_LINEAR_PCT_MAX = 100
bar = createPlayerBar({
  shell,
  storageKey: 'midee.float.score2d',
  getPlayer: () => player,
  togglePlay: () => void togglePlay(),
  // 竖屏底栏第二行居中的「添加」：大纲里的未来功能，先挂个开发中的占位彩蛋
  action: {
    label: () => t('p2.addWip'),
    run: () => {},
    disabled: () => true,
  },
  zoom: {
    min: SPACING_LINEAR_PCT_MIN,
    max: SPACING_LINEAR_PCT_MAX,
    step: 1,
    value: () => Math.round(layout.spacingLinear * 100),
    apply: (pct) => {
      layout.spacingLinear = clampV(pct / 100, SPACING_LINEAR_MIN, SPACING_LINEAR_MAX)
      saveLayout()
      scheduleRelayout()
    },
    title: (pct) => `${t('player.width')}-${pct}%`,
  },
})

applyI18n(document.body)
onLocaleChange(() => {
  applyI18n(document.body)
  shell.setTools(buildTools())
})

// ── 启动 ──────────────────────────────────────────────────────
async function boot(): Promise<void> {
  const xml = sessionStorage.getItem('midee.xml')
  const name = sessionStorage.getItem('midee.name')
  if (!xml) {
    setStatus(t('p2.noData'), true)
    shell.setTitle(t('p2.noDataTitle'))
    return
  }
  shell.setTitle(name ?? t('common.untitled'))
  showLayoutProgress(t('p2.prog.load'))
  xmlDoc = new DOMParser().parseFromString(xml, 'application/xml')
  renderScoreTitle()
  renderProg.set(0.15, t('p2.prog.engine'))
  const ok = await initVerovio()
  if (!ok) { hideLayoutProgress(); return }
  renderProg.set(0.35, t('p2.prog.layout'))
  renderScore()
  const waitLayout = (): Promise<void> =>
    new Promise((resolve) => {
      const poll = (): void => {
        if (!measureQueue.length) { resolve(); return }
        requestAnimationFrame(poll)
      }
      poll()
    })
  await waitLayout()
  // 排版完成后才预热播放器：把音色加载真正并进这个弹窗（0.6→1.0 段），
  // 这样「谱面出来了但声音还在下载」的空窗就消失了。
  if (sessionStorage.getItem('midee.midi')) {
    renderProg.set(0.6, t('p2.soundLoading'))
    await ensurePlayer((frac, label) => renderProg.set(frac, label))
  }
  hideLayoutProgress()
}
void boot()

// 装配完成上报：模块顶层求值到此全部走完。中途抛错时这两行不会执行，
// index.html 里的内联看门狗据此把「本页控件没装上」显式报出来（横幅 + 修复页签自检项），
// 而不是留下「页面看着正常、下拉全没了」的静默半初始化状态。
const reportAssembled = (
  window as unknown as { __lumiReady?: () => void }
).__lumiReady
reportAssembled?.()
