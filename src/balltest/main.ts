// ═══════════════════════════════════════════════════════════════
// BallTest · 小球轨迹诊断页
// 目的：最小化复现 3dpreview 的"音符标记 → 轨迹线分组 → 球跳跃"链路，
//       2D 顶部标注每个音符的轨道标记(mk)，3D 里轨迹线/球按 mk 分组上色，
//       表里列出 (mk/ch/time/x/y)，点击任意处三方联动高亮，定位"乱窜"根因。
// ═══════════════════════════════════════════════════════════════
import * as THREE from 'three'
import createVerovioModule from 'verovio/wasm'
import { VerovioToolkit as VrvToolkitClass } from 'verovio/esm'
import { xmlToMidi } from '../shared/midi-xml'
import sampleXml from '../3dtest/sample.xml?raw'

// ── 常量 ──────────────────────────────────────────────────────
const PX_PER_UNIT = 170
const MARK_COLORS = [0x6366f1, 0xef4444, 0x10b981, 0xf59e0b, 0xec4899, 0x06b6d4, 0x8b5cf6, 0x84cc16, 0xf97316, 0x14b8a6]
const FLIGHT_DEF = 0.5
const BALL_R_DEF = 0.06
const ARC_K_DEF = 0.3
let flightSec = FLIGHT_DEF
let ballR = BALL_R_DEF
let arcK = ARC_K_DEF

// ── 音符 / 事件 / 分组结构（同 3dpreview） ────────────────────
interface Note {
  x: number; y: number; id: string | null
  time: number; channel: number; mark: number
  host: Element | null // 2D SVG 里的 note 元素（联动高亮）
}
interface PlayEvent { midi: number; time: number; dur: number; vel: number; channel: number }
interface BallGroup { time: number; idxs: number[] }
interface BallTrack { groups: BallGroup[]; startPos: THREE.Vector3; endPos: THREE.Vector3; arc: THREE.Line | null; pool: THREE.Mesh[]; color: number }

let notes: Note[] = []
let events: PlayEvent[] = []
let ballTracks: BallTrack[] = []
let duration = 10
let trackLength = 12
let scoreH = 2.6

// ── Verovio ───────────────────────────────────────────────────
type VrvToolkit = InstanceType<typeof VrvToolkitClass>
let vtk: VrvToolkit | null = null
async function initVerovio(): Promise<boolean> {
  try {
    const Module = await createVerovioModule()
    const t = new VrvToolkitClass(Module as never)
    vtk = t
    t.setOptions({ pageWidth: 1200, scale: 45, spacingNonLinear: 0.6, breaks: 'none', footer: 'none', header: 'none', font: 'Bravura' })
    return true
  } catch (err) {
    console.error('Verovio 初始化失败', err)
    return false
  }
}

// ── 2D 渲染 + 音符解析（简化：getScreenCTM 反解 SVG 坐标） ─────────
let svgHost: HTMLElement | null = null

// ── MusicXML 预处理：Verovio 6.3 必须靠 <type> 推断时值才画符杆/符尾 ──
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
  // divisions 在 measure 级 <attributes> 里（不在 note 子树），用正则从全局取
  const dm = xml.match(/<divisions>(\d+)<\/divisions>/)
  const divisions = dm ? parseInt(dm[1]!, 10) : 4
  if (!divisions) return xml
  return xml.replace(/<note>([\s\S]*?)(?=<\/note>)/g, (m, inner: string) => {
    if (/<type>/.test(inner)) return m
    const dm2 = inner.match(/<duration>(\d+)<\/duration>/)
    if (!dm2) return m
    const beats = parseInt(dm2[1]!, 10) / divisions
    const type = durToType(beats)
    return m.replace(/<duration>\d+<\/duration>/, `$&<type>${type}</type>`)
  })
}

/** 画布宽高：优先 viewBox，退化用 width/height，最后 getBBox */
function svgCanvasSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.viewBox.baseVal
  let w = vb.width || 0
  let h = vb.height || 0
  if (!w || !h) {
    const bb = svg.getBBox()
    w = bb.width || w
    h = bb.height || h
  }
  return { w, h }
}

/** notehead 元素中心 → SVG 根坐标（累积所有祖先 transform） */
function noteSvgPos(svg: SVGSVGElement, nh: SVGGraphicsElement): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const r = nh.getBoundingClientRect()
  if (!r.width && !r.height) return null
  const p = new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

function renderSvg2D(xml: string): void {
  const top = document.getElementById('top')!
  top.innerHTML = ''
  const host = document.createElement('div')
  host.innerHTML = vtk!.renderToSVG(1)
  top.appendChild(host)
  svgHost = host
  const svg = host.querySelector('svg') as unknown as SVGSVGElement
  svg.style.height = '180px'
  svg.style.width = 'auto'
  // 标注 mk 数字
  for (const g of host.querySelectorAll('g.note')) {
    const nh = g.querySelector('.notehead') as SVGGraphicsElement | null
    if (!nh) continue
    const staffEl = g.closest('g.staff')
    const staffIdx = staffEl ? Array.from(staffEl.parentElement!.children).indexOf(staffEl) : 0
    const pos = noteSvgPos(svg, nh)
    if (!pos) continue
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    txt.setAttribute('x', String(pos.x + 14))
    txt.setAttribute('y', String(pos.y - 10))
    txt.setAttribute('font-size', '11')
    txt.setAttribute('font-family', 'monospace')
    txt.setAttribute('fill', '#' + MARK_COLORS[staffIdx % MARK_COLORS.length]!.toString(16).padStart(6, '0'))
    txt.textContent = 'mk' + staffIdx
    txt.setAttribute('data-note', g.getAttribute('id') ?? '')
    svg.appendChild(txt)
  }
  parseNotesFromSvg()
}

function parseNotesFromSvg(): void {
  if (!svgHost) return
  const svg = svgHost.querySelector('svg') as unknown as SVGSVGElement
  const { w: W, h: H } = svgCanvasSize(svg)
  notes = []
  for (const g of svgHost.querySelectorAll('g.note')) {
    const nh = g.querySelector('.notehead') as SVGGraphicsElement | null
    if (!nh) continue
    const staffEl = g.closest('g.staff')
    const staffIdx = staffEl ? Array.from(staffEl.parentElement!.children).indexOf(staffEl) : 0
    const pos = noteSvgPos(svg, nh)
    if (!pos) continue
    notes.push({
      x: (pos.x - W / 2) / PX_PER_UNIT,
      y: -((pos.y - H / 2)) / PX_PER_UNIT,
      time: 0, channel: 0, mark: staffIdx,
      id: g.getAttribute('id'),
      host: g,
    })
  }
  notes.sort((a, b) => a.x - b.x)
  trackLength = W / PX_PER_UNIT
  scoreH = H / PX_PER_UNIT
  console.log(`[balltest] notes=${notes.length} trackLength=${trackLength.toFixed(2)} scoreH=${scoreH.toFixed(2)}`)
  buildGeometry()
}

// ── 事件加载（sessionStorage MIDI 优先；无 → 内置 sample 的 xmlToMidi） ──
async function loadEventsAsync(): Promise<PlayEvent[]> {
  const b64 = sessionStorage.getItem('midee.midi')
  if (b64) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const { Midi } = await import('@tonejs/midi')
      const parsed = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      const evs: PlayEvent[] = []
      parsed.tracks.filter((t) => t.notes.length > 0).forEach((tr, ti) => {
        for (const n of tr.notes) evs.push({ midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity, channel: ti })
      })
      evs.sort((a, b) => a.time - b.time)
      duration = parsed.duration
      return evs
    } catch { /* fallthrough */ }
  }
  const xml = sessionStorage.getItem('midee.xml')
  const xmlStr = xml ?? sampleXml
  const evs = extractXmlEvents(xmlStr)
  // 若无 MIDI：用 xmlToMidi 生成再解析（保证事件与播放一致）
  try {
    const bytes = xmlToMidi(xmlStr)
    const { Midi } = await import('@tonejs/midi')
    const parsed = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    const evs2: PlayEvent[] = []
    parsed.tracks.filter((t) => t.notes.length > 0).forEach((tr, ti) => {
      for (const n of tr.notes) evs2.push({ midi: n.midi, time: n.time, dur: n.duration, vel: n.velocity, channel: ti })
    })
    evs2.sort((a, b) => a.time - b.time)
    duration = parsed.duration
    return evs2.length ? evs2 : evs
  } catch {
    duration = evs.length ? Math.max(...evs.map((e) => e.time + e.dur)) : 10
    return evs
  }
}

function extractXmlEvents(xmlStr: string): PlayEvent[] {
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml')
  const out: PlayEvent[] = []
  if (doc.querySelector('score-partwise, score-timewise')) {
    const notesEl = doc.getElementsByTagName('note')
    const divisions = parseFloat(doc.querySelector('divisions')?.textContent ?? '1') || 1
    let t = 0
    for (let i = 0; i < notesEl.length; i++) {
      const n = notesEl[i]!
      const d = parseFloat(n.querySelector('duration')?.textContent ?? '0') || 0
      if (n.querySelector('grace')) continue
      const p = n.querySelector('pitch')
      if (!p) { t += d / divisions; continue }
      const step = p.querySelector('step')?.textContent ?? 'C'
      const alter = parseFloat(p.querySelector('alter')?.textContent ?? '0') || 0
      const octave = parseInt(p.querySelector('octave')?.textContent ?? '4')
      out.push({ midi: midiFromStep(step, alter, octave), time: t, dur: d / divisions, vel: 90, channel: 0 })
      t += d / divisions
    }
  }
  return out
}
function midiFromStep(step: string, alter: number, octave: number): number {
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  return (octave + 1) * 12 + (base[step] ?? 0) + alter
}

// ── 时间绑定（同 3dpreview：tie 合并 + 同刻桶内音高序 + mark 统一 channel） ──
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

function bindTargets(): void {
  const evs = mergeTieEvents(events)
  const fallbackDur = duration > 0 ? duration : trackLength / 1.5
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!
    const ev = evs[i]
    n.time = ev ? ev.time : (n.x / Math.max(1e-6, trackLength)) * fallbackDur
  }
  notes.sort((a, b) => a.time - b.time || a.y - b.y)
  const eps = 0.005
  const tgByTime = new Map<number, Note[]>()
  for (const n of notes) {
    const key = Math.round(n.time / eps)
    const a = tgByTime.get(key) ?? []
    a.push(n)
    tgByTime.set(key, a)
  }
  const evByTime = new Map<number, PlayEvent[]>()
  for (const e of evs) {
    const key = Math.round(e.time / eps)
    const a = evByTime.get(key) ?? []
    a.push(e)
    evByTime.set(key, a)
  }
  for (const [key, tgList] of tgByTime) {
    const evList = evByTime.get(key)
    if (!evList) continue
    evList.sort((a, b) => (a.midi ?? 0) - (b.midi ?? 0))
    for (let k = 0; k < Math.min(tgList.length, evList.length); k++) {
      tgList[k]!.channel = evList[k]!.channel ?? 0
    }
  }
  // mark 统一 channel
  const markCh = new Map<number, number>()
  for (const n of notes) {
    const m = n.mark >= 0 ? n.mark : 0
    if (!markCh.has(m)) markCh.set(m, n.channel)
  }
  for (const n of notes) n.channel = markCh.get(n.mark >= 0 ? n.mark : 0) ?? 0
}

// ── 3D ────────────────────────────────────────────────────────
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xf5f5f7)
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200)
camera.position.set(0, 1.5, 4)
camera.lookAt(0, 0, 0)
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('stage') as HTMLCanvasElement, antialias: true })
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))

// 相机轨道（同 3dpreview）：焦点 x 跟随时间/球；AD 水平旋、WS 竖直旋、滚轮调 r
let focusX = 0
let r = 4
let txy = 0
let tyz = 55
let minR = 0.6 * 2.6
let maxR = 8 * 2.6
function applyCam(): void {
  const radX = (txy * Math.PI) / 180
  const radZ = (tyz * Math.PI) / 180
  camera.position.set(focusX + r * Math.cos(radZ) * Math.sin(radX), r * Math.sin(radZ), r * Math.cos(radZ) * Math.cos(radX))
  camera.lookAt(focusX, 0, 0)
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'a') txy -= 3
  if (e.key === 'd') txy += 3
  if (e.key === 'w') tyz = Math.min(80, tyz + 3)
  if (e.key === 's') tyz = Math.max(-80, tyz - 3)
  applyCam()
})
window.addEventListener('wheel', (e) => {
  r = Math.max(minR, Math.min(maxR, r * (e.deltaY > 0 ? 1.08 : 0.92)))
  applyCam()
}, { passive: true })

// 谱面纹理平面
function buildPlane(): void {
  if (!svgHost) return
  const svg = svgHost.querySelector('svg') as unknown as SVGSVGElement
  const { w, h } = svgCanvasSize(svg)
  const data = new XMLSerializer().serializeToString(svg)
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const pw = w / PX_PER_UNIT
    const ph = h / PX_PER_UNIT
    const geo = new THREE.PlaneGeometry(pw, ph)
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
    scene.add(mesh)
  }
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data)
}

// 音符方块（点亮诊断：进度前变轨色，未到保持黑）
const noteBoxes: THREE.Mesh[] = []
function buildNoteBoxes(): void {
  for (const m of noteBoxes) scene.remove(m)
  noteBoxes.length = 0
  for (const n of notes) {
    const g = new THREE.BoxGeometry(0.05, 0.05, 0.05)
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x000000 }))
    m.position.set(n.x, n.y, 0.06)
    scene.add(m)
    noteBoxes.push(m)
  }
}

// 轨迹线 + 球（按 mark 分组，复制 3dpreview 逻辑）
function arcPoint(px: number, py: number, tx: number, ty: number, u: number, zBase = 0.02): THREE.Vector3 {
  const dist = Math.hypot(tx - px, ty - py)
  const peak = Math.min(0.7, 0.08 + dist * arcK)
  return new THREE.Vector3(px + (tx - px) * u, py + (ty - py) * u, zBase + peak * 4 * (u - u * u))
}
function groupRep(g: BallGroup): { x: number; y: number } {
  if (g.idxs.length) { const t = notes[g.idxs[0]!]!; return { x: t.x, y: t.y } }
  return { x: 0, y: 0 }
}

const ballGroup = new THREE.Group()
scene.add(ballGroup)
const BALL_MARGIN = 2.5

function initBalls(): void {
  while (ballGroup.children.length) {
    const m = ballGroup.children[0] as THREE.Mesh
    ballGroup.remove(m)
    m.geometry?.dispose()
    ;(m.material as THREE.Material)?.dispose()
  }
  ballTracks = []
  if (!notes.length) return
  const byMark = new Map<number, number[]>()
  notes.forEach((t, i) => {
    const m = t.mark >= 0 ? t.mark : 0
    const a = byMark.get(m) ?? []
    a.push(i)
    byMark.set(m, a)
  })
  let startX = Infinity
  let endX = -Infinity
  for (const idxsRaw of byMark.values()) {
    idxsRaw.sort((a, b) => notes[a]!.time - notes[b]!.time || notes[a]!.y - notes[b]!.y)
    startX = Math.min(startX, notes[idxsRaw[0]!]!.x)
    endX = Math.max(endX, notes[idxsRaw[idxsRaw.length - 1]!]!.x)
  }
  startX -= BALL_MARGIN
  endX += BALL_MARGIN
  for (const [mark, idxsRaw] of byMark) {
    const groups: BallGroup[] = []
    for (const i of idxsRaw) {
      const ti = notes[i]!
      const last = groups[groups.length - 1]
      if (last && ti.time - last.time < 0.005) {
        if (!last.idxs.some((j) => Math.abs(notes[j]!.y - ti.y) < 0.01)) last.idxs.push(i)
      } else {
        groups.push({ time: ti.time, idxs: [i] })
      }
    }
    if (!groups.length) continue
    const color = MARK_COLORS[mark % MARK_COLORS.length]!
    const first = notes[groups[0]!.idxs[0]!]!
    const lastT = notes[groups[groups.length - 1]!.idxs[0]!]!
    const startPos = new THREE.Vector3(startX, first.y, 0.02)
    const endPos = new THREE.Vector3(endX, lastT.y, 0.02)
    const bt: BallTrack = { groups, startPos, endPos, arc: null, pool: [], color }
    const pts: THREE.Vector3[] = []
    pts.push(new THREE.Vector3(startPos.x, startPos.y, 0.02))
    const segN = 14
    for (let s = 1; s <= segN; s++) pts.push(arcPoint(startPos.x, startPos.y, first.x, first.y, s / segN))
    groups.forEach((g, gi) => {
      const rep = groupRep(g)
      for (let k = 1; k < g.idxs.length; k++) {
        const tgt = notes[g.idxs[k]!]!
        const sn = 8
        for (let s = 1; s <= sn; s++) pts.push(arcPoint(rep.x, rep.y, tgt.x, tgt.y, s / sn))
      }
      if (gi < groups.length - 1) {
        const nrep = groupRep(groups[gi + 1]!)
        for (let s = 1; s <= segN; s++) pts.push(arcPoint(rep.x, rep.y, nrep.x, nrep.y, s / segN))
      }
    })
    for (let s = 1; s <= segN; s++) pts.push(arcPoint(lastT.x, lastT.y, endPos.x, endPos.y, s / segN))
    if (pts.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.65 }))
      ballGroup.add(line)
      bt.arc = line
    }
    const poolSize = Math.max(8, Math.max(...groups.map((g) => g.idxs.length)))
    for (let k = 0; k < poolSize; k++) {
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(ballR, 16, 12),
        new THREE.MeshBasicMaterial({ color }),
      )
      ball.visible = false
      ballGroup.add(ball)
      bt.pool.push(ball)
    }
    ballTracks.push(bt)
  }
}

function updateBalls(t: number): void {
  for (const bt of ballTracks) {
    for (const b of bt.pool) b.visible = false
    const firstG = bt.groups[0]!
    const startT = Math.max(0, firstG.time - flightSec)
    const endT = Math.max(firstG.time, flightSec)
    if (t < endT) {
      const b0 = bt.pool[0]!
      if (t > startT) {
        const u = Math.min(1, Math.max(0, (t - startT) / (endT - startT)))
        const from = bt.startPos
        const targets: { x: number; y: number }[] = firstG.idxs.length
          ? firstG.idxs.map((ti) => { const tt = notes[ti]!; return { x: tt.x, y: tt.y } })
          : [{ x: from.x, y: from.y }]
        targets.forEach((tgt, fi) => {
          const ball = bt.pool[fi] ?? bt.pool[0]!
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
    if (t >= lastG.time + flightSec) {
      const b0 = bt.pool[0]!
      b0.visible = true
      b0.position.copy(bt.endPos)
      continue
    }
    if (t >= lastG.time) {
      const u = Math.min(1, Math.max(0, (t - lastG.time) / flightSec))
      const rep = groupRep(lastG)
      const b0 = bt.pool[0]!
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
    const stay = cur ?? bt.groups[0] ?? null
    if (!stay) continue
    const rep = groupRep(stay)
    if (next && t >= next.time - flightSec && t < next.time) {
      const u = Math.min(1, Math.max(0, (t - (next.time - flightSec)) / flightSec))
      const from = new THREE.Vector3(rep.x, rep.y, 0.02)
      const targets: { x: number; y: number }[] = next.idxs.length
        ? next.idxs.map((ti) => { const tt = notes[ti]!; return { x: tt.x, y: tt.y } })
        : [groupRep(next)]
      targets.forEach((tgt, fi) => {
        const ball = bt.pool[fi] ?? bt.pool[0]!
        ball.visible = true
        ball.position.copy(arcPoint(from.x, from.y, tgt.x, tgt.y, u))
      })
    } else {
      const b0 = bt.pool[0]!
      b0.visible = true
      b0.position.set(rep.x, rep.y, 0.02)
    }
  }
}

// 点亮（进度前变轨色）
let litCount = 0
function setLitProgress(t: number): void {
  let k = 0
  while (k < notes.length && notes[k]!.time <= t) k++
  if (k === litCount) return
  const from = Math.min(k, litCount)
  const to = Math.max(k, litCount)
  for (let i = from; i < to; i++) {
    const on = i < k
    const color = on ? MARK_COLORS[notes[i]!.channel % MARK_COLORS.length]! : 0x000000
    noteBoxes[i]?.material && ((noteBoxes[i]!.material as THREE.MeshBasicMaterial).color.setHex(color))
  }
  litCount = k
}

// 高亮（联动）：点击表行/2D → 3D ring + 2D 描边
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.09, 0.13, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd866, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
)
ring.visible = false
scene.add(ring)
let selIdx = -1
function selectNote(i: number): void {
  selIdx = i
  const n = notes[i]
  if (!n) { ring.visible = false; return }
  ring.visible = true
  ring.position.set(n.x, n.y, 0.08)
  // 2D 描边
  svgHost?.querySelectorAll('g.note').forEach((g) => g.setAttribute('stroke', ''))
  if (n.host) (n.host as Element).setAttribute('stroke', '#ffd866')
  // 表高亮
  document.querySelectorAll('#tbl tr').forEach((tr) => tr.classList.remove('sel'))
  document.querySelector(`#tbl tr[data-i="${i}"]`)?.classList.add('sel')
  const row = document.querySelector(`#tbl tr[data-i="${i}"]`)
  row?.scrollIntoView({ block: 'nearest' })
}

// 表
function renderTable(): void {
  const tbl = document.getElementById('tbl')!
  let html = '<table><tr><th>#</th><th>mk</th><th>ch</th><th>t</th><th>x</th><th>y</th><th>id</th></tr>'
  notes.forEach((n, i) => {
    const col = '#' + MARK_COLORS[n.mark % MARK_COLORS.length]!.toString(16).padStart(6, '0')
    html += `<tr data-i="${i}"><td>${i + 1}</td><td><span class="dot" style="background:${col}"></span>${n.mark}</td><td>${n.channel}</td><td>${n.time.toFixed(3)}</td><td>${n.x.toFixed(3)}</td><td>${n.y.toFixed(3)}</td><td>${(n.id ?? '').slice(0, 12)}</td></tr>`
  })
  html += '</table>'
  tbl.innerHTML = html
  tbl.querySelectorAll('tr[data-i]').forEach((tr) => {
    tr.addEventListener('click', () => selectNote(Number((tr as HTMLElement).dataset.i)))
  })
  // 2D 点击联动
  svgHost?.querySelectorAll('g.note').forEach((g) => {
    g.addEventListener('click', () => {
      const id = g.getAttribute('id')
      const i = notes.findIndex((n) => n.id === id)
      if (i >= 0) selectNote(i)
    })
  })
}

// ── 主流程 ────────────────────────────────────────────────────
/** 只做几何/相机常量（不依赖 events） */
function buildGeometry(): void {
  buildPlane()
  buildNoteBoxes()
  minR = 0.6 * scoreH
  maxR = 8 * scoreH
  r = Math.max(minR, Math.min(maxR, r))
  applyCam()
}

/** events 就绪后：绑定 + 球链 + 表 */
function buildTimed(): void {
  bindTargets()
  initBalls()
  updateBalls(0)
  renderTable()
  document.getElementById('stat')!.textContent = `事件 ${events.length} / 分组 ${notes.length ? ballTracks.length : '-'}`
  log(`notes=${notes.length} tracks=${ballTracks.length} dur=${duration.toFixed(2)}s chains=${ballTracks.map((bt) => bt.groups.length).join(',')}`)
}

function log(s: string): void {
  const el = document.getElementById('log')!
  el.textContent = s + '\n' + el.textContent.slice(0, 400)
}

// UI
const timeRange = document.getElementById('timeRange') as HTMLInputElement
const timeTxt = document.getElementById('time')!
timeRange.addEventListener('input', () => {
  const t = (Number(timeRange.value) / 1000) * duration
  timeTxt.textContent = t.toFixed(2)
  setLitProgress(t)
  updateBalls(t)
  // 焦点跟随主球（pool[0]，取可见链）
  let fx = 0
  let found = false
  for (const bt of ballTracks) {
    const b0 = bt.pool[0]!
    if (b0.visible) { fx = b0.position.x; found = true }
  }
  if (found) focusX = fx
  applyCam()
})
document.getElementById('flightMs')!.addEventListener('input', (e) => {
  flightSec = Number((e.target as HTMLInputElement).value) / 1000
  document.getElementById('flightTxt')!.textContent = String(Number((e.target as HTMLInputElement).value))
  updateBalls(Number(timeRange.value) / 1000 * duration)
})
document.getElementById('ballR')!.addEventListener('change', (e) => {
  ballR = Number((e.target as HTMLInputElement).value) || BALL_R_DEF
  initBalls()
  updateBalls(Number(timeRange.value) / 1000 * duration)
})
document.getElementById('arcK')!.addEventListener('change', (e) => {
  arcK = Number((e.target as HTMLInputElement).value) || ARC_K_DEF
  initBalls()
  updateBalls(Number(timeRange.value) / 1000 * duration)
})

// 播放（简单时钟，无音频）
let playing = false
let playT = 0
let lastTs = 0
document.getElementById('playBtn')!.addEventListener('click', () => {
  playing = !playing
  const btn = document.getElementById('playBtn') as HTMLButtonElement
  btn.textContent = playing ? '⏸ 暂停' : '▶ 播放'
  if (playing) {
    playT = Number(timeRange.value) / 1000 * duration
    lastTs = performance.now()
    requestAnimationFrame(tick)
  }
})
function tick(ts: number): void {
  if (!playing) return
  const dt = (ts - lastTs) / 1000
  lastTs = ts
  playT += dt
  if (playT >= duration) { playT = duration; playing = false; (document.getElementById('playBtn') as HTMLButtonElement).textContent = '▶ 播放' }
  const v = Math.round((playT / duration) * 1000)
  timeRange.value = String(v)
  timeTxt.textContent = playT.toFixed(2)
  setLitProgress(playT)
  updateBalls(playT)
  focusX = 0
  for (const bt of ballTracks) if (bt.pool[0]!.visible) focusX = bt.pool[0]!.position.x
  applyCam()
  if (playing) requestAnimationFrame(tick)
}

// resize
function resize(): void {
  const w = document.getElementById('stageWrap')!.clientWidth
  const h = document.getElementById('stageWrap')!.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

// 渲染循环
function animate(): void {
  requestAnimationFrame(animate)
  renderer.render(scene, camera)
}

// ── boot ───────────────────────────────────────────────────────
async function boot(): Promise<void> {
  if (!(await initVerovio())) return
  const xml = sessionStorage.getItem('midee.xml') ?? sampleXml
  vtk!.loadData(ensureNoteTypes(xml)) // 补 type：Verovio 才画符杆/符尾
  renderSvg2D(xml)    // 同步：解析 SVG → buildGeometry（不含事件绑定）
  events = await loadEventsAsync()
  buildTimed()
  // 初始 t=0 显示
  timeRange.max = '1000'
  timeTxt.textContent = '0.00'
  animate()
  requestAnimationFrame(() => { setLitProgress(0); updateBalls(0); applyCam() })
}
void boot()
