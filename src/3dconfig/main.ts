// ── 第 4 步：小球轨迹形状（v0.1 占位页） ──
//
// v0.1 范围：只锁定「轨迹路径形状」这一个开关（暂时只有抛物线），
// 其余小球外观 / 材质 / 拖尾 / 轨迹线样式全部挪到第 5 页 3D 空间里实时调。
// 本页其余选项以「即将支持」灰置展示，不写业务数据；2.5 秒后自动进入第 5 页。

import { applyI18n, onLocaleChange } from '../shell/i18n'
import { goStep, mountShell } from '../shell/shell'

interface TrajOpt {
  id: string
  label: string
  preview: string
  soon?: boolean
}

const TRAJS: TrajOpt[] = [
  {
    id: 'parabola',
    label: '抛物线',
    preview:
      '<svg viewBox="0 0 96 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 20 C30 4 66 4 90 20"/></svg>',
  },
  {
    id: 'line',
    label: '直线',
    preview:
      '<svg viewBox="0 0 96 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"><path d="M6 20 H90"/></svg>',
    soon: true,
  },
  {
    id: 'spline',
    label: '平滑曲线',
    preview:
      '<svg viewBox="0 0 96 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"><path d="M6 20 C26 10 40 22 58 12 S82 8 90 16"/></svg>',
    soon: true,
  },
]

const KEY_TRAJ = 'midee.trajShape'

function readPick(): string {
  const saved = sessionStorage.getItem(KEY_TRAJ)
  return saved && TRAJS.some((o) => o.id === saved && !o.soon) ? saved : 'parabola'
}
function savePick(v: string): void {
  sessionStorage.setItem(KEY_TRAJ, v)
  try { localStorage.setItem(KEY_TRAJ, v) } catch { /* noop */ }
}

function renderHost(host: HTMLElement): void {
  const current = readPick()
  host.textContent = ''
  for (const o of TRAJS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'p3-opt'
    b.dataset.id = o.id
    b.setAttribute('aria-pressed', String(o.id === current))
    if (o.soon) {
      b.disabled = true
      b.style.cursor = 'not-allowed'
      b.style.opacity = '0.55'
    }
    const prev = document.createElement('div')
    prev.className = 'p3-opt__prev'
    prev.innerHTML = o.preview
    const name = document.createElement('div')
    name.className = 'p3-opt__name'
    name.textContent = o.label
    b.append(prev, name)
    if (o.soon) {
      const soon = document.createElement('div')
      soon.className = 'p3-opt__soon'
      soon.textContent = '即将支持'
      b.append(soon)
    }
    b.addEventListener('click', () => {
      if (o.soon) return
      savePick(o.id)
      renderHost(host)
    })
    host.append(b)
  }
}

const name = sessionStorage.getItem('midee.name') ?? ''
mountShell({
  step: 4,
  title: name,
  onTitleRename: (text) => {
    try { sessionStorage.setItem('midee.name', text) } catch { /* noop */ }
  },
})

const trajsHost = document.getElementById('trajs')
if (trajsHost) renderHost(trajsHost)
if (!sessionStorage.getItem('midee.xml')) {
  const warn = document.getElementById('warn')
  if (warn) warn.hidden = false
}

document.getElementById('prev')?.addEventListener('click', () => goStep(3))
document.getElementById('next')?.addEventListener('click', () => goStep(5))

applyI18n(document.body)
onLocaleChange(() => {
  applyI18n(document.body)
  if (trajsHost) renderHost(trajsHost)
})

// 2.5 秒自动进入第 5 页（用户手动点「上一步」或「下一步」则取消倒计时）
let cancelled = false
const cancel = (): void => { cancelled = true }
document.getElementById('prev')?.addEventListener('click', cancel)
document.getElementById('next')?.addEventListener('click', cancel)
window.addEventListener('beforeunload', cancel)
setTimeout(() => {
  if (!cancelled) goStep(5)
}, 2500)

// 装配完成上报：模块顶层求值到此全部走完。中途抛错时这两行不会执行，
// index.html 里的内联看门狗据此把「本页控件没装上」显式报出来（横幅 + 修复页签自检项），
// 而不是留下「页面看着正常、下拉全没了」的静默半初始化状态。
const reportAssembled = (
  window as unknown as { __lumiReady?: () => void }
).__lumiReady
reportAssembled?.()
