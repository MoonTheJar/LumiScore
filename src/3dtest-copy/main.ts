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
  // ⚠ 必须匹配带属性的 <note ...>（如 <note chord="yes">）：旧正则只认无属性的 <note>，
  //    漏掉的音符没有 <type> → Verovio 不画符杆/符尾
  return xml.replace(/<note(?=[\s>])[^>]*>[\s\S]*?<\/note>/g, (m) => {
    if (/<type>/.test(m)) return m
    const dm2 = m.match(/<duration>(\d+)<\/duration>/)
    if (!dm2) return m
    const beats = parseInt(dm2[1]!, 10) / divisions
    return m.replace(/<duration>\d+<\/duration>/, `$&<type>${durToType(beats)}</type>`)
  })
}

// 给每个 <note> 注入唯一 id：Verovio 会把它原样渲染到 SVG 的 <g class="note" id="..."> 上，
// 于是符头（SVG 侧）与谱面身份（XML 侧）可以精确锚定，不再靠"文档序 = 渲染序"的假设。
function tagNoteIds(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  let k = 0
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    for (const m of Array.from(part.getElementsByTagName('measure'))) {
      for (const note of Array.from(m.getElementsByTagName('note'))) {
        note.setAttribute('id', 't3dN' + (k++))
        // 装饰音不占节拍：缺 <duration> 时补 0（否则 midi-xml 会按默认 1 拍算，把后面的音整体推迟）
        if (note.getElementsByTagName('grace').length && !note.getElementsByTagName('duration').length) {
          const d = doc.createElement('duration')
          d.textContent = '0'
          const v = note.getElementsByTagName('voice')[0]
          if (v) note.insertBefore(d, v)
          else note.appendChild(d)
        }
      }
    }
  }
  return new XMLSerializer().serializeToString(doc)
}

// ═══════════════════════════════════════════════════════════════
// 反复展开：把 repeat / volta(ending) / D.C. / D.S. / Coda / Fine 线性化成单向小节序列。
// 小球只前进不回跳（回跳视觉突兀且时序错乱），谱面也不再显示反复记号。
// 支持：forward/backward repeat（含 times）、多 ending volta、D.C./D.S.（al Fine / al Coda）、
//       Segno/Coda/Fine 标记（<sound> 属性 + <words> 文本兜底）
// 保护：展开上限 MAX_EXPAND，超限即停（绝不无限循环）
// ═══════════════════════════════════════════════════════════════
const MAX_EXPAND = 2000
function expandRepeats(xml: string): { xml: string; expanded: boolean; log: string[] } {
  const log: string[] = []
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parts = Array.from(doc.getElementsByTagName('part'))
  let expanded = false
  for (const part of parts) {
    const measures = Array.from(part.getElementsByTagName('measure'))
    if (!measures.length) continue
    interface MInfo {
      i: number; el: Element
      fwd: number | null   // forward repeat：重复回到的小节索引
      bwd: number | null   // backward repeat：重复次数
      endStart: string | null
      endStop: string | null
      fine: boolean; dacapo: boolean; dalsegno: boolean; coda: boolean; tocoda: boolean; segno: boolean
    }
    const infos: MInfo[] = measures.map((m, i) => {
      let fwd: number | null = null
      let bwd: number | null = null
      for (const b of Array.from(m.getElementsByTagName('barline'))) {
        const r = b.getElementsByTagName('repeat')[0]
        if (!r) continue
        const dir = r.getAttribute('direction')
        const loc = b.getAttribute('location') || 'right'
        const times = Math.max(2, parseInt(r.getAttribute('times') || '2', 10) || 2)
        if (dir === 'forward') fwd = loc === 'left' ? i : i + 1
        if (dir === 'backward') bwd = times
      }
      let endStart: string | null = null
      let endStop: string | null = null
      for (const e of Array.from(m.getElementsByTagName('ending'))) {
        const ty = e.getAttribute('type')
        if (ty === 'start') endStart = e.getAttribute('number') || '1'
        if (ty === 'stop') endStop = e.getAttribute('number') || '1'
      }
      const s = { fine: false, dacapo: false, dalsegno: false, coda: false, tocoda: false, segno: false }
      for (const snd of Array.from(m.getElementsByTagName('sound'))) {
        if (snd.getAttribute('fine')) s.fine = true
        if (snd.getAttribute('dacapo')) s.dacapo = true
        if (snd.getAttribute('dalsegno')) s.dalsegno = true
        if (snd.getAttribute('coda')) s.coda = true
        if (snd.getAttribute('tocoda')) s.tocoda = true
        if (snd.getAttribute('segno')) s.segno = true
      }
      const words = Array.from(m.getElementsByTagName('words')).map((w) => (w.textContent || '').toLowerCase()).join(' ')
      if (!s.dacapo && /d\.\s*c\.|da capo/.test(words)) s.dacapo = true
      if (!s.dalsegno && /d\.\s*s\.|dal segno/.test(words)) s.dalsegno = true
      if (!s.fine && /\bfine\b/.test(words)) s.fine = true
      if (!s.tocoda && /to\s*coda/.test(words)) s.tocoda = true
      return { i, el: m, fwd, bwd, endStart, endStop, ...s }
    })
    const segnoIdx = infos.findIndex((m) => m.segno)
    const codaIdx = infos.findIndex((m) => m.coda)
    const order: number[] = []
    const stack: { start: number; times: number; count: number }[] = []
    let jumped = false
    let curEnding: string | null = null
    let i = 0
    let guard = 0
    while (i < infos.length && guard++ < MAX_EXPAND) {
      const m = infos[i]!
      if (m.endStart) curEnding = m.endStart
      const pass = stack.length ? stack[stack.length - 1]!.count : 1
      // volta：本次经过不在该 ending 的 number 里 → 跳过整段
      if (curEnding && !jumped && stack.length) { // volta 跳过仅作用于反复段内部；段后的 ending 全部保留（否则整小节被丢弃）
        const nums = curEnding.split(',').map((x) => parseInt(x.trim(), 10))
        if (!nums.includes(pass)) {
          if (m.endStop) curEnding = null
          i++
          continue
        }
      }
      order.push(i)
      if (m.endStop) curEnding = null
      if (m.tocoda && codaIdx >= 0 && !jumped) { jumped = true; i = codaIdx; continue }
      if ((m.dacapo || (m.dalsegno && segnoIdx >= 0)) && !jumped) {
        jumped = true
        i = m.dacapo ? 0 : segnoIdx
        log.push(`${m.dacapo ? 'D.C.' : 'D.S.'} → 回到第 ${i + 1} 小节${infos.some((x) => x.fine) ? '（至 Fine）' : ''}`)
        continue
      }
      if (jumped && m.fine) break
      // 跳转之后不再触发 repeat（D.C./D.S. 回来的段落不重复，避免展开失控）
      if (!jumped && m.bwd !== null) {
        const r = stack[stack.length - 1]
        if (r) {
          r.times = m.bwd
          if (r.count < r.times) { r.count++; i = r.start; continue }
          stack.pop()
        }
      }
      // 同一个 forward 只入栈一次（二次经过时再入栈会无限重复）
      if (!jumped && m.fwd !== null && !stack.some((r) => r.start === m.fwd)) stack.push({ start: m.fwd, times: 2, count: 1 })
      i++
    }
    if (!order.length || order.length === measures.length) continue
    expanded = true
    log.push(`小节 ${measures.length} → 展开 ${order.length}`)
    const frag = doc.createDocumentFragment()
    order.forEach((idx, k) => {
      const clone = infos[idx]!.el.cloneNode(true) as Element
      clone.setAttribute('number', String(k + 1))
      // 剥掉反复/跳转记号，展开后的谱面不再出现它们
      for (const b of Array.from(clone.getElementsByTagName('barline'))) {
        const r = b.getElementsByTagName('repeat')[0]
        if (r) b.removeChild(r)
        const st = b.getElementsByTagName('bar-style')[0]
        if (st) st.textContent = 'regular'
      }
      for (const e of Array.from(clone.getElementsByTagName('ending'))) e.parentNode?.removeChild(e)
      for (const s of Array.from(clone.getElementsByTagName('sound'))) {
        for (const a of ['dacapo', 'dalsegno', 'tocoda', 'coda', 'segno', 'fine']) s.removeAttribute(a)
      }
      for (const d of Array.from(clone.getElementsByTagName('direction'))) {
        const w = d.getElementsByTagName('words')[0]
        if (w && /(d\.\s*c\.|d\.\s*s\.|da capo|dal segno|\bfine\b|to\s*coda)/i.test(w.textContent || '')) d.parentNode?.removeChild(d)
      }
      frag.appendChild(clone)
    })
    for (const m of measures) part.removeChild(m)
    part.appendChild(frag)
  }
  // ⚠ 剥离注释：Verovio(libxml2) 遇到含非 ASCII 的注释会直接"unknown XML data"拒绝加载
  return { xml: new XMLSerializer().serializeToString(doc).replace(/<!--[\s\S]*?-->/g, ''), expanded, log }
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
      breaks: 'none',   // 必须单行：折行会让小球换行时"跳回去"，且一行多轨的连线才不会跨轨
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
// 符头中心（SVG 用户坐标，坐标系 = 2D 对照区根 svg，即矫正层 corrLayer 所在坐标系）。
// ⚠ 不能只连乘到 el.ownerSVGElement：Verovio 输出里音符位于嵌套
//   <svg class="definition-scale" viewBox="0 0 84250 8440"> 内部，该内嵌 svg 被主 svg 按
//   preserveAspectRatio=meet 整体缩放（实测 0.869）并居中平移；手工连乘到内嵌 svg 为止
//   拿到的是"内嵌 svg viewBox 坐标"，与画在主 svg 上的端点差一个缩放+平移 → 端点错位。
//   直接用 getScreenCTM 换算到根 svg 坐标系：天然包含嵌套 svg / viewBox / 全部祖先 transform，
//   与浏览器真实渲染位置精确一致（实测与 getBoundingClientRect 中心偏差 <0.01px）。
function svgCenter(el: Element): { x: number; y: number } {
  const g = el as SVGGraphicsElement
  const b = g.getBBox()
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const root = document.getElementById('svgRef')?.querySelector('svg') as SVGSVGElement | null
  const sm = g.getScreenCTM()
  const rm = root?.getScreenCTM()
  if (sm && rm) {
    const p = new DOMPoint(cx, cy).matrixTransform(rm.inverse().multiply(sm))
    return { x: p.x, y: p.y }
  }
  // 兜底（无布局信息时）：元素自身 + 祖先 transform 连乘
  const svg = g.ownerSVGElement
  let m: M2 = M_ID
  let node: Element | null = el
  while (node && node !== svg) {
    const t = node.getAttribute('transform')
    if (t) m = mmul(mParse(t), m)
    node = node.parentElement
  }
  return mApply({ x: cx, y: cy }, m)
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
interface NoteTarget {
  x: number; y: number; mark: number; time: number; channel: number; staffY: number
  svgX: number; svgY: number; elRef: Element | null
  // 自动化扩展：MIDI 证据 + XML 谱面身份（见 XmlHead）
  dur: number; midi: number | null; tieCont: boolean; head: XmlHead | null
  noteId: string // SVG 侧锚点：Verovio 把 <note> 的 id 原样渲染到 g.note 上，用于精确对应
}
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

// 2D 独立页：#canvasPane 隐藏时画布无尺寸 → 全部 3D 渲染/几何让位给 2D，避免白屏与卡顿
const has3D = (): boolean => !!canvas && canvas.clientWidth > 4 && canvas.clientHeight > 4
function resize(): void {
  if (!has3D()) return
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
  if (!has3D()) return
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
  if (!has3D()) return
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
          const noteEl = el.el.closest?.('g.note') as Element | null
          noteTargets.push({ x: mesh.position.x, y: mesh.position.y, mark: 0, time: 0, channel: 0, staffY, svgX: c.x, svgY: c.y, elRef: el.el, dur: 0, midi: null, tieCont: false, head: null, noteId: noteEl?.id ?? '' })
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

// 2D 滚轮缩放（放大看局部细节，如符杆/符尾）+ 适应模式
// height=按窗高（长谱横向滚动）/ width=按窗宽（整谱可见、端点全部可点）/ page=整页塞进窗口
let _zoom = 1
let _fitMode: 'height' | 'width' | 'page' = 'height'
function apply2dSize(): void {
  const svgEl = document.getElementById('svgRef')!.querySelector('svg')
  if (!svgEl) return
  const paneEl = document.getElementById('svgPane')!
  const availW = Math.max(200, paneEl.clientWidth - 20)
  const availH = Math.max(200, paneEl.clientHeight - 44)
  let s = availH / natH
  if (_fitMode === 'width') s = availW / natW
  else if (_fitMode === 'page') s = Math.min(availW / natW, availH / natH)
  s *= _zoom
  // Verovio 输出的 svg 只有 width/height、无 viewBox；内容为绝对坐标（0~natW×natH），
  // 不加 viewBox 时只显示左上角一块 → 2D 看起来"空了"。补 viewBox 让完整谱面按比例缩放显示。
  svgEl.setAttribute('viewBox', `0 0 ${natW.toFixed(1)} ${natH.toFixed(1)}`)
  svgEl.setAttribute('width', `${(natW * s).toFixed(1)}px`)
  svgEl.setAttribute('height', `${(natH * s).toFixed(1)}px`)
}
document.getElementById('svgPane')!.addEventListener('wheel', (e) => {
  e.preventDefault()
  const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15
  _zoom = Math.min(8, Math.max(0.15, _zoom * delta))
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

// 2D SVG 点击（命中元素 → 反查 idx）：命中容器时向上/向下找真实图元，避免误报"不在映射表"
function resolveDbgIdx(hit: Element): number {
  let node: Element | null = hit
  while (node) {
    const i = dbgEls.findIndex((el) => el.el === node)
    if (i >= 0) return i
    node = node.parentElement
  }
  const sub = hit.querySelector?.('use, path, text, ellipse, rect') ?? null
  if (sub) {
    const j = dbgEls.findIndex((el) => el.el === sub)
    if (j >= 0) return j
  }
  return -1
}
const svgRef2 = document.getElementById('svgRef')!
svgRef2.addEventListener('pointerdown', (e) => {
  const t = e.target as Element
  const hit = t.closest?.('path,use,text,ellipse,rect,g')
  if (!hit) return
  highlight(resolveDbgIdx(hit))
})
svgRef2.addEventListener('dblclick', (e) => {
  const t = e.target as Element
  const hit = t.closest?.('path,use,text,ellipse,rect,g')
  if (!hit) return
  const i = resolveDbgIdx(hit)
  if (i >= 0) jump(i, '2D')
  else report(`2D: 该元素不在映射表（可能是 <defs> 字形定义 / 容器 / 未解析元素，tag=${hit.tagName}）`)
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
// 球系统：时间轴 + 轨迹线 + 点亮
// 自动化主线（参考 result.md 三真源 / Head-Edge-Ball 模型）：
//   MusicXML = 谱面身份真源（part/measure/staff/voice/chord/tie/逻辑游标）
//   MIDI     = 播放真源（onset 决定小球落点时机）
//   连线     = 由 (part,staff,voice) 分链 + MIDI 证据自动生成，分级 strong/candidate/fallback
//   人工     = 只做微调（拖动/分支/删除），改过的边标 manual，不覆盖自动证据
// ═══════════════════════════════════════════════════════════════
interface PlayEvent { midi: number; time: number; dur: number; vel: number; channel: number; tick: number }
let events: PlayEvent[] = []
let duration = 8
// 落点：同刻和弦聚合为一个 stop；组内每个符头一个球位（扇出视觉）
interface BallStop {
  idxs: number[]
  time: number              // onset（MIDI 决定）
  pos: { x: number; y: number }[]
  cx: number; cy: number    // 组中心（画轨迹线）
  dur: number               // MIDI 时长
  dwell: number             // 停留（跳音短、保持音长）
  flight: number            // 飞向下一落点用时
  peak: number              // 弧高（跳音高、保持音低）
}
interface BallTrack {
  mark: number; stops: BallStop[]; line: THREE.Line; balls: THREE.Mesh[]
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

// ── 边等级 ──────────────────────────────────────────────
type EdgeKind = 'strong' | 'candidate' | 'fallback' | 'manual' | 'dangling'
// ── 谱面身份 Head（由 MusicXML 解析） ───────────────────
interface XmlHead {
  part: number; measure: number; staff: number; voice: string
  onset: number        // 逻辑 onset（divisions tick，跨小节累计）
  dur: number          // 逻辑时长（divisions）
  div: number          // 该处的 divisions（每四分音符 tick）→ 换算 MIDI tick
  chord: boolean; rest: boolean; grace: boolean
  // 倚音拓扑（parseXmlHeads 后处理填充）：
  //   倚音角色（三层标签，而非二分类）：
  //     PRE     = 前倚音（插在主音之前，落点略早于主音）
  //     POST    = 后倚音（追加在主音之后，落点略晚于主音）
  //     BRIDGE  = 夹心：同时紧邻前主音与后主音（prevMain → graceChain → nextMain），
  //               默认标 CANDIDATE，不强行判 PRE/POST（保持不确定性，支持人工覆盖）
  //     UNKNOWN = 无 raw/MIDI 证据也无明确 XML 语义（孤立倚音）
  //     null    = 非倚音
  //   graceTimePolicy：落点时间策略（与角色解耦的独立字段）—— 'before' | 'after' | 'bridge' | 'chord' | null
  //   graceMainId：所依附主音的 noteId（BRIDGE 时为 nextMain，时间按主音略偏）
  //   graceOrder：同组（同主音同侧）内的串行序号（复倚音按序；和弦式倚音共享 onset 不串行）
  //   graceCandidate：BRIDGE 默认 true（待人工确认/覆盖）；人工覆盖 PRE/POST 后改 false
  graceRole: 'PRE' | 'POST' | 'BRIDGE' | 'UNKNOWN' | null
  graceTimePolicy: 'before' | 'after' | 'bridge' | 'chord' | null
  graceMainId: string | null
  graceOrder: number
  graceCandidate: boolean
  tieStart: boolean; tieStop: boolean
  step: string | null; oct: number | null; alter: number
  midi: number | null
  type: string | null
  noteId: string // 与 SVG 侧 g.note@id 一一对应（渲染前注入）
  // ── MIDI 对齐结果 ──
  time: number         // 秒（onset，由 MIDI 决定）
  durSec: number       // 秒（时长）
  evIdx: number        // 命中的 MIDI 事件序号（-1 = 无证据）
  tieCont: boolean     // tie 延续：不产生新 onset
  kind: EdgeKind
  why: string
}
interface AutoEdge { from: number; to: number; kind: EdgeKind; why: string }
let heads: XmlHead[] = []
let headMap: (XmlHead | null)[] = [] // noteTargets 索引 → Head
let headAligned = false
// 人工倚音覆盖：仅改角色与时间策略，绝不修改原始 XML/MIDI 证据。BRIDGE→PRE/POST 后取消 CANDIDATE。
const graceOverrides = new Map<string, { role: 'PRE' | 'POST'; policy: 'before' | 'after' }>()

const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
function midiOf(step: string, oct: number, alter: number): number {
  return (oct + 1) * 12 + (STEP_SEMI[step] ?? 0) + alter
}

// MusicXML → Head 列表（文档顺序，含 chord 成员 / 跳过 rest）
function parseXmlHeads(xml: string): XmlHead[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const out: XmlHead[] = []
  const parts = Array.from(doc.getElementsByTagName('part'))
  parts.forEach((part, pi) => {
    let div = 4
    let measureStart = 0
    let curBeat = 4
    let curBeatType = 4
    let staff = 1
    let voice = '1'
    const measures = Array.from(part.getElementsByTagName('measure'))
    measures.forEach((m, mi) => {
      const attrs = m.getElementsByTagName('attributes')[0]
      if (attrs) {
        const d = attrs.getElementsByTagName('divisions')[0]
        if (d?.textContent) { const v = parseInt(d.textContent, 10); if (v > 0) div = v }
        const be = attrs.getElementsByTagName('beats')[0]
        const bt = attrs.getElementsByTagName('beat-type')[0]
        if (be?.textContent && bt?.textContent) { curBeat = parseInt(be.textContent, 10); curBeatType = parseInt(bt.textContent, 10) }
      }
      const barTicks = div * 4 * (curBeat / curBeatType)
      // 每 voice 独立游标 —— 与 shared/midi-xml 的 xmlToMidi 用同一时值模型，
      // 保证 Head 逻辑 tick 与 MIDI tick 严格同序（否则音高/时序证据会错位）
      const voiceX = new Map<string, number>()
      for (const k of Array.from(m.children)) {
        const tag = k.tagName
        if (tag === 'note') {
          const durEl = k.getElementsByTagName('duration')[0]
          const dur = durEl?.textContent ? parseInt(durEl.textContent, 10) : div
          const chord = k.getElementsByTagName('chord').length > 0
          const rest = k.getElementsByTagName('rest').length > 0
          const grace = k.getElementsByTagName('grace').length > 0
          const staffEl = k.getElementsByTagName('staff')[0]
          const voiceEl = k.getElementsByTagName('voice')[0]
          const s = staffEl ? (parseInt(staffEl.textContent ?? '1', 10) || 1) : staff
          const v = voiceEl?.textContent?.trim() || voice
          let tieStart = false, tieStop = false
          for (const t of Array.from(k.getElementsByTagName('tie'))) {
            const ty = t.getAttribute('type')
            if (ty === 'start') tieStart = true
            if (ty === 'stop') tieStop = true
          }
          let step: string | null = null, oct: number | null = null, alter = 0, midi: number | null = null
          const pEl = k.getElementsByTagName('pitch')[0]
          if (pEl) {
            step = pEl.getElementsByTagName('step')[0]?.textContent?.trim() ?? null
            const o = parseInt(pEl.getElementsByTagName('octave')[0]?.textContent ?? '0', 10)
            alter = parseInt(pEl.getElementsByTagName('alter')[0]?.textContent ?? '0', 10)
            oct = Number.isFinite(o) ? o : null
            if (step && oct !== null) midi = midiOf(step, oct, alter)
          }
          const noteId = k.getAttribute('id') ?? ''
          const typeEl = k.getElementsByTagName('type')[0]
          const x = voiceX.get(v) ?? 0
          const pos = measureStart + (chord ? Math.max(0, x - dur) : x) // chord 与同 voice 前一个音同时
          if (!chord) voiceX.set(v, x + dur) // 与 xmlToMidi 一致（它对 grace 也不做特殊处理）
          out.push({
            part: pi, measure: mi + 1, staff: s, voice: v,
            onset: Math.round(pos), dur, div,
            chord, rest, grace, tieStart, tieStop,
            step, oct, alter, midi, type: typeEl?.textContent?.trim() ?? null, noteId,
            graceRole: null, graceTimePolicy: null, graceMainId: null, graceOrder: 0, graceCount: 0, graceCandidate: false,
            time: 0, durSec: 0, evIdx: -1, tieCont: false, kind: 'fallback', why: '',
          })
        }
      }
      measureStart += barTicks
    })
  })
  // ── 倚音拓扑标注（不改 onset，避免 MIDI 对齐错位）──
  // 按 (part,staff,voice) 保持文档序；识别连续 <grace> 段。
  // 角色三层标签：段后紧跟非倚音 且 段前也紧跟非倚音 → BRIDGE（夹心，保持不确定，标 CANDIDATE）；
  // 仅段后紧跟非倚音 → PRE（前倚音）；仅段前紧跟非倚音 → POST（后倚音）；两侧皆无 → UNKNOWN。
  // 段内按文档序给 graceOrder；带 <chord> 的倚音为和弦式（共享 onset，不串行，时间策略='chord'）。
  const lm = new Map<string, number[]>()
  out.forEach((h, i) => { if (h.rest) return; const k = `${h.part}|${h.staff}|${h.voice}`; const a = lm.get(k) ?? []; a.push(i); lm.set(k, a) })
  for (const idxs of lm.values()) {
    let i = 0
    while (i < idxs.length) {
      const cur = out[idxs[i]!]!
      if (!cur.grace) { i++; continue }
      let j = i
      while (j < idxs.length && out[idxs[j]!]!.grace) j++
      const seg = idxs.slice(i, j)
      const nextMain = j < idxs.length ? out[idxs[j]!]! : null
      const prevMain = i > 0 ? out[idxs[i - 1]!]! : null
      // 三层标签：夹心=BRIDGE（保持不确定，标 CANDIDATE）；仅后接=PRE；仅前接=POST；皆无=UNKNOWN
      let role: 'PRE' | 'POST' | 'BRIDGE' | 'UNKNOWN' | null = 'UNKNOWN'
      let candidate = false
      if (nextMain && prevMain) { role = 'BRIDGE'; candidate = true }
      else if (nextMain) role = 'PRE'
      else if (prevMain) role = 'POST'
      const main = role === 'POST' ? prevMain : nextMain // POST 落点依前主音，其余依后主音
      seg.forEach((si, k) => {
        const h = out[si]!
        h.graceRole = role
        h.graceTimePolicy = h.chord ? 'chord' : role === 'PRE' ? 'before' : role === 'POST' ? 'after' : role === 'BRIDGE' ? 'bridge' : null
        h.graceMainId = main ? main.noteId : null
        h.graceOrder = k
        h.graceCount = seg.length
        h.graceCandidate = candidate
      })
      i = j
    }
  }
  // 人工覆盖：仅改角色与时间策略，不触碰原始 XML/MIDI。BRIDGE→PRE/POST 后取消 CANDIDATE。
  for (const h of out) {
    const ov = graceOverrides.get(h.noteId)
    if (ov && h.grace) {
      h.graceRole = ov.role
      h.graceTimePolicy = ov.policy
      h.graceCandidate = false
    }
  }
  return out
}

// Head ↔ MIDI 事件对齐：全局时序一一对应（两者数量相同且都按时间单调）。
// 音高一致 → strong；时序对齐但音高不一致 → candidate（显式降级，不静默猜错）；
// 事件不足 → fallback（按谱面比例插值）。tie 延续不占独立事件。
function alignHeadsToMidi(hs: XmlHead[], evs: PlayEvent[]): void {
  // 精确匹配：Head 逻辑 tick（onset×480/divisions）↔ MIDI tick，再校验音高。
  // 不依赖双方序列顺序 —— 排序对齐在 unpitched（无 pitch，midi-xml 默认给 60）与
  // 同 tick 多事件时会产生局部错位。
  const byTickMidi = new Map<string, number[]>()
  const byTick = new Map<number, number[]>()
  evs.forEach((e, i) => {
    const k = e.tick + '|' + e.midi
    const a = byTickMidi.get(k) ?? []
    a.push(i)
    byTickMidi.set(k, a)
    const b = byTick.get(e.tick) ?? []
    b.push(i)
    byTick.set(e.tick, b)
  })
  const used = new Set<number>()
  const take = (arr: number[] | undefined): number | null => {
    if (!arr) return null
    for (const i of arr) if (!used.has(i)) { used.add(i); return i }
    return null
  }
  const lastEvByMidi = new Map<number, number>()
  const byNoteId = new Map<string, XmlHead>()
  for (const h of hs) if (h.noteId) byNoteId.set(h.noteId, h)
  for (const h of hs) {
    if (h.rest || h.grace) continue
    const tick = Math.round((h.onset * 480) / (h.div || 4))
    if (h.tieStop) {
      const prevIdx = lastEvByMidi.get(h.midi ?? -1)
      if (prevIdx !== undefined) {
        const ev = evs[prevIdx]!
        h.tieCont = true
        h.time = ev.time
        h.durSec = ev.dur
        h.evIdx = prevIdx
        h.kind = 'strong'
        h.why = 'tie 延续（同音高持续，不重复 onset）'
        continue
      }
    }
    let idx = h.midi !== null ? take(byTickMidi.get(tick + '|' + h.midi)) : null
    let exact = idx !== null
    if (idx === null) idx = take(byTick.get(tick))
    if (idx === null) {
      // 退而求其次：最近 tick 的未用事件
      let best = -1, bestD = Infinity
      for (let i = 0; i < evs.length; i++) {
        if (used.has(i)) continue
        const d = Math.abs(evs[i]!.tick - tick)
        if (d < bestD) { bestD = d; best = i }
      }
      if (best >= 0 && bestD <= 480) { used.add(best); idx = best }
    }
    const rec = idx !== null ? evs[idx]! : null
    if (rec && idx !== null) {
      h.time = rec.time
      h.durSec = rec.dur
      h.evIdx = idx
      // 身份（part/staff/voice）+ 节拍（tick 对齐）两类证据成立即为 strong；
      // 音高不一致多源于 midi-xml 对 unpitched（默认 60）与 chord="yes"（未识别）的处理差异，
      // 属已知转换差异 → 记入 why，不误判为错误连接。
      if (h.midi === null) {
        h.kind = 'strong'
        h.why = `unpitched（打击乐）：tick ${tick} 对齐，MIDI key ${rec.midi}`
      } else if (exact) {
        h.kind = 'strong'
        h.why = `MIDI#${idx} tick+音高一致（midi ${rec.midi} @ ${rec.time.toFixed(2)}s）`
      } else {
        h.kind = 'strong'
        h.why = `tick ${tick} 对齐；音高差异（谱 ${h.midi} vs MIDI ${rec.midi}，转换差异）`
      }
      lastEvByMidi.set(h.midi ?? -1, idx)
    } else {
      h.kind = 'fallback'
      h.why = 'MIDI 事件不足'
    }
  }
  // 倚音：落点 = 所依附主音（共享 MIDI 事件，避免抢事件导致错位）
  for (const h of hs) {
    if (!h.grace || !h.graceMainId) continue
    const m = byNoteId.get(h.graceMainId)
    if (m && m.evIdx >= 0) {
      h.evIdx = m.evIdx
      h.kind = 'strong'
      // 落点时间按独立字段 graceTimePolicy 略偏（与角色解耦）：
      //   before/bridge → 串在主音之前，且组内按 grace_order 递增（g0 最早，不能倒序）；
      //   after         → 串在主音之后，ag0 最早；
      //   chord         → 与主音同时（和弦式倚音共享 onset，不串行）。
      // 仅影响 3D 小球落点顺序，不改变连接拓扑。
      const G = Math.max(1, h.graceCount)
      if (h.graceTimePolicy === 'chord') { h.time = m.time; h.durSec = Math.max(0.08, m.durSec * 0.4) }
      else if (h.graceTimePolicy === 'after') { h.time = m.time + m.durSec + h.graceOrder * 0.02; h.durSec = 0.06 }
      else { h.time = m.time - (G - h.graceOrder) * 0.02; h.durSec = 0.06 } // 'before' / 'bridge' / null 兜底
      h.why = '倚音：落点按拓扑略偏主音，连接独立'
    } else {
      h.time = h.onset
      h.durSec = 0.1
      h.kind = 'fallback'
      h.why = '倚音：无主音 MIDI 证据'
    }
  }
  const miss = hs.filter((h) => !h.rest && !h.grace && h.evIdx < 0)
  if (miss.length) {
    const maxOnset = Math.max(1, ...hs.map((h) => h.onset + h.dur))
    for (const h of miss) {
      h.time = (h.onset / maxOnset) * duration
      h.durSec = Math.max(0.08, (h.dur / maxOnset) * duration)
      h.why += ' → 按谱面比例插值'
    }
  }
}

// 自动生成连线：按 (part, staff, voice) 分链；每个同刻组 = 一个"主音簇"（该 onset 的主音 + 其前/后倚音）。
// 簇内：前倚音串行→主音、后倚音主音→串行、和弦式倚音分别扇入主音；簇间首尾相接。跨声部不连。
function buildAutoEdges(hs: (XmlHead | null)[]): AutoEdge[] {
  const edges: AutoEdge[] = []
  const lanes = new Map<string, number[]>()
  hs.forEach((h, i) => {
    if (!h || h.tieCont || h.rest) return
    const key = `${h.part}|${h.staff}|${h.voice}`
    const a = lanes.get(key) ?? []
    a.push(i)
    lanes.set(key, a)
  })
  const add = (from: number, to: number, kind: EdgeKind, why: string): void => { if (from !== to) edges.push({ from, to, kind, why }) }
  const byTime = (a: number, b: number): number => {
    const ha = hs[a]!, hb = hs[b]!
    return ha.time - hb.time || ha.onset - hb.onset || (ha.midi ?? 0) - (hb.midi ?? 0)
  }
  for (const idxs of lanes.values()) {
    const sorted = [...idxs].sort(byTime)
    // 同刻分组（和弦 / 同 onset 多符头；倚音与主音同 onset → 同簇）
    const groups: number[][] = []
    for (const i of sorted) {
      const h = hs[i]!
      const g = groups[groups.length - 1]
      if (g) {
        const gh = hs[g[0]!]!
        // 同刻分组只看 onset（逻辑 tick）：倚音与主音同 onset → 同簇，由簇内拓扑处理前后顺序
        if (Math.abs(gh.onset - h.onset) < 1e-6) { g.push(i); continue }
      }
      groups.push([i])
    }
    const entryOf = (G: number[]): number => {
      const bw = G.filter((i) => hs[i]!.graceRole === 'PRE' || hs[i]!.graceRole === 'BRIDGE').sort((a, b) => hs[a]!.graceOrder - hs[b]!.graceOrder)
      if (bw.length) return bw[0]!
      const mn = G.filter((i) => !hs[i]!.grace)
      if (mn.length) return mn[0]!
      return G[0]!
    }
    const exitOf = (G: number[]): number => {
      const af = G.filter((i) => hs[i]!.graceRole === 'POST').sort((a, b) => hs[a]!.graceOrder - hs[b]!.graceOrder)
      if (af.length) return af[af.length - 1]!
      const mn = G.filter((i) => !hs[i]!.grace)
      if (mn.length) return mn[0]!
      return G[0]!
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const G = groups[gi]!
      const mains = G.filter((i) => !hs[i]!.grace).sort((a, b) => (hs[a]!.midi ?? 0) - (hs[b]!.midi ?? 0))
      const mainRep = mains.length ? mains[0]! : G.find((i) => !hs[i]!.grace) ?? G[0]!
      const beforeG = G.filter((i) => hs[i]!.graceRole === 'PRE' || hs[i]!.graceRole === 'BRIDGE').sort((a, b) => hs[a]!.graceOrder - hs[b]!.graceOrder)
      const afterG = G.filter((i) => hs[i]!.graceRole === 'POST').sort((a, b) => hs[a]!.graceOrder - hs[b]!.graceOrder)
      const serBefore = beforeG.filter((i) => !hs[i]!.chord)
      const chordBefore = beforeG.filter((i) => hs[i]!.chord)
      const serAfter = afterG.filter((i) => !hs[i]!.chord)
      const chordAfter = afterG.filter((i) => hs[i]!.chord)
      // 和弦：代表主音 → 其余主音（同刻多音都接入轨迹）
      for (let k = 1; k < mains.length; k++) add(mainRep, mains[k]!, 'strong', '和弦：同刻多音')
      // 前倚音 / 夹心倚音：串行 g1→…→gk，末端→主音；和弦式（chord）直接扇入主音（同时，不串行）
      const segRole = serBefore[0]?.graceRole
      const segLabel = segRole === 'BRIDGE' ? '夹心倚音' : '前倚音'
      for (let k = 1; k < serBefore.length; k++) add(serBefore[k - 1]!, serBefore[k]!, 'strong', `${segLabel}串行（grace_order）`)
      const beforeTail = serBefore.length ? serBefore[serBefore.length - 1]! : (chordBefore.length ? chordBefore[0]! : mainRep)
      if (beforeTail !== mainRep) add(beforeTail, mainRep, 'strong', `${segLabel}→主音`)
      for (const g of chordBefore) add(g, mainRep, 'strong', '前倚音（和弦式）扇入主音')
      // 后倚音：主音→ag1→…→agm；和弦式：主音→各 after（同时）。后倚音不自动成为下一音的前倚音（属本簇）
      const afterHead = serAfter.length ? serAfter[0]! : (chordAfter.length ? chordAfter[0]! : mainRep)
      if (afterHead !== mainRep) add(mainRep, afterHead, 'strong', '主音→后倚音')
      for (let k = 1; k < serAfter.length; k++) add(serAfter[k - 1]!, serAfter[k]!, 'strong', '后倚音串行')
      for (const g of chordAfter) add(mainRep, g, 'strong', '后倚音（和弦式）扇入主音')
      // 簇间：本簇出口 → 下一簇入口（首尾相接、连续不中断）
      if (gi < groups.length - 1) add(exitOf(G), entryOf(groups[gi + 1]!), 'strong', '声部连续（主音簇→下一簇）')
    }
  }
  return edges
}

// 只负责取播放真源：MusicXML → MIDI 事件（onset/时长/力度/通道）
async function loadBallEvents(): Promise<PlayEvent[]> {
  const evs: PlayEvent[] = []
  let duration0 = 8
  try {
    const { xmlToMidi } = await import('../shared/midi-xml')
    // ⚠ 必须先 ensureNoteTypes：本谱缺 <type>，midi-xml 靠 type 推断时值，
    //    直接用原 XML 会把顺序音符算成同时发声（时间全 0），小球落点时机全错。
    const bytes = xmlToMidi(ensureNoteTypes(XML))
    const { Midi } = await import('@tonejs/midi')
    const parsed = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    parsed.tracks.filter((t) => t.notes.length > 0).forEach((tr, ti) => {
      for (const n of tr.notes) evs.push({ midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity, channel: ti, tick: n.ticks })
    })
    // ⚠ 不要按 time 排序：xmlToMidi 按 XML 文档序输出，与 parseXmlHeads 的文档序一一对应。
    //    排序会打乱多 part 的交织顺序，导致音高证据错位（跨 part 时时间本就不单调）。
    duration0 = parsed.duration
  } catch {
    duration0 = 8
  }
  duration = duration0
  return evs
}

// 跳跃弧线：peak 由段类型决定（跳音高、保持音低）
function arcPoint(px: number, py: number, tx: number, ty: number, u: number, peak = 0.3, zBase = 0.02): THREE.Vector3 {
  return new THREE.Vector3(px + (tx - px) * u, py + (ty - py) * u, zBase + peak * 4 * (u - u * u))
}

// Head ↔ SVG 符头对齐 + 分链（mark）+ 按 onset 排序（同步重排 noteTargets / noteHeadMeshes / headMap）
function bindHeads(): void {
  if (!noteTargets.length) return
  const xmlHeads = parseXmlHeads(XML)
  const visible = xmlHeads.filter((h) => !h.rest)
  // 锚定：SVG 侧 g.note@id ↔ XML 侧 note id（唯一可靠对应；文档序 ≠ 渲染序，不能按序号对齐）
  const byId = new Map(visible.map((h) => [h.noteId, h]))
  const hit = noteTargets.filter((n) => n.noteId && byId.has(n.noteId)).length
  heads = visible
  if (hit > 0) {
    headAligned = hit === noteTargets.length
    headMap = noteTargets.map((n) => byId.get(n.noteId) ?? null)
  } else {
    // 没有 id 锚点时的兜底：按文档序索引对齐（旧行为，可能错配）
    headAligned = visible.length === noteTargets.length
    heads = headAligned ? visible : []
    headMap = noteTargets.map((_, i) => (headAligned ? visible[i] ?? null : null))
  }
  if (!headAligned) {
    console.warn('[auto] 符头锚定不完整', { svg: noteTargets.length, xml: visible.length, hit }, '→ 未锚定的符头不参与自动连线')
  }
  if (headAligned) {
    alignHeadsToMidi(heads, events)
    // tie 链合并：链首 = 唯一演奏音（时长累加整条链），链中/链尾 = 延续（不产生落点、不做端点）
    const openTie = new Map<string, XmlHead>()
    for (const h of heads) {
      const key = `${h.part}|${h.staff}|${h.voice}|${h.midi}`
      if (h.tieStart && !h.tieStop) openTie.set(key, h)
      else if (h.tieStop) {
        const start = openTie.get(key)
        if (start) {
          start.durSec += h.durSec
          h.time = start.time
          if (!h.tieStart) openTie.delete(key)
        }
      }
    }
  }

  if (headAligned) {
    // mark = (part, staff, voice) 声部链编号：跨声部不串链（左手不跳右手）
    const laneOf = new Map<string, number>()
    noteTargets.forEach((t, i) => {
      const h = headMap[i]!
      t.head = h
      t.time = h.time
      t.dur = h.durSec
      t.midi = h.midi
      t.tieCont = h.tieCont
      t.channel = h.part
      const key = `${h.part}|${h.staff}|${h.voice}`
      let id = laneOf.get(key)
      if (id === undefined) { id = laneOf.size; laneOf.set(key, id) }
      t.mark = id
    })
  } else {
    // 退化：按世界 y 聚类（谱行）分链，时间按 x 序 ↔ 事件序
    const sorted = [...noteTargets].sort((a, b) => a.y - b.y)
    let cur = 0
    const m = new Map<NoteTarget, number>()
    let prev = sorted[0]!.y
    for (const t of sorted) {
      if (t.y - prev > 3.2) cur++
      m.set(t, cur)
      prev = t.y
    }
    const xs = noteTargets.map((n) => n.x)
    const xMin = Math.min(...xs), xMax = Math.max(...xs)
    const order = noteTargets.map((_, i) => i).sort((a, b) => noteTargets[a]!.x - noteTargets[b]!.x)
    order.forEach((i, k) => {
      const t = noteTargets[i]!
      const ev = events[k]
      t.mark = m.get(t)!
      t.time = ev ? ev.time : ((t.x - xMin) / Math.max(1e-6, xMax - xMin)) * duration
      t.dur = ev ? ev.dur : 0.25
      t.midi = ev ? ev.midi : null
      t.tieCont = false
      t.head = null
    })
  }
  // 按 (链, time, y) 同步重排：链内时间单调（球链推进用），跨链独立
  const order2 = noteTargets.map((_, i) => i).sort((a, b) =>
    noteTargets[a]!.mark - noteTargets[b]!.mark || noteTargets[a]!.time - noteTargets[b]!.time || noteTargets[a]!.y - noteTargets[b]!.y)
  const nt2 = order2.map((i) => noteTargets[i]!)
  const nh2 = order2.map((i) => noteHeadMeshes[i]!)
  const hm2 = order2.map((i) => headMap[i] ?? null)
  noteTargets.splice(0, noteTargets.length, ...nt2)
  noteHeadMeshes.splice(0, noteHeadMeshes.length, ...nh2)
  headMap = hm2
}

// ── 从矫正层连线（自动 + 人工）构建球链 ────────────────
// 同刻（和弦/多音）聚合为一个落点；跨声部不串链；tie 延续不产生新落点。
function buildChainsFromEdges(): { mark: number; seq: number[][] }[] {
  const rank = (e: { kind: EdgeKind }): number => (e.kind === 'strong' || e.kind === 'manual' ? 0 : e.kind === 'candidate' ? 1 : 2)
  const marks = new Map<number, number[]>()
  noteTargets.forEach((t, i) => {
    const a = marks.get(t.mark) ?? []
    a.push(i)
    marks.set(t.mark, a)
  })
  const outEdges = new Map<number, { to: number; kind: EdgeKind }[]>()
  const indeg = new Map<number, number>()
  for (const e of corrEdges) {
    const a = outEdges.get(e.from) ?? []
    a.push({ to: e.to, kind: e.kind })
    outEdges.set(e.from, a)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const chains: { mark: number; seq: number[][] }[] = []
  for (const [mk, nodes] of marks) {
    const pool = new Set(nodes)
    const starts = nodes.filter((i) => (indeg.get(i) ?? 0) === 0).sort((a, b) => noteTargets[a]!.time - noteTargets[b]!.time)
    if (!starts.length) starts.push([...nodes].sort((a, b) => noteTargets[a]!.time - noteTargets[b]!.time)[0]!)
    const walk = (from: number): void => {
      if (!pool.has(from)) return
      const seq: number[][] = []
      let cur: number | null = from
      while (cur !== null && pool.has(cur)) {
        const t0 = noteTargets[cur]!
        const group = [...pool].filter((i) => noteTargets[i]!.mark === mk && Math.abs(noteTargets[i]!.time - t0.time) < 1e-6)
        for (const g of group) pool.delete(g)
        seq.push(group)
        const cands: { to: number; kind: EdgeKind }[] = []
        for (const g of group) for (const e of outEdges.get(g) ?? []) cands.push(e)
        cands.sort((a, b) => rank(a) - rank(b))
        const next = cands.find((e) => pool.has(e.to))
        cur = next ? next.to : null
      }
      if (seq.length) chains.push({ mark: mk, seq })
    }
    for (const s of starts) walk(s)
    for (const n of [...pool].sort((a, b) => noteTargets[a]!.time - noteTargets[b]!.time)) walk(n)
  }
  return chains
}

// 落点时序：停留/飞行/弧高按「持续比 r = dur / gap」自洽推导
//   跳音（r 小）→ 停留短、飞行长、跳得高；保持音（r 大）→ 停留长、飞行短、跳得低
function buildStops(seq: number[][]): BallStop[] {
  const stops: BallStop[] = seq.map((group) => {
    const t0 = Math.min(...group.map((i) => noteTargets[i]!.time))
    const dur = Math.max(...group.map((i) => noteTargets[i]!.dur))
    // 落点取"主音"：装饰音（依附主音）与和弦附加音只点亮，不参与落点，
    // 否则球会落在装饰音与主音中间（视觉上没落在任何符头上）
    // tie 延续音与链首同时间，但它不是落点（连音线未结束前球停在链首）
    // 落点取"主音/倚音"：tie 延续不落点；普通和弦附加音（chord 且非倚音）不落点，避免球落在和弦成员中间；
    // 倚音（含和弦式 grace+chord）独立落点 —— 复倚音每个音独立小球，和弦式倚音分别连接主音。
    let base = group.filter((i) => !noteTargets[i]!.tieCont && (!noteTargets[i]!.head?.chord || noteTargets[i]!.head?.grace))
    if (!base.length) base = group
    const prim = base.filter((i) => !noteTargets[i]!.head?.chord)
    if (prim.length) base = prim
    const pos = base.map((i) => ({ x: noteTargets[i]!.x, y: noteTargets[i]!.y }))
    return {
      idxs: group, time: t0, pos,
      cx: pos.reduce((s, p) => s + p.x, 0) / pos.length,
      cy: pos.reduce((s, p) => s + p.y, 0) / pos.length,
      dur, dwell: 0.1, flight: 0.4, peak: 0.25,
    }
  })
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]!
    if (i < stops.length - 1) {
      const n = stops[i + 1]!
      const gap = Math.max(0.05, n.time - s.time)
      const r = Math.min(1, Math.max(0, s.dur / gap)) // 持续比
      const ratio = 0.12 + 0.5 * r                    // 停留占比：跳音 0.12 → 保持音 0.62
      let dwell = Math.min(gap * ratio, Math.max(0.05, s.dur * 0.85))
      dwell = Math.min(dwell, gap * 0.7)              // 上限：始终"落到音符上就走"，不做明显停留
      s.dwell = Math.max(0.03, dwell)
      s.flight = Math.max(0.06, gap - s.dwell)        // 剩余时间都在飞行
      const dist = Math.hypot(n.cx - s.cx, n.cy - s.cy)
      // 弧高：基准随距离缓增并封顶，再按持续比调节 —— 跳音 ×1.8（跳得高）/ 保持音 ×0.7（跳得低）
      const base = Math.min(0.30, 0.05 + dist * 0.02)
      s.peak = Math.min(0.55, base * (0.7 + 1.1 * (1 - r)))
    } else {
      s.dwell = Math.min(0.6, Math.max(0.12, s.dur))
      s.flight = FLIGHT_SEC
      s.peak = 0.22
    }
  }
  return stops
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
  const chains = buildChainsFromEdges()
  let startX = Infinity, endX = -Infinity
  for (const c of chains) {
    for (const g of c.seq) for (const i of g) {
      startX = Math.min(startX, noteTargets[i]!.x)
      endX = Math.max(endX, noteTargets[i]!.x)
    }
  }
  if (!Number.isFinite(startX)) { startX = 0; endX = 1 }
  startX -= BALL_MARGIN
  endX += BALL_MARGIN
  for (const c of chains) {
    const stops = buildStops(c.seq)
    if (!stops.length) continue
    const color = MARK_COLORS[c.mark % MARK_COLORS.length]!
    const startPos = new THREE.Vector3(startX, stops[0]!.cy, 0.02)
    const endPos = new THREE.Vector3(endX, stops[stops.length - 1]!.cy, 0.02)
    // 轨迹线：入场 → 各落点（含停留平段）→ 出场
    const pts: THREE.Vector3[] = [startPos.clone()]
    const SAMP = 12
    for (let s = 1; s <= SAMP; s++) pts.push(arcPoint(startPos.x, startPos.y, stops[0]!.cx, stops[0]!.cy, s / SAMP, stops[0]!.peak))
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!, b = stops[i + 1]!
      pts.push(new THREE.Vector3(a.cx, a.cy, 0.02 + a.peak * 4 * 0.25)) // 起飞抬升
      for (let s = 1; s <= SAMP; s++) pts.push(arcPoint(a.cx, a.cy, b.cx, b.cy, s / SAMP, a.peak))
    }
    const lastS = stops[stops.length - 1]!
    for (let s = 1; s <= SAMP; s++) pts.push(arcPoint(lastS.cx, lastS.cy, endPos.x, endPos.y, s / SAMP, lastS.peak))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }),
    )
    ballRoot.add(line)
    const poolSize = Math.max(1, ...stops.map((s) => s.pos.length))
    const balls: THREE.Mesh[] = []
    for (let k = 0; k < poolSize; k++) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 16, 12), new THREE.MeshBasicMaterial({ color }))
      ball.visible = false
      ballRoot.add(ball)
      balls.push(ball)
    }
    ballTracks.push({ mark: c.mark, stops, line, balls, startPos, endPos, color })
  }
  renderMkToggles()
}

// 时间 → 球位置：onset 由 MIDI 决定；落点停留 dwell 后立即起飞（跳音更短更高）
function updateBalls(t: number): void {
  for (const bt of ballTracks) {
    for (const b of bt.balls) b.visible = false
    const stops = bt.stops
    if (!stops.length) continue
    const t0 = stops[0]!.time
    const enterDur = Math.min(0.6, Math.max(0.15, t0))
    const place = (k: number, x: number, y: number, z = 0.02): void => {
      const ball = bt.balls[k] ?? bt.balls[0]
      if (!ball) return
      ball.visible = true
      ball.position.set(x, y, z)
    }
    if (t < t0) {
      const u = t <= t0 - enterDur ? 0 : (t - (t0 - enterDur)) / enterDur
      stops[0]!.pos.forEach((p, k) => {
        const q = arcPoint(bt.startPos.x, bt.startPos.y, p.x, p.y, u, stops[0]!.peak)
        place(k, q.x, q.y, q.z)
      })
      continue
    }
    // 定位当前落点
    let i = 0
    for (let k = 0; k < stops.length; k++) if (stops[k]!.time <= t) i = k
    const s = stops[i]!
    const depart = s.time + s.dwell
    if (t < depart) {
      s.pos.forEach((p, k) => place(k, p.x, p.y))
      continue
    }
    if (i < stops.length - 1) {
      const n = stops[i + 1]!
      const u = Math.min(1, Math.max(0, (t - depart) / s.flight))
      s.pos.forEach((p, k) => {
        const tgt = n.pos[k] ?? n.pos[0]!
        const q = arcPoint(p.x, p.y, tgt.x, tgt.y, u, s.peak)
        place(k, q.x, q.y, q.z)
      })
      continue
    }
    // 末落点 → 出场
    const u = Math.min(1, Math.max(0, (t - depart) / s.flight))
    s.pos.forEach((p, k) => {
      const q = arcPoint(p.x, p.y, bt.endPos.x, bt.endPos.y, u, s.peak)
      place(k, q.x, q.y, q.z)
    })
  }
}

// 点亮：进度前变轨色（按 mark），回退变黑
let litCount = 0
// 点亮：已到达 onset 的符头着链色，未到达为黑（不依赖全局 time 单调，逐帧按进度比较）
function setLitProgress(t: number): void {
  let k = 0
  for (let i = 0; i < noteTargets.length; i++) {
    const nt = noteTargets[i]!
    const on = nt.time <= t
    if (on) k++
    const color = on ? MARK_COLORS[nt.mark % MARK_COLORS.length]! : 0x000000
    const mat = noteHeadMeshes[i]!.mesh.material as THREE.MeshBasicMaterial
    if (mat.color.getHex() !== color) mat.color.setHex(color)
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
  events = await loadBallEvents()
  bindHeads()        // MusicXML Head ↔ SVG 符头 + MIDI 对齐 + 分链
  buildCorrLayer()   // 自动生成连线（并挂上人工矫正层）
  if (has3D()) { initBalls(); updateBalls(0) } // 2D 独立页跳过 3D 几何
  timeBar.max = '1000'
  timeVal.textContent = '0.00s'
  litCount = 0
  const kinds: Record<EdgeKind, number> = { strong: 0, candidate: 0, fallback: 0, manual: 0 }
  for (const e of corrEdges) kinds[e.kind]++
  Object.assign((window as unknown as Record<string, unknown>).__t3d ?? {}, {
    noteTargets,
    ballTracks,
    ballEvents: events,
    ballDuration: duration,
    heads,
    headAligned,
    edgeKinds: kinds,
    ballEdges: corrEdges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, why: e.why })),
    ballStates: ballTracks.map((bt) => ({
      mark: bt.mark,
      stops: bt.stops.map((s) => ({ t: +s.time.toFixed(3), n: s.pos.length, dwell: +s.dwell.toFixed(3), flight: +s.flight.toFixed(3), peak: +s.peak.toFixed(3) })),
    })),
    // 调试/验证用：重建连线；或人为制造一处断链以演示"断掉的那根线变红"
    rebuild: () => { buildCorrLayer(); syncBalls() },
    // 人工指定倚音角色（仅改角色与时间策略，不修改原始 XML/MIDI）；BRIDGE→PRE/POST 后取消 CANDIDATE
    setGraceRole: (noteId: string, role: 'PRE' | 'POST') => {
      graceOverrides.set(noteId, { role, policy: role === 'PRE' ? 'before' : 'after' })
      bindHeads(); buildCorrLayer(); syncBalls()
      return graceOverrides.get(noteId)
    },
    graceOverrides,
    // 人工基准（getter + 操作），供脚本化批量修正 / 校验
    getManual: () => manualEdits,
    addManual: (a: number, b: number) => { addManualPair(a, b); buildCorrLayer(); syncBalls() },
    removeManual: (a: number, b: number) => { removeManualPair(a, b); buildCorrLayer(); syncBalls() },
    clearManual: () => { manualEdits = { added: [], removed: [] }; manualMode = false; saveManualEdits(); buildCorrLayer(); syncBalls() },
    clearAllAuto: () => { clearAllAuto(); buildCorrLayer(); syncBalls() },
    restoreAllAuto: () => { restoreAllAuto(); buildCorrLayer(); syncBalls() },
    isManualMode: () => manualMode,
    setViewMode: (m: ViewMode) => { viewMode = m; refreshCorr() },
    scoreName: () => SCORE_NAME,
    // 端点/边实时读取（getter，避免 rebuild 后引用失效）
    nodeTis: () => corrNodes.map((n) => n.ti),
    corrEdgeList: () => corrEdges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, why: e.why, cross: e.cross })),
    selectedEdgeId: () => selectedEdgeId,
    headsNow: () => heads,
    testDangling: () => {
      const e = corrEdges.find((x) => x.kind === 'strong')
      if (!e) return 0
      for (const x of [...corrEdges]) if (x.from === e.from || x.to === e.to) x.line.remove()
      corrEdges = corrEdges.filter((x) => x.from !== e.from && x.to !== e.to)
      const before = corrEdges.length
      patchDangling()
      return corrEdges.length - before
    },
  })
  const statEl = document.getElementById('stats') as HTMLElement
  statEl.textContent =
    `${noteTargets.length} 符头 · ${corrEdges.length} 边（strong ${kinds.strong} / candidate ${kinds.candidate} / fallback ${kinds.fallback}）` +
    ` · ${ballTracks.length} 球链 · ${duration.toFixed(1)}s` +
    (headAligned ? '' : ' · ⚠ 谱面对齐失败（已退化）')
}

// ===== 2D 矫正层：自动连线（strong / candidate / fallback）+ 人工微调（拖动·分支·删除 → manual） =====
const SVG_NS = 'http://www.w3.org/2000/svg'
// 尺寸常量单位 = 主 svg 用户坐标（1 单位 ≈ 0.11px：谱线 ≈2.4px，符头 ≈20px）
const EDGE_W = 46 // 连线宽 ≈5px（约为谱线 2 倍：显眼又不糊住谱面）
const EDGE_W_SEL = 66 // 选中边加粗
const SNAP_DIST = 150 // 吸附 / 删除判定半径 ≈16px
const SMALL_R = 34 // 端点实心圆半径 ≈3.8px（约为符头 1/3，清晰可见）
const SMALL_STROKE = 10 // 实心圆白描边（黑符头上一眼可见）
let NODE_R = 70 // 选中端点：空心大圆半径 ≈7.7px
const NODE_STROKE = 16 // 空心圆线宽 ≈1.8px（原来 4 → 0.4px 太细）
const KIND_COLOR: Record<EdgeKind, string> = {
  strong: '#22c55e',    // 绿：唯一后继 + MIDI 证据
  candidate: '#38bdf8', // 天蓝：同刻扇出，存在竞争候选
  fallback: '#ff9f43',  // 橙：缺 MIDI 证据，按谱面顺序推断
  manual: '#4da3ff',    // 蓝：人工确认/改动
  dangling: '#ff2222',  // 红：断链 —— 该处未首尾相接
}
const DRAG_COLOR = '#ff2d55' // 拖动中/非法目标的临时色
const SELECT_COLOR = '#ffd166' // 选中连线 / 拖拽新建的黄色反馈
const HEAD_ON = '#2266ff'       // 符头：首尾都有连线（连通）
const HEAD_DANGLING = '#ff9f43' // 符头：只有单边（断链 / 链尾——这里断开了，需要确认）
const HEAD_OFF = '#ff2222'      // 符头：孤立（完全没有连线）
const CROSS_LEAD = 150       // 跨行边的引线长度（≈16px）：只画两端"续接"短线，不横跨整页
let selectedEdgeId: number | null = null // 当前选中的线（只有它两端是空心大圆、可拖动；一次一根）
let edgeSeq = 0
let corrKeyBound = false // 键盘监听只绑一次
let corrLayerG: SVGGElement | null = null // 当前 2D 矫正层 group（mkEdge 写入用）

// ══════════ 人工连线基准（持久化，作为"标准"）══════════
// 以 noteTargets 索引记录：added=人工新增的边；removed=人工删掉的自动边。
// 每次重建（buildCorrLayer）都会重放这份基准，因此刷新页面不会丢失手工结果。
interface ManualEdits { added: [number, number][]; removed: [number, number][] }
let manualEdits: ManualEdits = { added: [], removed: [] }
let SCORE_NAME = 'sample'
const pairEq = (a: number, b: number, x: number, y: number): boolean => (a === x && b === y) || (a === y && b === x)
const storeKey = (): string => `t3d.manual.${SCORE_NAME}`
function loadManualEdits(): void {
  try {
    const raw = localStorage.getItem(storeKey())
    if (!raw) { manualEdits = { added: [], removed: [] }; return }
    const o = JSON.parse(raw)
    const clean = (v: unknown): [number, number][] =>
      Array.isArray(v) ? (v.filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isInteger(n))) as [number, number][]) : []
    manualEdits = { added: clean(o?.added), removed: clean(o?.removed) }
  } catch { manualEdits = { added: [], removed: [] } }
}
function saveManualEdits(): void {
  try { localStorage.setItem(storeKey(), JSON.stringify(manualEdits)) } catch { /* 隐私模式等忽略 */ }
}
function addManualPair(a: number, b: number): void {
  if (a === b) return
  if (!manualEdits.added.some(([x, y]) => pairEq(a, b, x, y))) manualEdits.added.push([a, b])
  manualEdits.removed = manualEdits.removed.filter(([x, y]) => !pairEq(a, b, x, y)) // 人工补回即撤销删除
  saveManualEdits()
}
function removeManualPair(a: number, b: number): void {
  manualEdits.added = manualEdits.added.filter(([x, y]) => !pairEq(a, b, x, y))
  if (!manualEdits.removed.some(([x, y]) => pairEq(a, b, x, y))) manualEdits.removed.push([a, b])
  saveManualEdits()
}
// 纯手工模式：清空全部自动连线，谱面留白，由用户从零连。
// 进入该模式后不再补"断链兜底红边"，否则整谱会到处是红噪声。
let manualMode = false
function clearAllAuto(): void {
  for (const e of corrEdges) {
    if (e.kind === 'manual') continue
    if (!manualEdits.removed.some(([a, b]) => pairEq(e.from, e.to, a, b))) manualEdits.removed.push([e.from, e.to])
  }
  manualMode = true
  saveManualEdits()
}
function restoreAllAuto(): void { manualEdits.removed = []; manualMode = false; saveManualEdits() }
// 视图模式：全部 / 只看人工 / 只看自动（仅影响 2D 显示，3D 轨迹仍用完整连线）
type ViewMode = 'all' | 'manual' | 'auto'
let viewMode: ViewMode = 'all'
interface CorrEdge { id: number; from: number; to: number; line: SVGElement; mark: number; kind: EdgeKind; why: string; cross: boolean }
interface CorrNode { ti: number; circ: SVGCircleElement; hit: SVGCircleElement; headEl: SVGUseElement | null }

// 创建一条连线（自动 / 人工 / 断链兜底共用）
function mkEdge(from: number, to: number, kind: EdgeKind, why: string): void {
  if (!corrLayerG) return
  const a = noteTargets[from]!, b = noteTargets[to]!
  const eid = edgeSeq++
  const cross = isCrossJump(a, b)
  const line = document.createElementNS(SVG_NS, cross ? 'path' : 'line')
  line.setAttribute('stroke-width', String(EDGE_W))
  line.setAttribute('stroke-linecap', 'round')
  line.setAttribute('data-edge', String(eid))
  line.addEventListener('click', (ev) => { ev.stopPropagation(); selectedEdgeId = eid; refreshCorr() })
  corrLayerG.appendChild(line)
  corrEdges.push({ id: eid, from, to, line, mark: a.mark, kind, why, cross })
}

// 断链兜底：每个声部链内，相邻演奏音若未首尾相接（前音无出边 / 后音无入边）→ 补一条红色边。
// 既保证视觉连续（从第一个音到最后一个音不中断），又让真正的断开一眼可见为红色。
function patchDangling(): void {
  if (!corrLayerG) return
  const laneIdx = new Map<string, number[]>()
  noteTargets.forEach((t, i) => {
    // 跳过：tie 延续（合并进 tie 起点）、无头、和弦副符头（与和弦根同时发声）、
    // 和弦式倚音（同时落下、分别扇入主音，本身是叶子：只有出边无入边，不是断链）
    if (t.tieCont || !t.head || t.head.chord) return
    const k = `${t.head.part}|${t.head.staff}|${t.head.voice}`
    const a = laneIdx.get(k) ?? []
    a.push(i)
    laneIdx.set(k, a)
  })
  for (const idxs of laneIdx.values()) {
    const seq = [...idxs].sort((x, y) => noteTargets[x]!.time - noteTargets[y]!.time)
    for (let j = 0; j < seq.length - 1; j++) {
      const a = seq[j]!, b = seq[j + 1]!
      const outA = corrEdges.some((e) => e.from === a)
      const inB = corrEdges.some((e) => e.to === b)
      if (!outA || !inB) mkEdge(a, b, 'dangling', '断链兜底：该处未首尾相接')
    }
  }
}
// 连线操作反馈（成功/失败都给提示，避免"拖了半天不知道成没成"）
let _toastT = 0
function toast(msg: string, kind: 'ok' | 'warn' | 'err' = 'ok'): void {
  let el = document.getElementById('t3dToast') as HTMLDivElement | null
  if (!el) {
    el = document.createElement('div')
    el.id = 't3dToast'
    el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;padding:7px 16px;border-radius:6px;font:13px/1.4 system-ui;color:#fff;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.35);transition:opacity .2s;opacity:0'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.background = kind === 'ok' ? '#16a34a' : kind === 'warn' ? '#d97706' : '#dc2626'
  el.style.opacity = '1'
  clearTimeout(_toastT)
  _toastT = window.setTimeout(() => { if (el) el.style.opacity = '0' }, 1700)
}
let corrEdges: CorrEdge[] = []
let corrNodes: CorrNode[] = []
let corrDrag: { mode: 'move' | 'branch'; node: CorrNode; temp: SVGLineElement | null } | null = null // 预留：拖拽态（当前拖拽用局部 dragNode/tempLine 维护）

function updateNodeVisuals(): void {
  for (const n of corrNodes) {
    const sel = selectedEdgeId !== null && corrEdges.some((e) => e.id === selectedEdgeId && (e.from === n.ti || e.to === n.ti))
    if (sel) {
      n.circ.setAttribute('r', String(NODE_R))
      n.circ.setAttribute('fill', 'none'); n.circ.setAttribute('stroke', '#111'); n.circ.setAttribute('stroke-width', String(NODE_STROKE))
    } else {
      n.circ.setAttribute('r', String(SMALL_R))
      n.circ.setAttribute('fill', '#111'); n.circ.setAttribute('stroke', '#fff'); n.circ.setAttribute('stroke-width', String(SMALL_STROKE))
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

// 颜色 / 线宽按边等级（不再用"有没有后继"猜正确与否）
function refreshCorrColors(): void {
  // 每个声部链内时间最末的符头 = 正常收尾（没有后继是自然的），不算断链
  const laneLast = new Set<number>()
  const byMark = new Map<number, number[]>()
  noteTargets.forEach((n, i) => {
    const a = byMark.get(n.mark) ?? []
    a.push(i)
    byMark.set(n.mark, a)
  })
  for (const arr of byMark.values()) {
    const sorted = [...arr].sort((x, y) => noteTargets[x]!.time - noteTargets[y]!.time)
    laneLast.add(sorted[sorted.length - 1]!)
  }
  // 符头：连通 = 蓝；孤立 = 红；后面还有音却没接出去 = 橙（真断链，需要人工确认）
  for (const n of corrNodes) {
    const t = noteTargets[n.ti]!
    // tie 延续音与链首合并为同一发声音 → 视为连通（不孤立、不橙）
    if (t.tieCont) { if (n.headEl) n.headEl.style.fill = HEAD_ON; continue }
    const inn = corrEdges.some((e) => e.to === n.ti)
    const out = corrEdges.some((e) => e.from === n.ti)
    const color = !inn && !out ? HEAD_OFF : !out && !laneLast.has(n.ti) ? HEAD_DANGLING : HEAD_ON
    if (n.headEl) n.headEl.style.fill = color
  }
  for (const e of corrEdges) {
    const sel = e.id === selectedEdgeId
    // 视图过滤：全部 / 只看人工 / 只看自动（仅 2D 显示）
    const visible = viewMode === 'all' ? true : viewMode === 'manual' ? e.kind === 'manual' : e.kind !== 'manual'
    e.line.setAttribute('display', visible ? 'inline' : 'none')
    e.line.setAttribute('stroke', sel ? SELECT_COLOR : KIND_COLOR[e.kind]) // 选中=黄色反馈
    e.line.setAttribute('stroke-width', String(sel ? EDGE_W_SEL : EDGE_W))
    e.line.setAttribute('opacity', e.kind === 'dangling' ? '1' : e.cross ? '0.45' : e.kind === 'fallback' ? '0.75' : '0.92')
    // 连线一律实线（虚线会让人误以为"断开"）；仅跨行短引线保留虚线
    e.line.setAttribute('stroke-dasharray', e.cross ? '70 50' : 'none')
    e.line.setAttribute('stroke-linecap', 'round')
  }
}

// 端点重合时点击轮换选中：同一符头上的多条边逐条切换（解决两条线重合分不开）
function cycleEdgeAt(ti: number): void {
  const list = corrEdges.filter((e) => e.from === ti || e.to === ti)
  if (!list.length) return
  const cur = list.findIndex((e) => e.id === selectedEdgeId)
  selectedEdgeId = list[(cur + 1) % list.length]!.id
  refreshCorr()
}

// 统一刷新入口：任何增删改后都调用，避免"改了不刷新"
function refreshCorr(): void {
  rebuildCorrLines()
  refreshCorrColors()
  updateNodeVisuals()
}

function deleteNodeEdges(ti: number): void {
  const dead = corrEdges.filter((e) => e.from === ti || e.to === ti)
  for (const e of dead) e.line.remove() // 必须移除 DOM，否则删掉的线还留在图上
  corrEdges = corrEdges.filter((e) => e.from !== ti && e.to !== ti)
  if (selectedEdgeId !== null && dead.some((e) => e.id === selectedEdgeId)) selectedEdgeId = null
  refreshCorr()
}

function rebuildCorrLines(): void {
  for (const e of corrEdges) {
    const at = noteTargets[e.from]!, bt = noteTargets[e.to]!
    if (!at || !bt) continue
    if (e.cross) {
      // a 端向右引线（去下一行）+ b 端向左引线（来自上一行）
      e.line.setAttribute('d', `M${at.svgX},${at.svgY} L${at.svgX + CROSS_LEAD},${at.svgY} M${bt.svgX},${bt.svgY} L${bt.svgX - CROSS_LEAD},${bt.svgY}`)
    } else {
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
  corrLayerG = g
  corrEdges = []; corrNodes = []
  // ── 自动连线：由 (part,staff,voice) 分链 + MIDI 证据生成，带等级 ──
  const legacyEdges = (): AutoEdge[] => {
    const out: AutoEdge[] = []
    const groups = new Map<number, number[]>()
    noteTargets.forEach((t, i) => {
      const a = groups.get(t.mark) ?? []
      a.push(i)
      groups.set(t.mark, a)
    })
    for (const idxs of groups.values()) {
      const sorted = [...idxs].sort((a, b) => noteTargets[a]!.time - noteTargets[b]!.time || noteTargets[a]!.y - noteTargets[b]!.y)
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i]!, b = sorted[i + 1]!
        if (Math.abs(noteTargets[a]!.time - noteTargets[b]!.time) < 1e-6) continue
        out.push({ from: a, to: b, kind: 'fallback', why: '谱面对齐退化：按时间序串联' })
      }
    }
    return out
  }
  const auto = headAligned ? buildAutoEdges(headMap) : legacyEdges()
  // 重放人工基准：剔除被人工删掉的自动边
  for (const e of auto) {
    if (manualEdits.removed.some(([a, b]) => pairEq(e.from, e.to, a, b))) continue
    mkEdge(e.from, e.to, e.kind, e.why)
  }
  // 再补上人工新增的边（允许跨谱表 / 跨声部：钢琴左右手联动只有人工才能表达）
  const N = noteTargets.length
  for (const [a, b] of manualEdits.added) {
    if (a >= 0 && b >= 0 && a < N && b < N && a !== b) mkEdge(a, b, 'manual', '人工基准连线')
  }
  if (!manualMode) patchDangling() // 断链兜底：未首尾相接处补红色边（纯手工模式下不补，避免满屏红噪声）
  // 端点：每个音符一个实心小球（直径=5×线宽+谱线宽，直接拖动）+ 大命中圈
  let staffW = 18
  for (const p of svg.querySelectorAll('path')) {
    const bb = (p as SVGGraphicsElement).getBBox()
    if (bb.width > 50 && bb.height < 1) {
      const w = parseFloat(getComputedStyle(p).strokeWidth) || 0
      if (w > 0) { staffW = w; break }
    }
  }
  const nodeR = Math.max(SMALL_R * 2, (5 * EDGE_W + staffW) / 2)
  NODE_R = nodeR
  const hitR = Math.max(SNAP_DIST, nodeR + 40)
  noteTargets.forEach((t, ti) => {
    if (t.rest) return // 休止符不是演奏音 → 不生成端点；其余（含 tie 延续 / 和弦附加音）都生成端点，保证手动可连
    const circ = document.createElementNS(SVG_NS, 'circle')
    circ.setAttribute('cx', String(t.svgX)); circ.setAttribute('cy', String(t.svgY))
    circ.setAttribute('r', String(SMALL_R))
    circ.setAttribute('fill', '#111'); circ.setAttribute('stroke', '#fff'); circ.setAttribute('stroke-width', String(SMALL_STROKE))
    circ.setAttribute('pointer-events', 'none')
    const hit = document.createElementNS(SVG_NS, 'circle')
    hit.setAttribute('cx', String(t.svgX)); hit.setAttribute('cy', String(t.svgY))
    hit.setAttribute('r', String(hitR))
    hit.setAttribute('fill', 'transparent')
    hit.style.cursor = 'grab'
    hit.addEventListener('click', (ev) => { ev.stopPropagation(); cycleEdgeAt(ti) }) // 点端点：轮换选中（重合也能分开）
    g.appendChild(circ); g.appendChild(hit)
    corrNodes.push({ ti, circ, hit, headEl: t.elRef as SVGUseElement | null })
  })
  // 交互：单击端点=选中其连线（黄色反馈）；从端点拖拽=拉黄色虚线新建连线（允许跨谱表/声部）；松手吸附到目标即落点并校验。
  let dragNode: CorrNode | null = null
  let dragMoved = false
  let tempLine: SVGLineElement | null = null
  let dragStart = { x: 0, y: 0 }
  // 吸附判定：半径用"屏幕像素"定义再换算成 SVG 用户单位。
  // 之前写死 SNAP_DIST=150 用户单位，适应宽度缩小后屏幕上只剩几像素 → 明明拖到正确位置却吸不上。
  const SNAP_PX = 30        // 正常吸附半径（屏幕像素）
  const SNAP_PX_FAR = 110   // 兜底半径：附近有端点就吸，避免差几像素失败
  const CROSS_PEN_PX = 10   // 跨谱表/声部只轻微加罚 → 手动跨谱表照样好连
  const userPerPx = (): number => {
    const svg = document.querySelector('#svgRef svg') as SVGSVGElement | null
    const a = svg?.getScreenCTM() ? Math.abs(svg.getScreenCTM()!.a) : 1
    return a > 1e-6 ? 1 / a : 1
  }
  // 最近端点（跨谱表/声部仅轻微加分，手动允许跨链连接）
  const snapTarget = (px: number, py: number, fromTi: number): { ti: number; x: number; y: number; weak: boolean } | null => {
    const upp = userPerPx()
    const pen = CROSS_PEN_PX * upp
    const own = noteTargets[fromTi]!
    let best = Infinity, bestTi = -1
    for (const n of corrNodes) {
      if (n.ti === fromTi) continue
      const t2 = noteTargets[n.ti]!
      const d = Math.hypot(t2.svgX - px, t2.svgY - py) + (t2.mark === own.mark ? 0 : pen)
      if (d < best) { best = d; bestTi = n.ti }
    }
    if (bestTi < 0 || best > SNAP_PX_FAR * upp) return null
    const s = noteTargets[bestTi]!
    return { ti: bestTi, x: s.svgX, y: s.svgY, weak: best > SNAP_PX * upp }
  }
  // 手动连线的类型校验：禁止自连 / 重复连线（同类型首尾相接——人工手动边统一为 'manual'，不与自动强边冲突）
  const validateManualEdge = (a: number, b: number): { ok: boolean; reason: string } => {
    if (a === b) return { ok: false, reason: '不能自连' }
    if (corrEdges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))) return { ok: false, reason: '连线已存在' }
    return { ok: true, reason: '' }
  }
  const onDown = (ev: PointerEvent, node: CorrNode): void => {
    ev.preventDefault(); ev.stopPropagation()
    dragNode = node; dragMoved = false
    dragStart = { x: ev.clientX, y: ev.clientY }
  }
  const onMove = (ev: PointerEvent): void => {
    if (!dragNode) return
    if (!dragMoved && Math.hypot(ev.clientX - dragStart.x, ev.clientY - dragStart.y) < 4) return // 阈值内视为点击
    dragMoved = true
    if (!tempLine) {
      const g2 = document.querySelector('#corrLayer') as SVGGElement
      tempLine = document.createElementNS(SVG_NS, 'line')
      tempLine.setAttribute('stroke', SELECT_COLOR); tempLine.setAttribute('stroke-width', String(EDGE_W))
      tempLine.setAttribute('stroke-dasharray', '14,10'); tempLine.setAttribute('opacity', '0.9')
      g2.appendChild(tempLine)
    }
    const t = noteTargets[dragNode.ti]!
    const p = svgPoint(ev)
    const snap = snapTarget(p.x, p.y, dragNode.ti)
    const bx = snap ? snap.x : p.x, by = snap ? snap.y : p.y
    tempLine.setAttribute('x1', String(t.svgX)); tempLine.setAttribute('y1', String(t.svgY))
    tempLine.setAttribute('x2', String(bx)); tempLine.setAttribute('y2', String(by))
    const v = snap ? validateManualEdge(dragNode.ti, snap.ti) : { ok: true, reason: '' }
    tempLine.setAttribute('stroke', v.ok ? SELECT_COLOR : DRAG_COLOR) // 非法目标临时变红
    // 高亮当前吸中的端点，方便确认"吸对了没有"
    if (snap) {
      for (const n of corrNodes) n.circ.setAttribute('stroke', n.ti === snap.ti ? '#ff2d55' : '#fff')
      if (snap.weak) tempLine.setAttribute('opacity', '0.65')
    }
  }
  const onUp = (ev: PointerEvent): void => {
    if (!dragNode) return
    const node = dragNode; dragNode = null
    if (tempLine) { tempLine.remove(); tempLine = null }
    if (!dragMoved) { cycleEdgeAt(node.ti); return } // 仅点击：选中该端点上的连线（黄色反馈）
    const p = svgPoint(ev)
    const snap = snapTarget(p.x, p.y, node.ti)
    if (!snap) { toast('没吸到端点：请把线拖到某个圆点上（靠近会变黄）', 'warn'); refreshCorr(); return }
    const v = validateManualEdge(node.ti, snap.ti)
    if (!v.ok) { toast(v.reason, 'err'); refreshCorr(); return }
    addManualPair(node.ti, snap.ti) // 记入人工基准（持久化）
    mkEdge(node.ti, snap.ti, 'manual', '人工连线（跨谱表/声部允许）') // 手动允许跨 staff/voice
    toast('已连接', 'ok')
    refreshCorr(); syncBalls()
  }
  for (const n of corrNodes) n.hit.addEventListener('pointerdown', (ev) => onDown(ev, n))
  // 点击空白（非线/非端点）取消选中
  svg.addEventListener('click', (ev) => {
    const t = ev.target as Element
    if (t.closest?.('line, path, circle')) return
    if (selectedEdgeId !== null) { selectedEdgeId = null; refreshCorr() }
  })
  document.removeEventListener('pointermove', onMove)
  document.removeEventListener('pointerup', onUp)
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
  // 键盘：Delete/Backspace 删除选中边；Esc 取消选中（只绑一次）
  if (!corrKeyBound) {
    corrKeyBound = true
    document.addEventListener('keydown', (ev) => {
      if (selectedEdgeId === null) return
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const e = corrEdges.find((x) => x.id === selectedEdgeId)
        if (e) deleteEdge(e)
      } else if (ev.key === 'Escape') {
        selectedEdgeId = null
        refreshCorr()
      }
    })
  }
  refreshCorr()
}

// 跨行 / 远距离连接判定：这类边在 2D 上只画两端短引线（音乐上仍相连，球轨迹连续），
// 否则长直线会横穿整页，看起来像连到别的谱表 / 声部
function isCrossJump(a: NoteTarget, b: NoteTarget): boolean {
  const dx = b.svgX - a.svgX
  const dy = b.svgY - a.svgY
  return dx < -50 || Math.abs(dy) > 1200 || Math.hypot(dx, dy) > 3500
}

// 删除一条边（DOM + 数组 + 刷新 + 同步 3D 球链）
function deleteEdge(e: CorrEdge): void {
  removeManualPair(e.from, e.to) // 记入人工基准（持久化）：刷新后不会被自动连线复活
  e.line.remove()
  corrEdges = corrEdges.filter((x) => x.id !== e.id)
  if (selectedEdgeId === e.id) selectedEdgeId = null
  refreshCorr()
  syncBalls()
}

// 人工改动连线后重建 3D 球链（2D 矫正结果 → 3D 轨迹），并保持当前播放进度
function syncBalls(): void {
  if (!has3D()) return // 2D 独立页：无需重建 3D 球链
  initBalls()
  const bar = document.getElementById('timeBar') as HTMLInputElement | null
  updateBalls(((Number(bar?.value ?? '0')) / 1000) * duration)
}

// 人工基准工具栏：清除 / 导出 / 导入 / 视图切换
function initManualTools(): void {
  const cnt = document.getElementById('manualCount')
  const upd = (): void => { if (cnt) cnt.textContent = `人工 ${manualEdits.added.length} · 删除 ${manualEdits.removed.length}` }
  const rebuild = (): void => { buildCorrLayer(); syncBalls(); upd() }
  upd()
  document.getElementById('manualClear')?.addEventListener('click', () => {
    manualEdits = { added: [], removed: [] }; manualMode = false; saveManualEdits(); rebuild(); toast('已清除全部人工改动', 'ok')
  })
  // 纯手工：清空所有自动连线（我自己连）
  document.getElementById('clearAuto')?.addEventListener('click', () => { clearAllAuto(); rebuild(); upd(); toast('已清空自动连线，现在可以自己连了', 'ok') })
  document.getElementById('restoreAuto')?.addEventListener('click', () => { restoreAllAuto(); rebuild(); upd(); toast('已恢复自动连线', 'ok') })
  document.getElementById('manualExport')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ score: SCORE_NAME, ...manualEdits }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `${SCORE_NAME}.baseline.json`; a.click()
    URL.revokeObjectURL(a.href)
  })
  const file = document.getElementById('manualImport') as HTMLInputElement | null
  file?.addEventListener('change', async () => {
    const f = file.files?.[0]
    if (!f) return
    try {
      const o = JSON.parse(await f.text())
      manualEdits = { added: o?.added ?? [], removed: o?.removed ?? [] }
      saveManualEdits(); rebuild(); file.value = ''
    } catch { alert('基准文件解析失败') }
  })
  const sel = document.getElementById('corrView') as HTMLSelectElement | null
  sel?.addEventListener('change', () => { viewMode = (sel.value as ViewMode) || 'all'; refreshCorr() })
  // 适应模式：宽度 / 整页 / 高度
  const fitSel = document.getElementById('fitMode') as HTMLSelectElement | null
  const applyFit = (): void => { _fitMode = (fitSel?.value as 'height' | 'width' | 'page') || 'height'; _zoom = 1; apply2dSize() }
  fitSel?.addEventListener('change', applyFit)
  document.getElementById('fitWidth')?.addEventListener('click', () => { if (fitSel) fitSel.value = 'width'; applyFit() })
  document.getElementById('fitPage')?.addEventListener('click', () => { if (fitSel) fitSel.value = 'page'; applyFit() })
  document.getElementById('fitHeight')?.addEventListener('click', () => { if (fitSel) fitSel.value = 'height'; applyFit() })
  // 2D / 3D 面板切换（2D 优先：隐藏 3D 让谱面占满整窗，端点全部可点）
  const pane = document.getElementById('canvasPane')
  const toggle3d = document.getElementById('toggle3d')
  pane?.addEventListener('transitionend', () => { if (has3D()) resize() })
  toggle3d?.addEventListener('click', () => {
    if (!pane) return
    const on = pane.style.display === 'none'
    pane.style.display = on ? '' : 'none'
    if (toggle3d.textContent) toggle3d.textContent = on ? '隐藏 3D' : '显示 3D'
    if (on) requestAnimationFrame(() => { resize(); syncBalls() })
  })
}

void (async () => {
  if (!(await initVrv())) { (document.getElementById('stats') as HTMLElement).textContent = 'Verovio 初始化失败'; return }
  // 乐谱来源：window.__SCORE_XML > ?xml=xxx.xml > 默认 sample.xml
  const q = new URLSearchParams(location.search)
  const src = String((window as unknown as Record<string, unknown>).__SCORE_XML ?? q.get('xml') ?? 'sample.xml')
  SCORE_NAME = src.replace(/\.xml$/i, '')
  loadManualEdits()
  try { const r = await fetch(new URL(src, import.meta.url).href); if (r.ok) XML = await r.text() } catch { /* 用内嵌兜底 */ }
  // 反复必须展开：小球单向前进，回跳既突兀又会让时序错乱
  const exp = expandRepeats(XML)
  XML = exp.xml
  if (exp.expanded) console.log('[expand]', exp.log)
  XML = tagNoteIds(XML) // 注入 note id（必须在展开之后，保证唯一）→ SVG 侧可精确锚定
  Object.assign((window as unknown as Record<string, unknown>).__t3d ?? {}, { expanded: exp.expanded, expandLog: exp.log, xmlHead: XML.slice(0, 300), xmlLen: XML.length })
  // 初始适应模式（页面可用 #fitMode 指定；2D 独立页默认 width 让整谱可见、端点全部可点）
  const fitSel0 = document.getElementById('fitMode') as HTMLSelectElement | null
  if (fitSel0) _fitMode = (fitSel0.value as 'height' | 'width' | 'page') || 'height'
  resize()
  build()
  void initBallSystem()
  initManualTools()
})()
