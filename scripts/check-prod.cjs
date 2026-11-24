const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  await page.goto('http://127.0.0.1:8124/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1500);
  // prod 模式：用 JS 直接切页（UI 无切页入口是预期）
  for (let n = 1; n <= 6; n++) {
    await page.evaluate((nn) => { setPage(nn); }, n);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `D:/乐谱可视化/新建文件夹/scripts/prod-p${n}.png` });
    const d = await page.evaluate(() => {
      const f = document.getElementById('player-float');
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      const topbar = document.getElementById('shell-topbar').getBoundingClientRect();
      return {
        num: document.getElementById('page-num').textContent,
        floatDisp: cs.display,
        float: r.height ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) } : 'hidden',
        topbar: { top: Math.round(topbar.top), h: Math.round(topbar.height) },
      };
    });
    console.log('P' + n + ':', JSON.stringify(d));
  }
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
