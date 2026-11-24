const { chromium } = require('playwright')
const CHROME = 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await browser.newContext()

  // 每个 frame 加载前就注入 message 拦截
  await ctx.addInitScript(() => {
    window.__toyLogs = []
    window.addEventListener('message', (ev) => {
      let d = ev.data
      try { d = typeof d === 'string' ? JSON.parse(d) : d } catch (_) {}
      window.__toyLogs.push({ dir: 'recv', origin: ev.origin, data: d })
    })
    const origPost = window.postMessage.bind(window)
    window.postMessage = function (msg, origin) {
      let d = msg
      try { d = typeof msg === 'string' ? JSON.parse(msg) : msg } catch (_) {}
      window.__toyLogs.push({ dir: 'send', target: origin, data: d })
      return origPost(msg, origin)
    }
  })

  const page = await ctx.newPage()
  const logs = []
  page.on('console', (m) => logs.push('[console] ' + m.text()))
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))

  await page.goto('https://www.bilibili.com/toy/preview/author_9lmIohDM/index.html', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(5000)

  for (const f of page.frames()) {
    try {
      const l = await f.evaluate(() => window.__toyLogs || [])
      console.log(`\n=== frame: ${f.url().slice(0, 90)} (${l.length} msgs) ===`)
      for (const item of l) console.log(JSON.stringify(item))
    } catch (e) { console.log('frame err:', e.message) }
  }
  console.log('\n=== console ===')
  console.log(logs.slice(0, 30).join('\n'))
  await browser.close()
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
