// lumiscore hash 路由外壳：URL 形如 index.html#/import … #/3dpreview。
// 五个步骤页是独立 HTML（各自初始化 Verovio/Tone/WASM，与原多页应用同构），
// 由全屏 iframe 承载；页间「下一步/步骤切换」通过 postMessage 通知外壳改 hash，
// 浏览器前进/后退与 URL 分享均可用。直接访问某页（dev/独立打开）时页内跳转
// 仍走普通 location.href，不依赖外壳（见 shell.ts goStep）。
const STEPS = ['import', '2dpreview', 'link2d', '3dconfig', '3dpreview'] as const
type StepName = (typeof STEPS)[number]

const frame = document.getElementById('stage') as HTMLIFrameElement
const boot = document.getElementById('boot') as HTMLDivElement
let current = ''

function hashToStep(): StepName {
  const m = /^#\/([a-z0-9]+)/i.exec(location.hash)
  const s = m?.[1]
  return (STEPS as readonly string[]).includes(s ?? '') ? (s as StepName) : 'import'
}

function render(): void {
  const step = hashToStep()
  if (step === current) return
  current = step
  boot?.classList.remove('is-hidden')
  frame.src = `pages/${step}/index.html`
}

/** 内层页面是否真的把外壳挂上了（同源才读得到；读不到就退回老行为） */
function innerBooted(): boolean {
  try {
    return (frame.contentDocument?.documentElement.dataset.topbar ?? '') === 'expanded'
  } catch {
    return true
  }
}

const BOOT_MSG = '星跃谱 LumiScore · 正在载入…'
let pollTimer = 0

frame.addEventListener('load', () => {
  // 首帧可能是 about:blank；只在真页面载入后开始等
  if (!frame.src || /about:blank/.test(frame.src)) return
  clearInterval(pollTimer)
  const hide = (): void => {
    clearInterval(pollTimer)
    boot?.classList.add('is-hidden')
  }
  // load 只代表 HTML 到手：内层那张模块依赖图还在下载/求值，甚至可能已经抛错。
  // 原来这里直接隐藏 boot，内层挂了就成了「外壳说加载完了，里面还是空的」。
  if (innerBooted()) {
    hide()
    return
  }
  let waited = 0
  pollTimer = window.setInterval(() => {
    waited += 300
    if (innerBooted()) {
      hide()
      return
    }
    if (waited < 15000) return
    clearInterval(pollTimer)
    if (!boot) return
    boot.textContent = '这一步没能加载完成，点此重试'
    boot.style.pointerEvents = 'auto'
    boot.style.cursor = 'pointer'
    boot.onclick = () => {
      boot.textContent = BOOT_MSG
      boot.style.pointerEvents = 'none'
      boot.style.cursor = ''
      boot.onclick = null
      boot.classList.remove('is-hidden')
      current = '' // 让 render() 真的重挂一次，而不是被同一步骤名短路
      render()
    }
  }, 300)
})

window.addEventListener('hashchange', render)

// 页内导航消息：{ lumiscore: 'nav', step: 1..5 }
window.addEventListener('message', (e) => {
  // 仅接受同源 iframe 的导航消息（file:// 下双方 origin 均为字符串 "null"，亦匹配）
  if (e.origin !== window.location.origin) return
  const d = e.data as { lumiscore?: string; step?: number } | null
  if (d?.lumiscore !== 'nav' || typeof d.step !== 'number') return
  const s = STEPS[d.step - 1]
  if (!s) return
  const want = `#/${s}`
  if (location.hash !== want) location.hash = want
})

// 静默补一个起始 hash（不产生多余历史记录）
if (!location.hash) history.replaceState(null, '', '#/import')
render()
