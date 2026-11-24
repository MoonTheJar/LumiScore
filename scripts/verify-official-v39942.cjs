// 线上 v39942 最终验证(自动过密码门)
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 632 }, userAgent: 'Mozilla/5.0 (Linux; Android 10; V2031A Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto('https://www.bilibili.com/toy/lumiscore-sdk-test/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  if (await page.evaluate(() => !!document.getElementById('pw'))) {
    await page.fill('#pw', '12345678abc');
    await page.click('#go');
    await page.waitForTimeout(5000);
  }
  const f = page.frames().find(x => x.url().includes('bilibilitoy.com'));
  if (!f) { console.log('NO FRAME'); await browser.close(); return; }
  console.log('frame:', f.url().slice(0, 150));
  const info = await f.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src.split('/').pop());
    const grp = document.querySelector('.sh-topbar-group').getBoundingClientRect();
    return {
      scripts,
      compatReferenced: scripts.some(s => s.indexOf('compat.js') >= 0),
      diagHidden: document.getElementById('diag-screen').hidden,
      debugBar: !!document.getElementById('debug-bar'),
      title: document.getElementById('title-text').textContent,
      step: document.getElementById('step-label').textContent,
      settingsBtn: !!document.querySelector('.sh-menu[data-menu="settings"] button'),
      pageCount: document.getElementById('pagecount-btn').textContent,
      topbarGroup: Math.round(grp.top) + 'x' + Math.round(grp.height),
      bootToy: window.__toyLocalBoot || false,
    };
  });
  console.log('official v39942:', JSON.stringify(info));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/official-v39942.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
