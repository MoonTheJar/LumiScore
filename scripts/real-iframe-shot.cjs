const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await page.goto('https://www.bilibili.com/toy/preview/author_fsZhkOwm/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4000);
  const frame = page.frames().find(f => f.url().includes('bilibilitoy.com'));
  if (!frame) { console.log('NO iframe'); process.exit(1); }
  // 用 locator 截 iframe 内 body
  const body = frame.locator('body');
  await body.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/real-iframe-p1.png' });
  // 检查 Toy 控件是否真的可见
  const vis = await frame.evaluate(() => {
    const c = document.getElementById('toy-controls');
    const d = document.getElementById('toy-diag');
    const v = (el) => {
      if (!el) return 'missing';
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    };
    return { controls: v(c), diag: v(d) };
  });
  console.log('Toy controls visibility:', JSON.stringify(vis, null, 2));
  // 切换到有播放条的页看看
  await frame.evaluate(() => { setPage(2); });
  await page.waitForTimeout(400);
  const body2 = frame.locator('body');
  await body2.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/real-iframe-p2.png' });
  console.log('done');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
