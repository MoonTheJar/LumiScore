// 打开 toy 预览页，在 iframe 上下文抓 postMessage 协议
const { chromium } = require('playwright')
const CHROME = 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // 收集所有 console
  const logs = []
  page.on('console', (m) => logs.push('[console] ' + m.text()))
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))

  // 监听主窗口的 message（通过 CDP 注入）
  await page.goto('https://www.bilibili.com/toy/preview/author_9lmIohDM/index.html', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(3000)

  // 找 iframe
  const frames = page.frames()
  console.log('frames count:', frames.length)
  for (const f of frames) console.log('  frame url:', f.url())

  // 在主页面注入 message 监听
  await page.evaluate(() => {
    window.__toyLogs = []
    window.addEventListener('message', (ev) => {
      window.__toyLogs.push({ dir: 'recv', origin: ev.origin, data: ev.data })
    })
    const orig = window.parent ? window.parent.postMessage : null
    // 监听 iframe 里的 postMessage 发出
  })

  // 在每个 frame 里注入监听
  for (const f of frames) {
    try {
      await f.evaluate(() => {
        window.__toyLogs = []
        window.addEventListener('message', (ev) => {
          window.__toyLogs.push({ dir: 'recv', origin: ev.origin, data: ev.data })
        })
        // 拦截 postMessage 发出
        const origPost = window.postMessage.bind(window)
        window.postMessage = function (msg, origin) {
          window.__toyLogs.push({ dir: 'send', target: origin, data: msg })
          return origPost(msg, origin)
        }
      })
    } catch (e) { console.log('frame eval err:', e.message) }
  }

  // 等 2 秒让自动握手发生
  await page.waitForTimeout(2000)

  // 收集所有日志
  for (const f of frames) {
    try {
      const l = await f.evaluate(() => window.__toyLogs || [])
      console.log(`\n=== frame: ${f.url().slice(0, 80)} ===`)
      for (const item of l) {
        console.log(JSON.stringify(item, null, 2))
      }
    } catch (e) {}
  }

  console.log('\n=== page console ===')
  console.log(logs.join('\n'))

  await browser.close()
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
