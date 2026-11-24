// 验证主项目"逐步加载"补丁:首次进入显示预热进度卡(rp-wrap)且逐步推进
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const shots = [];
  page.on('console', m => { if (m.type() === 'error') shots.push('[console] ' + m.text().slice(0, 120)); });
  await page.goto('https://www.bilibili.com/toy/lumiscore/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  // 每 500ms 采样 .rp-wrap 状态,记录时间线
  const timeline = [];
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(500);
    const snap = await page.evaluate(() => {
      const w = document.querySelector('.rp-wrap');
      const lbl = w ? w.querySelector('.rp-label') : null;
      const bar = w ? w.querySelector('.rp-bar') : null;
      return {
        hasProgress: !!w,
        text: lbl ? lbl.textContent.trim() : '',
        width: bar ? getComputedStyle(bar).width : '',
        topbarText: (() => { const tb = document.querySelector('.sh-topbar'); return tb ? tb.textContent.trim().slice(0, 60) : ''; })(),
      };
    });
    timeline.push(`${i * 500}ms: ${JSON.stringify(snap)}`);
    if (snap.hasProgress === false && snap.topbarText.includes('导入')) break;
  }
  console.log('timeline:\n' + timeline.join('\n'));
  // 等稳定后取最深 iframe 内容
  await page.waitForTimeout(3000);
  const frames = page.frames();
  let target = frames.filter(x => x !== page.mainFrame()).find(x => x.url().includes('pages/import'));
  if (!target) target = frames[frames.length - 1];
  const info = await target.evaluate(() => ({
    url: location.href.slice(0, 100),
    text: document.body.innerText.slice(0, 200),
    hasProgress: !!document.querySelector('.rp-wrap'),
    buttons: Array.from(document.querySelectorAll('button')).slice(0, 6).map(b => b.textContent.trim().slice(0, 15)).join(','),
  }));
  console.log('final:', JSON.stringify(info));
  console.log('console errors:', shots.join(' | ') || '(none)');
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/main-live2.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
