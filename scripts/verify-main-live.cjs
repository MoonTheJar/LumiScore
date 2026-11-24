// 主项目线上验证:确认新版本 + 渲染正常
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.goto('https://www.bilibili.com/toy/lumiscore/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(4000);
  let f = page.frames().find(x => x.url().includes('bilibilitoy.com') && x.url().includes('lumiscore'));
  if (!f) {
    // 可能还在外层,等一会再找
    await page.waitForTimeout(6000);
    f = page.frames().find(x => x.url().includes('bilibilitoy.com') && x.url().includes('lumiscore'));
    if (!f) { console.log('FRAME NOT FOUND, urls:', page.frames().map(x => x.url().slice(0, 120)).join(' | ')); await browser.close(); return; }
  }
  console.log('iframe:', f.url().slice(0, 180));
  const info = await f.evaluate(() => ({
    title: document.title,
    topbar: (() => { const t = document.querySelector('[data-testid="shell-topbar"], #shell-topbar, .sh-topbar'); return t ? t.className.slice(0, 60) : 'N/A'; })(),
    hasStage: !!document.getElementById('stage'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    hasSettings: !!document.querySelector('.sh-menu[data-menu="settings"]'),
    hasDiag: !!document.getElementById('toy-diag') || !!document.getElementById('diag-screen') || !!document.getElementById('debug-bar'),
    text: document.body.innerText.slice(0, 200),
  }));
  console.log('main page:', JSON.stringify(info));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/main-live.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
