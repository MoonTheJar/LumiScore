const TYPE = { 96:'long', 48:'whole', 72:'whole', 24:'half', 36:'half', 18:'half', 12:'quarter', 9:'quarter', 6:'eighth', 3:'16th', 4:'eighth', 2:'16th', 8:'quarter', 16:'half' }
const PITCH = /^([A-G])(#|b)?(-?\d)$/

function n(p, dur, o = {}) {
  const m = PITCH.exec(p)
  if (!m) throw new Error('bad pitch ' + p)
  const step = m[1], alter = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, oct = m[3]
  const type = o.type || TYPE[dur] || 'quarter'
  let s = '<note>'
  if (o.grace) s += '<grace/>'
  if (o.chord) s += '<chord/>'
  s += '<pitch><step>' + step + '</step>' + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + oct + '</octave></pitch>'
  if (!o.grace) s += '<duration>' + dur + '</duration>'
  s += '<voice>' + (o.voice || 1) + '</voice><type>' + type + '</type>'
  if (o.staff) s += '<staff>' + o.staff + '</staff>'
  if (o.tie) s += '<tie type="' + o.tie + '"/>'
  if (o.dot) s += '<dot/>'
  if (o.tuplet) s += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'
  const inner = []
  if (o.slur) inner.push('<slur type="' + o.slur + '" number="1"/>')
  if (o.tuplet) inner.push('<tuplet type="' + o.tuplet + '" number="1"/>')
  const orn = []
  if (o.tremolo) orn.push('<tremolo type="single">' + o.tremolo + '</tremolo>')
  if (o.trill) orn.push('<trill-mark/>')
  if (o.mordent) orn.push('<mordent/>')
  if (o.turn) orn.push('<turn/>')
  if (orn.length) inner.push('<ornaments>' + orn.join('') + '</ornaments>')
  const art = []
  if (o.staccato) art.push('<staccato/>')
  if (o.accent) art.push('<accent/>')
  if (o.tenuto) art.push('<tenuto/>')
  if (art.length) inner.push('<articulations>' + art.join('') + '</articulations>')
  if (o.fermata) inner.push('<fermata/>')
  if (o.arpeggio) inner.push('<arpeggiate number="' + o.arpeggio + '"/>')
  if (inner.length) s += '<notations>' + inner.join('') + '</notations>'
  return s + '</note>'
}

export const g = (p, o = {}) => n(p, 0, { grace: true, ...o })
export const r = (dur, o = {}) => '<note><rest/><duration>' + dur + '</duration><voice>' + (o.voice || 1) + '</voice><type>' + (TYPE[dur] || 'quarter') + '</type>' + (o.staff ? '<staff>' + o.staff + '</staff>' : '') + '</note>'
export const rFull = (v, st) => '<note><rest measure="yes"/><duration>48</duration><voice>' + v + '</voice>' + (st ? '<staff>' + st + '</staff>' : '') + '</note>'
export const w = (t, reh) => '<direction placement="above"><direction-type>' + (reh ? '<rehearsal enclosure="rectangle">' + t + '</rehearsal>' : '<words>' + t + '</words>') + '</direction-type></direction>'
export const dyn = (t) => '<direction placement="below"><direction-type><dynamics><' + t + '/></dynamics></direction-type></direction>'
export function attrs(o) {
  let s = '<attributes>'
  if (o.div) s += '<divisions>' + o.div + '</divisions>'
  if (o.fifths !== undefined) s += '<key><fifths>' + o.fifths + '</fifths></key>'
  if (o.beats) s += '<time><beats>' + o.beats + '</beats><beat-type>' + (o.beatType || 4) + '</beat-type></time>'
  if (o.staves) s += '<staves>' + o.staves + '</staves>'
  for (const c of o.clefs || []) s += '<clef number="' + (c[2] || 1) + '"><sign>' + c[0] + '</sign><line>' + c[1] + '</line>' + (c[3] ? '<clef-octave-change>' + c[3] + '</clef-octave-change>' : '') + '</clef>'
  return s + '</attributes>'
}
export const bl = (d) => d === 'start' ? '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>' : d === 'end' ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>' : ''
export const end = (num, type) => '<ending number="' + num + '" type="' + type + '"/>'

// ─────────── 每个 part 固定 16 小节，严格对齐 ───────────
const M = 16
const m1 = (inner, o = {}) => '<measure number="' + (o.num || 1) + '">' + (o.head || '') + (o.bl || '') + (o.end || '') + inner + '</measure>'

// P1 单声部：时值 / 附点 / 圆滑线 / 延音线 / 同音高反复 / 三连音 / 装饰音 / 反复 / 移调 / 大跳
const P1 = [
  m1(attrs({ div: D, fifths: 0, beats: 4, clefs: [['G', 2]] }) + w('P1 单声部 · 时值与附点', 1)
    + n('C5', 48) + n('D5', 24) + n('E5', 18, { dot: 1 }) + n('F5', 6), { num: 1 }),
  m1(n('G5', 6) + n('A5', 3) + n('B5', 15, { dot: 1 }) + n('C6', 24, { dot: 1 }), { num: 2 }),
  m1(n('C5', 12) + n('C5', 12) + n('C5', 12) + n('C5', 12), { num: 3 }),
  m1(n('D5', 12, { tie: 'start' }) + n('D5', 12, { tie: 'stop' }) + n('D5', 12, { tie: 'start' }) + n('D5', 12, { tie: 'stop' }), { num: 4 }),
  m1(n('E5', 12, { slur: 'start' }) + n('F5', 12) + n('G5', 12) + n('A5', 12), { num: 5 }),
  m1(n('B5', 12) + n('C6', 12) + n('B5', 12) + n('A5', 12, { slur: 'stop' }), { num: 6 }),
  m1(n('G5', 4, { tuplet: 'start' }) + n('A5', 4) + n('B5', 4, { tuplet: 'stop' })
    + n('C6', 8, { tuplet: 'start' }) + n('B5', 8) + n('A5', 8, { tuplet: 'stop' })
    + n('G5', 12), { num: 7 }),
  m1(n('F5', 12, { trill: 1, accent: 1 }) + n('G5', 12, { mordent: 1, tenuto: 1 })
    + n('A5', 12, { turn: 1, staccato: 1 }) + n('B5', 12, { fermata: 1 }), { num: 8 }),
  m1(bl('start') + end(1, 'start') + n('C5', 12) + n('D5', 12) + n('E5', 24) + end(1, 'stop') + bl('end'), { num: 9 }),
  m1(end(2, 'start') + n('F5', 12) + n('E5', 12) + n('D5', 24) + end(2, 'stop'), { num: 10 }),
  m1(w('移调谱号 / 拍号 / 调号') + attrs({ fifths: -3, beats: 3, clefs: [['G', 2, 1, -1]] })
    + n('A4', 12) + n('B4', 12) + n('C5', 12), { num: 11 }),
  m1(attrs({ beats: 4, clefs: [['G', 2]] }) + w('大跳与极端音程') + n('C3', 24) + n('C6', 24), { num: 12 }),
  m1(n('E5', 6) + n('F5', 6) + n('G5', 6) + n('A5', 6) + n('B5', 6) + n('C6', 6) + n('D6', 6) + n('E6', 6), { num: 13 }),
  m1(n('C6', 8) + n('B5', 8) + n('A5', 8) + n('G5', 8) + n('F5', 8) + n('E5', 8), { num: 14 }),
  m1(n('G4', 24) + n('B4', 24), { num: 15 }),
  m1(n('C5', 48, { fermata: 1 }), { num: 16 }),
]

// P2 和弦：二度~八度 / 密集簇 / 琶音 / 拆分 / 和弦+延音线
const P2 = [
  m1(attrs({ div: D, fifths: 0, beats: 4, clefs: [['G', 2]] }) + w('P2 和弦音程', 1)
    + n('C4', 48) + n('D4', 48, { chord: 1 }), { num: 1 }),
  m1(n('E4', 48) + n('G4', 48, { chord: 1 }) + n('B4', 48, { chord: 1 }) + n('C5', 48, { chord: 1 }), { num: 2 }),
  m1(n('D4', 48, { arpeggio: 1 }) + n('A4', 48, { chord: 1 }) + n('B4', 48, { chord: 1 }) + n('D5', 48, { chord: 1 }), { num: 3 }),
  m1(n('C5', 24) + n('C#5', 24, { chord: 1 }) + n('D5', 24, { chord: 1 }) + n('E5', 24, { chord: 1 }), { num: 4 }),
  m1(n('F4', 12) + n('A4', 12) + n('C5', 12) + n('F5', 12), { num: 5 }),
  m1(n('G4', 24, { tie: 'start' }) + n('B4', 24, { chord: 1 }) + n('D5', 24, { chord: 1 }) + n('G4', 24, { tie: 'stop' }) + n('B4', 24, { chord: 1 }), { num: 6 }),
  m1(n('A4', 48) + n('C5', 48, { chord: 1 }) + n('E5', 48, { chord: 1 }), { num: 7 }),
  m1(n('F4', 12) + n('G4', 12) + n('A4', 12) + n('B4', 12), { num: 8 }),
  m1(n('C5', 12) + n('E5', 12) + n('G5', 12) + n('B5', 12), { num: 9 }),
  m1(n('D4', 24) + n('F4', 24, { chord: 1 }) + n('A4', 24, { chord: 1 }) + n('D5', 24, { chord: 1 }), { num: 10 }),
  m1(n('E5', 6) + n('G5', 6, { chord: 1 }) + n('B5', 6, { chord: 1 }) + n('E6', 6) + n('D6', 6) + n('B5', 6, { chord: 1 }) + n('G5', 6, { chord: 1 }) + n('E5', 6), { num: 11 }),
  m1(n('F4', 12) + n('A4', 12) + n('C5', 12) + n('E5', 12), { num: 12 }),
  m1(n('G4', 12) + n('B4', 12) + n('D5', 12) + n('F5', 12), { num: 13 }),
  m1(n('C4', 24) + n('G4', 24, { chord: 1 }) + n('C5', 24) + n('E5', 24, { chord: 1 }), { num: 14 }),
  m1(n('A4', 12) + n('C5', 12) + n('E5', 12) + n('A5', 12), { num: 15 }),
  m1(n('D5', 24) + n('F5', 24, { chord: 1 }) + n('A5', 24, { chord: 1 }) + n('D5', 24) + n('A5', 24, { chord: 1 }), { num: 16 }),
]

// P3 双声部 A：同谱表两声部 + 休止错位
const P3 = [
  m1(attrs({ div: D, fifths: 0, beats: 4, clefs: [['G', 2]] }) + w('P3 双声部 A', 1)
    + n('C5', 12, { voice: 1 }) + n('E5', 12, { voice: 1 }) + n('G5', 12, { voice: 1 }) + n('C6', 12, { voice: 1 })
    + n('C4', 12, { voice: 2 }) + n('D4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }), { num: 1 }),
  m1(n('D5', 12, { voice: 1 }) + r(12, { voice: 1 }) + n('E5', 24, { voice: 1 }) + rFull(2), { num: 2 }),
  m1(n('F5', 48, { voice: 1 }) + n('G3', 12, { voice: 2 }) + n('A3', 12, { voice: 2 }) + n('B3', 12, { voice: 2 }) + n('C4', 12, { voice: 2 }), { num: 3 }),
  m1(n('E5', 24, { voice: 1 }) + n('D5', 24, { voice: 1 }) + n('D4', 24, { voice: 2 }) + n('E4', 24, { voice: 2 }), { num: 4 }),
  m1(n('C5', 12, { voice: 1 }) + n('D5', 12, { voice: 1 }) + n('E5', 12, { voice: 1 }) + n('F5', 12, { voice: 1 })
    + n('F4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }) + n('D4', 12, { voice: 2 }) + n('C4', 12, { voice: 2 }), { num: 5 }),
  m1(n('G5', 24, { voice: 1 }) + r(24, { voice: 1 }) + n('A4', 24, { voice: 2 }) + r(24, { voice: 2 }), { num: 6 }),
  m1(n('B4', 12, { voice: 1 }) + n('C5', 12, { voice: 1 }) + n('D5', 12, { voice: 1 }) + n('E5', 12, { voice: 1 })
    + n('C5', 12, { voice: 2 }) + n('B4', 12, { voice: 2 }) + n('A4', 12, { voice: 2 }) + n('G4', 12, { voice: 2 }), { num: 7 }),
  m1(n('F5', 48, { voice: 1 }) + n('A4', 48, { voice: 2 }), { num: 8 }),
  m1(n('E5', 12, { voice: 1 }) + n('F5', 12, { voice: 1 }) + n('G5', 12, { voice: 1 }) + n('A5', 12, { voice: 1 })
    + r(12, { voice: 2 }) + n('C5', 12, { voice: 2 }) + n('D5', 12, { voice: 2 }) + n('E5', 12, { voice: 2 }), { num: 9 }),
  m1(n('B5', 24, { voice: 1 }) + n('A5', 24, { voice: 1 }) + n('F4', 24, { voice: 2 }) + n('G4', 24, { voice: 2 }), { num: 10 }),
  m1(n('C6', 12, { voice: 1 }) + n('B5', 12, { voice: 1 }) + n('A5', 12, { voice: 1 }) + n('G5', 12, { voice: 1 })
    + n('E4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }) + n('G4', 12, { voice: 2 }) + n('A4', 12, { voice: 2 }), { num: 11 }),
  m1(n('F5', 48, { voice: 1 }) + n('B3', 48, { voice: 2 }), { num: 12 }),
  m1(n('E5', 12, { voice: 1 }) + n('D5', 12, { voice: 1 }) + n('C5', 12, { voice: 1 }) + n('B4', 12, { voice: 1 })
    + n('C4', 12, { voice: 2 }) + n('D4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }), { num: 13 }),
  m1(n('A4', 24, { voice: 1 }) + n('C5', 24, { voice: 1 }) + n('D4', 24, { voice: 2 }) + n('F4', 24, { voice: 2 }), { num: 14 }),
  m1(n('E5', 12, { voice: 1 }) + n('F5', 12, { voice: 1 }) + n('G5', 12, { voice: 1 }) + n('A5', 12, { voice: 1 })
    + n('G4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }) + n('D4', 12, { voice: 2 }), { num: 15 }),
  m1(n('C5', 48, { voice: 1 }) + n('C4', 48, { voice: 2 }), { num: 16 }),
]

// P4 双声部 B：声部交叉 + 切分 + 休止错位
const P4 = [
  m1(attrs({ div: D, fifths: 0, beats: 4, clefs: [['G', 2]] }) + w('P4 双声部 B · 声部交叉', 1)
    + n('C4', 48, { voice: 1 }) + n('G5', 48, { voice: 2 }) + n('E3', 48, { voice: 3 }), { num: 1 }),
  m1(n('D4', 12, { voice: 1 }) + n('E4', 12, { voice: 1 }) + n('F4', 12, { voice: 1 }) + n('G4', 12, { voice: 1 })
    + n('A5', 12, { voice: 2 }) + n('G5', 12, { voice: 2 }) + n('F5', 12, { voice: 2 }) + n('E5', 12, { voice: 2 }), { num: 2 }),
  m1(n('A4', 6, { voice: 1 }) + r(6, { voice: 1 }) + n('B4', 6, { voice: 1 }) + r(6, { voice: 1 })
    + n('C5', 6, { voice: 1 }) + r(6, { voice: 1 }) + n('D5', 6, { voice: 1 }) + r(6, { voice: 1 })
    + n('D5', 6, { voice: 2 }) + n('C5', 6, { voice: 2 }) + n('B4', 6, { voice: 2 }) + n('A4', 6, { voice: 2 })
    + n('G4', 6, { voice: 2 }) + n('A4', 6, { voice: 2 }) + n('B4', 6, { voice: 2 }) + n('C5', 6, { voice: 2 }), { num: 3 }),
  m1(n('E5', 24, { voice: 1 }) + n('C5', 24, { voice: 1 }) + n('A4', 24, { voice: 2 }) + n('F4', 24, { voice: 2 }), { num: 4 }),
  m1(n('G4', 12, { voice: 1 }) + n('A4', 12, { voice: 1 }) + n('B4', 12, { voice: 1 }) + n('C5', 12, { voice: 1 })
    + n('B3', 12, { voice: 2 }) + n('C4', 12, { voice: 2 }) + n('D4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }), { num: 5 }),
  m1(n('D5', 48, { voice: 1 }) + n('A3', 48, { voice: 2 }), { num: 6 }),
  m1(n('C5', 12, { voice: 1 }) + n('B4', 12, { voice: 1 }) + n('A4', 12, { voice: 1 }) + n('G4', 12, { voice: 1 })
    + n('C4', 12, { voice: 2 }) + n('D4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }), { num: 7 }),
  m1(n('E5', 24, { voice: 1 }) + n('G5', 24, { voice: 1 }) + n('G4', 24, { voice: 2 }) + n('B4', 24, { voice: 2 }), { num: 8 }),
  m1(n('A5', 12, { voice: 1 }) + r(12, { voice: 1 }) + n('G5', 12, { voice: 1 }) + n('F5', 12, { voice: 1 })
    + n('E4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }) + n('G4', 12, { voice: 2 }) + n('A4', 12, { voice: 2 }), { num: 9 }),
  m1(n('E5', 24, { voice: 1 }) + n('D5', 24, { voice: 1 }) + n('C5', 24, { voice: 2 }) + n('A4', 24, { voice: 2 }), { num: 10 }),
  m1(n('B4', 6, { voice: 1 }) + n('C5', 6, { voice: 1 }) + n('D5', 6, { voice: 1 }) + n('E5', 6, { voice: 1 })
    + n('F5', 6, { voice: 1 }) + n('E5', 6, { voice: 1 }) + n('D5', 6, { voice: 1 }) + n('C5', 6, { voice: 1 })
    + n('E4', 12, { voice: 2 }) + n('G4', 12, { voice: 2 }) + n('B4', 12, { voice: 2 }) + n('D5', 12, { voice: 2 }), { num: 11 }),
  m1(n('F5', 48, { voice: 1 }) + n('B3', 48, { voice: 2 }), { num: 12 }),
  m1(n('E5', 12, { voice: 1 }) + n('D5', 12, { voice: 1 }) + n('C5', 12, { voice: 1 }) + n('B4', 12, { voice: 1 })
    + n('A4', 12, { voice: 2 }) + n('G4', 12, { voice: 2 }) + n('F4', 12, { voice: 2 }) + n('E4', 12, { voice: 2 }), { num: 13 }),
  m1(n('D5', 24, { voice: 1 }) + n('F5', 24, { voice: 1 }) + n('D4', 24, { voice: 2 }) + n('A4', 24, { voice: 2 }), { num: 14 }),
  m1(n('G5', 8, { voice: 1 }) + n('F5', 8, { voice: 1 }) + n('E5', 8, { voice: 1 }) + n('D5', 8, { voice: 1 })
    + n('C5', 8, { voice: 1 }) + n('B4', 8, { voice: 1 })
    + n('G4', 12, { voice: 2 }) + n('A4', 12, { voice: 2 }) + n('B4', 12, { voice: 2 }) + n('C5', 12, { voice: 2 }), { num: 15 }),
  m1(n('C5', 48, { voice: 1 }) + n('E4', 48, { voice: 2 }), { num: 16 }),
]
