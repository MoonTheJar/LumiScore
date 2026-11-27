// 导入流水线（导入闸门）：
//   任意文件 → 识别并校验实际类型 → 非 XML 转 XML（XML 原样进入）
//   → 结构校验 / 自动矫正 / 反复展开 / Verovio 终检
//   → 由 webmscore（MuseScore 引擎）从最终 XML 导出标准 MIDI
//   → 写入 sessionStorage（原 MIDI 与标准 MIDI 各存一份）
//
// 关键约定：用户直接导入的 .mid 可在设置里选为「播放原 MIDI」，但绝不参与计算
// （量化成 XML 再转回会拉伸演奏事件）；计算一律使用 XML 经 MuseScore 导出的标准 MIDI。

// verovio 是 8MB 级的 wasm 包装，这里故意不做静态 import：ESM 要先把整张依赖图
// 下载并求值完才跑第一行代码，静态引它就等于让首页首屏白等几百毫秒（字和框都
// 还没长出来）。改成用到时动态引入，外壳/文案先到位，下载由导入弹窗的阶段列表显示。
import { midiToXml } from './midi-xml'
import {
  checkXmlStructure,
  autocorrectXml,
  expandRepeatsXml,
  verifyWithVerovio,
} from './score-preprocess'
import type { ImportLogs, ImportModalHandle } from './import-modal'

export type Fmt =
  | 'mid' | 'kar' | 'xml' | 'mxl' | 'mscz' | 'mscx'
  | 'gp' | 'gp3' | 'gp4' | 'gp5' | 'gpx' | 'gtp' | 'ptb' | 'unknown'

const GP_EXTS: Fmt[] = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'gtp', 'ptb']
const WMS_FMT: Partial<Record<Fmt, string>> = {
  mscz: 'mscz', mscx: 'mscx', mxl: 'mxl',
  gp: 'gp', gp3: 'gp3', gp4: 'gp4', gp5: 'gp5', gpx: 'gpx', gtp: 'gtp', ptb: 'ptb',
}

function ascii(buf: Uint8Array, off: number, len: number): string {
  let s = ''
  const end = Math.min(buf.length, off + len)
  for (let i = off; i < end; i++) s += String.fromCharCode(buf[i]!)
  return s
}
function readU16(buf: Uint8Array, off: number): number {
  return ((buf[off]! | (buf[off + 1]! << 8)) >>> 0)
}
function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0)
}
function zipEntryNames(buf: Uint8Array): string[] {
  const names: string[] = []
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      let p = readU32(buf, i + 16)
      while (p + 46 <= buf.length) {
        if (!(buf[p] === 0x50 && buf[p + 1] === 0x4b && buf[p + 2] === 0x01 && buf[p + 3] === 0x02)) break
        const nLen = readU16(buf, p + 28)
        const eLen = readU16(buf, p + 30)
        const mLen = readU16(buf, p + 32)
        names.push(ascii(buf, p + 46, nLen))
        p += 46 + nLen + eLen + mLen
      }
      break
    }
  }
  return names
}

export function detectFormat(buf: Uint8Array, ext: string): Fmt {
  const extL = ext.toLowerCase()
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const names = zipEntryNames(buf)
    if (names.some((n) => /\.mscx$/i.test(n))) return 'mscz'
    if (names.some((n) => /\.(musicxml|xml)$/i.test(n))) return 'mxl'
    if (extL === 'gpx') return 'gpx'
    if (extL === 'mscz') return 'mscz'
    if (extL === 'mxl') return 'mxl'
    return 'unknown'
  }
  if (ascii(buf, 0, 4) === 'MThd') return extL === 'kar' ? 'kar' : 'mid'
  const head = ascii(buf, 0, 8000).replace(/\0/g, '').trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<!DOCTYPE')) {
    const low = head.toLowerCase()
    if (low.includes('<score-partwise') || low.includes('<score-timewise')) return 'xml'
    if (low.includes('<musescore')) return 'mscx'
    if (low.includes('musicxml')) return 'xml'
    return 'mscx'
  }
  if (/fichier guitar pro|guitar pro|^gp\d|created with gp/i.test(ascii(buf, 0, 120))) {
    return GP_EXTS.includes(extL as Fmt) ? (extL as Fmt) : 'gp'
  }
  if (extL === 'xml' || extL === 'musicxml') return 'xml'
  if (extL === 'mid' || extL === 'midi' || extL === 'kar') return 'mid'
  if (GP_EXTS.includes(extL as Fmt)) return extL as Fmt
  return 'unknown'
}

export interface ExternalConverter {
  /** MXL 手动解压失败时也走这里；返回 MuseScore/webmscore 转出的 XML（其 MIDI 丢弃） */
  convert(fmt: Fmt, buf: Uint8Array): Promise<string>
  /** MXL 内嵌 MusicXML 解压（fflate）；失败返回 null */
  extractMxl(buf: Uint8Array): string | null
  /** 由最终 XML 经 MuseScore 引擎导出标准 MIDI（计算真源） */
  xmlToMidi(xml: string): Promise<Uint8Array>
}

export interface PipelineResult {
  outcome: 'perfect' | 'confirm' | 'fatal' | 'unsupported'
  logs: ImportLogs
}

const STAGE_NAMES = ['识别文件类型', '转换为 MusicXML', '校验与自动矫正', '展开反复记号', '生成标准 MIDI']

/**
 * 运行导入流水线。
 * @param modal 弹窗句柄（openImportProcess 已创建）
 * @param onApproved 允许进入下一步时回调：perfect 自动延时触发，confirm 由用户点“继续”触发
 */
export async function runImportPipeline(
  file: File,
  modal: ImportModalHandle,
  conv: ExternalConverter,
  onApproved: () => void,
): Promise<PipelineResult> {
  const logs: ImportLogs = { fatal: [], auto: [], repeat: [], ok: [] }
  const push = (k: keyof ImportLogs, msg: string): void => {
    logs[k].push(msg)
    modal.setLogs({ fatal: [...logs.fatal], auto: [...logs.auto], repeat: [...logs.repeat], ok: [...logs.ok] })
  }
  const setStage = (i: number, state: 'wait' | 'run' | 'done' | 'error', note?: string): void =>
    modal.setStage(i, state, note)
  const finish = (outcome: PipelineResult['outcome']): PipelineResult => ({ outcome, logs: { ...logs } })

  // ── 阶段 1：识别 ──
  setStage(0, 'run')
  const buf = new Uint8Array(await file.arrayBuffer())
  const ext = file.name.split('.').pop() ?? ''
  const fmt = detectFormat(buf.slice(0, 8192), ext)
  if (fmt === 'unknown') {
    setStage(0, 'error')
    modal.finish('unsupported', {
      hint: `抱歉，不支持当前文件（${file.name}）。支持 MIDI、MusicXML、MXL、MuseScore 与 GuitarPro。`,
    })
    return finish('unsupported')
  }
  setStage(0, 'done', fmt.toUpperCase())
  const name = file.name.replace(/\.[^.]+$/, '')

  // ── 阶段 2：转 XML ──
  setStage(1, 'run')
  let xml: string
  let midiOrig: Uint8Array | null = null
  try {
    if (fmt === 'xml') {
      xml = new TextDecoder().decode(buf)
      push('ok', '文件本身就是 MusicXML，直接进入校验')
    } else if (fmt === 'mid' || fmt === 'kar') {
      midiOrig = buf
      xml = midiToXml(buf, name)
      push('auto', 'MIDI → MusicXML：按音高/时间重建谱面（演奏细节不进谱面，原 MIDI 保留用于播放）')
    } else if (fmt === 'mxl') {
      xml = conv.extractMxl(buf) ?? (await conv.convert('mxl', buf))
      push('ok', 'MXL 压缩包已解包为 MusicXML')
    } else {
      xml = await conv.convert(fmt, buf)
      push('auto', `${ext.toUpperCase()} → MusicXML：由本地 MuseScore 引擎转换（转换结果以 XML 为计算真源）`)
    }
  } catch (err) {
    setStage(1, 'error')
    push('fatal', `转换失败：${String(err).slice(0, 200)}`)
    modal.finish('fatal')
    return finish('fatal')
  }
  setStage(1, 'done')

  // ── 阶段 3：结构校验 + 自动矫正 ──
  setStage(2, 'run')
  const structErr = checkXmlStructure(xml)
  if (structErr.length) {
    for (const e of structErr) push('fatal', e)
    setStage(2, 'error')
    modal.finish('fatal')
    return finish('fatal')
  }
  push('ok', 'MusicXML 结构完整（声部 / 小节 / 音符齐全）')
  const ac = autocorrectXml(xml)
  if (ac.fatal.length) {
    for (const e of ac.fatal) push('fatal', e)
    setStage(2, 'error')
    modal.finish('fatal')
    return finish('fatal')
  }
  for (const m of ac.auto) push('auto', m)
  for (const m of ac.ok) push('ok', m)
  xml = ac.xml
  setStage(2, 'done')

  // ── 阶段 4：反复展开 ──
  setStage(3, 'run')
  const ep = expandRepeatsXml(xml)
  for (const m of ep.repeat) push('repeat', m)
  if (!ep.repeat.length) push('ok', '没有需要展开的反复 / 跳转记号')
  xml = ep.xml
  if (ep.repeat.length) {
    // expandRepeats 克隆小节会复制音符 id，第三页按 id 绑 MIDI 时间时，重复段的音符会
    // 拿到错误时间、圆滑线/连音线点亮错乱；展开后重打一次 id，保证全局唯一。
    xml = autocorrectXml(xml).xml
  }
  setStage(3, 'done')

  // ── Verovio 终检（渲染闸门） ──
  let tk: { loadData(x: string): boolean } | null = null
  try {
    // 用到才拉：这 8MB 不该压在首屏前面（见文件头的说明）
    const { default: createVerovioModule } = await import('verovio/wasm')
    const { VerovioToolkit: VrvToolkitClass } = await import('verovio/esm')
    const mod = await createVerovioModule()
    tk = new VrvToolkitClass(mod as never) as unknown as { loadData(x: string): boolean }
  } catch (err) {
    push('fatal', `渲染引擎初始化失败：${String(err).slice(0, 120)}`)
    modal.finish('fatal')
    return finish('fatal')
  }
  const vErr = verifyWithVerovio(tk, xml)
  if (vErr) {
    push('fatal', vErr)
    modal.finish('fatal')
    return finish('fatal')
  }
  push('ok', '渲染引擎校验通过')

  // ── 阶段 5：标准 MIDI（计算真源，由 MuseScore 引擎导出） ──
  setStage(4, 'run')
  let stdMidi: Uint8Array
  try {
    // 我们已在阶段 4 自行线性化反复记号；这里仍让引擎展开（midiExpandRepeats=true）双保险
    stdMidi = await conv.xmlToMidi(xml)
    push(
      'ok',
      midiOrig
        ? 'MuseScore 引擎已由校验后的 XML 导出标准 MIDI（用于计算）；原 MIDI 另存，可在设置里选为播放源'
        : 'MuseScore 引擎已由校验后的 XML 导出标准 MIDI（播放与计算共用）',
    )
  } catch (err) {
    push('fatal', `标准 MIDI 生成失败：${String(err).slice(0, 160)}`)
    setStage(4, 'error')
    modal.finish('fatal')
    return finish('fatal')
  }
  setStage(4, 'done')

  // ── 落盘延迟到用户批准（perfect 自动 / confirm 点“继续”）之后：
  //    用户在报告窗点取消 = 完全放弃，不覆盖当前会话数据 ──
  const toB64 = (bytes: Uint8Array): string => {
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    return btoa(bin)
  }
  const commit = (): void => {
    // 先算好全部载荷再写：toB64 本身可能因为超大文件耗很久，但不会抛配额错，
    // 放 try 外面可以避免把「编码慢」误报成「存储失败」
    const midiB64 = toB64(stdMidi)
    const origB64 = midiOrig ? toB64(midiOrig) : null
    try {
      sessionStorage.setItem('midee.name', name)
      sessionStorage.setItem('midee.xml', xml)
      sessionStorage.setItem('midee.midi', midiB64)
      if (origB64) sessionStorage.setItem('midee.midiOrig', origB64)
      else sessionStorage.removeItem('midee.midiOrig')
    } catch (err) {
      // 大谱常见：sessionStorage 一般只有 5MB，超了会抛 QuotaExceededError。
      // 写一半 = 给下游留下「新 XML 配旧 MIDI」的错配谱面，整套撤掉重头来更安全。
      for (const k of ['midee.name', 'midee.xml', 'midee.midi', 'midee.midiOrig']) {
        try {
          sessionStorage.removeItem(k)
        } catch {
          /* 连删都删不掉就只能放弃 */
        }
      }
      push(
        'fatal',
        `会话存储写入失败（谱面过大或浏览器禁用了 sessionStorage）：${String(err).slice(0, 120)}`,
      )
      setStage(4, 'error')
      modal.finish('fatal')
      return
    }
    // 新谱：清掉旧谱的视觉修改 / 排版 / 连线 / 冻结 path 谱面（防跳页读到旧谱）
    sessionStorage.removeItem('midee.symbolEdits')
    sessionStorage.removeItem('midee.layout')
    sessionStorage.removeItem('midee.links')
    sessionStorage.removeItem('midee.pathSvg')
    onApproved()
  }

  const hasChanges = logs.auto.length > 0 || logs.repeat.length > 0
  modal.finish(hasChanges ? 'confirm' : 'perfect', { onContinue: commit })
  return finish(hasChanges ? 'confirm' : 'perfect')
}

export { STAGE_NAMES }
