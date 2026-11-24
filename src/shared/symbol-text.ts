// ── 符号编辑 + 文字→矢量轮廓（第二页 ↔ 第三页 ↔ 第五页共享） ──────────
// 职责：
//   ① 定义第二页视觉编辑的可编辑元素选择器（NOTE/BAR/EDIT/ALL/LOCKED），
//      data-idx 分配算法与第二页 renderScore 完全一致（文档序打标），
//      保证 midee.symbolEdits 按同一序号跨页生效；
//   ② applySymbolEdits：把第二页编辑（改字/删除/偏移/缩放/加粗/自由文字）
//      原样应用到任意一次 Verovio 渲染产物上（第三页/第五页回退路径用）；
//   ③ convertSvgTextsToPaths：把全部 <text> 原样转成 <path> 字形轮廓——
//      第二页的文字（Times, serif 文本 / Bravura SMuFL 字形 / 中文）进入
//      第五页之前在第三页冻结为纯 path，之后全站只处理 path 元素。
//
// 字体映射（与第二页浏览器渲染对应）：
//   · Verovio 根 svg font-family="Times, serif" → Liberation.ttf（Times 度量兼容）
//   · 叶子 tspan font-family="Bravura"（SMuFL 私有区字符）→ Bravura.ttf（原字体）
//   · Times 没有的字形（中文等）→ noto-7000.ttf（Noto Sans SC 子集兜底）
//   · 加粗（data-bold / Verovio style 的 fing/reh/tempo/ending bold）→
//     轮廓加同色描边近似（stroke-width ≈ 字号 × 0.045）

import type * as opentype from 'opentype.js'
import { fontCss, preloadOutlineFonts, webOutlineFont } from './webfont'

// ── 选择器（与第二页 2dpreview/main.ts 保持同步） ──────────────────
export const NOTE_SEL = 'g.note'
export const BAR_SEL = 'g.barLine, g.barline'
export const EDIT_SEL = [
  'g.label',
  'g.rest',
  'g.mRest',
  'g.fermata',
  'g.dynam',
  'g.hairpin',
  'g.dir',
  'g.tempo',
  'g.reh',
  'g.tupletNum',
  'g.tupletBracket',
  'g.harm',
  'g.arpeg',
  'g.ornament',
  'g.breath',
  'g.artic',
  'g.fing',
  'g.syl',
  'g.trill',
  'g.mordent',
  'g.turn',
  'g.dim',
  'g.trem',
].join(',')
export const ALL_SEL = [NOTE_SEL, BAR_SEL, EDIT_SEL].join(',')
export const LOCKED_SEL = [NOTE_SEL, BAR_SEL].join(',')

// ── 编辑数据（midee.symbolEdits，形状与第二页一致） ────────────────
export interface SymPt {
  x: number
  y: number
}
export interface FreeText {
  x: number
  y: number
  txt: string
  dx: number
  dy: number
  hidden?: boolean
  isTitle?: boolean
  sc?: number
  bold?: boolean
  /** 字体（FONT_CHOICES 的 key；空/缺省 = 默认字体） */
  face?: string
}
export interface SymbolEdits {
  o: (SymPt | null)[]
  h: number[]
  x: Record<string, string>
  f: FreeText[]
  s: Record<string, number>
  bw: number[]
  /** 文本元素指定的字体（idx → FONT_CHOICES key） */
  fb: Record<string, string>
}

export function loadSymbolEdits(): SymbolEdits | null {
  try {
    const raw = sessionStorage.getItem('midee.symbolEdits')
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<SymbolEdits>
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
    return null
  }
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** baseTf 若为纯平移则返回其分量（锚点换算用；Verovio 这些 g 通常无 transform） */
function baseTranslate(base: string): { tx: number; ty: number } | null {
  const m = /^translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)$/.exec(base.trim())
  return m ? { tx: parseFloat(m[1]!), ty: parseFloat(m[2]!) } : null
}

/**
 * 元素渲染锚点（父坐标系）：首个 <text> 的 x/y（Verovio 定位惯例，叶子 tspan
 * 不带定位）经 baseTf 平移换算；无 text 时用 baseTf 平移本身；都无则 (0,0)。
 * 缩放必须围绕该锚点——围绕 SVG 原点缩放会把远离原点的元素甩飞（Verovio
 * 用户坐标上万，×1.2 即偏移数千单位）。
 */
function elementAnchor(g: Element): { ax: number; ay: number } {
  // dataset 写读同名（XML 文档 attribute 大小写敏感，dataset.baseTf ↔ data-base-tf）
  const base = (g as SVGGElement).dataset.baseTf ?? g.getAttribute('transform') ?? ''
  const tr = baseTranslate(base)
  const t = g.querySelector('text')
  if (t) {
    const x = parseFloat(t.getAttribute('x') ?? '0') || 0
    const y = parseFloat(t.getAttribute('y') ?? '0') || 0
    return { ax: x + (tr?.tx ?? 0), ay: y + (tr?.ty ?? 0) }
  }
  return { ax: tr?.tx ?? 0, ay: tr?.ty ?? 0 }
}

/**
 * 合成 transform：偏移（父系单位）+ 围绕锚点的缩放 + 原始 baseTf。
 * 第二页 applyTransform / 拖动、第三五页编辑应用共用同一套语义。
 */
export function composeSymbolTransform(
  g: Element,
  off: SymPt | null,
  sc: number,
): void {
  const base = (g as SVGGElement).dataset.baseTf ?? ''
  const parts: string[] = []
  if (off && (Math.abs(off.x) > 0.001 || Math.abs(off.y) > 0.001)) {
    parts.push(`translate(${r3(off.x)} ${r3(off.y)})`)
  }
  if (Math.abs(sc - 1) > 0.001) {
    const { ax, ay } = elementAnchor(g)
    if (ax || ay) {
      parts.push(`translate(${r3(ax)} ${r3(ay)}) scale(${r3(sc)}) translate(${r3(-ax)} ${r3(-ay)})`)
    } else {
      parts.push(`scale(${r3(sc)})`)
    }
  }
  if (base) parts.push(base)
  g.setAttribute('transform', parts.join(' '))
}

/**
 * 改写元素文字：替换首个叶子 tspan 的内容（保留其 font-size——Verovio 把
 * 真实字号放在叶子 tspan 上、<text> 级是 font-size="0px" 兜底，直接对
 * text.textContent 赋值会毁掉 tspan 使字号归零、文字消失），多余段落删除。
 * 无叶子（空 text）时直接写 text 并补默认字号。
 */
export function rewriteSymbolText(g: Element, val: string): void {
  const txt = g.querySelector('text')
  if (!txt) return
  const leaves = Array.from(txt.querySelectorAll('tspan')).filter(
    (ts) => !ts.querySelector('tspan') && (ts.textContent ?? '').trim() !== '',
  )
  if (leaves.length) {
    leaves[0]!.textContent = val
    for (const extra of leaves.slice(1)) extra.remove()
  } else {
    txt.textContent = val
    const fs = parseFloat(txt.getAttribute('font-size') ?? '0')
    if (!(fs > 0)) txt.setAttribute('font-size', '405px')
  }
}

/**
 * 给一段文字指定字体（第二页显示 / 第三页转 path 共用）。
 * 音乐字形（Bravura tspan）不动——它必须由 SMuFL 字体绘制；其余叶子 tspan
 * 用内联 style 覆盖（Verovio 的 font-family 是表现属性，内联样式优先级更高）。
 * data-font 记录字体 key，供 convertSvgTextsToPaths 选用同一套轮廓字体。
 */
export function applyTextFace(t: Element, key: string | undefined): void {
  const css = key ? fontCss(key) : ''
  ;(t as SVGTextElement).style.fontFamily = css
  if (key) t.setAttribute('data-font', key)
  else t.removeAttribute('data-font')
  for (const ts of Array.from(t.querySelectorAll('tspan'))) {
    if ((ts.getAttribute('font-family') ?? '').includes('Bravura')) continue
    ;(ts as SVGElement).style.fontFamily = css
  }
}

/** 元素（g）内首个 <text> 指定字体 */
export function applySymbolFont(g: Element, key: string | undefined): void {
  const t = g.querySelector('text')
  if (t) applyTextFace(t, key)
}

/**
 * 把第二页编辑原样应用到一次 Verovio 渲染产物（离屏 SVG，尚未挂载）：
 * 打 data-idx（与第二页 renderScore 相同算法）→ 隐藏删除 → 文字改写 →
 * 加粗标记（data-bold，转 path 时加描边）→ 偏移/缩放合成 → 自由文字生成。
 * 音符/小节线（结构锚点）只打标不受编辑（与第二页锁定规则一致）。
 */
export function applySymbolEdits(svg: Element, edits: SymbolEdits): void {
  const all = Array.from(svg.querySelectorAll<SVGGElement>(ALL_SEL))
  all.forEach((g, i) => {
    g.dataset.idx = String(i)
    g.dataset.baseTf = g.getAttribute('transform') ?? ''
  })
  for (const g of all) {
    const i = Number(g.dataset.idx)
    if (!Number.isFinite(i) || i < 0) continue
    if (g.matches(LOCKED_SEL)) continue // 结构锚点：锁定，不应用任何编辑
    if (edits.h.includes(i)) {
      g.remove()
      continue
    }
    const txt = edits.x[String(i)]
    if (txt !== undefined) rewriteSymbolText(g, txt)
    const face = edits.fb[String(i)]
    if (face) applySymbolFont(g, face)
    if (edits.bw.includes(i)) {
      const t = g.querySelector('text')
      if (t) t.setAttribute('data-bold', '1')
    }
    const off = edits.o[i] ?? null
    const sc = edits.s[String(i)] ?? 1
    if ((off && (Math.abs(off.x) > 0.001 || Math.abs(off.y) > 0.001)) || Math.abs(sc - 1) > 0.001) {
      composeSymbolTransform(g, off, sc)
    }
  }
  // 自由文字：挂 definition-scale 内层 svg（与第二页 innerScoreSvg 同层：
  // outer.querySelector('svg')，坐标系≈外层 22 倍大，ft.x/y 是这层的用户坐标）
  const host =
    (svg.matches('svg') ? ((svg.querySelector('svg') as SVGSVGElement | null) ?? (svg as unknown as SVGSVGElement)) : null) ?? null
  if (!host || !edits.f.length) return
  const SVG_NS = 'http://www.w3.org/2000/svg'
  for (const ft of edits.f) {
    if (ft.hidden) continue
    const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
    g.setAttribute('data-freetext', '1')
    g.setAttribute(
      'transform',
      `translate(${r3(ft.x + (ft.dx || 0))} ${r3(ft.y + (ft.dy || 0))})`,
    )
    const t = document.createElementNS(SVG_NS, 'text')
    t.textContent = ft.txt
    t.setAttribute('font-size', String(Math.round(405 * (ft.sc ?? 1))))
    if (ft.face) applyTextFace(t, ft.face)
    if (ft.bold) t.setAttribute('data-bold', '1')
    t.setAttribute('fill', '#111')
    g.appendChild(t)
    host.appendChild(g)
  }
}

// ── 字体（public/fonts 直链按需加载，模块级缓存） ──────────────────
export interface PathFonts {
  latin: opentype.Font
  music: opentype.Font
  cjk: opentype.Font | null
}
let cachedFonts: PathFonts | null = null
let fontsLoading: Promise<PathFonts | null> | null = null

async function loadOtf(url: string): Promise<opentype.Font | null> {
  try {
    const resp = await fetch(new URL(url, document.baseURI).href)
    if (!resp.ok) return null
    const mod = await import('opentype.js')
    // opentype.js v2 只导出 default（命名导出在运行时可能缺失）
    const parse = mod.parse ?? mod.default?.parse
    return parse ? parse(await resp.arrayBuffer()) : null
  } catch {
    return null
  }
}

export function ensurePathFonts(): Promise<PathFonts | null> {
  if (cachedFonts) return Promise.resolve(cachedFonts)
  if (!fontsLoading) {
    fontsLoading = (async () => {
      const [latin, music, cjk] = await Promise.all([
        loadOtf('../../fonts/Liberation.ttf'),
        loadOtf('../../fonts/Bravura.ttf'),
        loadOtf('../../fonts/noto-7000.ttf'),
      ])
      if (!latin || !music) return null
      cachedFonts = { latin, music, cjk }
      return cachedFonts
    })()
  }
  return fontsLoading
}

/** SMuFL 私有区（Bravura 音乐字形） */
const isSmufl = (ch: string): boolean => /[\uE000-\uF8FF]/.test(ch)

function hasGlyph(font: opentype.Font | null, ch: string): boolean {
  const g = font?.charToGlyph(ch)
  return !!g && g.index !== 0
}

/** 历史兜底链：Liberation（Times 度量）→ Noto 中文字集 */
function fallbackFont(ch: string, f: PathFonts): opentype.Font | null {
  if (hasGlyph(f.latin, ch)) return f.latin
  if (hasGlyph(f.cjk, ch)) return f.cjk
  return null
}

/** 字符 → 字形字体：SMuFL→Bravura；空白→Liberation（advance 用）；其余按
 *  第二页指定的字体取轮廓，缺字形时回落到历史兜底链（绝不丢字）。空白必须
 *  归入 latin——否则段内空格会被当"无字形字符"跳过，单词连成一片且 advance 计零。 */
function fontForChar(ch: string, f: PathFonts, key = ''): opentype.Font | null {
  if (isSmufl(ch)) return f.music
  if (ch.trim() === '') return f.latin
  if (key && key !== 'liberation') {
    const web = webOutlineFont(key, ch)
    if (web && hasGlyph(web, ch)) return web
  }
  return fallbackFont(ch, f)
}

function advanceWidth(txt: string, fs: number, f: PathFonts, key = ''): number {
  let w = 0
  let cur = ''
  let curFont: opentype.Font | null = null
  const flush = (): void => {
    if (cur && curFont) w += curFont.getAdvanceWidth(cur, fs)
    cur = ''
  }
  for (const ch of txt) {
    const font = fontForChar(ch, f, key)
    if (font && font === curFont) cur += ch
    else {
      flush()
      curFont = font
      cur = ch
    }
  }
  flush()
  return w
}

/** opentype 转出的 path d 偶发 QNaN（个别字体字形坐标异常，
 *  SVG 解析直接抛 “Expected number” 并使整条路径失效）。
 *  把非有限数归 0：字形仍大致在位，杜绝控制台报错。 */
const sanitizePathData = (d: string): string =>
  d.replace(/NaN|Infinity/gi, '0').replace(/-?[\d.]+(?:e[-+]?\d+)?/gi, (m) => (Number.isFinite(Number(m)) ? m : '0'))

/**
 * 一段文本 → path d（跨字体分段合串，段内保留 kerning；y 为基线，
 * opentype y-down 与 SVG 同向）。返回 d 与实际推进宽度。
 */
function runToPath(
  txt: string,
  fs: number,
  bx: number,
  by: number,
  f: PathFonts,
  key = '',
): { d: string; adv: number } | null {
  const segs: { font: opentype.Font; chars: string[] }[] = []
  for (const ch of txt) {
    const font = fontForChar(ch, f, key)
    if (!font) continue // 三套字体都缺字形 → 跳过该字符
    const last = segs[segs.length - 1]
    if (last && last.font === font) last.chars.push(ch)
    else segs.push({ font, chars: [ch] })
  }
  if (!segs.length) return null
  let x = bx
  let any = false
  let dAll = ''
  for (const seg of segs) {
    const str = seg.chars.join('')
    try {
      const p = seg.font.getPath(str, x, by, fs)
      if (p.commands.length) {
        dAll += (dAll ? ' ' : '') + sanitizePathData(p.toPathData(2))
        any = true
      }
      x += seg.font.getAdvanceWidth(str, fs)
    } catch {
      /* 段失败跳过 */
    }
  }
  return any ? { d: dAll, adv: x - bx } : null
}

interface TextLeaf {
  text: string
  fs: number
  smufl: boolean
  key: string
}

/**
 * 转 path 前的异步预取：收集 root 内所有指定了网络字体的文字，把覆盖这些
 * 字符的 woff2 分片全部下载并解析好，之后同步转换才能取到真轮廓。
 */
export async function preloadTextFonts(root: Element): Promise<void> {
  const groups = new Map<string, Set<string>>()
  for (const t of Array.from(root.querySelectorAll('text'))) {
    const key = t.getAttribute('data-font')
    if (!key) continue
    let set = groups.get(key)
    if (!set) groups.set(key, (set = new Set()))
    for (const ch of t.textContent ?? '') if (ch.trim()) set.add(ch)
  }
  await Promise.all([...groups].map(([k, set]) => preloadOutlineFonts(k, set)))
}

/**
 * 把 root 下全部 <text>（含自由文字）原样转成 <path> 字形轮廓并移除原 text。
 * 定位语义与 2D 渲染一致：<text> 的 x/y（基线起点）+ text-anchor
 * （start/middle/end）；同一 text 内多段叶子按浏览器排版规则连续流动
 * （段间补一个空格 advance）；叶子 tspan 的 font-size / font-family 生效。
 * 加粗 → 轮廓加同色描边近似。
 */
export function convertSvgTextsToPaths(root: Element, fonts: PathFonts): void {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  for (const t of Array.from(root.querySelectorAll('text'))) {
    // 叶子段收集（叶子 tspan 或无 tspan 的整段 text）
    const leaves: TextLeaf[] = []
    const face = t.getAttribute('data-font') ?? ''
    const tspans = Array.from(t.querySelectorAll('tspan'))
    if (tspans.length) {
      for (const ts of tspans) {
        if (ts.querySelector('tspan')) continue
        const content = (ts.textContent ?? '').replace(/[\n\r\t]/g, '')
        if (!content) continue
        const fs = parseFloat(ts.getAttribute('font-size') ?? '0') ||
          parseFloat(t.getAttribute('font-size') ?? '0') || 0
        if (!(fs > 0)) continue
        const smufl = (ts.getAttribute('font-family') ?? '').includes('Bravura')
        leaves.push({ text: content, fs, smufl, key: face })
      }
    } else {
      const content = (t.textContent ?? '').replace(/[\n\r\t]/g, '')
      if (content.trim()) {
        const fs = parseFloat(t.getAttribute('font-size') ?? '0') || 0
        if (fs > 0) leaves.push({ text: content, fs, smufl: false, key: face })
      }
    }
    if (!leaves.length) {
      // 无可转换叶子：空文本（Verovio 常见的自闭合 <text/> 占位，如空 tempo）
      // 渲染无输出，直接移除保证纯 path；有内容但缺字号的保留给第五页旧管线兜底
      if (!(t.textContent ?? '').trim()) t.remove()
      continue
    }

    const x = parseFloat(t.getAttribute('x') ?? '0') || 0
    const y = parseFloat(t.getAttribute('y') ?? '0') || 0
    const anchor = t.getAttribute('text-anchor') ?? 'start'
    const bold =
      t.getAttribute('data-bold') === '1' || !!t.closest('g.fing, g.reh, g.tempo, g.ending')
    const fill = t.getAttribute('fill')

    // 总宽（段间补空格 advance）→ text-anchor 定位起点
    let totalW = 0
    const widths = leaves.map((L, i) => {
      const w = advanceWidth(L.text, L.fs, fonts, L.key)
      if (i > 0) totalW += advanceWidth(' ', L.fs, fonts, L.key)
      return w
    })
    totalW += widths.reduce((a, b) => a + b, 0)
    let cx = x
    if (anchor === 'middle') cx = x - totalW / 2
    else if (anchor === 'end') cx = x - totalW

    let dAll = ''
    let any = false
    for (let i = 0; i < leaves.length; i++) {
      const L = leaves[i]!
      if (i > 0) cx += advanceWidth(' ', L.fs, fonts, L.key)
      const r = runToPath(L.text, L.fs, cx, y, fonts, L.key)
      if (r) {
        dAll += (dAll ? ' ' : '') + r.d
        any = true
      }
      cx += widths[i] ?? 0
    }
    if (!any) continue

    const pathEl = document.createElementNS(SVG_NS, 'path')
    pathEl.setAttribute('d', dAll)
    pathEl.setAttribute('data-text-path', '1') // 标记：文字轮廓，3D 走 winding 判孔补丁（区别于 Verovio SMuFL path）
    if (fill) pathEl.setAttribute('fill', fill)
    if (bold) {
      // 加粗近似：同色描边外扩（浏览器对 Times 的合成加粗同思路）
      pathEl.setAttribute('stroke', fill ?? 'currentColor')
      pathEl.setAttribute('stroke-width', String(Math.round(leaves[0]!.fs * 0.045)))
      pathEl.setAttribute('stroke-linejoin', 'round')
    }
    t.before(pathEl)
    t.remove()
  }
}
