// 验证诊断屏新增:安全区滑轨 + 站内重载
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 632 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  await page.goto('http://127.0.0.1:8124/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1000);
  // 滑轨存在?
  const hasSim = await page.evaluate(() => {
    return ['sim-top', 'sim-left', 'sim-bottom', 'sim-reset', 'diag-reload', 'diag-enter'].every(id => !!document.getElementById(id));
  });
  console.log('controls present:', hasSim);
  // 拖动顶部滑轨到 54
  await page.evaluate(() => {
    const inp = document.getElementById('sim-top');
    inp.value = 54;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const after = await page.evaluate(() => {
    return {
      manual: window.__manualSafe,
      cssTop: getComputedStyle(document.documentElement).getPropertyValue('--toy-safe-top').trim(),
      label: document.getElementById('sim-top-v').textContent,
      topbarTop: document.getElementById('shell-topbar').getBoundingClientRect().top,
    };
  });
  console.log('after slide:', JSON.stringify(after));
  // 进正式页(滑轨保持 54)
  await page.click('#diag-enter');
  await page.waitForTimeout(500);
  const ent = await page.evaluate(() => {
    const tb = document.getElementById('shell-topbar');
    return { topbarTop: tb.getBoundingClientRect().top, cssTop: getComputedStyle(document.documentElement).getPropertyValue('--toy-safe-top').trim() };
  });
  console.log('entered with 54px safe:', JSON.stringify(ent));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/diag-slider-shot.png' });
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
