// 验证原版化:无 compat.js / 无 CSS 双声明兜底 / 页面+调试浮层正常
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 632 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  await page.goto('http://127.0.0.1:8124/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(800);
  const check = await page.evaluate(() => {
    // 无 compat.js 引用
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    return {
      compatReferenced: scripts.some(s => s.indexOf('compat.js') >= 0),
      scripts: scripts.map(s => s.split('/').pop()),
      diagHidden: document.getElementById('diag-screen').hidden,
      debugBar: !!document.getElementById('debug-bar'),
      topbarRows: (() => {
        const tb = document.getElementById('shell-topbar');
        return {
          title: document.getElementById('title-text').textContent,
          step: document.getElementById('step-label').textContent,
          hasSettings: !!document.querySelector('.sh-menu[data-menu="settings"] button'),
          pageCount: document.getElementById('pagecount-btn').textContent,
        };
      })(),
      bodyMode: document.body.dataset.mode,
    };
  });
  console.log('page check:', JSON.stringify(check));
  // 顶栏两行按钮布局位置
  const tb = await page.evaluate(() => {
    const g = document.querySelector('.sh-topbar-group');
    const r = g.getBoundingClientRect();
    return { groupTop: Math.round(r.top), groupBottom: Math.round(r.bottom), groupLeft: Math.round(r.left), groupRight: Math.round(r.right) };
  });
  console.log('topbar group rect:', JSON.stringify(tb));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/vanilla-page.png' });
  // 调试浮层仍工作
  await page.click('#db-toggle');
  await page.evaluate(() => {
    const inp = document.getElementById('db-top');
    inp.value = 100;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const slid = await page.evaluate(() => ({
    panelOpen: !document.getElementById('db-panel').hidden,
    cssTop: getComputedStyle(document.documentElement).getPropertyValue('--toy-safe-top').trim(),
    topbarTop: document.getElementById('shell-topbar').getBoundingClientRect().top,
  }));
  console.log('debug bar after slide 100:', JSON.stringify(slid));
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
