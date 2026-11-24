const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  // 手机 UA 模拟
  const pixel = devices['Pixel 5'];
  const ctx = await browser.newContext({ ...pixel });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 150)); });
  await page.goto('https://www.bilibili.com/toy/preview/author_fsZhkOwm/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);
  const frame = page.frames().find(f => f.url().includes('bilibilitoy.com'));
  if (!frame) { console.log('NO iframe (mobile)'); process.exit(1); }
  const d = await frame.evaluate(() => ({
    mode: document.body.dataset.mode,
    innerW: window.innerWidth, innerH: window.innerHeight,
    toy: typeof window.toy,
    controls: document.getElementById('toy-controls') ? getComputedStyle(document.getElementById('toy-controls')).display : 'missing',
    diag: document.getElementById('toy-diag') ? getComputedStyle(document.getElementById('toy-diag')).display : 'missing',
    testCard: document.getElementById('test-card') ? getComputedStyle(document.getElementById('test-card')).display : 'missing',
    viewport: document.querySelector('.test-viewport') ? getComputedStyle(document.querySelector('.test-viewport')).display : 'missing',
  }));
  console.log('mobile iframe:', JSON.stringify(d, null, 2));
  const body = frame.locator('body');
  await body.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/mobile-preview-p1.png' });
  // 切到第 2 页看播放条
  await frame.evaluate(() => setPage(2));
  await page.waitForTimeout(500);
  const body2 = frame.locator('body');
  await body2.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/mobile-preview-p2.png' });
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
