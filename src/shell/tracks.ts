// 顶栏「音轨」下拉的共享面板（2D / 3D 两页一致）。
//
// 按「总轨」分组（两级结构）：
//   · 一级 = 总轨：钢琴1 / 钢琴2 / 小提琴…——同乐器多总轨时按轨名里的
//     序号（「钢琴2 右手」→ 钢琴2）或出现顺序编号；单总轨只显示乐器名；
//   · 二级 = 总轨内的分谱：右手 / 左手 / 和弦 等，折叠挂在总轨下
//     （单轨总轨不可展开）；
//   · 一级行挂「音色」下拉（自动三级兜底 / 本地钢琴采样 / 合成器 /
//     GM 128 在线音色）与音源状态点：在线下载中显示进度条，兜底到
//     合成器时可点 ↻ 手动重新下载。二级行不加音色（跟随总轨）。
// 组行的静音/音量统管组内所有轨；展开后每子轨可单独静音/音量/（3D）点亮颜色。

import { t, onLocaleChange, getLocale } from './i18n'
import { bindTip, bindRangeTip } from './tooltip'
import type { MideePlayer, MidiTrack, SoundTarget } from '../3dpreview/player'
import { INSTRUMENT_NAMES, GM_CHINESE_NAMES, GM_FAMILY_NAMES, type InstrumentId } from '../3dpreview/instruments'
import { GM_PROGRAM_NAMES } from '../3dpreview/smplr-soundfont'
import { listDownloaded, subscribe as subscribeRes } from '../shared/resource-manager'

export interface TrackPanelOptions {
  getPlayer(): MideePlayer | null
  /** 显示每轨颜色选择器（仅 3D） */
  showColor?: boolean
  getColor?(index: number): number
  onColor?(index: number, hex: string): void
  /** 自定义轨名（来自第三页路径重命名）；返回 undefined 时回退到 MIDI 轨名 */
  getTrackName?(index: number): string | undefined
  /** 打开「下载资源」窗口（音色下拉的提示链接用） */
  onOpenCache?: () => void
}

export interface TrackPanelHandle {
  el: HTMLElement
  /** 播放器加载完成 / 换谱后重建 */
  refresh(): void
}

const EXPAND_KEY = 'midee.tracks.groupsExpanded'

function readExpanded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPAND_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? (raw as string[]) : [])
  } catch {
    return new Set()
  }
}
function writeExpanded(set: Set<string>): void {
  try {
    localStorage.setItem(EXPAND_KEY, JSON.stringify([...set]))
  } catch {
    /* noop */
  }
}

interface TrackGroup {
  /** 分组键：乐器 + 总轨序号（无序号 '_' 共享） */
  key: string
  /** 组显示名（钢琴 / 钢琴2 / 小提琴…） */
  label: string
  tracks: MidiTrack[]
}

// ── 分谱（声部）识别 ─────────────────────────────────────────
type Voice = 'right' | 'left' | 'chord' | 'tab' | 'main' | null
const RIGHT_HAND = /(右手|右\s*手|treble|\bright\b|\br\s*h\b|\br\.h\.?)/i
const LEFT_HAND = /(左手|左\s*手|bass clef|\bleft\b|\bl\s*h\b|\bl\.h\.?)/i
const CHORD_LIKE = /(和弦|和声|伴奏|伴唱|chord|accomp)/i
// 指法谱：MuseScore 导出 TAB 谱的轨名可能带 指法/TAB 字样；只用 tablature|\btabs?\b 防误配 "table"
const TAB_LIKE = /(指法谱|指法|六线谱|tablature|\btabs?\b)/i
const MAIN_LIKE = /(主谱|主旋律|主声部|\bmain\b|\blead\b|\bmelody\b)/i

function voiceOf(tr: MidiTrack): Voice {
  const n = tr.name?.trim() ?? ''
  if (RIGHT_HAND.test(n)) return 'right'
  if (LEFT_HAND.test(n)) return 'left'
  if (TAB_LIKE.test(n)) return 'tab'
  if (CHORD_LIKE.test(n)) return 'chord'
  if (MAIN_LIKE.test(n)) return 'main'
  return null
}

/** 中文数字 → 数值：「二」→2、「十二」→12、「二十」→20、「十」→10；解析失败 null */
function cnNumToInt(s: string): number | null {
  const D: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  let total = 0
  let unit = 0
  for (const ch of s) {
    const d = D[ch]
    if (d === undefined) return null
    if (d === 10) {
      total += (unit || 1) * 10
      unit = 0
    } else unit = d
  }
  return total + unit
}

/** 轨名中的总轨序号：「钢琴2 右手」→ 2、「Piano 1」→ 1、「吉他二」→ 2；无序号 → null */
function partSeq(tr: MidiTrack): number | null {
  const name = tr.name ?? ''
  const m = /(?:^|[^\d])(\d{1,2})(?!\d)/.exec(name)
  if (m) return Number.parseInt(m[1]!, 10)
  // 中文兜底：只认轨名末尾的中文数字（避免「二胡/三弦」里的字被误当序号）
  const cm = /([一二两三四五六七八九十]{1,3})\s*$/.exec(name.trim())
  if (cm) return cnNumToInt(cm[1]!)
  return null
}

/** 轨道乐器：识别的用映射结果；「右手/左手/和弦」分谱归入钢琴（tab/主谱保持原乐器，吉他指法谱必须归吉他） */
function instOf(tr: MidiTrack): InstrumentId {
  if (tr.instrumentKnown) return tr.instrumentId
  const v = voiceOf(tr)
  return v === 'right' || v === 'left' || v === 'chord' ? 'piano' : tr.instrumentId
}

const GM_FAMILY_LABELS_EN = [
  'Pianos', 'Chromatic Perc.', 'Organs', 'Guitars', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reeds', 'Pipes', 'Synth Lead', 'Synth Pad', 'Synth FX', 'Ethnic', 'Percussive', 'Sound FX',
]
function gmFamilyLabel(i: number): string {
  return getLocale() === 'en' ? (GM_FAMILY_LABELS_EN[i] ?? GM_FAMILY_NAMES[i] ?? '') : (GM_FAMILY_NAMES[i] ?? '')
}

export function createTrackPanel(opts: TrackPanelOptions): TrackPanelHandle {
  const box = document.createElement('div')
  box.className = 'sh-tracks'

  const emptyEl = document.createElement('div')
  emptyEl.className = 'sh-tracks__empty'
  box.append(emptyEl)

  // MideePlayer 不暴露静音读取，面板自己记一份
  const mutedIds = new Set<string>()
  // 各组展开状态（默认全部折叠）
  const expandedGroups = readExpanded()
  // 首次构建是否已应用过「含 和弦/指法谱/主谱 的大类自动展开」（只应用一次，之后尊重用户折叠）
  let defaultExpandApplied = false
  // 组音源 UI 更新器（局部刷新，避免整树重建打断 select 交互）
  const groupUIs = new Map<string, { update: () => void }>()

  function trackList(): MidiTrack[] {
    return opts.getPlayer()?.tracks ?? []
  }

  /**
   * 按「总轨」分组（保持首现顺序）：
   * 桶键 = 乐器 + 轨名序号（无序号共享 '_' 桶）；同乐器多桶才显示编号，
   * 编号优先用轨名带的序号，无序号桶按已用最大号递增。
   */
  function groupTracks(tracks: MidiTrack[]): TrackGroup[] {
    const buckets = new Map<string, { instId: InstrumentId; seq: number | null; tracks: MidiTrack[] }>()
    for (const tr of tracks) {
      const instId = instOf(tr)
      const seq = partSeq(tr)
      const key = `${instId}:${seq ?? '_'}`
      let b = buckets.get(key)
      if (!b) {
        b = { instId, seq, tracks: [] }
        buckets.set(key, b)
      }
      b.tracks.push(tr)
    }
    // 乐器内编号：带号桶用自身号，无号桶顺延；乐器只一桶则不编号
    const perInst = new Map<InstrumentId, number>() // 已用最大显示号
    const count = new Map<InstrumentId, number>()
    for (const b of buckets.values()) {
      count.set(b.instId, (count.get(b.instId) ?? 0) + 1)
    }
    const groups: TrackGroup[] = []
    for (const [key, b] of buckets) {
      let label = INSTRUMENT_NAMES[b.instId]
      if ((count.get(b.instId) ?? 0) > 1) {
        let no = b.seq ?? (perInst.get(b.instId) ?? 0) + 1
        if (!b.seq) {
          // 顺延号可能撞上后面带号桶，但显示不冲突即可（带号桶优先自身号）
          while ([...perInst.entries()].some(([k, v]) => k === b.instId && v === no)) no++
        }
        perInst.set(b.instId, Math.max(perInst.get(b.instId) ?? 0, no))
        label = `${INSTRUMENT_NAMES[b.instId]}${no}`
      } else {
        perInst.set(b.instId, 1)
      }
      groups.push({ key, label, tracks: b.tracks })
    }
    return groups
  }

  /** 子项显示名：分谱名（右手/左手/指法谱/和弦/主谱）优先，否则原名或组名+序号 */
  function subLabel(group: TrackGroup, tr: MidiTrack, i: number): string {
    const custom = opts.getTrackName?.(tr.channel)
    if (custom?.trim()) return custom
    if (group.tracks.length >= 2) {
      const v = voiceOf(tr)
      if (v === 'right') return t('tracks.rightHand')
      if (v === 'left') return t('tracks.leftHand')
      if (v === 'tab') return t('tracks.tab')
      if (v === 'chord') return t('tracks.chord')
      if (v === 'main') return t('tracks.main')
    }
    const raw = tr.name?.trim()
    if (raw && raw !== group.label) return raw
    if (group.tracks.length >= 2) return `${group.label} ${i + 1}`
    return group.label
  }

  function setMuted(id: string, muted: boolean): void {
    if (muted) mutedIds.add(id)
    else mutedIds.delete(id)
    opts.getPlayer()?.setTrackMute(id, muted)
  }

  function makeMute(trackIds: string[], tip: () => string): HTMLInputElement {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    bindTip(cb, tip)
    cb.addEventListener('change', () => {
      for (const id of trackIds) setMuted(id, cb.checked)
      refresh()
    })
    return cb
  }

  function makeVol(trackIds: string[]): HTMLInputElement {
    const r = document.createElement('input')
    r.type = 'range'
    r.className = 'sh-tracks__range'
    r.min = '0'
    r.max = '150'
    // 初始值读取该轨实际音量（默认 100%），避免 refresh 重建后把用户调过的音量复位
    const p = opts.getPlayer()
    const initV = p && trackIds[0] ? p.getTrackVolume(trackIds[0]!) : 1.0
    r.value = String(Math.round(initV * 100))
    bindRangeTip(r, () => `${t('tracks.volume')} ${r.value}%`)
    r.addEventListener('input', () => {
      const p = opts.getPlayer()
      if (!p) return
      for (const id of trackIds) p.setTrackVolume(id, Number(r.value) / 100)
    })
    return r
  }

  /** 组内是否全部静音（勾选组复选框） */
  function groupMuted(g: TrackGroup): boolean {
    return g.tracks.length > 0 && g.tracks.every((tr) => mutedIds.has(tr.id))
  }

  // ── 音色下拉 + 音源状态（每条子项独立；单选大类挂大类行） ──
  /** 当前下拉应显值：由该轨 target 推导 */
  function selectValueOf(tr: MidiTrack): string {
    const st = opts.getPlayer()?.getTrackSoundState(tr.id)
    const tg = st?.target
    if (!tg) return ''
    if (tg.kind === 'pianoSample') return '__piano'
    if (tg.kind === 'synth') return '__synth'
    if (tg.kind === 'online') return tg.sfName
    return ''
  }

  function targetOfValue(value: string): SoundTarget {
    if (value === '__piano') return { kind: 'pianoSample' }
    if (value === '__synth') return { kind: 'synth' }
    if (value) return { kind: 'online', sfName: value }
    return { kind: 'auto' }
  }

  // 自绘音色下拉的统一管理：一次只开一个，点外部/Esc 关闭（不依赖浏览器原生 select 弹层）
  let openDd: { el: HTMLElement; btn: HTMLButtonElement } | null = null
  document.addEventListener('pointerdown', (e) => {
    if (!openDd) return
    const t = e.target
    if (t instanceof Node && !openDd.el.contains(t) && t !== openDd.btn) {
      openDd.el.remove()
      openDd.btn.classList.remove('is-open')
      openDd = null
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDd) {
      openDd.el.remove()
      openDd.btn.classList.remove('is-open')
      openDd = null
    }
  })

  function buildSoundPick(tr: MidiTrack): { wrap: HTMLElement } {
    const wrap = document.createElement('span')
    wrap.className = 'sh-tracks__soundwrap'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sh-tracks__sound'
    btn.dataset.trackId = tr.id
    bindTip(btn, () => t('tracks.sound'))

    const curValue = (): string => selectValueOf(tr)
    const labelOf = (v: string): string => {
      if (v === '') return t('tracks.sound.auto')
      if (v === '__piano') return t('tracks.sound.piano')
      if (v === '__synth') return t('tracks.sound.synth')
      const res = listDownloaded('soundfont').find((s) => s.id === v)
      if (res) return res.label ?? res.name
      const idx = (GM_PROGRAM_NAMES as readonly string[]).indexOf(v)
      if (idx >= 0 && GM_CHINESE_NAMES[idx]) return `${GM_CHINESE_NAMES[idx]} · ${idx + 1}`
      return v
    }
    const paint = (): void => {
      btn.textContent = ''
      const sp = document.createElement('span')
      sp.className = 'sh-tracks__sound-label'
      sp.textContent = labelOf(curValue())
      const caret = document.createElement('span')
      caret.className = 'sh-tracks__sound-caret'
      caret.textContent = '▾'
      btn.append(sp, caret)
    }

    const close = (): void => {
      if (openDd?.btn === btn) {
        openDd.el.remove()
        openDd = null
        btn.classList.remove('is-open')
      }
    }
    const open = (): void => {
      close()
      const dd = document.createElement('div')
      dd.className = 'sh-tracks__dd'
      const cur = curValue()
      const downloaded = new Set(listDownloaded('soundfont').filter((s) => s.status === 'done').map((s) => s.id))
      const mkItem = (v: string, label: string): HTMLButtonElement => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'sh-tracks__dd-item' + (v === cur ? ' is-cur' : '')
        b.textContent = label
        b.addEventListener('click', () => {
          if (v === '__more') {
            opts.onOpenCache?.()
          } else {
            opts.getPlayer()?.setTrackSound([tr.id], targetOfValue(v))
            groupUIs.get(tr.id)?.update()
          }
          paint()
          close()
        })
        return b
      }
      const mkGrp = (label: string): HTMLElement => {
        const g = document.createElement('div')
        g.className = 'sh-tracks__dd-grp'
        g.textContent = label
        return g
      }
      dd.append(
        mkItem('', t('tracks.sound.auto')),
        mkItem('__piano', t('tracks.sound.piano')),
        mkItem('__synth', t('tracks.sound.synth')),
      )
      for (let fam = 0; fam < 16; fam++) {
        const items: HTMLButtonElement[] = []
        for (let k = 0; k < 8; k++) {
          const idx = fam * 8 + k
          const id = GM_PROGRAM_NAMES[idx] ?? `__${idx}`
          if (!downloaded.has(id) && id !== cur) continue
          items.push(mkItem(id, `${GM_CHINESE_NAMES[idx] ?? id} · ${idx + 1}`))
        }
        if (!items.length) continue
        dd.append(mkGrp(gmFamilyLabel(fam)), ...items)
      }
      // 固定的「下载更多音色」入口（不再是浏览器原生 select 弹层，跨浏览器样式一致）
      dd.append(mkGrp(t('tracks.sound.moreGroup')), mkItem('__more', t('tracks.sound.more')))

      document.body.append(dd)
      const r = btn.getBoundingClientRect()
      dd.style.position = 'fixed'
      dd.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`
      dd.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 340)}px`
      openDd = { el: dd, btn }
      btn.classList.add('is-open')
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (openDd?.btn === btn) close()
      else open()
    })
    paint()
    wrap.append(btn)
    return { wrap }
  }

  /**
   * 音源状态区：下载进度条 / 生效音源点 / 兜底到合成器时的手动下载按钮。
   * update() 只改本行 DOM，进度高频回调下不重建子项行。
   */
  function buildSoundStatus(tr: MidiTrack): { wrap: HTMLElement; update: () => void } {
    const wrap = document.createElement('span')
    wrap.className = 'sh-tracks__status'
    const update = (): void => {
      const p = opts.getPlayer()
      const st = p?.getTrackSoundState(tr.id) ?? null
      wrap.textContent = ''
      if (!st || !p) return
      if (st.source === 'loading') {
        if (st.progress != null) {
          const bar = document.createElement('span')
          bar.className = 'sh-tracks__prog'
          const fill = document.createElement('i')
          fill.style.width = `${Math.round(st.progress * 100)}%`
          bar.append(fill)
          bindTip(bar, () => `${t('tracks.sound.loading')} ${Math.round((st.progress ?? 0) * 100)}%`)
          wrap.append(bar)
        } else {
          const dot = document.createElement('span')
          dot.className = 'sh-tracks__src sh-tracks__src--loading'
          dot.textContent = '…'
          bindTip(dot, () => t('tracks.sound.loading'))
          wrap.append(dot)
        }
        return
      }
      const dot = document.createElement('span')
      dot.className = `sh-tracks__src sh-tracks__src--${st.source}`
      dot.textContent = '●'
      bindTip(dot, () => t(`tracks.sound.src.${st.source}`))
      wrap.append(dot)
      // 兜底到合成器（用户未主动选合成器）→ 给手动重新下载按钮
      if (st.source === 'synth' && st.target.kind !== 'synth') {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'sh-tracks__dl'
        btn.textContent = '↻'
        bindTip(btn, () => t('tracks.sound.download'))
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const tg = p.getTrackSoundState(tr.id)?.target
          const sf = tg?.kind === 'online' ? tg.sfName : tr.sfName
          if (!sf) return
          p.setTrackSound([tr.id], { kind: 'online', sfName: sf })
          update()
        })
        wrap.append(btn)
      }
    }
    update()
    return { wrap, update }
  }

  function buildGroup(g: TrackGroup): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'sh-tracks__group'
    const multi = g.tracks.length >= 2
    const isOpen = multi && expandedGroups.has(g.key)
    const ids = g.tracks.map((tr) => tr.id)

    // ── 大类行：▸ + 名称 + 聚合静音 + 聚合音量 ──
    // 音色/音源状态已下移到各子项（独立可调），大类行不再放组级音色。
    const row = document.createElement('div')
    row.className = 'sh-tracks__row sh-tracks__row--group'

    const expandBtn = document.createElement('button')
    expandBtn.type = 'button'
    expandBtn.className = 'sh-tracks__expand'
    expandBtn.textContent = isOpen ? '▾' : '▸'
    expandBtn.style.visibility = multi ? '' : 'hidden'
    if (multi) {
      bindTip(expandBtn, () => (isOpen ? t('tracks.collapse') : t('tracks.expand')))
      expandBtn.addEventListener('click', () => {
        if (expandedGroups.has(g.key)) expandedGroups.delete(g.key)
        else expandedGroups.add(g.key)
        writeExpanded(expandedGroups)
        refresh()
      })
    }

    const nameEl = document.createElement('span')
    nameEl.className = 'sh-tracks__name'
    // 单轨大类：若第三页给该路径设了自定义名，用它替换乐器名显示
    const soloCustom = g.tracks.length === 1 ? opts.getTrackName?.(g.tracks[0]!.channel) : undefined
    nameEl.textContent = soloCustom?.trim() || g.label
    nameEl.title = INSTRUMENT_NAMES[instOf(g.tracks[0]!)]

    const mute = makeMute(ids, () => t('tracks.muteAll'))
    mute.checked = groupMuted(g)
    mute.classList.add('sh-tracks__mute--group')
    const vol = makeVol(ids)

    // 单选大类：无子项可展开，音色下拉/状态直接内联在大类行（保持既有形态）
    if (!multi) {
      const solo = g.tracks[0]!
      const soundPick = buildSoundPick(solo)
      const soundSt = buildSoundStatus(solo)
      groupUIs.set(solo.id, { update: soundSt.update })
      row.append(expandBtn, nameEl, soundPick.wrap, soundSt.wrap, mute, vol)
      wrap.append(row)
      return wrap
    }

    row.append(expandBtn, nameEl, mute, vol)
    wrap.append(row)

    // ── 子项（展开才渲染）：每条 MIDI 轨 = 独立子项，音色/静音/音量/颜色各自可调 ──
    if (isOpen) {
      const sub = document.createElement('div')
      sub.className = 'sh-tracks__sub'
      g.tracks.forEach((tr, i) => {
        const r = document.createElement('div')
        r.className = 'sh-tracks__row'
        r.dataset.trackId = tr.id

        const spacer = document.createElement('span')
        spacer.className = 'sh-tracks__indent'

        const nm = document.createElement('span')
        nm.className = 'sh-tracks__name sh-tracks__name--sub'
        nm.textContent = subLabel(g, tr, i)

        const soundPick = buildSoundPick(tr)
        const soundSt = buildSoundStatus(tr)
        groupUIs.set(tr.id, { update: soundSt.update })

        const m = makeMute([tr.id], () => t('tracks.mute'))
        m.checked = mutedIds.has(tr.id)
        const v = makeVol([tr.id])

        r.append(spacer, nm, soundPick.wrap, soundSt.wrap, m, v)

        if (opts.showColor) {
          const color = document.createElement('input')
          color.type = 'color'
          color.className = 'sh-tracks__color'
          color.value = '#' + (opts.getColor?.(tr.channel) ?? 0).toString(16).padStart(6, '0')
          bindTip(color, () => t('tracks.color'))
          color.addEventListener('input', () => opts.onColor?.(tr.channel, color.value))
          r.append(color)
        }

        sub.append(r)
      })
      wrap.append(sub)
    }

    return wrap
  }

  function refresh(): void {
    const tracks = trackList()
    groupUIs.clear()
    // 重建面板时收起开着的自绘下拉（按钮已被重建）
    if (openDd) {
      openDd.el.remove()
      openDd = null
    }
    emptyEl.textContent = t('tracks.empty')
    emptyEl.hidden = tracks.length > 0
    // 首次构建到真实音轨时：含 和弦/指法谱/主谱 子项的大类默认展开，
    // 让这些子项不被藏起来（面板初建时 player 还没就绪、轨为空，必须在有轨后应用一次）
    if (!defaultExpandApplied && tracks.length > 0) {
      for (const g of groupTracks(tracks)) {
        if (g.tracks.length >= 2 && g.tracks.some((tr) => {
          const v = voiceOf(tr)
          return v === 'chord' || v === 'tab' || v === 'main'
        })) expandedGroups.add(g.key)
      }
      defaultExpandApplied = true
      writeExpanded(expandedGroups)
    }
    // 保留 emptyEl，重建其余组节点
    Array.from(box.querySelectorAll('.sh-tracks__group')).forEach((n) => n.remove())
    for (const g of groupTracks(tracks)) box.append(buildGroup(g))
    hookSound()
  }

  // 音源状态/进度变化 → 按 trackId 局部更新对应子项行（不重建面板，不打断 select）。
  // player 是延迟创建/可能换实例的：每次 refresh 校验，换了就重新订阅。
  let hookedPlayer: MideePlayer | null = null
  function hookSound(): void {
    const p = opts.getPlayer()
    if (!p || p === hookedPlayer) return
    hookedPlayer = p
    p.onTrackSound((ids) => {
      for (const id of ids) groupUIs.get(id)?.update()
    })
  }

  // 资源管理器变化（下载/删除音色）→ 仅当已下载音色集合变化时重建下拉，
  // 避免下载进度高频 emit 导致整面板反复重建。
  let lastSfIds = ''
  subscribeRes(() => {
    // 只比较「真正下载完成」的集合：排队/下载中状态变化不改下拉，
    // 而 idle/queued → done 的转变恰好改变该集合 → 触发重建，下载好的音色立刻出现
    const ids = listDownloaded('soundfont')
      .filter((s) => s.status === 'done')
      .map((s) => s.id)
      .sort()
      .join(',')
    if (ids !== lastSfIds) {
      lastSfIds = ids
      refresh()
    }
  })

  onLocaleChange(refresh)
  refresh()

  return { el: box, refresh }
}
