// 工程文件（.zip）导出：第二、三、五页共用。
// 完整工程包 = 声明 README（时间戳/偏好/已下载资源重下链接）+ 乐谱 XML/MIDI + 逐页累积数据 md
// + 机器可读 project.json（导入还原用，含会话数据/本机偏好/3D 场景设置/资源清单）。
// 用户可自由勾选导出内容。弹窗复用第五页导出弹窗的 .ex-* 样式（见 shell/export-shell.ts）。
import { zipSync, strToU8 } from 'fflate'
import { buildExportShell, h } from './export-shell'
import { t } from './i18n'
import {
  PROJECT_FILE,
  SURF_KEY,
  collectProjectState,
  type ProjectState,
} from './project-state'

export interface ProjectExportSelection {
  includeOrigMidi: boolean
  includeMidi: boolean
  includeXml: boolean
  /** 逐页累积数据 md（config/*.md） */
  includeConfig: boolean
  /** 本机偏好 + 3D 场景设置（project.json prefs/surf + README 偏好摘要） */
  includePrefs: boolean
  /** 第五页「工具 ▾ → 相机」状态（project.json cam：模式/视角/居中参数） */
  includeCam: boolean
  /** 第五页「工具 ▾ → 时间」设置（project.json time：首尾留白/音画对齐） */
  includeTime: boolean
  /** 已下载资源清单（README 重下链接 + project.json resources） */
  includeResources: boolean
}

/** 文件名基名：曲名去掉非法字符 */
export function exportBaseName(): string {
  const raw = sessionStorage.getItem('midee.name')?.trim() || 'score'
  const clean = raw.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return clean || 'score'
}

/** base64（可带 dataURL 前缀）→ 二进制 */
function b64ToBytes(b64: string): Uint8Array {
  const pure = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
  const bin = atob(pure)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function prettyJson(raw: string | null): string {
  if (!raw) return '（无）'
  try {
    return `\`\`\`json\n${JSON.stringify(JSON.parse(raw), null, 2)}\n\`\`\``
  } catch {
    return `\`\`\`\n${raw}\n\`\`\``
  }
}

function bytesLen(raw: string | null): number {
  if (!raw) return 0
  try {
    return b64ToBytes(raw).length
  } catch {
    return 0
  }
}

// ── 逐页数据段（每段一个步骤；导出第 N 页文件时累积 1..N，满足「含上一页信息」） ──
function section1(): string {
  const name = read('midee.name') || '未命名'
  const midi = read('midee.midi')
  const orig = read('midee.midiOrig')
  const xml = read('midee.xml') || ''
  return `## 第 1 步 · 导入

- 曲名：${name}
- MusicXML：${xml ? `${new Blob([xml]).size} 字节` : '无'}
- 标准 MIDI：${midi ? `${bytesLen(midi)} 字节` : '无'}
- 原始 MIDI：${orig ? `${bytesLen(orig)} 字节` : '无（导入源未附带原始 MIDI）'}
- 符号编辑（midee.symbolEdits）：${read('midee.symbolEdits') ? '已记录' : '无'}
`
}

function section2(): string {
  return `## 第 2 步 · 2D 谱面排版

### 排版参数（midee.layout）
${prettyJson(read('midee.layout'))}

### 谱面标题覆盖（midee.scoreMeta）
${prettyJson(read('midee.scoreMeta'))}

### 符号视觉编辑（midee.symbolEdits）
${prettyJson(read('midee.symbolEdits'))}
`
}

function section3(): string {
  const links = read('midee.links')
  let summary = '（无）'
  try {
    const o = links ? JSON.parse(links) : null
    if (o && Array.isArray(o.paths)) {
      const paths = o.paths as Array<Record<string, unknown>>
      const rows = paths.map((p, i) => {
        const name = (p.name as string) || `路径 ${i + 1}`
        const color = (p.color as string) || '默认'
        const track = (p.trackKey as string) || '未绑定'
        const ay = `起 ${p.ayStart ?? '默认'} / 终 ${p.ayEnd ?? '默认'}`
        return `| ${i + 1} | ${name} | ${track} | ${color} | ${ay} |`
      })
      summary = [
        '| # | 名称 | 音轨 | 颜色 | 首尾锚点 |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n')
    }
  } catch {
    summary = '（解析失败，原始数据见下方）'
  }
  return `## 第 3 步 · 音轨连线

### 路径概览
${summary}

### 原始数据（midee.links）
${prettyJson(links)}
`
}

function section4(): string {
  return `## 第 4 步 · 3D 轨迹配置

### 轨迹形状（midee.trajShape）
${prettyJson(read('midee.trajShape'))}
`
}

function section5(): string {
  const surfRaw = readLS(SURF_KEY)
  return `## 第 5 步 · 3D 预览与导出

### 3D 场景设置（midee.surf3d：球体/拖尾/光照/发光/起终点线/辅助线等）
${prettyJson(surfRaw)}

### 第三页路径在 3D 中的落地（midee.links）
${prettyJson(read('midee.links'))}
`
}

const SECTION: Record<number, () => string> = {
  1: section1,
  2: section2,
  3: section3,
  4: section4,
  5: section5,
}

const STEP_NAME: Record<number, string> = {
  1: '1-import',
  2: '2-layout',
  3: '3-links',
  4: '4-scene',
  5: '5-preview',
}

/** 第 step 页的累积数据 md：包含 1..step 全部段落（「哪一页保存的含上一页信息」） */
function cumulativeMd(step: number): string {
  const parts = [`# ${exportBaseName()} · 工程数据（截至第 ${step} 步）`, '']
  for (let s = 1; s <= step; s++) {
    const fn = SECTION[s]
    if (fn) parts.push(fn())
  }
  parts.push('> 机器可读完整状态见 `project.json`（导入工程时由它还原）。')
  return parts.join('\n\n')
}

const PREF_LABEL: Record<string, string> = {
  'midee.theme': '主题（light/dark/system）',
  'midee.motion': '动效（reduced/full）',
  'midee.accent': '强调色',
  'midee.locale': '语言',
  'midee.playOriginal': '播放原始 MIDI',
  'midee.autoSoundfont': '自动下载音色',
  'midee.autoPoll': '自动轮询镜像',
  'midee.downloadMirror': '下载镜像序号',
  'midee.volume': '音量',
  'midee.speed': '播放速度',
  'midee.trailPct': '拖尾长度 %',
  'midee.avOffset': '音画对齐（秒）',
}

/** 声明 README：项目信息 + 时间戳 + 偏好摘要 + 已下载资源重下链接 + 目录 + 导入说明 */
function readmeMd(step: number, eff: ProjectExportSelection, state: ProjectState): string {
  const base = exportBaseName()
  const entries: string[] = []
  if (eff.includeXml) entries.push(`${base}.musicxml        MusicXML 乐谱`)
  if (eff.includeMidi) entries.push(`${base}.mid              标准 MIDI`)
  if (eff.includeOrigMidi) entries.push(`${base}.orig.mid         原始 MIDI`)
  entries.push(`${PROJECT_FILE}           机器可读完整状态（导入还原用）`)
  if (eff.includeConfig) entries.push('config/                 逐页累积数据说明（Markdown）')
  entries.push('README.md               本文件')

  const prefLines: string[] = []
  if (eff.includePrefs) {
    for (const [k, label] of Object.entries(PREF_LABEL)) {
      const v = state.prefs[k]
      if (v !== undefined) prefLines.push(`- ${label}：\`${v}\``)
    }
  }

  const resLines: string[] = []
  if (eff.includeResources && state.resources.length) {
    resLines.push('| 类别 | 名称 | 大小 | 重下链接 |', '| --- | --- | --- | --- |')
    for (const r of state.resources) {
      const size = r.bytes ? `${(r.bytes / 1024 / 1024).toFixed(2)} MB` : '—'
      const link = r.url ? `[下载](${r.url})` : '程序自动管理'
      resLines.push(`| ${r.category} | ${r.name || r.id} | ${size} | ${link} |`)
    }
  }

  return `# ${base} · 星跃谱工程文件

- 应用：${state.app}
- 导出时间：${state.exportedAt}
- 导出时所在步骤：第 ${step} 步
- 工程格式版本：${state.version}

## 目录

\`\`\`
${entries.join('\n')}
\`\`\`

${prefLines.length ? `## 本机偏好\n\n${prefLines.join('\n')}\n` : ''}
${resLines.length ? `## 已下载资源（可一键重下）\n\n${resLines.join('\n')}\n` : ''}
## 导入说明

- 在星跃谱「导入」页直接拖入本 \`.zip\`，即可还原乐谱、各页数据与设置，并跳回导出时所在步骤。
- \`config/\` 下的 md 按 \`1-import\` → \`5-preview\` 累积排列，第 N 页文件包含第 1..N 页的全部信息。
- 3D 场景设置（球体/拖尾/光照/发光/起终点线/辅助线，含逐路径调参）随 \`project.json\` 的 \`surf\` 字段保存与还原。
- 相机状态（模式/视角/居中参数）与时间设置（首尾留白/音画对齐）分别随 \`cam\` / \`time\` 字段保存与还原。
- 资源（音色/贴图）不打包进 zip，按上表链接重下即可。
`
}

/** 组装 zip 字节 */
export function buildProjectZip(step: number, sel: ProjectExportSelection): Uint8Array {
  const base = exportBaseName()
  const files: Record<string, Uint8Array> = {}

  const xml = read('midee.xml')
  const midi = read('midee.midi')
  const orig = read('midee.midiOrig')
  // 勾选但会话里没有对应数据时按「未包含」处理，README 与实际内容保持一致
  const eff: ProjectExportSelection = {
    includeXml: sel.includeXml && !!xml,
    includeMidi: sel.includeMidi && !!midi,
    includeOrigMidi: sel.includeOrigMidi && !!orig,
    includeConfig: sel.includeConfig,
    includePrefs: sel.includePrefs,
    includeCam: sel.includeCam,
    includeTime: sel.includeTime,
    includeResources: sel.includeResources,
  }

  if (eff.includeXml && xml) files[`${base}.musicxml`] = strToU8(xml)
  if (eff.includeMidi && midi) files[`${base}.mid`] = b64ToBytes(midi)
  if (eff.includeOrigMidi && orig) files[`${base}.orig.mid`] = b64ToBytes(orig)

  // 机器可读状态：导入还原的主干，始终包含会话工程数据；偏好/资源按勾选
  const state = collectProjectState(step, {
    prefs: eff.includePrefs,
    resources: eff.includeResources,
    cam: eff.includeCam,
    time: eff.includeTime,
  })
  files[PROJECT_FILE] = strToU8(JSON.stringify(state, null, 2))

  if (eff.includeConfig) {
    for (let s = 1; s <= step; s++) {
      files[`config/${STEP_NAME[s]}.md`] = strToU8(cumulativeMd(s))
    }
  }
  files['README.md'] = strToU8(readmeMd(step, eff, state))

  return zipSync(files, { level: 6 })
}

/** 生成并下载 zip */
export async function downloadProjectZip(
  step: number,
  sel: ProjectExportSelection,
): Promise<void> {
  const data = buildProjectZip(step, sel)
  const blob = new Blob([data as unknown as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${exportBaseName()}.zip`
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const ICON_PROJECT =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2.2h7.8a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/><path d="M8 12.5h8M8 15.8h5"/></svg>'
const ICON_VIDEO =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.5" width="14" height="13" rx="2.5"/><path d="M16.5 10l5-3v10l-5-3z"/></svg>'

let projectModal: HTMLElement | null = null
/** 上一实例的收尾（移除 Esc 监听等），重开前先清干净，避免监听泄漏 */
let closeProjectModal: (() => void) | null = null

/**
 * 第二 / 三 / 五页的导出弹窗：观感与第五页导出弹窗一致。
 * 只有「工程文件」可用，视频项禁用并标注「不支持」。
 */
export function openProjectExportDialog(step: number): void {
  closeProjectModal?.()
  const sel: ProjectExportSelection = {
    includeOrigMidi: true,
    includeMidi: true,
    includeXml: true,
    includeConfig: true,
    includePrefs: true,
    includeCam: true,
    includeTime: true,
    includeResources: true,
  }

  const { wrap, body, closeBtn, cancelBtn, exportBtn, progWrap, progFill, progNote } = buildExportShell()

  const left = h('div', 'ex-left')
  const kindLabel = h('div', 'ex-sec-label')
  kindLabel.textContent = t('ex.options')

  const kindList = h('div', 'ex-kinds')
  const projectKind = h('button', 'ex-kind ex-kind--on')
  projectKind.type = 'button'
  projectKind.innerHTML = `<span class="ex-kind__icon">${ICON_PROJECT}</span><span>${t('ex.kind.project')}</span>`
  const videoKind = h('button', 'ex-kind ex-kind--off')
  videoKind.type = 'button'
  videoKind.disabled = true
  videoKind.innerHTML = `<span class="ex-kind__icon">${ICON_VIDEO}</span><span>${t('ex.kind.video')}</span><span class="ex-kind__tag">${t('ex.unsupportedShort')}</span>`
  kindList.append(projectKind, videoKind)

  const descLabel = h('div', 'ex-sec-label')
  descLabel.textContent = t('ex.about')
  const desc = h('div', 'ex-desc')
  desc.textContent = t('ex.projectDesc')
  const prevLabel = h('div', 'ex-sec-label')
  prevLabel.textContent = t('ex.contentTitle')
  const prevBox = h('div', 'ex-preview')
  const prevPh = h('div', 'ex-preview__ph')
  prevPh.textContent = t('ex.projectPreview')
  prevBox.append(prevPh)
  left.append(kindLabel, kindList, descLabel, desc, prevLabel, prevBox)

  const right = h('div', 'ex-right')
  right.append(buildSettings())

  body.append(left, right)

  function close(): void {
    document.removeEventListener('keydown', onKey)
    if (projectModal === wrap) projectModal = null
    if (closeProjectModal === close) closeProjectModal = null
    wrap.remove()
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  document.addEventListener('keydown', onKey)
  closeBtn.addEventListener('click', close)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
  cancelBtn.addEventListener('click', close)

  function buildSettings(): HTMLElement {
    const box = h('div', 'ex-form')
    const secFormat = h('div', 'ex-sec-label')
    secFormat.textContent = t('ex.sec.format')
    const r1 = h('div', 'ex-row')
    const l1 = h('span', 'ex-row__label')
    l1.textContent = t('ex.row.projectFormat')
    const v1 = h('div', 'ex-select')
    v1.textContent = 'ZIP · 工程包'
    r1.append(l1, v1)
    const secContent = h('div', 'ex-sec-label')
    secContent.textContent = t('ex.sec.content')
    box.append(secFormat, r1, secContent)

    const items: Array<{ key: keyof ProjectExportSelection; labelKey: string; supported: boolean }> = [
      { key: 'includeXml', labelKey: 'ex.inc.xml', supported: !!read('midee.xml') },
      { key: 'includeMidi', labelKey: 'ex.inc.midi', supported: !!read('midee.midi') },
      { key: 'includeOrigMidi', labelKey: 'ex.inc.origMidi', supported: !!read('midee.midiOrig') },
      { key: 'includeConfig', labelKey: 'ex.inc.config', supported: true },
      { key: 'includePrefs', labelKey: 'ex.inc.prefs', supported: true },
      { key: 'includeCam', labelKey: 'ex.inc.cam', supported: true },
      { key: 'includeTime', labelKey: 'ex.inc.time', supported: true },
      { key: 'includeResources', labelKey: 'ex.inc.resources', supported: true },
    ]
    for (const it of items) {
      const lab = h('label', 'ex-check' + (it.supported ? '' : ' ex-check--off'))
      const input = h('input') as HTMLInputElement
      input.type = 'checkbox'
      input.checked = sel[it.key] && it.supported
      input.disabled = !it.supported
      input.addEventListener('change', () => {
        sel[it.key] = input.checked
      })
      const span = h('span')
      span.textContent = `${t(it.labelKey)}${it.supported ? '' : t('ex.unsupported')}`
      lab.append(input, span)
      box.append(lab)
    }

    const note = h('div', 'ex-note')
    note.textContent = t('ex.projectNote')
    box.append(note)
    return box
  }

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true
    progWrap.hidden = false
    progFill.style.width = '10%'
    progNote.textContent = t('ex.gatherProject')
    try {
      await downloadProjectZip(step, sel)
      progFill.style.width = '100%'
      progNote.textContent = t('ex.done')
      setTimeout(close, 1200)
    } catch (err) {
      progFill.style.width = '0%'
      progNote.textContent = t('ex.failed', { msg: (err as Error)?.message || String(err) })
      exportBtn.disabled = false
    }
  })

  projectModal = wrap
  closeProjectModal = close
  document.body.append(wrap)
  exportBtn.focus()
}