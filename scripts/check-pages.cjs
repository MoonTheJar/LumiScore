const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  await page.goto('http://127.0.0.1:8124/index.html?test=1', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1200);
  const results = [];
  for (let n = 1; n <= 6; n++) {
    const d = await page.evaluate(() => {
      const f = document.getElementById('player-float');
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      const topbar = document.getElementById('shell-topbar').getBoundingClientRect();
      const title = document.getElementById('title-text');
      const tr = title.getBoundingClientRect();
      return {
        num: document.getElementById('page-num').textContent,
        mode: document.body.dataset.mode,
        floatDisp: cs.display,
        float: r.height ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : 'hidden',
        topbar: { top: Math.round(topbar.top), h: Math.round(topbar.height) },
        title: { x: Math.round(tr.x), w: Math.round(tr.width), text: title.textContent },
        card: getComputedStyle(document.getElementById('test-card')).display,
      };
    });
    results.push(d);
    const nb = await page.$('#next-btn');
    if (nb && (await nb.isVisible())) { await nb.click(); }
    else { await page.evaluate(() => document.getElementById('cycle-btn').click()); }
    await page.waitForTimeout(350);
  }
  console.log(JSON.stringify(results, null, 2));
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
