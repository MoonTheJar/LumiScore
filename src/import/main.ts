// ── 导入页（第 1 步）──
// 统一导入闸门：任意文件 → 流水线（识别 → 转 XML → 校验/矫正 → 反复展开
// → 标准 MIDI）→ 弹窗透明展示每一步与分级日志 → 进入第 2 步。
//
// 本地完成，文件不上传。推荐导入 MusicXML；也支持 MIDI（仅播放保留原声）。

import { unzipSync } from 'fflate'
import { applyI18n, onLocaleChange, t } from '../shell/i18n'
import { goStep, mountShell } from '../shell/shell'
import { openImportProcess } from '../shared/import-modal'
import { createRenderProgress } from '../shared/render-progress'
import { runImportPipeline, STAGE_NAMES } from '../shared/import-pipeline'
import type { Fmt } from '../shared/import-pipeline'
import { tryImportProjectZip, type ProjectImportResult } from '../shell/project-import'
import { PUB_ROOT } from '../shared/pub-root'

const statusEl = document.getElementById('status')!
const drop = document.getElementById('drop')!
const fileInput = document.getElementById('file')! as HTMLInputElement
const pickBtn = document.getElementById('pickBtn')!

mountShell({ step: 1 })

// 取消后后台流水线仍会跑完（转换/校验是异步的），其 setStatus 不该再覆盖
// 「已取消导入」。这个闸门只拦后续消息，取消当口的提示用 writeStatus 直写。
let statusSuppressed = false

function writeStatus(msg: string, kind: '' | 'ok' | 'err' = ''): void {
  statusEl.removeAttribute('data-i18n')
  statusEl.textContent = msg
  statusEl.className = 'sh-status p1-status' + (kind === 'ok' ? ' is-ok' : kind === 'err' ? ' is-err' : '')
  // 状态行默认隐藏，只有真正出现处理消息（嗅探/转换/取消/错误/完成）时才占位显示
  statusEl.hidden = false
}

function setStatus(msg: string, kind: '' | 'ok' | 'err' = ''): void {
  if (statusSuppressed) return
  writeStatus(msg, kind)
}

// ── 外部转换器：webmscore（MuseScore 引擎）+ MXL 解压 ─────────
interface WmsScore {
  saveXml(): Promise<string>
  saveMidi(midiExpandRepeats?: boolean): Promise<Uint8Array>
}
interface WmsModule {
  ready: Promise<void>
  load(
    fmt: string,
    data: Uint8Array,
    fonts?: Uint8Array[],
    doLayout?: boolean,
  ): Promise<WmsScore>
}
type StageFn = (frac: number, msg: string) => void

let warming: Promise<WmsModule> | null = null
/**
 * 预热 webmscore（引擎体积大）。onStage 把过程拆成三段报出去：
 * 取模块 → 初始化 wasm → 自检完成。以前是静默预热，用户在导入中途
 * 才撞上「调用 MuseScore 引擎转换中…」的长等待，像一次性卡死。
 */
function getWmscore(onStage?: StageFn): Promise<WmsModule> {
  if (!warming) {
    warming = (async () => {
      ;(window as unknown as { MSCORE_SCRIPT_URL?: string }).MSCORE_SCRIPT_URL = `${PUB_ROOT}webmscore/`
      onStage?.(0.1, t('p1.prog.dlEngine'))
      const mod = (await import('webmscore')).default as unknown as WmsModule
      onStage?.(0.62, t('p1.prog.wasmInit'))
      await mod.ready
      onStage?.(0.95, t('p1.prog.selfTest'))
      return mod
    })().catch((err: unknown) => {
      warming = null // 预热失败允许重试：真正用到时再把错误暴露出来
      throw err
    })
  }
  return warming
}

// 首次进入：进门就把预热进度摊开显示（小进度卡 pointer-events:none，不挡操作）。
// 导入区全程可用——真到导入时引擎通常已就绪，还没好也能继续等它报阶段。
const prog = createRenderProgress()
prog.show(t('p1.prog.prepEngine'))
getWmscore((frac, msg) => prog.set(frac, msg))
  .then(() => prog.done(t('p1.prog.ready')))
  .catch(() => prog.done(t('p1.prog.warmupLate')))
const WMS_LOAD_FMT: Record<string, string> = {
  mscz: 'mscz', mscx: 'mscx', mxl: 'mxl',
  gp: 'gp', gp3: 'gp3', gp4: 'gp4', gp5: 'gp5', gpx: 'gpx', gtp: 'gtp', ptb: 'ptb',
}

const externalConverter = {
  extractMxl(buf: Uint8Array): string | null {
    try {
      const files = unzipSync(buf)
      let xmlName = ''
      const container = files['META-INF/container.xml']
      if (container) {
        const m = /full-path="([^"]+)"/.exec(new TextDecoder().decode(container))
        if (m) xmlName = m[1]!
      }
      if (!xmlName) xmlName = Object.keys(files).find((n) => /\.(musicxml|xml)$/i.test(n)) ?? ''
      const data = files[xmlName]
      return data ? new TextDecoder().decode(data) : null
    } catch {
      return null
    }
  },
  async convert(fmt: Fmt, buf: Uint8Array): Promise<string> {
    setStatus(t('p1.status.musescore'))
    const W = await getWmscore()
    const m = await W.load(WMS_LOAD_FMT[fmt]!, buf)
    return m.saveXml()
  },
  async xmlToMidi(xml: string): Promise<Uint8Array> {
    const W = await getWmscore()
    // doLayout=false：只要 MIDI，跳过排版（官方称快约 3 倍）；第 1 参让引擎再做一次反复展开双保险
    const bytes = new TextEncoder().encode(xml)
    const m = await W.load('xml', bytes, undefined, false)
    return m.saveMidi(true)
  },
}

async function handleFile(f: File): Promise<void> {
  // 工程 zip（含 project.json）：直接还原工程并跳回导出步骤，不走单文件导入流水线。
  // 仅对 zip 容器（PK 头）尝试；不是工程包则交回流水线（mxl/mscz/gpx 同为 zip）。
  const head = new Uint8Array(await f.slice(0, 2).arrayBuffer())
  if (head[0] === 0x50 && head[1] === 0x4b) {
    let restored: ProjectImportResult | null
    try {
      restored = tryImportProjectZip(new Uint8Array(await f.arrayBuffer()))
    } catch (err) {
      setStatus(t('p1.status.projectFail', { err: String(err) }), 'err')
      return
    }
    if (restored) {
      setStatus(t('p1.status.projectRestored', { name: restored.name }), 'ok')
      const target = restored.step
      setTimeout(() => goStep(target as 1 | 2 | 3 | 4 | 5), 350)
      return
    }
  }
  statusSuppressed = false
  setStatus(t('p1.status.sniff'))
  const modal = openImportProcess(STAGE_NAMES, () => {
    statusSuppressed = true
    writeStatus(t('p1.status.cancelled'), '')
  })
  const goNext = (): void => {
    setStatus(t('p1.status.done'), 'ok')
    setTimeout(() => {
      goStep(2)
    }, 200)
  }
  try {
    const result = await runImportPipeline(f, modal, externalConverter, goNext)
    if (result.outcome === 'fatal' || result.outcome === 'unsupported') {
      setStatus(t('p1.status.incomplete'), 'err')
    }
  } catch (err) {
    modal.close()
    setStatus(t('p1.status.failed', { err: String(err) }), 'err')
  }
}

// ── 拖拽 / 点选 / 键盘：三种方式都打开文件选择或接收拖入 ──
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('is-over')
})
drop.addEventListener('dragleave', (e) => {
  // 拖进内部子元素（图标/文字）也会触发 dragleave，只有真正离开才撤高亮
  if (!drop.contains(e.relatedTarget as Node | null)) drop.classList.remove('is-over')
})
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('is-over')
  const f = (e as DragEvent).dataTransfer?.files?.[0]
  if (f) void handleFile(f)
})
drop.addEventListener('click', () => fileInput.click())
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fileInput.click()
  }
})
// 「或试试网络乐谱」：网络开源乐谱功能尚未接入，先留空占位。
// 注意别接到下方三张卡片上——那是内置示例乐谱，不是网络乐谱。
pickBtn.addEventListener('click', () => {
  // TODO: 接入网络开源乐谱检索/加载后再实现
})
// 三个示例卡片：数据包为 samples/<id>.md（内容是 MusicXML 文本，绕开 .mid/.xml 后缀限制）
document.querySelectorAll<HTMLButtonElement>('.p1-sample[data-sample]').forEach((btn) => {
  btn.addEventListener('click', () => void loadPackedSample(btn))
})
async function loadPackedSample(btn: HTMLButtonElement): Promise<void> {
  const fileId = btn.dataset.sample!
  // 标题已由 applyI18n 写成当前语言，直接取它当载入提示里的曲名（中英适配）
  const showName = btn.querySelector('.p1-sample__title')?.textContent?.trim() || fileId
  setStatus(t('p1.status.sample', { name: showName }))
  try {
    const res = await fetch(`${PUB_ROOT}samples/${fileId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const xmlText = await res.text()
    const file = new File([xmlText], `${showName}.musicxml`, {
      type: 'application/vnd.recordare.musicxml+xml',
    })
    await handleFile(file)
  } catch (err) {
    setStatus(t('p1.status.sampleFail', { err: String(err) }), 'err')
  }
}
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  if (f) void handleFile(f)
  fileInput.value = ''
})

applyI18n(document.body)
onLocaleChange(() => applyI18n(document.body))

// 装配完成上报：模块顶层求值到此全部走完。中途抛错时这两行不会执行，
// index.html 里的内联看门狗据此把「本页控件没装上」显式报出来（横幅 + 修复页签自检项），
// 而不是留下「页面看着正常、下拉全没了」的静默半初始化状态。
const reportAssembled = (
  window as unknown as { __lumiReady?: () => void }
).__lumiReady
reportAssembled?.()
