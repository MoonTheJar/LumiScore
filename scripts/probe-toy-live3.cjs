const { chromium } = require('playwright')
const CHROME = 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await browser.newContext()
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
      try { d = typeof msg === 'string' ? JSON.parse(msg) : d } catch (_) {}
      window.__toyLogs.push({ dir: 'send', target: origin, data: d })
      return origPost(msg, origin)
    }
  })
  const page = await ctx.newPage()
  await page.goto('https://www.bilibili.com/toy/preview/author_9lmIohDM/index.html', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(3000)

  // 在主 frame 检查 toyHost 状态
  const mainFrame = page.frames()[0]
  const hostInfo = await mainFrame.evaluate(() => {
    return {
      hasToyHost: typeof window.toyHost,
      toyHostKeys: window.toyHost ? Object.keys(window.toyHost) : [],
      hasMeta: typeof window.__TOY_META__,
      meta: window.__TOY_META__,
      logs: (window.__toyLogs || []).filter(l => l.data && (l.data.type === 'ready' || (l.data.payload))),
    }
  })
  console.log('=== host info ===')
  console.log(JSON.stringify(hostInfo, null, 2))

  // 在 iframe 里手动发 ready，看 host 回什么
  const toyFrame = page.frames().find(f => f.url().includes('bilibilitoy.com'))
  if (toyFrame) {
    await toyFrame.evaluate(() => {
      window.parent.postMessage({ type: 'ready' }, '*')
    })
    await page.waitForTimeout(2000)
    const iframeLogs = await toyFrame.evaluate(() => window.__toyLogs || [])
    console.log('\n=== iframe logs after manual ready ===')
    for (const l of iframeLogs) console.log(JSON.stringify(l))
  }

  // 再看主 frame 有没有 send
  const mainLogs = await mainFrame.evaluate(() => window.__toyLogs || [])
  console.log('\n=== main frame all logs (last 15) ===')
  for (const l of mainLogs.slice(-15)) console.log(JSON.stringify(l))

  await browser.close()
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
