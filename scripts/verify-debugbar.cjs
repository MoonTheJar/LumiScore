// 验证重构:默认正式页 / 调试浮层滑轨 / ?diag=1 诊断屏
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 632 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  await page.goto('http://127.0.0.1:8124/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(800);
  const init = await page.evaluate(() => ({
    diagHidden: document.getElementById('diag-screen').hidden,
    debugBarVisible: getComputedStyle(document.getElementById('debug-bar')).display !== 'none',
    panelHidden: document.getElementById('db-panel').hidden,
    toggleText: document.getElementById('db-toggle').textContent,
    topbarTop: document.getElementById('shell-topbar').getBoundingClientRect().top,
    floatVisible: getComputedStyle(document.getElementById('player-float')).display !== 'none',
    pageNum: document.getElementById('page-num').textContent,
  }));
  console.log('init (expect diag hidden, debug bar visible, panel hidden):', JSON.stringify(init));
  // 展开调试浮层
  await page.click('#db-toggle');
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => ({
    panelHidden: document.getElementById('db-panel').hidden,
    toggleText: document.getElementById('db-toggle').textContent,
  }));
  console.log('after toggle (expect panel shown):', JSON.stringify(opened));
  // 拖顶部滑轨到 54
  await page.evaluate(() => {
    const inp = document.getElementById('db-top');
    inp.value = 54;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const slid = await page.evaluate(() => ({
    manual: window.__manualSafe,
    cssTop: getComputedStyle(document.documentElement).getPropertyValue('--toy-safe-top').trim(),
    topbarTop: document.getElementById('shell-topbar').getBoundingClientRect().top,
    eff: document.getElementById('db-eff').textContent,
  }));
  console.log('after slide 54 (expect cssTop=54px, topbarTop=54):', JSON.stringify(slid));
  // 恢复默认
  await page.click('#db-reset');
  await page.waitForTimeout(200);
  const reset = await page.evaluate(() => ({
    manual: window.__manualSafe,
    cssTop: getComputedStyle(document.documentElement).getPropertyValue('--toy-safe-top').trim(),
    topbarTop: document.getElementById('shell-topbar').getBoundingClientRect().top,
  }));
  console.log('after reset (expect null / empty / 0):', JSON.stringify(reset));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/official-page-debugbar.png' });
  // ?diag=1 诊断屏
  await page.goto('http://127.0.0.1:8124/index.html?diag=1', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(800);
  const diag = await page.evaluate(() => ({
    diagHidden: document.getElementById('diag-screen').hidden,
    hasViewportRows: document.querySelectorAll('#diag-viewport tr').length,
    hasSafeRows: document.querySelectorAll('#diag-safe tr').length,
    hasCssRows: document.querySelectorAll('#diag-css tr').length,
    hasResRows: document.querySelectorAll('#diag-res tr').length,
    hasJsRows: document.querySelectorAll('#diag-js tr').length,
    verdict: document.getElementById('diag-verdict').textContent.slice(0, 30),
  }));
  console.log('?diag=1 (expect visible + tables filled):', JSON.stringify(diag));
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
