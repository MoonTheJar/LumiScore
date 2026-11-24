// 主项目线上验证:穿透外壳到最深 iframe
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.goto('https://www.bilibili.com/toy/lumiscore/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(6000);
  // 找最深 iframe
  const frames = page.frames();
  console.log('frames:', frames.map(x => x.url().slice(0, 140)).join('\n'));
  // 找包含 import 或 pages 的 iframe(真实内容)
  let target = frames.filter(x => x !== page.mainFrame()).find(x => !x.url().includes('index.html#') && !x.url().endsWith('/index.html'));
  if (!target) target = frames[frames.length - 1];
  console.log('target:', target.url().slice(0, 160));
  const info = await target.evaluate(() => ({
    title: document.title,
    url: location.href.slice(0, 120),
    text: document.body.innerText.slice(0, 300),
    hasCanvas: !!document.querySelector('canvas'),
    topbar: (() => { const t = document.querySelector('[data-testid="shell-topbar"], #shell-topbar, .sh-topbar, .topbar'); return t ? t.className.slice(0, 80) : 'N/A'; })(),
    buttons: Array.from(document.querySelectorAll('button')).slice(0, 12).map(b => b.textContent.trim().slice(0, 20)).join(','),
  }));
  console.log('deep info:', JSON.stringify(info));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/main-live.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
