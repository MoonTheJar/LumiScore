// 统一界面外壳：顶栏（含收纳/下拉）+ 四步步骤条 + 设置 + 关于 + 帮助。
//
// 设计约定（后面加功能时照这个来）：
//   · 顶栏只放「品牌 / 曲名 / 步骤 / 四个图标入口」，页面自己的按钮一律
//     收纳进「工具 ▾」下拉，保持顶栏单行、精简。
//   · 设置 ▾ 是全局项（语言、主题、动效、清数据），与页面无关，四页一致。
//   · 关于 = 项目介绍 + 版权许可；帮助 = 四步流程 + 格式 + 快捷键 + 常见问题。
//   · 所有偏好写 localStorage，与主应用同键（midee.locale / midee.theme）。

import './shell.css'
import { applyI18n, getLocale, onLocaleChange, setLocale, t, type Locale } from './i18n'
import { bringToFront } from './layer'
import {
  attachBlankDrag,
  canvasRect,
  createDockRegistry,
  createEdgeLayer,
  isRichLayout,
  onRichChange,
  createSideDocks,
  type DockRegistry,
  type EdgeLayer,
  type Side,
  type SideSlot,
  type Size,
} from './dock'
import { createFloatingWindow, isPlayingNow, type FloatingHandle } from './floating'
import { bindRangeTip, bindTip } from './tooltip'
import { formatBytes, listCaches } from '../shared/cache-registry'
import { createAudioPrefs, type AudioPrefsHandle } from '../shared/audio-prefs-ui'
import { getNudgeSec, NUDGE_MAX, NUDGE_MIN, setNudgeSec } from '../shared/audio-prefs'
import {
	deleteResource,
	downloadResource,
	getDriver,
	listCategories,
	listDownloaded,
	listResources,
	redownloadResource,
	refreshInUse,
	subscribe as subscribeRes,
	type ResCategory,
	type ResState,
	type ResStatus,
} from '../shared/resource-manager'
// 导入贴图资源模块（副作用：注册 'texture' 分类，保证非 3D 页也能看到贴图）
import '../3dpreview/texture-resource'
import { ensureTextureCatalog } from '../3dpreview/texture-resource'
import { PUB_ROOT } from '../shared/pub-root'
import { icons } from '../ui/icons'

// 反馈入口：B站动态
const FEEDBACK_URL = 'https://b23.tv/uG8sv2m'
// 开源仓库
const GITHUB_URL = 'https://github.com/MoonTheJar/LumiScore'
const APP_VERSION = 'v0.1.6'

export type ShellStep = 1 | 2 | 3 | 4 | 5

/** 五个步骤的入口地址；步骤条回退与「下一步」都走这张表。 */
// 五个页面同处 pages/<步骤>/（dev 下为 src/<步骤>/，构建镜像一致），
// 用相对路径互跳：dev、独立打开、静态子目录部署均有效
export const STEP_URLS: Record<ShellStep, string> = {
  1: '../import/index.html',
  2: '../2dpreview/index.html',
  3: '../link2d/index.html',
  4: '../3dconfig/index.html',
  5: '../3dpreview/index.html',
}

// 切语言时同步浏览器标签标题（首屏由各页看门狗设置）。第4页不在本轮范围，留空由其自身管理。
const DOC_TITLE_KEYS: Partial<Record<ShellStep, string>> = {
  1: 'doc.title.1',
  2: 'doc.title.2',
  3: 'doc.title.3',
  5: 'doc.title.5',
}

/** 站内切页前的「离开守卫」：由当前挂载的外壳注入（见 mountShell 的 isDirty）。
 *  返回 true 表示可以离开；null 表示当前页没有守卫，直接放行。 */
let leaveGuard: (() => Promise<boolean>) | null = null
/** 当前外壳所在步骤；用于区分「前进」与「回退」——前进不会丢本页数据，不该弹提示 */
let mountedStep: ShellStep | null = null
/** goStep 已自行决定放行（前进免提示 / 回退已过确认框）：置位后本次切页触发的
 *  beforeunload 不再弹原生提示。否则前进会被原生框拦下（数据其实已存 sessionStorage、
 *  回退可恢复），回退会在确认框之后再弹一次原生框（双重提示）。刷新/关闭不经 goStep，
 *  此 flag 为 false，仍按 dirty 弹原生提示。 */
let stepNavigating = false

/**
 * 步骤跳转：在 lumiscore hash 外壳的 iframe 内时，通知外壳改 hash（不刷新外层、
 * URL 可前进后退）；dev/独立打开时退回普通整页跳转。已挂外壳时先过「离开守卫」。
 */
export function goStep(s: ShellStep): void {
  // 只有「回退」才可能丢数据；前进（下一步）本页内容已被下一页面读取，不弹提示
  const goingBack = mountedStep === null || s <= mountedStep
  if (leaveGuard && goingBack) {
    const guard = leaveGuard
    void guard().then((ok) => {
      if (ok) {
        stepNavigating = true // 已过确认框：切页触发的 beforeunload 不再重复弹原生框
        goStepNow(s)
      }
    })
    return
  }
  stepNavigating = true // 前进免提示（数据已持久化）；回退无守卫时也直接放行
  goStepNow(s)
}

/** 跳过离开守卫直接切页（清空数据等由外壳自身发起、不需要提示的场景） */
function goStepNow(s: ShellStep): void {
  const url = STEP_URLS[s]
  if (window.parent && window.parent !== window) {
    try {
      // 只向同源父壳投递（'*' 会向任意嵌入页泄露步骤信息）；非壳父页会忽略此消息，
      // 由下面的超时兜底保证无论父页是否响应都能完成导航。
      window.parent.postMessage({ lumiscore: 'nav', step: s }, location.origin)
    } catch {
      /* 跨域 postMessage 抛错时直接走兜底 */
    }
    // 父壳正常处理会换 iframe src 使本文档卸载；若 350ms 后仍在原地（父页非壳/未响应），
    // 自行硬跳转，避免导航静默失败。
    setTimeout(() => {
      window.location.href = url
    }, 350)
    return
  }
  window.location.href = url
}

export type ThemeMode = 'light' | 'dark' | 'system'
export interface ShellTool {
  id: string
  label: string
  /** 作为菜单项点击时执行 */
  run?: () => void
  /** 作为下拉内的自定义区块（例如相机面板） */
  node?: HTMLElement
}

export interface ShellNextItem {
  label: string
  /** 语言切换时自动重译 */
  labelKey?: string
  run: () => void
}

export interface ShellOptions {
  /** 当前步骤（决定步骤条高亮与可回退范围） */
  step: ShellStep
  /** 顶栏显示的曲名 */
  title?: string
  /** 收纳进「工具 ▾」的页面操作 */
  tools?: ShellTool[]
  /** 顶栏「音轨」下拉里挂的面板节点（2D/3D 播放页） */
  tracks?: HTMLElement
  /** 顶栏「画面比例」下拉里挂的面板节点（3D 页：裁剪辅助线） */
  aspect?: HTMLElement
  /** 顶栏最右侧的「下一步」；悬停展开 items（如导出 SVG） */
  next?: {
    onNext: () => void
    items?: ShellNextItem[]
  }
  /** 顶栏居中曲名被用户直接修改时回调（一般写入 midee.name 并同步页面） */
  onTitleRename?: (text: string) => void
  /** 追加到帮助弹窗末尾的页面专属说明（HTML 片段） */
  helpExtra?: string
  /** 当前页是否有未导出的改动：为真时，刷新走浏览器原生提示，站内切页弹确认框 */
  isDirty?: () => boolean
  /** 离开提示里点「工程文件」链接时调用（一般打开本页的导出弹窗） */
  onExport?: () => void
}

/** 页面把自己造好的悬浮窗登记进外壳，就能在「悬浮窗 ↔ 顶栏控件」之间切换 */
export interface ShellDockFloatSpec {
  /** 'player' / 'surf' 这类稳定 id，形态与位置都按它持久化 */
  id: string
  /** 顶栏悬停说明与悬浮窗标题（i18n key） */
  titleKey: string
  /** 顶栏图标 / 折叠小图标（同一枚 SVG，两套形态看着是同一个东西） */
  iconHTML: string
  /** 悬浮窗本体与它的内容（切形态时这块 DOM 在窗与下拉之间搬） */
  win: FloatingHandle
  host: HTMLElement
  /** 顶栏常驻的紧凑控件：播放那条用「六点 + 线框播放/暂停 + 无框秒数 + ∨」。
   *  控件里标了 data-dock-caret 的元素负责开合下拉，data-dock-grip 的负责被拖出顶栏。
   *  不传就是普通图标按钮 + 下拉。 */
  mini?: HTMLElement
  /** 钉在功能区最左（播放）；其余按钮不参与排序 */
  leftmost?: boolean
}

export interface ShellHandle {
  topbar: HTMLElement
  /** 注册一个可与顶栏控件互切换的页面悬浮窗 */
  dockFloat: (spec: ShellDockFloatSpec) => void
  setTitle: (text: string) => void
  setTools: (tools: ShellTool[]) => void
  openAbout: () => void
  openHelp: () => void
  /** 打开「下载资源」窗口 */
  openCache: () => void
}

// ── 图标 ─────────────────────────────────────────────────────
const SVG = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.3"/><path d="M12 17h.01"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h.01M12 12h.01M18 12h.01"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  tracks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M21 18h-1"/><circle cx="16" cy="6" r="2.2" fill="var(--sh-surface)"/><circle cx="10" cy="12" r="2.2" fill="var(--sh-surface)"/><circle cx="19" cy="18" r="2.2" fill="var(--sh-surface)"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  aspect:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5.5A2.5 2.5 0 0 1 5.5 3H7M17 3h1.5A2.5 2.5 0 0 1 21 5.5V7M21 17v1.5a2.5 2.5 0 0 1-2.5 2.5H17M7 21H5.5A2.5 2.5 0 0 1 3 18.5V17"/><rect x="7.5" y="7.5" width="9" height="9" rx="1" stroke-dasharray="2.6 2.2"/></svg>',
} as const

// ── 颜色主题（强调色；浅/深色各一套） ─────────────────────────
interface AccentTriple {
  light: [string, string, string]
  dark: [string, string, string]
}
const ACCENTS: Record<string, AccentTriple> = {
  blue: { light: ['#2f6bff', '#eaf0ff', '#ffffff'], dark: ['#7aa2ff', '#1b2740', '#0b0d13'] },
  purple: { light: ['#7c3aed', '#f0e9ff', '#ffffff'], dark: ['#a78bfa', '#2a1f45', '#140f20'] },
  green: { light: ['#0f9d58', '#e6f6ef', '#ffffff'], dark: ['#34d399', '#0f2e22', '#06140f'] },
  orange: { light: ['#ea580c', '#fdeee3', '#ffffff'], dark: ['#fb923c', '#3a2110', '#1a0f04'] },
  rose: { light: ['#e11d48', '#fde8ed', '#ffffff'], dark: ['#fb7185', '#3a1520', '#1a0a0e'] },
  cyan: { light: ['#0891b2', '#e1f4fa', '#ffffff'], dark: ['#22d3ee', '#0c2a33', '#04141a'] },
}
export type AccentId = keyof typeof ACCENTS

export function getAccent(): string {
  const v = readPref('midee.accent')
  return v && v in ACCENTS ? v : 'blue'
}
export function setAccent(id: string): void {
  if (!(id in ACCENTS)) return
  writePref('midee.accent', id)
  paintAccent()
}
function paintAccent(): void {
  document.documentElement.dataset.accent = getAccent()
}

function iconBtn(svg: string, ariaKey: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'sh-icon-btn'
  b.dataset.i18nAria = ariaKey
  b.innerHTML = svg
  addMenuLabel(b, ariaKey)
  // 宽屏/中窄屏只剩图标，靠悬停气泡说明；第二行与侧栏里文字已经写在按钮上了
  bindTip(b, () => {
    const lab = b.querySelector('.sh-menu__label')
    return lab && getComputedStyle(lab).display === 'none' ? t(ariaKey) : ''
  })
  return b
}

/**
 * 图标按钮里补一个文字标签：竖屏第二行与超宽屏侧栏里显示（CSS 控制显隐），
 * 宽屏只有图标、靠悬停气泡说明。
 */
function addMenuLabel(btn: HTMLElement, labelKey: string): void {
  const label = document.createElement('span')
  label.className = 'sh-menu__label'
  label.dataset.i18n = labelKey
  label.textContent = t(labelKey)
  btn.append(label)
}

// ── 偏好（主题 / 动效 / 顶栏收纳） ─────────────────────────────
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* noop */
  }
}

let media: MediaQueryList | null = null
function systemDark(): boolean {
  media ??= window.matchMedia('(prefers-color-scheme: dark)')
  return media.matches
}

export function getThemeMode(): ThemeMode {
  const v = readPref('midee.theme')
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/** 实际生效的深浅色：「跟随系统」+ 深色 OS 也是深色。
 *  凡是要按深浅色分支的地方都走这里，别只判 getThemeMode() === 'dark'。 */
export function isDarkTheme(): boolean {
  const mode = getThemeMode()
  return mode === 'dark' || (mode === 'system' && systemDark())
}

/** 黑底白谱是深色模式专属的显示反色：浅色模式下挂起（偏好仍留着，切回深色自动恢复），
 *  否则浅色界面配一张反色黑谱，顶栏/播放条还会被 body.dark2d 的选择器染成深色那套。 */
export function paintDark2d(): void {
  let on = false
  try {
    on = sessionStorage.getItem('midee.dark2d') === '1'
  } catch {
    /* noop */
  }
  document.body.classList.toggle('dark2d', on && isDarkTheme())
}

function paintTheme(): void {
  document.documentElement.dataset.theme = isDarkTheme() ? 'dark' : 'light'
  paintDark2d()
}

export function setThemeMode(mode: ThemeMode): void {
  writePref('midee.theme', mode)
  paintTheme()
}

function isReducedMotion(): boolean {
  return readPref('midee.motion') === 'reduced'
}
function setReducedMotion(v: boolean): void {
  writePref('midee.motion', v ? 'reduced' : 'full')
  document.documentElement.dataset.motion = v ? 'reduced' : 'full'
}

// ── 关于 / 帮助 内容 ─────────────────────────────────────────
/** 开源引用条目：name 可点击展开作者/协议/用途/主页 */
interface OssItem {
  name: string
  author: string
  license: string
  url: string
  use: string
  useEn: string
}
interface OssGroup {
  id: 'runtime' | 'audio' | 'fonts' | 'dev' | 'internal'
  items: OssItem[]
}
const OSS_GROUPS: OssGroup[] = [
  {
    id: 'runtime',
    items: [
      { name: 'three.js', author: 'mrdoob & contributors', license: 'MIT', url: 'https://github.com/mrdoob/three.js', use: 'WebGL 3D 渲染引擎：3D 乐谱空间、轨道相机与后处理', useEn: 'WebGL 3D engine: score space, rail camera, post-processing' },
      { name: 'three.quarks', author: 'alvinxyz', license: 'MIT', url: 'https://github.com/alvinxyz/three.quarks', use: 'GPU 粒子系统（音符绽放粒子）', useEn: 'GPU particle system (note bursts)' },
      { name: 'three.meshline', author: 'Jaume Sánchez (spite)', license: 'MIT', url: 'https://github.com/spite/three.meshline', use: '3D 轨迹线条渲染', useEn: '3D trail line rendering' },
      { name: 'pixi.js', author: 'PixiJS Team', license: 'MIT', url: 'https://github.com/pixijs/pixijs', use: '2D WebGL 渲染（2D 预览层）', useEn: '2D WebGL renderer (2D preview layer)' },
      { name: 'pixi-filters', author: 'PixiJS Team', license: 'MIT', url: 'https://github.com/pixijs/filters', use: 'Pixi 滤镜效果', useEn: 'Pixi filter effects' },
      { name: 'solid-js', author: 'Ryan Carniato & contributors', license: 'MIT', url: 'https://github.com/solidjs/solid', use: '响应式 UI 框架（主站）', useEn: 'Reactive UI framework (main site)' },
      { name: 'Tone.js', author: 'Yotam Mann', license: 'MIT', url: 'https://github.com/Tonejs/Tone.js', use: 'Web Audio 调度、合成器与采样播放', useEn: 'Web Audio scheduling, synths and samplers' },
      { name: '@tonejs/midi', author: 'Tone.js ecosystem', license: 'MIT', url: 'https://github.com/Tonejs/Tone.js', use: 'MIDI 文件解析', useEn: 'MIDI file parsing' },
      { name: 'smplr', author: 'danigb', license: 'MIT', url: 'https://github.com/danigb/smplr', use: '浏览器采样音源：在线 soundfont 加载与调度', useEn: 'Browser sampling: online soundfont loading' },
      { name: 'opentype.js', author: 'Nodebox & contributors', license: 'MIT', url: 'https://github.com/opentypejs/opentype.js', use: '字体轮廓解析（3D 文字挤出、谱面字形转 path）', useEn: 'Font glyph parsing (3D text extrusion, score paths)' },
      { name: 'fflate', author: '101arrowz', license: 'MIT', url: 'https://github.com/101arrowz/fflate', use: 'ZIP 解压（MXL / MuseScore 导入）', useEn: 'ZIP decompression (MXL / MuseScore import)' },
      { name: 'Verovio', author: 'RISM Digital', license: 'LGPL-3.0-or-later', url: 'https://github.com/rism-digital/verovio', use: '乐谱排版引擎（2D 谱面渲染）', useEn: 'Music engraving engine (2D score rendering)' },
      { name: 'webmscore', author: 'LibreScore', license: 'GPL-3.0', url: 'https://github.com/LibreScore/webmscore', use: '浏览器内嵌 MuseScore 引擎（mscz / GuitarPro 转换）', useEn: 'In-browser MuseScore engine (mscz / GuitarPro conversion)' },
      { name: 'MuseScore', author: 'MuseScore NV & contributors', license: 'GPL-3.0', url: 'https://github.com/musescore/MuseScore', use: 'MuseScore 格式解析与转换内核（经 webmscore 使用）', useEn: 'MuseScore format parsing core (via webmscore)' },
      { name: 'mediabunny', author: 'vanilagy', license: 'MPL-2.0', url: 'https://github.com/vanilagy/mediabunny', use: '音视频导入与转码', useEn: 'Audio/video import and transcoding' },
      { name: '@breezystack/lamejs', author: 'lamejs contributors', license: 'LGPL-3.0', url: 'https://github.com/breezystack/lamejs', use: 'MP3 编码（导出）', useEn: 'MP3 encoding (export)' },
      { name: '@tonaljs', author: 'danigb & contributors', license: 'MIT', url: 'https://github.com/tonaljs/tonal', use: '乐理库（和弦识别）', useEn: 'Music theory (chord detection)' },
      { name: 'zod', author: 'Colin McDonnell', license: 'MIT', url: 'https://github.com/colinhacks/zod', use: '运行时数据校验', useEn: 'Runtime data validation' },
      { name: 'VexFlow', author: 'VexFlow contributors', license: 'MIT', url: 'https://github.com/vexflow/vexflow', use: '乐谱渲染（2D 谱面 SVG 绘制）', useEn: 'Score rendering (2D SVG)' },
      { name: 'fonteditor-core', author: 'kekee000 & contributors', license: 'MIT', url: 'https://github.com/kekee000/fonteditor-core', use: '字体子集化（网络字体按需裁剪）', useEn: 'Font subsetting (on-demand web font trimming)' },
      { name: '@vercel/analytics', author: 'Vercel', license: 'MIT', url: 'https://github.com/vercel/analytics', use: '访问统计（匿名流量分析）', useEn: 'Analytics (anonymous traffic)' },
      { name: 'posthog-js', author: 'PostHog', license: '(Apache-2.0 AND MIT)', url: 'https://github.com/PostHog/posthog-js', use: '产品分析（可在设置中关闭）', useEn: 'Product analytics (can disable in settings)' },
      { name: '@t3-oss/env-core', author: 't3-oss', license: 'MIT', url: 'https://github.com/t3-oss/t3-env', use: '环境变量校验', useEn: 'Environment variable validation' },
      { name: 'events', author: 'Gozala', license: 'MIT', url: 'https://github.com/Gozala/events', use: 'Node events 浏览器 polyfill', useEn: 'Node events browser polyfill' },
    ],
  },
  {
    id: 'audio',
    items: [
      { name: 'midi-js-soundfonts (FluidR3_GM)', author: 'Immanuel Gleitz (整理) · Frank Wen (采样)', license: '可自由使用分发', url: 'https://github.com/gleitz/midi-js-soundfonts', use: '在线 GM 音色采样库（多镜像竞速下载）', useEn: 'Online GM soundfont samples (multi-mirror)' },
      { name: 'tonejs-instruments', author: 'nbrosowsky', license: 'MIT', url: 'https://github.com/nbrosowsky/tonejs-instruments', use: '本地钢琴采样来源（A1–A7 / C8，三级兜底第二级）', useEn: 'Local piano samples (tier-2 fallback)' },
      { name: 'Poly Haven Textures', author: 'Poly Haven', license: 'CC0', url: 'https://polyhaven.com/textures', use: '网络贴图（PBR：漫反射 / 法线 / 粗糙度），1K JPG 直链', useEn: 'Network PBR textures (diffuse / normal / roughness), 1K JPG' },
      { name: 'midee', author: 'midee project', license: 'MIT', url: '', use: '部分界面设计与艺术风格参考', useEn: 'Interface design & art reference' },
    ],
  },
  {
    id: 'fonts',
    items: [
      { name: 'Bravura', author: 'Steinberg Media Technologies', license: 'SIL OFL 1.1', url: 'https://www.smufl.org/fonts/bravura/', use: 'SMuFL 乐谱字体（符头 / 术语 / 记号）', useEn: 'SMuFL music font (noteheads, terms)' },
      { name: 'Leland', author: 'Leland contributors', license: 'SIL OFL 1.1', url: 'https://www.smufl.org/fonts/', use: 'SMuFL 乐谱字形（VexFlow Leland Text）', useEn: 'SMuFL glyphs (VexFlow Leland Text)' },
      { name: 'Liberation', author: 'Red Hat & contributors', license: 'SIL OFL 1.1', url: 'https://github.com/liberationfonts/liberation-fonts', use: '西文 / 谱面文本字体', useEn: 'Latin & score text font' },
      { name: 'Noto（中文子集）', author: 'Google', license: 'SIL OFL 1.1', url: 'https://fonts.google.com/noto', use: '中文 7000 常用字子集（3D 文字）', useEn: 'CJK subset for 3D text' },
      { name: 'Inter', author: 'Rasmus Andersson', license: 'SIL OFL 1.1', url: 'https://rsms.me/inter/', use: '界面西文字体', useEn: 'UI Latin font' },
      { name: 'JetBrains Mono', author: 'JetBrains', license: 'SIL OFL 1.1', url: 'https://www.jetbrains.com/lp/mono/', use: '等宽字体', useEn: 'Monospace font' },
      { name: 'Instrument Serif', author: 'Instrument Serif project', license: 'SIL OFL 1.1', url: 'https://fonts.google.com/specimen/Instrument+Serif', use: '衬线展示字体', useEn: 'Serif display font' },
    ],
  },
  {
    id: 'dev',
    items: [
      { name: 'TypeScript', author: 'Microsoft', license: 'Apache-2.0', url: 'https://www.typescriptlang.org/', use: '类型系统与编译检查', useEn: 'Type system and compile checks' },
      { name: 'Vite', author: 'VoidZero / Evan You', license: 'MIT', url: 'https://vite.dev/', use: '开发服务器与构建工具', useEn: 'Dev server and bundler' },
      { name: 'Vitest', author: 'VoidZero', license: 'MIT', url: 'https://vitest.dev/', use: '单元测试框架', useEn: 'Unit test framework' },
      { name: 'Biome', author: 'Biome organization', license: 'MIT OR Apache-2.0', url: 'https://biomejs.dev/', use: 'Lint 与格式化', useEn: 'Linter and formatter' },
      { name: 'esbuild', author: 'Evan Wallace', license: 'MIT', url: 'https://esbuild.github.io/', use: '脚本打包（示例数据生成）', useEn: 'Script bundling (sample data gen)' },
      { name: 'Playwright', author: 'Microsoft', license: 'Apache-2.0', url: 'https://playwright.dev/', use: '端到端测试', useEn: 'End-to-end testing' },
      { name: '@resvg/resvg-js', author: 'yisibl & contributors', license: 'MPL-2.0', url: 'https://github.com/yisibl/resvg-js', use: 'SVG 转 PNG（OG 分享图生成）', useEn: 'SVG to PNG (OG image generation)' },
      { name: 'vite-plugin-solid', author: 'solidjs', license: 'MIT', url: 'https://github.com/solidjs/vite-plugin-solid', use: 'Solid JSX 编译（Vite 插件）', useEn: 'Solid JSX compilation (Vite plugin)' },
      { name: 'jsdom', author: 'jsdom contributors', license: 'MIT', url: 'https://github.com/jsdom/jsdom', use: 'DOM 模拟（测试环境）', useEn: 'DOM simulation (test environment)' },
      { name: 'marked', author: 'marked contributors', license: 'MIT', url: 'https://github.com/markedjs/marked', use: 'Markdown 解析（关于页）', useEn: 'Markdown parsing (about page)' },
      { name: '@posthog/cli', author: 'PostHog', license: 'MIT', url: 'https://github.com/PostHog/posthog', use: 'PostHog 命令行工具', useEn: 'PostHog command-line tool' },
      { name: '@solidjs/testing-library', author: 'solidjs', license: 'MIT', url: 'https://github.com/solidjs/solid-testing-library', use: '组件测试工具', useEn: 'Component testing utilities' },
      { name: '@vitest/coverage-v8', author: 'Vitest', license: 'MIT', url: 'https://github.com/vitest-dev/vitest', use: '测试覆盖率（v8）', useEn: 'Test coverage (v8)' },
    ],
  },
  {
    id: 'internal',
    items: [
      { name: '五步流程外壳（hash 路由 + 页面编排）', author: 'LumiScore 自研', license: '', url: '', use: '导入 → 2D 修正 → 连线 → 样式 → 3D 空间的流程骨架', useEn: 'Five-step flow shell (hash router + iframes)' },
      { name: '导入管线（嗅探 / 转换 / 反复展开）', author: 'LumiScore 自研', license: '', url: '', use: '格式识别、校验、MusicXML ↔ MIDI 双向转换与反复记号展开', useEn: 'Import pipeline (sniff / convert / repeat expand)' },
      { name: '2D 谱面检查与微调', author: 'LumiScore 自研', license: '', url: '', use: '符号选择 / 拖动 / 文字编辑（仅视觉层）', useEn: '2D score check & tweak (visual only)' },
      { name: '第三页自动连线算法', author: 'LumiScore 自研', license: '', url: '', use: '按声部自动生成音符连线（绿=确定 / 橙=兜底 / 红=断链）', useEn: 'Auto note-linking (green/orange/red confidence)' },
      { name: '3D 沉浸式乐谱渲染', author: 'LumiScore 自研', license: '', url: '', use: '轨道相机 / 水面 / 辉光 / 符头点亮 / 粒子', useEn: 'Immersive 3D score rendering' },
      { name: '单时钟播放引擎与音色三级兜底', author: 'LumiScore 自研', license: '', url: '', use: '唯一播放头 + 在线竞速 → 本地钢琴采样 → 合成器兜底链', useEn: 'Single-clock playback + 3-tier sound fallback' },
    ],
  },
]

const FORMATS: Record<Locale, string[]> = {
  'zh-CN': ['MIDI .mid .midi .kar', 'MusicXML .xml .musicxml', 'MXL .mxl', 'MuseScore .mscz .mscx', 'GuitarPro .gp .gp3 .gp4 .gp5 .gpx .gtp .ptb'],
  en: ['MIDI .mid .midi .kar', 'MusicXML .xml .musicxml', 'MXL .mxl', 'MuseScore .mscz .mscx', 'GuitarPro .gp .gp3 .gp4 .gp5 .gpx .gtp .ptb'],
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

// 资源名/分类/id 部分来自 Poly Haven 等外部 API，拼进 innerHTML 前必须转义，
// 否则恶意或被打断的响应可注入脚本（XSS）。
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

// ── 弹窗骨架 ─────────────────────────────────────────────────
function createModal(id: string, titleKey: string): { wrap: HTMLDivElement; fill: (html: string) => void } {
  const wrap = el('div', 'sh-modal')
  wrap.id = id
  wrap.hidden = true
  wrap.setAttribute('role', 'dialog')
  wrap.setAttribute('aria-modal', 'true')

  const card = el('div', 'sh-modal__card')
  const head = el('div', 'sh-modal__head')
  const h2 = el('h2')
  h2.dataset.i18n = titleKey
  h2.textContent = t(titleKey)
  const close = el('button', 'sh-icon-btn')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', t('common.close'))
  head.append(h2, el('div', 'sh-spacer'), close)

  const body = el('div', 'sh-modal__body')
  card.append(head, body)
  wrap.append(card)
  document.body.append(wrap)

  close.addEventListener('click', () => {
    wrap.hidden = true
  })
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) wrap.hidden = true
  })

  // 焦点：打开时移入、关闭时还给原处。原来弹窗只在屏幕上「出现」，键盘用户按 Tab
  // 仍从页面顶部开始；关掉后焦点掉回 body，读屏直接丢失上下文。
  // 各页是直接写 wrap.hidden 的（about/help/cache 都这样），所以用属性观察挂钩子，
  // 不强求调用方改走 open()/close()。
  const focusables = (): HTMLElement[] =>
    Array.from(
      card.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null)
  let prevFocus: HTMLElement | null = null
  new MutationObserver(() => {
    if (wrap.hidden) {
      prevFocus?.focus?.()
      prevFocus = null
      return
    }
    prevFocus = document.activeElement as HTMLElement | null
    const f = focusables()
    // 优先落进正文第一个可操作项（[0] 是标题栏的关闭按钮，直接聚焦它不太自然）
    ;(f[1] ?? f[0])?.focus()
  }).observe(wrap, { attributes: true, attributeFilter: ['hidden'] })
  // 焦点陷阱：Tab 到最后一个就不再跑到背后的页面里去
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || wrap.hidden) return
    const f = focusables()
    if (!f.length) return
    const first = f[0]!
    const last = f[f.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  })

  return {
    wrap,
    fill: (html: string) => {
      body.innerHTML = html
      applyI18n(body)
    },
  }
}

export { createModal }

export interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：确认按钮用红色，焦点默认落在取消上，避免误回车 */
  danger?: boolean
  /** 追加在说明文字后的可点击链接（主题色 + 下划线）；点击后关闭弹窗并回调 */
  linkText?: string
  onLink?: () => void
}

let activeConfirm: HTMLElement | null = null
/** 通用确认弹窗：替代原生 confirm()，样式随外壳令牌，返回 Promise<boolean>。
 *  带焦点移入/陷阱/归还与 Esc/背板关闭；同一时间只保留一个确认弹窗。 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (activeConfirm) activeConfirm.remove()
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null
    const wrap = el('div', 'sh-modal')
    wrap.setAttribute('role', 'dialog')
    wrap.setAttribute('aria-modal', 'true')
    const card = el('div', 'sh-modal__card')
    card.style.width = 'min(400px, 100%)'
    const head = el('div', 'sh-modal__head')
    head.append(el('h2', undefined, opts.title ?? t('confirm.title')))
    const body = el('div', 'sh-modal__body')
    const p = el('p')
    p.style.margin = '12px 0 0'
    p.append(document.createTextNode(opts.message))
    let linkEl: HTMLAnchorElement | null = null
    if (opts.linkText) {
      linkEl = el('a', 'sh-inline-link', opts.linkText) as HTMLAnchorElement
      linkEl.href = '#'
      linkEl.addEventListener('click', (e) => {
        e.preventDefault()
        close(false)
        opts.onLink?.()
      })
      p.append(linkEl)
    }
    body.append(p)
    const foot = el('div', 'sh-modal__foot')
    const cancel = el('button', 'sh-btn', opts.cancelText ?? t('confirm.cancel'))
    cancel.type = 'button'
    const ok = el(
      'button',
      opts.danger ? 'sh-btn sh-btn--danger' : 'sh-btn sh-btn--primary',
      opts.confirmText ?? t('confirm.ok'),
    )
    ok.type = 'button'
    foot.append(cancel, ok)
    card.append(head, body, foot)
    wrap.append(card)
    document.body.append(wrap)
    activeConfirm = wrap
    bringToFront(wrap)

    let done = false
    const close = (result: boolean): void => {
      if (done) return
      done = true
      activeConfirm = null
      wrap.remove()
      document.removeEventListener('keydown', onKey, true)
      prevFocus?.focus?.()
      resolve(result)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(false)
      } else if (e.key === 'Enter') {
        if (document.activeElement === linkEl) return // 交给链接自身的 click
        e.preventDefault()
        e.stopPropagation()
        close(document.activeElement !== cancel)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const list: HTMLElement[] = [cancel, ok]
        if (linkEl) list.push(linkEl)
        const i = list.indexOf(document.activeElement as HTMLElement)
        const dir = e.shiftKey ? -1 : 1
        const n = i < 0 ? 0 : (i + dir + list.length) % list.length
        list[n]?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => close(false))
    ok.addEventListener('click', () => close(true))
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(false)
    })
    ;(opts.danger ? cancel : ok).focus()
  })
}

/** 站内离开提示：确认框样式同外壳，正文后挂「工程文件」链接，点了直接开导出弹窗。
 *  返回 true 表示可以离开。 */
function confirmLeave(onExport?: () => void): Promise<boolean> {
  const opts: ConfirmOptions = {
    title: t('leave.title'),
    message: t('leave.msg'),
    confirmText: t('leave.confirm'),
    cancelText: t('leave.stay'),
  }
  if (onExport) {
    opts.linkText = t('leave.export')
    opts.onLink = onExport
  }
  return confirmDialog(opts)
}

let globalToastBox: HTMLDivElement | null = null
/** 全局轻提示（供各页复用，免自造）：ok/err 两种，4.5s 自动消失，点击即关。 */
export function showToast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  if (!globalToastBox) {
    globalToastBox = el('div', 'sh-toasts')
    globalToastBox.setAttribute('aria-live', 'polite')
    document.body.append(globalToastBox)
  }
  const box = globalToastBox
  while (box.children.length >= 3) box.firstElementChild?.remove()
  const node = el('div', `sh-toast${kind === 'ok' ? ' is-ok' : ' is-err'}`)
  node.textContent = msg
  node.addEventListener('click', () => node.remove())
  box.append(node)
  setTimeout(() => node.remove(), 4500)
}

function aboutHtml(): string {
  const isEn = getLocale() === 'en'
  const groups = OSS_GROUPS.map((g) => {
    const items = g.items
      .map((it) => {
        const internal = g.id === 'internal'
        const lic = internal ? t('about.internal.tag') : it.license
        const detail = internal
          ? `<div class="sh-oss__row"><span class="sh-oss__k">${t('about.oss.usage')}</span><span>${isEn ? it.useEn : it.use}</span></div>`
          : `
          <div class="sh-oss__row"><span class="sh-oss__k">${t('about.oss.author')}</span><span>${it.author}</span></div>
          <div class="sh-oss__row"><span class="sh-oss__k">${t('about.oss.license')}</span><span>${it.license}</span></div>
          <div class="sh-oss__row"><span class="sh-oss__k">${t('about.oss.usage')}</span><span>${isEn ? it.useEn : it.use}</span></div>
          ${it.url ? `<div class="sh-oss__row"><span class="sh-oss__k">${t('about.oss.home')}</span><a href="${it.url}" target="_blank" rel="noopener">${it.url}</a></div>` : ''}`
        return `<details class="sh-oss__item${internal ? ' sh-oss__item--internal' : ''}">
          <summary><span class="sh-oss__name">${it.name}</span><em>${lic}</em><i class="sh-oss__chev">▸</i></summary>
          <div class="sh-oss__detail">${detail}</div>
        </details>`
      })
      .join('')
    return `<h3>${t(`about.oss.${g.id}`)}${g.id === 'internal' ? `<span class="sh-oss__note">${t('about.internal.tag')}</span>` : ''}</h3><div class="sh-oss">${items}</div>`
  }).join('')
  return `
    <p style="margin:12px 0 0">${t('about.tagline')}</p>
    <p>${t('about.intro')}</p>
    <div class="sh-about-gh">
      <a class="sh-about-gh__link" href="${GITHUB_URL}" target="_blank" rel="noopener" aria-label="${t('settings.github.aria')}">
        <span class="sh-about-gh__icon">${icons.github(18)}</span>
        <span class="sh-about-gh__text">
          <strong>${t('about.github.label')}</strong>
          <em>${t('about.github.desc')}</em>
        </span>
      </a>
    </div>
    <p>${t('about.privacy')}</p>
    <h3 data-i18n="about.legal"></h3>
    <p>${t('about.legal.note')}</p>
    ${groups}
    <p style="margin-top:12px;font-size:12px">${t('about.copyright')} · ${APP_VERSION}</p>
  `
}

function helpHtml(helpExtra?: string): string {
  const flow = [1, 2, 3, 4, 5]
    .map(
      (n) => `<div class="sh-flow__row">
        <div class="sh-flow__n">${n}</div>
        <div>
          <div class="sh-flow__t">${t(`help.flow.${n}.t`)}</div>
          <div class="sh-flow__d">${t(`help.flow.${n}.d`)}</div>
        </div>
      </div>`,
    )
    .join('')
  const chips = FORMATS[getLocale()].map((f) => `<span class="sh-chip">${f}</span>`).join('')
  const faq = [1, 2, 3]
    .map(
      (n) => `<div class="sh-flow__row">
        <div class="sh-flow__n">?</div>
        <div>
          <div class="sh-flow__t">${t(`help.faq.${n}.q`)}</div>
          <div class="sh-flow__d">${t(`help.faq.${n}.a`)}</div>
        </div>
      </div>`,
    )
    .join('')
  return `
    <h3 data-i18n="help.flow"></h3>
    <div class="sh-flow">${flow}</div>
    <h3 data-i18n="help.formats"></h3>
    <div class="sh-chips" style="margin-top:6px">${chips}</div>
    <h3 data-i18n="help.faq"></h3>
    <div class="sh-flow">${faq}</div>
    ${helpExtra ?? ''}
  `
}

// ── 外壳挂载 ─────────────────────────────────────────────────
export function mountShell(opts: ShellOptions): ShellHandle {
  paintTheme()
  paintAccent()
  setReducedMotion(isReducedMotion())
  document.documentElement.lang = getLocale()
  mountedStep = opts.step

  // ── 离开守卫 ──
  // 有未保存改动时：回退/logo 回首页弹统一确认框，前进（下一步）不弹，刷新走浏览器原生提示。
  const dirty = opts.isDirty
  if (dirty) {
    leaveGuard = async () => !dirty() || (await confirmLeave(opts.onExport))
    window.addEventListener('beforeunload', (e) => {
      // goStep 切页（前进免提示 / 回退已过确认框）不再弹原生框；仅刷新/关闭等
      // 不经 goStep 的离开才按 dirty 提示，避免前进被拦、回退双重提示。
      if (stepNavigating || !dirty()) return
      e.preventDefault()
      e.returnValue = ''
    })
  }

  // ── 顶栏 ──
  const topbar = el('header', 'sh-topbar')
  topbar.id = 'shell-topbar'

  const brand = el('button', 'sh-brand')
  brand.type = 'button'
  brand.innerHTML =
    `<img class="sh-brand__mark" src="${PUB_ROOT}icons/lumiscore-logo.svg" alt="" /><span data-i18n="brand.name">星跃谱</span>`
  // 回首页（导入页）：切到步骤 1（iframe 内走 hash，独立页走硬跳转）
  brand.addEventListener('click', () => {
    goStep(1)
  })

  // 曲名：顶栏正中；传入 onTitleRename 时可点击直接改名
  const title = el('div', 'sh-title')
  const titleText = el('strong')
  titleText.textContent = opts.title ?? ''
  title.append(titleText)
  if (opts.onTitleRename) {
    title.classList.add('sh-title--editable')
    titleText.dataset.i18nAria = 'topbar.rename'
    titleText.setAttribute('role', 'textbox')
    titleText.setAttribute('aria-multiline', 'false')
    let titleBefore = ''
    const commitTitle = (): void => {
      titleText.contentEditable = 'inherit'
      titleText.classList.remove('is-editing')
      const next = titleText.textContent?.trim() ?? ''
      if (next && next !== titleBefore) {
        titleBefore = next
        opts.onTitleRename?.(next)
      } else {
        titleText.textContent = titleBefore
      }
    }
    titleText.addEventListener('click', () => {
      if (titleText.classList.contains('is-editing')) return
      titleBefore = titleText.textContent ?? ''
      titleText.classList.add('is-editing')
      titleText.contentEditable = 'true'
      titleText.focus()
      const range = document.createRange()
      range.selectNodeContents(titleText)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })
    titleText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        titleText.blur()
      } else if (e.key === 'Escape') {
        titleText.textContent = titleBefore
        titleText.blur()
      }
    })
    titleText.addEventListener('blur', commitTitle)
  }

  // 项目名被限制区截断时，悬停出全名气泡（点击改名不受影响）
  title.dataset.tipWrap = '1'
  bindTip(title, () => (title.scrollWidth > title.clientWidth + 1 ? titleText.textContent ?? '' : ''))

  // 步骤：顶栏左侧只显示四个文字按钮；点击弹出步骤简介菜单（可回退到已完成步骤）
  const stepsWrap = el('div', 'sh-steps-wrap')
  const steps = el('nav', 'sh-steps')
  steps.setAttribute('aria-label', 'steps')
  const stepsDrop = el('div', 'sh-dropdown sh-steps__drop')
  stepsDrop.hidden = true
  stepsWrap.append(steps, stepsDrop)

  const spacer = el('div', 'sh-spacer')

  // 步数指示：统一放顶栏（原来在播放条左下角，桌面也会误显示）
  const pageCount = el('button', 'sh-pagecount')
  pageCount.type = 'button'
  pageCount.dataset.i18nAria = 'topbar.steps'
  pageCount.textContent = t('topbar.pagecount', { n: opts.step, total: 5 })
  pageCount.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleStepsDrop(pageCount)
  })

  // 工具 ▾
  const toolsMenu = el('div', 'sh-menu')
  const toolsBtn = iconBtn(SVG.dots, 'topbar.tools')
  toolsBtn.setAttribute('aria-haspopup', 'true')
  toolsBtn.setAttribute('aria-expanded', 'false')
  const toolsDrop = el('div', 'sh-dropdown sh-dropdown--wide')
  toolsDrop.hidden = true
  toolsMenu.append(toolsBtn, toolsDrop)

  // 音轨 ▾（仅 2D / 3D 播放页传入）
  let tracksMenu: HTMLElement | null = null
  let tracksBtn: HTMLButtonElement | null = null
  let tracksDrop: HTMLElement | null = null
  if (opts.tracks) {
    tracksMenu = el('div', 'sh-menu')
    tracksBtn = iconBtn(SVG.tracks, 'topbar.tracks')
    tracksBtn.setAttribute('aria-haspopup', 'true')
    tracksBtn.setAttribute('aria-expanded', 'false')
    tracksDrop = el('div', 'sh-dropdown')
    tracksDrop.hidden = true
    tracksDrop.append(opts.tracks)
    tracksMenu.append(tracksBtn, tracksDrop)
  }

  // 画面比例 ▾（仅 3D 页传入：裁剪辅助虚线 + 置黑）
  let aspectMenu: HTMLElement | null = null
  let aspectBtn: HTMLButtonElement | null = null
  let aspectDrop: HTMLElement | null = null
  if (opts.aspect) {
    aspectMenu = el('div', 'sh-menu')
    aspectBtn = document.createElement('button')
    aspectBtn.type = 'button'
    aspectBtn.className = 'sh-icon-btn'
    aspectBtn.innerHTML = SVG.aspect
    aspectBtn.dataset.i18nAria = 'topbar.aspect'
    addMenuLabel(aspectBtn, 'topbar.aspect')
    aspectBtn.setAttribute('aria-haspopup', 'true')
    aspectBtn.setAttribute('aria-expanded', 'false')
    aspectDrop = el('div', 'sh-dropdown sh-dropdown--wide')
    aspectDrop.hidden = true
    aspectDrop.append(opts.aspect)
    aspectMenu.append(aspectBtn, aspectDrop)
  }

  // 设置 ▾（功能区右端固定项，靠 .sh-menu--set 的 order 钉住，不参与功能区排序）
  const setMenu = el('div', 'sh-menu sh-menu--set')
  const setBtn = iconBtn(SVG.gear, 'topbar.settings')
  setBtn.setAttribute('aria-haspopup', 'true')
  setBtn.setAttribute('aria-expanded', 'false')
  const setDrop = el('div', 'sh-dropdown sh-dropdown--wide')
  setDrop.hidden = true
  setMenu.append(setBtn, setDrop)

  // 下一步（最右；悬停展开附项，如导出 SVG；小 caret 点开下拉）
  let nextWrap: HTMLElement | null = null
  let nextDrop: HTMLElement | null = null
  if (opts.next) {
    nextWrap = el('div', 'sh-next')
    const main = el('button', 'sh-btn sh-btn--primary sh-next__main')
    main.type = 'button'
    main.dataset.i18n = 'topbar.next'
    main.textContent = t('topbar.next')
    main.addEventListener('click', () => opts.next?.onNext())
    nextWrap.append(main)
    if (opts.next.items?.length) {
      const caret = el('button', 'sh-next__caret')
      caret.type = 'button'
      caret.innerHTML = SVG.caret
      caret.setAttribute('aria-haspopup', 'true')
      caret.setAttribute('aria-expanded', 'false')
      nextDrop = el('div', 'sh-dropdown sh-next__drop')
      nextDrop.hidden = true
      for (const item of opts.next.items) {
        const b = el('button', 'sh-dd-item')
        b.type = 'button'
        b.textContent = item.label
        if (item.labelKey) b.dataset.i18n = item.labelKey
        b.addEventListener('click', () => {
          if (nextDrop) nextDrop.hidden = true
          item.run()
        })
        nextDrop.append(b)
      }
      caret.addEventListener('click', (e) => {
        e.stopPropagation()
        if (!nextDrop) return
        const willOpen = nextDrop.hidden
        closeDropdowns(nextDrop)
        nextDrop.hidden = !willOpen
        caret.setAttribute('aria-expanded', String(willOpen))
        caret.classList.toggle('is-open', willOpen)
        if (willOpen) bringToFront(topbar)
      })
      nextWrap.append(caret, nextDrop)
    }
  }

  // 顶栏固定不可折叠（用户口径：全项目统一），不再提供收起按钮与拉回把手
  // 「步数 + 步骤 + 各菜单」包成一组：宽屏拍平（display: contents）按 order 排布，
  // 竖屏变成可横滚的第二行，超宽屏变成可纵滚的右侧栏
  const group = el('div', 'sh-topbar-group')
  // 功能区：设置/下一步靠 order 钉在右端，其余按钮不承诺固定顺序。
  // 播放区（将来由 dock 层注入）排在功能区最左，也就是这里 toolsMenu 之前。
  group.append(
    pageCount,
    stepsWrap,
    toolsMenu,
    ...(tracksMenu ? [tracksMenu] : []),
    ...(aspectMenu && aspectBtn ? [aspectMenu] : []),
    setMenu,
  )
  topbar.append(
    brand,
    el('div', 'sh-sep'),
    title,
    spacer,
    group,
    ...(nextWrap ? [nextWrap] : []),
  )
  document.body.append(topbar)
  document.documentElement.dataset.topbar = 'expanded'

  // ── 浮层定位 ────────────────────────────────────────────────
  // 竖屏第二行与超宽屏侧栏的功能区都是滚动容器，absolute 下拉会被裁剪，
  // 所以下拉打开期间挂到 body 用 fixed 定位，关闭时放回原位。
  // 「下一步」的下拉不搬：它靠 .sh-next:hover 触发，且本来就在滚动容器之外。
  const dropHomes = new WeakMap<HTMLElement, HTMLElement>()
  const dropAnchors = new WeakMap<HTMLElement, HTMLElement>()
  const mqPortrait = matchMedia('(max-aspect-ratio: 1/1)')
  const mqUltra = matchMedia('(min-aspect-ratio: 2/1)')
  // 普通横屏标记写给 CSS 与 dock 层共用：拖出为悬浮窗、边缘横向改大小、侧编辑区吸附
  // 这些高级交互只在普通横屏开，其余断点一律回退到「能显示能操作」的既有形态。
  const paintRich = (rich: boolean): void => {
    document.documentElement.dataset.rich = rich ? '1' : '0'
  }
  paintRich(isRichLayout())
  onRichChange((rich) => {
    paintRich(rich)
    repositionDrops()
  })

  // ── 功能区溢出时的横滚：拖拽 + 滚轮 ──────────────────────────
  // 竖屏第二行放不下就横向滚动（触摸板/手指走原生滚动，这里补鼠标场景）。
  group.addEventListener('pointerdown', (e) => {
    const target = e as PointerEvent
    // 手指一律走原生滚动：自定义拖拽会 setPointerCapture 把惯性横滚一起抢掉
    if (target.pointerType === 'touch') return
    if ((target.target as HTMLElement)?.closest?.('button')) return
    const startX = target.clientX
    const startScroll = group.scrollLeft
    try {
      group.setPointerCapture(target.pointerId)
    } catch {
      /* 合成事件环境没有活动指针，监听仍挂在 group 上 */
    }
    const move = (ev: PointerEvent): void => {
      group.scrollLeft = startScroll - (ev.clientX - startX)
    }
    const up = (): void => {
      group.removeEventListener('pointermove', move)
      group.removeEventListener('pointerup', up)
      group.removeEventListener('pointercancel', up)
    }
    group.addEventListener('pointermove', move)
    group.addEventListener('pointerup', up)
    group.addEventListener('pointercancel', up)
  })
  group.addEventListener(
    'wheel',
    (e) => {
      if (!mqPortrait.matches) return
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      if (group.scrollWidth <= group.clientWidth) return
      e.preventDefault()
      group.scrollLeft += e.deltaY
    },
    { passive: false },
  )

  const managedDrops: HTMLElement[] = [setDrop, toolsDrop, stepsDrop]
  if (tracksDrop) managedDrops.push(tracksDrop)
  if (aspectDrop) managedDrops.push(aspectDrop)

  /** 下拉定位：一律钳在画布可视区内（顶栏下沿 → 底栏上沿，左右扣除侧栏/侧编辑区）。
   *  CSS 里 .sh-dropdown 的 max-height 用的是同一组 dock 变量，限高与定位同口径，
   *  这样下拉自己的滚动条一定留在画布区内，被裁到的条目靠滚动/滑动就够得着。 */
  function placeDrop(anchor: HTMLElement, drop: HTMLElement): void {
    const a = anchor.getBoundingClientRect()
    const dw = drop.offsetWidth
    const dh = drop.offsetHeight
    const m = 8
    const c = canvasRect()
    const topMax = Math.max(c.top + m, c.bottom - m - dh) // 整块落在画布带内（放不下就靠自身滚动）
    let left: number
    let top: number
    if (mqPortrait.matches) {
      // 顶栏第二行：往下弹；步骤靠左对齐，其余贴按钮右缘。
      // 下限用画布上沿（不是锚点下沿）：dockVars 把顶栏高度向上取整写变量，
      // 按锚点弹会差 1px 压在顶栏下沿上。
      left = drop.classList.contains('sh-steps__drop') ? a.left : a.right - dw
      left = Math.min(Math.max(left, c.left + m), c.right - m - dw)
      top = Math.min(Math.max(c.top, a.bottom + 8), topMax)
    } else {
      // 右侧栏 / 顶栏：往左弹成侧边飞出，垂直对齐锚点并钳在画布区内
      left = a.left - 8 - dw
      left = Math.min(Math.max(left, c.left + m), c.right - m - dw)
      top = Math.max(c.top + m, Math.min(a.top, topMax))
    }
    drop.style.position = 'fixed'
    drop.style.left = `${left}px`
    drop.style.top = `${top}px`
    drop.style.right = 'auto'
  }

  // ── 下拉四边长按改大小 ──────────────────────────────────────
  // 每个下拉一张贴边粗线图层（挂在 body，按下拉的实际矩形贴合——下拉本体是滚动容器，
  // 把手放进去了会跟着内容滚走）。尺寸存 localStorage，位置不存：重开时仍跟着锚点走。
  const dropIds = new Map<HTMLElement, string>([
    [setDrop, 'set'],
    [toolsDrop, 'tools'],
    [stepsDrop, 'steps'],
  ])
  if (tracksDrop) dropIds.set(tracksDrop, 'tracks')
  if (aspectDrop) dropIds.set(aspectDrop, 'aspect')
  const dropLayers = new Map<HTMLElement, EdgeLayer>()

  function dropLayerOf(drop: HTMLElement): EdgeLayer {
    const have = dropLayers.get(drop)
    if (have) return have
    const id = dropIds.get(drop) ?? 'drop'
    const layer = createEdgeLayer(drop, {
      min: { w: 220, h: 120 },
      max: () => {
        const c = canvasRect()
        return { w: Math.max(220, Math.floor(c.w)), h: Math.max(120, Math.floor(c.h)) }
      },
      onResize: (box) => {
        // CSS 的 max-width / max-height 是「按视口算的兜底上限」，用户手拉过尺寸就该让位，
        // 上限改由这里的画布限幅（createEdgeLayer 已钳过）负责。
        drop.style.maxWidth = 'none'
        drop.style.maxHeight = 'none'
        drop.style.width = `${Math.round(box.w)}px`
        drop.style.height = `${Math.round(box.h)}px`
        drop.style.left = `${Math.round(box.x)}px`
        drop.style.top = `${Math.round(box.y)}px`
      },
      onEnd: (w, h) => {
        try {
          localStorage.setItem(`midee.dropsize.${id}`, JSON.stringify({ w: Math.round(w), h: Math.round(h) }))
        } catch {
          /* 隐私模式：这次调的尺寸不持久，交互本身不受影响 */
        }
      },
    })
    dropLayers.set(drop, layer)
    return layer
  }

  /** 打开前把存过的尺寸套上：先定尺寸再定位，placeDrop 量到的 dw/dh 才是最终值 */
  function applyDropSize(drop: HTMLElement): void {
    drop.style.width = ''
    drop.style.height = ''
    drop.style.maxWidth = ''
    drop.style.maxHeight = ''
    let s: Size | null = null
    try {
      const raw = localStorage.getItem(`midee.dropsize.${dropIds.get(drop) ?? 'drop'}`)
      if (raw) {
        const v = JSON.parse(raw) as Partial<Size>
        if (typeof v.w === 'number' && typeof v.h === 'number') s = { w: v.w, h: v.h }
      }
    } catch {
      /* 脏数据 → 用默认尺寸 */
    }
    if (!s) return
    const c = canvasRect()
    s = { w: Math.min(Math.max(220, s.w), c.w), h: Math.min(Math.max(120, s.h), c.h) }
    drop.style.width = `${Math.round(s.w)}px`
    drop.style.height = `${Math.round(s.h)}px`
    // CSS 里的 max-width/max-height 会把存回来的尺寸再压回去，只有拉过尺寸的这一层需要放开
    drop.style.maxWidth = 'none'
    drop.style.maxHeight = 'none'
  }

  function openDrop(anchor: HTMLElement, drop: HTMLElement, btn?: HTMLElement): void {
    closeDropdowns(drop)
    const home = drop.parentElement
    if (home && home !== document.body) dropHomes.set(drop, home)
    dropAnchors.set(drop, anchor)
    document.body.append(drop)
    drop.hidden = false
    applyDropSize(drop)
    placeDrop(anchor, drop)
    btn?.classList.add('is-open')
    bringToFront(drop)
    const layer = dropLayerOf(drop)
    layer.setVisible(true)
    layer.sync()
  }

  function shutDrop(drop: HTMLElement, btn?: HTMLElement): void {
    if (drop.hidden) return
    // 已经切去悬浮窗 / 侧编辑区的内容不归下拉管：点别处「收起全部下拉」时
    // 不许把它搬回顶栏，也不许把人家正显示的面板判成 hidden。
    if (drop.classList.contains('sh-dropdown--float') || drop.classList.contains('sh-dropdown--side'))
      return
    drop.hidden = true
    drop.style.position = ''
    drop.style.left = ''
    drop.style.top = ''
    drop.style.right = ''
    btn?.classList.remove('is-open')
    dropLayers.get(drop)?.setVisible(false)
    const home = dropHomes.get(drop)
    if (home) {
      home.append(drop)
      dropHomes.delete(drop)
    }
  }

  /** 打开着的下拉按当前视口重新定位（缩放、折叠、切页都要调） */
  function repositionDrops(): void {
    for (const d of managedDrops) {
      if (d.hidden) continue
      // 侧编辑区/悬浮窗里的面板由各自的容器排版，写 fixed 会把它从槽里甩出去
      if (d.classList.contains('sh-dropdown--side') || d.classList.contains('sh-dropdown--float'))
        continue
      const anchor = dropAnchors.get(d)
      if (anchor) placeDrop(anchor, d)
    }
    dockVars()
    titleZone()
  }

  /**
   * 抽屉锚点：把两条停靠栏的真实高度写成 CSS 变量。
   * 竖屏的面板要卡在顶栏与底栏之间，超宽的要卡在侧栏左边、控件条上边，
   * 这两处高度都是内容撑出来的（第二行文字按钮、控件条是否折叠），只能量。
   */
  function dockVars(): void {
    const root = document.documentElement
    const rectOf = (sel: string, byId = false): number => {
      const e = byId ? document.getElementById(sel) : document.querySelector(sel)
      return e ? e.getBoundingClientRect().bottom : 0
    }
    let topH: number
    if (mqUltra.matches) {
      // 超宽段没有顶栏，但左上角那一行（行首折叠开关 + 无背板的项目名）
      // 也是浮在画面上的，抽屉不能把它盖掉；标题折叠后这里自然归零。
      topH = Math.max(rectOf('.sh-title'), rectOf('collapse-title', true)) + 8
    } else {
      topH = topbar.getBoundingClientRect().height
    }
    // 底栏/控件条到视口底边的距离 = 抽屉的下沿留白：
    // 竖屏底栏是贴边的（就是它自身高度），超宽的控件条还悬着 10px 离底，
    // 只量高度的话抽屉会压到控件条上。
    const barR = document
      .querySelector<HTMLElement>('.sh-float:has(> .sh-pb)')
      ?.getBoundingClientRect()
    let bottomH = 0
    if (barR && barR.height > 0) {
      // 控件条正常贴底时，量「条顶到视口底」（含条身 + 底部留白），与原算法一致；
      // 一旦条被异常推离底部（浏览器控制台开关触发 resize，悬浮窗被夹上去后不回位），
      // 退化为条自身高度兜底——否则 --sh-dock-bottom 会爆炸、画布下边界上移，
      // 导致其它悬浮窗（如场景设置窗）出现下方隐形墙、拖不下去。
      const gapToBottom = window.innerHeight - barR.bottom
      bottomH = gapToBottom <= barR.height
        ? Math.max(0, window.innerHeight - barR.top)
        : barR.height
    }
    root.style.setProperty('--sh-dock-top', `${Math.round(Math.max(0, topH))}px`)
    root.style.setProperty('--sh-dock-bottom', `${Math.round(bottomH)}px`)
    // 画布避让「背板且非悬浮」的控件区：顶栏（超宽段无顶栏，归零）+ 右侧栏。
    // 悬浮窗（播放条/设置窗）与无背板控件不避让，画布仍铺到它们下面。
    // 比例辅助线与导出裁剪都按这块内缩可视区算，避免压到背板下造成参考/导出分歧。
    const canvasTop = mqUltra.matches ? 0 : topH
    root.style.setProperty('--sh-canvas-top', `${Math.round(Math.max(0, canvasTop))}px`)
    // 开机第一步就是这一句：那时播放条还没量出自己多高，--sh-dock-bottom 是 0，
    // 侧编辑区按「视口底」画就会把下沿压到播放条上（刷新一下才恢复）。
    // 变量一落地就让侧区重画一次，别等下一次 resize。
    if (isRichLayout()) docks.refresh()
  }
  window.addEventListener('resize', repositionDrops)
  mqPortrait.addEventListener('change', repositionDrops)
  mqUltra.addEventListener('change', repositionDrops)

  // ── 项目名限制区：绝不画在控件上 ────────────────────────────
  // 顶栏带内（1:1 ~ 2:1）标题是绝对定位居中的，长谱名会盖住两端控件。
  // 这里按「左侧最后一个可见控件」与「右侧第一个可见控件」之间的真实空档
  // 限宽并居中，超出就出省略号，两端控件纹丝不动。
  // 竖屏（流内靠右）与超宽屏（挂左上角）由 CSS 各自处理，这里交回控制权。
  function titleZone(): void {
    if (mqPortrait.matches || mqUltra.matches) {
      title.style.left = ''
      title.style.maxWidth = ''
      return
    }
    const m = 8
    const cw = document.documentElement.clientWidth
    const leftEdge = stepsWrap.getBoundingClientRect().right + m
    let rightEdge = cw - m
    for (const c of [tracksMenu, aspectMenu, toolsMenu, setMenu, nextWrap]) {
      if (!c || c.style.display === 'none' || c.offsetParent === null) continue
      rightEdge = Math.min(rightEdge, c.getBoundingClientRect().left - m)
    }
    title.style.maxWidth = `${Math.max(60, rightEdge - leftEdge)}px`
    title.style.left = `${(leftEdge + rightEdge) / 2}px`
  }

  // ── 超宽屏行首折叠开关：标题行 / 播放控件行各一个 ────────────
  // 主项目「顶栏固定不可折叠」是为了不干扰第五页的比例裁剪；
  // 这两个是贴边浮层，不参与裁剪计算，所以可以折。
  const collapseTitle = el('button', 'corner-collapse')
  collapseTitle.id = 'collapse-title'
  collapseTitle.type = 'button'
  collapseTitle.textContent = '‹'
  collapseTitle.hidden = true
  const collapsePlayer = el('button', 'corner-collapse')
  collapsePlayer.id = 'collapse-player'
  collapsePlayer.type = 'button'
  collapsePlayer.textContent = '‹'
  collapsePlayer.hidden = true
  document.body.append(collapseTitle, collapsePlayer)
  bindTip(collapseTitle, () => t(collapseTitle.dataset.i18nAria ?? 'topbar.collapseTitle'))
  bindTip(collapsePlayer, () => t(collapsePlayer.dataset.i18nAria ?? 'topbar.collapsePlayer'))

  function paintCollapse(): void {
    const on = mqUltra.matches
    const root = document.documentElement
    if (!on) {
      root.dataset.ultraTitle = ''
      root.dataset.ultraPlayer = ''
    }
    // 没有曲名（第一/第四页）或没有播放条的页面，对应的折叠开关不该露出来
    collapseTitle.hidden = !on || !titleText.textContent.trim()
    collapsePlayer.hidden = !on
    const tCol = root.dataset.ultraTitle === 'collapsed'
    const pCol = root.dataset.ultraPlayer === 'collapsed'
    collapseTitle.textContent = tCol ? '›' : '‹'
    collapsePlayer.textContent = pCol ? '›' : '‹'
    const titleKey = tCol ? 'topbar.expandTitle' : 'topbar.collapseTitle'
    const playerKey = pCol ? 'topbar.expandPlayer' : 'topbar.collapsePlayer'
    collapseTitle.dataset.i18nAria = titleKey
    collapsePlayer.dataset.i18nAria = playerKey
    collapseTitle.setAttribute('aria-label', t(titleKey))
    collapsePlayer.setAttribute('aria-label', t(playerKey))
    dockVars()
    titleZone()
  }
  collapseTitle.addEventListener('click', (e) => {
    e.stopPropagation()
    const root = document.documentElement
    root.dataset.ultraTitle = root.dataset.ultraTitle === 'collapsed' ? '' : 'collapsed'
    paintCollapse()
  })
  collapsePlayer.addEventListener('click', (e) => {
    e.stopPropagation()
    const root = document.documentElement
    root.dataset.ultraPlayer = root.dataset.ultraPlayer === 'collapsed' ? '' : 'collapsed'
    paintCollapse()
  })
  mqUltra.addEventListener('change', paintCollapse)
  // 宽度拖变也重算一次：媒体查询 change 在部分环境（iframe 尺寸被外部改动）不触发
  window.addEventListener('resize', paintCollapse)

  // ── 步骤条 + 步骤简介下拉 ──
  let tools: ShellTool[] = opts.tools ?? []
  let stepBtnEl: HTMLButtonElement | null = null

  function stepState(s: ShellStep): 'current' | 'done' | 'todo' {
    return s === opts.step ? 'current' : s < opts.step ? 'done' : 'todo'
  }

  function renderSteps(): void {
    steps.textContent = ''
    // 顶栏只显示「当前步骤」一个按钮；完整四步 + 简介在点开的下拉里
    const b = el('button', 'sh-step')
    b.type = 'button'
    b.dataset.step = String(opts.step)
    b.dataset.state = 'current'
    const lab = el('span', undefined, t(`step.${opts.step}`))
    const caret = el('span', 'sh-step__caret')
    caret.innerHTML = SVG.caret
    b.append(lab, caret)
    bindTip(b, () => t('settings.steps.hint'))
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleStepsDrop(b)
    })
    steps.append(b)
    stepBtnEl = b
  }

  function renderStepsDrop(): void {
    stepsDrop.textContent = ''
    const list: ShellStep[] = [1, 2, 3, 4, 5]
    list.forEach((s) => {
      const state = stepState(s)
      const row = el('button', 'sh-steprow')
      row.type = 'button'
      row.dataset.state = state
      if (state === 'todo') row.disabled = true
      const top = el('span', 'sh-steprow__top')
      const name = el('span', 'sh-steprow__name', t(`step.${s}`))
      const mark = el('span', 'sh-steprow__mark')
      top.append(name, mark)
      const desc = el('span', 'sh-steprow__desc', t(`step.${s}.desc`))
      row.append(top, desc)
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        shutDrop(stepsDrop, stepBtnEl ?? undefined)
        if (state === 'done') goStep(s)
      })
      stepsDrop.append(row)
    })
  }

  /** 步骤简介下拉：步骤按钮与步数按钮都开同一个，锚点取触发它的那个 */
  function toggleStepsDrop(anchor?: HTMLElement): void {
    const btn = anchor ?? stepBtnEl ?? undefined
    if (!stepsDrop.hidden) {
      shutDrop(stepsDrop, btn)
      return
    }
    openDrop(anchor ?? stepsWrap, stepsDrop, btn)
  }

  function renderTools(): void {
    toolsDrop.textContent = ''
    if (tools.length === 0) {
      toolsMenu.style.display = 'none'
      return
    }
    toolsMenu.style.display = ''
    for (const item of tools) {
      if (item.node) {
        // 不写标题行：面板自带页签（第五页的「相机 / 时间 / 修复」）或自带标题，
        // 这里再加一行同名文字既重复又把第一项往下顶出一截空隙。
        const host = el('div', 'sh-dd-scroll')
        host.append(item.node)
        toolsDrop.append(host)
        continue
      }
      const b = el('button', 'sh-dd-item')
      b.type = 'button'
      b.textContent = item.label
      b.addEventListener('click', () => {
        closeDropdowns()
        item.run?.()
      })
      toolsDrop.append(b)
    }
  }

  // ── 设置面板 ──
  // 标注（小节标题 / 说明文字）不再占位显示，改为悬停对应控件时用气泡给出，
  // 把下拉的垂直空间留给真正的操作项。
  function renderSettings(): void {
    setDrop.textContent = ''

    const langSeg = el('div', 'sh-seg')
    const langOpts: Array<[Locale, string]> = [
      ['zh-CN', '简体中文'],
      ['en', 'English'],
    ]
    for (const [code, label] of langOpts) {
      const b = el('button', undefined, label)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(getLocale() === code))
      b.addEventListener('click', () => {
        setLocale(code)
      })
      langSeg.append(b)
    }
    bindTip(langSeg, () => t('settings.language'))
    setDrop.append(langSeg)

    const themeSeg = el('div', 'sh-seg')
    const themeOpts: Array<[ThemeMode, string]> = [
      ['light', t('settings.theme.light')],
      ['dark', t('settings.theme.dark')],
      ['system', t('settings.theme.system')],
    ]
    for (const [mode, label] of themeOpts) {
      const b = el('button', undefined, label)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(getThemeMode() === mode))
      b.addEventListener('click', () => {
        setThemeMode(mode)
        renderSettings()
      })
      themeSeg.append(b)
    }
    bindTip(themeSeg, () => t('settings.theme'))
    setDrop.append(themeSeg)

    // 2D 黑底白谱（仅深色模式下出现；两 2D 页共享 sessionStorage，纯显示反色不改 SVG）
    if (isDarkTheme()) {
      const dark2dOn = sessionStorage.getItem('midee.dark2d') === '1'
      const dark2dItem = el('button', 'sh-dd-item')
      dark2dItem.type = 'button'
      dark2dItem.setAttribute('role', 'switch')
      dark2dItem.setAttribute('aria-checked', String(dark2dOn))
      dark2dItem.textContent = t(dark2dOn ? 'settings.dark2d.on' : 'settings.dark2d.off')
      dark2dItem.addEventListener('click', () => {
        sessionStorage.setItem('midee.dark2d', dark2dOn ? '0' : '1')
        paintDark2d()
        renderSettings()
      })
      bindTip(dark2dItem, () => t('settings.dark2d.hint'))
      setDrop.append(dark2dItem)
    }

    // 颜色主题（强调色色板）
    const accentRow = el('div', 'sh-accents')
    const curAccent = getAccent()
    for (const [id, triple] of Object.entries(ACCENTS)) {
      const sw = el('button', 'sh-accent')
      sw.type = 'button'
      sw.dataset.id = id
      const dark = isDarkTheme()
      sw.style.background = (dark ? triple.dark[0] : triple.light[0]) ?? ''
      sw.setAttribute('aria-pressed', String(id === curAccent))
      sw.setAttribute('aria-label', t(`settings.accent.${id}`))
      sw.addEventListener('click', () => {
        setAccent(id)
        renderSettings()
      })
      accentRow.append(sw)
    }
    bindTip(accentRow, () => t('settings.accent'))
    setDrop.append(accentRow)

    const motion = el('button', 'sh-dd-item')
    motion.type = 'button'
    motion.setAttribute('role', 'switch')
    motion.setAttribute('aria-checked', String(isReducedMotion()))
    motion.textContent = t('settings.motion')
    const tick = el('span', 'sh-dd-item__tick', isReducedMotion() ? '✓' : '')
    motion.append(tick)
    motion.addEventListener('click', () => {
      setReducedMotion(!isReducedMotion())
      renderSettings()
    })
    bindTip(motion, () => t('settings.motion.hint'))
    setDrop.append(motion)

    // 音源：只保留播放源选择（MIDI 源）；音色引擎选择在顶栏「音轨」面板里
    // 按轨设置，这里不再重复。
    setDrop.append(el('div', 'sh-dd-sep'))
    const useOrig = readPref('midee.playOriginal') === '1'
    const row1 = el('div', 'sh-dd-audio')
    const r1Label = el('span', 'sh-dd-audio__label', t('settings.midiSource'))
    const r1Kind = el('button', 'sh-dd-audio__kind')
    r1Kind.type = 'button'
    r1Kind.textContent = t(useOrig ? 'settings.midiOrig' : 'settings.midiStd')
    r1Kind.addEventListener('click', () => {
      writePref('midee.playOriginal', useOrig ? '0' : '1')
      renderSettings()
    })
    const r1State = el('span', 'sh-dd-audio__state', t(useOrig ? 'settings.midiOrig.state' : 'settings.midiStd.state'))
    row1.append(r1Label, r1Kind, r1State)
    const audioBox = el('div', 'sh-dd-audiobox')
    audioBox.append(row1)
    bindTip(audioBox, () => `${t('settings.audio')} · ${t('settings.audioNote')}`)
    setDrop.append(audioBox)

    // 播放跳转步长：0～12 秒。播放条的前进/后退按钮每次读这个值（见 playerbar.ts），
    // 不在这里复制一份状态。
    setDrop.append(el('div', 'sh-dd-sep'))
    const nudgeRow = el('div', 'sh-dd-audio')
    nudgeRow.append(el('span', 'sh-dd-audio__label', t('settings.nudge')))
    const nudgeRange = document.createElement('input')
    nudgeRange.type = 'range'
    nudgeRange.min = String(NUDGE_MIN)
    nudgeRange.max = String(NUDGE_MAX)
    nudgeRange.step = '1'
    nudgeRange.value = String(getNudgeSec())
    nudgeRange.setAttribute('aria-label', t('settings.nudge'))
    const nudgeState = el('span', 'sh-dd-audio__state')
    const paintNudge = (): void => {
      const n = getNudgeSec()
      nudgeRange.value = String(n)
      nudgeState.textContent = n === 0 ? t('settings.nudge.off') : t('settings.nudge.sec', { n })
    }
    nudgeRange.addEventListener('input', () => {
      setNudgeSec(Number(nudgeRange.value))
      paintNudge()
    })
    paintNudge()
    nudgeRow.append(nudgeRange, nudgeState)
    bindTip(nudgeRow, () => t('settings.nudge.hint'))
    setDrop.append(nudgeRow)

    // 帮助 / 关于 收进设置
    setDrop.append(el('div', 'sh-dd-sep'))
    const cacheItem = el('button', 'sh-dd-item')
    cacheItem.type = 'button'
    cacheItem.textContent = t('settings.cache')
    cacheItem.addEventListener('click', () => {
      closeDropdowns()
      openCache()
    })
    setDrop.append(cacheItem)
    const helpItem = el('button', 'sh-dd-item')
    helpItem.type = 'button'
    helpItem.textContent = t('settings.help')
    helpItem.addEventListener('click', () => {
      closeDropdowns()
      openHelp()
    })
    const aboutRow = el('div', 'sh-dd-row')
    const aboutBtn = el('button', 'sh-dd-row__label')
    aboutBtn.type = 'button'
    aboutBtn.textContent = t('settings.about')
    aboutBtn.addEventListener('click', () => {
      closeDropdowns()
      openAbout()
    })
    const ghCircle = el('a', 'sh-gh-circle')
    ghCircle.href = GITHUB_URL
    ghCircle.target = '_blank'
    ghCircle.rel = 'noopener'
    ghCircle.setAttribute('aria-label', t('settings.github.aria'))
    ghCircle.title = t('settings.github.aria')
    ghCircle.innerHTML = icons.github(14)
    aboutRow.append(aboutBtn, ghCircle)
    setDrop.append(helpItem, aboutRow)

    // 反馈与建议（测试）：非强制登录，新开 B站私信页
    setDrop.append(el('div', 'sh-dd-sep'))
    const fbItem = el('button', 'sh-dd-item')
    fbItem.type = 'button'
    fbItem.textContent = t('settings.feedback')
    fbItem.addEventListener('click', () => {
      window.open(FEEDBACK_URL, '_blank', 'noopener')
    })
    bindTip(fbItem, () => t('settings.feedback.desc'))
    setDrop.append(fbItem)

    // 版本号（页脚式注记）
    setDrop.append(el('div', 'sh-dd-sep'))
    const verNote = el('div', 'sh-dd-note')
    verNote.style.textAlign = 'center'
    verNote.style.opacity = '0.7'
    verNote.textContent = `${t('brand.name')} ${APP_VERSION}`
    setDrop.append(verNote)

    setDrop.append(el('div', 'sh-dd-sep'))
    const clear = el('button', 'sh-dd-item')
    clear.type = 'button'
    clear.textContent = t('settings.clear')
    clear.addEventListener('click', () => {
      void confirmDialog({
        title: t('confirm.clear.title'),
        message: t('confirm.clear.msg'),
        confirmText: t('settings.clear'),
        danger: true,
      }).then((ok) => {
        if (!ok) return
        for (const k of ['midee.midi', 'midee.midiOrig', 'midee.xml', 'midee.name', 'midee.ballStyle', 'midee.trailStyle', 'midee.links', 'midee.trajShape', 'midee.layout']) {
          sessionStorage.removeItem(k)
        }
        try {
          localStorage.removeItem('midee.playOriginal')
          localStorage.removeItem('midee.trailPct') // 3D 拖尾长度偏好，清数据时一并复位
          localStorage.removeItem('midee.nudgeSec') // 跳转步长（0～12 秒）同理回到默认 10
        } catch {
          /* noop */
        }
        goStepNow(1)
      })
    })
    bindTip(clear, () => t('settings.clear.hint'))
    setDrop.append(clear)
  }

  // ── 弹窗 ──
  const about = createModal('shell-about', 'about.title')
  const help = createModal('shell-help', 'help.title')
  const renderModals = (): void => {
    about.fill(aboutHtml())
    help.fill(helpHtml(opts.helpExtra))
  }
  renderModals()

  const openAbout = (): void => {
    about.wrap.hidden = false
    bringToFront(about.wrap)
  }
  const openHelp = (): void => {
    help.wrap.hidden = false
    bringToFront(help.wrap)
  }

  // ── 缓存设置（左右两栏：左大类 / 右下载+资源列表） ──────────────
  const cache = createModal('shell-cache', 'cache.title')

  // ── 下载完成/失败全局浮层提示（用户不在下载资源窗口时也能知道结果） ──
  // 复用模块级 showToast（aria-live 播报），不再各页/各处自造提示容器。
  // 对比上一次状态：queued/downloading → done/failed 的转变弹提示。
  // 下载窗口开着时用户看得到进度，不打扰；离开后完成/失败才提示。
  const dlPrev = new Map<string, ResStatus>()
  subscribeRes(() => {
    const all: ResState[] = [...listResources('soundfont'), ...listResources('texture')]
    for (const s of all) {
      const prev = dlPrev.get(s.id)
      const finished = (prev === 'queued' || prev === 'downloading') && (s.status === 'done' || s.status === 'failed' || s.status === 'error')
      if (finished && cache.wrap.hidden) {
        if (s.status === 'done') showToast(t('cache.toast.done', { name: s.label ?? s.name }), 'ok')
        else showToast(t('cache.toast.failed', { name: s.label ?? s.name }), 'err')
      }
      dlPrev.set(s.id, s.status)
    }
  })

  type CatKey = ResCategory | 'font' | 'piano'
  const CAT_KEYS: Record<CatKey, string> = {
    soundfont: 'cache.cat.soundfont',
    texture: 'cache.cat.texture',
    font: 'cache.cat.font',
    piano: 'cache.cat.piano',
  }
  let curCat: CatKey = 'soundfont'
  let unsubscribeRes: (() => void) | null = null

  function statusLabel(s: ResState): string {
    switch (s.status) {
      case 'queued': return t('cache.status.queued')
      case 'downloading': return t('cache.status.downloading', { n: s.progress })
      case 'failed': return t('cache.status.failed')
      case 'error': return t('cache.status.error')
      case 'done': return s.inUse ? t('cache.status.inUse') : t('cache.status.idle')
      default: return ''
    }
  }
  function statusClass(s: ResState): string {
    if (s.status === 'queued') return 'is-wait'
    if (s.status === 'downloading') return 'is-dl'
    if (s.status === 'failed' || s.status === 'error') return 'is-bad'
    if (s.status === 'done') return s.inUse ? 'is-use' : 'is-ok'
    return ''
  }

  /** 按搜索词过滤下载树（renderCachePanel 重建后也要复用） */
  function applyDlFilter(search: HTMLInputElement | null, tree: HTMLElement | null): void {
    if (!search || !tree) return
    const q = search.value.trim().toLowerCase()
    tree.querySelectorAll<HTMLElement>('.sh-cache__dlitem').forEach((item) => {
      const name = item.querySelector('.sh-cache__dlitem-name')?.textContent ?? ''
      item.hidden = q !== '' && !name.toLowerCase().includes(q)
    })
    tree.querySelectorAll<HTMLDetailsElement>('.sh-cache__grp').forEach((grp) => {
      const visible = grp.querySelectorAll('.sh-cache__dlitem:not([hidden])').length
      grp.hidden = visible === 0
    })
  }

  // 面板结构签名：只有「已下载项 / 可下载项」的成员变化时才整窗重建。
  // 下载进度每秒会 emit 多次，若每次都 innerHTML 重建会明显卡顿——
  // 进度变化只就地改状态标签与体积文本。
  let cacheStructSig = ''
  function cacheSignature(): string {
    if (curCat === 'font' || curCat === 'piano') return `legacy:${curCat}`
    const cat = curCat as ResCategory
    const dl = listDownloaded(cat).map((s) => s.id)
    const idle = listResources(cat).filter((r) => r.status === 'idle').map((r) => r.id)
    return `${cat}|${dl.join(',')}|${idle.join(',')}`
  }
  function patchCacheStatus(): void {
    if (curCat === 'font' || curCat === 'piano') return
    for (const s of listDownloaded(curCat as ResCategory)) {
      const row = cache.wrap.querySelector<HTMLElement>(`.sh-cache__row[data-res="${CSS.escape(s.id)}"]`)
      if (!row) continue
      const tag = row.querySelector<HTMLElement>('.sh-cache__tag')
      if (tag) {
        const cls = `sh-cache__tag ${statusClass(s)}`
        const txt = statusLabel(s)
        // 值没变就不写 DOM：避免无意义的重绘（下载中每帧都会走到这里）
        if (tag.className !== cls) tag.className = cls
        if (tag.textContent !== txt) tag.textContent = txt
      }
      const meta = row.querySelector<HTMLElement>('.sh-cache__meta')
      if (meta) {
        const txt = s.bytes ? formatBytes(s.bytes) : ''
        if (meta.textContent !== txt) meta.textContent = txt
      }
    }
  }
  // 显示内容签名：进度/状态/占用/体积都没变时整帧跳过，不再触碰 DOM。
  // 进度文案只精确到整数百分比，天然把每 chunk 一次的 emit 收敛到 ~100 次。
  let cacheStatusSig = ''
  function cacheStatusSignature(): string {
    if (curCat === 'font' || curCat === 'piano') return `legacy:${curCat}`
    return listDownloaded(curCat as ResCategory)
      .map((s) => `${s.id}:${s.status}:${s.progress}:${s.inUse ? 1 : 0}:${s.bytes}`)
      .join('|')
  }
  let cacheRefreshRaf = 0
  function scheduleCacheRefresh(): void {
    if (cacheRefreshRaf) return
    cacheRefreshRaf = requestAnimationFrame(() => {
      cacheRefreshRaf = 0
      if (cache.wrap.hidden) return
      if (cacheSignature() !== cacheStructSig) {
        renderCachePanel()
        return
      }
      const sig = cacheStatusSignature()
      if (sig === cacheStatusSig) return
      cacheStatusSig = sig
      patchCacheStatus()
    })
  }

  let audioPrefsHandle: AudioPrefsHandle | null = null
  function renderCachePanel(): void {
    // 重建前销毁上一份音频偏好控件，避免 onAudioPrefChange/onLocaleChange 监听累积
    audioPrefsHandle?.destroy()
    audioPrefsHandle = null
    // 记住搜索词与展开的分组，重建后恢复，避免下载开始时输入/展开状态被重置
    const keepSearch = cache.wrap.querySelector<HTMLInputElement>('[data-dl-search]')?.value ?? ''
    const keepOpen = [...cache.wrap.querySelectorAll<HTMLDetailsElement>('.sh-cache__grp[open]')]
      .map((d) => d.querySelector('summary span')?.textContent ?? '')
      .filter(Boolean)

    // 下载资源窗口只展示外链拉取的分类（音色 / 贴图）；
    // 字体分片、钢琴采样是本项目自带的本地资源，不在此窗口出现。
    const cats: CatKey[] = [...listCategories()] as CatKey[]
    const nav = cats.map((c) =>
      `<button class="sh-cache__nav${c === curCat ? ' is-active' : ''}" type="button" data-cat="${c}">${t(CAT_KEYS[c])}</button>`,
    ).join('')

    let right = ''
    if (curCat === 'font' || curCat === 'piano') {
      right = renderLegacyCat(curCat)
    } else {
      right = renderResCat(curCat as ResCategory)
    }

    cache.fill(`
      <div class="sh-cache sh-cache--2col">
        <nav class="sh-cache__sidebar">${nav}</nav>
        <div class="sh-cache__main">${right}</div>
      </div>`)
    cacheStructSig = cacheSignature()
    cacheStatusSig = cacheStatusSignature()

    // 恢复搜索词与展开状态
    const searchEl = cache.wrap.querySelector<HTMLInputElement>('[data-dl-search]')
    if (searchEl && keepSearch) searchEl.value = keepSearch
    applyDlFilter(searchEl, cache.wrap.querySelector<HTMLElement>('[data-dl-tree]'))
    if (keepOpen.length) {
      cache.wrap.querySelectorAll<HTMLDetailsElement>('.sh-cache__grp').forEach((d) => {
        const k = d.querySelector('summary span')?.textContent ?? ''
        if (keepOpen.includes(k)) d.open = true
      })
    }

    // 音色分类：挂载共享音频偏好控件（替换占位符）
    const prefsMount = cache.wrap.querySelector('[data-aprefs-mount]')
    if (prefsMount) {
      audioPrefsHandle = createAudioPrefs({
        sf: 'cache.pref.autoSf', sfHint: 'cache.pref.autoSf.desc',
        poll: 'cache.pref.poll', pollHint: 'cache.pref.poll.desc',
        mirror: 'cache.pref.mirror', mirrorHint: 'cache.pref.mirror.desc',
      })
      prefsMount.replaceWith(audioPrefsHandle.el)
    }

    bindCacheEvents()
  }

  function renderResCat(cat: ResCategory): string {
    const driver = getDriver(cat)
    if (!driver) return `<p class="sh-cache__none">${t('cache.none')}</p>`
    const items = listDownloaded(cat)
    // 可下载资源（仅未下载的 idle，天然防重复）：按 group 折叠分组
    const all = listResources(cat)
    const idle = all.filter((r) => r.status === 'idle')
    let dlHtml = ''
    if (driver.downloadable) {
      // 音色分类顶部：全局音频偏好（共享控件）+ 自定义导入（即将支持）
      const prefsHtml = cat === 'soundfont' ? `
        <div class="sh-cache__prefs">
          <div data-aprefs-mount></div>
          <div class="sh-apref sh-apref--soon" title="${t('cache.dl.soonTip')}">
            <span>${t('cache.pref.custom')}</span>
            <em>${t('cache.dl.soon')}</em>
          </div>
        </div>` : cat === 'texture' ? `
        <div class="sh-cache__prefs">
          <div class="sh-apref sh-apref--src">
            <span>${t('cache.pref.mirror')}</span>
            <em>${t('cache.pref.texSrc')}</em>
          </div>
          <div class="sh-apref sh-apref--soon" title="${t('cache.dl.soonTip')}">
            <span>${t('cache.pref.custom')}</span>
            <em>${t('cache.dl.soon')}</em>
          </div>
        </div>` : ''
      if (!idle.length) {
        dlHtml = `${prefsHtml}<p class="sh-cache__none">${t('cache.dl.allDone')}</p>`
      } else {
        // 按 group 分组
        const groups = new Map<string, ResState[]>()
        for (const r of idle) {
          const g = r.group ?? t('cache.cat.other')
          if (!groups.has(g)) groups.set(g, [])
          groups.get(g)!.push(r)
        }
        const tree = [...groups.entries()].map(([g, rs]) => `
          <details class="sh-cache__grp">
            <summary class="sh-cache__grp-head">
              <span>${escapeHtml(g)}</span>
              <span class="sh-cache__grp-cnt">${rs.length}</span>
            </summary>
            <div class="sh-cache__grp-body">
              ${rs.map((r) => `
                <button class="sh-cache__dlitem" type="button" data-dl="${escapeHtml(r.id)}">
                  <span class="sh-cache__dlitem-name">${escapeHtml(r.label ?? r.name)}</span>
                  <span class="sh-cache__dlitem-idle">${t('cache.dl.go')}</span>
                </button>`).join('')}
            </div>
          </details>`).join('')
        dlHtml = `
          ${prefsHtml}
          <div class="sh-cache__dlbox">
            <input class="sh-cache__search" type="search" placeholder="${t('cache.dl.search')}" data-dl-search>
            <div class="sh-cache__tree" data-dl-tree>${tree}</div>
          </div>`
      }
    }

    const rows = items.length
      ? items.map((s) => `
          <div class="sh-cache__row" data-res="${escapeHtml(s.id)}">
            <div class="sh-cache__info">
              <div class="sh-cache__name">${escapeHtml(s.label ?? s.name)}</div>
              <div class="sh-cache__desc">${escapeHtml(s.group ?? s.category)}</div>
            </div>
            <span class="sh-cache__tag ${statusClass(s)}">${statusLabel(s)}</span>
            <span class="sh-cache__meta">${s.bytes ? formatBytes(s.bytes) : ''}</span>
            <button class="sh-btn sh-btn--sm" type="button" data-redl="${escapeHtml(s.id)}" title="${t('cache.redl')}">↻</button>
            <button class="sh-btn sh-btn--sm" type="button" data-del="${escapeHtml(s.id)}" title="${t('cache.del')}">✕</button>
          </div>`).join('')
      : `<p class="sh-cache__none">${t('cache.emptyList')}</p>`

    return `${dlHtml}<div class="sh-cache__list">${rows}</div><p class="sh-cache__note">${t('cache.note')}</p>`
  }

  function renderLegacyCat(cat: 'font' | 'piano'): string {
    const entry = listCaches().find((e) => e.id === cat)
    if (!entry) return `<p class="sh-cache__none">${t('cache.none')}</p>`
    const s = entry.stats()
    const empty = s.count === 0
    const meta = empty ? t('cache.empty') : `${s.count} ${t('cache.unit')} · ${formatBytes(s.bytes)}`
    let extra = ''
    if (entry.adjust) {
      const a = entry.adjust
      extra = `<div class="sh-cache__tune">
        <div class="sh-cache__tune-top"><span>${t(a.labelKey)}</span><b>${a.get()}</b></div>
        <input type="range" min="${a.min}" max="${a.max}" step="${a.step}" value="${a.get()}" aria-label="${t(a.labelKey)}" data-adj>
        <div class="sh-cache__desc">${t(a.hintKey)}</div>
      </div>`
    }
    return `
      <div class="sh-cache__row">
        <div class="sh-cache__info">
          <div class="sh-cache__name">${t(entry.labelKey)}</div>
          <div class="sh-cache__desc">${t(entry.descKey)}</div>
        </div>
        <span class="sh-cache__meta">${meta}</span>
        <button class="sh-btn sh-btn--sm" type="button" data-legacy-clear="${cat}"${empty ? ' disabled' : ''}>${t('cache.clear')}</button>
      </div>
      ${extra}
      <p class="sh-cache__note">${t('cache.note')}</p>`
  }

  function bindCacheEvents(): void {
    cache.wrap.querySelectorAll<HTMLButtonElement>('[data-cat]').forEach((b) => {
      b.addEventListener('click', () => {
        curCat = b.dataset.cat as CatKey
        refreshInUse(curCat as ResCategory)
        // 选中贴图时拉取 Poly Haven 清单（懒加载，已加载则跳过）
        if (curCat === 'texture') void ensureTextureCatalog().then(renderCachePanel)
        renderCachePanel()
      })
    })
    // 下载树里的单项：点击即下载（已下好的不在树里，天然防重复）
    cache.wrap.querySelectorAll<HTMLButtonElement>('[data-dl]').forEach((b) => {
      b.addEventListener('click', () => void downloadResource(b.dataset.dl!))
    })
    // 搜索过滤
    const search = cache.wrap.querySelector<HTMLInputElement>('[data-dl-search]')
    const tree = cache.wrap.querySelector<HTMLElement>('[data-dl-tree]')
    if (search && tree) {
      search.addEventListener('input', () => applyDlFilter(search, tree))
    }
    cache.wrap.querySelectorAll<HTMLButtonElement>('[data-redl]').forEach((b) => {
      b.addEventListener('click', () => void redownloadResource(b.dataset.redl!))
    })
    cache.wrap.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.addEventListener('click', () => void deleteResource(b.dataset.del!))
    })
    cache.wrap.querySelectorAll<HTMLButtonElement>('[data-legacy-clear]').forEach((b) => {
      b.addEventListener('click', () => {
        listCaches().find((e) => e.id === b.dataset.legacyClear)?.clear()
        renderCachePanel()
      })
    })
    const adj = cache.wrap.querySelector<HTMLInputElement>('[data-adj]')
    if (adj) {
      const entry = listCaches().find((e) => e.id === curCat)
      if (entry?.adjust) {
        const a = entry.adjust
        const out = cache.wrap.querySelector<HTMLElement>('.sh-cache__tune-top b')
        adj.addEventListener('input', () => {
          a.set(Number(adj.value))
          if (out) out.textContent = String(a.get())
        })
        adj.addEventListener('change', () => renderCachePanel())
        bindRangeTip(adj, () => String(a.get()))
      }
    }
  }

  const openCache = (): void => {
    curCat = 'soundfont'
    renderCachePanel()
    cache.wrap.hidden = false
    bringToFront(cache.wrap)
    if (!unsubscribeRes) {
      // 进度事件高频触发：合并到下一帧，仅在结构变化时重建，其余就地打补丁
      unsubscribeRes = subscribeRes(scheduleCacheRefresh)
    }
  }

  // ── 低性能设备一次性提示（进入网站只弹一次） ──
  function maybePerfWarn(): void {
    try {
      if (localStorage.getItem('midee.perfWarnShown') === '1') return
    } catch { /* noop */ }
    const cores = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 8
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    const weak = cores <= 4 || mem <= 4 || isMobile
    if (!weak) return
    const wrap = el('div', 'sh-modal')
    wrap.id = 'shell-perf'
    wrap.setAttribute('role', 'dialog')
    wrap.setAttribute('aria-modal', 'true')
    const card = el('div', 'sh-modal__card')
    const head = el('div', 'sh-modal__head')
    const h2 = el('h2')
    h2.textContent = t('perf.title')
    head.append(h2, el('div', 'sh-spacer'))
    const body = el('div', 'sh-modal__body')
    body.innerHTML = `<p style="margin:0;line-height:1.8">${t('perf.body')}</p>`
    const ok = el('button', 'sh-btn sh-btn--primary')
    ok.type = 'button'
    ok.textContent = t('perf.ok')
    body.append(ok)
    card.append(head, body)
    wrap.append(card)
    document.body.append(wrap)
    const dismiss = (): void => {
      wrap.hidden = true
      try { localStorage.setItem('midee.perfWarnShown', '1') } catch { /* noop */ }
    }
    ok.addEventListener('click', dismiss)
    wrap.addEventListener('click', (e) => { if (e.target === wrap) dismiss() })
    wrap.hidden = false
    bringToFront(wrap)
  }
  maybePerfWarn()

  // ── 下拉开合 ──
  const menus: Array<{ btn: HTMLElement; drop: HTMLElement }> = [
    { btn: setBtn, drop: setDrop },
    { btn: toolsBtn, drop: toolsDrop },
    ...(tracksBtn && tracksDrop ? [{ btn: tracksBtn, drop: tracksDrop }] : []),
    ...(aspectBtn && aspectDrop ? [{ btn: aspectBtn, drop: aspectDrop }] : []),
  ]
  function closeDropdowns(except?: HTMLElement): void {
    for (const m of menus) {
      if (m.drop === except) continue
      shutDrop(m.drop, m.btn)
      m.btn.setAttribute('aria-expanded', 'false')
    }
    const caret = nextWrap?.querySelector<HTMLButtonElement>('.sh-next__caret')
    if (nextDrop && nextDrop !== except) {
      nextDrop.hidden = true
      caret?.setAttribute('aria-expanded', 'false')
      caret?.classList.remove('is-open')
    }
    if (stepsDrop !== except) {
      shutDrop(stepsDrop)
      pageCount.classList.remove('is-open')
      stepBtnEl?.classList.remove('is-open')
    }
  }
  /** 按钮 ↔ 下拉的开合绑定；页面注册的 dockable 也走这一套，closeDropdowns 才管得到它 */
  function bindMenu(btn: HTMLElement, drop: HTMLElement): void {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      // 设置面板每次打开重建（播放源开关依赖当前 sessionStorage）
      if (btn === setBtn) renderSettings()
      if (!drop.hidden) {
        shutDrop(drop, btn)
        btn.setAttribute('aria-expanded', 'false')
      } else {
        btn.setAttribute('aria-expanded', 'true')
        openDrop(btn, drop, btn)
      }
    })
    drop.addEventListener('click', (e) => {
      e.stopPropagation()
      bringToFront(drop)
    })
  }
  for (const m of menus) bindMenu(m.btn, m.drop)
  document.addEventListener('click', () => closeDropdowns())

  // ── 形态注册表：工具 / 音轨 / 比例可整块切成悬浮窗 ──────────────
  // 设置与步骤不参与（用户口径：那两项保持顶栏下拉）；同一内容只有一种形态，
  // 切到悬浮窗就把顶栏那颗图标收掉，图标拖出顶栏带 / 窗体拖回顶栏带来回切换。
  type DockItem = {
    id: string
    titleKey: string
    iconHTML: string
    btn: HTMLButtonElement
    drop: HTMLElement
    home: HTMLElement
  }
  const dockItems: DockItem[] = [
    { id: 'tools', titleKey: 'topbar.tools', iconHTML: SVG.dots, btn: toolsBtn, drop: toolsDrop, home: toolsMenu },
    ...(tracksBtn && tracksDrop && tracksMenu
      ? [{ id: 'tracks', titleKey: 'topbar.tracks', iconHTML: SVG.tracks, btn: tracksBtn, drop: tracksDrop, home: tracksMenu }]
      : []),
    ...(aspectBtn && aspectDrop && aspectMenu
      ? [{ id: 'aspect', titleKey: 'topbar.aspect', iconHTML: SVG.aspect, btn: aspectBtn, drop: aspectDrop, home: aspectMenu }]
      : []),
  ]
  const dockFloats = new Map<string, FloatingHandle>()
  /** 左右两块侧编辑区：内容进来/出去都由 dock 形态切换驱动，宽度存 localStorage */
  const docks = createSideDocks()
  // 拖中缝改宽度时同样要让画布跟着重算（侧区内部自己 paint，不会触发 window resize）
  window.addEventListener('pointerup', () => {
    if (isRichLayout()) docks.refresh()
  })
  const dock: DockRegistry = createDockRegistry(docks)

  /** id → 那块内容本体，用来事后核对它究竟落在哪一格 */
  const sideContents = new Map<string, HTMLElement>()
  function syncSideSlots(): void {
    for (const [id, content] of sideContents) {
      const cell = content.closest<HTMLElement>('.sh-sidedock__slot')
      const zone = content.closest<HTMLElement>('.sh-sidedock')
      if (!cell || !zone) continue
      const side: Side = zone.dataset.side === 'left' ? 'left' : 'right'
      const slot: SideSlot = cell.classList.contains('sh-sidedock__slot--top')
        ? 'top'
        : cell.classList.contains('sh-sidedock__slot--bottom')
          ? 'bottom'
          : 'full'
      dock.rememberSlot(id, side, slot)
    }
  }

  /** 侧区一有进出/宽度变化，画布避让变量就变。第五页有 ResizeObserver 盯着容器，
   *  但第 2/3 页只监听 window resize —— 这里补发一次，否则画布还按旧宽度画。 */
  function syncCanvasAfterSide(): void {
    repositionDrops()
    window.dispatchEvent(new Event('resize'))
  }
  /** 形态切换时清掉「下拉时代」写过的内联尺寸：
   *  拉过大小的下拉换到悬浮窗/侧区后，那套 fixed 尺寸会盖住新容器的排版。 */
  function clearDropInlineSize(drop: HTMLElement): void {
    drop.style.width = ''
    drop.style.height = ''
    drop.style.maxWidth = ''
    drop.style.maxHeight = ''
    drop.style.position = ''
    drop.style.left = ''
    drop.style.top = ''
    drop.style.right = ''
  }

  /** 侧编辑区的包装层：一条标题行 + 内容。
   *  标题行不能塞进 content 自己的 children——工具下拉每次重绘都 textContent=''，
   *  会把唯一的「还原」出口一起抹掉，侧区就成了只进不出的死格。 */
  const sideWrap = new WeakMap<HTMLElement, HTMLElement>()
  function wrapOf(content: HTMLElement, titleKey: string, onRelease: () => void): HTMLElement {
    const cached = sideWrap.get(content)
    if (cached) return cached
    const box = el('div', 'sh-sidedock__panel')
    const bar = el('div', 'sh-sidedock__bar')
    const name = el('span', 'sh-sidedock__title')
    name.dataset.i18n = titleKey
    name.textContent = t(titleKey)
    const btn = el('button', 'sh-btn sh-btn--sm')
    btn.type = 'button'
    btn.dataset.i18n = 'dock.sideRelease'
    btn.textContent = t('dock.sideRelease')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onRelease()
    })
    bar.append(name, btn)
    box.append(bar, content)
    sideWrap.set(content, box)
    return box
  }

  function sideMount(
    content: HTMLElement,
    side: 'left' | 'right',
    slot: 'full' | 'top' | 'bottom',
    titleKey: string,
    onRelease: () => void,
  ): void {
    content.classList.add('sh-dropdown--side')
    // 换形态 = 换排版的负责人：下拉时代存下来的内联尺寸与贴边粗线都不该跟过来
    clearDropInlineSize(content)
    dropLayers.get(content)?.setVisible(false)
    // 进槽前内容是「收起的下拉」，hidden 还挂着 true；.sh-dropdown[hidden]{display:none}
    // 会把整块面板藏没，侧区只剩一条空框——必须在这里显式放开。
    content.hidden = false
    docks.zones[side].mount(wrapOf(content, titleKey, onRelease), slot)
    applyI18n(content)
    syncCanvasAfterSide()
    // 整条被挤成两块时，搬家的那块要按它现在的真实格子记回去
    syncSideSlots()
  }

  function sideUnmount(content: HTMLElement): void {
    if (!content.classList.contains('sh-dropdown--side')) return
    content.classList.remove('sh-dropdown--side')
    // 包装层是侧区专属的：先把内容捞出来再拆盒子，别让它跟着回顶栏/悬浮窗
    const box = sideWrap.get(content)
    if (box) {
      for (const z of [docks.zones.left, docks.zones.right]) z.unmount(box)
      sideWrap.delete(content)
    } else {
      for (const z of [docks.zones.left, docks.zones.right]) z.unmount(content)
    }
    content.remove()
    syncCanvasAfterSide()
  }
  for (const d of dockItems) {
    dock.add({
      id: d.id,
      titleKey: d.titleKey,
      iconHTML: d.iconHTML,
      btn: d.btn,
      // 这三块下拉本体是纵向排版，就是给侧编辑区准备的：拖到左/右边缘要能吸附。
      // 播放条/场景窗不在这份名单里（那两条按用户口径先不做吸附）。
      forms: ['drop', 'float', 'side'],
      showFloat: (pos, collapsed) => {
        let win = dockFloats.get(d.id)
        if (!win) {
          win = createFloatingWindow({
            storageKey: `midee.float.${d.id}`,
            host: d.drop,
            ariaLabel: t(d.titleKey),
            // 缩成悬浮小图标时沿用顶栏那颗图标，两套形态看着是同一个东西
            reopenHTML: d.iconHTML,
            reopenLabel: () => t(d.titleKey),
            resizable: { min: { w: 240, h: 140 }, max: { w: 900, h: 720 } },
            autoHide: { isPlaying: isPlayingNow },
            onDragMove: (x, y) => {
              if (isRichLayout()) docks.hover(x, y)
            },
            onDragEnd: (r) => dock.dragEnded(d.id, r),
          })
          // 标题行和场景窗同一套：六点把手 / 名称 / 图钉 / ×。
          // 这三件是 createFloatingWindow 交回调用方摆放的，之前没摆 = 拖下来的窗
          // 只能拖窗体、既关不掉也钉不住。
          const handle = win
          const bar = el('div', 'sh-float__bar')
          const name = el('strong', 'sh-float__name')
          name.textContent = t(d.titleKey)
          bar.append(handle.grip, name, handle.pinBtn, handle.closeBtn)
          handle.root.prepend(bar)
          onLocaleChange(() => {
            name.textContent = t(d.titleKey)
            handle.root.setAttribute('aria-label', t(d.titleKey))
          })
          dockFloats.set(d.id, win)
        }
        if (d.drop.parentElement !== win.root) win.root.append(d.drop)
        clearDropInlineSize(d.drop)
        dropLayers.get(d.drop)?.setVisible(false)
        d.drop.hidden = false
        d.drop.classList.add('sh-dropdown--float')
        win.root.hidden = false
        if (pos) win.setPos(pos)
        win.setCollapsed(collapsed)
      },
      hideFloat: () => {
        const win = dockFloats.get(d.id)
        if (win) {
          win.setCollapsed(true)
          win.root.hidden = true
          win.reopen.hidden = true
        }
        d.drop.classList.remove('sh-dropdown--float')
        d.drop.hidden = true
        if (d.drop.parentElement !== d.home) d.home.append(d.drop)
      },
      closeDrop: () => shutDrop(d.drop, d.btn),
      sideSlot: { side: 'right', slot: 'full' },
      mountSide: (side, slot) => {
        shutDrop(d.drop, d.btn)
        const win = dockFloats.get(d.id)
        if (win) {
          win.setCollapsed(true)
          win.root.hidden = true
          win.reopen.hidden = true
        }
        sideMount(d.drop, side, slot, d.titleKey, () => dock.setForm(d.id, 'drop'))
      },
      unmountSide: () => {
        sideUnmount(d.drop)
        if (d.drop.parentElement !== d.home) d.home.append(d.drop)
        d.drop.hidden = true
      },
    })
    sideContents.set(d.id, d.drop)
    dock.bindButton(d.id)
    // 工具/音轨/比例：下拉拖着空白处就能就地搬走——拖到侧边进侧编辑区，
    // 拖进画布中间变成悬浮窗，两处都不沾就弹回锚点。设置与步骤不参与（保持顶栏下拉）。
    attachBlankDrag(d.drop, {
      // 内容一旦变成悬浮窗或进了侧编辑区，这块 DOM 就不该再被「拖空白」搬走：
      // 前者有自己的拖拽，后者要常驻。
      enabled: () => dock.formOf(d.id) === 'drop',
      onMove: (x, y) => {
        if (isRichLayout()) docks.hover(x, y)
        d.drop.style.position = 'fixed'
        d.drop.style.left = `${Math.round(x)}px`
        d.drop.style.top = `${Math.round(y)}px`
        d.drop.style.right = 'auto'
        dropLayers.get(d.drop)?.sync()
      },
      onEnd: () => {
        const r = d.drop.getBoundingClientRect()
        const form = dock.dropDragEnded(d.id, r.left + 10, r.top + 10)
        if (form === 'drop') {
          const a = dropAnchors.get(d.drop)
          if (a) placeDrop(a, d.drop)
        }
      },
    })
  }
  /** 页面悬浮窗 ↔ 顶栏控件：内容还是页面那一份 DOM，只是父节点在
   *  「悬浮窗 root」与「外壳造的下拉」之间来回搬；两者互斥，同一时刻只存在一处。 */
  function dockFloat(spec: ShellDockFloatSpec): void {
    const menu = el('div', 'sh-menu')
    menu.dataset.dock = spec.id
    if (spec.leftmost) menu.style.order = '-1'
    const drop = el('div', 'sh-dropdown sh-dropdown--wide')
    drop.hidden = true
    const caret = spec.mini
      ? (spec.mini.querySelector<HTMLElement>('[data-dock-caret]') ?? spec.mini)
      : iconBtn(spec.iconHTML, spec.titleKey)
    menu.append(spec.mini ?? caret, drop)
    // 尺寸按 id 存：不登记就会和内置下拉一起落到 midee.dropsize.drop，互相覆盖拉出来的大小
    dropIds.set(drop, spec.id)
    group.insertBefore(menu, setMenu)
    bindMenu(caret, drop)
    managedDrops.push(drop)
    dock.add({
      id: spec.id,
      titleKey: spec.titleKey,
      iconHTML: spec.iconHTML,
      btn: menu,
      // 六点把手才是拖出点：按在播放键或秒数上拖出去会误伤那两个操作
      dragFrom: spec.mini?.querySelector<HTMLElement>('[data-dock-grip]') ?? caret,
      defaultForm: 'float',
      showFloat: (pos, collapsed) => {
        if (spec.host.parentElement !== spec.win.root) spec.win.root.append(spec.host)
        spec.win.root.hidden = false
        if (pos) spec.win.setPos(pos)
        spec.win.setCollapsed(collapsed)
      },
      hideFloat: () => {
        spec.win.setCollapsed(true)
        spec.win.root.hidden = true
        spec.win.reopen.hidden = true
        drop.append(spec.host)
      },
      closeDrop: () => shutDrop(drop, caret),
      sideSlot: { side: 'right', slot: 'full' },
      mountSide: (side, slot) => {
        shutDrop(drop, caret)
        spec.win.setCollapsed(true)
        spec.win.root.hidden = true
        spec.win.reopen.hidden = true
        sideMount(drop, side, slot, spec.titleKey, () => dock.setForm(spec.id, 'drop'))
      },
      unmountSide: () => {
        sideUnmount(drop)
        if (spec.host.parentElement !== drop) drop.append(spec.host)
      },
    })
    dock.bindButton(spec.id)
  }

  // 顶栏按钮收掉后，项目名限制区要按剩下的控件重算；
  // 转进/转出普通横屏时按各自存下来的形态重新装配一次。
  dock.onChange(() => titleZone())
  onRichChange(() => {
    dock.reapplyAll()
    titleZone()
  })

  document.addEventListener('keydown', (e) => {
    const tgt = e.target as HTMLElement | null
    const typing =
      tgt?.tagName === 'INPUT' ||
      tgt?.tagName === 'TEXTAREA' ||
      tgt?.tagName === 'SELECT' ||
      !!tgt?.isContentEditable
    if (e.key === 'Escape') {
      // 正在弹窗里的输入框打字时（缓存面板的搜索框），Esc 先退出输入框而不是把整个
      // 弹窗关掉：想中止搜索却把面板关了，得重新点开再找，是最容易被误会成「按键坏了」的那种手感
      if (typing && tgt?.closest('.sh-modal')) {
        tgt.blur()
        return
      }
      closeDropdowns()
      about.wrap.hidden = true
      help.wrap.hidden = true
      cache.wrap.hidden = true
      return
    }
    // ? 打开帮助（输入框/可编辑区内不触发）
    if (e.key === '?' && !typing && about.wrap.hidden && help.wrap.hidden && cache.wrap.hidden) openHelp()
  })

  // 系统主题变化（mode = system 时跟随）
  media?.addEventListener('change', () => {
    if (getThemeMode() !== 'system') return
    paintTheme()
    // 设置面板可能正开着：黑底白谱开关只在深色下出现，色板也按深浅取色，得跟着重建
    renderSettings()
  })

  renderSteps()
  renderStepsDrop()
  renderTools()
  renderSettings()
  applyI18n(topbar)
  titleZone()
  paintCollapse()
  // 各页 head 里那段内联看门狗的收工信号：撤掉首屏令牌副本的 data-boot 标记
  // （真 CSS 这时已经生效），并收起可能已经亮出来的「加载未完成」横幅。
  ;(window as unknown as { __lumiBooted?: () => void }).__lumiBooted?.()
  // 播放条通常是页面在 mountShell 之后才建的。等它一出现就量抽屉锚点，并盯着它的
  // 尺寸：手动折行（双击把手）、折行宽度自检、超宽折叠都会改控件条的高度，
  // 只靠 rAF 补一次的话 --sh-dock-bottom 会停在旧值，抽屉就压在变高了的条上。
  const watchDockBar = (): void => {
    const el = document.querySelector<HTMLElement>('.sh-float:has(> .sh-pb)')
    if (!el) return
    new ResizeObserver(() => dockVars()).observe(el)
    dockVars()
  }
  dockVars()
  watchDockBar()
  if (!document.querySelector('.sh-float:has(> .sh-pb)')) {
    const mo = new MutationObserver(() => {
      if (!document.querySelector('.sh-float:has(> .sh-pb)')) return
      mo.disconnect()
      watchDockBar()
    })
    mo.observe(document.body, { childList: true, subtree: true })
  }
  // 字体/折行稳定后再校一次（旧行为，保留兜底）
  requestAnimationFrame(dockVars)

  // 语言切换后：重建动态区块 + 重新翻译静态标记
  onLocaleChange(() => {
    renderSteps()
    renderStepsDrop()
    renderTools()
    renderSettings()
    applyI18n(topbar)
    // 挂到 body 上的打开中下拉不在 topbar 子树里，单独补翻
    for (const d of managedDrops) if (!d.hidden) applyI18n(d)
    pageCount.textContent = t('topbar.pagecount', { n: opts.step, total: 5 })
    paintCollapse()
    renderModals()
    if (!cache.wrap.hidden) renderCachePanel()
    const docTitleKey = DOC_TITLE_KEYS[opts.step]
    if (docTitleKey) document.title = t(docTitleKey)
  })

  return {
    topbar,
    dockFloat,
    setTitle: (text: string) => {
      if (titleText.classList.contains('is-editing')) return
      titleText.textContent = text
    },
    setTools: (next: ShellTool[]) => {
      tools = next
      renderTools()
    },
    openAbout,
    openHelp,
    openCache,
  }
}
