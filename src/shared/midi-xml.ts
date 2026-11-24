// ── MIDI ↔ MusicXML 双向转换 ─────────────────────────────────
// MIDI 用于播放，MusicXML 用于 Verovio 显示乐谱。任何导入都互转出两份数据。
// v3：单 part 大谱表（一行多轨）：所有轨合进同一行（高音谱+低音谱并排），
//     但每轨独立 voice（声部不混淆成和弦）；32 分网格量化。
import { Midi } from '@tonejs/midi'

const DIV = 480 // divisions per quarter note
const GRID = DIV / 8 // 32 分音符量化网格（更精细，三连音/快速音不丢）

// ── 音名换算 ─────────────────────────────────────────────────
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiToStep(m: number): { step: string; alter: number; octave: number } {
  const pc = ((m % 12) + 12) % 12
  let step = NAMES[pc]!
  let alter = 0
  if (step.includes('#')) {
    step = NAMES[(pc + 11) % 12]!.replace('#', '')
    alter = 1
  }
  return { step, alter, octave: Math.floor(m / 12) - 1 }
}

/** ticks → MusicXML type（含单/双附点）。按 ×2 / ×1.75（双附点）/ ×1.5（单附点）/ ×1 匹配 */
function ticksToType(ticks: number): { type: string; dots?: number } {
  const q = DIV // 四分
  const T: Array<[number, string, number?]> = [
    [q * 4, 'whole'],
    [q * 3.5, 'half', 2],
    [q * 3, 'half', 1],
    [q * 2, 'half'],
    [q * 1.75, 'quarter', 2],
    [q * 1.5, 'quarter', 1],
    [q, 'quarter'],
    [q * 0.875, 'eighth', 2],
    [q * 0.75, 'eighth', 1],
    [q / 2, 'eighth'],
    [q * 0.4375, '16th', 2],
    [q * 0.375, '16th', 1],
    [q / 4, '16th'],
  ]
  for (const [v, type, dots] of T) {
    if (ticks >= v) return dots ? { type, dots } : { type }
  }
  return { type: '32nd' }
}

/** 简单调号推断（黑键占比） */
function inferFifths(notes: { midi: number }[]): number {
  if (!notes.length) return 0
  const count = new Map<number, number>()
  for (const n of notes) {
    const pc = ((n.midi % 12) + 12) % 12
    count.set(pc, (count.get(pc) ?? 0) + 1)
  }
  const black = [1, 3, 6, 8, 10]
  const blacks = black.reduce((s, pc) => s + (count.get(pc) ?? 0), 0)
  const ratio = blacks / notes.length
  if (ratio < 0.02) return 0
  if (ratio < 0.1) return 1
  if (ratio < 0.22) return 2
  return 3
}

/** 判断一个轨道用什么谱表：范围跨大谱表 → 双 staff；否则按中位数 */
function staffMode(trackNotes: { midi: number }[]): 'treble' | 'bass' | 'both' {
  if (!trackNotes.length) return 'treble'
  const mids = trackNotes.map((n) => n.midi)
  const min = Math.min(...mids)
  const max = Math.max(...mids)
  if (min < 55 && max >= 62) return 'both'
  const sorted = [...mids].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]!
  return med >= 60 ? 'treble' : 'bass'
}

// ── MIDI → MusicXML（单 part 大谱表 + 每轨独立 voice：一行多轨） ──
// 所有轨合进同一个 part（高音谱 staff1 + 低音谱 staff2 并排一行），
// 每轨分配独立 voice → 声部清晰分离，不会把不同轨同时发音的音符混成和弦。
interface TrackNote {
  tick: number
  dur: number
  midi: number
  staff: 1 | 2
  voice: number
}

export function midiToXml(midiBytes: Uint8Array, name = 'untitled'): string {
  const midi = new Midi(midiBytes)
  const bpm = midi.header.tempos[0]?.bpm ?? 120
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4]
  const num = ts[0] ?? 4
  const den = ts[1] ?? 4
  const beatSec = 60 / bpm
  const beatsPerBar = num * 4 / den
  const barTicks = DIV * beatsPerBar

  // 每轨分配 staff/voice（轨内跨大谱表 → 占两个 voice）
  let voiceCounter = 0
  function nextVoice(): number {
    return ++voiceCounter
  }
  interface VoiceAlloc {
    staff: 1 | 2
    voice: number
  }
  const trackAlloc: (VoiceAlloc[] | null)[] = midi.tracks.map((track) => {
    if (!track.notes.length) return null
    const mids = track.notes.map((n) => n.midi)
    const min = Math.min(...mids)
    const max = Math.max(...mids)
    if (min < 55 && max >= 62) {
      // 轨内跨大谱表 → 高音/低音各一 voice
      return [
        { staff: 1 as const, voice: nextVoice() },
        { staff: 2 as const, voice: nextVoice() },
      ]
    }
    const sorted = [...mids].sort((a, b) => a - b)
    const med = sorted[Math.floor(sorted.length / 2)]!
    return [{ staff: (med >= 60 ? 1 : 2) as 1 | 2, voice: nextVoice() }]
  })

  // 量化到 32 分网格，标注 staff/voice
  const notes: TrackNote[] = []
  midi.tracks.forEach((track, ti) => {
    const alloc = trackAlloc[ti]
    if (!alloc) return
    for (const n of track.notes) {
      const tick = Math.round(n.time / beatSec * DIV / GRID) * GRID
      const dur = Math.max(GRID, Math.round(n.duration / beatSec * DIV / GRID) * GRID)
      const a = alloc[n.midi >= 60 ? 0 : alloc.length > 1 ? 1 : 0]!
      notes.push({ tick, dur, midi: n.midi, staff: a.staff, voice: a.voice })
    }
  })
  notes.sort((a, b) => a.tick - b.tick || a.voice - b.voice)
  const maxEndTick = notes.length ? Math.max(...notes.map((n) => n.tick + n.dur)) : 0
  const nBars = Math.max(1, Math.ceil(maxEndTick / barTicks))
  const fifths = inferFifths(notes)

  // voice → 固定 staff（每轨 1~2 个 voice，staff 不随音符变化）
  const voiceStaff = new Map<number, 1 | 2>()
  for (const alloc of trackAlloc) {
    if (!alloc) continue
    for (const a of alloc) voiceStaff.set(a.voice, a.staff)
  }
  const allVoices = [...voiceStaff.keys()].sort((a, b) => a - b)

  // 把任意 60 网格时值贪心拆成「可由单个 type(+附点) 表示」的标准时值序列。
  // 关键：严格引擎（MuseScore）会按 <type> 名义时值重排计时，若 type 与 <duration>
  // 不一致（如 1140/1800 这类量化残值），后续音符会整体移位；拆成 tie 链后
  // 每个音的 type 名义值恒等于 duration，时间分毫不差。
  const STD_DURS = [1920, 1680, 1440, 960, 840, 720, 480, 420, 360, 240, 210, 180, 120, 60]
  function splitDur(dur: number): number[] {
    const out: number[] = []
    let r = dur
    for (const v of STD_DURS) {
      while (r >= v) { out.push(v); r -= v }
    }
    if (r > 0) {
      const last = out[out.length - 1]
      if (last !== undefined) out[out.length - 1] = last + r
      else out.push(r)
    }
    return out
  }

  interface Item { tick: number; dur: number; midi: number; chord: boolean; tieIn: boolean; tieOut: boolean }
  interface MemSeg { midi: number; dur: number; chord: boolean; tieIn: boolean; tieOut: boolean }
  interface BarSeg { start: number; maxDur: number; members: MemSeg[] }
  const voiceBars = new Map<number, BarSeg[][]>()
  for (const v of allVoices) {
    const vNotes = notes.filter((n) => n.voice === v).sort((a, b) => a.tick - b.tick || a.midi - b.midi)
    const groups: { start: number; members: TrackNote[] }[] = []
    for (const n of vNotes) {
      const g = groups[groups.length - 1]
      if (g && g.start === n.tick) g.members.push(n)
      else groups.push({ start: n.tick, members: [n] })
    }
    // 踏板/连奏让前一个音延续到下一音之后，记谱上应在下一音起点收束
    for (let gi = 0; gi < groups.length; gi++) {
      const nextStart = groups[gi + 1]?.start
      if (nextStart === undefined) continue
      for (const m of groups[gi]!.members) {
        if (m.tick + m.dur > nextStart) m.dur = Math.max(GRID, nextStart - m.tick)
      }
    }
    // 展平成标准时值 item 列表：组内首成员为普通音，其余成员首段带 <chord/>；
    // 非标准时值拆成 tie 链（tie 只表示同一音的延续）。
    const items: Item[] = []
    for (const g of groups) {
      g.members.forEach((m, mi) => {
        const pieces = splitDur(m.dur)
        let t = g.start
        pieces.forEach((d, pi) => {
          items.push({
            tick: t,
            dur: d,
            midi: m.midi,
            chord: mi > 0 && pi === 0,
            tieIn: pi > 0,
            tieOut: pi < pieces.length - 1,
          })
          t += d
        })
      })
    }
    items.sort((a, b) => a.tick - b.tick || (a.chord === b.chord ? a.midi - b.midi : a.chord ? 1 : -1))

    // 切分到各小节（跨小节的 item 再拆一段并叠加跨小节 tie）
    const bars: BarSeg[][] = Array.from({ length: nBars }, () => [])
    const segMap = new Map<number, BarSeg>()
    for (const it of items) {
      const end = it.tick + it.dur
      const firstBar = Math.floor(it.tick / barTicks)
      const lastBar = Math.floor((end - 1) / barTicks)
      for (let b = firstBar; b <= lastBar; b++) {
        const bs = b * barTicks
        const be = bs + barTicks
        const segStart = Math.max(it.tick, bs)
        const segDur = Math.min(end, be) - segStart
        let seg = segMap.get(segStart)
        if (!seg) {
          seg = { start: segStart, maxDur: 0, members: [] }
          segMap.set(segStart, seg)
          bars[b]!.push(seg)
        }
        seg.maxDur = Math.max(seg.maxDur, segDur)
        seg.members.push({
          midi: it.midi,
          dur: segDur,
          chord: it.chord && it.tick >= bs,
          tieIn: it.tieIn || it.tick < bs,
          tieOut: it.tieOut || end > be,
        })
      }
    }
    for (const bar of bars) bar.sort((a, b2) => a.start - b2.start)
    voiceBars.set(v, bars)
  }

  // 休止也按标准时值拆分并带 type/dot，避免引擎对非标准时长休止重排
  const emitRest = (dur: number, voice: number, staff: number, whole: boolean): void => {
    const pieces = whole ? [dur] : splitDur(dur)
    for (const rd of pieces) {
      const { type, dots } = ticksToType(rd)
      let s = '      <note>'
      s += `<rest${whole ? ' measure="yes"' : ''}/>`
      s += `<duration>${rd}</duration>`
      s += `<voice>${voice}</voice>`
      s += `<type>${type}</type>`
      for (let d = 0; d < (dots ?? 0); d++) s += '<dot/>'
      s += `<staff>${staff}</staff>`
      s += '</note>'
      xml.push(s)
    }
  }

  const xml: string[] = []
  xml.push('<?xml version="1.0" encoding="UTF-8"?>')
  xml.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">')
  xml.push('<score-partwise version="4.0">')
  xml.push(`  <work><work-title>${esc(name)}</work-title></work>`)
  xml.push('  <part-list>')
  xml.push(`    <score-part id="P1"><part-name>${esc(name)}</part-name></score-part>`)
  xml.push('  </part-list>')
  xml.push('  <part id="P1">')
  // 本 part 是否含两个 staff（跨大谱表轨的高/低两个 voice 分属 staff 1/2）。
  // 必须显式声明 <staves>2</staves>，否则引擎只认 staff 1，staff 2 的每个音符
  // 都会报 “Staff 2 cannot be found / cross staff reference”。
  const staffSet = new Set(voiceStaff.values())
  const twoStaves = staffSet.has(1) && staffSet.has(2)
  // 单 staff 轨即便音符都在低音区（alloc 给 staff 2），输出时也要归一为 staff 1，
  // 否则 <staff>2</staff> 引用不存在的第二谱表
  const singleIsBass = !twoStaves && staffSet.has(2)
  const outStaffOf = (voice: number): 1 | 2 => {
    const s = voiceStaff.get(voice)!
    return twoStaves ? s : 1
  }
  for (let b = 0; b < nBars; b++) {
    const barStart = b * barTicks
    xml.push(`    <measure number="${b + 1}">`)
    if (b === 0) {
      xml.push('      <attributes>')
      xml.push(`        <divisions>${DIV}</divisions>`)
      if (twoStaves) xml.push('        <staves>2</staves>')
      xml.push(`        <key><fifths>${fifths}</fifths></key>`)
      xml.push(`        <time><beats>${num}</beats><beat-type>${den}</beat-type></time>`)
      if (twoStaves) {
        xml.push('        <clef number="1"><sign>G</sign><line>2</line></clef>')
        xml.push('        <clef number="2"><sign>F</sign><line>4</line></clef>')
      } else if (singleIsBass) {
        xml.push('        <clef number="1"><sign>F</sign><line>4</line></clef>')
      } else {
        xml.push('        <clef number="1"><sign>G</sign><line>2</line></clef>')
      }
      xml.push('      </attributes>')
      // 保留原始速度：MIDI 往返与 MuseScore 导出时不丢 tempo
      xml.push(`      <direction><sound tempo="${Math.round(bpm * 100) / 100}"/></direction>`)
    }
    // 输出顺序：先 staff 1 各 voice 再 staff 2；每进入下一个 voice 都用 <backup>
    // 把时间游标回退到小节起点——MusicXML 单 part 多声部靠 backup 并行，
    // 否则严格引擎会把各 voice 时值顺序累加（4/4 被读成 8/4、后续小节整体丢失）。
    const orderedVoices = [...allVoices].sort(
      (a, b2) => voiceStaff.get(a)! - voiceStaff.get(b2)! || a - b2,
    )
    orderedVoices.forEach((v, vi) => {
      const staff = outStaffOf(v)
      if (vi > 0) {
        xml.push(`      <backup><duration>${barTicks}</duration></backup>`)
      }
      const segs = voiceBars.get(v)![b]!
      if (!segs.length) {
        emitRest(barTicks, v, staff, true) // 该声部本小节无声 → 整小节休止
        return
      }
      // 展开为「可直接写 XML 的标准时值音符」列表：跨小节裁剪段若为非标准残值，
      // 再拆成段内 tie 链；同 tick 的第二个及以后音符一律 <chord/>。
      interface N { off: number; dur: number; midi: number; chord: boolean; tieIn: boolean; tieOut: boolean }
      const notesOut: N[] = []
      for (const seg of segs) {
        const off0 = seg.start - barStart
        for (const m of seg.members) {
          const pieces = splitDur(m.dur)
          let t = off0
          pieces.forEach((d, pi) => {
            notesOut.push({
              off: t,
              dur: d,
              midi: m.midi,
              chord: m.chord && pi === 0,
              tieIn: pi === 0 ? m.tieIn : true,
              tieOut: pi === pieces.length - 1 ? m.tieOut : true,
            })
            t += d
          })
        }
      }
      notesOut.sort((a, b) => a.off - b.off || (a.chord === b.chord ? a.midi - b.midi : a.chord ? 1 : -1))
      for (let i = 1; i < notesOut.length; i++) {
        if (notesOut[i]!.off === notesOut[i - 1]!.off) notesOut[i]!.chord = true
      }
      let cursor = 0
      for (const n of notesOut) {
        if (n.off > cursor) emitRest(n.off - cursor, v, staff, false) // 两音之间补休止
        const { step, alter, octave } = midiToStep(n.midi)
        const { type, dots } = ticksToType(n.dur)
        // MusicXML <note> 子元素有严格顺序：chord → pitch → duration → tie → voice → type → dot → staff → notations
        xml.push('      <note>')
        if (n.chord) xml.push('        <chord/>')
        // <step> 与 <alter> 必须是兄弟节点（写成 <step>F<alter/></step> 严格引擎会整小节丢弃）
        xml.push(`        <pitch><step>${step}</step>${alter !== 0 ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`)
        xml.push(`        <duration>${n.dur}</duration>`)
        if (n.tieIn) xml.push('        <tie type="stop"/>')
        if (n.tieOut) xml.push('        <tie type="start"/>')
        xml.push(`        <voice>${v}</voice>`)
        xml.push(`        <type>${type}</type>`)
        for (let d = 0; d < (dots ?? 0); d++) xml.push('        <dot/>')
        xml.push(`        <staff>${staff}</staff>`)
        if (n.tieIn || n.tieOut) {
          const tied = `${n.tieIn ? '<tied type="stop"/>' : ''}${n.tieOut ? '<tied type="start"/>' : ''}`
          xml.push(`        <notations>${tied}</notations>`)
        }
        xml.push('      </note>')
        // <chord/> 成员只共享起音、不推进时间；严格引擎按主音推进，若让较长和弦
        // 成员参与游标，主音结束到下一起音间的缺口休止会被吞，起音被前移。
        if (!n.chord) cursor = n.off + n.dur
      }
      if (cursor < barTicks) emitRest(barTicks - cursor, v, staff, false) // 小节尾部补齐
    })
    xml.push('    </measure>')
  }
  xml.push('  </part>')
  xml.push('</score-partwise>')
  return xml.join('\n')
}

// ── MusicXML → MIDI（按 part + staff 分轨：大谱表钢琴 → 右手/左手） ──
export function xmlToMidi(xml: string, bpmIn?: number): Uint8Array {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parts = doc.getElementsByTagName('part')
  if (!parts.length) throw new Error('MusicXML 中无 <part>')

  // 速度：优先显式入参，其次 MusicXML <sound tempo>（midiToXml 往返保留），默认 120
  let bpm = bpmIn ?? 120
  if (bpmIn === undefined) {
    const soundTempo = doc.getElementsByTagName('sound')[0]?.getAttribute('tempo')
    const parsed = soundTempo ? parseFloat(soundTempo) : NaN
    if (Number.isFinite(parsed) && parsed > 0) bpm = parsed
  }
  // 拍号：取第一个 part 首组 <attributes><time>，默认 4/4
  const firstAttrs = parts[0]?.getElementsByTagName('attributes')[0]
  const timeBeats = parseInt(firstAttrs?.getElementsByTagName('beats')[0]?.textContent ?? '4', 10)
  const timeBeatType = parseInt(firstAttrs?.getElementsByTagName('beat-type')[0]?.textContent ?? '4', 10)
  const beats = Number.isFinite(timeBeats) && timeBeats > 0 ? timeBeats : 4
  const beatType = Number.isFinite(timeBeatType) && timeBeatType > 0 ? timeBeatType : 4

  // part-list：part id → 乐器/声部名（用于分轨命名）
  const partNames = new Map<string, string>()
  const scoreParts = doc.getElementsByTagName('score-part')
  for (let i = 0; i < scoreParts.length; i++) {
    const sp = scoreParts[i]!
    const id = sp.getAttribute('id') ?? `P${i + 1}`
    const nm =
      sp.getElementsByTagName('part-name')[0]?.textContent?.trim() ||
      sp.getElementsByTagName('instrument-name')[0]?.textContent?.trim() ||
      ''
    partNames.set(id, nm)
  }

  interface XmlEv {
    tick: number
    dur: number
    midi: number | null
    staff: number
  }
  // 按 part + staff 收集音符：大谱表钢琴自然拆成右手(staff1)/左手(staff2) 两轨
  const groups: Array<{ name: string; notes: XmlEv[] }> = []
  const groupIndex = new Map<string, number>()
  const partStaves = new Map<number, Set<number>>()
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi]!
    const pid = part.getAttribute('id') ?? `P${pi + 1}`
    let divisions = DIV
    let curBeat = 4
    let curBeatType = 4
    let tick = 0
    const measures = part.getElementsByTagName('measure')
    for (let mi = 0; mi < measures.length; mi++) {
      const m = measures[mi]!
      const attrs = m.getElementsByTagName('attributes')[0]
      if (attrs) {
        const d = attrs.getElementsByTagName('divisions')[0]
        if (d?.textContent) divisions = parseInt(d.textContent, 10)
        const beats = attrs.getElementsByTagName('beats')[0]
        const bt = attrs.getElementsByTagName('beat-type')[0]
        if (beats?.textContent && bt?.textContent) {
          curBeat = parseInt(beats.textContent, 10)
          curBeatType = parseInt(bt.textContent, 10)
        }
      }
      const barTicks = divisions * 4 * (curBeat / curBeatType)
      const notesEls = m.getElementsByTagName('note')
      // 每个 voice 独立的时值游标：多声部不互相污染位置（voice 缺失默认 1）
      const voiceX = new Map<number, number>()
      for (let ni = 0; ni < notesEls.length; ni++) {
        const el = notesEls[ni]!
        const isChord = !!el.getElementsByTagName('chord')[0]
        const vEl = el.getElementsByTagName('voice')[0]
        const v = vEl?.textContent ? parseInt(vEl.textContent, 10) : 1
        const x = voiceX.get(v) ?? 0
        const durEl = el.getElementsByTagName('duration')[0]
        const dur = durEl?.textContent ? parseInt(durEl.textContent, 10) : divisions
        const pos = tick + (isChord ? Math.max(0, x - dur) : x)
        if (!isChord) voiceX.set(v, x + dur)
        const staff = parseInt(el.getElementsByTagName('staff')[0]?.textContent ?? '1', 10) || 1
        if (!partStaves.has(pi)) partStaves.set(pi, new Set<number>())
        partStaves.get(pi)!.add(staff)
        const isRest = !!el.getElementsByTagName('rest')[0]
        let midi: number | null = null
        if (!isRest) {
          const p = el.getElementsByTagName('pitch')[0]
          const step = p?.getElementsByTagName('step')[0]?.textContent ?? 'C'
          const alter = parseInt(p?.getElementsByTagName('alter')[0]?.textContent ?? '0', 10)
          const octave = parseInt(p?.getElementsByTagName('octave')[0]?.textContent ?? '4', 10)
          const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
          const pc = STEP_PC[step] ?? 0
          midi = pc + alter + (octave + 1) * 12
        }
        const key = `${pi}:${staff}`
        let gi = groupIndex.get(key)
        if (gi === undefined) {
          gi = groups.length
          groupIndex.set(key, gi)
          groups.push({ name: '', notes: [] })
        }
        groups[gi]!.notes.push({ tick: Math.round(pos * (480 / divisions)), dur: Math.max(1, Math.round(dur * (480 / divisions))), midi, staff })
      }
      tick += barTicks
    }
    // 命名：同一 part 有多个谱表 → 声部名（右手/左手/第三谱表=和弦），并带上
    // part 名前缀（「钢琴2 右手」）——音轨面板按「总轨=钢琴n」分组依赖这个前缀；
    // 无 part 名时退回纯声部名（兼容旧数据）。单谱表 → part 自带名。
    const staves = [...(partStaves.get(pi) ?? [1])].sort((a, b) => a - b)
    staves.forEach((staff, k) => {
      const gi = groupIndex.get(`${pi}:${staff}`)
      if (gi === undefined) return
      if (staves.length >= 2) {
        const voice = k === 0 ? '右手' : k === 1 ? '左手' : '和弦'
        const base = partNames.get(pid) ?? ''
        groups[gi]!.name = base ? `${base} ${voice}` : voice
      } else {
        groups[gi]!.name = partNames.get(pid) ?? ''
      }
    })
  }

  // SMF 编码
  const division = 480
  const tempo = Math.round(60000000 / bpm)
  // FF 58 拍号：(分子, 分母指数, 每拍 MIDI clock, 32 分音符数)
  const denExp = Math.max(0, Math.round(Math.log2(beatType)))
  const clocks = Math.max(1, Math.round(24 * ((beats * 4) / beatType)))
  const timeSig = [beats, denExp, clocks, 8]

  const vlq = (n: number): number[] => {
    const out = [n & 0x7f]
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80)
    return out
  }

  const track0: number[] = []
  pushEvent(track0, vlq, 0, [0xff, 0x51, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff])
  pushEvent(track0, vlq, 0, [0xff, 0x58, 4, ...timeSig])
  pushEvent(track0, vlq, 0, [0xff, 0x2f, 0])

  /** FF 03 轨名 meta 事件（SMF 文本按 UTF-8 写字节） */
  const trackNameEvent = (name: string): number[] => {
    const bytes = Array.from(new TextEncoder().encode(name))
    return [0xff, 0x03, bytes.length, ...bytes]
  }

  const noteTracks: number[][] = groups.map((g) => {
    const evs: { tick: number; type: 'on' | 'off'; midi: number; vel: number }[] = []
    for (const n of g.notes) {
      if (n.midi == null) continue
      evs.push({ tick: n.tick, type: 'on', midi: n.midi, vel: 80 })
      evs.push({ tick: n.tick + n.dur, type: 'off', midi: n.midi, vel: 0 })
    }
    evs.sort((a, b) => a.tick - b.tick || (a.type === b.type ? 0 : a.type === 'on' ? -1 : 1))
    const buf: number[] = []
    if (g.name) pushEvent(buf, vlq, 0, trackNameEvent(g.name))
    let last = 0
    for (const e of evs) {
      const d = e.tick - last
      last = e.tick
      const status = e.type === 'on' ? 0x90 : 0x80
      pushEvent(buf, vlq, d, [status, e.midi, e.vel])
    }
    pushEvent(buf, vlq, 0, [0xff, 0x2f, 0])
    return buf
  })

  const bytes: number[] = []
  const ntrks = 1 + noteTracks.length
  bytes.push(0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, (ntrks >> 8) & 0xff, ntrks & 0xff, (division >> 8) & 0xff, division & 0xff)
  for (const tr of [track0, ...noteTracks]) {
    bytes.push(0x4d, 0x54, 0x72, 0x6b)
    const len = tr.length
    bytes.push((len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
    bytes.push(...tr)
  }
  return new Uint8Array(bytes)
}

function pushEvent(buf: number[], vlq: (n: number) => number[], delta: number, ev: number[]): void {
  buf.push(...vlq(delta), ...ev)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
}
