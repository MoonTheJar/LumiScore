// 超宽屏（>2:1）那一段里，左上角的项目名和左下角的播放控件条都没有背板，
// 直接压在 3D 画面上。画面可能是星空黑，也可能是白底谱面，固定一种前景色
// 就总有一半情况看不清，所以按画面实际亮度现学：
// 取控件背后那一小块像素缩成几个点求平均亮度，暗出浅字、亮出深字。
//
// WebGL 画布默认 preserveDrawingBuffer: false，别的时机读出来是空帧，
// 因此这里不做定时轮询，只暴露一个 sample() 让页面在 render 之后同帧调用。

const mqUltra = /* @__PURE__ */ matchMedia('(min-aspect-ratio: 2/1)')

/** 平均亮度低于这个值就算「暗底」，前景用浅色 */
const DARK_THRESHOLD = 0.5

/** 采样网格：够代表一块长条区域的明暗就停手，不追求精细 */
const GRID_W = 6
const GRID_H = 3

type Slot = 'title' | 'player'

export interface ContrastProbe {
  /** 页面在 renderer.render() 之后同一同步任务里调用 */
  sample: () => void
  /** 段切换、控件折叠时把结果清掉，回到主题默认色 */
  reset: () => void
}

export function createContrastProbe(getCanvas: () => HTMLCanvasElement | null): ContrastProbe {
  const scratch = document.createElement('canvas')
  scratch.width = GRID_W
  scratch.height = GRID_H
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  const root = document.documentElement
  const applied: Record<Slot, string> = { title: '?', player: '?' }

  /** 元素背后那块画布的平均亮度（0~1）；量不到返回 null */
  function luminance(el: HTMLElement | null): number | null {
    const src = getCanvas()
    if (!el || !src || !ctx) return null
    const r = el.getBoundingClientRect()
    const c = src.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || c.width < 2 || src.width < 2) return null
    // CSS 像素 → 画布像素（画布按 DPR 放大过）
    const k = src.width / c.width
    const x = Math.max(0, Math.min(src.width - 1, (r.left - c.left) * k))
    const y = Math.max(0, Math.min(src.height - 1, (r.top - c.top) * k))
    const w = Math.max(1, Math.min(src.width - x, r.width * k))
    const h = Math.max(1, Math.min(src.height - y, r.height * k))
    try {
      ctx.drawImage(src, x, y, w, h, 0, 0, GRID_W, GRID_H)
    } catch {
      return null // 画布尺寸还没定，下一帧再来
    }
    const d = ctx.getImageData(0, 0, GRID_W, GRID_H).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) {
      sum += (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255
    }
    return sum / (d.length / 4)
  }

  function put(slot: Slot, on: 'light' | 'dark' | ''): void {
    if (applied[slot] === on) return
    applied[slot] = on
    const name = slot === 'title' ? 'ultraTitleFg' : 'ultraPlayerFg'
    if (on) root.dataset[name] = on
    else delete root.dataset[name]
  }

  function reset(): void {
    put('title', '')
    put('player', '')
  }

  let cached: { title: HTMLElement | null; player: HTMLElement | null; at: number } = {
    title: null,
    player: null,
    at: -1e9,
  }

  function sample(): void {
    if (!mqUltra.matches) {
      reset()
      return
    }
    // 元素每帧查一次太浪费，300ms 缓存一轮足够（折叠/换段都会过期重查）
    const now = performance.now()
    if (now - cached.at > 300 || !cached.title || !cached.player) {
      cached = {
        title: document.querySelector<HTMLElement>('.sh-title'),
        player: document.querySelector<HTMLElement>('.sh-float:has(> .sh-pb) .sh-pb'),
        at: now,
      }
    }
    const lt = luminance(cached.title)
    put('title', lt === null ? '' : lt < DARK_THRESHOLD ? 'light' : 'dark')
    const lp = luminance(cached.player)
    put('player', lp === null ? '' : lp < DARK_THRESHOLD ? 'light' : 'dark')
  }

  mqUltra.addEventListener('change', reset)
  return { sample, reset }
}
