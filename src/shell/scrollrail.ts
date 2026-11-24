// 自绘横向拖动条。原生滚动条在超宽（无顶栏底栏）和竖屏（底栏停靠）这两段既不能
// 抬到底栏上方，也不能和提示文字互换显隐，所以自己画一条：细、无背板、只在有横向
// 溢出时出现。滚动中显示条、隐藏提示，静止反过来（两者占同一条底边位置）。
const IDLE_MS = 700; // 最后一次 scroll 之后多久算「静止」
const MIN_THUMB = 28; // 滑块最小宽度（px）：谱太长时按比例会细到点不中

/** 超宽（min-aspect-ratio:2/1）与竖屏（max-aspect-ratio:1/1）才接管，中间那两段保留原样 */
const mqUltra = window.matchMedia('(min-aspect-ratio: 2/1)');
const mqPortrait = window.matchMedia('(max-aspect-ratio: 1/1)');

export interface ScrollRailHandle {
  update(): void;
}

/** 给一个横向滚动的容器配一条底部拖动条；容器不存在或没有横向溢出时整条隐藏 */
export function createScrollRail(getScroller: () => HTMLElement | null): ScrollRailHandle {
  const root = document.createElement('div');
  root.className = 'sh-srail';
  const thumb = document.createElement('div');
  thumb.className = 'sh-srail__thumb';
  root.append(thumb);
  document.body.append(root);

  let idleTimer = 0;
  let isActive = false; // html[data-scrolling] 当前是不是「1」（避免每次 scroll 都重设属性）

  function markScrolling(): void {
    if (idleTimer) window.clearTimeout(idleTimer);
    if (!isActive) {
      isActive = true;
      document.documentElement.dataset.scrolling = '1';
    }
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      isActive = false;
      delete document.documentElement.dataset.scrolling;
    }, IDLE_MS);
  }

  function update(): void {
    const el = getScroller();
    const span = el ? el.scrollWidth - el.clientWidth : 0;
    if (!el || span <= 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const track = root.clientWidth || 1;
    const w = Math.max(MIN_THUMB, (el.clientWidth / el.scrollWidth) * track);
    thumb.style.width = `${w}px`;
    thumb.style.transform = `translateX(${((track - w) * el.scrollLeft) / span}px)`;
  }

  // 拖滑块 = 按比例写 scrollLeft（拖动条只是滚动的另一种输入，不额外搞一套位置状态）
  thumb.addEventListener('pointerdown', (e) => {
    const el = getScroller();
    if (!el) return;
    e.preventDefault();
    // 移动/收尾都挂在 window 上：不用 setPointerCapture，指针提前释放也不会丢事件
    const track = root.clientWidth || 1;
    const span = el.scrollWidth - el.clientWidth;
    const startX = e.clientX;
    const startLeft = el.scrollLeft;
    const room = Math.max(1, track - thumb.offsetWidth);
    const move = (ev: PointerEvent): void => {
      el.scrollLeft = startLeft + ((ev.clientX - startX) / room) * span;
      markScrolling();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  // 点轨道空白处：按比例跳到那个位置
  root.addEventListener('pointerdown', (e) => {
    if (e.target === thumb) return;
    const el = getScroller();
    if (!el) return;
    const track = root.clientWidth || 1;
    const ratio = (e.clientX - root.getBoundingClientRect().left - thumb.offsetWidth / 2) / Math.max(1, track - thumb.offsetWidth);
    el.scrollLeft = Math.max(0, Math.min(1, ratio)) * (el.scrollWidth - el.clientWidth);
    markScrolling();
  });

  const el0 = getScroller();
  el0?.addEventListener('scroll', () => {
    markScrolling();
    update();
  }, { passive: true });
  window.addEventListener('resize', update);
  for (const m of [mqUltra, mqPortrait]) m.addEventListener('change', update);
  new ResizeObserver(update).observe(root);
  // 滚动容器自己的盒子不变，是里面那份内容在长（逐节铺开 / 缩放），所以内容元素也要盯
  const ro = new ResizeObserver(update);
  if (el0) ro.observe(el0);
  if (el0?.firstElementChild) ro.observe(el0.firstElementChild);
  update();
  return { update };
}
