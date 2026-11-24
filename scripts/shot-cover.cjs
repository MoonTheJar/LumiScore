// 第一页（导入页）截图，用作 toy 封面（16:9，1600x900）
const { chromium } = require('playwright')
const CHROME = 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)) })
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 120)))
  await page.goto('http://localhost:19996/lumiscore/#/import', { waitUntil: 'networkidle', timeout: 60000 })
  // 等首屏稳定（boot 隐藏、iframe 内容挂载）
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'cover-import.png' })
  console.log('SAVED cover-import.png')
  if (errors.length) console.log('CONSOLE_ERRORS:\n' + errors.join('\n'))
  else console.log('NO console errors')
  await browser.close()
})().catch((e) => { console.error('FAIL', e); process.exit(1) })
