// 自绘下拉：外观与交互对齐音轨面板里的「音色」下拉（按钮 + ▾，列表挂 body、fixed 定位，
// 一次只开一个，点外部 / Esc 关闭）。用它替浏览器原生 <select>，因为原生弹层的样式
// 各浏览器不一致，触屏上还是另一套系统 UI，没法跟着主题走。
// 键盘可达：按钮上 ArrowDown/Up/Enter/Space 展开，列表内方向键/Home/End 移动、Enter 选中、
// Esc 关闭并把焦点还给按钮（role=listbox/option + aria-expanded）。
import { bringToFront } from './layer'

export interface SelectOption {
  v: string
  l: string
  /** 分组标题：只在这一项前面画一次 */
  grp?: string
}

export interface SelectHandle {
  el: HTMLElement
  value(): string
  setValue(v: string): void
  setOptions(list: SelectOption[]): void
  setDisabled(b: boolean): void
}

let openDd: { el: HTMLElement; btn: HTMLButtonElement } | null = null;

function closeOpen(restoreFocus = false): void {
  if (!openDd) return;
  const { el, btn } = openDd;
  el.remove();
  btn.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
  openDd = null;
  if (restoreFocus) btn.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (!openDd) return;
  const t = e.target;
  if (t instanceof Node && !openDd.el.contains(t) && t !== openDd.btn) closeOpen();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openDd) closeOpen(true);
});
// 视口一变，fixed 的列表就对不上按钮了，直接收掉（重开即按新位置排）
window.addEventListener('resize', () => closeOpen());

export function isSelectUI(node: EventTarget | null): boolean {
  const el = node instanceof Element ? node : null;
  return !!el?.closest?.('.sh-select, .sh-select__dd');
}

export function createSelect(opts: {
  options: SelectOption[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  className?: string;
}): SelectHandle {
  let list = opts.options;
  let cur = opts.value;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sh-select' + (opts.className ? ' ' + opts.className : '');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (opts.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
  const label = document.createElement('span');
  label.className = 'sh-select__label';
  const caret = document.createElement('span');
  caret.className = 'sh-select__caret';
  caret.textContent = '▾';
  btn.append(label, caret);

  function paint(): void {
    const hit = list.find((x) => x.v === cur);
    label.textContent = hit ? hit.l : (list[0]?.l ?? '');
  }

  function choose(v: string): void {
    cur = v;
    paint();
    closeOpen(true);
    opts.onChange(v);
  }

  function open(): void {
    closeOpen();
    const dd = document.createElement('div');
    dd.className = 'sh-select__dd';
    dd.setAttribute('role', 'listbox');
    if (opts.ariaLabel) dd.setAttribute('aria-label', opts.ariaLabel);
    // 列表整体阻止冒泡：否则点项会冒到 document 触发外壳 closeDropdowns，
    // 把宿主菜单（音轨面板/工具菜单）整个收起，选一次就得重开。
    dd.addEventListener('click', (e) => e.stopPropagation());
    const items: HTMLButtonElement[] = [];
    for (const o of list) {
      if (o.grp) {
        const g = document.createElement('div');
        g.className = 'sh-select__grp';
        g.textContent = o.grp;
        dd.append(g);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sh-select__item' + (o.v === cur ? ' is-cur' : '');
      b.textContent = o.l;
      b.dataset.v = o.v;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', o.v === cur ? 'true' : 'false');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        choose(o.v);
      });
      items.push(b);
      dd.append(b);
    }
    dd.addEventListener('keydown', (e) => {
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      // 本组件消费的键一律不往外冒：否则宿主页面把同一个键另作快捷操作
      // （第 2 页 Alt+方向键微调符号、Esc 清选择集会在展开态下同时生效）
      if (
        e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' ||
        e.key === 'End' || e.key === 'Enter' || e.key === ' ' ||
        e.key === 'Escape' || e.key === 'Tab'
      ) e.stopPropagation();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[Math.min(items.length - 1, idx + 1)]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[Math.max(0, idx - 1)]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        (document.activeElement as HTMLButtonElement | null)?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeOpen(true);
      } else if (e.key === 'Tab') {
        closeOpen();
      }
    });
    document.body.append(dd);
    const r = btn.getBoundingClientRect();
    const w = dd.offsetWidth || 252;
    const h = dd.offsetHeight || 120;
    dd.style.position = 'fixed';
    dd.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    // 下面放不下就往上弹；两个方向都得夹回窗口内——锚点被滚出窗口时，
    // 光算 r.top - h 仍可能把整块甩到下沿之外
    const below = window.innerHeight - r.bottom - 12;
    const top = below >= h || r.top < below ? r.bottom + 4 : r.top - h - 4;
    dd.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
    openDd = { el: dd, btn };
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    bringToFront(dd);
    // 焦点移入当前项（无则首项），键盘用户展开即可直接方向键选择
    ;(items.find((it) => it.dataset.v === cur) ?? items[0])?.focus();
  }

  btn.addEventListener('click', () => {
    if (openDd?.btn === btn) {
      closeOpen();
      return;
    }
    open();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation(); // 同上：这几个键归本组件
      if (openDd?.btn === btn) closeOpen(true);
      else open();
    }
  });
  paint();

  return {
    el: btn,
    value: () => cur,
    setValue(v: string): void {
      cur = v;
      paint();
    },
    setOptions(next: SelectOption[]): void {
      list = next;
      if (!list.some((x) => x.v === cur)) cur = list[0]?.v ?? '';
      paint();
    },
    setDisabled(b: boolean): void {
      btn.disabled = b;
      btn.classList.toggle('is-disabled', b);
      if (b && openDd?.btn === btn) closeOpen();
    },
  };
}