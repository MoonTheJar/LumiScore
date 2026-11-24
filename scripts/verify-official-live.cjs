// 真实渲染正式版:带 cookie 打开官方链接 → iframe 诊断屏 → 进正式页
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 10; V2031A Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36' });
  await ctx.addCookies([{ name: 'toy_access', value: 'MTc5Mzc3OTUyNw.11abdb58d7c62e45951c5ca8fadd07a6b52ba3559f5728f62f590a3de0ddeaea', domain: '.bilibili.com', path: '/', httpOnly: true, secure: true }]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 200)); });
  await page.goto('https://www.bilibili.com/toy/lumiscore-sdk-test/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  // 密码门:自动填密码过门
  const gate = await page.evaluate(() => !!document.getElementById('pw'));
  if (gate) {
    console.log('password gate -> submitting');
    await page.fill('#pw', '12345678abc');
    await page.click('#go');
    await page.waitForTimeout(5000);
  }
  // 等 iframe
  const frames = page.frames();
  const toyFrame = frames.find(f => f.url().includes('bilibilitoy.com'));
  console.log('frames:', frames.map(f => f.url().slice(0, 90)).join(' | '));
  if (toyFrame) {
    console.log('toy frame URL:', toyFrame.url().slice(0, 140));
    const info = await toyFrame.evaluate(() => {
      const s = document.getElementById('diag-screen');
      return {
        diagHidden: !s || s.hidden === true,
        debugBar: !!document.getElementById('debug-bar'),
        dbToggle: document.getElementById('db-toggle') ? document.getElementById('db-toggle').textContent : '?',
        dbPanelHidden: document.getElementById('db-panel') ? document.getElementById('db-panel').hidden : '?',
        hasDbTop: !!document.getElementById('db-top'),
        hasDbLeft: !!document.getElementById('db-left'),
        hasDbBottom: !!document.getElementById('db-bottom'),
        hasDbReset: !!document.getElementById('db-reset'),
        hasDbReload: !!document.getElementById('db-reload'),
        mode: document.body.dataset.mode,
        inner: window.innerWidth + 'x' + window.innerHeight,
        topbarH: document.getElementById('shell-topbar') ? Math.round(document.getElementById('shell-topbar').getBoundingClientRect().height) : -1,
        bootCompat: window.__compatBoot || false,
        bootToy: window.__toyLocalBoot || false,
        setPage: typeof window.setPage === 'function',
        bootExport: window.__exportBoot || false,
      };
    });
    console.log('toy frame info:', JSON.stringify(info));
    // 截图整页(iframe 渲染)
    await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/official-diag-shot.png' });
  } else {
    // 没有 toy iframe —— 看主页面是什么(密码门?)
    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '(no body)');
    console.log('NO toy frame. body:', body);
    await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/official-noframe-shot.png' });
  }
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
