const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('framenavigated', f => console.log('frame nav:', f.url().slice(0, 150)));
  await page.goto('https://www.bilibili.com/toy/lumiscore-sdk-test/51035314058240/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);
  const frames = page.frames().map(f => ({ url: f.url().slice(0, 160) }));
  console.log('frames:', JSON.stringify(frames, null, 2));
  const frame = page.frames().find(f => f.url().includes('bilibilitoy.com'));
  if (frame) {
    const d = await frame.evaluate(() => ({
      mode: document.body.dataset.mode,
      hasControls: !!document.getElementById('toy-controls'),
      hasDiag: !!document.getElementById('toy-diag'),
      testCard: document.getElementById('test-card') ? getComputedStyle(document.getElementById('test-card')).display : 'missing',
      toy: typeof window.toy,
      ready: document.readyState,
    }));
    console.log('iframe:', JSON.stringify(d, null, 2));
    const body = frame.locator('body');
    await body.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/official-p1.png' });
  } else {
    console.log('NO bilibilitoy iframe found');
    await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/official-page.png' });
  }
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
