// 音频偏好控件（自动拉取音色 / 多镜像轮询 / 下载镜像）——导入审核窗与
// 「下载资源 → 音色」共用同一份实现与样式（.sh-apref），镜像下拉走外壳自绘
// createSelect，不再各用一套原生 <select>/<checkbox>。订阅 onAudioPrefChange
// 让两处实例实时同步，订阅 onLocaleChange 重绘标签。
import { createSelect } from '../shell/select'
import { applyI18n, onLocaleChange, t } from '../shell/i18n'
import {
  getAutoPoll, getAutoSoundfont, getDownloadMirror,
  onAudioPrefChange, setAutoPoll, setAutoSoundfont, setDownloadMirror,
} from './audio-prefs'
import { SOUND_BASE_LABELS } from '../3dpreview/smplr-soundfont'

export interface AudioPrefsKeys {
  sf: string
  sfHint: string
  poll: string
  pollHint: string
  mirror: string
  mirrorHint: string
}

export interface AudioPrefsHandle {
  el: HTMLElement
  destroy(): void
}

export function createAudioPrefs(keys: AudioPrefsKeys): AudioPrefsHandle {
  const el = document.createElement('div')
  el.className = 'sh-aprefs'
  el.innerHTML = `
    <label class="sh-apref">
      <input type="checkbox" data-apref="sf">
      <span data-i18n="${keys.sf}"></span>
      <em data-i18n="${keys.sfHint}"></em>
    </label>
    <label class="sh-apref">
      <input type="checkbox" data-apref="poll">
      <span data-i18n="${keys.poll}"></span>
      <em data-i18n="${keys.pollHint}"></em>
    </label>
    <div class="sh-apref sh-apref--select">
      <span data-i18n="${keys.mirror}"></span>
      <span data-apref-mirror></span>
      <em data-i18n="${keys.mirrorHint}"></em>
    </div>`

  const sf = el.querySelector<HTMLInputElement>('[data-apref="sf"]')!
  const poll = el.querySelector<HTMLInputElement>('[data-apref="poll"]')!
  const mirror = createSelect({
    options: SOUND_BASE_LABELS.map((l, i) => ({ v: String(i), l })),
    value: String(getDownloadMirror()),
    onChange: (v) => setDownloadMirror(Number(v)),
    ariaLabel: t(keys.mirror),
  })
  el.querySelector('[data-apref-mirror]')!.replaceWith(mirror.el)

  // 只读回填，不调用 setter，避免自身 emit 触发死循环
  function syncFromStore(): void {
    sf.checked = getAutoSoundfont()
    poll.checked = getAutoPoll()
    mirror.setValue(String(getDownloadMirror()))
    mirror.setDisabled(getAutoPoll())
  }
  sf.addEventListener('change', () => setAutoSoundfont(sf.checked))
  poll.addEventListener('change', () => setAutoPoll(poll.checked))
  syncFromStore()
  applyI18n(el)

  const offPref = onAudioPrefChange(syncFromStore)
  const offLocale = onLocaleChange(() => {
    applyI18n(el)
    mirror.el.setAttribute('aria-label', t(keys.mirror))
  })

  return {
    el,
    destroy(): void {
      offPref()
      offLocale()
      el.remove()
    },
  }
}