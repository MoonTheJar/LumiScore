// 导入处理弹窗：进度步骤逐条透明公开 + 中间默认折叠的日志栏（4 栏分级）+
// 底部左边提示语、右边继续/取消按钮。
//
// 结束模式：
//   running     执行中（提示“请稍等…”，只有取消）
//   unsupported 文件不支持（“抱歉，不支持当前文件” + 取消）
//   fatal       有无法处理的错误（“抱歉，我们无法处理…” + 取消，错误栏自动展开）
//   confirm     自动矫正 / 反复展开（提示 + “我同意自动更改 继续”）
//   perfect     完全正确（“你的文件没有任何问题”，自动进入下一步）

import './import-modal.css'
import { bringToFront } from '../shell/layer'
import { applyI18n, onLocaleChange, t } from '../shell/i18n'
import { createAudioPrefs } from './audio-prefs-ui'

export type StageState = 'wait' | 'run' | 'done' | 'error'
export type FinishMode = 'running' | 'unsupported' | 'fatal' | 'confirm' | 'perfect'

export interface ImportLogs {
  fatal: string[]
  auto: string[]
  repeat: string[]
  ok: string[]
}

export interface ImportModalHandle {
  setStage(i: number, state: StageState, note?: string): void
  setLogs(logs: ImportLogs): void
  finish(mode: FinishMode, opts?: { hint?: string; hintName?: string; onContinue?: () => void; autoMs?: number }): void
  close(): void
}

interface SectionDef {
  level: keyof ImportLogs
  titleKey: string
  open: (n: number) => boolean
}

export function openImportProcess(
  stages: string[],
  onCancel: () => void,
): ImportModalHandle {
  const root = document.createElement('div')
  root.className = 'imp-modal'
  root.innerHTML = `
    <div class="imp-card" data-mode="running" role="dialog" aria-modal="true">
      <div class="imp-head"><span class="imp-spinner"></span><h2 class="imp-title" data-i18n="imp.title"></h2></div>
      <div class="imp-stages"></div>
      <button class="imp-log-toggle" type="button" aria-expanded="false" hidden>
        <span class="imp-log-caret">▸</span><span class="imp-log-label"></span>
      </button>
      <div class="imp-log" hidden></div>
      <div class="imp-prefs" data-prefs-mount></div>
      <div class="imp-foot">
        <div class="imp-hint"></div>
        <button class="sh-btn imp-cancel" type="button" data-i18n="confirm.cancel"></button>
        <button class="sh-btn sh-btn--primary imp-continue" type="button" data-i18n="imp.continue" hidden></button>
      </div>
    </div>`
  document.body.appendChild(root)
  applyI18n(root)
  bringToFront(root)

  const card = root.querySelector<HTMLElement>('.imp-card')!
  const stagesEl = root.querySelector<HTMLElement>('.imp-stages')!
  const logToggle = root.querySelector<HTMLButtonElement>('.imp-log-toggle')!
  const logEl = root.querySelector<HTMLElement>('.imp-log')!
  const hintEl = root.querySelector<HTMLElement>('.imp-hint')!
  const cancelBtn = root.querySelector<HTMLButtonElement>('.imp-cancel')!
  const continueBtn = root.querySelector<HTMLButtonElement>('.imp-continue')!

  // 音频偏好控件（与「下载资源 → 音色」共用同一份实现与样式）
  const prefs = createAudioPrefs({
    sf: 'imp.pref.sf', sfHint: 'imp.pref.sfHint',
    poll: 'imp.pref.poll', pollHint: 'imp.pref.pollHint',
    mirror: 'imp.pref.mirror', mirrorHint: 'imp.pref.mirrorHint',
  })
  root.querySelector('[data-prefs-mount]')!.appendChild(prefs.el)

  const stageEls: HTMLElement[] = stages.map((s) => {
    const row = document.createElement('div')
    row.className = 'imp-stage'
    row.dataset.state = 'wait'
    row.innerHTML = `<span class="imp-stage__dot">·</span><span class="imp-stage__label" data-i18n="${s}"></span><span class="imp-stage__note"></span>`
    stagesEl.appendChild(row)
    return row
  })
  applyI18n(stagesEl)

  let currentLogs: ImportLogs = { fatal: [], auto: [], repeat: [], ok: [] }

  const SECTIONS: SectionDef[] = [
    { level: 'fatal', titleKey: 'imp.sec.fatal', open: () => true },
    { level: 'auto', titleKey: 'imp.sec.auto', open: (n) => n > 0 },
    { level: 'repeat', titleKey: 'imp.sec.repeat', open: (n) => n > 0 },
    { level: 'ok', titleKey: 'imp.sec.ok', open: () => false },
  ]
  // 各栏手动折叠状态优先（用户手动关过的栏，刷新日志时不再强制弹开）
  const userToggled = new Set<string>()

  function renderLog(): void {
    const total =
      currentLogs.fatal.length + currentLogs.auto.length +
      currentLogs.repeat.length + currentLogs.ok.length
    logToggle.hidden = total === 0
    const badCount = currentLogs.fatal.length + currentLogs.auto.length + currentLogs.repeat.length
    logToggle.querySelector('.imp-log-label')!.textContent =
      badCount ? t('imp.logAttention', { n: badCount }) : t('imp.log')
    logEl.textContent = ''
    for (const sec of SECTIONS) {
      const items = currentLogs[sec.level]
      if (!items.length) continue
      const wrap = document.createElement('div')
      wrap.className = 'imp-log__section'
      wrap.dataset.level = sec.level
      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'imp-log__head'
      const isOpen = userToggled.has(sec.level)
        ? logEl.dataset[`open_${sec.level}`] === '1'
        : sec.open(items.length)
      head.setAttribute('aria-expanded', String(isOpen))
      head.innerHTML =
        `<span class="imp-log__caret">▸</span><span class="imp-log__title"></span><span class="imp-log__count"></span>`
      head.querySelector('.imp-log__title')!.textContent = t(sec.titleKey)
      head.querySelector('.imp-log__count')!.textContent = t('imp.logCount', { n: items.length })
      const ul = document.createElement('ul')
      ul.className = 'imp-log__items'
      ul.hidden = !isOpen
      for (const msg of items) {
        const li = document.createElement('li')
        li.textContent = msg
        ul.appendChild(li)
      }
      head.addEventListener('click', () => {
        const next = ul.hidden
        ul.hidden = !next
        head.setAttribute('aria-expanded', String(next))
        userToggled.add(sec.level)
        logEl.dataset[`open_${sec.level}`] = next ? '1' : '0'
      })
      wrap.append(head, ul)
      logEl.appendChild(wrap)
    }
    // 任一“需关注”栏有内容 → 默认展开整个日志栏
    const autoOpenLog =
      currentLogs.fatal.length > 0 || currentLogs.auto.length > 0 || currentLogs.repeat.length > 0
    logEl.hidden = !autoOpenLog
    logToggle.setAttribute('aria-expanded', String(autoOpenLog))
  }

  logToggle.addEventListener('click', () => {
    const next = logEl.hidden
    logEl.hidden = !next
    logToggle.setAttribute('aria-expanded', String(next))
  })

  function setMode(mode: FinishMode): void {
    card.dataset.mode = mode
  }

  // 底部提示语随语言切换重绘（动态文本不走 data-i18n，故单独保存重绘闭包）
  let repaintHint: () => void = () => { hintEl.textContent = t('imp.hint.running') }

  cancelBtn.addEventListener('click', () => {
    onCancel()
    close()
  })
  const offLocale = onLocaleChange(() => {
    applyI18n(root)
    renderLog()
    repaintHint()
  })
  function close(): void {
    offLocale()
    prefs.destroy()
    root.remove()
  }

  const handle: ImportModalHandle = {
    setStage(i, state, note) {
      const row = stageEls[i]
      if (!row) return
      row.dataset.state = state
      row.querySelector('.imp-stage__note')!.textContent = note ?? ''
      const dot = row.querySelector('.imp-stage__dot')!
      dot.textContent = state === 'done' ? '✓' : state === 'error' ? '!' : state === 'run' ? '…' : '·'
    },
    setLogs(logs) {
      currentLogs = logs
      renderLog()
    },
    finish(mode, opts) {
      setMode(mode)
      const { hint, hintName, onContinue, autoMs = 900 } = opts ?? {}
      cancelBtn.hidden = false
      continueBtn.hidden = true
      if (mode === 'running') {
        repaintHint = () => { hintEl.textContent = hint ?? t('imp.hint.running') }
      } else if (mode === 'unsupported') {
        repaintHint = () => {
          hintEl.textContent = hint ?? (hintName !== undefined
            ? t('imp.err.unsupported', { name: hintName })
            : t('imp.hint.unsupported'))
        }
      } else if (mode === 'fatal') {
        repaintHint = () => { hintEl.textContent = hint ?? t('imp.hint.fatal') }
      } else if (mode === 'confirm') {
        repaintHint = () => { hintEl.textContent = (hint ? `${hint} ` : '') + t('imp.hint.confirm') }
        continueBtn.hidden = false
        continueBtn.onclick = () => {
          onContinue?.()
          close()
        }
      } else if (mode === 'perfect') {
        repaintHint = () => { hintEl.textContent = hint ?? t('imp.hint.perfect') }
        cancelBtn.hidden = true
        window.setTimeout(() => {
          if (root.isConnected) {
            onContinue?.()
            close()
          }
        }, autoMs)
      }
      repaintHint()
    },
    close,
  }

  handle.setStage(0, 'run')
  handle.finish('running')
  return handle
}
