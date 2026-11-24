// ── 第 3 步：连线检查与手动精修 ──────────────────────────────────
// 自动连线算法照搬 3dtest-copy r44：3 范围策略(voice/voiceStable/staff) ×
// 2 后继时机(onset/release)，见 shared/auto-links.ts。
//
// 产品规则：
//   ① 加载时按策略自动连线一次，立即清理「首尾同刻」的错误边；
//   ② 此后完全由用户操作（增删边、增删路径、跨轨串连均可），系统不拦截只标红；
//      唯一前端硬拦截 = 同刻端点之间禁止连线；
//   ③ 下一步统一判定：每路径从起点线到终点线单向不倒流、首尾相接、中间无断即可；
//      漏音（端点完全没人连）只标注，不阻断。
//   tie 续接音不产生端点、不触发演奏。

// 黑底白谱（两 2D 页共享 sessionStorage，仅深色模式生效）
paintDark2d()

import createVerovioModule from 'verovio/wasm'
import { VerovioToolkit as VrvToolkitClass } from 'verovio/esm'
import { Midi } from '@tonejs/midi'
import { confirmDialog, goStep, mountShell, paintDark2d } from '../shell/shell'
import { openProjectExportDialog } from '../shell/project-export'
import { applyI18n, onLocaleChange, t } from '../shell/i18n'
import { createSelect, isSelectUI } from '../shell/select'
import { createPlayerBar, type PlayerBarHandle } from '../shell/playerbar'
import { createTrackPanel, type TrackPanelHandle } from '../shell/tracks'
import { createScrollRail } from '../shell/scrollrail'
import { mergeTieEvents, parseMidiEvents } from '../score/midiEvents'
import { MideePlayer, playbackMidiB64 } from '../3dpreview/player'
import {
  parseXmlHeads,
  computeAutoGraph,
  loadAutoPolicy,
  saveAutoPolicy,
  pairEq,
  DEFAULT_AUTO_POLICY,
  type AutoPolicy,
  type AutoScope,
  type AutoSucc,
  type XmlHead,
} from '../shared/auto-links'
import {
  applySymbolEdits,
  convertSvgTextsToPaths,
  ensurePathFonts,
  loadSymbolEdits,
  preloadTextFonts,
} from '../shared/symbol-text'
import { ensureNoteTypes } from '../shared/score-preprocess'
import { createRenderProgress } from '../shared/render-progress'

const SCALE = 45
// ── 排版（第二页写入 midee.layout，本页必须同参渲染，否则宽高对不上） ──
const LAYOUT_KEY = 'midee.layout'
const SPACING_LINEAR_DEF = 0.25; const SPACING_LINEAR_MIN = 0.00; const SPACING_LINEAR_MAX = 1.00
const SPACING_SYSTEM_DEF = 4;    const SPACING_SYSTEM_MIN = 0;     const SPACING_SYSTEM_MAX = 48
const SPACING_STAFF_DEF = 12;    const SPACING_STAFF_MIN = 0;     const SPACING_STAFF_MAX = 48

function clampV(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 与第二页 loadLayout 完全一致：v2 直取 Verovio 值，旧版宽度百分比迁移 */
function loadLayout(): { spacingLinear: number; spacingSystem: number; spacingStaff: number } {
  const fallback = {
    spacingLinear: SPACING_LINEAR_DEF,
    spacingSystem: SPACING_SYSTEM_DEF,
    spacingStaff: SPACING_STAFF_DEF,
  }
  try {
    const raw = sessionStorage.getItem(LAYOUT_KEY)
    if (!raw) return fallback
    const p = JSON.parse(raw) as { v?: number; spacingLinear?: number; spacingSystem?: number; spacingStaff?: number; heightPct?: number; widthPct?: number; lengthPct?: number }
    if (p.v === 2 && typeof p.spacingLinear === 'number' && typeof p.spacingSystem === 'number' && typeof p.spacingStaff === 'number') {
      return {
        spacingLinear: clampV(p.spacingLinear, SPACING_LINEAR_MIN, SPACING_LINEAR_MAX),
        spacingSystem: clampV(p.spacingSystem, SPACING_SYSTEM_MIN, SPACING_SYSTEM_MAX),
        spacingStaff: clampV(p.spacingStaff, SPACING_STAFF_MIN, SPACING_STAFF_MAX),
      }
    }
    const oldW = clampV(p.widthPct ?? p.lengthPct ?? 100, 60, 180)
    return {
      spacingLinear: clampV(0.25 * oldW / 100, SPACING_LINEAR_MIN, SPACING_LINEAR_MAX),
      spacingSystem: SPACING_SYSTEM_DEF,
      spacingStaff: SPACING_STAFF_DEF,
    }
  } catch {
    return fallback
  }
}
const SVG_NS = 'http://www.w3.org/2000/svg'
const LINKS_KEY = 'midee.links'
const TERM_MARGIN = 90 // 起终点竖线距首尾符头的默认留白（SVG 用户单位）
const TERM_GAP_MIN = 12 // 竖线可拖到的最近/最远距离：第五页「远离乐谱距离」滑轨同区间
const TERM_GAP_MAX = 600
const PALETTE = [
  '#2266ff', '#e11d48', '#16a34a', '#ea580c', '#7c3aed',
  '#0891b2', '#ca8a04', '#be185d', '#15803d', '#4f46e5',
  '#9333ea', '#0d9488',
]

interface ToolkitLike {
  setOptions(o: Record<string, unknown>): void
  loadData(x: string): boolean
  renderToSVG(page?: number): string
  renderToTimemap(): { on?: string[]; tstamp?: number }[]
}

// ── DOM / 外壳 ────────────────────────────────────────────────
const scoreEl = document.getElementById('score')!
const innerEl = document.getElementById('score')!.querySelector<HTMLElement>('#scoreInner')!
const hintEl = document.getElementById('hint')!
const emptyEl = document.getElementById('empty')!
document.getElementById('emptyNext')?.addEventListener('click', () => { goStep(1) })

let shell: ReturnType<typeof mountShell>
let bar: PlayerBarHandle | null = null

// ── 数据模型 ──────────────────────────────────────────────────
type Pair = [string, string]
interface PathData {
  id: string
  color: string
  /** 用户自定义路径名（可选；未设置时回退到 trackLabel(trackKey)） */
  name?: string
  /** 归属键：有原始 MIDI 时为 't0'/'t1'…（原曲轨道，默认路径数=轨道数）；XML 直导时为 lane 键 */
  trackKey: string
  /** 自动边（重算策略时整体替换；受 removed 全局抑制） */
  auto: Pair[]
  /** 人工新增边（跨轨允许；重算策略时保留） */
  manual: Pair[]
  /** 起点/终点线上锚点的 y 列表（自动策略恰好 1 个；手动可多个起点/终点） */
  ayStart: number[]
  ayEnd: number[]
  /** false=锚点由自动策略放置（单锚点=同轨头/尾端点的广义费马点，随铺刷新）；true=用户手动打点 */
  anchorsManual: boolean
}
interface LinksStore {
  v: 5
  policy: AutoPolicy
  offStart: number
  offEnd: number
  /** 起点线离谱面（最左符头）的距离，SVG 用户单位；默认 TERM_MARGIN，可横向拖拽 */
  termStartGap: number
  /** 终点线离谱面（最右符头）的距离，同上 */
  termEndGap: number
  paths: PathData[]
  selected: string
  /** 用户从自动结果里删掉的边（重算后继续抑制） */
  removed: Pair[]
}

interface Endpoint {
  id: string
  x: number; y: number
  time: number // 秒（Verovio timemap tstamp）
  midi: number
  lane: string
  /** 归属键：'t0'…=原始 MIDI 轨道；'lane:…'=XML 直导按声部 */
  trackKey: string
  nodeIdx: number
  head: XmlHead
}

let heads: XmlHead[] = []
let epById = new Map<string, Endpoint>()
let endpoints: Endpoint[] = []
let svg: SVGSVGElement | null = null
let edgeLayer: SVGGElement | null = null
let nodeLayer: SVGGElement | null = null
let termLayer: SVGGElement | null = null
let ballLayer: SVGGElement | null = null
let startX = 0
let endX = 0
/** 端点 x 的最左/最右（竖线拖拽按「离符头的距离」记账，第五页同口径映射） */
let notesLo = 0
let notesHi = 0
let musicDur = 0
let store: LinksStore
let pathSeq = 0

function emptyStore(policy: AutoPolicy): LinksStore {
  return { v: 5, policy, offStart: 0.7, offEnd: 0.7, termStartGap: TERM_MARGIN, termEndGap: TERM_MARGIN, paths: [], selected: '', removed: [] }
}
/** 起/终点线留白的合法区间：太近会压到符头，太远第五页球轨飞出画面 */
const clampGap = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(n, TERM_GAP_MIN, TERM_GAP_MAX) : TERM_MARGIN
}
// 留白允许 0（用户主动设零），不能用 `Number(v) || 0.7`——那会把 0 吞成默认值。
const clampOff = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(n, 0, 5) : 0.7
}
function loadStore(): LinksStore {
  const name = sessionStorage.getItem('midee.name') ?? 'untitled'
  const policy = loadAutoPolicy(name)
  try {
    const raw = sessionStorage.getItem(LINKS_KEY)
    if (raw) {
      const o = JSON.parse(raw) as Partial<LinksStore>
      if (o && o.v === 5 && Array.isArray(o.paths) && o.paths.every((p) => typeof p.trackKey === 'string' && Array.isArray(p.ayStart) && Array.isArray(p.ayEnd) && Array.isArray(p.auto) && Array.isArray(p.manual) && typeof p.anchorsManual === 'boolean')) {
        return {
          v: 5,
          policy: o.policy ?? policy,
          offStart: clampOff(o.offStart),
          offEnd: clampOff(o.offEnd),
          termStartGap: clampGap(o.termStartGap),
          termEndGap: clampGap(o.termEndGap),
          paths: o.paths,
          selected: o.selected ?? '',
          removed: Array.isArray(o.removed) ? o.removed : [],
        }
      }
    }
  } catch { /* 新建 */ }
  return emptyStore(policy)
}
/** 本页改动标记：boot 完成前的自动铺轨 / 默认路径不算「用户改动」 */
let dirty = false
let dirtyWatch = false

function persist(): void {
  if (dirtyWatch) dirty = true
  try { sessionStorage.setItem(LINKS_KEY, JSON.stringify(store)) } catch { /* noop */ }
}
function selectedPath(): PathData | null {
  return store.paths.find((p) => p.id === store.selected) ?? null
}
function pathColor(id: string): string {
  return store.paths.find((p) => p.id === id)?.color ?? '#888'
}

/** 路径当前全部边（auto 去掉全局已删，再并 manual），带来源标记。
 *
 *  原来每条 auto 边都要 store.removed.some(...) 全表扫一遍（O(E×R)），
 *  而 pathEdges 在 validate、renderEdges、ballPositionsAt 里被反复调用——
 *  播放时每帧都跑一遍。这里改成：已删边建一次 Set（pairEq 是无向的，
 *  键按字典序拼），每条路径的边表算好后缓存，renderAll 顶部统一作废。 */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
let removedKeys: Set<string> | null = null
const edgesCache = new Map<string, { pair: Pair; manual: boolean }[]>()

function invalidateEdgeCache(): void {
  removedKeys = null
  edgesCache.clear()
}
function isRemoved(a: string, b: string): boolean {
  removedKeys ??= new Set(store.removed.map((r) => pairKey(r[0], r[1])))
  return removedKeys.has(pairKey(a, b))
}

function pathEdges(p: PathData): { pair: Pair; manual: boolean }[] {
  const cached = edgesCache.get(p.id)
  if (cached) return cached
  const out: { pair: Pair; manual: boolean }[] = []
  for (const e of p.auto) {
    if (!isRemoved(e[0], e[1])) out.push({ pair: e, manual: false })
  }
  for (const e of p.manual) out.push({ pair: e, manual: true })
  edgesCache.set(p.id, out)
  return out
}
function allPairs(): { path: PathData; pair: Pair; manual: boolean }[] {
  const out: ReturnType<typeof allPairs> = []
  for (const p of store.paths) for (const e of pathEdges(p)) out.push({ path: p, pair: e.pair, manual: e.manual })
  return out
}

// ── Verovio 流式渲染：骨架先挂，小节逐帧向后铺开（同 2D 页） ───────
let tk: ToolkitLike | null = null
let vbW = 0
let vbH = 0
let revealGen = 0
let revealDone = false
let measureQueue: SVGGElement[] = []
let measureParent: SVGGElement | null = null
let measureAnchor: ChildNode | null = null
let pumpQueued = false
let totalMeasures = 0
const renderProg = createRenderProgress()
const INITIAL_MEASURES = 6
const MEASURES_PER_FRAME = 2
const REVEAL_CHUNK = 4
const REVEAL_GUARD = 24

async function prepareToolkit(xml: string): Promise<boolean> {
  try {
    const mod = await createVerovioModule()
    const inst = new VrvToolkitClass(mod as never) as unknown as ToolkitLike
    const layout = loadLayout()
    inst.setOptions({
      pageWidth: 1200, scale: SCALE,
      spacingLinear: layout.spacingLinear, spacingNonLinear: 0.6,
      spacingSystem: layout.spacingSystem, spacingStaff: layout.spacingStaff,
      breaks: 'none', footer: 'none', header: 'none', font: 'Bravura',
    })
    inst.loadData(ensureNoteTypes(xml)) // 与第五页回退渲染同一份预处理，两页渲染输入完全一致
    tk = inst
    return true
  } catch (err) {
    hintEl.textContent = t('l3.verovioInitFail', { err: String(err) })
    return false
  }
}

/** 流式挂载谱面（要求 heads/时间/轨道/路径已就绪）。
 *  挂载前先完成：第二页文字编辑原样应用 → 全部 <text> 冻结为 <path> 矢量轮廓
 *  （Liberation=Times 文本 / Bravura=SMuFL 字形 / Noto=中文），并把这份纯 path
 *  的完整 SVG 存入 midee.pathSvg——第五页直接消费，进第五页前只处理 path 元素。
 *  返回是否挂载成功：失败时 svg 仍为 null，调用方必须停下。原来 boot 不查返回值，
 *  往下 `svg!.addEventListener` 直接抛 TypeError（boot 用 void 调起，异常只成为
 *  unhandledrejection → 误触首屏看门狗的「异步任务失败」），进度弹窗也永不收尾。 */
async function mountSvgProgressive(): Promise<boolean> {
  const inst = tk!
  // 离屏解析，小节拆下来逐批挂载（避免大谱一次性插入长任务）
  try {
    const parsed = new DOMParser().parseFromString(inst.renderToSVG(1), 'image/svg+xml')
    const srcSvg = parsed.documentElement as unknown as SVGSVGElement
    // ── 第二页编辑（改字/删除/偏移/缩放/加粗/自由文字）原样映射 ──
    // 各步独立降级：任何失败只损失对应增强（编辑/矢量冻结），绝不挡谱面挂载
    const edits = loadSymbolEdits()
    if (edits) {
      try {
        applySymbolEdits(srcSvg, edits)
      } catch (err) {
        console.warn('[连线页] 应用第二页编辑失败（已忽略，按未编辑谱面继续）', err)
      }
    }
    // ── text → path（字体就绪后；失败则保留 text，第五页旧管线兜底） ──
    let fonts: Awaited<ReturnType<typeof ensurePathFonts>> = null
    try {
      fonts = await ensurePathFonts()
    } catch {
      fonts = null
    }
    if (fonts) {
      try {
        // 第二页指定了网络字体的文字：先把 woff2 分片拉齐再同步转 path
        await preloadTextFonts(srcSvg)
        convertSvgTextsToPaths(srcSvg, fonts)
      } catch (err) {
        console.warn('[连线页] text→path 转换失败（已忽略，保留 text）', err)
      }
    }
    // midee.pathSvg（第五页的提速缓存）不在这里同步序列化了——几 MB 字符串
    // 挡在小节挂载之前是首屏计算的大头。铺开完成后由模块级的 stashPathSvg()
    // 从活动树补写（见其注释）；第五页读不到时会自己渲染+转换，结果一致。
    const measures = Array.from(srcSvg.querySelectorAll<SVGGElement>('g.measure'))
    totalMeasures = measures.length
    measureParent = (measures[0]?.parentNode as SVGGElement | null) ?? null
    const lastM = measures[measures.length - 1] ?? null
    measureAnchor = lastM?.nextSibling ?? null
    measureQueue = measures
    for (const m of measures) m.remove()

    const old = innerEl.querySelector('svg')
    if (old) old.remove()
    svg = document.adoptNode(srcSvg)
    innerEl.appendChild(svg)
    const w = parseFloat(svg.getAttribute('width') ?? '0')
    const h = parseFloat(svg.getAttribute('height') ?? '0')
    vbW = w; vbH = h
    if (w && h) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
      svg.dataset.vbW = String(w)
      svg.dataset.vbH = String(h)
    }
    edgeLayer = document.createElementNS(SVG_NS, 'g')
    edgeLayer.setAttribute('class', 'lk-layer lk-edges')
    nodeLayer = document.createElementNS(SVG_NS, 'g')
    nodeLayer.setAttribute('class', 'lk-layer lk-nodes')
    termLayer = document.createElementNS(SVG_NS, 'g')
    termLayer.setAttribute('class', 'lk-terms')
    ballLayer = document.createElementNS(SVG_NS, 'g')
    ballLayer.setAttribute('class', 'lk-balls')
    // 层级：竖线 → 连线 → 端点 → 圆点。端点/圆点改成节点复用（只补状态与坐标），
    // 所以这里重建 svg 时必须把两边的缓存丢掉，否则会往已脱离文档的旧节点上写属性
    svg.append(termLayer, edgeLayer, nodeLayer, ballLayer)
    nodeItems = []
    resetBallPool()
    invalidateEdgeCache()
    revealRenders = 0 // 换谱重建：下一批（第一批）仍旧同步画，别等帧
    // 端点表是「量过就不再量」的增量缓存，重建 svg 时必须整张丢掉，
    // 否则会拿旧坐标去套新文档（旧节点已经不在页面里了）
    epById = new Map()
    endpoints = []

    // 竖线初始位置（末端点挂载后再收敛到真实首/尾音）
    startX = 56
    endX = vbW - 56
    notesLo = startX + store.termStartGap
    notesHi = Math.max(notesLo, endX - store.termEndGap)
    applyScale()
    revealGen++
    revealDone = false
    pumpQueued = false
    revealMeasures(INITIAL_MEASURES)
    queuePump()
    return true
  } catch (err) {
    hintEl.textContent = t('l3.verovioRenderFail', { err: String(err) })
    return false
  }
}

/** 最后一节已挂载的小节：给 mountedFrontierX 当 O(1) 前沿用（原来是全量 querySelectorAll + getBBox） */
let lastMountedMeasure: SVGGElement | null = null

/** 把当前谱面写进 midee.pathSvg（第五页的提速缓存，读不到会自渲染回退）。
 *  从【活动树】克隆：铺开完成后小节都已插回原位，摘掉四层连线覆盖层就是纯谱面。
 *  原来是在 mountSvgProgressive 里对拆散前的 srcSvg 同步序列化——几 MB 字符串
 *  挡在小节挂载之前，是首屏计算的大头，现在挪到铺完之后空闲时再做。 */
function stashPathSvg(): void {
  try {
    if (!svg) return
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.querySelectorAll('.lk-layer, .lk-terms, .lk-balls').forEach((n) => n.remove())
    sessionStorage.setItem('midee.pathSvg', new XMLSerializer().serializeToString(clone))
  } catch {
    /* 超限等异常：第五页回退自行渲染+转换 */
  }
}

function revealMeasures(max: number): number {
  if (!measureParent) return 0
  let n = 0
  while (measureQueue.length && n < max) {
    const detached = measureQueue.shift()!
    const live = document.adoptNode(detached)
    measureParent.insertBefore(live, measureAnchor)
    lastMountedMeasure = live as SVGGElement
    n++
  }
  if (n) onRevealProgress()
  if (!measureQueue.length && !revealDone) {
    revealDone = true
    onRevealProgress()
    renderProg.done()
    // 谱面完整了：空闲时把 midee.pathSvg 缓存补上（见 mountSvgProgressive 的说明）
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    }
    if (w.requestIdleCallback) w.requestIdleCallback(stashPathSvg, { timeout: 3000 })
    else setTimeout(stashPathSvg, 800)
  } else if (totalMeasures) {
    // 进度直接由队列长度推出来，不必每批 querySelectorAll 一遍（那是 O(M²)）
    renderProg.set(Math.min(1, (totalMeasures - measureQueue.length) / totalMeasures))
  }
  return n
}
function pump(): void {
  pumpQueued = false
  if (!measureQueue.length) return
  revealMeasures(MEASURES_PER_FRAME)
  if (measureQueue.length) queuePump()
}
function queuePump(): void {
  if (pumpQueued) return
  pumpQueued = true
  requestAnimationFrame(pump)
}
function measureTranslateX(m: Element): number {
  const mm = /translate\(\s*(-?[\d.]+)/.exec(m.getAttribute('transform') ?? '')
  return mm && mm[1] !== undefined ? parseFloat(mm[1]) : 0
}
function mountedFrontierX(): number {
  if (!svg) return 0
  // 正常路径直接用最后一节已挂载的小节；只有它不在文档里（换谱/重建）才回退去查
  let last = lastMountedMeasure
  if (!last?.isConnected) {
    const mounted = svg.querySelectorAll<SVGGElement>('g.measure')
    last = mounted[mounted.length - 1] ?? null
    lastMountedMeasure = last
  }
  if (!last) return 0
  let w = 0
  try { w = last.getBBox().width } catch { w = 0 }
  return measureTranslateX(last) + w
}
/** 一次调用最多补 4 批（原来是 24 次循环 × 每批一次整层重绘，一帧能触发二十多次渲染）；
 *  没铺够就交给下一帧继续，播放头推进时自然会追上来 */
const REVEAL_STEPS_PER_CALL = 4
function ensureRevealToUserX(targetX: number): void {
  let guard = 0
  while (
    measureQueue.length &&
    mountedFrontierX() < targetX &&
    guard < Math.min(REVEAL_GUARD, REVEAL_STEPS_PER_CALL)
  ) {
    revealMeasures(REVEAL_CHUNK)
    guard++
  }
  if (measureQueue.length) queuePump()
}

// ── 时间/轨道（不依赖 DOM，流式铺开前就算好） ───────────────────
// 关键：XML 是 midiToXml(midee.midiOrig) 生成的，voice 编号在生成时就与原始轨道
// 一一确定对应（见 shared/midi-xml.ts 的 trackAlloc），这里【原封不动复刻同一分配
// 规则】反推出 staff|voice → 轨道，绝不靠时间/音高事后匹配（左右手同音高重叠会
// 错配，导致串轨与端点看似错位）。
const headTime = new Map<string, number>() // noteId → 秒
interface OrigTrack { name: string; notes: { midi: number }[] }
/** 稀疏数组：下标 = 原始 MIDI 轨号（含空轨），仅非空轨有值 */
let origTracks: (OrigTrack | null)[] = []
/** 非空轨道的下标（路径顺序） */
let origTrackIdx: number[] = []
/** 'staff|voice' → 't<原始轨号>' */
const svToTrack = new Map<string, string>()

function buildTimeAndTracks(xml: string): void {
  heads = parseXmlHeads(xml)
  headTime.clear()
  // 单事件源：优先用共享 MIDI 事件表（与第五页完全同一份解析 + tie 合并）；
  // 数量对齐才采纳，否则保留 Verovio timemap（渲染引擎给出的时间映射）兜底并告警。
  const midiEvs = parseMidiEvents(sessionStorage.getItem('midee.midi'))
  if (midiEvs.length) {
    const hs = heads
      .map((h, i) => ({ h, i }))
      .filter((x) => !x.h.rest && !x.h.tieCont && !x.h.grace && x.h.midi !== null)
    const evs = mergeTieEvents(midiEvs)
    hs.sort((a, b) => a.h.onset - b.h.onset || (a.h.midi ?? 0) - (b.h.midi ?? 0))
    if (hs.length === evs.length) {
      hs.forEach((x, k) => headTime.set(x.h.noteId, evs[k]!.time))
    } else {
      console.warn(
        `[连线页] 符头数(${hs.length}) ≠ MIDI 事件数(${evs.length})，退回 Verovio 时间映射`,
      )
    }
  }
  if (!headTime.size) {
    for (const row of tk!.renderToTimemap()) {
      if (row.on && row.tstamp !== undefined) {
        for (const id of row.on) if (!headTime.has(id)) headTime.set(id, row.tstamp / 1000)
      }
    }
  }
  const times = heads.filter((h) => !h.rest && !h.tieCont && headTime.has(h.noteId)).map((h) => headTime.get(h.noteId)!)
  musicDur = times.length ? Math.max(...times) : 0

  origTracks = []
  origTrackIdx = []
  svToTrack.clear()
  const origB64 = sessionStorage.getItem('midee.midiOrig')
  if (origB64) {
    try {
      const bin = atob(origB64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const midi = new Midi(bytes)
      origTracks = midi.tracks.map((tr, i) =>
        tr.notes.length
          ? { name: tr.name?.trim() || `${t('l3.track')} ${i + 1}`, notes: tr.notes.map((n) => ({ midi: n.midi })) }
          : null,
      )
      origTrackIdx = origTracks.map((tr, i) => (tr ? i : -1)).filter((i) => i >= 0)

      // 复刻 midi-xml.ts trackAlloc：voiceCounter 仅在非空轨间递增；
      // 跨大谱表轨占两个 voice（staff1/staff2 各一），否则按音高中位数单 voice。
      let voiceCounter = 0
      const nextVoice = (): number => ++voiceCounter
      origTracks.forEach((tr, ti) => {
        if (!tr) return
        const mids = tr.notes.map((n) => n.midi)
        const min = Math.min(...mids)
        const max = Math.max(...mids)
        if (min < 55 && max >= 62) {
          const v1 = nextVoice(), v2 = nextVoice()
          svToTrack.set(`1|${v1}`, `t${ti}`)
          svToTrack.set(`2|${v2}`, `t${ti}`)
        } else {
          const sorted = [...mids].sort((a, b) => a - b)
          const med = sorted[Math.floor(sorted.length / 2)]!
          const staff: 1 | 2 = med >= 60 ? 1 : 2
          svToTrack.set(`${staff}|${nextVoice()}`, `t${ti}`)
        }
      })
    } catch {
      origTracks = []
      origTrackIdx = []
    }
  }
}
/**
 * 符头所属轨道键：
 *  · MIDI 导入：复刻 midiToXml 的 voice→轨道映射（跨大谱表的一只手可占高低两个谱表）；
 *  · XML 直导（无原始 MIDI）：标准 MIDI 由 webmscore 从该 XML 导出，按 part+staff
 *    分轨，因此归属键用 part|staff（同谱表内的多个 voice 合并为一条路径），
 *    保证路径数与 MIDI 轨道一一对应，不会出现「两轨四条路径」。
 */
function trackKeyOf(h: XmlHead): string {
  return svToTrack.get(`${h.staff}|${h.voice}`) ?? `staff:${h.part}|${h.staff}`
}
function trackLabel(key: string): string {
  if (key.startsWith('t')) {
    const i = Number(key.slice(1))
    return origTracks[i]?.name ?? `${t('l3.track')} ${i + 1}`
  }
  if (key.startsWith('manual:')) return t('l3.customPath')
  const m = /^staff:(\d+)\|(\d+)$/.exec(key)
  if (m) return `P${Number(m[1]) + 1}·${t(Number(m[2]) === 1 ? 'l3.staff.high' : 'l3.staff.low')}`
  return key
}

/** 路径显示名：用户自定义名优先，否则回退到 trackLabel */
function pathDisplayName(p: PathData): string {
  return p.name?.trim() || trackLabel(p.trackKey)
}

/** 名字去重：在已有路径名中找唯一的名字（冲突时追加 (2)、(3)…） */
function uniquePathName(desired: string, excludeId: string): string {
  const base = desired.trim()
  if (!base) return base
  const used = new Set(store.paths.filter((p) => p.id !== excludeId).map((p) => pathDisplayName(p)))
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

// ── 端点表：只包含已挂载小节里的符头（流式过程中逐步出现） ─────────
function scanMountedEndpoints(): void {
  if (!svg) return
  const r = svg.getBoundingClientRect()
  const vbw = Number(svg.dataset.vbW) || r.width
  const pxPerUnit = r.width / vbw
  // 端点坐标是【用户空间】的，不随缩放/滚动变化 → 量过的符头不必再量。
  // 原来每批都把 heads 全表重查一遍：几千个音符铺开时要几十批，
  // 每批都是 N 次 querySelector + N 次 getBoundingClientRect（每次都是布局读），
  // 首屏计算时间基本都耗在这儿。
  const ep: Endpoint[] = endpoints.slice()
  heads.forEach((h, i) => {
    if (h.rest || h.tieCont || !h.noteId) return
    if (epById.has(h.noteId)) return // 已经量过，坐标不会变
    const g = svg!.querySelector<SVGGElement>(`g.note#${CSS.escape(h.noteId)}`)
    if (!g) return // 小节尚未挂载
    // 端点必须落在【符头】中心：g.note 的包围盒含符杆/符尾，取其中心会系统性
    // 偏向符杆一侧（1x 偏 10~12px、放大后更明显）。优先 g.notehead，
    // 找不到再退回整个 note 包围盒。
    const headEl = g.querySelector<SVGGElement>('g.notehead') ?? g
    const nr = headEl.getBoundingClientRect()
    if (!nr.width) return
    const time = headTime.get(h.noteId)
    if (time === undefined) return // 装饰音等无时间证据 → 不做端点
    ep.push({
      id: h.noteId,
      x: (nr.left + nr.width / 2 - r.left) / pxPerUnit,
      y: (nr.top + nr.height / 2 - r.top) / pxPerUnit,
      time,
      midi: h.midi ?? 0,
      lane: `${h.part}|${h.staff}|${h.voice}`,
      trackKey: trackKeyOf(h),
      nodeIdx: i,
      head: h,
    })
  })
  epById = new Map(ep.map((e) => [e.id, e]))
  endpoints = ep.sort((a, b) => a.time - b.time || a.y - b.y)
  if (endpoints.length) {
    // 原来是 Math.min/max(...ep.map(...))：分配临时数组还把上千个值当展开实参传
    let lo = Infinity
    let hi = -Infinity
    for (const e of ep) {
      if (e.x < lo) lo = e.x
      if (e.x > hi) hi = e.x
    }
    notesLo = lo
    notesHi = hi
    startX = lo - store.termStartGap
    if (revealDone) endX = hi + store.termEndGap
  }
}

/** 每批小节挂载后：补端点、刷新自动锚点（头/尾中位数随已铺小节收敛）。
 *  整层重绘（validate + 四层重建）在铺开期间很贵，而 ensureRevealToUserX 一次能连补
 *  好几批——原来每批都全量重绘。改成按帧合并成一次。
 *  例外：第一批必须立刻同步画一次，否则首屏端点要等一帧才出现（标签页在后台时
 *  rAF 根本不跑，就会看着像卡在那儿不渲染）；铺开完成那一次也同步，并落盘。 */
let revealRenderQueued = false
let revealRenders = 0
function onRevealProgress(): void {
  scanMountedEndpoints()
  recomputeAutoAnchors()
  if (revealDone) {
    revealRenderQueued = false
    revealRenders++
    renderAll(true)
    return
  }
  if (revealRenders === 0) {
    revealRenders++
    renderAll(false)
    return
  }
  if (revealRenderQueued) return
  revealRenderQueued = true
  requestAnimationFrame(() => {
    revealRenderQueued = false
    if (revealDone) return
    revealRenders++
    renderAll(false)
  })
}
function pathEndpoints(p: PathData): Endpoint[] {
  const ids = new Set<string>()
  // 走 pathEdges（已滤掉全局 removed）：直接用 p.auto 会把被抑制的幽灵边算进来，
  // 切换策略重建 auto 后头尾/锚点判定随之失真并落盘传给第五页。
  for (const { pair: [a, b] } of pathEdges(p)) {
    ids.add(a)
    ids.add(b)
  }
  return [...ids].map((id) => epById.get(id)).filter((e): e is Endpoint => !!e).sort((a, b) => a.time - b.time)
}

// ── 自动连线：照搬测试项目算法 → 同轨边归集（自动绝不跨轨道） ──────
let graphBuckets = new Map<string, Pair[]>()

function runAuto(policy: AutoPolicy): void {
  const graph = computeAutoGraph(heads, policy)
  graphBuckets = new Map()
  for (const e of graph.edges) {
    const a = heads[e.from], b = heads[e.to]
    if (!a || !b) continue
    // ① 首尾同刻边刷掉（同刻端点之间不连线；同刻簇在播放层按时间聚簇，不需要边）
    if (Math.abs(a.onset - b.onset) < 1e-6 && a.measure === b.measure) continue
    // ② 自动连线不允许跨轨道：两端归属不同键直接丢弃（测试项目 voice 边界即此约束）
    const ka = trackKeyOf(a), kb = trackKeyOf(b)
    if (ka !== kb) continue
    const pair: Pair = [a.noteId, b.noteId]
    const arr = graphBuckets.get(ka) ?? []
    arr.push(pair)
    graphBuckets.set(ka, arr)
  }
}

function makePath(key: string, colorIdx: number): PathData {
  return {
    id: `p${++pathSeq}`,
    color: PALETTE[colorIdx % PALETTE.length]!,
    trackKey: key,
    auto: graphBuckets.get(key) ?? [],
    manual: [],
    ayStart: [], ayEnd: [],
    anchorsManual: false,
  }
}

function buildDefaultPathsFromAuto(): void {
  store.paths = []
  if (origTrackIdx.length) {
    // 有多少个（非空）原始轨道就建多少条路径，顺序/名字沿用原始轨
    origTrackIdx.forEach((ti, colorIdx) => store.paths.push(makePath(`t${ti}`, colorIdx)))
  } else {
    // XML 直导：按算法实际产出的归属键建路径
    ;[...graphBuckets.keys()].sort().forEach((key, i) => store.paths.push(makePath(key, i)))
  }
  recomputeAutoAnchors()
  store.selected = store.paths[0]?.id ?? ''
}

function rebuildAutoKeepManual(): void {
  runAuto(store.policy)
  for (const p of store.paths) p.auto = graphBuckets.get(p.trackKey) ?? []
  // 新归属键 → 追加路径；人工边/人工锚点保留
  const used = new Set(store.paths.map((p) => p.trackKey))
  graphBuckets.forEach((edges, key) => {
    if (used.has(key) || !edges.length) return
    store.paths.push(makePath(key, store.paths.length))
  })
  recomputeAutoAnchors()
  if (!store.paths.some((p) => p.id === store.selected)) store.selected = store.paths[0]?.id ?? ''
}

// ── 头/尾端点与自动锚点（广义费马点 = 一维中位数，使接线总长最短） ─────
function medianYs(ys: number[]): number | null {
  if (!ys.length) return null
  const s = [...ys].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
function nearestAnchor(ys: number[], y: number): number {
  let best = ys[0]!, bd = Infinity
  for (const a of ys) { const d = Math.abs(a - y); if (d < bd) { bd = d; best = a } }
  return best
}

/** 路径的头（无入边）/尾（无出边）端点 id（自动边与人工边合并计算） */
function pathHeadsTails(p: PathData): { heads: string[]; tails: string[] } {
  const nodes = new Set<string>()
  const indeg = new Set<string>()
  const outAdj = new Map<string, string[]>()
  // 同 pathEndpoints：必须基于过滤 removed 后的边，否则被抑制的自动边会伪造头/尾。
  for (const { pair: [a, b] } of pathEdges(p)) {
    if (!epById.has(a) || !epById.has(b)) continue
    nodes.add(a); nodes.add(b)
    indeg.add(b)
    ;(outAdj.get(a) ?? outAdj.set(a, []).get(a)!).push(b)
  }
  const heads: string[] = []
  const tails: string[] = []
  for (const id of nodes) {
    if (!indeg.has(id)) heads.push(id)
    if (!(outAdj.get(id)?.length)) tails.push(id)
  }
  return { heads, tails }
}

/** 自动锚点：同轨每个头/尾都接到起/终点线上同一个共同最近点（y 的中位数） */
function recomputeAutoAnchors(): void {
  // 头/尾判定现在走 pathEdges（带缓存）；本函数总在 auto/manual 改动后调用，
  // 先作废缓存，避免读到改动前的旧边表。
  invalidateEdgeCache()
  for (const p of store.paths) {
    if (p.anchorsManual) continue
    const { heads, tails } = pathHeadsTails(p)
    const hy = heads.map((id) => epById.get(id)?.y).filter((v): v is number => v !== undefined)
    const ty = tails.map((id) => epById.get(id)?.y).filter((v): v is number => v !== undefined)
    const sm = medianYs(hy), em = medianYs(ty)
    p.ayStart = sm === null ? [] : [sm]
    p.ayEnd = em === null ? [] : [em]
  }
}

// ── 校验（只算/标红，不拦截） ───────────────────────────────────
interface Validation {
  backward: Set<string> // "pathId|a|b"
  badNodes: Set<string> // 倒流边涉及的端点 id
  orphans: Set<string> // 任何路径都没连的端点
  badAnchors: Set<string> // pathId:start/end
}
function validate(): Validation {
  const v: Validation = { backward: new Set(), badNodes: new Set(), orphans: new Set(), badAnchors: new Set() }
  const used = new Set<string>()
  for (const pth of store.paths) {
    for (const { pair } of pathEdges(pth)) {
      const [a, b] = pair
      const ea = epById.get(a), eb = epById.get(b)
      if (!ea || !eb) continue
      used.add(a); used.add(b)
      if (eb.time <= ea.time + 1e-6) {
        v.backward.add(`${pth.id}|${a}|${b}`)
        v.badNodes.add(a); v.badNodes.add(b)
      }
    }
    if (!pth.ayStart.length) v.badAnchors.add(`${pth.id}|start`)
    if (!pth.ayEnd.length) v.badAnchors.add(`${pth.id}|end`)
  }
  for (const e of endpoints) if (!used.has(e.id)) v.orphans.add(e.id)
  return v
}
let validation: Validation = { backward: new Set(), badNodes: new Set(), orphans: new Set(), badAnchors: new Set() }

/** 最终判定：每条路径 有起/终锚点、非空、边严格单向（头/尾自动接竖线）；漏音不管 */
function finalCheck(): string[] {
  if (!revealDone) return [t('l3.rendering')]
  const problems: string[] = []
  for (const pth of store.paths) {
    const tag = pathDisplayName(pth)
    if (!pth.ayStart.length || !pth.ayEnd.length) { problems.push(t('l3.problem.noTerm', { tag })); continue }
    const es = pathEdges(pth)
    if (!es.length) { problems.push(t('l3.problem.empty', { tag })); continue }
    for (const { pair } of es) {
      const ea = epById.get(pair[0]), eb = epById.get(pair[1])
      if (!ea || !eb || eb.time <= ea.time + 1e-6) { problems.push(t('l3.problem.backward', { tag })); break }
    }
  }
  return [...new Set(problems)]
}

// ── 覆盖层渲染 ────────────────────────────────────────────────
let pendingFrom: string | null = null
let selectedEdge: { pathId: string; pair: Pair } | null = null
let mouseUser: { x: number; y: number } | null = null
// 端点拖动：重连选中边 / 新建连线。pointerdown 记录起点，移动超过阈值进入拖动，
// 释放时若有吸附目标则执行重连/新建（重连到对端则删除该边），否则当作单击。
interface EpDrag {
  id: string
  startX: number
  startY: number
  moved: boolean
  /** 手指按压：位移阈值要放宽（见 EP_TAP_SLOP），否则轻点被当成拖动，端点选不上 */
  touch: boolean
  /** true=拖动选中边的端点以重连；false=从端点拖出新建连线 */
  reconnect: boolean
  edgePathId?: string
  edgePair?: Pair
  snapId: string | null
  /** 只有端点已被选中（pendingFrom 或选中边端点）才允许拖动，否则本按压只是单击选中 */
  allowDrag: boolean
}
let epDrag: EpDrag | null = null
const EP_DRAG_THRESHOLD = 4 // px，区分单击与拖动
/** 手指按住端点时坐标天然抖动，4px 一碰就超；轻点判定放宽到 12px */
const EP_TAP_SLOP = 12
const SNAP_RADIUS = 22 // SVG 用户单位，吸附半径
const LONG_PRESS_MS = 450 // 长按触发「共端点重连相邻两边」

// 长按共端点重连：选中端点后长按，该端点同路径的入边+出边均变虚线，拖动时两边同时重连
let longPressTimer: number | null = null
let longPressActive = false

// 选中边中间拖动加点：A-B 选中后从线段中间拖到 C → A-C-B
interface EdgeMidDrag {
  pathId: string
  pair: Pair
  startX: number
  startY: number
  moved: boolean
  snapId: string | null
}
let edgeMidDrag: EdgeMidDrag | null = null
// 当前持有拖拽的那根手指/光标：多指同屏时，第二根手指的 move/up/cancel 会
// 落到同一组全局 window 监听器上，把第一根手指正在进行的拖拽劫持甚至提前提交。
let dragPointerId: number | null = null
const tempLine = document.createElementNS(SVG_NS, 'path')
tempLine.setAttribute('class', 'lk-temp')
tempLine.style.stroke = '#3c4048'
tempLine.setAttribute('visibility', 'hidden')

/** 有选中态（端点/边）时隐藏运动圆球，取消选中或播放时重新渲染 */
function selectionActive(): boolean {
  return pendingFrom !== null || selectedEdge !== null || longPressActive
}

function renderAll(save = true): void {
  if (!edgeLayer || !nodeLayer || !termLayer || !ballLayer) return
  // 边表缓存在一次整层重绘的范围内有效：渲染中途 store 不会再变，
  // 之后到下一次 renderAll 之间（播放每帧）都直接命中缓存
  invalidateEdgeCache()
  renderRev++ // validation 只在这里重算，端点 class 缓存的签名要能感知到
  validation = validate()
  renderTerms()
  renderEdges()
  renderNodes()
  renderPathWindow()
  if (selectionActive()) {
    ballLayer!.innerHTML = '' // 选中时隐藏圆球
    resetBallPool() // 池子里的圆点跟着这层一起没了
  } else {
    renderBalls(localTau)
  }
  if (save) persist()
}

function renderTerms(): void {
  termLayer!.innerHTML = ''
  if (!svg) return
  const vbH = Number(svg.dataset.vbH) || 1000
  for (const [x, which, labelKey] of [
    [startX, 'start', t('l3.term.start')],
    [endX, 'end', t('l3.term.end')],
  ] as const) {
    // 隐形加粗命中线：竖线本身 pointer-events:none，拖拽只吃这条 24 宽的命中线
    const hit = document.createElementNS(SVG_NS, 'line')
    hit.setAttribute('class', 'lk-term-hit')
    hit.setAttribute('x1', String(x)); hit.setAttribute('x2', String(x))
    hit.setAttribute('y1', '0'); hit.setAttribute('y2', String(vbH))
    hit.dataset.which = which
    termLayer!.appendChild(hit)
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('class', 'lk-term-line')
    line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x))
    line.setAttribute('y1', '0'); line.setAttribute('y2', String(vbH))
    termLayer!.appendChild(line)
    const lbl = document.createElementNS(SVG_NS, 'text')
    lbl.setAttribute('class', 'lk-term-label')
    lbl.setAttribute('x', String(x)); lbl.setAttribute('y', '40')
    lbl.setAttribute('text-anchor', 'middle')
    lbl.textContent = labelKey
    termLayer!.appendChild(lbl)
  }
  for (const p of store.paths) {
    const mk = (ays: number[], which: 'start' | 'end'): void => {
      const bad = revealDone && validation.badAnchors.has(`${p.id}|${which}`)
      ays.forEach((ay, idx) => {
        const c = document.createElementNS(SVG_NS, 'circle')
        c.setAttribute('class', `lk-anchor${bad ? ' is-bad' : ''}${p.anchorsManual ? ' is-manual' : ''}`)
        c.setAttribute('cx', String(which === 'start' ? startX : endX))
        c.setAttribute('cy', String(ay))
        c.setAttribute('r', '11')
        c.dataset.pathId = p.id
        c.dataset.which = which
        c.dataset.index = String(idx)
        if (bad) { c.style.stroke = '#e5232b'; c.style.fill = '#ffe3e4' }
        else if (p.anchorsManual) { c.style.stroke = p.color; c.style.strokeWidth = '4' }
        termLayer!.appendChild(c)
      })
    }
    mk(p.ayStart, 'start')
    mk(p.ayEnd, 'end')
  }
}

function renderEdges(): void {
  edgeLayer!.innerHTML = ''
  // 连线永远只画一条所属路径颜色的细线；倒流/断线的红色提示只落在端点上。
  // 注意：Verovio 给 SVG 注入了 #<id> path{stroke:currentColor}，表现属性会被
  // 覆盖成 currentcolor，必须用内联 style.stroke 才能真正显示路径色。
  // 长按选中端点时，该端点相邻的边（所有路径）变虚线，提示将被共端点重连
  const adjIds = longPressActive && pendingFrom ? adjacentEdgeKeys(pendingFrom) : null
  for (const { path: p, pair } of allPairs()) {
    const a = epById.get(pair[0]), b = epById.get(pair[1])
    if (!a || !b) continue
    const g = document.createElementNS(SVG_NS, 'g')
    g.setAttribute('class', 'lk-edge')
    const isSel = selectedEdge && selectedEdge.pathId === p.id && pairEq(selectedEdge.pair[0], selectedEdge.pair[1], pair[0], pair[1])
    if (isSel) g.classList.add('is-selected')
    if (adjIds && adjIds.has(`${p.id}|${pair[0]}|${pair[1]}`)) g.classList.add('is-selected') // 复用虚线样式
    // 选中报错边：红绿闪烁
    const badKey = `${p.id}|${pair[0]}|${pair[1]}`
    if (isSel && validation.backward.has(badKey)) g.classList.add('is-bad-flash')
    const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
    const hit = document.createElementNS(SVG_NS, 'path')
    hit.setAttribute('class', 'lk-edge-hit')
    hit.setAttribute('d', d)
    // Verovio 的 #id path{stroke:currentColor} 会把透明点击带也染成灰带，内联强制透明
    hit.style.stroke = 'transparent'
    hit.dataset.pathId = p.id
    hit.dataset.from = pair[0]
    hit.dataset.to = pair[1]
    const line = document.createElementNS(SVG_NS, 'path')
    line.setAttribute('class', 'lk-edge-line')
    line.setAttribute('d', d)
    line.style.stroke = p.color
    g.append(hit, line)
    edgeLayer!.appendChild(g)
  }
  // 头尾接线：每个头(无入边)→起点线上最近锚点，每个尾(无出边)→终点线上最近锚点；路径色细线
  for (const pth of store.paths) {
    const { heads, tails } = pathHeadsTails(pth)
    const lead = (ids: string[], ays: number[], xLine: number): void => {
      if (!ays.length) return
      for (const id of ids) {
        const e = epById.get(id)
        if (!e) continue
        const ay = nearestAnchor(ays, e.y)
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('class', 'lk-edge-line')
        path.style.stroke = pth.color
        path.setAttribute('d', `M ${xLine} ${ay} L ${e.x} ${e.y}`)
        edgeLayer!.appendChild(path)
      }
    }
    lead(heads, pth.ayStart, startX)
    lead(tails, pth.ayEnd, endX)
  }
  // epDrag / edgeMidDrag 期间临时线由 pointermove 直接控制，这里不动它
  if (!epDrag && !edgeMidDrag) {
    if (pendingFrom && mouseUser) {
      const a = epById.get(pendingFrom)!
      tempLine.setAttribute('d', `M ${a.x} ${a.y} L ${mouseUser.x} ${mouseUser.y}`)
      tempLine.style.stroke = selectedPath()?.color ?? '#3c4048'
      tempLine.setAttribute('visibility', 'visible')
    } else {
      tempLine.setAttribute('visibility', 'hidden')
    }
  }
  if (!tempLine.parentNode) edgeLayer!.appendChild(tempLine)
}

/** 端点圆点：位置在铺开后就不再变，每帧只有「状态色」在变。
 *  原来 renderNodes 是 innerHTML='' 再给每个端点建 g + 2 个 circle
 *  （≈14N 次 DOM 操作，96 个端点就 1300+ 次，端点上千时一帧就吃掉了整个刷新预算），
 *  而且每帧重建会让 is-bad-flash 这类 CSS 动画从头重放。
 *  改成：端点集合没变就只比对 class 串，变了才整层重建。 */
interface NodeItem { ep: Endpoint; c: SVGCircleElement; cls: string }
let nodeItems: NodeItem[] = []

/** 端点当前状态对应的 class 串（优先级与原来一致） */
function nodeClassFor(e: Endpoint, selIds: Set<string>, bad: boolean, visited: boolean): string {
  const sel = selIds.has(e.id) || pendingFrom === e.id
  let cls = 'lk-node'
  if (bad && sel) cls += ' is-bad-flash' // 选中报错端点：红绿闪烁
  else if (bad) cls += ' is-bad'
  else if (epDrag?.snapId === e.id) cls += ' is-snap'
  else if (visited) cls += ' is-visited'
  else if (selIds.has(e.id)) cls += ' is-endpoint-sel'
  else if (pendingFrom === e.id) cls += ' is-pending'
  return cls
}

/** endpoints 已按 time 升序 → 二分出「播放头走过多少个」，
 *  替代每个端点比一次时间（一千个端点的谱每帧省掉一千次比较与字符串拼接） */
function countVisited(tau: number): number {
  const os = store.offStart
  let lo = 0
  let hi = endpoints.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (endpoints[mid]!.time + os <= tau + 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo
}

let lastNodeSig = ''
let lastVisited = -1
/** renderAll 里自增：validation（红点集合）只在那儿重算，签名要能察觉它变了 */
let renderRev = 0

function renderNodes(): void {
  // 端点状态色：问题（孤立/断线/倒流）红；走过/正确绿；选中边端点/待连线=绿；
  // 拖动吸附目标=白底绿描边。连线本身始终是路径色，不参与红/绿。
  const selEpIds = new Set<string>()
  if (selectedEdge) { selEpIds.add(selectedEdge.pair[0]); selEpIds.add(selectedEdge.pair[1]) }
  const dur = totalDur()
  const vis = localTau <= dur + 1e-6 ? countVisited(localTau) : 0
  const sig = `${pendingFrom ?? ''}|${selectedEdge?.pathId ?? ''}|${selectedEdge?.pair[0] ?? ''}|${selectedEdge?.pair[1] ?? ''}|${epDrag?.snapId ?? ''}|${revealDone}|${renderRev}`
  const structural = nodeItems.length !== endpoints.length || nodeItems.some((it, i) => it.ep !== endpoints[i])
  // 播放中的绝大多数帧：绿了多少个没变、选中/吸附/校验也都没动 → 整轮直接跳过
  if (!structural && sig === lastNodeSig && vis === lastVisited) return
  if (structural) {
    nodeLayer!.innerHTML = ''
    nodeItems = []
    for (const e of endpoints) {
      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('class', 'lk-node-g')
      g.dataset.ep = e.id
      const hit = document.createElementNS(SVG_NS, 'circle')
      hit.setAttribute('class', 'lk-node-hit')
      hit.setAttribute('cx', String(e.x)); hit.setAttribute('cy', String(e.y)); hit.setAttribute('r', '13')
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('r', '6.5')
      c.setAttribute('cx', String(e.x)); c.setAttribute('cy', String(e.y))
      g.append(hit, c)
      nodeLayer!.appendChild(g)
      nodeItems.push({ ep: e, c, cls: '' })
    }
  }
  for (let i = 0; i < nodeItems.length; i++) {
    const it = nodeItems[i]!
    // 流式铺开未完成时不标红（未来小节的端点尚未出现，避免一路红闪）
    const bad = revealDone && (validation.badNodes.has(it.ep.id) || validation.orphans.has(it.ep.id))
    const cls = nodeClassFor(it.ep, selEpIds, bad, i < vis)
    if (cls !== it.cls) {
      it.c.setAttribute('class', cls)
      it.cls = cls
    }
  }
  lastNodeSig = sig
  lastVisited = vis
}

// ── 路径选择悬浮窗 ────────────────────────────────────────────
let pathPanel: HTMLElement
// 正在改名的格子。renderPathWindow 每次 renderAll 都整块 innerHTML='' 重建，
// 而「移除正在聚焦的元素」不会触发 blur —— 用户刚敲进去的名字会连同节点一起被丢掉。
// 所以面板重建前先替这一格收尾。
let renameState: { input: HTMLInputElement; apply: () => void } | null = null
function settleRename(): void {
  const st = renameState
  if (!st) return
  renameState = null
  st.apply() // 只落数据不重绘：调用方本来就在重绘
}
function renderPathWindow(): void {
  if (!pathPanel) return
  settleRename()
  pathPanel.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'lk-paths__head'
  head.textContent = t('l3.paths')
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'lk-paths__add'
  add.textContent = '+'
  add.title = t('l3.addPath')
  add.setAttribute('aria-label', t('l3.addPath'))
  add.addEventListener('click', () => addPath())
  head.append(add)
  pathPanel.append(head)
  if (!store.paths.length) {
    const empty = document.createElement('div')
    empty.className = 'lk-paths__empty'
    empty.textContent = t('l3.noPath')
    pathPanel.append(empty)
    return
  }
  const keysId = 'lk-path-keys'
  const keys = document.createElement('span')
  keys.className = 'sh-sr-only'
  keys.id = keysId
  keys.textContent = t('l3.pathKeys')
  const list = document.createElement('div')
  list.className = 'lk-paths__list'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', t('l3.pathList'))
  list.setAttribute('aria-describedby', keysId)
  pathPanel.append(keys, list)

  // renderAll 会清空重建整个面板，焦点会掉回 body；操作前在面板里就把焦点还回去
  const focusRow = (id: string): void => {
    const el = Array.from(pathPanel?.querySelectorAll<HTMLElement>('.lk-pathrow') ?? []).find(
      (r) => r.dataset.pathId === id,
    )
    el?.focus()
  }
  const select = (id: string): void => {
    const keepFocus = !!pathPanel?.contains(document.activeElement)
    store.selected = id
    selectedEdge = null
    pendingFrom = null
    renderAll()
    if (keepFocus) focusRow(id)
  }

  for (const p of store.paths) {
    const active = p.id === store.selected
    const row = document.createElement('div')
    row.className = `lk-pathrow${active ? ' is-active' : ''}`
    row.dataset.pathId = p.id
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', active ? 'true' : 'false')
    row.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown F2 Delete C')
    row.tabIndex = active ? 0 : -1

    const openPicker = (): void => {
      // 同一时刻只留一个取色器：上一次没正常关闭（取消/不支持弹层）时先清掉，避免隐形 input 堆积
      document.querySelector('.lk-colorpick')?.remove()
      const picker = document.createElement('input')
      picker.type = 'color'
      picker.className = 'lk-colorpick'
      picker.value = p.color
      picker.style.position = 'fixed'
      picker.style.left = '-9999px'
      picker.style.opacity = '0'
      picker.style.pointerEvents = 'none'
      document.body.appendChild(picker)
      picker.addEventListener('input', () => {
        p.color = picker.value
        sw.style.background = p.color
        renderEdges()
        renderTerms()
        persist()
      })
      // change=选定关闭；cancel=未选直接 dismiss（Chrome 111+）。两者都要移除，
      // 否则取消弹层后隐形 input 永远留在 body 里。
      const cleanup = (): void => { picker.remove(); renderAll() }
      picker.addEventListener('change', cleanup)
      picker.addEventListener('cancel', cleanup)
      picker.click()
    }
    const sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'lk-sw'
    sw.style.background = p.color
    sw.title = t('l3.dblClickColor')
    sw.setAttribute('aria-label', t('l3.changeColor'))
    sw.tabIndex = -1 // 键盘走所在行的 C 键，不让 Tab 在每行里停三次
    sw.addEventListener('click', (ev) => { ev.stopPropagation(); select(p.id) })
    sw.addEventListener('dblclick', (ev) => { ev.stopPropagation(); openPicker() })
    sw.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      ev.stopPropagation()
      openPicker()
    })

    const startRename = (): void => {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'lk-pathrow__edit'
      input.value = pathDisplayName(p)
      input.maxLength = 40
      input.setAttribute('aria-label', t('l3.renamePath'))
      name.replaceWith(input)
      input.focus()
      input.select()
      const apply = (): void => {
        const next = uniquePathName(input.value, p.id)
        p.name = next || undefined
      }
      renameState = { input, apply }
      const commit = (): void => {
        if (renameState?.input !== input) return // 面板重建时已收尾过
        renameState = null
        apply()
        renderAll()
        focusRow(p.id)
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        e.stopPropagation() // 改名期间 F2/Delete/方向键归输入框，别触发行的快捷键
        if (e.key === 'Enter') { e.preventDefault(); input.blur() }
        else if (e.key === 'Escape') { input.value = pathDisplayName(p); input.blur() }
      })
    }
    const name = document.createElement('span')
    name.className = 'lk-pathrow__name'
    name.textContent = pathDisplayName(p)
    name.title = t('l3.dblClickRename')
    name.addEventListener('dblclick', (ev) => { ev.stopPropagation(); startRename() })

    const askDelete = (): void => {
      void confirmDialog({
        message: t('l3.delPathConfirm', { name: pathDisplayName(p) }),
        confirmText: t('confirm.delete'),
        danger: true,
      }).then((ok) => { if (ok) removePath(p.id) })
    }
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'lk-pathrow__del'
    del.textContent = '×'
    del.title = t('l3.delPath')
    del.setAttribute('aria-label', t('l3.delPath'))
    del.tabIndex = -1 // 键盘走所在行的 Delete 键
    del.addEventListener('click', (ev) => { ev.stopPropagation(); askDelete() })

    row.append(sw, name, del)
    row.addEventListener('click', () => select(p.id))
    row.addEventListener('keydown', (ev) => {
      const k = ev.key
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
        ev.preventDefault()
        ev.stopPropagation()
        const rows = Array.from(list.querySelectorAll<HTMLElement>('.lk-pathrow'))
        const i = rows.indexOf(row)
        const j =
          k === 'Home' ? 0
          : k === 'End' ? rows.length - 1
          : k === 'ArrowDown' ? Math.min(rows.length - 1, i + 1)
          : Math.max(0, i - 1)
        const nid = rows[j]?.dataset.pathId
        if (nid) { select(nid); focusRow(nid) }
        return
      }
      if (k === 'Enter' || k === ' ') {
        ev.preventDefault()
        ev.stopPropagation()
        select(p.id)
        focusRow(p.id)
        return
      }
      if (k === 'F2') { ev.preventDefault(); ev.stopPropagation(); startRename(); return }
      // 不 stopPropagation 的话，文档级监听会顺手把画布上选中的边一起删掉
      if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); ev.stopPropagation(); askDelete(); return }
      if (k === 'c' || k === 'C') { ev.preventDefault(); ev.stopPropagation(); openPicker() }
    })
    list.append(row)
  }
}
function addPath(): void {
  const p: PathData = {
    id: `p${++pathSeq}`,
    color: PALETTE[store.paths.length % PALETTE.length]!,
    trackKey: `manual:${pathSeq}`,
    auto: [], manual: [], ayStart: [], ayEnd: [], anchorsManual: true,
  }
  store.paths.push(p)
  store.selected = p.id
  renderAll()
}
function removePath(id: string): void {
  store.paths = store.paths.filter((p) => p.id !== id)
  if (store.selected === id) store.selected = store.paths[0]?.id ?? ''
  renderAll()
}

// ── 交互：端点连线 / 选边删除 / 锚点拖动 ─────────────────────────
function clientToUser(clientX: number, clientY: number): { x: number; y: number } {
  const r = svg!.getBoundingClientRect()
  const vbW = Number(svg!.dataset.vbW) || r.width
  const px = r.width / vbW
  return { x: (clientX - r.left) / px, y: (clientY - r.top) / px }
}

// ── 视图缩放（滚轮 / 双指捏合；等比，排版在第 2 步已锁定） ──────────
let svgScale = 1
function applyScale(): void {
  if (!svg) return
  if (vbW) svg.style.width = `${vbW * svgScale}px`
  if (vbH) svg.style.height = `${vbH * svgScale}px`
}
function zoomAt(clientX: number, clientY: number, factor: number): void {
  if (!svg) return
  const ns = Math.min(3, Math.max(0.3, svgScale * factor))
  if (Math.abs(ns - svgScale) < 0.001) return
  const sr = scoreEl.getBoundingClientRect()
  const ax = scoreEl.scrollLeft + (clientX - sr.left)
  const ay = scoreEl.scrollTop + (clientY - sr.top)
  svgScale = ns
  applyScale()
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
const pinchPointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0
let pinchMid = { x: 0, y: 0 }
scoreEl.addEventListener('pointerdown', (e) => {
  // 只登记触摸/笔：鼠标只有一个 pointerId，登记进来只会积累幽灵条目，
  // 残留一条就会让之后每次单指落下都被当成「第二指捏合」而撤掉拖拽
  if (e.pointerType === 'mouse') return
  pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinchPointers.size === 2) {
    abortEdgeDrags()
    const pts = [...pinchPointers.values()]
    pinchDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
    pinchMid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
  }
})
scoreEl.addEventListener(
  'pointermove',
  (e) => {
    if (!pinchPointers.has(e.pointerId)) return
    pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchPointers.size === 2) {
      const pts = [...pinchPointers.values()]
      const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
      if (pinchDist > 0) {
        e.preventDefault()
        zoomAt(pinchMid.x, pinchMid.y, d / pinchDist)
      }
      pinchDist = d
      pinchMid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
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

// 滚动接近已铺小节前沿时提前补挂
scoreEl.addEventListener(
  'scroll',
  () => {
    if (!measureQueue.length || !svg) return
    // 播放跟随自己推的那一滚不算「用户滚到前沿了」，别反过来再铺一轮
    if (
      Math.abs(scoreEl.scrollLeft - progScrollX) < 2 &&
      Math.abs(scoreEl.scrollTop - progScrollY) < 2
    )
      return
    const r = svg.getBoundingClientRect()
    const px = r.width / vbW
    const targetUserX = (scoreEl.scrollLeft + scoreEl.clientWidth * 1.5) / px
    ensureRevealToUserX(targetUserX)
  },
  { passive: true },
)

function onSvgClick(ev: MouseEvent): void {
  // 端点交互（单击选中/拖动连线）统一在 pointerup 里处理，这里只处理「点边选中」和「点空白取消」
  const edgeHit = (ev.target as Element).closest?.('.lk-edge-hit') as SVGPathElement | null
  if (edgeHit) {
    const pathId = edgeHit.dataset.pathId!
    const pair: Pair = [edgeHit.dataset.from!, edgeHit.dataset.to!]
    selectedEdge = { pathId, pair }
    pendingFrom = null
    longPressActive = false
    renderAll()
    return
  }
  if ((ev.target as Element).closest?.('[data-ep]')) return
  // 竖线（含刚拖完的那一下）不当成「点空白」，否则选中的边会被顺手取消
  if ((ev.target as Element).closest?.('.lk-term-hit')) return
  // 空白处：取消选中边 + 取消待连线起点 + 退出长按
  pendingFrom = null
  selectedEdge = null
  longPressActive = false
  renderAll()
}

// Delete 删除选中边（只删人工边或记录自动边抑制）
document.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement | null
  // 路径改名那条 inline input 也是 INPUT；再加上 TEXTAREA / 富文本，
  // 否则在里面按 Delete 会把选中的边一起删掉
  const typing =
    tgt?.tagName === 'INPUT' ||
    tgt?.tagName === 'TEXTAREA' ||
    tgt?.tagName === 'SELECT' ||
    !!tgt?.isContentEditable ||
    // 策略面板等自绘下拉是 <button>，展开时 Esc/Backspace 归它，不该顺手删边
    isSelectUI(e.target)
  if (typing || document.querySelector('.sh-modal:not([hidden])')) return
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEdge) {
    deleteEdge(selectedEdge.pathId, selectedEdge.pair)
    selectedEdge = null
    renderAll()
    return
  }
  if (e.key === 'Escape') { pendingFrom = null; selectedEdge = null; longPressActive = false; renderAll() }
})

// 鼠标移动：临时连线跟随 + 锚点拖动 + 端点拖动吸附 + 线段中间加点预览
let anchorDrag: { pathId: string; which: 'start' | 'end'; index: number } | null = null
// 起/终点竖线水平拖拽：落账的是「离符头的距离」（store.termStartGap/termEndGap），
// 第五页按同一份数据放起点/终点线 → 这里拖一次，两页的竖线一起动。
let termDrag: { which: 'start' | 'end' } | null = null
window.addEventListener('pointermove', (e) => {
  // 拖拽只认发起它的那根手指；但手指可能凭空消失（移出窗口/系统打断）而收不到
  // up/cancel，所以四类拖拽状态全空时把登记也一并清掉，免得卡住之后的鼠标悬停预览
  if (!epDrag && !anchorDrag && !edgeMidDrag && !termDrag) dragPointerId = null
  else if (dragPointerId !== null && e.pointerId !== dragPointerId) return
  if (termDrag) {
    const u = clientToUser(e.clientX, e.clientY)
    const gap = clamp(
      termDrag.which === 'start' ? notesLo - u.x : u.x - notesHi,
      TERM_GAP_MIN,
      TERM_GAP_MAX,
    )
    if (termDrag.which === 'start') {
      store.termStartGap = gap
      startX = notesLo - gap
    } else {
      store.termEndGap = gap
      endX = notesHi + gap
    }
    renderTerms()
    renderEdges() // 头/尾接线段从竖线出发（d 里带 startX/endX）
    return
  }
  if (anchorDrag) {
    const u = clientToUser(e.clientX, e.clientY)
    const p = store.paths.find((x) => x.id === anchorDrag!.pathId)
    if (p) {
      const arr = anchorDrag.which === 'start' ? p.ayStart : p.ayEnd
      if (anchorDrag.index in arr) arr[anchorDrag.index] = u.y
      renderTerms()
      renderEdges()
    }
    return
  }
  if (epDrag) {
    mouseUser = clientToUser(e.clientX, e.clientY)
    if (!epDrag.moved) {
      const d = Math.hypot(e.clientX - epDrag.startX, e.clientY - epDrag.startY)
      if (d > (epDrag.touch ? EP_TAP_SLOP : EP_DRAG_THRESHOLD)) {
        epDrag.moved = true
        clearLongPress() // 一旦移动就取消长按计时
      }
    }
    if (epDrag.moved && epDrag.allowDrag) {
      const snap = findSnapTarget(mouseUser.x, mouseUser.y, epDrag.id)
      epDrag.snapId = snap?.id ?? null
      if (longPressActive) {
        // 共端点重连：预览所有相邻边的对端 → 吸附点
        renderAdjacentReconnectPreview(epDrag.id, epDrag.snapId ?? mouseUser)
      } else {
        // 单条边重连 / 新建连线
        const from = epDrag.reconnect ? (epDrag.snapId ?? mouseUser) : epById.get(epDrag.id)!
        const to = epDrag.reconnect
          ? epById.get(otherEndpointOf(epDrag.edgePair!, epDrag.id)!)!
          : (epDrag.snapId ? epById.get(epDrag.snapId)! : mouseUser)
        const fx = typeof from === 'object' ? from.x : (epById.get(from as string)?.x ?? mouseUser.x)
        const fy = typeof from === 'object' ? from.y : (epById.get(from as string)?.y ?? mouseUser.y)
        tempLine.setAttribute('d', `M ${fx} ${fy} L ${to.x} ${to.y}`)
        tempLine.style.stroke = epDrag.reconnect ? pathColor(epDrag.edgePathId!) : (selectedPath()?.color ?? '#3c4048')
        tempLine.setAttribute('visibility', 'visible')
      }
    }
    // 拖动过程中边本身没变（预览画在 tempLine 上，落点要到 pointerup 才提交），
    // 这里整层重建 94 条边纯属白费——只刷端点状态（renderNodes 现在是 class 比对，很便宜）
    renderNodes()
    return
  }
  if (edgeMidDrag) {
    mouseUser = clientToUser(e.clientX, e.clientY)
    if (!edgeMidDrag.moved) {
      const d = Math.hypot(e.clientX - edgeMidDrag.startX, e.clientY - edgeMidDrag.startY)
      if (d > EP_DRAG_THRESHOLD) edgeMidDrag.moved = true
    }
    if (edgeMidDrag.moved) {
      const snap = findSnapTarget(mouseUser.x, mouseUser.y, '')
      edgeMidDrag.snapId = snap?.id ?? null
      // 预览：A → 吸附点 → B（两段虚线）
      const A = epById.get(edgeMidDrag.pair[0])!
      const B = epById.get(edgeMidDrag.pair[1])!
      const mid = edgeMidDrag.snapId ? epById.get(edgeMidDrag.snapId)! : mouseUser
      tempLine.setAttribute('d', `M ${A.x} ${A.y} L ${mid.x} ${mid.y} L ${B.x} ${B.y}`)
      tempLine.style.stroke = pathColor(edgeMidDrag.pathId)
      tempLine.setAttribute('visibility', 'visible')
    }
    renderNodes() // 同上：边没变，只刷端点（吸附高亮）
    return
  }
  if (pendingFrom) {
    mouseUser = clientToUser(e.clientX, e.clientY)
    renderNodes() // 待连线状态下只有「选中/吸附」这一层要刷，别再整层重画边
  }
})
window.addEventListener('pointerup', (e) => {
  if (dragPointerId !== null && e.pointerId !== dragPointerId) return
  dragPointerId = null
  if (termDrag) { termDrag = null; renderAll(true); return }
  if (anchorDrag) { anchorDrag = null; renderAll(); return }
  clearLongPress()
  if (edgeMidDrag) {
    const d = edgeMidDrag
    edgeMidDrag = null
    if (d.moved && d.snapId) {
      splitEdge(d.pathId, d.pair, d.snapId)
      // 选中新插入的第一段，方便继续操作
      const ea = epById.get(d.pair[0]), em = epById.get(d.snapId)
      if (ea && em) {
        const pair: Pair = ea.time <= em.time ? [d.pair[0], d.snapId] : [d.snapId, d.pair[0]]
        selectedEdge = { pathId: d.pathId, pair }
      }
    }
    renderAll()
    return
  }
  if (!epDrag) return
  const drag = epDrag
  epDrag = null
  if (drag.moved && drag.allowDrag) {
    if (longPressActive && drag.snapId) {
      // 共端点重连：把所有相邻边里的 drag.id 换成 snapId
      reconnectAdjacentEdges(drag.id, drag.snapId)
      pendingFrom = null
      selectedEdge = null
    } else if (drag.snapId) {
      const target = epById.get(drag.snapId)
      if (target) {
        if (drag.reconnect && drag.edgePair && drag.edgePathId) {
          const otherId = otherEndpointOf(drag.edgePair, drag.id)
          if (drag.snapId === otherId) {
            deleteEdge(drag.edgePathId, drag.edgePair)
            selectedEdge = null
          } else {
            reconnectEdge(drag.edgePathId, drag.edgePair, drag.id, drag.snapId)
            const np: Pair = [drag.edgePair[0] === drag.id ? drag.snapId : drag.edgePair[0], drag.edgePair[1] === drag.id ? drag.snapId : drag.edgePair[1]]
            const nea = epById.get(np[0]), neb = epById.get(np[1])
            selectedEdge = { pathId: drag.edgePathId, pair: (nea && neb && nea.time > neb.time) ? [np[1], np[0]] : np }
          }
        } else {
          const p = selectedPath()
          if (p) addManualEdge(p, drag.id, drag.snapId)
          else hintEl.textContent = t('l3.needPath')
          pendingFrom = null
        }
      }
    }
    longPressActive = false
    renderAll()
    return
  }
  // 未拖动 = 单击端点
  if (!drag.moved) {
    if (drag.reconnect) {
      // 单击选中边的端点：转为端点选中态（变绿，可长按共端点重连）
      pendingFrom = drag.id
      selectedEdge = null
    } else {
      // 单击普通端点：点击-点击连线
      if (pendingFrom && pendingFrom !== drag.id) {
        const p = selectedPath()
        if (p) addManualEdge(p, pendingFrom, drag.id)
        else hintEl.textContent = t('l3.needPath')
        pendingFrom = null
      } else if (pendingFrom === drag.id) {
        pendingFrom = null
      } else {
        pendingFrom = drag.id
        selectedEdge = null
        hintEl.textContent = t('l3.pickTarget')
      }
    }
    renderAll()
    return
  }
  // 拖动但不允许（未先选中）或无吸附：取消
  longPressActive = false
  renderAll()
})

// 手指被判成平移/中断（pointercancel），或第二根手指进入捏合：必须清空所有拖拽态，
// 否则 epDrag 一直挂在那儿，之后的轻点全落进上一笔残留里。
function abortEdgeDrags(): void {
  dragPointerId = null
  if (!epDrag && !anchorDrag && !edgeMidDrag && !termDrag) return
  epDrag = null
  anchorDrag = null
  edgeMidDrag = null
  termDrag = null
  clearLongPress()
  longPressActive = false
  renderAll()
}
window.addEventListener('pointercancel', (e) => {
  // 只是另一根手指（捏合缩放的辅助指）被判成平移时，别打断正在进行的拖拽
  if (dragPointerId !== null && e.pointerId !== dragPointerId) return
  abortEdgeDrags()
})
function onSvgPointerDown(e: PointerEvent): void {
  // 已有手指在拖：第二根手指只该用于捏合缩放（scoreEl 上另有监听），这里不接管，
  // 否则会把第一根手指正在进行的拖拽状态整个换掉
  if (dragPointerId !== null && e.pointerId !== dragPointerId) return
  const a = (e.target as Element).closest?.('.lk-anchor') as SVGCircleElement | null
  if (a && selectedPath() && selectedPath()!.id === a.dataset.pathId) {
    const p = selectedPath()!
    p.anchorsManual = true
    anchorDrag = {
      pathId: a.dataset.pathId!,
      which: a.dataset.which as 'start' | 'end',
      index: Number(a.dataset.index ?? 0),
    }
    dragPointerId = e.pointerId
    e.preventDefault()
    return
  }
  // 起点/终点竖线：整条可横向拖拽（锚点在竖线上，先让锚点命中）
  const th = (e.target as Element).closest?.('.lk-term-hit') as SVGLineElement | null
  if (th) {
    termDrag = { which: th.dataset.which === 'end' ? 'end' : 'start' }
    dragPointerId = e.pointerId
    e.preventDefault()
    return
  }
  const epEl = (e.target as Element).closest?.('[data-ep]') as Element | null
  if (epEl) {
    const id = epEl.getAttribute('data-ep')!
    const edge = edgeOfEndpoint(id)
    const allowDrag = pendingFrom === id || !!edge // 必须先选中（变绿）才能拖动
    epDrag = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      touch: e.pointerType === 'touch',
      reconnect: !!edge,
      edgePathId: edge?.pathId,
      edgePair: edge?.pair,
      snapId: null,
      allowDrag,
    }
    dragPointerId = e.pointerId
    // 选中端点时启动长按计时（共端点重连相邻两边）
    if (allowDrag && pendingFrom === id) startLongPress(id)
    e.preventDefault()
    return
  }
  // 选中边的中间拖动 → 加点
  const edgeHit = (e.target as Element).closest?.('.lk-edge-hit') as SVGPathElement | null
  if (edgeHit && selectedEdge && selectedEdge.pathId === edgeHit.dataset.pathId) {
    const pair: Pair = [edgeHit.dataset.from!, edgeHit.dataset.to!]
    if (pairEq(selectedEdge.pair[0], selectedEdge.pair[1], pair[0], pair[1])) {
      edgeMidDrag = {
        pathId: selectedEdge.pathId,
        pair,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        snapId: null,
      }
      dragPointerId = e.pointerId
      e.preventDefault()
    }
  }
}
// 在竖线上点击给当前路径补默认打点（点空白处而非已有圆点）
function onSvgDblClick(e: MouseEvent): void {
  const p = selectedPath()
  if (!p) return
  const u = clientToUser(e.clientX, e.clientY)
  p.anchorsManual = true
  if (Math.abs(u.x - startX) < 20) { p.ayStart.push(u.y); renderAll() }
  else if (Math.abs(u.x - endX) < 20) { p.ayEnd.push(u.y); renderAll() }
}

// ── 长按：共端点重连相邻两边 ────────────────────────────────────
function startLongPress(id: string): void {
  clearLongPress()
  longPressTimer = window.setTimeout(() => {
    if (epDrag && epDrag.id === id && !epDrag.moved) {
      longPressActive = true
      renderEdges() // 相邻边变虚线
    }
  }, LONG_PRESS_MS)
}
function clearLongPress(): void {
  if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null }
}
/** 把所有相邻边里的 oldId 换成 newId（共端点重连） */
function reconnectAdjacentEdges(oldId: string, newId: string): void {
  if (oldId === newId) return
  for (const p of store.paths) {
    // 处理人工边：替换端点，去重，去自环，按时间排序
    const newManual: Pair[] = []
    for (const m of p.manual) {
      const a = m[0] === oldId ? newId : m[0]
      const b = m[1] === oldId ? newId : m[1]
      if (a === b) continue // 自环丢弃
      const ea = epById.get(a), eb = epById.get(b)
      const sorted: Pair = (ea && eb && ea.time > eb.time) ? [b, a] : [a, b]
      const dup = newManual.some((x) => pairEq(x[0], x[1], sorted[0], sorted[1]))
      if (!dup) newManual.push(sorted)
    }
    p.manual = newManual
    // 处理自动边：把含 oldId 的自动边抑制，转人工（避免重建时复活）
    const affected = p.auto.filter((x) => x[0] === oldId || x[1] === oldId)
    for (const pair of affected) {
      p.auto = p.auto.filter((x) => !pairEq(x[0], x[1], pair[0], pair[1]))
      if (!store.removed.some((r) => pairEq(r[0], r[1], pair[0], pair[1]))) store.removed.push(pair)
      const a = pair[0] === oldId ? newId : pair[0]
      const b = pair[1] === oldId ? newId : pair[1]
      if (a === b) continue // 自环丢弃
      const ea = epById.get(a), eb = epById.get(b)
      const sorted: Pair = (ea && eb && ea.time > eb.time) ? [b, a] : [a, b]
      // 上面刚改了 p.auto / store.removed，边表缓存必须先作废：拿旧表判存在会把该加的
      // 人工边误判成「已有」而漏掉 → 重连后静默断链
      invalidateEdgeCache()
      const exists = allPairs().some((x) => x.path.id === p.id && pairEq(x.pair[0], x.pair[1], sorted[0], sorted[1]))
        || p.manual.some((x) => pairEq(x[0], x[1], sorted[0], sorted[1]))
      if (!exists) p.manual.push(sorted)
    }
  }
  invalidateEdgeCache()
}
/** 共端点重连的预览：画所有相邻边对端 → 目标点的连线 */
function renderAdjacentReconnectPreview(oldId: string, target: { x: number; y: number } | string): void {
  let d = ''
  const tx = typeof target === 'string' ? (epById.get(target)?.x ?? mouseUser!.x) : target.x
  const ty = typeof target === 'string' ? (epById.get(target)?.y ?? mouseUser!.y) : target.y
  for (const { path, pair } of allPairs()) {
    const other = otherEndpointOf(pair, oldId)
    if (!other) continue
    const o = epById.get(other)!
    d += `M ${o.x} ${o.y} L ${tx} ${ty} `
  }
  tempLine.setAttribute('d', d || `M 0 0 L 0 0`)
  tempLine.style.stroke = selectedPath()?.color ?? '#3c4048'
  tempLine.setAttribute('visibility', 'visible')
}

// ── 端点/边操作辅助 ────────────────────────────────────────────
/** 该端点相邻的所有边（跨路径）的 key 集合，用于长按虚线高亮 */
function adjacentEdgeKeys(id: string): Set<string> {
  const keys = new Set<string>()
  for (const { path, pair } of allPairs()) {
    if (pair[0] === id || pair[1] === id) keys.add(`${path.id}|${pair[0]}|${pair[1]}`)
  }
  return keys
}
/** 选中边是否包含该端点（用于判定重连模式） */
function edgeOfEndpoint(id: string): { pathId: string; pair: Pair } | null {
  if (!selectedEdge) return null
  const [a, b] = selectedEdge.pair
  return a === id || b === id ? selectedEdge : null
}
function otherEndpointOf(pair: Pair, id: string): string | null {
  if (pair[0] === id) return pair[1]
  if (pair[1] === id) return pair[0]
  return null
}
/** 查找吸附范围内最近的端点 */
function findSnapTarget(x: number, y: number, excludeId: string): Endpoint | null {
  let best: Endpoint | null = null
  let bestD = SNAP_RADIUS
  for (const e of endpoints) {
    if (e.id === excludeId) continue
    const d = Math.hypot(e.x - x, e.y - y)
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}
/** 在指定路径新增一条人工边（自动按时间排序、去重、拦截同刻） */
function addManualEdge(p: PathData, idA: string, idB: string): void {
  if (idA === idB) return
  const a = epById.get(idA), b = epById.get(idB)
  if (!a || !b) return
  if (Math.abs(a.time - b.time) < 1e-6) {
    hintEl.textContent = t('l3.sameTimeBlocked')
    return
  }
  const from = a.time <= b.time ? idA : idB
  const to = a.time <= b.time ? idB : idA
  const pair: Pair = [from, to]
  const exists = allPairs().some((x) => x.path.id === p.id && pairEq(x.pair[0], x.pair[1], pair[0], pair[1]))
  if (!exists) p.manual.push(pair)
  // 边表缓存按路径 id 存，manual/auto/removed 一改就脏：下面这些改边的函数
  // 出口统一作废，别让下一个读边表的人（或下一次 renderAll 前的校验）拿到旧表。
  invalidateEdgeCache()
}
/** 删除一条边（人工边直接删；自动边记入 removed 抑制） */
function deleteEdge(pathId: string, pair: Pair): void {
  const p = store.paths.find((x) => x.id === pathId)
  if (!p) return
  const mi = p.manual.findIndex((x) => pairEq(x[0], x[1], pair[0], pair[1]))
  if (mi >= 0) p.manual.splice(mi, 1)
  else {
    p.auto = p.auto.filter((x) => !pairEq(x[0], x[1], pair[0], pair[1]))
    if (!store.removed.some((r) => pairEq(r[0], r[1], pair[0], pair[1]))) store.removed.push(pair)
  }
  invalidateEdgeCache()
}
/** 重连：把边的一个端点换成新端点（自动边→转人工，保留原自动边的抑制） */
function reconnectEdge(pathId: string, pair: Pair, oldId: string, newId: string): void {
  const p = store.paths.find((x) => x.id === pathId)
  if (!p || oldId === newId) return
  let newPair: Pair = [pair[0] === oldId ? newId : pair[0], pair[1] === oldId ? newId : pair[1]]
  // 保证时间单向（小时间在前），避免重连后产生倒流边
  const ea = epById.get(newPair[0]), eb = epById.get(newPair[1])
  if (ea && eb && ea.time > eb.time) newPair = [newPair[1], newPair[0]]
  // 去重：若新边已存在（自动或人工），不重复添加
  const dup = allPairs().some((x) => x.path.id === pathId && pairEq(x.pair[0], x.pair[1], newPair[0], newPair[1]))
  const mi = p.manual.findIndex((x) => pairEq(x[0], x[1], pair[0], pair[1]))
  if (mi >= 0) {
    if (dup) { p.manual.splice(mi, 1) } // 已存在同边 → 删掉旧的，避免重复
    else {
      const m = p.manual[mi]!
      m[0] = newPair[0]; m[1] = newPair[1]
    }
    invalidateEdgeCache()
    return
  }
  // 自动边：抑制原自动边，新增人工边承接（若目标已被同路径自动边覆盖则不加）
  p.auto = p.auto.filter((x) => !pairEq(x[0], x[1], pair[0], pair[1]))
  if (!store.removed.some((r) => pairEq(r[0], r[1], pair[0], pair[1]))) store.removed.push(pair)
  if (!dup) p.manual.push(newPair)
  invalidateEdgeCache()
}
/** 线段中间加点：把 A-B 拆成 A-C-B（自动边→拆成两条人工边并抑制原自动边） */
function splitEdge(pathId: string, pair: Pair, midId: string): void {
  const p = store.paths.find((x) => x.id === pathId)
  if (!p) return
  const [A, B] = pair
  if (midId === A || midId === B) return
  // 删除原边
  const mi = p.manual.findIndex((x) => pairEq(x[0], x[1], pair[0], pair[1]))
  if (mi >= 0) p.manual.splice(mi, 1)
  else {
    p.auto = p.auto.filter((x) => !pairEq(x[0], x[1], pair[0], pair[1]))
    if (!store.removed.some((r) => pairEq(r[0], r[1], pair[0], pair[1]))) store.removed.push(pair)
  }
  invalidateEdgeCache() // 原边刚摘掉，下面两段要用最新边表判重
  // 按时间排序后插入两条新边
  const ea = epById.get(A), eb = epById.get(B), em = epById.get(midId)
  if (!ea || !eb || !em) return
  // A-mid 和 mid-B，各自保证时间单向
  const seg1: Pair = ea.time <= em.time ? [A, midId] : [midId, A]
  const seg2: Pair = em.time <= eb.time ? [midId, B] : [B, midId]
  for (const s of [seg1, seg2]) {
    const exists = allPairs().some((x) => x.path.id === pathId && pairEq(x.pair[0], x.pair[1], s[0], s[1]))
    if (!exists) p.manual.push(s)
    invalidateEdgeCache() // 第二段要看得见第一段
  }
}

// ── 播放：圆点沿路径匀速走，音频在留白后进入 ─────────────────────
let player: MideePlayer | null = null
// 加载中的共享 promise：togglePlay 与初始化可能并发调用 ensurePlayer，
// 没有锁的话两者都会 new MideePlayer 并 load，后建的覆盖先建的 → 音频句柄泄漏/错乱。
let playerLoading: Promise<MideePlayer | null> | null = null
let trackPanel: TrackPanelHandle | null = null
let localTau = 0
let isPlaying = false
let rafId = 0
function totalDur(): number {
  return store.offStart + Math.max(0, musicDur) + store.offEnd
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

interface BallPos { x: number; y: number; color: string }
/**
 * 当前时刻每条路径上圆点的用户坐标（用于绘制 + 视野跟随 + 流式追赶）。
 *
 * 模型：**圆点严格沿连线（边）运动**——每条边对应一个圆点，在其两端点
 * [A.time, B.time] 之间做匀速插值；到达 B 的时刻恰好是 B 音符的演奏时刻。
 * 这样：
 *   ① 同轨：自动连线绝不跨轨，圆点天然不串轨；
 *   ② 到达时间严格 = MIDI time；
 *   ③ 严格沿连线走，不出轨（位置就是两端点的直线插值）。
 * 分叉/合并：多条边各自一个点——同刻和弦并行出发、琶音错峰则依次到达，
 * 汇入同一端点时多球自然重合（不能再用“时间桶 + pos 数组下标”配对，否则
 * 和弦→琶音时三个点会被错误地全塞到最先响的那个音）。
 * 首/尾留白：无入边的头端点从起点线飞入、无出边的尾端点飞向终点线。
 */
function ballPositionsAt(tau: number): BallPos[] {
  const out: BallPos[] = []
  const os = store.offStart
  const tot = totalDur()
  const lerp = (x0: number, y0: number, x1: number, y1: number, u: number, color: string): BallPos =>
    ({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, color })
  for (const p of store.paths) {
    const segs: { A: Endpoint; B: Endpoint }[] = []
    const nodes = new Set<string>()
    const indeg = new Set<string>()
    const outdeg = new Set<string>()
    for (const { pair } of pathEdges(p)) {
      const A = epById.get(pair[0])
      const B = epById.get(pair[1])
      if (!A || !B) continue // 小节尚未挂载
      segs.push({ A, B })
      nodes.add(A.id); nodes.add(B.id); indeg.add(B.id); outdeg.add(A.id)
    }
    // ① 首留白：无入边的头端点，从起点线匀速飞入，到达时刻 = 该音时间
    for (const id of nodes) {
      if (indeg.has(id)) continue
      const E = epById.get(id)!
      const te = E.time + os
      if (tau >= -1e-6 && tau <= te + 1e-6) {
        const y0 = p.ayStart.length ? nearestAnchor(p.ayStart, E.y) : E.y
        const u = clamp(tau / Math.max(1e-6, te), 0, 1)
        out.push(lerp(startX, y0, E.x, E.y, u, p.color))
      }
    }
    // ② 真实连线：每条边一个圆点，严格沿线、到达时刻 = B.time
    for (const { A, B } of segs) {
      const ta = A.time + os
      const tb = B.time + os
      if (tau >= ta - 1e-6 && tau <= tb + 1e-6) {
        const u = clamp((tau - ta) / Math.max(1e-6, tb - ta), 0, 1)
        out.push(lerp(A.x, A.y, B.x, B.y, u, p.color))
      }
    }
    // ③ 尾留白：无出边的尾端点，从末音匀速飞向终点线
    for (const id of nodes) {
      if (outdeg.has(id)) continue
      const E = epById.get(id)!
      const te = E.time + os
      if (tau >= te - 1e-6 && tau <= tot + 1e-6) {
        const y1 = p.ayEnd.length ? nearestAnchor(p.ayEnd, E.y) : E.y
        const u = clamp((tau - te) / Math.max(1e-6, tot - te), 0, 1)
        out.push(lerp(E.x, E.y, endX, y1, u, p.color))
      }
    }
  }
  return out
}

/** 圆点池：播放时每帧位置都在变，但「innerHTML='' + 每个球建一次并写 6 个属性」
 *  完全可以换成复用已有 circle 只补 cx/cy（fill 只在换路径时才写）。 */
let ballPool: SVGCircleElement[] = []
/** 球层被整体清空时（选中隐藏球、换谱等）必须调用：池里的节点已经不在文档里了 */
function resetBallPool(): void {
  ballPool = []
}

function renderBalls(tau: number): BallPos[] {
  if (!ballLayer) return []
  const pos = ballPositionsAt(tau)
  while (ballPool.length < pos.length) {
    const c = document.createElementNS(SVG_NS, 'circle')
    c.setAttribute('class', 'lk-ball')
    c.setAttribute('r', '8')
    c.setAttribute('stroke', '#fff')
    c.setAttribute('stroke-width', '2')
    ballLayer.appendChild(c)
    ballPool.push(c)
  }
  for (let i = 0; i < ballPool.length; i++) {
    const c = ballPool[i]!
    const bp = pos[i]
    if (!bp) {
      c.style.display = 'none' // 这一帧球少了：多出来的池子挂起来备用，不销毁
      continue
    }
    if (c.style.display === 'none') c.style.display = ''
    c.setAttribute('cx', bp.x.toFixed(1))
    c.setAttribute('cy', bp.y.toFixed(1))
    if (c.getAttribute('fill') !== bp.color) c.setAttribute('fill', bp.color)
  }
  return pos
}

/** followBalls 自己写下去的滚动位置。滚动事件据此认出「这一滚是程序推的」，
 *  不再反过来触发一轮铺开 + 整层重绘（原来是 自发滚动 → scroll → ensureRevealToUserX
 *  → renderAll → 又写滚动 的自激环，每帧都在抖布局）。 */
let progScrollX = -1
let progScrollY = -1

/** 播放时把所有圆点保持在视野内（横向推进为主，纵向兼顾高低谱表） */
function followBalls(pos: BallPos[]): void {
  if (!svg || !pos.length) return
  const r = svg.getBoundingClientRect()
  const sr = scoreEl.getBoundingClientRect()
  const px = r.width / vbW
  const py = r.height / vbH
  // 用户坐标 → 相对滚动内容原点的像素
  const toContentX = (ux: number): number => r.left - sr.left + scoreEl.scrollLeft + ux * px
  const toContentY = (uy: number): number => r.top - sr.top + scoreEl.scrollTop + uy * py
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const b of pos) {
    minX = Math.min(minX, toContentX(b.x)); maxX = Math.max(maxX, toContentX(b.x))
    minY = Math.min(minY, toContentY(b.y)); maxY = Math.max(maxY, toContentY(b.y))
  }
  const vw = scoreEl.clientWidth
  const vh = scoreEl.clientHeight
  const leadX = maxX
  const viewL = scoreEl.scrollLeft, viewR = viewL + vw
  if (leadX > viewR - vw * 0.28) scoreEl.scrollLeft = leadX - vw * 0.42
  else if (minX < viewL + vw * 0.12) scoreEl.scrollLeft = Math.max(0, minX - vw * 0.2)
  const midY = (minY + maxY) / 2
  const viewT = scoreEl.scrollTop, viewB = viewT + vh
  if (midY > viewB - vh * 0.3) scoreEl.scrollTop = midY - vh * 0.5
  else if (midY < viewT + vh * 0.3) scoreEl.scrollTop = Math.max(0, midY - vh * 0.5)
  // 回读一次真实值（浏览器会自己夹边界），下轮 scroll 事件据此判断是不是自己推的
  progScrollX = scoreEl.scrollLeft
  progScrollY = scoreEl.scrollTop
}

async function ensurePlayer(): Promise<MideePlayer | null> {
  if (player) return player
  if (playerLoading) return playerLoading
  const b64 = playbackMidiB64()
  if (!b64) return null
  playerLoading = (async () => {
    try {
      const p = new MideePlayer({ onProgress: () => undefined, onEnd: onPlayEnd, onState: () => undefined })
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      await p.load(bytes, sessionStorage.getItem('midee.name') ?? undefined)
      player = p
      bar?.attachPlayer()
      trackPanel?.refresh()
      return p
    } catch (err) {
      // 不吞掉：boot 里是 void ensurePlayer()，点播放也是 void togglePlay()，
      // 让 rejection 冒出去只会变成 unhandledrejection（首屏看门狗据此弹「异步任务失败」），
      // 用户看到的是一句不相干的报错，而不是「播放不可用」。
      hintEl.textContent = t('l3.playFail', { err: String(err).slice(0, 120) })
      return null
    }
  })()
  try {
    return await playerLoading
  } finally {
    playerLoading = null
  }
}
function audioWindow(tau: number): [number, number] {
  return [store.offStart, store.offStart + musicDur]
}
async function syncAudio(tau: number, prevTau: number): Promise<void> {
  const p = player
  if (!p) return
  const [a0, a1] = audioWindow(tau)
  const inside = tau >= a0 && tau <= a1
  const wasInside = prevTau >= a0 && prevTau <= a1
  if (inside) {
    const at = clamp(tau - a0, 0, musicDur)
    if (!wasInside) await p.play(at)
    else if (!p.playing && isPlaying) p.play(at).catch(() => undefined)
  } else if (p.playing) {
    p.pause()
  }
}
function onPlayEnd(): void {
  // 音频自然结束（在尾留白开始处）；圆点继续走完尾留白后由 rAF 收尾
}

async function togglePlay(): Promise<void> {
  const p = await ensurePlayer()
  if (!p) { hintEl.textContent = t('l3.noMidi'); return }
  if (isPlaying) {
    isPlaying = false
    p.pause()
  } else {
    if (localTau >= totalDur() - 1e-6) {
      localTau = 0
      scoreEl.scrollLeft = 0 // 从头放：视野回到起点线
    }
    isPlaying = true
    // 播放时取消选中，圆球按最新路径重新运动
    pendingFrom = null
    selectedEdge = null
    longPressActive = false
    await syncAudio(localTau, -1)
  }
  bar?.setPlaying(isPlaying)
}

/** 跳到完整时间线（含首尾偏移）上的某一刻：同步音频位置、补挂小节、刷新并跟随视野 */
function locateTimeline(tau: number): void {
  localTau = clamp(tau, 0, totalDur())
  // 音频整体后移 offStart：留白段把播放器停在 0 / 末尾，音乐段 seek 到 tau-offStart
  if (player) {
    const at = localTau < store.offStart ? 0
      : localTau > store.offStart + musicDur ? musicDur
      : localTau - store.offStart
    player.seek(at)
  }
  const pos = ballPositionsAt(localTau)
  if (measureQueue.length) {
    const r = svg!.getBoundingClientRect()
    const targetX = (Math.max(0, ...pos.map((b) => b.x)) + scoreEl.clientWidth * 0.5) / (r.width / vbW)
    ensureRevealToUserX(targetX)
  }
  renderNodes()
  followBalls(renderBalls(localTau))
  bar?.setProgress(localTau, totalDur())
}
/** 进度条 0..1 → 完整时间线定位 */
function seekFrac(frac: number): void {
  locateTimeline(clamp(frac, 0, 1) * totalDur())
}
/** ±10s（以及播放条进退按钮）：在完整时间线上移动 */
function nudge(deltaSec: number): void {
  locateTimeline(localTau + deltaSec)
}
function frame(): void {
  rafId = requestAnimationFrame(frame)
  if (!isPlaying) return
  // 单播放头：localTau 不再自行积分——由播放头（p.currentTime = playbackEngine.now()，
  // 含变速）平移映射到完整时间线（0..offStart..musicDur..totalDur）；
  // 与第五页同一 MusicTime 轴（0..dur），首尾留白只是本页的显示偏移。
  const prev = localTau
  const mt = player ? player.currentTime : 0
  localTau = Math.min(totalDur(), store.offStart + mt)
  if (localTau >= totalDur() - 1e-6) {
    localTau = totalDur()
    isPlaying = false
    player?.pause()
    bar?.setPlaying(false)
    bar?.setEnded(totalDur())
  } else {
    void syncAudio(localTau, prev)
  }
  // 播放条映射完整时间线（起点线 0:00 → 终点线总时长，含首尾留白）
  bar?.setProgress(localTau, totalDur())
  // 连线是静态的路径色细线，播放时只需刷新端点（绿）与圆点
  renderNodes()
  const pos = renderBalls(localTau)
  // 小球前方小节先铺开，再把视野带到小球
  if (measureQueue.length) {
    const r = svg!.getBoundingClientRect()
    const aheadUser = (Math.max(0, ...pos.map((b) => b.x)) + scoreEl.clientWidth * 1.2) / (r.width / vbW)
    ensureRevealToUserX(aheadUser)
  }
  followBalls(pos)
}
rafId = requestAnimationFrame(frame)

// ── 顶栏分组面板 ──────────────────────────────────────────────
function policyPanel(): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sh-dd-scroll sh-panel-sliders'
  const scopeSel = createSelect({
    options: ([
      ['voice', t('l3.scope.voice')],
      ['voiceStable', t('l3.scope.voiceStable')],
      ['staff', t('l3.scope.staff')],
    ] as [AutoScope, string][]).map(([v, l]) => ({ v, l })),
    value: store.policy.scope,
    onChange: () => apply(),
    ariaLabel: t('l3.scope'),
    className: 'lk-sel',
  })
  const succSel = createSelect({
    options: ([
      ['onset', t('l3.succ.onset')],
      ['release', t('l3.succ.release')],
    ] as [AutoSucc, string][]).map(([v, l]) => ({ v, l })),
    value: store.policy.succ,
    onChange: () => apply(),
    ariaLabel: t('l3.succ'),
    className: 'lk-sel',
  })
  const mkRow = (label: string, selEl: HTMLElement): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'lk-polrow'
    const k = document.createElement('span')
    k.textContent = label
    row.append(k, selEl)
    return row
  }
  box.append(mkRow(t('l3.scope'), scopeSel.el), mkRow(t('l3.succ'), succSel.el))
  const apply = (): void => {
    store.policy = { scope: scopeSel.value() as AutoScope, succ: succSel.value() as AutoSucc }
    const name = sessionStorage.getItem('midee.name') ?? 'untitled'
    saveAutoPolicy(name, store.policy)
    renderProg.show(t('l3.prog.reauto'))
    // 让出一帧让弹窗绘制，再做同步的图计算 + 重绘
    requestAnimationFrame(() => {
      rebuildAutoKeepManual()
      selectedEdge = null
      renderAll()
      renderProg.done(t('l3.prog.reautoDone'))
    })
  }
  const rerun = document.createElement('button')
  rerun.type = 'button'
  rerun.className = 'sh-dd-item'
  rerun.textContent = t('l3.rerunAuto')
  rerun.addEventListener('click', () => {
    store.removed = []
    apply()
  })
  box.append(rerun)
  return box
}

function editPanel(): HTMLElement {
  const box = document.createElement('div')
  const mk = (label: string, fn: () => void): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sh-dd-item'
    b.textContent = label
    b.addEventListener('click', fn)
    box.append(b)
  }
  mk(t('l3.clearPathEdges'), () => {
    const p = selectedPath()
    if (!p) return
    p.manual = []
    for (const e of p.auto) if (!store.removed.some((r) => pairEq(r[0], r[1], e[0], e[1]))) store.removed.push(e)
    p.anchorsManual = true
    p.ayStart = []; p.ayEnd = []
    renderAll()
  })
  mk(t('l3.restoreAuto'), () => {
    const p = selectedPath()
    if (!p) return
    p.manual = []
    // 解除归属该路径轨道的全部自动边的人工删除抑制
    store.removed = store.removed.filter((r) => {
      const h = heads.find((x) => x.noteId === r[0])
      return !h || trackKeyOf(h) !== p.trackKey
    })
    p.anchorsManual = false
    renderProg.show(t('l3.prog.restore'))
    requestAnimationFrame(() => {
      rebuildAutoKeepManual()
      renderAll()
      renderProg.done(t('l3.prog.restoreDone'))
    })
  })
  mk(t('l3.delSelectedPath'), () => {
    if (selectedPath()) removePath(selectedPath()!.id)
  })
  return box
}

function playbackPanel(): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sh-dd-scroll sh-panel-sliders'
  const mk = (label: string, key: 'offStart' | 'offEnd'): HTMLElement => {
    const lab = document.createElement('label')
    lab.className = 'lk-polrow'
    const k = document.createElement('span')
    k.textContent = label
    const inp = document.createElement('input')
    inp.type = 'number'
    inp.className = 'sh-select lk-num'
    inp.min = '0'; inp.max = '5'; inp.step = '0.1'
    inp.value = String(store[key])
    inp.addEventListener('input', () => {
      const v = Number(inp.value)
      if (Number.isFinite(v) && v >= 0 && v <= 5) {
        store[key] = v
        persist() // 首尾留白落盘：第五页显示轴/球头尾弧从这里读（两页偏移同源）
        localTau = clamp(localTau, 0, totalDur())
        renderAll()
        bar?.setProgress(localTau, totalDur()) // 总时长（含留白）变化后同步播放条
      }
    })
    lab.append(k, inp)
    return lab
  }
  box.append(mk(t('l3.offStart'), 'offStart'), mk(t('l3.offEnd'), 'offEnd'))
  return box
}

// ── 启动 ──────────────────────────────────────────────────────
function goNext(): void {
  const probs = finalCheck()
  if (probs.length) {
    hintEl.textContent = `${t('l3.hasProblems')}：${probs.slice(0, 3).join('；')}${probs.length > 3 ? ' …' : ''}`
    hintEl.style.color = 'var(--sh-danger)'
    return
  }
  hintEl.style.color = ''
  goStep(4)
}

async function boot(): Promise<void> {
  const xml = sessionStorage.getItem('midee.xml')
  if (!xml) {
    emptyEl.style.display = 'block'
    document.getElementById('score')!.style.display = 'none'
    mountShell({ step: 3 })
    return
  }
  store = loadStore()
  pathSeq = store.paths.reduce((m, p) => Math.max(m, Number(p.id.replace('p', '')) || 0), 0)
  let openCache: (() => void) | null = null
  trackPanel = createTrackPanel({
    getPlayer: () => player,
    onOpenCache: () => openCache?.(),
  })
  shell = mountShell({
    step: 3,
    title: sessionStorage.getItem('midee.name') ?? t('common.untitled'),
    tools: [],
    tracks: trackPanel.el,
    next: {
      onNext: goNext,
      items: [
        {
          label: t('p2.exportProject'),
          labelKey: 'p2.exportProject',
          run: () => openProjectExportDialog(3),
        },
      ],
    },
    isDirty: () => dirty,
    onExport: () => openProjectExportDialog(3),
  })
  openCache = shell.openCache
  // 超宽/竖屏两段的底部拖动条（滚动时出条、静止时出提示，见 shell/scrollrail.ts）
  createScrollRail(() => scoreEl)
  const buildTools = (): { id: string; label: string; node: HTMLElement }[] => [
    { id: 'policy', label: t('l3.autoTitle'), node: policyPanel() },
    { id: 'edit', label: t('l3.editTitle'), node: editPanel() },
    { id: 'playoff', label: t('l3.playoffTitle'), node: playbackPanel() },
  ]
  shell.setTools(buildTools())
  onLocaleChange(() => {
    shell.setTools(buildTools())
    // 路径名回退标签（P1·高/低）与起止线的「起/终」都随语言变；
    // renderAll(false) 会整层重画（含路径列表），save=false 不重复落盘
    renderAll(false)
  })

  pathPanel = document.createElement('div')
  pathPanel.className = 'lk-paths'
  document.body.appendChild(pathPanel)

  // 竖屏（底栏）与超宽（侧栏）两档：路径面板当抽屉用，默认收起来，
  // 由「路径」按钮就地展开；回到横屏/中窄那两档再摊开——那两档底栏按钮是隐藏的。
  const drawerBands = [
    window.matchMedia('(max-aspect-ratio: 1/1)'),
    window.matchMedia('(min-aspect-ratio: 2/1)'),
  ]
  let stowedByBand = false
  const syncPanelStow = (): void => {
    if (drawerBands.some((m) => m.matches)) {
      if (!pathPanel.hidden) {
        pathPanel.hidden = true
        stowedByBand = true
      }
    } else if (stowedByBand) {
      pathPanel.hidden = false
      stowedByBand = false
    }
  }
  syncPanelStow()
  window.addEventListener('resize', syncPanelStow)
  for (const m of drawerBands) m.addEventListener('change', syncPanelStow)

  bar = createPlayerBar({
    shell,
    storageKey: 'midee.float.link2d',
    getPlayer: () => player,
    togglePlay: () => void togglePlay(),
    seekFrac,
    nudge,
    // 底栏居中 / 侧栏功能区的「路径」：开合本页的路径抽屉
    // （原来这里靠 '.sh-topbar > .sh-menu:first-of-type' 点顶栏按钮，
    //   但顶栏第一个 div 恒为 .sh-sep，选择器永不命中，是个点了没反应的死按钮）
    action: {
      label: () => t('l3.paths'),
      run: () => {
        pathPanel.hidden = !pathPanel.hidden
      },
    },
  })
  bar.setProgress(0, store.offStart + musicDur + store.offEnd)

  applyI18n(document.body)
  hintEl.textContent = t('l3.hint')

  renderProg.show(t('l3.prog.init'))
  const ok = await prepareToolkit(xml)
  if (!ok) { renderProg.done(); return }
  renderProg.set(0.25, t('l3.prog.parse'))
  ensurePathFonts() // 字体预取与后续构建并行（挂载前转换 text→path 需要它就绪）
  // 时间/轨道（含原始 MIDI 轨匹配）与自动图必须在流式挂载前就绪
  buildTimeAndTracks(xml)
  renderProg.set(0.45, t('l3.prog.auto'))
  runAuto(store.policy)
  if (!store.paths.length) buildDefaultPathsFromAuto()
  renderProg.set(0.6, t('l3.prog.lay'))
  const mounted = await mountSvgProgressive() // 小节逐帧铺开，每批触发 scanMountedEndpoints + renderAll；完成后弹窗自动 done
  if (!mounted) {
    renderProg.done(t('l3.prog.renderFail'))
    return
  }
  bar?.setProgress(localTau, totalDur()) // 音乐时长就绪后刷新播放条总时长
  svg!.addEventListener('click', onSvgClick)
  svg!.addEventListener('pointerdown', onSvgPointerDown)
  svg!.addEventListener('dblclick', onSvgDblClick)
  if (sessionStorage.getItem('midee.midi')) void ensurePlayer()
  dirtyWatch = true
}
void boot()

// 装配完成上报：模块顶层求值到此全部走完。中途抛错时这两行不会执行，
// index.html 里的内联看门狗据此把「本页控件没装上」显式报出来（横幅 + 修复页签自检项），
// 而不是留下「页面看着正常、下拉全没了」的静默半初始化状态。
const reportAssembled = (
  window as unknown as { __lumiReady?: () => void }
).__lumiReady
reportAssembled?.()
