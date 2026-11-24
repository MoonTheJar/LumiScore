// ── 字体注册表（内置 + 网络字体） ────────────────────────────────
// 第二页「文字元素」可指定字体，选项同时用于 DOM 渲染与第三页 text→path。
//
// 内置字体直接复用 public/fonts 下已有的 ttf/woff2（index.html 已 @font-face）。
// 网络字体走 jsdelivr 的 MiSans（小米开源、可商用、按 script 分包）：
//   · DOM 渲染：注入官方 CSS，浏览器按 unicode-range 懒加载 woff2 分片；
//   · 轮廓/矢量：同一份 CSS 解析出「分片 URL ↔ unicode-range」，按字符抓取
//     对应 woff2，fonteditor-core 解成 sfnt 后交给 opentype.js —— 与内置字体
//     同一条转 path 管线，第三页/第五页拿到的都是真轮廓。

import type * as opentype from 'opentype.js'
import { registerCache } from './cache-registry'

export interface FontChoice {
  key: string
  label: string
  /** CSS font-family 栈（含兜底） */
  css: string
  /** 需要联网下载的字体 */
  remote?: boolean
}

export const FONT_CHOICES: FontChoice[] = [
  { key: '', label: '默认 · Noto Sans SC', css: "'NotoSC','Liberation',sans-serif" },
  { key: 'liberation', label: '衬线 · Liberation', css: "'Liberation','NotoSC',serif" },
  {
    key: 'misans',
    label: 'MiSans · 网络（多语言）',
    // 官方包按 script 拆成多个 family：SC（MiSans VF）、TC、阿拉伯、天城文……
    // 全列进栈里，浏览器逐字回退，落在哪个脚本就用哪套字，无需用户选语言
    css: [
      "'MiSans VF'",
      "'MiSansTC VF'",
      "'MiSansArabic VF'",
      "'MiSansDevanagari VF'",
      "'MiSansGurmukhi VF'",
      "'MiSansKhmer VF'",
      "'MiSansLao VF'",
      "'MiSansMyanmar VF'",
      "'MiSansThai VF'",
      "'MiSansTibetan VF'",
      "'NotoSC'",
      "'Liberation'",
      'sans-serif',
    ].join(','),
    remote: true,
  },
]

const choiceOf = new Map(FONT_CHOICES.map((c) => [c.key, c]))

export function fontCss(key: string | undefined): string {
  return (key ? choiceOf.get(key)?.css : undefined) ?? choiceOf.get('')!.css
}

// ── 网络字体（官方包，按 script 分包） ───────────────────────────
// MiSans Global 官方包按语言拆成多套：Normal（简中+拉丁，56 个 unicode-range
// 分片）、TC（繁体，64 个分片），以及 Arabic / Devanagari / Gurmukhi / Khmer /
// Lao / Myanmar / Thai / Tibetan 这些单文件脚本字库。
// Normal/TC 自带 unicode-range，浏览器只下载用到的分片；单文件字库没有范围声明，
// 这里按脚本区块补上，否则「输入一句日文也会把阿拉伯字库拉下来」。
// 运行时不需要用户选语言：字符落在哪个脚本区块，就只加载那一套。
const REMOTE_BASE = 'https://cdn.jsdelivr.net/npm/misans@5.0.0/'

interface RemoteSource {
  /** 包内 CSS 路径（相对 jsDelivr 包根） */
  css: string
  /** CSS 未声明 unicode-range 时补的脚本区块 */
  ranges?: string
}

const REMOTE_SOURCES: Record<string, RemoteSource[]> = {
  misans: [
    { css: 'lib/Normal/MiSansVF.min.css' },
    { css: 'lib/TC/MiSansTCVF.min.css' },
    {
      css: 'lib/Arabic/MiSansArabicVF.min.css',
      ranges: 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+FB50-FDFF,U+FE70-FEFF',
    },
    {
      css: 'lib/Devanagari/MiSansDevanagariVF.min.css',
      ranges: 'U+0900-097F,U+1CD0-1CFF,U+A8E0-A8FF',
    },
    { css: 'lib/Gurmukhi/MiSansGurmukhiVF.min.css', ranges: 'U+0A00-0A7F,U+A830-A83F' },
    { css: 'lib/Khmer/MiSansKhmerVF.min.css', ranges: 'U+1780-17FF,U+19E0-19FF' },
    { css: 'lib/Lao/MiSansLaoVF.min.css', ranges: 'U+0E80-0EFF' },
    {
      css: 'lib/Myanmar/MiSansMyanmarVF.min.css',
      ranges: 'U+1000-109F,U+A9E0-A9FF,U+AA60-AA7F',
    },
    { css: 'lib/Thai/MiSansThaiVF.min.css', ranges: 'U+0E00-0E7F' },
    { css: 'lib/Tibetan/MiSansTibetanVF.min.css', ranges: 'U+0F00-0FFF' },
  ],
}

interface FaceRule {
  url: string
  family: string
  ranges: [number, number][]
  /** 原样回写的 unicode-range 文本（注入 DOM 时用） */
  rangeText: string
}

const injected = new Set<string>()
const rulesCache = new Map<string, FaceRule[]>()
const rulesLoading = new Map<string, Promise<FaceRule[]>>()

/**
 * 让指定网络字体可用：注入 @font-face（只注入一次）+ 按 sample 里实际出现的
 * 字符预热对应分片。放开成异步也不影响显示——字体到位后浏览器会自动重排。
 */
export async function ensureFontReady(key: string, sample?: string): Promise<void> {
  if (!REMOTE_SOURCES[key]) return
  const rules = await remoteRules(key)
  if (!rules.length) return
  injectStyle(key, rules)
  await loadDomFaces(rules, sample)
}

/** 把解析出来的 @font-face 原样生成 <style>；有 unicode-range 时浏览器按需取分片 */
function injectStyle(key: string, rules: FaceRule[]): void {
  if (injected.has(key)) return
  injected.add(key)
  const style = document.createElement('style')
  style.dataset.mdFont = key
  style.textContent = rules
    .map(
      (r) =>
        `@font-face{font-family:"${r.family}";font-style:normal;font-weight:150 700;` +
        `font-display:swap;src:url("${r.url}") format("woff2");unicode-range:${r.rangeText}}`,
    )
    .join('')
  document.head.appendChild(style)
}

/** 按 sample 里出现的字符，逐个 family 触发一次 document.fonts.load */
async function loadDomFaces(rules: FaceRule[], sample?: string): Promise<void> {
  if (!document.fonts) return
  const text = sample?.trim() || 'Aa中'
  const byFamily = new Map<string, string>()
  for (const ch of text) {
    const r = ruleForChar(rules, ch)
    if (!r) continue
    byFamily.set(r.family, (byFamily.get(r.family) ?? '') + ch)
  }
  if (!byFamily.size) byFamily.set(rules[0]!.family, text)
  await Promise.all(
    [...byFamily].map(([family, chars]) =>
      document.fonts.load(`16px "${family}"`, chars).catch(() => undefined),
    ),
  )
}

function parseUnicodeRange(src: string): [number, number][] {
  const out: [number, number][] = []
  for (const raw of src.split(',')) {
    const p = raw.trim().replace(/^U\+/i, '')
    if (!p) continue
    if (p.includes('?')) {
      const lo = Number.parseInt(p.replace(/\?/g, '0'), 16)
      const hi = Number.parseInt(p.replace(/\?/g, 'F'), 16)
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi])
    } else if (p.includes('-')) {
      const [a, b] = p.split('-')
      const lo = Number.parseInt(a ?? '', 16)
      const hi = Number.parseInt(b ?? '', 16)
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi])
    } else {
      const v = Number.parseInt(p, 16)
      if (Number.isFinite(v)) out.push([v, v])
    }
  }
  return out
}

function parseFaceRules(css: string, base: string, fallbackRanges?: string): FaceRule[] {
  const out: FaceRule[] = []
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1] ?? ''
    const u = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(body)
    if (!u?.[1]) continue
    const fam = /font-family\s*:\s*['"]?([^;'"}]+)['"]?\s*(?:;|$)/i.exec(body)
    const declared = /unicode-range\s*:\s*([^;]+)/i.exec(body)
    const rangeText = declared?.[1]?.trim() || fallbackRanges || 'U+0-10FFFF'
    out.push({
      url: new URL(u[1], base).href,
      family: (fam?.[1] ?? '').trim(),
      ranges: parseUnicodeRange(rangeText),
      rangeText,
    })
  }
  return out
}

function remoteRules(key: string): Promise<FaceRule[]> {
  const hit = rulesCache.get(key)
  if (hit) return Promise.resolve(hit)
  const sources = REMOTE_SOURCES[key]
  if (!sources?.length) return Promise.resolve([])
  let p = rulesLoading.get(key)
  if (!p) {
    p = (async () => {
      const parts = await Promise.all(
        sources.map(async (s) => {
          const cssUrl = new URL(s.css, REMOTE_BASE).href
          try {
            const res = await fetch(cssUrl)
            if (!res.ok) return []
            return parseFaceRules(await res.text(), cssUrl, s.ranges)
          } catch {
            return []
          }
        }),
      )
      // 顺序即优先级：Normal → TC → 各脚本字库，ruleForChar 取首个命中
      const rules = parts.flat()
      rulesCache.set(key, rules)
      return rules
    })()
    rulesLoading.set(key, p)
  }
  return p
}

// ── woff2 → sfnt（fonteditor-core 的 wasm 解码器，浏览器可用） ────
// wawoff2 的 emscripten 绑定只在 Node 分支导出模块，浏览器里 Promise 会永久挂起，
// 所以这里改用 fonteditor-core：woff2.init(wasm) + woff2.decode，Node/浏览器同一套代码。
type Woff2Decoder = {
  init: (url?: string) => Promise<unknown>
  isInited: () => boolean
  decode: (buf: ArrayBuffer | Uint8Array) => Uint8Array
}

let woff2Module: Promise<Woff2Decoder | null> | null = null

function loadWoff2Module(): Promise<Woff2Decoder | null> {
  woff2Module ??= (async () => {
    try {
      const mod = await import('fonteditor-core')
      const w = (mod as unknown as { woff2?: Woff2Decoder }).woff2
      if (!w) return null
      if (!w.isInited()) {
        await w.init(new URL('../../fonts/woff2.wasm', document.baseURI).href)
      }
      return w
    } catch (err) {
      console.warn('[webfont] woff2 解码器加载失败', err)
      return null
    }
  })()
  return woff2Module
}

async function woff2ToSfnt(buf: ArrayBuffer): Promise<ArrayBuffer | null> {
  const mod = await loadWoff2Module()
  if (!mod) return null
  try {
    const out = mod.decode(buf)
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
  } catch {
    return null
  }
}

// ── 分片字体缓存（LRU：CJK 分片单个可达数百 KB，不能无限堆） ──────
// 上限可在「设置 → 缓存设置」里调（localStorage midee.fontCacheLimit）。
const FONT_LIMIT_KEY = 'midee.fontCacheLimit'
const FONT_LIMIT_MIN = 8
const FONT_LIMIT_MAX = 64
const FONT_LIMIT_DEFAULT = 24

function readFontLimit(): number {
  try {
    const n = Number(localStorage.getItem(FONT_LIMIT_KEY))
    if (Number.isFinite(n) && n > 0) return Math.min(FONT_LIMIT_MAX, Math.max(FONT_LIMIT_MIN, Math.round(n)))
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return FONT_LIMIT_DEFAULT
}

let fontLimit = readFontLimit()
const chunkFonts = new Map<string, opentype.Font | null>()
const chunkLoading = new Map<string, Promise<opentype.Font | null>>()
/** 每个分片下载到的字节数（统计用；与 chunkFonts 同步淘汰） */
const chunkBytes = new Map<string, number>()

export function getFontCacheLimit(): number {
  return fontLimit
}

export function setFontCacheLimit(n: number): void {
  fontLimit = Math.min(FONT_LIMIT_MAX, Math.max(FONT_LIMIT_MIN, Math.round(n)))
  try {
    localStorage.setItem(FONT_LIMIT_KEY, String(fontLimit))
  } catch {
    /* noop */
  }
  trimChunks()
}

function trimChunks(): void {
  while (chunkFonts.size > fontLimit) {
    const oldest = chunkFonts.keys().next().value
    if (oldest === undefined) break
    chunkFonts.delete(oldest)
    chunkBytes.delete(oldest)
  }
}

function rememberChunk(url: string, font: opentype.Font | null): void {
  chunkFonts.set(url, font)
  trimChunks()
}

/** 卸载已解析的分片轮廓（DOM 里的 @font-face 保持不动，避免已渲染文字掉字） */
function clearFontCache(): number {
  const n = chunkFonts.size
  chunkFonts.clear()
  chunkLoading.clear()
  chunkBytes.clear()
  return n
}

async function loadChunkFont(url: string): Promise<opentype.Font | null> {
  if (chunkFonts.has(url)) return chunkFonts.get(url) ?? null
  let p = chunkLoading.get(url)
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) return null
        const buf = await res.arrayBuffer()
        chunkBytes.set(url, buf.byteLength)
        const sfnt = await woff2ToSfnt(buf)
        if (!sfnt) return null
        const mod = await import('opentype.js')
        // opentype.js v2 只导出 default（命名导出在运行时可能缺失）
        const parse = mod.parse ?? mod.default?.parse
        return parse ? parse(sfnt) : null
      } catch {
        return null
      }
    })()
    chunkLoading.set(url, p)
  }
  const font = await p
  chunkLoading.delete(url)
  rememberChunk(url, font)
  return font
}

function ruleForChar(rules: FaceRule[], ch: string): FaceRule | null {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return null
  for (const r of rules) {
    for (const [lo, hi] of r.ranges) if (cp >= lo && cp <= hi) return r
  }
  return null
}

/** 转 path 前的异步预取：把 root 里指定了网络字体的文字所需分片全部拉齐 */
export async function preloadOutlineFonts(key: string, chars: Set<string>): Promise<void> {
  if (!REMOTE_SOURCES[key] || !chars.size) return
  const rules = await remoteRules(key)
  if (!rules.length) return
  const urls = new Set<string>()
  for (const ch of chars) {
    const r = ruleForChar(rules, ch)
    if (r) urls.add(r.url)
  }
  await Promise.all([...urls].map((u) => loadChunkFont(u)))
}

/** 同步取字（预取完成后调用）：该字体覆盖此字符的分片字形字体，未就绪返回 null */
export function webOutlineFont(key: string, ch: string): opentype.Font | null {
  const rules = rulesCache.get(key)
  if (!rules) return null
  const r = ruleForChar(rules, ch)
  return r ? (chunkFonts.get(r.url) ?? null) : null
}

// 登记到「设置 → 缓存设置」：可看统计、可卸载、可调分片上限
registerCache({
  id: 'webfont',
  labelKey: 'cache.fonts',
  descKey: 'cache.fonts.desc',
  stats: () => {
    let bytes = 0
    for (const url of chunkFonts.keys()) bytes += chunkBytes.get(url) ?? 0
    return { count: chunkFonts.size, bytes }
  },
  clear: clearFontCache,
  adjust: {
    labelKey: 'cache.fontLimit',
    hintKey: 'cache.fontLimit.hint',
    min: FONT_LIMIT_MIN,
    max: FONT_LIMIT_MAX,
    step: 4,
    get: getFontCacheLimit,
    set: setFontCacheLimit,
  },
})
