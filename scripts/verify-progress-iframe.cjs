// 验证 iframe 内预热进度卡逐步推进
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.goto('https://www.bilibili.com/toy/lumiscore/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  // 等 iframe 出现
  let target = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    target = page.frames().find(x => x.url().includes('pages/import'));
    if (target) break;
  }
  if (!target) { console.log('NO IMPORT FRAME'); await browser.close(); return; }
  console.log('iframe found:', target.url().slice(0, 120));
  // 进 iframe 采样进度卡
  const timeline = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const snap = await target.evaluate(() => {
      const w = document.querySelector('.rp-wrap');
      const lbl = w ? w.querySelector('.rp-label') : null;
      const bar = w ? w.querySelector('.rp-bar') : null;
      const tb = document.querySelector('.sh-topbar');
      return {
        hasProgress: !!w,
        text: lbl ? lbl.textContent.trim() : '',
        barW: bar ? getComputedStyle(bar).width : '',
        topbar: tb ? tb.textContent.trim().replace(/\s+/g, ' ').slice(0, 50) : '',
        dropOk: !!document.getElementById('drop'),
      };
    });
    timeline.push(`${i * 500}ms: ${JSON.stringify(snap)}`);
    if (!snap.hasProgress && snap.topbar && snap.dropOk) break;
  }
  console.log('iframe timeline:\n' + timeline.join('\n'));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/main-live3.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
