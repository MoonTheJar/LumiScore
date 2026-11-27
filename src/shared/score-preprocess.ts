// 乐谱导入预处理（MusicXML 闸门）：
//   1. 结构解析校验（fatal：不是合法 XML / 无 part / 无音符 / Verovio 拒绝加载）
//   2. 自动矫正（auto：缺 <type> 补时值类型、装饰音缺 duration 补 0）
//   3. 反复展开（repeats：repeat / volta / D.C. / D.S. / Coda / Fine 线性化）
//   4. 注入音符唯一 id（正确内容；供连线页/3D 锚定符头）
// 每一步产出分级日志，交由导入弹窗按 无法处理错误 / 自动矫正 / 反复展开 / 正确内容 展示。

export type LogLevel = 'fatal' | 'auto' | 'repeat' | 'ok'

export interface PreprocessResult {
  xml: string
  fatal: string[]
  auto: string[]
  repeat: string[]
  ok: string[]
}

interface VerovioLike {
  loadData(xml: string): boolean
}

/** Verovio 终检（渲染真源闸门），通过返回 null */
export function verifyWithVerovio(tk: VerovioLike, xml: string): string | null {
  return verovioProbe(tk, xml)
}

// ── 渲染前兜底：缺 <type> 的音符补时值类型 ─────────────────────
// Verovio 6.3 必须靠 <type> 推断时值才画符杆/符尾。导入流水线的 tagNoteIds
// 已补过乐音的 type；这里是渲染前的防御（休止符等边角），第三页/第五页
// 共用同一份，保证两页渲染输入完全一致（text→path 的 pathSvg 才能跨页复用）。
function durToTypeRender(beats: number): string {
  const map = [
    { b: 0.125, t: '32nd' },
    { b: 0.25, t: '16th' },
    { b: 0.5, t: 'eighth' },
    { b: 1, t: 'quarter' },
    { b: 2, t: 'half' },
    { b: 4, t: 'whole' },
    { b: 8, t: 'breve' },
  ]
  for (const { b, t } of map) {
    if (Math.abs(beats - b) < 0.001) return t
    if (Math.abs(beats - b * 1.5) < 0.001) return t // 附点（<dot/> 已存在，type 用 base）
  }
  let best = map[0]!.t
  let bestD = Infinity
  for (const { b, t } of map) {
    const d = Math.abs(beats - b)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}
export function ensureNoteTypes(xml: string): string {
  // divisions 在 measure 级 <attributes> 里（不在 note 子树），用正则从全局取
  const dm = xml.match(/<divisions>(\d+)<\/divisions>/)
  const divisions = dm ? parseInt(dm[1]!, 10) : 4
  if (!divisions) return xml
  return xml.replace(/<note>([\s\S]*?)(?=<\/note>)/g, (m, inner: string) => {
    if (/<type>/.test(inner)) return m
    const dm2 = inner.match(/<duration>(\d+)<\/duration>/)
    if (!dm2) return m
    const beats = parseInt(dm2[1]!, 10) / divisions
    const type = durToTypeRender(beats)
    return m.replace(/<duration>\d+<\/duration>/, `$&<type>${type}</type>`)
  })
}

/** 用 Verovio 试加载（渲染真源做最终闸门），失败返回原因 */
export function verovioProbe(tk: VerovioLike, xml: string): string | null {
  try {
    const ok = tk.loadData(xml)
    if (!ok) return 'Verovio 拒绝加载该乐谱（结构异常）'
    return null
  } catch (err) {
    return `Verovio 无法解析：${String(err).slice(0, 160)}`
  }
}

// ── 时值类型补全（四分音符拍数 → type，含单/双附点） ─────────
function durToType(beats: number): { type: string; dots?: number } {
  const T: Array<[number, string, number?]> = [
    [4, 'whole'], [3.5, 'half', 2], [3, 'half', 1], [2, 'half'],
    [1.75, 'quarter', 2], [1.5, 'quarter', 1], [1, 'quarter'],
    [0.875, 'eighth', 2], [0.75, 'eighth', 1], [0.5, 'eighth'],
    [0.4375, '16th', 2], [0.375, '16th', 1], [0.25, '16th'], [0.125, '32nd'],
  ]
  for (const [b, type, dots] of T) {
    if (beats + 0.001 >= b) return dots ? { type, dots } : { type }
  }
  return { type: '32nd' }
}

/**
 * 注入音符 id + 装饰音补 duration=0 + 为缺 <type> 的乐音补时值类型。
 * 注意 MusicXML <note> 子元素顺序：…duration, tie, voice, type, dot, accidental…, staff…，
 * <type>/<dot> 必须插在 <voice> 之后，正则盲插会违反 DTD 被严格引擎拒绝。
 */
function tagNoteIds(xml: string, autoLog: string[], okLog: string[]): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const pe = doc.getElementsByTagName('parsererror')[0]
  if (pe) throw new Error('XML 解析失败：' + pe.textContent?.slice(0, 120))
  let k = 0
  let graceFixed = 0
  let typeFixed = 0
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    let divisions = 4
    for (const m of Array.from(part.getElementsByTagName('measure'))) {
      const divText = m.getElementsByTagName('divisions')[0]?.textContent
      if (divText) divisions = parseInt(divText, 10) || divisions
      for (const note of Array.from(m.getElementsByTagName('note'))) {
        note.setAttribute('id', 'msN' + k++)
        if (
          note.getElementsByTagName('grace').length &&
          !note.getElementsByTagName('duration').length
        ) {
          const d = doc.createElement('duration')
          d.textContent = '0'
          const v = note.getElementsByTagName('voice')[0]
          if (v) note.insertBefore(d, v)
          else note.appendChild(d)
          graceFixed++
        }
        // 缺 type 的乐音（休止符可无 type）：按 duration 补 type/dot，锚点为 <voice> 之后
        if (
          !note.getElementsByTagName('type')[0] &&
          !note.getElementsByTagName('rest')[0]
        ) {
          const durText = note.getElementsByTagName('duration')[0]?.textContent
          const dur = durText ? parseInt(durText, 10) : NaN
          if (Number.isFinite(dur) && dur > 0) {
            const { type, dots } = durToType(dur / divisions)
            const typeEl = doc.createElement('type')
            typeEl.textContent = type
            const voice = note.getElementsByTagName('voice')[0]
            note.insertBefore(typeEl, voice ? voice.nextSibling : note.getElementsByTagName('staff')[0] ?? null)
            let anchor: Node = typeEl
            for (let i = 0; i < (dots ?? 0); i++) {
              const dotEl = doc.createElement('dot')
              note.insertBefore(dotEl, anchor.nextSibling)
              anchor = dotEl
            }
            typeFixed++
          }
        }
      }
    }
  }
  if (graceFixed) autoLog.push(`为 ${graceFixed} 个装饰音补 0 时长，避免后续音符时序被整体推迟`)
  if (typeFixed) autoLog.push(`为 ${typeFixed} 个缺少时值类型（<type>）的音符自动补全，符杆/符尾渲染恢复正常`)
  okLog.push(`已标注 ${k} 个音符身份（用于连线与 3D 锚定）`)
  return new XMLSerializer().serializeToString(doc)
}

// ── 反复展开（移植自 3dtest-copy） ───────────────────────────
const MAX_EXPAND = 2000
function expandRepeats(xml: string, log: string[]): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parts = Array.from(doc.getElementsByTagName('part'))
  let expanded = false
  for (const part of parts) {
    const measures = Array.from(part.getElementsByTagName('measure'))
    if (!measures.length) continue
    interface MInfo {
      i: number; el: Element
      fwd: number | null
      bwd: number | null
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
      if (curEnding && !jumped && stack.length) {
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
        log.push(`${m.dacapo ? 'D.C.' : 'D.S.'} 跳转：回到第 ${i + 1} 小节${infos.some((x) => x.fine) ? '（至 Fine）' : ''}`)
        continue
      }
      if (jumped && m.fine) break
      if (!jumped && m.bwd !== null) {
        const r = stack[stack.length - 1]
        if (r) {
          r.times = m.bwd
          if (r.count < r.times) { r.count++; i = r.start; continue }
          stack.pop()
        }
      }
      if (!jumped && m.fwd !== null && !stack.some((r) => r.start === m.fwd)) stack.push({ start: m.fwd, times: 2, count: 1 })
      i++
    }
    if (!order.length || order.length === measures.length) continue
    expanded = true
    log.push(`反复段落展开：小节 ${measures.length} → ${order.length}（展开后谱面单向演奏，不再显示反复记号）`)
    const frag = doc.createDocumentFragment()
    order.forEach((idx, k) => {
      const clone = infos[idx]!.el.cloneNode(true) as Element
      clone.setAttribute('number', String(k + 1))
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
  if (!expanded) return xml
  // Verovio(libxml2) 遇含非 ASCII 的注释会拒绝加载
  return new XMLSerializer().serializeToString(doc).replace(/<!--[\s\S]*?-->/g, '')
}

/** 结构初检：合法 XML + 有 part + 有音符；返回 fatal 原因列表（空数组=通过） */
export function checkXmlStructure(rawXml: string): string[] {
  const probe = new DOMParser().parseFromString(rawXml, 'application/xml')
  const parseErr = probe.getElementsByTagName('parsererror')[0]
  if (parseErr) return ['不是合法的 XML 文件：' + (parseErr.textContent ?? '').slice(0, 160)]
  const parts = Array.from(probe.getElementsByTagName('part'))
  if (!parts.length) return ['XML 中没有找到 <part>（不是有效的 MusicXML 乐谱）']
  const noteCount = parts.reduce((n, p) => n + p.getElementsByTagName('note').length, 0)
  if (!noteCount) return ['乐谱中没有任何音符（<note>），无法处理']
  return []
}

/** 自动矫正：补 <type>、装饰音补 0 时长、注入音符 id */
export function autocorrectXml(
  rawXml: string,
): { xml: string; auto: string[]; ok: string[]; fatal: string[] } {
  const auto: string[] = []
  const ok: string[] = []
  const fatal: string[] = []
  let xml = rawXml
  try {
    xml = tagNoteIds(xml, auto, ok)
  } catch (err) {
    fatal.push(String((err as Error).message ?? err))
  }
  return { xml, auto, ok, fatal }
}

/** 反复展开（无反复时原样返回） */
export function expandRepeatsXml(xml: string): { xml: string; repeat: string[] } {
  const repeat: string[] = []
  return { xml: expandRepeats(xml, repeat), repeat }
}

/**
 * 完整预处理闸门（一次性版本）。
 * @param tk 已初始化的 Verovio 工具（最终渲染校验）
 */
export function preprocessScore(rawXml: string, tk: VerovioLike): PreprocessResult {
  const fatal = checkXmlStructure(rawXml)
  if (fatal.length) return { xml: rawXml, fatal, auto: [], repeat: [], ok: [] }
  const auto: string[] = []
  const repeat: string[] = []
  const ok: string[] = []
  const probe = new DOMParser().parseFromString(rawXml, 'application/xml')
  const partCount = probe.getElementsByTagName('part').length
  const noteCount = Array.from(probe.getElementsByTagName('part')).reduce(
    (n, p) => n + p.getElementsByTagName('note').length, 0,
  )
  ok.push(`结构校验通过：${partCount} 个声部、${noteCount} 个音符`)

  const ac = autocorrectXml(rawXml)
  fatal.push(...ac.fatal)
  auto.push(...ac.auto)
  ok.push(...ac.ok)
  const ep = expandRepeatsXml(ac.xml)
  repeat.push(...ep.repeat)
  // expandRepeats 克隆小节会复制音符 id，第三页按 id 绑 MIDI 时间时，重复段的音符会
  // 拿到错误时间、圆滑线/连音线点亮错乱；有展开时重打一次 id，保证全局唯一。
  const finalXml = ep.repeat.length ? autocorrectXml(ep.xml).xml : ep.xml
  const err = verovioProbe(tk, finalXml)
  if (err) fatal.push(err)
  else ok.push('渲染引擎校验通过，乐谱可以正常显示')

  return { xml: finalXml, fatal, auto, repeat, ok }
}
