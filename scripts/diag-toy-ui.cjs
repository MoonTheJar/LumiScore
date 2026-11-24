// 打开 B站官方 Toy 页面，抓 iframe 实际布局数值（诊断 UI 异常根因）
const { chromium } = require('playwright')
const CHROME = 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'

const TARGET = process.argv[2] || 'https://www.bilibili.com/toy/lumiscore-sdk-test/51035314058240/index.html'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console.error] ' + m.text()) })

  await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(4000)

  console.log('final url:', page.url())
  console.log('frames:')
  for (const f of page.frames()) console.log('  ', f.url())

  // 在 iframe（bilibilitoy.com）里抓布局数值
  const toyFrame = page.frames().find(f => f.url().includes('bilibilitoy.com')) || page.frames()[0]
  try {
    const info = await toyFrame.evaluate(() => {
      const de = document.documentElement
      const vb = (n, s) => { const v = document.getElementById(n); if (!v) return null; const r = v.getBoundingClientRect(); return `${n}: top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} h=${Math.round(r.height)} ${s} visible=${s !== 'none' && s !== 'hidden'}` }
      const topbar = document.getElementById('shell-topbar')
      const float = document.getElementById('player-float')
      const page = document.getElementById('page-num')
      const vp = document.getElementById('vp-info')
      const gs = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { pos: cs.position, disp: cs.display, vis: cs.visibility, z: cs.zIndex } }
      return {
        inner: [window.innerWidth, window.innerHeight],
        client: [de.clientWidth, de.clientHeight],
        dpr: window.devicePixelRatio,
        visual: window.visualViewport ? [window.visualViewport.width, window.visualViewport.height] : null,
        topbarRect: vb('shell-topbar'),
        topbarCss: gs(topbar),
        floatRect: vb('player-float'),
        floatCss: gs(float),
        pageRect: vb('page-num'),
        vpText: vp ? vp.textContent : null,
        hasToy: typeof window.toy,
        toyState: window.__toyState,
        cssVars: {
          safeTop: de.style.getPropertyValue('--toy-safe-top'),
          safeBottom: de.style.getPropertyValue('--toy-safe-bottom'),
          ori: de.style.getPropertyValue('--toy-orientation'),
          imm: de.style.getPropertyValue('--toy-immersive'),
        },
        scroll: [window.scrollX, window.scrollY],
        bodyH: document.body ? document.body.scrollHeight : null,
      }
    })
    console.log('\n=== iframe layout ===')
    console.log(JSON.stringify(info, null, 2))
  } catch (e) { console.log('frame eval err:', e.message) }

  console.log('\n=== errors ===')
  console.log(errs.slice(0, 20).join('\n') || '(none)')
  await browser.close()
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
