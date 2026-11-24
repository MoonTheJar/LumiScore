// ── 自动连线纯函数核心（移植自 3dtest-copy r44，零 DOM 渲染依赖）──────────────
// 六策略 = scope('voice' | 'voiceStable' | 'staff') × succ('onset' | 'release')。
// 索引即节点 id：heads 数组下标（rest 占位但不参与成链，tieCont 延续音也剔除）。
// 参考：3dtest-copy/自动连线策略移植清单.md

export type AutoScope = 'voice' | 'voiceStable' | 'staff'
export type AutoSucc = 'onset' | 'release'
export interface AutoPolicy { scope: AutoScope; succ: AutoSucc }
export interface AutoEdge { from: number; to: number; kind: 'strong'; why: string }
export interface AutoGraph { edges: AutoEdge[]; chain: AutoEdge[]; terminals: Set<number> }

export const DEFAULT_AUTO_POLICY: AutoPolicy = { scope: 'voiceStable', succ: 'onset' }

export interface XmlHead {
  part: number; measure: number; staff: number; voice: string
  onset: number // 四分音符数（跨小节累计）
  dur: number // 四分音符数
  chord: boolean; rest: boolean; grace: boolean
  graceRole: 'PRE' | 'POST' | 'BRIDGE' | 'UNKNOWN' | null
  graceMainId: string | null
  graceOrder: number
  tieStart: boolean; tieStop: boolean; tieCont: boolean
  midi: number | null
  noteId: string
}

const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
function midiOf(step: string, oct: number, alter: number): number {
  return (oct + 1) * 12 + (STEP_SEMI[step] ?? 0) + alter
}

function timeSigQuarters(beatsTxt: string, beatTypeTxt: string): number | null {
  const bs = beatsTxt.split('+').map((s) => parseInt(s.trim(), 10))
  const tss = beatTypeTxt.split('+').map((s) => parseInt(s.trim(), 10))
  if (!bs.length || bs.some((v) => !Number.isInteger(v) || v <= 0)) return null
  if (!tss.length || tss.some((v) => !Number.isInteger(v) || v <= 0)) return null
  let total = 0
  if (tss.length === 1) {
    for (const b of bs) total += (4 * b) / tss[0]!
  } else if (tss.length === bs.length) {
    for (let i = 0; i < bs.length; i++) total += (4 * bs[i]!) / tss[i]!
  } else return null
  return total
}
function measureTimeSigs(mEl: Element): { beats: string; beatType: string }[] {
  const sigs: { beats: string; beatType: string }[] = []
  for (const at of Array.from(mEl.getElementsByTagName('attributes'))) {
    const b = at.getElementsByTagName('beats')[0]?.textContent?.trim()
    const ty = at.getElementsByTagName('beat-type')[0]?.textContent?.trim()
    if (b && ty) sigs.push({ beats: b, beatType: ty })
  }
  return sigs
}
function isPickupMeasure(mEl: Element): boolean {
  return mEl.getAttribute('implicit') === 'yes' || mEl.getAttribute('number') === '0'
}

/** MusicXML → Head 列表（与渲染 g.note@id 一一对应；rest 保留占位） */
export function parseXmlHeads(xml: string): XmlHead[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const out: XmlHead[] = []
  const parts = Array.from(doc.getElementsByTagName('part'))
  parts.forEach((part, pi) => {
    let div = 4
    let measureStart = 0
    let lastBarQ = 4
    const measures = Array.from(part.getElementsByTagName('measure'))
    const vx = new Map<string, number>()
    const vLastOnset = new Map<string, number>()
    const vStaff = new Map<string, number>()
    measures.forEach((m, mi) => {
      const pickup = isPickupMeasure(m)
      for (const at of Array.from(m.getElementsByTagName('attributes'))) {
        const d = at.getElementsByTagName('divisions')[0]
        if (d?.textContent) { const v = parseInt(d.textContent, 10); if (v > 0) div = v }
      }
      const sigs = measureTimeSigs(m)
      if (sigs.length) {
        let q = 0
        for (const s of sigs) q += timeSigQuarters(s.beats, s.beatType) ?? lastBarQ
        lastBarQ = q
      }
      const barQ = lastBarQ
      const prevVx = new Map(vx)
      const firstPos = new Map<string, number>()
      let g = measureStart
      let backedUp = false
      let lastSV = '1|1'
      for (const k of Array.from(m.children)) {
        const tag = k.tagName
        if (tag === 'backup') {
          const bd = k.getElementsByTagName('duration')[0]?.textContent
          if (bd) { g -= parseInt(bd, 10) / div; backedUp = true }
          continue
        }
        if (tag === 'forward') {
          const fd = k.getElementsByTagName('duration')[0]?.textContent
          if (fd) {
            const q = parseInt(fd, 10) / div
            g += q
            const lv = vx.get(lastSV)
            if (lv !== undefined) vx.set(lastSV, lv + q)
          }
          continue
        }
        if (tag !== 'note') continue
        const durEl = k.getElementsByTagName('duration')[0]
        const durTicks = durEl?.textContent ? parseInt(durEl.textContent, 10) : div
        const chord = k.getElementsByTagName('chord').length > 0
        const rest = k.getElementsByTagName('rest').length > 0
        const grace = k.getElementsByTagName('grace').length > 0
        const qdur = grace ? 0 : durTicks / div
        const voiceEl = k.getElementsByTagName('voice')[0]
        const staffEl = k.getElementsByTagName('staff')[0]
        const v = voiceEl?.textContent?.trim() || '1'
        let s: number
        if (staffEl) { s = parseInt(staffEl.textContent ?? '1', 10) || 1; vStaff.set(v, s) }
        else s = vStaff.get(v) ?? 1
        const sv = `${s}|${v}`
        lastSV = sv
        let pos: number
        if (chord) {
          pos = vLastOnset.get(sv) ?? Math.max(measureStart, g)
        } else {
          const carried = vx.get(sv)
          pos = carried !== undefined && carried >= measureStart - 1e-6
            ? carried
            : (backedUp ? Math.max(g, measureStart) : measureStart)
          if (!prevVx.has(sv) || prevVx.get(sv)! < measureStart - 1e-6) firstPos.set(sv, Math.max(pos, measureStart))
          vx.set(sv, pos + qdur)
          vLastOnset.set(sv, pos)
          g += qdur
        }
        let tieStart = false, tieStop = false
        for (const tt of Array.from(k.getElementsByTagName('tie'))) {
          if (tt.getAttribute('type') === 'start') tieStart = true
          if (tt.getAttribute('type') === 'stop') tieStop = true
        }
        let midi: number | null = null
        const pEl = k.getElementsByTagName('pitch')[0]
        if (pEl) {
          const step = pEl.getElementsByTagName('step')[0]?.textContent?.trim() ?? null
          const o = parseInt(pEl.getElementsByTagName('octave')[0]?.textContent ?? '0', 10)
          const alter = parseInt(pEl.getElementsByTagName('alter')[0]?.textContent ?? '0', 10)
          if (step && Number.isFinite(o)) midi = midiOf(step, o, alter)
        }
        out.push({
          part: pi, measure: mi + 1, staff: s, voice: v,
          onset: pos, dur: qdur,
          chord, rest, grace,
          graceRole: null, graceMainId: null, graceOrder: 0,
          tieStart, tieStop, tieCont: false,
          midi, noteId: k.getAttribute('id') ?? '',
        })
      }
      let advance = barQ
      if (pickup) {
        let mx = 0
        for (const [v, end] of vx) {
          const start = prevVx.has(v) ? prevVx.get(v)! : firstPos.get(v)!
          if (Number.isFinite(start)) mx = Math.max(mx, end - start)
        }
        if (mx > 0) advance = mx
      }
      measureStart += advance
    })
  })
  // 倚音拓扑三层标注
  const lm = new Map<string, number[]>()
  out.forEach((h, i) => {
    if (h.rest) return
    const key = `${h.part}|${h.staff}|${h.voice}`
    const a = lm.get(key) ?? []
    a.push(i); lm.set(key, a)
  })
  for (const idxs of lm.values()) {
    let i = 0
    while (i < idxs.length) {
      if (!out[idxs[i]!]!.grace) { i++; continue }
      let j = i
      while (j < idxs.length && out[idxs[j]!]!.grace) j++
      const seg = idxs.slice(i, j)
      const nextMain = j < idxs.length ? out[idxs[j]!]! : null
      const prevMain = i > 0 ? out[idxs[i - 1]!]! : null
      let role: XmlHead['graceRole'] = 'UNKNOWN'
      if (nextMain && prevMain) role = 'BRIDGE'
      else if (nextMain) role = 'PRE'
      else if (prevMain) role = 'POST'
      const main = role === 'POST' ? prevMain : nextMain
      seg.forEach((si, k) => {
        const h = out[si]!
        h.graceRole = role
        h.graceMainId = main ? main.noteId : null
        h.graceOrder = k
      })
      i = j
    }
  }
  // tie 链合并：stop 音标 tieCont（不产生独立节点/端点/演奏事件）
  const openTie = new Map<string, XmlHead>()
  for (const h of out) {
    if (h.rest) continue
    const key = `${h.part}|${h.staff}|${h.voice}|${h.midi}`
    if (h.tieStart && !h.tieStop) openTie.set(key, h)
    else if (h.tieStop) {
      if (openTie.has(key)) h.tieCont = true
      if (!h.tieStart) openTie.delete(key)
    }
  }
  return out
}

// ── 自动图 ────────────────────────────────────────────────────
export function computeAutoGraph(hs: (XmlHead | null)[], policy: AutoPolicy): AutoGraph {
  const edges: AutoEdge[] = []
  const chain: AutoEdge[] = []
  const terminals = new Set<number>()
  const seen = new Set<string>()
  const outNodes = new Set<number>()
  const inNodes = new Set<number>()
  const allOutlets = new Set<number>()
  const push = (from: number, to: number, why: string, isChain = false): void => {
    if (from === to) return
    const k = `${from}>${to}`
    if (seen.has(k)) return
    seen.add(k)
    edges.push({ from, to, kind: 'strong', why })
    outNodes.add(from); inNodes.add(to)
    if (isChain) chain.push(edges[edges.length - 1]!)
  }
  const items: number[] = []
  hs.forEach((h, i) => { if (h && !h.rest && !h.tieCont) items.push(i) })

  const byDoc = (a: number, b: number): number =>
    hs[a]!.measure - hs[b]!.measure || hs[a]!.onset - hs[b]!.onset || a - b
  const groupsOf = (idxs: number[]): number[][] => {
    const sorted = [...idxs].sort(byDoc)
    const groups: number[][] = []
    for (const i of sorted) {
      const g0 = groups[groups.length - 1]
      if (g0 && hs[g0[0]!]!.measure === hs[i]!.measure && Math.abs(hs[g0[0]!]!.onset - hs[i]!.onset) < 1e-6) { g0.push(i); continue }
      groups.push([i])
    }
    return groups
  }
  const pitchOf = (i: number): number => hs[i]!.midi ?? 0
  const portSort = (a: number, b: number): number => pitchOf(a) - pitchOf(b) || a - b
  interface GrInfo { onset: number; sound: number[]; ins: number[]; outs: { node: number; owner: number }[] }

  const connectPorts = (
    S0: number[], T0: number[], base: string, isChain = true,
    guard: (s: number, t: number) => boolean,
    pitchAt: (i: number) => number = pitchOf,
  ): void => {
    const byP = (a: number, b: number): number => pitchAt(a) - pitchAt(b) || a - b
    const S = [...new Set(S0)].sort(byP)
    const T = [...new Set(T0)].sort(byP)
    if (!S.length || !T.length) return
    const N = S.length, M = T.length
    const pairs = new Set<string>()
    const add = (si: number, ti: number): void => {
      const s = S[si]!, t = T[ti]!
      if (s === t || !guard(s, t)) return
      pairs.add(`${si}>${ti}`)
    }
    for (let si = 0; si < N; si++) add(si, Math.min(M - 1, Math.floor(((2 * si + 1) * M) / (2 * N))))
    for (let ti = 0; ti < M; ti++) add(Math.min(N - 1, Math.floor(((2 * ti + 1) * N) / (2 * M))), ti)
    const cover = (dir: 's' | 't'): void => {
      const A = dir === 's' ? N : M
      const B = dir === 's' ? M : N
      const ratio = B / A
      const has = (a: number, b: number): boolean => (dir === 's' ? pairs.has(`${a}>${b}`) : pairs.has(`${b}>${a}`))
      const ok = (a: number, b: number): boolean => {
        const s = dir === 's' ? S[a]! : T[b]!
        const t = dir === 's' ? T[b]! : S[a]!
        return s !== t && guard(s, t)
      }
      const put = (a: number, b: number): void => { if (dir === 's') pairs.add(`${a}>${b}`); else pairs.add(`${b}>${a}`) }
      for (let a = 0; a < A; a++) {
        let covered = false
        for (let b = 0; b < B; b++) if (has(a, b)) { covered = true; break }
        if (covered) continue
        const ideal = (a + 0.5) * ratio - 0.5
        let pick = -1, best = Infinity
        for (let b2 = 0; b2 < B; b2++) {
          if (!ok(a, b2)) continue
          const d = Math.abs(b2 - ideal)
          if (d < best) { best = d; pick = b2 }
        }
        if (pick >= 0) put(a, pick)
      }
    }
    cover('s'); cover('t')
    const usedS = new Set<number>(), usedT = new Set<number>()
    pairs.forEach((k) => { const [si, ti] = k.split('>').map(Number) as [number, number]; usedS.add(si); usedT.add(ti) })
    const why = (): string => {
      const n = usedS.size, m = usedT.size
      if (n === 1 && m > 1) return `${base}·拆分（1→${m} 条并行）`
      if (n > 1 && m === 1) return `${base}·合并（${n}→1）`
      if (n > 1 && m > 1) return n === m ? `${base}·声线对接（${n} 条按音高各自进行）` : `${base}·拆分/合并（${n}→${m}，低音对低音）`
      return base
    }
    const w = why()
    pairs.forEach((k) => {
      const [si, ti] = k.split('>').map(Number) as [number, number]
      push(S[si]!, T[ti]!, w, isChain)
    })
  }

  const docBefore = (s: number, t: number): boolean => {
    const a = hs[s]!, b = hs[t]!
    return a.measure < b.measure || (a.measure === b.measure && b.onset >= a.onset - 1e-6)
  }
  const docStrictBefore = (s: number, t: number): boolean => {
    const a = hs[s]!, b = hs[t]!
    return a.measure < b.measure || (a.measure === b.measure && b.onset > a.onset + 1e-6)
  }

  const processStream = (
    idxs: number[],
    opts: { firstStart: boolean; baseOn: string; baseRel: string },
  ): GrInfo[] => {
    const groups = groupsOf(idxs)
    const infos: GrInfo[] = []
    const ownerOf = new Map<number, number>()
    for (const G of groups) {
      const sound = G.filter((i) => !hs[i]!.grace).sort(portSort)
      const pre = G.filter((i) => !hs[i]!.chord && (hs[i]!.graceRole === 'PRE' || hs[i]!.graceRole === 'BRIDGE'))
        .sort((a, b) => hs[a]!.graceOrder - hs[b]!.graceOrder)
      const posts = G.filter((i) => !hs[i]!.chord && hs[i]!.graceRole === 'POST')
        .sort((a, b) => hs[a]!.graceOrder - hs[b]!.graceOrder)
      const chordPre = G.filter((i) => hs[i]!.chord && (hs[i]!.graceRole === 'PRE' || hs[i]!.graceRole === 'BRIDGE'))
      const chordPost = G.filter((i) => hs[i]!.chord && hs[i]!.graceRole === 'POST')
      const rep = sound[0]
      if (pre.length) {
        const label = hs[pre[0]!]!.graceRole === 'BRIDGE' ? '夹心倚音' : '前倚音'
        for (let k = 1; k < pre.length; k++) push(pre[k - 1]!, pre[k]!, `${label}串行（grace_order）`)
        const tail = pre[pre.length - 1]!
        for (const p of sound) push(tail, p, sound.length > 1 ? `${label}→和弦各音（并行拆分）` : `${label}→主音`)
      }
      if (rep !== undefined) {
        for (const gp of chordPre) push(gp, rep, '前倚音（和弦式）')
        for (const gp of chordPost) push(rep, gp, '后倚音（和弦式）')
      }
      const tailOf = new Map<number, number>()
      for (const p of posts) {
        const gid = hs[p]!.graceMainId
        let owner = gid ? sound.find((mm) => hs[mm]!.noteId === gid) : undefined
        if (owner === undefined) owner = rep
        if (owner === undefined) continue
        const prev = tailOf.get(owner)
        push(prev ?? owner, p, prev === undefined ? '主音→后倚音' : '后倚音串行')
        tailOf.set(owner, p)
      }
      const ins: number[] = pre.length ? [pre[0]!]
        : sound.length ? [...sound]
        : posts.length ? [posts[0]!] : [...G]
      const outs: { node: number; owner: number }[] = sound.length
        ? sound.map((s) => ({ node: tailOf.get(s) ?? s, owner: s }))
        : posts.length ? [{ node: posts[posts.length - 1]!, owner: posts[posts.length - 1]! }] : []
      if (!sound.length && posts.length > 1) {
        for (let k = 1; k < posts.length; k++) push(posts[k - 1]!, posts[k]!, '无主音簇串行（末尾倚音）')
      }
      for (const o of outs) ownerOf.set(o.node, o.owner)
      infos.push({ onset: hs[G[0]!]!.onset, sound, ins, outs })
    }
    if (opts.firstStart && infos.length) {
      const g0 = infos[0]!
      const root = g0.sound[0]
      if (root !== undefined) for (const p of g0.sound) if (p !== root && !inNodes.has(p)) push(root, p, '起始和弦（并行起线）')
    }
    const pitchAtOut = (n: number): number => pitchOf(ownerOf.has(n) ? ownerOf.get(n)! : n)
    if (policy.succ === 'onset') {
      for (let gi = 0; gi < infos.length - 1; gi++) {
        connectPorts(infos[gi]!.outs.map((o) => o.node), infos[gi + 1]!.ins, opts.baseOn, true, docBefore, pitchAtOut)
      }
    } else {
      for (let gi = 0; gi < infos.length; gi++) {
        const byT = new Map<number, number[]>()
        for (const o of infos[gi]!.outs) {
          const rel = hs[o.owner]!.onset + hs[o.owner]!.dur
          let j = -1
          for (let k = gi + 1; k < infos.length; k++) {
            if (infos[k]!.onset >= rel - 1e-6) { j = k; break }
          }
          if (j >= 0) { const a = byT.get(j) ?? []; a.push(o.node); byT.set(j, a) }
        }
        for (const [j, S] of byT) connectPorts(S, infos[j]!.ins, opts.baseRel, true, docBefore, pitchAtOut)
      }
    }
    for (let gi = 1; gi < infos.length; gi++) {
      for (const t of infos[gi]!.ins) {
        if (inNodes.has(t)) continue
        let pick: number | null = null, bd = Infinity
        for (let k = gi - 1; k >= 0; k--) {
          for (const o of infos[k]!.outs) {
            if (!docBefore(o.node, t)) continue
            const d = Math.abs(pitchOf(o.node) - pitchOf(t))
            if (d < bd) { bd = d; pick = o.node }
          }
          if (pick !== null) break
        }
        if (pick !== null) push(pick, t, '声线补链（跨小节游标校正）', true)
      }
    }
    for (const g0 of infos) for (const o of g0.outs) allOutlets.add(o.node)
    return infos
  }
  const bucket = (map: Map<string, number[]>, k: string, i: number): void => {
    const a = map.get(k) ?? []
    a.push(i); map.set(k, a)
  }

  if (policy.scope === 'staff') {
    const streams = new Map<string, number[]>()
    for (const i of items) bucket(streams, `${hs[i]!.part}|${hs[i]!.staff}`, i)
    for (const idxs of streams.values()) {
      processStream(idxs, { firstStart: true, baseOn: '同谱表连续（下一音开始，可跨声部）', baseRel: '同谱表·演奏完成→最近的下一音' })
    }
  } else {
    const staves = new Map<string, number[]>()
    for (const i of items) bucket(staves, `${hs[i]!.part}|${hs[i]!.staff}`, i)
    for (const arr of staves.values()) {
      if (policy.scope === 'voice') {
        const streams = new Map<string, number[]>()
        for (const i of arr) bucket(streams, hs[i]!.voice, i)
        for (const idxs of streams.values()) {
          processStream(idxs, { firstStart: true, baseOn: '声部连续（下一音开始）', baseRel: '演奏完成→最近的下一音' })
        }
        continue
      }
      // voiceStable
      const measVoices = new Map<number, Set<string>>()
      for (const i of arr) {
        const h = hs[i]!
        const s = measVoices.get(h.measure) ?? new Set<string>()
        s.add(h.voice); measVoices.set(h.measure, s)
      }
      const measList = [...measVoices.keys()].sort((a, b) => a - b)
      const regimes: { meas: Set<number>; voices: Set<string> }[] = []
      const regimeOf = new Map<number, number>()
      for (const mn of measList) {
        const vs = measVoices.get(mn)!
        const last = regimes[regimes.length - 1]
        const same = !!last && last.voices.size === vs.size && [...vs].every((v) => last.voices.has(v))
        if (same) last!.meas.add(mn)
        else regimes.push({ meas: new Set([mn]), voices: new Set(vs) })
        regimeOf.set(mn, regimes.length - 1)
      }
      const sub = new Map<string, number[]>()
      for (const i of arr) bucket(sub, `${hs[i]!.voice}@${regimeOf.get(hs[i]!.measure)!}`, i)
      const infoMap = new Map<string, GrInfo[]>()
      for (const [key, idxs] of sub) {
        infoMap.set(key, processStream(idxs, {
          firstStart: key.endsWith('@0'),
          baseOn: '声部连续（下一音开始）',
          baseRel: '演奏完成→最近的下一音',
        }))
      }
      const ownerAt = new Map<number, number>()
      for (const infos of infoMap.values()) for (const G of infos) for (const o of G.outs) ownerAt.set(o.node, o.owner)
      const pitchAtB = (n: number): number => pitchOf(ownerAt.has(n) ? ownerAt.get(n)! : n)
      for (let ri = 0; ri < regimes.length - 1; ri++) {
        const R = regimes[ri]!, R2 = regimes[ri + 1]!
        const tail = (v: string): GrInfo | null => { const a = infoMap.get(`${v}@${ri}`); return a && a.length ? a[a.length - 1]! : null }
        const head = (v: string): GrInfo | null => { const a = infoMap.get(`${v}@${ri + 1}`); return a && a.length ? a[0]! : null }
        const label = `声部变化（${R.voices.size} 声部 → ${R2.voices.size} 声部）`
        for (const v of [...R.voices].filter((x) => R2.voices.has(x)).sort()) {
          const A = tail(v), B = head(v)
          if (A && B) connectPorts(A.outs.map((o) => o.node), B.ins, `声部「${v}」连续（跨稳定段）`, true, docBefore, pitchAtB)
        }
        const dying = [...R.voices].filter((v) => !R2.voices.has(v)).sort()
        const headPorts = [...R2.voices].flatMap((v) => head(v)?.ins ?? [])
        for (const v of dying) {
          const A = tail(v)
          if (!A) continue
          for (const o of A.outs) {
            let best: { t: number; meas: number; onset: number; d: number } | null = null
            for (const t of headPorts) {
              if (!docBefore(o.node, t)) continue
              const cand = { t, meas: hs[t]!.measure, onset: hs[t]!.onset, d: Math.abs(pitchOf(o.node) - pitchOf(t)) }
              if (!best || cand.meas < best.meas || (cand.meas === best.meas && cand.onset < best.onset)
                || (cand.meas === best.meas && cand.onset === best.onset && cand.d < best.d)) best = cand
            }
            if (best) push(o.node, best.t, `${label}·合并`, true)
          }
        }
        for (const t of headPorts) {
          if (inNodes.has(t)) continue
          const tv = hs[t]!.voice
          const score = (s: number) => ({ s, meas: hs[s]!.measure, onset: hs[s]!.onset, d: Math.abs(pitchOf(s) - pitchOf(t)) })
          const better = (c: { meas: number; onset: number; d: number }, b: { meas: number; onset: number; d: number } | null): boolean =>
            !b || c.meas > b.meas || (c.meas === b.meas && c.onset > b.onset)
            || (c.meas === b.meas && c.onset === b.onset && c.d < b.d)
          let pick: { s: number; meas: number; onset: number; d: number } | null = null
          for (const v of R.voices) {
            const A = tail(v)
            if (!A) continue
            for (const o of A.outs) {
              if (o.node === t || !docBefore(o.node, t)) continue
              const c = score(o.node)
              if (better(c, pick)) pick = c
            }
          }
          if (!pick) {
            for (const v of R2.voices) {
              if (v === tv) continue
              const a = infoMap.get(`${v}@${ri + 1}`)
              if (!a) continue
              for (const G of a) {
                for (const o of G.outs) {
                  if (o.node === t || !docBefore(o.node, t) || hs[o.node]!.measure > hs[t]!.measure) continue
                  const c = score(o.node)
                  if (better(c, pick)) pick = c
                }
              }
            }
          }
          if (!pick) {
            const mine = head(tv)
            const root = mine ? mine.ins[0] : null
            if (root !== undefined && root !== null && root !== t && !inNodes.has(t)) pick = score(root)
          }
          if (pick) push(pick.s, t, `${label}·拆分`, true)
        }
      }
      for (let ri = 0; ri < regimes.length; ri++) {
        for (const v of regimes[ri]!.voices) {
          const a = infoMap.get(`${v}@${ri}`)
          if (!a?.length) continue
          const existedBefore = ri > 0 && regimes.slice(0, ri).some((R0) => R0.voices.has(v))
          const existsAfter = ri < regimes.length - 1 && regimes.slice(ri + 1).some((R0) => R0.voices.has(v))
          if (!existedBefore) {
            const G0 = a[0]!
            for (const t of G0.ins) {
              if (inNodes.has(t)) continue
              let pick: { s: number; meas: number; onset: number; d: number } | null = null
              for (const v2 of regimes[ri]!.voices) {
                if (v2 === v) continue
                const b = infoMap.get(`${v2}@${ri}`)
                if (!b) continue
                for (const H of b) {
                  for (const o of H.outs) {
                    if (o.node === t || !docStrictBefore(o.node, t)) continue
                    const c = { s: o.node, meas: hs[o.node]!.measure, onset: H.onset, d: Math.abs(pitchOf(o.node) - pitchOf(t)) }
                    if (!pick || c.meas > pick.meas || (c.meas === pick.meas && c.onset > pick.onset)
                      || (c.meas === pick.meas && c.onset === pick.onset && c.d < pick.d)) pick = c
                  }
                }
              }
              if (pick) push(pick.s, t, `声部「${v}」进入（从中段最近的声线并行拆出）`, true)
            }
          }
          if (!existsAfter) {
            const Gz = a[a.length - 1]!
            for (const o of Gz.outs) {
              if (outNodes.has(o.node)) continue
              let pick: { t2: number; meas: number; onset: number; d: number } | null = null
              for (const v2 of regimes[ri]!.voices) {
                if (v2 === v) continue
                const b = infoMap.get(`${v2}@${ri}`)
                if (!b) continue
                for (const H of b) {
                  for (const t2 of H.ins) {
                    if (!docStrictBefore(o.node, t2)) continue
                    const c = { t2, meas: hs[t2]!.measure, onset: H.onset, d: Math.abs(pitchOf(o.node) - pitchOf(t2)) }
                    if (!pick || c.meas < pick.meas || (c.meas === pick.meas && c.onset < pick.onset)
                      || (c.meas === pick.meas && c.onset === pick.onset && c.d < pick.d)) pick = c
                  }
                }
              }
              if (pick) push(o.node, pick.t2, `声部「${v}」退出（并入中段最近的继续线）`, true)
            }
          }
        }
      }
    }
  }
  for (const o of allOutlets) if (!outNodes.has(o)) terminals.add(o)
  return { edges, chain, terminals }
}

// ── 策略持久化（按谱名） ────────────────────────────────────────
export function policyStoreKey(scoreName: string): string {
  return `midee.policy.${scoreName}`
}
export function loadAutoPolicy(scoreName: string): AutoPolicy {
  try {
    const o = JSON.parse(localStorage.getItem(policyStoreKey(scoreName)) ?? 'null')
    if (o && (o.scope === 'voice' || o.scope === 'voiceStable' || o.scope === 'staff')
      && (o.succ === 'onset' || o.succ === 'release')) return { scope: o.scope, succ: o.succ }
  } catch { /* 默认 */ }
  return { ...DEFAULT_AUTO_POLICY }
}
export function saveAutoPolicy(scoreName: string, p: AutoPolicy): void {
  try { localStorage.setItem(policyStoreKey(scoreName), JSON.stringify(p)) } catch { /* noop */ }
}

export const pairEq = (a: string, b: string, x: string, y: string): boolean =>
  (a === x && b === y) || (a === y && b === x)
