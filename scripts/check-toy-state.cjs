const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push('[' + m.type() + '] ' + m.text()); });
  await page.goto('http://127.0.0.1:8124/index.html?test=1', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1500);
  const d = await page.evaluate(() => ({
    toy: typeof window.toy,
    toyKeys: window.toy ? Object.keys(window.toy) : null,
    hasControls: !!document.getElementById('toy-controls'),
    hasDiag: !!document.getElementById('toy-diag'),
    hasSafeStyle: !!document.getElementById('toy-safearea-style'),
    mode: document.body.dataset.mode,
    sdkLoaded: !!window.__TOY_META__,
    biliJsb: typeof window.biliJsbDowngradeAdapter,
  }));
  console.log(JSON.stringify(d, null, 2));
  console.log('errors:', errs.join('\n') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
