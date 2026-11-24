const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 200)); });
  page.on('framenavigated', f => console.log('frame nav:', f.url().slice(0, 120)));
  await page.goto('https://www.bilibili.com/toy/preview/author_fsZhkOwm/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4000);
  // 找 iframe
  const frames = page.frames().map(f => ({ url: f.url().slice(0, 150), isMain: f === page.mainFrame() }));
  console.log('frames:', JSON.stringify(frames, null, 2));
  // 尝试在 iframe 里执行
  for (const f of page.frames()) {
    if (f.url().includes('bilibilitoy.com') || f.url().includes('127.0.0.1') || f.url() !== page.mainFrame().url()) {
      try {
        const d = await f.evaluate(() => {
          const body = document.body;
          return {
            mode: body.dataset.mode,
            html: body.innerHTML.slice(0, 300),
            toy: typeof window.toy,
            hasControls: !!document.getElementById('toy-controls'),
            hasDiag: !!document.getElementById('toy-diag'),
            testCard: document.getElementById('test-card') ? getComputedStyle(document.getElementById('test-card')).display : 'missing',
          };
        });
        console.log('iframe state:', JSON.stringify(d, null, 2));
        await f.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/real-preview.png' });
      } catch (e) { console.log('iframe eval failed:', e.message.slice(0, 150)); }
    }
  }
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/real-preview-page.png' });
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
