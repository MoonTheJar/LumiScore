// ═══════════════════════════════════════════════════════════════
// 3D 空谱映射测试：固定 XML（高音 G + 低音 F，5 小节无旋律音符）
// 目的：2D SVG 原样 vs 3D 矢量映射逐元素对照，找出"乱七八糟"根因
// 诊断视角：正交相机从 +z 正视谱面（等价 2D 正射），一眼看出位置/缩放/方向差异
// ═══════════════════════════════════════════════════════════════
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import createVerovioModule from 'verovio/wasm'
import { VerovioToolkit as VrvToolkitClass } from 'verovio/esm'

const PX_PER_UNIT = 170 // SVG px → 世界单位（与主项目一致）

// ── MusicXML 预处理：Verovio 6.3 必须靠 <type> 推断时值才画符杆/符尾 ──
// 没有 <type>（只有 duration/divisions）时全部音符被当"无符杆"渲染。
// 渲染前给每个缺 <type> 的 note 推算并补上（duration/divisions → 拍数 → type 名）。
function durToType(beats: number): string {
  const map = [
    { b: 0.125, t: '32nd' }, { b: 0.25, t: '16th' }, { b: 0.5, t: 'eighth' },
    { b: 1, t: 'quarter' }, { b: 2, t: 'half' }, { b: 4, t: 'whole' }, { b: 8, t: 'breve' },
  ]
  for (const { b, t } of map) {
    if (Math.abs(beats - b) < 0.001) return t
    if (Math.abs(beats - b * 1.5) < 0.001) return t // 附点（<dot/> 已存在，type 用 base）
  }
  let best = map[0]!.t, bestD = Infinity
  for (const { b, t } of map) { const d = Math.abs(beats - b); if (d < bestD) { bestD = d; best = t } }
  return best
}
function ensureNoteTypes(xml: string): string {
  const dm = xml.match(/<divisions>(\d+)<\/divisions>/)
  const divisions = dm ? parseInt(dm[1]!, 10) : 4
  if (!divisions) return xml
  return xml.replace(/<note>([\s\S]*?)(?=<\/note>)/g, (m, inner: string) => {
    if (/<type>/.test(inner)) return m
    const dm2 = inner.match(/<duration>(\d+)<\/duration>/)
    if (!dm2) return m
    const beats = parseInt(dm2[1]!, 10) / divisions
    const type = durToType(beats)
    // 只改 <note>...</note> 内部（m 不含闭合标签，原闭合标签保留，避免双闭合破坏 XML）
    return m.replace(/<duration>\d+<\/duration>/, `$&<type>${type}</type>`)
  })
}

// ── Verovio 渲染固定空谱 ─────────────────────────────
let vtk: { loadData(x: string): boolean; setOptions(o: Record<string, unknown>): void; renderToSVG(p?: number): string } | null = null
async function initVrv(): Promise<boolean> {
  try {
    const wasm = await createVerovioModule()
    const tk = new VrvToolkitClass(wasm)
    tk.setOptions({
      pageWidth: 1200,
      scale: 45,
      spacingNonLinear: 0.6,
      spacingLinear: 0.5,
      breaks: 'none',
      footer: 'none',
      header: 'none',
      font: 'Bravura',
    })
    vtk = tk
    Object.assign((window as unknown as Record<string, unknown>).__t3d ?? {}, { vtk: tk })
    return true
  } catch (e) {
    console.error('vrv init fail', e)
    return false
  }
}

// ── SVG 解析（复制主项目 parseScore 的三分类逻辑） ───
type ElKind = 'open' | 'fill' | 'text'
interface RawEl {
  kind: ElKind
  shapes: THREE.Shape[] | null
  pts: { x: number; y: number }[] | null
  txt: string | null
  el: Element
  oW: number; oH: number; oCX: number; oCY: number
  strokeW: number
  flipY: boolean
}
interface MappedEl {
  kind: ElKind
  worldX: number; worldY: number; w: number; h: number; strokeW: number
  pts: { x: number; y: number }[] | null
  shapes: THREE.Shape[] | null
  txt: string | null
  sx: number; sy: number; sw: number; sh: number
  tag: string
  el: Element
}

function parseD(d: string, transform?: string | null): { shapes: THREE.Shape[] | null; pts: { x: number; y: number }[] | null; closed: boolean } {
  // 按 M 拆分子路径（Bravura 字形 path 是多段独立闭合轮廓，合并会破坏三角化）
  // 闭合段 → 各自独立 Shape（分别挤出再合并，保留相对布局）；开放段 → 合并 pts
  const segs: { pts: { x: number; y: number }[]; closed: boolean }[] = []
  let cur: { pts: { x: number; y: number }[]; closed: boolean } | null = null
  let cx = 0, cy = 0, sx = 0, sy = 0
  const nums = d.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
  const cmds = d.replace(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/g, ' ').trim()
  let ni = 0
  const rd = (): number => { const v = Number(nums[ni]); ni++; return Number.isFinite(v) ? v : 0 }
  const pushT = (x: number, y: number): void => {
    if (!cur) return
    const last = cur.pts[cur.pts.length - 1]
    if (!last || Math.abs(last.x - x) > 1e-3 || Math.abs(last.y - y) > 1e-3) cur.pts.push({ x, y })
  }
  const cubic = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number): void => {
    const p0x = cx, p0y = cy
    const len = Math.hypot(c1x - p0x, c1y - p0y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(ex - c2x, ey - c2y)
    const n = Math.max(6, Math.ceil(len / 10))
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t
      pushT(mt * mt * mt * p0x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
            mt * mt * mt * p0y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey)
    }
    cx = ex; cy = ey
  }
  const quad = (c1x: number, c1y: number, ex: number, ey: number): void => {
    const p0x = cx, p0y = cy
    const len = Math.hypot(c1x - p0x, c1y - p0y) + Math.hypot(ex - c1x, ey - c1y)
    const n = Math.max(6, Math.ceil(len / 10))
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t
      pushT(mt * mt * p0x + 2 * mt * t * c1x + t * t * ex,
            mt * mt * p0y + 2 * mt * t * c1y + t * t * ey)
    }
    cx = ex; cy = ey
  }
  for (const c of cmds) {
    const rel = c !== c.toUpperCase() && c !== 'z' && c !== 'Z' // 小写 = 相对坐标
    switch (c.toUpperCase()) {
      case 'M':
        if (rel) { cx += rd(); cy += rd() } else { cx = rd(); cy = rd() }
        sx = cx; sy = cy
        cur = { pts: [], closed: false }
        segs.push(cur)
        pushT(cx, cy)
        break
      case 'L':
        if (rel) { cx += rd(); cy += rd() } else { cx = rd(); cy = rd() }
        pushT(cx, cy)
        break
      case 'H':
        if (rel) { cx += rd() } else { cx = rd() }
        pushT(cx, cy)
        break
      case 'V':
        if (rel) { cy += rd() } else { cy = rd() }
        pushT(cx, cy)
        break
      case 'C': {
        let c1x, c1y, c2x, c2y, ex, ey
        if (rel) { c1x = cx + rd(); c1y = cy + rd(); c2x = cx + rd(); c2y = cy + rd(); ex = cx + rd(); ey = cy + rd() }
        else { c1x = rd(); c1y = rd(); c2x = rd(); c2y = rd(); ex = rd(); ey = rd() }
        cubic(c1x, c1y, c2x, c2y, ex, ey)
        break
      }
      case 'S': case 'Q': {
        // S 平滑三次：镜像前控制点缺失时退化为普通三次（用当前点做控制点）；Q 二次
        let c1x, c1y, ex, ey
        if (rel) { c1x = cx + rd(); c1y = cy + rd(); ex = cx + rd(); ey = cy + rd() }
        else { c1x = rd(); c1y = rd(); ex = rd(); ey = rd() }
        if (c.toUpperCase() === 'S') {
          // 退化：当前点作为第一控制点 → 仍是三次曲线（近似）
          const c2x = c1x, c2y = c1y
          cubic(cx, cy, c2x, c2y, ex, ey)
        } else {
          quad(c1x, c1y, ex, ey)
        }
        break
      }
      case 'T':
        // 平滑二次：退化直连端点
        if (rel) { cx += rd(); cy += rd() } else { cx = rd(); cy = rd() }
        pushT(cx, cy)
        break
      case 'A': {
        // 圆弧 → 端点近似（乐谱 SVG 极少用，先直线）
        rd(); rd(); rd(); rd(); rd()
        if (rel) { cx += rd(); cy += rd() } else { cx = rd(); cy = rd() }
        pushT(cx, cy)
        break
      }
      case 'Z': case 'z':
        if (cur) { cur.closed = true; pushT(sx, sy) }
        break
    }
  }
  if (!segs.length) return { shapes: null, pts: null, closed: false }
  // 应用 path 自身 transform（如 scale(1,-1)）：让 shape/pts 与 getBBox（渲染几何）同坐标系，fill 无需再猜翻转
  const tf = parseTransformToMatrix(transform ?? null)
  const applyPts = (pts: { x: number; y: number }[]): { x: number; y: number }[] =>
    pts.map((p) => ({ x: tf.a * p.x + tf.c * p.y + tf.e, y: tf.b * p.x + tf.d * p.y + tf.f }))
  const allClosed = segs.every((s) => s.closed)
  if (allClosed) {
    const shapes: THREE.Shape[] = []
    for (const s of segs) {
      if (s.pts.length < 3) continue
      const ap = applyPts(s.pts)
      const sh = new THREE.Shape()
      sh.moveTo(ap[0]!.x, ap[0]!.y)
      for (let i = 1; i < ap.length; i++) sh.lineTo(ap[i]!.x, ap[i]!.y)
      sh.closePath()
      shapes.push(sh)
    }
    return { shapes: shapes.length ? shapes : null, pts: null, closed: true }
  }
  const all: { x: number; y: number }[] = []
  for (const s of segs) for (const p of s.pts) all.push(p)
  // 叶片环判据（防误伤 + 防 epsilon 漏判）：
  // ① 首尾距离 ≪ 曲线总长（相对判据：transform 缩放/翻转后精确闭合的曲线首尾差是浮点 epsilon，仍命中）
  // ② Shoelace 包围面积足够大（叶片环=外弧+内弧围出的实心区域；"往返细线"如符杆双 C 面积≈0 → 拒，保持 ribbon）
  if (all.length >= 6) {
    let totalLen = 0, area2 = 0
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < all.length; i++) {
      const p = all[i]!, q = all[(i + 1) % all.length]!
      totalLen += Math.hypot(q.x - p.x, q.y - p.y)
      area2 += p.x * q.y - q.x * p.y // Shoelace 2 倍面积（有符号）
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    const f0 = all[0]!, l0 = all[all.length - 1]!
    const span = Math.hypot(maxX - minX, maxY - minY) || 1e-9
    const closedByLen = Math.hypot(f0.x - l0.x, f0.y - l0.y) < totalLen * 0.015
    const hasArea = Math.abs(area2) / 2 > span * span * 0.005
    if (closedByLen && hasArea) {
      const ap = applyPts(all)
      const sh = new THREE.Shape()
      sh.moveTo(ap[0]!.x, ap[0]!.y)
      for (let i = 1; i < ap.length; i++) sh.lineTo(ap[i]!.x, ap[i]!.y)
      sh.closePath()
      return { shapes: [sh], pts: null, closed: true }
    }
  }
  return { shapes: null, pts: applyPts(all), closed: false }
}

// 解析 SVG transform（matrix/translate/scale/rotate，按出现顺序连乘）
function parseTransformToMatrix(s: string | null): { a: number; b: number; c: number; d: number; e: number; f: number } {
  let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0
  if (!s) return { a, b, c, d, e, f }
  const re = /(matrix|translate|scale|rotate)\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const vals = (m[2] ?? '').split(/[,\s]+/).map((v) => parseFloat(v)).filter((v) => !Number.isNaN(v))
    const a0 = a, b0 = b, c0 = c, d0 = d, e0 = e, f0 = f
    switch (m[1]) {
      case 'matrix': {
        const [ma = 1, mb = 0, mc = 0, md = 1, me = 0, mf = 0] = vals
        a = a0 * ma + c0 * mb; b = b0 * ma + d0 * mb
        c = a0 * mc + c0 * md; d = b0 * mc + d0 * md
        e = a0 * me + c0 * mf + e0; f = b0 * me + d0 * mf + f0
        break
      }
      case 'translate': {
        const tx = vals[0] ?? 0, ty = vals[1] ?? 0
        e = a0 * tx + c0 * ty + e0; f = b0 * tx + d0 * ty + f0
        break
      }
      case 'scale': {
        const sx = vals[0] ?? 1, sy = vals[1] ?? sx
        a = a0 * sx; b = b0 * sx; c = c0 * sy; d = d0 * sy
        break
      }
      case 'rotate': {
        const ang = ((vals[0] ?? 0) * Math.PI) / 180
        const ca = Math.cos(ang), sa = Math.sin(ang)
        a = a0 * ca + c0 * sa; b = b0 * ca + d0 * sa
        c = -a0 * sa + c0 * ca; d = -b0 * sa + d0 * ca
        break
      }
    }
  }
  return { a, b, c, d, e, f }
}

function useRect(el: Element): { x: number; y: number; w: number; h: number } {
  // <use transform="translate(tx,ty) scale(sx,sy)">：getBBox 只返回字形本地坐标
  // 手动叠加 use 自身 transform（字形本地 bbox 先 scale 再 translate）
  const u = el as unknown as SVGUseElement
  const b = u.getBBox()
  const tr = u.getAttribute('transform') || ''
  let tx = 0, ty = 0, sx = 1, sy = 1
  const t = tr.match(/translate\(([-\d.]+)[,\s]+([-\d.]+)\)/)
  const s = tr.match(/scale\(([-\d.]+)[,\s]*([-\d.]+)?\)/)
  if (t) { tx = parseFloat(t[1] ?? '0'); ty = parseFloat(t[2] ?? '0') }
  if (s) { sx = parseFloat(s[1] ?? '1'); sy = s[2] ? parseFloat(s[2]) : sx }
  const rw = b.width * sx
  const rh = b.height * sy
  const rcx = (b.x + b.width / 2) * sx + tx
  const rcy = (b.y + b.height / 2) * sy + ty
  return { x: rcx - rw / 2, y: rcy - rh / 2, w: rw, h: rh }
}

function screenRect(el: Element): { x: number; y: number; w: number; h: number } {
  // getBBox 对 <use> 返回字形本地坐标（负数/不含 use 的 translate+scale），需手动叠加
  if (el.tagName === 'use') return useRect(el)
  const b = (el as SVGGraphicsElement).getBBox()
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

// 手工 2D 仿射矩阵（布局无关）：SVG transform 属性解析 + 祖先链连乘
interface M2 { a: number; b: number; c: number; d: number; e: number; f: number }
const M_ID: M2 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
function mmul(A: M2, B: M2): M2 {
  return { a: A.a * B.a + A.c * B.b, b: A.b * B.a + A.d * B.b, c: A.a * B.c + A.c * B.d, d: A.b * B.c + A.d * B.d, e: A.a * B.e + A.c * B.f + A.e, f: A.b * B.e + A.d * B.f + A.f }
}
function mApply(P: { x: number; y: number }, M: M2): { x: number; y: number } {
  return { x: M.a * P.x + M.c * P.y + M.e, y: M.b * P.x + M.d * P.y + M.f }
}
function mParse(s: string): M2 {
  let m: M2 = { ...M_ID }
  const re = /(translate|scale|rotate|matrix)\(([^)]*)\)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(s)) !== null) {
    const fn = mm[1]
    const a = (mm[2] ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
    let t: M2 = { ...M_ID }
    if (fn === 'translate') { t.e = a[0] ?? 0; t.f = a[1] ?? 0 }
    else if (fn === 'scale') { t.a = a[0] ?? 1; t.d = a[1] ?? a[0] ?? 1 }
    else if (fn === 'matrix') { t = { a: a[0] ?? 1, b: a[1] ?? 0, c: a[2] ?? 0, d: a[3] ?? 1, e: a[4] ?? 0, f: a[5] ?? 0 } }
    else if (fn === 'rotate') { const rad = (a[0] ?? 0) * Math.PI / 180; t = { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad), e: 0, f: 0 } }
    m = mmul(m, t) // SVG transform 列表从左到右左乘：M = M · t（先应用 t 到点）
  }
  return m
}
// 符头中心：本地 getBBox 中心 ×（元素自身 + 全部祖先 transform 连乘）→ SVG 用户坐标。
// 像素基准已验证：与 use 真实渲染 bbox 中心偏差 (0,0)。
// 纯几何运算，不依赖浏览器布局 / 屏幕坐标 —— 与渲染位置精确一致
function svgCenter(el: Element): { x: number; y: number } {
  const svg = (el as SVGGraphicsElement).ownerSVGElement
  let m: M2 = M_ID
  let node: Element | null = el
  while (node && node !== svg) {
    const t = node.getAttribute('transform')
    if (t) m = mmul(mParse(t), m)
    node = node.parentElement
  }
  const b = (el as SVGGraphicsElement).getBBox()
  return mApply({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, m)
}

// SVG 后处理：空小节（内部无 note/chord/rest 的 <g class="measure">）拉宽到非空小节中位宽度。
// Verovio 输出里 measure g 无 transform、元素全在绝对坐标（每小节第一条 path 是 staffLine 横线 M x1 L x2 分段），
// 用小节内第一条 path 的 M 起点 x 定位小节；空小节内容（bar rest）很窄 → 小节被压扁，
// 把空小节之后的全部 measure 平移 x 后移，空小节即变宽（后续小节顺移、内容相对不变）。
// 总谱多 part：同 x 坐标的 measure（同一小节多轨）归为一组，组内全部为空才拉宽。
function widenEmptyMeasures(svgRoot: SVGSVGElement): void {
  const ms = Array.from(svgRoot.querySelectorAll<SVGGElement>('g.measure'))
  if (ms.length < 2) return
  const measureX = (m: SVGGElement): number => {
    const p = m.querySelector('path')
    if (p) {
      const d = p.getAttribute('d') ?? ''
      const mm = d.match(/M\s*([-\d.]+)/)
      if (mm) return parseFloat(mm[1]!)
    }
    return (m as SVGGraphicsElement).getBBox().x
  }
  interface MInfo { el: SVGGElement; x: number; empty: boolean }
  const infos: MInfo[] = []
  for (const m of ms) {
    const x = measureX(m)
    if (!Number.isFinite(x)) return
    infos.push({ el: m, x, empty: !m.querySelector('g.note, g.chord') })
  }
  // 按 x 排序 → 合并同 x 组
  infos.sort((a, b) => a.x - b.x)
  const groups: { x: number; els: MInfo[]; empty: boolean }[] = []
  for (const it of infos) {
    const g = groups[groups.length - 1]
    if (g && Math.abs(g.x - it.x) < 0.5) { g.els.push(it); g.empty &&= it.empty }
    else groups.push({ x: it.x, els: [it], empty: it.empty })
  }
  if (groups.length < 2) return
  // 非空组宽度 → 目标最小宽度（中位数）
  const ws: number[] = []
  for (let i = 0; i < groups.length - 1; i++) if (!groups[i]!.empty) ws.push(groups[i + 1]!.x - groups[i]!.x)
  if (!ws.length) return
  const sorted = [...ws].sort((a, b) => a - b)
  const minW = sorted[Math.floor(sorted.length / 2)]!
  // 累积后移：空组宽度 < minW → 该组及之后全部组平移 (minW - 宽度)
  const nx: number[] = [groups[0]!.x]
  let acc = 0
  for (let i = 0; i < groups.length - 1; i++) {
    const w = groups[i + 1]!.x - groups[i]!.x
    if (groups[i]!.empty && w < minW) acc += minW - w
    nx.push(groups[i + 1]!.x + acc)
  }
  if (acc < 1e-6) return
  // 平移：measure g 加 transform（2D 渲染随父级平移）+ data-xoff 记录（3D 构建时叠加 mesh.position.x）
  groups.forEach((grp, i) => {
    const shift = nx[i]! - grp.x
    if (Math.abs(shift) < 1e-6) return
    for (const it of grp.els) {
      const tr = it.el.getAttribute('transform')
      it.el.setAttribute('transform', tr ? `${tr} translate(${shift.toFixed(1)} 0)` : `translate(${shift.toFixed(1)} 0)`)
      ;(it.el as unknown as HTMLElement).dataset.xoff = shift.toFixed(1)
    }
  })
}

function parseScore(svgStr: string): { elems: MappedEl[]; svg: SVGSVGElement; natW: number; natH: number } {
  const host = document.createElement('div')
  host.innerHTML = svgStr
  document.body.appendChild(host) // 挂载后 getBBox/getComputedStyle 才有布局
  const svg = host.querySelector('svg') as unknown as SVGSVGElement
  // 暂禁用空小节拉宽（怀疑破坏 2D 渲染/transform 叠加出问题）——用户要求恢复到处理空小节前
  // widenEmptyMeasures(svg)

  // defs 字形
  const defShapes = new Map<string, { shapes: THREE.Shape[]; w: number; h: number }>()
  for (const g of host.querySelectorAll('defs g[id]')) {
    const p = g.querySelector('path')
    const d = p?.getAttribute('d')
    if (!d) continue
    const pd = parseD(d, p?.getAttribute('transform'))
    if (pd.shapes) {
      const b = (p as SVGGraphicsElement).getBBox()
      defShapes.set(g.id, { shapes: pd.shapes, w: b.width, h: b.height })
    }
  }

  const raws: RawEl[] = []
  interface PushArg {
    kind: ElKind
    shapes: THREE.Shape[] | null
    pts: { x: number; y: number }[] | null
    txt: string | null
    el: Element
    oW?: number; oH?: number; oCX?: number; oCY?: number
    strokeW: number
    flipY?: boolean
  }
  const push = (r: PushArg): void => {
    const rc = screenRect(r.el)
    const oW = (r.oW ?? 0) > 0 ? (r.oW ?? 0) : 1
    const oH = (r.oH ?? 0) > 0 ? (r.oH ?? 0) : 1
    raws.push({
      kind: r.kind, shapes: r.shapes, pts: r.pts, txt: r.txt, el: r.el,
      oW, oH,
      oCX: r.oCX ?? 0, oCY: r.oCY ?? 0,
      strokeW: r.strokeW, flipY: r.flipY !== false,
    })
  }

  for (const p of host.querySelectorAll('path')) {
    if (p.closest('defs')) continue
    const d = p.getAttribute('d')
    if (!d) continue
    const b = (p as SVGGraphicsElement).getBBox()
    const pd = parseD(d, p.getAttribute('transform'))
    const swC = parseFloat(getComputedStyle(p).strokeWidth) || 0
    const strokeAttr = swC > 0 ? swC : (parseFloat(p.getAttribute('stroke-width') ?? '0') || 0.3)
    push({
      kind: pd.closed ? 'fill' : 'open',
      shapes: pd.closed ? pd.shapes : null,
      pts: pd.closed ? null : pd.pts,
      txt: null, el: p,
      oW: b.width, oH: b.height,
      oCX: b.x + b.width / 2, oCY: b.y + b.height / 2,
      strokeW: strokeAttr,
    })
  }
  for (const u of host.querySelectorAll('use')) {
    const href = u.getAttribute('href') ?? u.getAttribute('xlink:href') ?? ''
    const sh = defShapes.get(href.replace(/^#/, ''))
    if (!sh) continue
    push({
      kind: 'fill', shapes: sh.shapes.map((s) => s.clone()), pts: null, txt: null, el: u,
      oW: sh.w, oH: sh.h, oCX: 0, oCY: 0, strokeW: 0, flipY: false,
    })
  }
  for (const t of host.querySelectorAll('text')) {
    const content = t.textContent?.trim() ?? ''
    if (!content) continue
    const b = (t as SVGGraphicsElement).getBBox()
    push({
      kind: 'text', shapes: null, pts: null, txt: content, el: t,
      oW: 1, oH: 1, oCX: 0, oCY: 0, strokeW: 0,
    })
  }
  for (const e of host.querySelectorAll('ellipse')) {
    const rx = parseFloat(e.getAttribute('rx') ?? '0') || 1
    const ry = parseFloat(e.getAttribute('ry') ?? '0') || rx
    const b = (e as SVGGraphicsElement).getBBox()
    push({
      kind: 'fill', shapes: [makeCircleShape(rx, ry)], pts: null, txt: null, el: e,
      oW: b.width, oH: b.height,
      oCX: b.x + b.width / 2, oCY: b.y + b.height / 2, strokeW: 0,
    })
  }
  for (const r of host.querySelectorAll('rect')) {
    const wA = parseFloat(r.getAttribute('width') ?? '0') || 0
    const hA = parseFloat(r.getAttribute('height') ?? '0') || 0
    if (!wA && !hA) continue
    const b = (r as SVGGraphicsElement).getBBox()
    const swC = parseFloat(getComputedStyle(r).strokeWidth) || 0
    const vertical = hA > wA
    push({
      kind: 'open', shapes: null,
      pts: vertical
        ? [{ x: b.x + b.width / 2, y: b.y }, { x: b.x + b.width / 2, y: b.y + b.height }]
        : [{ x: b.x, y: b.y + b.height / 2 }, { x: b.x + b.width, y: b.y + b.height / 2 }],
      txt: null, el: r,
      oW: b.width, oH: b.height,
      oCX: b.x + b.width / 2, oCY: b.y + b.height / 2,
      strokeW: swC > 0 ? swC : Math.min(wA, hA),
    })
  }
  host.remove()
  // 解析完成后把 svg 移到对照区（必须在所有 host 查询之后）
  document.getElementById('svgRef')!.appendChild(svg)

  if (!raws.length) return { elems: [], svg, natW: 0, natH: 0 }
  // 归一化：内容屏幕范围 → 栅格化显示尺寸（与主项目一致）
  const xs = raws.map((r) => screenRect(r.el).x)
  const ys = raws.map((r) => screenRect(r.el).y)
  const xMin = Math.min(...xs)
  const yMin = Math.min(...ys)
  const xMax = Math.max(...xs.map((_, i) => screenRect(raws[i]!.el).x + screenRect(raws[i]!.el).w))
  const yMax = Math.max(...ys.map((_, i) => screenRect(raws[i]!.el).y + screenRect(raws[i]!.el).h))
  const spanX = Math.max(1e-6, xMax - xMin)
  const spanY = Math.max(1e-6, yMax - yMin)
  // 世界尺寸基准 = 内容范围（Verovio 的 width/height 只是页面尺寸，元素坐标带偏移且溢出）
  const natW = spanX
  const natH = spanY
  // 2D 显示归一化：补 viewBox = 内容范围 → 2D 窗完整显示谱面（与 3D 归一化同源）
  svg.setAttribute('viewBox', `${xMin} ${yMin} ${spanX} ${spanY}`)
  // 显示尺寸按比例放大（不挤压）：0.4 倍，超出容器出现滚动条
  svg.setAttribute('width', `${(spanX * 0.4).toFixed(1)}px`)
  svg.setAttribute('height', `${(spanY * 0.4).toFixed(1)}px`)

  const elems: MappedEl[] = raws.map((r) => {
    const rc = screenRect(r.el)
    const scaleX = r.oW > 0 ? rc.w / r.oW : 1
    const scaleY = r.oH > 0 ? (r.flipY ? -rc.h / r.oH : rc.h / r.oH) : (r.flipY ? -1 : 1)
    // 线元素（bbox 某一维为 0）的缩放：取非零维度比例（竖线宽 0 → 用高度比例，横线高 0 → 用宽度比例）
    const sScale = (r.oW > 0 && rc.w > 0) ? rc.w / r.oW : (r.oH > 0 && rc.h > 0 ? Math.abs(rc.h / r.oH) : 1)
    const cx = rc.x + rc.w / 2
    const cy = rc.y + rc.h / 2
    const wx = ((cx - xMin) / spanX) * natW / PX_PER_UNIT
    const wy = ((yMax - cy) / spanY) * natH / PX_PER_UNIT
    let pts: { x: number; y: number }[] | null = null
    if (r.kind === 'open' && r.pts && r.pts.length >= 2) {
      pts = r.pts.map((pt) => ({
        x: wx + (pt.x - r.oCX) * scaleX / PX_PER_UNIT,
        y: wy + (pt.y - r.oCY) * scaleY / PX_PER_UNIT,
      }))
    }
    return {
      kind: r.kind,
      worldX: wx, worldY: wy,
      w: (rc.w / spanX) * natW / PX_PER_UNIT,
      h: (rc.h / spanY) * natH / PX_PER_UNIT,
      // 线宽换算：SVG px → 世界。缩放取非零维度的比例（竖线 bbox 宽为 0，不能用 scaleX=0 把线宽归零）
      strokeW: r.strokeW * sScale / PX_PER_UNIT,
      pts,
      shapes: r.kind === 'fill' ? r.shapes : null,
      txt: r.kind === 'text' ? r.txt : null,
      sx: rc.x, sy: rc.y, sw: rc.w, sh: rc.h,
      tag: r.el.tagName,
      el: r.el,
    }
  })
  return { elems, svg, natW, natH }
}

function makeCircleShape(rx: number, ry: number): THREE.Shape {
  const s = new THREE.Shape()
  const k = 0.5522847498
  const cx = 0, cy = 0
  s.moveTo(cx + rx, cy)
  s.bezierCurveTo(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry)
  s.bezierCurveTo(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy)
  s.bezierCurveTo(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry)
  s.bezierCurveTo(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy)
  return s
}

// ── 3D 构建（三分类：ribbon / 轮廓挤出 / 文字薄片） ──────
const mat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
const rise = 0.02
let fillFlip = -1 // 谱号 fill 方向：Three y 向上，字形 d 为设计坐标（y 向上）→ 渲染时需翻转对齐 bbox（SVG y 向下）；诊断按钮可切换

// ── 球系统数据（notehead 收集） ─────────────────────────
interface NoteTarget { x: number; y: number; mark: number; time: number; channel: number; staffY: number; svgX: number; svgY: number; elRef: Element | null }
interface NoteHeadRec { mesh: THREE.Mesh; mark: number; x: number; y: number }
const noteHeadMeshes: NoteHeadRec[] = []
const noteTargets: NoteTarget[] = []
const staffLineYCache = new WeakMap<Element, number>()
const MARK_COLORS = [0x4da3ff, 0x37c871, 0xff9f43, 0xe85c9d, 0x9b7bff, 0xffd166, 0x5ce1e6, 0x8a94a0]

function makeRibbon(pts: { x: number; y: number }[], strokeW: number, r: number): THREE.BufferGeometry {
  // 按方向突变（折返 >120°）断开：往返曲线（如大括号去程+回程）在折返点 ribbon 自交成乱线网格
  const segs: { x: number; y: number }[][] = []
  let cur: { x: number; y: number }[] = [pts[0]!]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!
    const v1x = b.x - a.x, v1y = b.y - a.y
    const v2x = c.x - b.x, v2y = c.y - b.y
    const l1 = Math.hypot(v1x, v1y) || 1e-9
    const l2 = Math.hypot(v2x, v2y) || 1e-9
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2)
    cur.push(b)
    if (cos < -0.5) { segs.push(cur); cur = [b] }
  }
  cur.push(pts[pts.length - 1]!)
  segs.push(cur)
  const geos = segs.filter((s) => s.length >= 2).map((s) => ribbonSegment(s, strokeW, r))
  if (!geos.length) return new THREE.BufferGeometry()
  const g = geos.length === 1 ? geos[0]! : mergeSafe(geos)!
  g.computeBoundingBox()
  const bb = g.boundingBox!
  g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0)
  return g
}

// 单段实心条：扁管（上下/左右四壁）+ 首尾端面封口
function ribbonSegment(pts: { x: number; y: number }[], strokeW: number, r: number): THREE.BufferGeometry {
  const n = pts.length
  const half = Math.max(0.0002, strokeW / 2)
  const depth = Math.max(0.001, r)
  const norms: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!
    const b = pts[Math.min(n - 1, i + 1)]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1e-9
    norms.push({ x: -dy / len, y: dx / len })
  }
  const pos: number[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const nm = norms[i]!
    pos.push(p.x + nm.x * half, p.y + nm.y * half, depth, p.x - nm.x * half, p.y - nm.y * half, depth, p.x + nm.x * half, p.y + nm.y * half, 0, p.x - nm.x * half, p.y - nm.y * half, 0)
  }
  const idx: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = (i + 1) * 4
    idx.push(a, a + 1, b + 1, a, b + 1, b)
    idx.push(a + 2, b + 2, b + 3, a + 2, b + 3, a + 3)
    idx.push(a, a + 2, b + 2, a, b + 2, b)
    idx.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3)
  }
  // 端面封口（首尾两端），挤出成有厚度的实心条
  const last = (n - 1) * 4
  idx.push(0, 1, 3, 0, 3, 2)                 // 首端
  idx.push(last, last + 2, last + 3, last, last + 3, last + 1) // 尾端
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

const fillCache = new Map<string, THREE.BufferGeometry>()
function makeFill(el: MappedEl, r: number): THREE.BufferGeometry {
  const key = `${el.tag}:${el.sx.toFixed(1)}:${el.sy.toFixed(1)}:${el.sw.toFixed(1)}:${el.sh.toFixed(1)}`
  const cached = fillCache.get(key)
  if (cached) return cached
  const shapes = el.shapes ?? []
  if (!shapes.length) return new THREE.PlaneGeometry(el.w, el.h)
  const depth = Math.max(0.001, r)
  // 整体 bbox（所有子路径本地坐标，保留相对布局）
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const shape of shapes) {
    for (const p of shape.getPoints()) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
  }
  const sw2 = Math.max(1e-6, maxX - minX)
  const sh2 = Math.max(1e-6, maxY - minY)
  // 按 bbox 包含关系分组：不被任何段包含的 = 外轮廓；被包含的 = 孔洞（挂到外轮廓，避免填实内部空隙导致"太粗"）
  const bboxOf = (shape: THREE.Shape): { x: number; y: number; w: number; h: number } => {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity
    for (const p of shape.getPoints()) {
      mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x)
      mny = Math.min(mny, p.y); mxy = Math.max(mxy, p.y)
    }
    return { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny }
  }
  const contains = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
  const boxes = shapes.map(bboxOf)
  const groups: { outer: THREE.Shape; holes: THREE.Shape[] }[] = []
  for (let i = 0; i < shapes.length; i++) {
    let isHole = false
    for (let j = 0; j < shapes.length; j++) {
      if (i !== j && contains(boxes[j]!, boxes[i]!)) { isHole = true; break }
    }
    if (isHole) continue
    const holes = shapes.filter((_, k) => k !== i && contains(boxes[i]!, boxes[k]!))
    groups.push({ outer: shapes[i]!, holes })
  }
  const geos: THREE.BufferGeometry[] = []
  for (const g0 of groups) {
    try {
      const s = g0.outer.clone()
      for (const h of g0.holes) {
        const pts = h.getPoints()
        if (pts.length < 3) continue
        const path = new THREE.Path()
        path.moveTo(pts[0]!.x, pts[0]!.y)
        for (let k = pts.length - 1; k > 0; k--) path.lineTo(pts[k]!.x, pts[k]!.y) // 反转 winding，earcut 洞检测更稳
        path.closePath()
        s.holes.push(path)
      }
      geos.push(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false }))
    } catch {
      // 坏组跳过
    }
  }
  if (!geos.length) return new THREE.PlaneGeometry(el.w, el.h)
  const geo = (geos.length === 1 ? geos[0] : mergeSafe(geos))!
  // 整体居中 → 缩放（shape 已应用 path 自身 transform，与 SVG bbox 同坐标系 → 正 scaleY）
  geo.computeBoundingBox()
  const bb0 = geo.boundingBox!
  geo.translate(-(bb0.min.x + bb0.max.x) / 2, -(bb0.min.y + bb0.max.y) / 2, 0)
  geo.scale(el.w / sw2, el.h / sh2 * fillFlip, 1)
  // 缩放后再居中（负 scaleY 后中心仍可能偏移）
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0)
  fillCache.set(key, geo)
  return geo
}

function makeTextPlane(el: MappedEl, r: number): THREE.Mesh {
  const s = 3
  const cw = Math.max(8, Math.ceil(el.w * PX_PER_UNIT * s))
  const ch = Math.max(8, Math.ceil(el.h * PX_PER_UNIT * s))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let fs = Math.max(8, Math.round(el.h * PX_PER_UNIT * s * 0.92))
  ctx.font = `${fs}px 'Liberation', serif`
  // 文字宽度适配 canvas（避免长文本被右裁切）
  const tw = ctx.measureText(el.txt ?? '').width
  if (tw > cw * 0.92) {
    fs = Math.max(8, Math.floor(fs * (cw * 0.92) / tw))
    ctx.font = `${fs}px 'Liberation', serif`
  }
  ctx.fillText(el.txt ?? '', cw / 2, ch / 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(el.w, el.h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
  mesh.position.set(el.worldX, el.worldY, r / 2)
  return mesh
}

// ── 场景 ──────────────────────────────────────────────
const canvas = document.getElementById('gl') as HTMLCanvasElement
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xffffff)
const camOrtho = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100)
camOrtho.position.set(0, 0, 10)
camOrtho.lookAt(0, 0, 0)
const camPersp = new THREE.PerspectiveCamera(50, 1, 0.1, 200)
camPersp.position.set(3, 3, 6)
camPersp.lookAt(0, 0, 0)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
console.log('DIAG webgl', renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1')
renderer.setClearColor(0xffffff, 1) // 白底黑谱
renderer.setPixelRatio(window.devicePixelRatio)
let cam: THREE.OrthographicCamera | THREE.PerspectiveCamera = camOrtho
const controls = new OrbitControls(cam, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.12
controls.enablePan = true
// 限制滚轮缩放范围（防 zoom 拉过头"卡飞掉/卡没"）；fitView/focus3D 会重置 zoom=1
controls.minZoom = 0.15
controls.maxZoom = 25
// ── 构建容器（必须在 animate() 调用前定义，避免 TDZ） ──
const group = new THREE.Group()
scene.add(group)
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
}

function resize(): void {
  const rect = canvas.parentElement!.getBoundingClientRect()
  renderer.setSize(rect.width, rect.height)
  const ar = rect.width / rect.height
  camOrtho.left = -7 * ar; camOrtho.right = 7 * ar; camOrtho.top = 4; camOrtho.bottom = -4
  camOrtho.updateProjectionMatrix()
  camPersp.aspect = ar
  camPersp.updateProjectionMatrix()
  fitView() // 重算 fit（保持像素比例，防左右压扁）
}
window.addEventListener('resize', resize)

function fitView(): void {
  // fit 谱面 + 边距，但保持 x/y 像素比例一致（画布窄时防水平压缩）
  const rect = canvas.parentElement!.getBoundingClientRect()
  const aspect = rect.width / Math.max(1, rect.height)
  let halfW = natW / PX_PER_UNIT / 2 * 1.4 + 0.5
  let halfH = natH / PX_PER_UNIT / 2 * 1.4 + 0.5
  if (halfW / halfH > aspect) { halfW = halfH * aspect } else { halfH = halfW / aspect }
  const cx = (natW / PX_PER_UNIT) / 2
  const cy = (natH / PX_PER_UNIT) / 2
  // ⚠ 正交投影 left/right/top/bottom 是视图空间（相机局部）坐标：
  //   相机 position=(cx,cy,10) 看向 (cx,cy,0) 无旋转 → 视图 x = 世界 x − cx。
  //   必须设为 −halfW~+halfW（相对相机），直接写世界范围会把所有元素裁出 clip → 白屏。
  camOrtho.left = -halfW; camOrtho.right = halfW
  camOrtho.top = halfH; camOrtho.bottom = -halfH
  camOrtho.zoom = 1 // 重置 OrbitControls 滚轮残留的 zoom，防"飞掉/卡没"
  camOrtho.updateProjectionMatrix()
  camOrtho.position.set(cx, cy, 10)
  camOrtho.lookAt(cx, cy, 0)
  camPersp.position.set(cx + (natW / PX_PER_UNIT) * 0.35, cy + (natH / PX_PER_UNIT) * 0.35, natW / PX_PER_UNIT)
  camPersp.lookAt(cx, cy, 0)
  controls.target.set(cx, cy, 0)
  controls.update()
}

function animate(): void {
  requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, cam)
}
animate()

// 灯光（Lambert 需要）
scene.add(new THREE.DirectionalLight(0xffffff, 1))
scene.add(new THREE.AmbientLight(0xffffff, 0.6))

// ── 构建 ──────────────────────────────────────────────
let natW = 0
let natH = 0
function build(): void {
  while (group.children.length) {
    const m = group.children[0] as THREE.Mesh
    group.remove(m)
    m.geometry?.dispose()
    ;(m.material as THREE.Material | THREE.Material[]) && Array.isArray(m.material)
      ? (m.material as THREE.Material[]).forEach((x) => { (x as THREE.MeshBasicMaterial).map?.dispose(); x.dispose() })
      : ((m.material as THREE.MeshBasicMaterial)?.map?.dispose(), (m.material as THREE.Material)?.dispose())
  }
  fillCache.clear()
  const svg = document.getElementById('svgRef')!.querySelector('svg')
  if (svg) svg.remove()
  const ok = vtk?.loadData(ensureNoteTypes(XML))
  console.log('DIAG loadData:', ok)
  if (!ok) { (document.getElementById('stats') as HTMLElement).textContent = 'loadData failed'; return }
  const svgStr = vtk!.renderToSVG(1)
  console.log('DIAG svg len:', svgStr.length, 'head:', svgStr.slice(0, 120))
  // 调试钩子：暴露 SVG + 解析计数（合并到顶层已暴露的 renderer/cam/selfCheck）
  const diagHost = document.createElement('div')
  diagHost.innerHTML = svgStr
  Object.assign((window as unknown as Record<string, unknown>).__t3d!, {
    svgStr,
    hostPaths: diagHost.querySelectorAll('path').length,
    hostUses: diagHost.querySelectorAll('use').length,
    hostTexts: diagHost.querySelectorAll('text').length,
    hostEllipses: diagHost.querySelectorAll('ellipse').length,
    hostRects: diagHost.querySelectorAll('rect').length,
    hostDefs: diagHost.querySelectorAll('defs g[id]').length,
    svgHead: svgStr.slice(0, 300),
  })
  const { elems, svg: svgEl, natW: nw, natH: nh } = parseScore(svgStr)
  natW = nw
  natH = nh

  // 3D 构建（诊断页不合并 open，每个元素独立 mesh + userData 供点击高亮）
  const meshes: THREE.Mesh[] = []
  for (const el of elems) {
    try {
      let mesh: THREE.Mesh | null = null
      if (el.kind === 'open' && el.pts && el.pts.length >= 2) {
        // 线宽加粗补偿：SVG stroke 归一化到世界后过细（符杆 0.16 世界 → fitView 下仅 ~1.8px 不可见）。
        // 保持相对粗细（谱线 0.076 / 符杆 0.159 / 连谱号 0.106 比例不变），整体 ×2；
        // 连谱号（粗 stroke 长曲线）保留 ×1.5 后再 ×2。
        const base = el.strokeW > 0.09 && el.pts.length > 100 ? el.strokeW * 1.5 : el.strokeW
        const sw = base * 2
        mesh = new THREE.Mesh(makeRibbon(el.pts, sw, rise), mat)
      } else if (el.kind === 'fill' && el.shapes) {
        mesh = new THREE.Mesh(makeFill(el, rise), mat)
      } else if (el.kind === 'text' && el.txt) {
        mesh = makeTextPlane(el, rise)
      }
      if (mesh) {
        // 几何在生成时做了 translate 居中，boundingSphere 指向原始绝对坐标导致 culling 全剔除。
        // 诊断页 mesh 数量有限（~374），直接禁用 culling；主项目回传时用近场 chunk 规避。
        mesh.geometry.computeBoundingSphere()
        mesh.frustumCulled = false
        mesh.position.set(el.worldX, el.worldY, 0)
        // 空小节拉宽偏移：父 measure 的 data-xoff（SVG 父级 transform 平移，screenRect/parseD 不含父 transform → 这里叠加）
        const mEl = el.el.closest?.('g.measure') as HTMLElement | null
        const xoff = mEl ? parseFloat(mEl.dataset.xoff ?? '0') : 0
        mesh.position.x += xoff
        // notehead：独立材质（点亮变色用）+ 收集为球目标（class 在父 <g class="notehead"> 上）
        if (el.el.closest('g.notehead')) {
          mesh.material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
          // 谱行标识：谱行内五线谱线（横向细长 path）的最小 y（跨小节稳定）→ 后续按 y 聚类分链
          // 钢琴大谱表左右手是两个 staff → 分成两条独立球链（左手不跳右手）
          const staffEl = el.el.closest('g.staff')
          let staffY = 0
          if (staffEl) {
            let cached = staffLineYCache.get(staffEl)
            if (cached === undefined) {
              const lines = Array.from(staffEl.querySelectorAll('path')).filter((p) => {
                const bb = (p as SVGGraphicsElement).getBBox()
                return bb.width > 50 && bb.height < 1
              })
              cached = lines.length
                ? Math.min(...lines.map((l) => (l as SVGGraphicsElement).getBBox().y))
                : (staffEl as SVGGraphicsElement).getBBox().y
              staffLineYCache.set(staffEl, cached)
            }
            staffY = cached
          }
          noteHeadMeshes.push({ mesh, mark: 0, x: mesh.position.x, y: mesh.position.y })
          const c = svgCenter(el.el)
          noteTargets.push({ x: mesh.position.x, y: mesh.position.y, mark: 0, time: 0, channel: 0, staffY, svgX: c.x, svgY: c.y, elRef: el.el })
        }
        mesh.userData.elIdx = meshes.length
        meshes.push(mesh)
      }
    } catch (e) {
      console.error('elem fail', el.tag, e)
    }
  }
  meshes.forEach((m) => group.add(m))
  console.log('DIAG meshes:', meshes.length)
  if (meshes.length) {
    const m0 = meshes[0]!
    m0.geometry.computeBoundingBox()
    const bb = m0.geometry.boundingBox!
    console.log('DIAG m0 pos', m0.position.x.toFixed(2), m0.position.y.toFixed(2), 'bb', bb.min.x.toFixed(2), bb.min.y.toFixed(2), bb.max.x.toFixed(2), bb.max.y.toFixed(2))
    const mLast = meshes[meshes.length - 1]!
    console.log('DIAG mLast pos', mLast.position.x.toFixed(2), mLast.position.y.toFixed(2))
  }
  console.log('DIAG camOrtho', camOrtho.left.toFixed(2), camOrtho.right.toFixed(2), camOrtho.top.toFixed(2), camOrtho.bottom.toFixed(2), 'pos', camOrtho.position.x.toFixed(2), camOrtho.position.y.toFixed(2), camOrtho.position.z.toFixed(2))

  // 调试表（div 行，可高亮；悬浮窗结构：表头 + .dbody 容器）
  const dbg = document.getElementById('dbg') as HTMLElement
  const dbody = dbg.querySelector('.dbody') as HTMLElement
  dbody.innerHTML = ''
  const rows: HTMLDivElement[] = []
  const mkRow = (txt: string, hl?: boolean): HTMLDivElement => {
    const d = document.createElement('div')
    d.className = 'drow' + (hl ? ' hl' : '')
    d.textContent = txt
    dbody.appendChild(d)
    rows.push(d)
    return d
  }
  mkRow(`共 ${elems.length} 元素 · 内容 ${natW.toFixed(0)}×${natH.toFixed(0)}px · 世界 长=${(natW / PX_PER_UNIT).toFixed(2)} 高=${(natH / PX_PER_UNIT).toFixed(2)}`, true)
  elems.forEach((el, ei) => {
    const row = mkRow(
      `${el.tag} ${el.kind.padEnd(4)} | svg(${el.sx.toFixed(0)},${el.sy.toFixed(0)} ${el.sw.toFixed(0)}×${el.sh.toFixed(0)}) | 3D(${el.worldX.toFixed(3)},${el.worldY.toFixed(3)}) w=${el.w.toFixed(3)} h=${el.h.toFixed(3)} sw=${el.strokeW.toFixed(4)}` +
      (el.pts ? ` | pts${el.pts.length}` : '') +
      (el.txt ? ` | "${el.txt}"` : ''),
    )
    row.addEventListener('click', () => highlight(ei))
    row.addEventListener('dblclick', () => jump(ei, '对照表'))
  })
  dbgElRows = rows
  dbgEls = elems
  dbgMeshes = meshes
  _t3dHost.dbgEls = elems
  _t3dHost.dbgMeshes = meshes
  ;(document.getElementById('stats') as HTMLElement).textContent = `${elems.length} 元素 · 长 ${(natW / PX_PER_UNIT).toFixed(2)} · 高 ${(natH / PX_PER_UNIT).toFixed(2)}`
  // 相机 fit 谱面（留 40% 边距，保持像素比例）+ 轨道控制目标 = 谱面中心
  fitView()
  console.log('DIAG camOrtho AFTER', camOrtho.left.toFixed(2), camOrtho.right.toFixed(2), camOrtho.top.toFixed(2), camOrtho.bottom.toFixed(2), 'pos', camOrtho.position.x.toFixed(2), camOrtho.position.y.toFixed(2))

  // 2D 显示：高度固定窗高（上下固定），宽度按比例 → 长谱时只横向滚动
  const paneEl = document.getElementById('svgPane')!
  const availH = Math.max(200, paneEl.clientHeight - 44)
  const s = availH / natH
  apply2dSize()
  // 构建后自检：等一帧渲染后统计真实像素
  setTimeout(selfCheck, 800)
}

// 2D 滚轮缩放（放大看局部细节，如符杆/符尾；上下固定，左右滚动）
let _zoom = 1
function apply2dSize(): void {
  const svgEl = document.getElementById('svgRef')!.querySelector('svg')
  if (!svgEl) return
  const paneEl = document.getElementById('svgPane')!
  const availH = Math.max(200, paneEl.clientHeight - 44)
  const s = (availH / natH) * _zoom
  // Verovio 输出的 svg 只有 width/height、无 viewBox；内容为绝对坐标（0~natW×natH），
  // 不加 viewBox 时只显示左上角一块 → 2D 看起来"空了"。补 viewBox 让完整谱面按比例缩放显示。
  svgEl.setAttribute('viewBox', `0 0 ${natW.toFixed(1)} ${natH.toFixed(1)}`)
  svgEl.setAttribute('width', `${(natW * s).toFixed(1)}px`)
  svgEl.setAttribute('height', `${(availH * _zoom).toFixed(1)}px`)
}
document.getElementById('svgPane')!.addEventListener('wheel', (e) => {
  e.preventDefault()
  const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15
  _zoom = Math.min(8, Math.max(0.2, _zoom * delta))
  apply2dSize()
})

let dbgElRows: HTMLDivElement[] = []
let dbgEls: MappedEl[] = []
let dbgMeshes: THREE.Mesh[] = []

// ── 渲染自检（readPixels 统计真实渲染缓冲，诊断 3D 空白） ──
function selfCheck(): void {
  try {
    const gl = renderer.getContext() as WebGLRenderingContext
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let nonWhite = 0, dark = 0, red = 0
    for (let i = 0; i < buf.length; i += 4) {
      const r8 = buf[i]!, g8 = buf[i + 1]!, b8 = buf[i + 2]!
      if (!(r8 > 240 && g8 > 240 && b8 > 240)) nonWhite++
      if (r8 < 100 && g8 < 100 && b8 < 100) dark++
      if (r8 > 150 && g8 < 100 && b8 < 100) red++
    }
    const stats = document.getElementById('stats')!
    stats.textContent = `${dbgEls.length} 元素 · calls=${renderer.info.render.calls} · 非白px=${nonWhite} 黑px=${dark} 红px=${red}`
    console.log('DIAG selfCheck', { w, h, nonWhite, dark, red, calls: renderer.info.render.calls })
  } catch (e) {
    console.error('selfCheck fail', e)
  }
}
// 暴露渲染器与自检（__t3d 由 build() 定义，这里兜底初始化）
const _t3dHost = (window as unknown as { __t3d?: Record<string, unknown> }).__t3d ?? {}
;(window as unknown as { __t3d: Record<string, unknown> }).__t3d = _t3dHost
_t3dHost.renderer = renderer
_t3dHost.selfCheck = selfCheck
_t3dHost.cam = cam
_t3dHost.projTest = (wx: number, wy: number, wz = 0): number[] => {
  cam.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert()
  const v = new THREE.Vector3(wx, wy, wz)
  v.applyMatrix4(inv).applyMatrix4(cam.projectionMatrix)
  return v.toArray().map((x) => +x.toFixed(3))
}
_t3dHost.camInfo = (): Record<string, unknown> => {
  const isOrtho = cam instanceof THREE.OrthographicCamera
  const ortho = isOrtho ? cam as THREE.OrthographicCamera : null
  return {
    type: isOrtho ? 'ortho' : 'persp',
    left: ortho ? ortho.left : null,
    right: ortho ? ortho.right : null,
    top: ortho ? ortho.top : null,
    bottom: ortho ? ortho.bottom : null,
    pos: cam.position.toArray().map((v) => +v.toFixed(2)),
    near: cam.near,
    far: cam.far,
    target: controls.target.toArray().map((v) => +v.toFixed(2)),
  }
}

// ── 双击联动：对照表 / 2D / 3D 互相定位并聚焦 ──
function report(reason: string): void {
  const stats = document.getElementById('stats')!
  stats.textContent = `⚠ ${reason}`
  console.error('t3d:', reason)
}
function focus3D(i: number): boolean {
  const m = dbgMeshes[i]
  if (!m) return false
  m.geometry.computeBoundingBox()
  const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld)
  const c = bb.getCenter(new THREE.Vector3())
  const r = bb.getBoundingSphere(new THREE.Sphere()).radius
  const pad = Math.max(1.5, r * 1.6)
  const rect = canvas.parentElement!.getBoundingClientRect()
  const aspect = Math.max(0.2, rect.width / Math.max(1, rect.height))
  let halfW = pad, halfH = pad
  if (halfW / halfH > aspect) { halfH = halfW / aspect } else { halfW = halfH * aspect }
  camOrtho.left = -halfW; camOrtho.right = halfW
  camOrtho.top = halfH; camOrtho.bottom = -halfH
  camOrtho.zoom = 1 // 聚焦时同样重置 zoom，保证视野 = pad 范围
  camOrtho.updateProjectionMatrix()
  camOrtho.position.set(c.x, c.y, 10)
  camOrtho.lookAt(c.x, c.y, 0)
  controls.target.set(c.x, c.y, 0)
  controls.update()
  cam = camOrtho
  controls.object = camOrtho as never
  ;(document.getElementById('view') as HTMLSelectElement).value = 'ortho'
  return true
}
function scroll2D(i: number): boolean {
  const el = dbgEls[i]
  if (!el) return false
  const paneEl = document.getElementById('svgPane')!
  const svgEl = document.getElementById('svgRef')!.querySelector('svg')
  if (!svgEl) return false
  const dispW = parseFloat(svgEl.getAttribute('width') ?? '0')
  if (!dispW) return false
  const px = (el.sx + el.sw / 2) / natW * dispW
  paneEl.scrollLeft = Math.max(0, px - paneEl.clientWidth / 2)
  return true
}
function jump(i: number, from: string): void {
  highlight(i)
  if (i < 0) { report(`${from}: 未找到对应元素（索引 -1）`); return }
  const reasons: string[] = []
  if (!dbgEls[i]) reasons.push(`2D 映射表无索引 ${i}`)
  const m = dbgMeshes[i]
  if (!m) reasons.push('3D 无对应 mesh（开放路径点数不足 / 轮廓无 shapes / 空文本 → 未生成 3D 物体）')
  else if (!focus3D(i)) reasons.push('3D 聚焦失败')
  if (!scroll2D(i)) reasons.push('2D 滚动失败')
  if (reasons.length) report(`${from}: ${reasons.join('；')}`)
}

// ── 点击高亮（2D / 3D / 调试表三联动） ────────────────
const selHelper = new THREE.Box3Helper(new THREE.Box3(), 0xff0000)
selHelper.visible = false
scene.add(selHelper)
let curSel = -1
function highlight(i: number): void {
  curSel = i
  dbgElRows.forEach((r, ri) => r.classList.toggle('hl', ri === i + 1)) // 第 0 行是标题
  dbgEls.forEach((e, ei) => e.el.classList.toggle('sel', ei === i))
  if (i >= 0 && i < dbgMeshes.length) {
    const m = dbgMeshes[i]!
    m.geometry.computeBoundingBox()
    const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld)
    selHelper.box.copy(bb)
    selHelper.visible = true
  } else {
    selHelper.visible = false
  }
}

// 3D 画布点击（区分拖拽：位移 < 6px 才算点击）
const ray = new THREE.Raycaster()
let downX = 0, downY = 0, downT = 0
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = Date.now() })
canvas.addEventListener('pointerup', (e) => {
  const dx = e.clientX - downX, dy = e.clientY - downY
  if (Math.hypot(dx, dy) > 6 || Date.now() - downT > 500) return
  const rect = canvas.getBoundingClientRect()
  ray.setFromCamera(
    new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
    cam,
  )
  const hits = ray.intersectObjects(dbgMeshes, false)
  highlight(hits.length ? (hits[0]!.object.userData.elIdx as number) : -1)
})

// 2D SVG 点击（命中元素 → 反查 idx）
const svgRef2 = document.getElementById('svgRef')!
svgRef2.addEventListener('pointerdown', (e) => {
  const t = e.target as Element
  const hit = t.closest?.('path,use,text,ellipse,rect,g')
  if (!hit) return
  const i = dbgEls.findIndex((el) => el.el === hit)
  highlight(i >= 0 ? i : -1)
})
svgRef2.addEventListener('dblclick', (e) => {
  const t = e.target as Element
  const hit = t.closest?.('path,use,text,ellipse,rect,g')
  if (!hit) return
  const i = dbgEls.findIndex((el) => el.el === hit)
  if (i >= 0) jump(i, '2D')
  else report(`2D: 该元素不在映射表（可能是 <defs> 字形定义 / 容器 / 未解析元素，tag=${hit.tagName} class=${(hit as HTMLElement).className || ''}）`)
})
// 3D 画布双击（raycast → 联动聚焦）
canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect()
  ray.setFromCamera(
    new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
    cam,
  )
  const hits = ray.intersectObjects(dbgMeshes, false)
  if (hits.length) {
    const idx = hits[0]!.object.userData.elIdx as number
    jump(idx, '3D')
  } else {
    report('3D: 画布未命中任何元素（3D 空白或该区域无物体）')
  }
})

function mergeSafe(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  // 简易 merge：全部转非索引（index 兼容问题兜底）
  const converted = geos.map((g) => {
    if (g.index) {
      const non = g.toNonIndexed()
      g.dispose()
      return non
    }
    return g
  })
  const merged = new THREE.BufferGeometry()
  let off = 0
  const pos: number[] = []
  for (const g of converted) {
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i))
    off += p.count
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  merged.computeVertexNormals()
  return merged
}

let XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><staff>2</staff></note></measure>
    <measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>6</duration><dot/><voice>1</voice><staff>1</staff></note><note><pitch><step>B</step><octave>3</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>F</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note><note><pitch><step>A</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note></measure>
    <measure number="3"><note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>G</step><alter>-1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note><note><pitch><step>F</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note></measure>
    <measure number="4"><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/><voice>1</voice><staff>1</staff></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><staff>1</staff></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note><note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note></measure>
    <measure number="5"><note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note><note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note><note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff></note></measure>
  </part>
</score-partwise>`

document.getElementById('reload')!.addEventListener('click', () => {
  resize()
  build()
  void initBallSystem()
})
document.getElementById('flipbtn')!.addEventListener('click', () => {
  fillFlip *= -1
  ;(document.getElementById('flipbtn') as HTMLElement).textContent = `谱号翻转: ${fillFlip === 1 ? '正' : '反'}`
  build()
})
;(document.getElementById('flipbtn') as HTMLElement).textContent = `谱号翻转: ${fillFlip === 1 ? '正' : '反'}`
// 调试表悬浮窗折叠/展开
;(document.getElementById('dbg') as HTMLElement).querySelector('.dhead')?.addEventListener('click', () => {
  ;(document.getElementById('dbg') as HTMLElement).classList.toggle('collapsed')
})
document.getElementById('view')!.addEventListener('change', (e) => {
  cam = (e.target as HTMLSelectElement).value === 'persp' ? camPersp : camOrtho
  controls.object = cam as never
  controls.update()
})

// ═══════════════════════════════════════════════════════════════
// 球系统：时间轴 + 可选择轨迹线 + 点亮（与主项目/balltest 同逻辑）
// ═══════════════════════════════════════════════════════════════
interface PlayEvent { midi: number; time: number; dur: number; vel: number; channel: number }
let events: PlayEvent[] = []
let duration = 8
interface BallGroup { time: number; idxs: number[]; state?: string }
interface BallTrack {
  mark: number; groups: BallGroup[]; line: THREE.Line; balls: THREE.Mesh[]
  startPos: THREE.Vector3; endPos: THREE.Vector3; color: number
}
interface CorrEdgeInfo { mark: number; from: number; to: number | null; kind: string }
let ballTracks: BallTrack[] = []
const BALL_MARGIN = 2.5
const FLIGHT_SEC = 0.5
const BALL_R = 0.06
const ARC_K = 0.3
const ballRoot = new THREE.Group()
scene.add(ballRoot)

async function loadBallEvents(): Promise<{ evs: PlayEvent[]; staffs: number[] }> {
  const evs: PlayEvent[] = []
  let duration0 = 8
  try {
    const { xmlToMidi } = await import('../shared/midi-xml')
    const bytes = xmlToMidi(XML)
    const { Midi } = await import('@tonejs/midi')
    const parsed = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    parsed.tracks.filter((t) => t.notes.length > 0).forEach((tr, ti) => {
      for (const n of tr.notes) evs.push({ midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity, channel: ti })
    })
    evs.sort((a, b) => a.time - b.time)
    duration0 = parsed.duration
  } catch {
    duration0 = 8
  }
  duration = duration0
  // XML staff 编号（文档序，与 SVG notehead use 顺序一致）：mark = part 序号 ×10 + (staff-1)，全局唯一（钢琴左右手分开）
  const staffs: number[] = []
  try {
    const partRe = /<part\b[^>]*id="([^"]*)"[\s\S]*?<\/part>/g
    let pm: RegExpExecArray | null
    let pi = 0
    while ((pm = partRe.exec(XML))) {
      const noteRe = /<note\b[^>]*>([\s\S]*?)<\/note>/g
      let nm: RegExpExecArray | null
      while ((nm = noteRe.exec(pm[0]))) {
        // chord 后续音符 / 休止符：SVG 无独立 notehead use → 跳过（保持与 noteTargets 顺序对齐）
        if (/<chord\s*\/>/.test(nm[1]!) || /<rest\s*\/>/.test(nm[1]!)) continue
        const sm = nm[1]!.match(/<staff\s*>(\d+)<\/staff>/)
        staffs.push(pi * 10 + (sm ? Number(sm[1]) - 1 : 0))
      }
      pi++
    }
  } catch {
    /* staff 提取失败：退化为全 0 */
  }
  return { evs, staffs }
}

function mergeTieEvents(evs: PlayEvent[]): PlayEvent[] {
  const byKey = new Map<string, PlayEvent[]>()
  for (const e of evs) {
    const key = `${e.channel}|${e.midi}`
    const a = byKey.get(key) ?? []
    a.push(e)
    byKey.set(key, a)
  }
  const out: PlayEvent[] = []
  for (const list of byKey.values()) {
    list.sort((a, b) => a.time - b.time)
    let prev: PlayEvent | null = null
    for (const e of list) {
      if (prev && e.time - (prev.time + prev.dur) < 0.05) {
        prev.dur = Math.max(prev.dur, e.time + e.dur - prev.time)
        continue
      }
      out.push(e)
      prev = e
    }
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function arcPoint(px: number, py: number, tx: number, ty: number, u: number, zBase = 0.02): THREE.Vector3 {
  const dist = Math.hypot(tx - px, ty - py)
  const peak = Math.min(0.7, 0.08 + dist * ARC_K)
  return new THREE.Vector3(px + (tx - px) * u, py + (ty - py) * u, zBase + peak * 4 * (u - u * u))
}
function groupRep(g: BallGroup): { x: number; y: number } {
  if (g.idxs.length) { const t = noteTargets[g.idxs[0]!]!; return { x: t.x, y: t.y } }
  return { x: 0, y: 0 }
}

function bindTargets(_staffs?: number[]): void {
  // 谱行聚类：音符世界 y 排序，相邻 gap > 5（谱行间距 ~12 世界，同谱行音高差 <2）→ 换谱行
  // 每谱行唯一 mark（钢琴左右手=两条独立球链）
  const sorted = [...noteTargets].sort((a, b) => a.y - b.y)
  let cur = 0
  const m = new Map<NoteTarget, number>()
  let prev = sorted[0]!.y
  for (const t of sorted) {
    if (t.y - prev > 3.2) cur++
    m.set(t, cur)
    prev = t.y
  }
  noteTargets.forEach((t) => { t.mark = m.get(t)! })
  const evs = mergeTieEvents(events)
  const xs = noteTargets.map((n) => n.x)
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  // 目标按 x 序 ↔ 事件按 time 序（单轨大谱表 DOM 序=XML 序=事件序；tie 合并后尾部 fallback）
  const order = noteTargets.map((_, i) => i).sort((a, b) => noteTargets[a]!.x - noteTargets[b]!.x)
  for (let i = 0; i < order.length; i++) {
    const t = noteTargets[order[i]!]!
    const ev = evs[i]
    t.time = ev ? ev.time : ((t.x - xMin) / Math.max(1e-6, xMax - xMin)) * duration
  }
  // 按 (time, y) 同步重排 noteTargets 与 noteHeadMeshes（点亮/球链都用 time 序）
  const order2 = noteTargets.map((_, i) => i).sort((a, b) => noteTargets[a]!.time - noteTargets[b]!.time || noteTargets[a]!.y - noteTargets[b]!.y)
  const nt2 = order2.map((i) => noteTargets[i]!)
  const nh2 = order2.map((i) => noteHeadMeshes[i]!)
  noteTargets.splice(0, noteTargets.length, ...nt2)
  noteHeadMeshes.splice(0, noteHeadMeshes.length, ...nh2)
}

function initBalls(): void {
  while (ballRoot.children.length) {
    const m = ballRoot.children[0] as THREE.Mesh
    ballRoot.remove(m)
    m.geometry?.dispose()
    ;(m.material as THREE.Material)?.dispose()
  }
  ballTracks = []
  if (!noteTargets.length) return
  const byMark = new Map<number, number[]>()
  noteTargets.forEach((t, i) => {
    const m = t.mark >= 0 ? t.mark : 0
    const a = byMark.get(m) ?? []
    a.push(i)
    byMark.set(m, a)
  })
  let startX = Infinity, endX = -Infinity
  for (const idxsRaw of byMark.values()) {
    idxsRaw.sort((a, b) => noteTargets[a]!.time - noteTargets[b]!.time || noteTargets[a]!.y - noteTargets[b]!.y)
    startX = Math.min(startX, noteTargets[idxsRaw[0]!]!.x)
    endX = Math.max(endX, noteTargets[idxsRaw[idxsRaw.length - 1]!]!.x)
  }
  startX -= BALL_MARGIN
  endX += BALL_MARGIN
  for (const [mark, idxsRaw] of byMark) {
    const groups: BallGroup[] = []
    for (const i of idxsRaw) {
      const ti = noteTargets[i]!
      const last = groups[groups.length - 1]
      if (last && ti.time - last.time < 0.005) {
        if (!last.idxs.some((j) => Math.abs(noteTargets[j]!.y - ti.y) < 0.01)) last.idxs.push(i)
      } else {
        groups.push({ time: ti.time, idxs: [i] })
      }
    }
    if (!groups.length) continue
    const color = MARK_COLORS[mark % MARK_COLORS.length]!
    const first = noteTargets[groups[0]!.idxs[0]!]!
    const lastT = noteTargets[groups[groups.length - 1]!.idxs[0]!]!
    const startPos = new THREE.Vector3(startX, first.y, 0.02)
    const endPos = new THREE.Vector3(endX, lastT.y, 0.02)
    const bt: BallTrack = { mark, groups, line: null as never, balls: [], startPos, endPos, color }
    const pts: THREE.Vector3[] = [startPos.clone()]
    const segN = 14
    for (let s = 1; s <= segN; s++) pts.push(arcPoint(startPos.x, startPos.y, first.x, first.y, s / segN))
    groups.forEach((g, gi) => {
      const rep = groupRep(g)
      for (let k = 1; k < g.idxs.length; k++) {
        const tgt = noteTargets[g.idxs[k]!]!
        for (let s = 1; s <= 8; s++) pts.push(arcPoint(rep.x, rep.y, tgt.x, tgt.y, s / 8))
      }
      if (gi < groups.length - 1) {
        const nrep = groupRep(groups[gi + 1]!)
        for (let s = 1; s <= segN; s++) pts.push(arcPoint(rep.x, rep.y, nrep.x, nrep.y, s / segN))
      }
    })
    for (let s = 1; s <= segN; s++) pts.push(arcPoint(lastT.x, lastT.y, endPos.x, endPos.y, s / segN))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.65 }),
    )
    ballRoot.add(line)
    bt.line = line
    const poolSize = Math.max(6, Math.max(...groups.map((g) => g.idxs.length)))
    for (let k = 0; k < poolSize; k++) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 16, 12), new THREE.MeshBasicMaterial({ color }))
      ball.visible = false
      ballRoot.add(ball)
      bt.balls.push(ball)
    }
    ballTracks.push(bt)
  }
  renderMkToggles()
}

function updateBalls(t: number): void {
  for (const bt of ballTracks) {
    // 球状态机标注（文档 §7: idle → approaching → onset → sustaining → releasing）
    for (const g of bt.groups) {
      const s = Math.max(0, g.time - FLIGHT_SEC)
      const e = g.time + FLIGHT_SEC
      g.state = t < s ? 'idle' : t < g.time ? 'approaching' : t < e ? 'onset' : 'sustaining'
    }
    for (const b of bt.balls) b.visible = false
    if (!bt.groups.length) continue
    const firstG = bt.groups[0]!
    const startT = Math.max(0, firstG.time - FLIGHT_SEC)
    const endT = Math.max(firstG.time, FLIGHT_SEC)
    if (t < endT) {
      const b0 = bt.balls[0]!
      if (t > startT) {
        const u = Math.min(1, Math.max(0, (t - startT) / (endT - startT)))
        const from = bt.startPos
        const targets = firstG.idxs.length
          ? firstG.idxs.map((ti) => ({ x: noteTargets[ti]!.x, y: noteTargets[ti]!.y }))
          : [{ x: from.x, y: from.y }]
        targets.forEach((tgt, fi) => {
          const ball = bt.balls[fi] ?? bt.balls[0]!
          ball.visible = true
          ball.position.copy(arcPoint(from.x, from.y, tgt.x, tgt.y, u))
        })
      } else {
        b0.visible = true
        b0.position.copy(bt.startPos)
      }
      continue
    }
    const lastG = bt.groups[bt.groups.length - 1]!
    if (t >= lastG.time + FLIGHT_SEC) {
      const b0 = bt.balls[0]!
      b0.visible = true
      b0.position.copy(bt.endPos)
      continue
    }
    if (t >= lastG.time) {
      const u = Math.min(1, Math.max(0, (t - lastG.time) / FLIGHT_SEC))
      const rep = groupRep(lastG)
      const b0 = bt.balls[0]!
      b0.visible = true
      b0.position.copy(arcPoint(rep.x, rep.y, bt.endPos.x, bt.endPos.y, u))
      continue
    }
    let cur: BallGroup | null = null
    let next: BallGroup | null = null
    for (const g of bt.groups) {
      if (g.time <= t) cur = g
      else { next = g; break }
    }
    const stay = cur ?? bt.groups[0]!
    const rep = groupRep(stay)
    if (next && t >= next.time - FLIGHT_SEC && t < next.time) {
      const u = Math.min(1, Math.max(0, (t - (next.time - FLIGHT_SEC)) / FLIGHT_SEC))
      const from = new THREE.Vector3(rep.x, rep.y, 0.02)
      const targets = next.idxs.length
        ? next.idxs.map((ti) => ({ x: noteTargets[ti]!.x, y: noteTargets[ti]!.y }))
        : [groupRep(next)]
      targets.forEach((tgt, fi) => {
        const ball = bt.balls[fi] ?? bt.balls[0]!
        ball.visible = true
        ball.position.copy(arcPoint(from.x, from.y, tgt.x, tgt.y, u))
      })
    } else {
      const b0 = bt.balls[0]!
      b0.visible = true
      b0.position.set(rep.x, rep.y, 0.02)
    }
  }
}

// 点亮：进度前变轨色（按 mark），回退变黑
let litCount = 0
function setLitProgress(t: number): void {
  let k = 0
  while (k < noteTargets.length && noteTargets[k]!.time <= t) k++
  if (k === litCount) return
  const from = Math.min(k, litCount)
  const to = Math.max(k, litCount)
  for (let i = from; i < to; i++) {
    const on = i < k
    const color = on ? MARK_COLORS[noteTargets[i]!.mark % MARK_COLORS.length]! : 0x000000
    ;(noteHeadMeshes[i]!.mesh.material as THREE.MeshBasicMaterial).color.setHex(color)
  }
  litCount = k
}

// 轨迹线开关（每 mk 一个 checkbox）
function renderMkToggles(): void {
  const host = document.getElementById('mkToggles')!
  host.innerHTML = ''
  for (const bt of ballTracks) {
    const lbl = document.createElement('label')
    lbl.style.cssText = 'display:flex;align-items:center;gap:3px;color:var(--text);cursor:pointer'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = true
    cb.addEventListener('change', () => {
      bt.line.visible = cb.checked
      if (!cb.checked) bt.balls.forEach((b) => { b.visible = false })
    })
    lbl.appendChild(cb)
    const sw = document.createElement('span')
    sw.style.cssText = `width:10px;height:10px;background:#${bt.color.toString(16).padStart(6, '0')};display:inline-block;border-radius:2px`
    lbl.appendChild(sw)
    lbl.appendChild(document.createTextNode(`mk${bt.mark}`))
    host.appendChild(lbl)
  }
}

// 时间轴 + 播放
const timeBar = document.getElementById('timeBar') as HTMLInputElement
const timeVal = document.getElementById('timeVal')!
const playBtn = document.getElementById('playBtn')!
timeBar.addEventListener('input', () => {
  const t = (Number(timeBar.value) / 1000) * duration
  timeVal.textContent = t.toFixed(2) + 's'
  setLitProgress(t)
  updateBalls(t)
  let fx = 0
  let found = false
  for (const bt of ballTracks) {
    const b0 = bt.balls[0]!
    if (b0.visible) { fx = b0.position.x; found = true }
  }
  if (found) controls.target.x = fx
  controls.update()
})
let playing = false
let playT = 0
let playStart = 0
let rafId = 0
playBtn.addEventListener('click', () => {
  playing = !playing
  playBtn.textContent = playing ? '暂停' : '播放'
  if (playing) {
    playStart = performance.now() - playT * 1000
    const step = (): void => {
      if (!playing) return
      playT = (performance.now() - playStart) / 1000
      if (playT > duration) { playT = 0; playStart = performance.now() }
      timeBar.value = String((playT / duration) * 1000)
      timeVal.textContent = playT.toFixed(2) + 's'
      setLitProgress(playT)
      updateBalls(playT)
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)
  } else {
    cancelAnimationFrame(rafId)
  }
})

async function initBallSystem(): Promise<void> {
  const loaded = await loadBallEvents()
  events = loaded.evs
  bindTargets(loaded.staffs)
  initBalls()
  updateBalls(0)
  timeBar.max = '1000'
  timeVal.textContent = '0.00s'
  litCount = 0
  // 边等级（文档 §4/§6：strong=唯一后继 · candidate=同 onset 多音扇出 · fallback=链尾无后继）
  const ballEdges: CorrEdgeInfo[] = []
  for (const bt of ballTracks) {
    for (let gi = 0; gi < bt.groups.length; gi++) {
      const g = bt.groups[gi]!
      const nxt = bt.groups[gi + 1]
      ballEdges.push({ mark: bt.mark, from: g.time, to: nxt ? nxt.time : null, kind: nxt ? (g.idxs.length > 1 ? 'candidate' : 'strong') : 'fallback' })
    }
  }
  Object.assign((window as unknown as Record<string, unknown>).__t3d ?? {}, {
    noteTargets,
    ballTracks,
    ballEvents: events,
    ballDuration: duration,
    ballStaffs: loaded.staffs,
    ballEdges,
    ballStates: ballTracks.map((bt) => ({ mark: bt.mark, groups: bt.groups.map((g) => ({ t: g.time, n: g.idxs.length, state: g.state ?? 'idle' })) })),
  })
  ;(document.getElementById('stats') as HTMLElement).textContent =
    `${document.getElementById('stats')!.textContent} · 球 ${noteTargets.length} 音 / ${ballTracks.length} 链 / ${duration.toFixed(1)}s`
  buildCorrLayer()
}

// ===== 2D 人工矫正层 v2：边线段模型（线宽=小节线宽 · 实心小球端点=5×线宽+谱线宽 · 拖动吸附/分支/删除 · 黄绿红 · 符头蓝红） =====
const SVG_NS = 'http://www.w3.org/2000/svg'
const EDGE_W = 22 // 与小节分隔线同宽（Verovio barLine 用户单位 ~22）
const SNAP_DIST = 55
const SMALL_R = 12 // 默认端点：实心小圆
let NODE_R = 20 // 选中线端点：空心大圆（直径 = 5×小节线宽 + 谱线宽，构建时量谱线宽计算）
let selectedEdgeId: number | null = null // 当前选中的线（只有它两端是空心大圆、可拖动；一次一根）
let edgeSeq = 0
interface CorrEdge { id: number; from: number; to: number; line: SVGLineElement; mark: number }
interface CorrNode { ti: number; circ: SVGCircleElement; hit: SVGCircleElement; headEl: SVGUseElement | null }
let corrEdges: CorrEdge[] = []
let corrNodes: CorrNode[] = []
let corrDrag: { mode: 'move' | 'branch'; node: CorrNode; temp: SVGLineElement | null } | null = null

function updateNodeVisuals(): void {
  for (const n of corrNodes) {
    const sel = selectedEdgeId !== null && corrEdges.some((e) => e.id === selectedEdgeId && (e.from === n.ti || e.to === n.ti))
    if (sel) {
      n.circ.setAttribute('r', String(NODE_R))
      n.circ.setAttribute('fill', 'none'); n.circ.setAttribute('stroke', '#111'); n.circ.setAttribute('stroke-width', '4')
    } else {
      n.circ.setAttribute('r', String(SMALL_R))
      n.circ.setAttribute('fill', '#111'); n.circ.setAttribute('stroke', 'none')
    }
  }
}

function svgPoint(ev: MouseEvent): { x: number; y: number } {
  const svg = document.querySelector('#svgRef svg') as SVGSVGElement
  const pt = svg.createSVGPoint()
  pt.x = ev.clientX; pt.y = ev.clientY
  const p = pt.matrixTransform((svg as SVGGraphicsElement).getScreenCTM()!.inverse())
  return { x: p.x, y: p.y }
}

function refreshCorrColors(): void {
  // 音符符头：被端点经过（有边）= 蓝，否则红
  for (const n of corrNodes) {
    const has = corrEdges.some((e) => e.from === n.ti || e.to === n.ti)
    if (n.headEl) n.headEl.style.fill = has ? '#2266ff' : '#ff2222'
  }
  // 线：头尾相接（时间序：from 的下一个 time 是 to）= 绿；断开 = 红
  for (const e of corrEdges) {
    const nexts = corrEdges
      .filter((x) => x.mark === e.mark && x.from === e.to)
      .map((x) => x.to)
    const ok = nexts.length > 0 || corrEdges.some((x) => x.mark === e.mark && x.to === e.from)
    e.line.setAttribute('stroke', ok ? '#22c55e' : '#ff2222')
  }
}

function deleteNodeEdges(ti: number): void {
  const dead = new Set(corrEdges.filter((e) => e.from === ti || e.to === ti).map((e) => e.id))
  corrEdges = corrEdges.filter((e) => e.from !== ti && e.to !== ti)
  if (selectedEdgeId !== null && dead.has(selectedEdgeId)) selectedEdgeId = null
  for (const e of corrEdges) e.line.setAttribute('stroke', '#22c55e')
  refreshCorrColors()
}

function rebuildCorrLines(): void {
  for (const e of corrEdges) {
    const a = corrNodes.find((n) => n.ti === e.from)
    const b = corrNodes.find((n) => n.ti === e.to)
    if (a && b) {
      const at = noteTargets[a.ti]!, bt = noteTargets[b.ti]!
      e.line.setAttribute('x1', String(at.svgX)); e.line.setAttribute('y1', String(at.svgY))
      e.line.setAttribute('x2', String(bt.svgX)); e.line.setAttribute('y2', String(bt.svgY))
    }
  }
}

function buildCorrLayer(): void {
  const svg = document.querySelector('#svgRef svg') as SVGSVGElement
  if (!svg) return
  svg.querySelector('#corrLayer')?.remove()
  const g = document.createElementNS(SVG_NS, 'g')
  g.id = 'corrLayer'
  svg.appendChild(g)
  corrEdges = []; corrNodes = []
  // 每链：按 (mark, time) 序，相邻不同 time 的音符建边（同刻和弦不互相连线，共同连到下一时刻）
  const groups = new Map<number, NoteTarget[]>()
  for (const t of noteTargets) {
    if (!groups.has(t.mark)) groups.set(t.mark, [])
    groups.get(t.mark)!.push(t)
  }
  for (const [mk, arr] of groups) {
    const sorted = [...arr].sort((a, b) => a.time - b.time || a.y - b.y)
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!, b = sorted[i + 1]!
      if (Math.abs(a.time - b.time) < 1e-6) continue // 同刻（和弦）不连
      const ai = noteTargets.indexOf(a), bi = noteTargets.indexOf(b)
      const eid = edgeSeq++
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('x1', String(a.svgX)); line.setAttribute('y1', String(a.svgY))
      line.setAttribute('x2', String(b.svgX)); line.setAttribute('y2', String(b.svgY))
      line.setAttribute('stroke', '#22c55e'); line.setAttribute('stroke-width', String(EDGE_W))
      line.setAttribute('stroke-linecap', 'round'); line.setAttribute('opacity', '0.9')
      line.setAttribute('data-edge', String(eid))
      line.addEventListener('click', (ev) => { ev.stopPropagation(); selectedEdgeId = eid; updateNodeVisuals() })
      g.appendChild(line)
      corrEdges.push({ id: eid, from: ai, to: bi, line, mark: mk })
    }
  }
  // 端点：每个音符一个实心小球（直径=5×线宽+谱线宽，直接拖动）+ 大命中圈
  let staffW = 18
  for (const p of svg.querySelectorAll('path')) {
    const bb = (p as SVGGraphicsElement).getBBox()
    if (bb.width > 50 && bb.height < 1) {
      const w = parseFloat(getComputedStyle(p).strokeWidth) || 0
      if (w > 0) { staffW = w; break }
    }
  }
  const nodeR = (5 * EDGE_W + staffW) / 2
  NODE_R = nodeR
  const hitR = Math.max(SNAP_DIST, nodeR + 12)
  noteTargets.forEach((t, ti) => {
    const circ = document.createElementNS(SVG_NS, 'circle')
    circ.setAttribute('cx', String(t.svgX)); circ.setAttribute('cy', String(t.svgY))
    circ.setAttribute('r', String(SMALL_R))
    circ.setAttribute('fill', '#111'); circ.setAttribute('stroke', 'none')
    circ.setAttribute('pointer-events', 'none')
    const hit = document.createElementNS(SVG_NS, 'circle')
    hit.setAttribute('cx', String(t.svgX)); hit.setAttribute('cy', String(t.svgY))
    hit.setAttribute('r', String(hitR))
    hit.setAttribute('fill', 'transparent')
    hit.style.cursor = 'grab'
    hit.addEventListener('click', (ev) => ev.stopPropagation()) // 端点点击不触发空白取消
    g.appendChild(circ); g.appendChild(hit)
    corrNodes.push({ ti, circ, hit, headEl: t.elRef as SVGUseElement | null })
  })
  // 交互：pointerdown 拖端点（吸附/删除），dblclick 引分支
  let dragNode: CorrNode | null = null
  let dragT = 0
  const onDown = (ev: PointerEvent, node: CorrNode): void => {
    // 只有选中线的两个端点可拖动（实心小圆不可拖）
    if (selectedEdgeId === null || !corrEdges.some((e) => e.id === selectedEdgeId && (e.from === node.ti || e.to === node.ti))) return
    ev.preventDefault(); ev.stopPropagation()
    dragNode = node; dragT = performance.now()
    corrDrag = { mode: 'move', node, temp: null }
    document.body.style.cursor = 'grabbing'
    // 相关线变黄
    for (const e of corrEdges) if (e.from === node.ti || e.to === node.ti) e.line.setAttribute('stroke', '#ffd166')
  }
  const onMove = (ev: PointerEvent): void => {
    if (!dragNode || !corrDrag) return
    const p = svgPoint(ev)
    const t = noteTargets[dragNode.ti]!
    // 吸附检测：最近音符（同链优先）
    let best = Infinity, bestTi = -1
    for (const n of corrNodes) {
      if (n.ti === dragNode.ti) continue
      const t2 = noteTargets[n.ti]!
      const d = Math.hypot(t2.svgX - p.x, t2.svgY - p.y) + (t2.mark === t.mark ? 0 : 40)
      if (d < best) { best = d; bestTi = n.ti }
    }
    let cx = p.x, cy = p.y
    if (best < SNAP_DIST) { const s = noteTargets[bestTi]!; cx = s.svgX; cy = s.svgY }
    dragNode.circ.setAttribute('cx', String(cx)); dragNode.circ.setAttribute('cy', String(cy))
    const hit = dragNode.hit
    hit.setAttribute('cx', String(cx)); hit.setAttribute('cy', String(cy))
    // 更新相关线端点
    for (const e of corrEdges) if (e.from === dragNode.ti || e.to === dragNode.ti) {
      const a = corrNodes.find((n) => n.ti === e.from), b = corrNodes.find((n) => n.ti === e.to)
      if (!a || !b) continue
      const at = noteTargets[a.ti]!, bt = noteTargets[b.ti]!
      const src = e.from === dragNode.ti ? { x: cx, y: cy } : { x: at.svgX, y: at.svgY }
      const dst = e.to === dragNode.ti ? { x: cx, y: cy } : { x: bt.svgX, y: bt.svgY }
      e.line.setAttribute('x1', String(src.x)); e.line.setAttribute('y1', String(src.y))
      e.line.setAttribute('x2', String(dst.x)); e.line.setAttribute('y2', String(dst.y))
    }
  }
  const onUp = (ev: PointerEvent): void => {
    if (!dragNode || !corrDrag) { document.body.style.cursor = ''; return }
    const node = dragNode
    dragNode = null; corrDrag = null
    document.body.style.cursor = ''
    const p = svgPoint(ev)
    const t = noteTargets[node.ti]!
    // 落到另一端点（空心圈）= 删除该音符的所有边
    let best = Infinity, bestTi = -1
    for (const n of corrNodes) {
      if (n.ti === node.ti) continue
      const t2 = noteTargets[n.ti]!
      const d = Math.hypot(t2.svgX - p.x, t2.svgY - p.y)
      if (d < best) { best = d; bestTi = n.ti }
    }
    if (best < SNAP_DIST && bestTi >= 0) {
      deleteNodeEdges(node.ti)
      node.circ.setAttribute('cx', String(t.svgX)); node.circ.setAttribute('cy', String(t.svgY))
      node.hit.setAttribute('cx', String(t.svgX)); node.hit.setAttribute('cy', String(t.svgY))
      rebuildCorrLines()
      updateNodeVisuals()
      return
    }
    // 未吸附/未删除：恢复原位（撤销拖动）
    rebuildCorrLines()
    node.circ.setAttribute('cx', String(t.svgX)); node.circ.setAttribute('cy', String(t.svgY))
    node.hit.setAttribute('cx', String(t.svgX)); node.hit.setAttribute('cy', String(t.svgY))
    refreshCorrColors()
  }
  const onDbl = (ev: MouseEvent, node: CorrNode): void => {
    ev.preventDefault(); ev.stopPropagation()
    // 引分支：从该音符拉新线，吸附到目标音符则新建边
    const t = noteTargets[node.ti]!
    const g2 = document.querySelector('#corrLayer') as SVGGElement
    const temp = document.createElementNS(SVG_NS, 'line')
    temp.setAttribute('x1', String(t.svgX)); temp.setAttribute('y1', String(t.svgY))
    temp.setAttribute('x2', String(t.svgX)); temp.setAttribute('y2', String(t.svgY))
    temp.setAttribute('stroke', '#ffd166'); temp.setAttribute('stroke-width', String(EDGE_W))
    temp.setAttribute('stroke-dasharray', '14,10'); temp.setAttribute('opacity', '0.9')
    g2.appendChild(temp)
    corrDrag = { mode: 'branch', node, temp }
    const mv = (e2: PointerEvent): void => {
      if (corrDrag?.mode !== 'branch') return
      const pt = svgPoint(e2)
      let bx = pt.x, by = pt.y, best2 = Infinity, bt2 = -1
      for (const n of corrNodes) {
        if (n.ti === node.ti) continue
        const t2 = noteTargets[n.ti]!
        const d = Math.hypot(t2.svgX - pt.x, t2.svgY - pt.y)
        if (d < best2) { best2 = d; bt2 = n.ti }
      }
      if (best2 < SNAP_DIST) { const s = noteTargets[bt2]!; bx = s.svgX; by = s.svgY }
      temp.setAttribute('x2', String(bx)); temp.setAttribute('y2', String(by))
    }
    const up = (e2: PointerEvent): void => {
      document.removeEventListener('pointermove', mv)
      document.removeEventListener('pointerup', up)
      const temp2 = temp
      temp2.remove()
      if (corrDrag?.mode !== 'branch') return
      corrDrag = null
      const pt = svgPoint(e2)
      let best3 = Infinity, bt3 = -1
      for (const n of corrNodes) {
        if (n.ti === node.ti) continue
        const t2 = noteTargets[n.ti]!
        const d = Math.hypot(t2.svgX - pt.x, t2.svgY - pt.y)
        if (d < best3) { best3 = d; bt3 = n.ti }
      }
      if (best3 >= SNAP_DIST || bt3 < 0) return
      const a = node.ti, b = bt3
      const eid = edgeSeq++
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('x1', String(noteTargets[a]!.svgX)); line.setAttribute('y1', String(noteTargets[a]!.svgY))
      line.setAttribute('x2', String(noteTargets[b]!.svgX)); line.setAttribute('y2', String(noteTargets[b]!.svgY))
      line.setAttribute('stroke', '#22c55e'); line.setAttribute('stroke-width', String(EDGE_W))
      line.setAttribute('stroke-linecap', 'round'); line.setAttribute('opacity', '0.9')
      line.setAttribute('data-edge', String(eid))
      line.addEventListener('click', (ev) => { ev.stopPropagation(); selectedEdgeId = eid; updateNodeVisuals() })
      ;(document.querySelector('#corrLayer') as SVGGElement).appendChild(line)
      const mark = noteTargets[a]!.mark
      corrEdges.push({ id: eid, from: a, to: b, line, mark })
      refreshCorrColors()
      updateNodeVisuals()
    }
    document.addEventListener('pointermove', mv)
    document.addEventListener('pointerup', up)
  }
  for (const n of corrNodes) {
    n.hit.addEventListener('pointerdown', (ev) => onDown(ev, n))
    n.hit.addEventListener('dblclick', (ev) => onDbl(ev, n))
  }
  // 点击空白（非线/非端点）取消选中
  svg.addEventListener('click', (ev) => {
    const t = ev.target as Element
    if (t.closest?.('line, circle')) return
    if (selectedEdgeId !== null) { selectedEdgeId = null; updateNodeVisuals() }
  })
  document.removeEventListener('pointermove', onMove)
  document.removeEventListener('pointerup', onUp)
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
  refreshCorrColors()
  updateNodeVisuals()
}

void (async () => {
  if (!(await initVrv())) { (document.getElementById('stats') as HTMLElement).textContent = 'Verovio 初始化失败'; return }
  try { const r = await fetch('sample.xml'); if (r.ok) XML = await r.text() } catch { /* 用内嵌兜底 */ }
  resize()
  build()
  void initBallSystem()
})()
