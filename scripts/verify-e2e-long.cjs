// 端到端重跑:等待转换完成(最长 120s),记录阶段推进
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 150)));
  page.on('console', m => { if (m.type() === 'error') errs.push('[c]' + m.text().slice(0, 120)); });
  await page.goto('https://www.bilibili.com/toy/lumiscore/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  let imp = null;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); imp = page.frames().find(x => x.url().includes('pages/import')); if (imp) break; }
  if (!imp) { console.log('NO IMPORT FRAME'); await browser.close(); return; }
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const txt = await imp.evaluate(() => { const w = document.querySelector('.rp-wrap .rp-label'); return w ? w.textContent : ''; });
    if (txt.includes('就绪')) break;
  }
  const clicked = await imp.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(x => x.textContent.includes('巴赫'));
    if (!b) return false; b.click(); return true;
  });
  console.log('sample clicked:', clicked);
  // 记录弹窗阶段状态(每 5s)
  let lk = null;
  let prev = '';
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    lk = page.frames().find(x => x.url().includes('pages/link2d'));
    if (lk) break;
    const st = await imp.evaluate(() => {
      const modal = document.querySelector('.imp-modal');
      const status = document.getElementById('status');
      return { modal: modal ? modal.textContent.trim().replace(/\s+/g, ' ').slice(0, 160) : '', status: status ? status.textContent.trim() : '' };
    });
    const key = st.modal.slice(0, 60);
    if (key !== prev) { console.log(`${i * 5}s: ${JSON.stringify(st)}`); prev = key; }
  }
  if (!lk) {
    console.log('STILL NO LINK2D after 120s');
    const st = await imp.evaluate(() => { const m = document.querySelector('.imp-modal'); return m ? m.textContent.trim().replace(/\s+/g, ' ').slice(0, 200) : 'no modal'; });
    console.log('final modal:', st);
    console.log('errors:', errs.join(' | ') || '(none)');
    await browser.close(); return;
  }
  console.log('LINK2D reached:', lk.url().slice(0, 130));
  // link2d 渐进挂载采样
  const tl = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const snap = await lk.evaluate(() => {
      const svg = document.querySelector('svg');
      const prog = document.querySelector('.rp-wrap .rp-label');
      return { svgNodes: svg ? svg.querySelectorAll('*').length : 0, prog: prog ? prog.textContent.trim() : '', emptyNext: !!document.getElementById('emptyNext') };
    });
    tl.push(`${i}s: ${JSON.stringify(snap)}`);
  }
  console.log('link2d timeline:\n' + tl.join('\n'));
  console.log('errors:', errs.join(' | ') || '(none)');
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/e2e-link2d.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
