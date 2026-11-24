// 本地验证诊断屏:截图 + 点进入正式页
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 632 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 150)); });
  await page.goto('http://127.0.0.1:8124/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1200);
  const diagVisible = await page.evaluate(() => {
    const s = document.getElementById('diag-screen');
    return s && s.style.display !== 'none';
  });
  console.log('diag visible:', diagVisible);
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/diag-local.png' });
  // dump 诊断表内容
  const tables = await page.evaluate(() => {
    const out = {};
    for (const id of ['diag-viewport', 'diag-safe', 'diag-css', 'diag-container', 'diag-res', 'diag-js']) {
      const tb = document.getElementById(id);
      const rows = [];
      for (const tr of tb.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        rows.push(tds[0].textContent + ' = ' + tds[1].textContent + (tds[1].className || ''));
      }
      out[id] = rows;
    }
    return out;
  });
  console.log(JSON.stringify(tables, null, 1));
  // 点进入正式页
  await page.click('#diag-enter');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const s = document.getElementById('diag-screen');
    return { diagGone: !s || s.style.display === 'none', mode: document.body.dataset.mode, pageNum: document.getElementById('page-num') ? document.getElementById('page-num').textContent : '?', topbarH: document.getElementById('shell-topbar') ? document.getElementById('shell-topbar').getBoundingClientRect().height : 0 };
  });
  console.log('after enter:', JSON.stringify(after));
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/diag-local-entered.png' });
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
