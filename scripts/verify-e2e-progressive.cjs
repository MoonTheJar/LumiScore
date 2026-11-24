// 端到端:示例乐谱 → 转换 → 2D 修正页(渐进式挂载验证)
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 150)));
  await page.goto('https://www.bilibili.com/toy/lumiscore/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  let imp = null;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); imp = page.frames().find(x => x.url().includes('pages/import')); if (imp) break; }
  if (!imp) { console.log('NO IMPORT FRAME'); await browser.close(); return; }
  // 等预热 done
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const txt = await imp.evaluate(() => { const w = document.querySelector('.rp-wrap .rp-label'); return w ? w.textContent : ''; });
    if (txt.includes('就绪')) break;
  }
  console.log('engine ready, clicking sample...');
  // 点第一个示例乐谱(巴赫)
  const clicked = await imp.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(x => x.textContent.includes('巴赫'));
    if (!b) return false;
    b.click(); return true;
  });
  console.log('sample clicked:', clicked);
  // 等待转换完成 → 自动跳 link2d
  let lk = null;
  let steps = [];
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    lk = page.frames().find(x => x.url().includes('pages/link2d'));
    if (lk) break;
    // 记录导入页状态(转换进度)
    const st = await imp.evaluate(() => {
      const s = document.getElementById('status');
      const rp = document.querySelector('.rp-wrap .rp-label');
      const modal = document.querySelector('.imp-modal');
      return { status: s ? s.textContent.trim() : '', prog: rp ? rp.textContent.trim() : '', modal: modal ? modal.textContent.trim().slice(0, 80) : '' };
    });
    steps.push(`${i * 500}ms: ${JSON.stringify(st)}`);
  }
  console.log('import steps:\n' + steps.join('\n'));
  if (!lk) { console.log('NO LINK2D FRAME after 30s'); await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/e2e-fail.png' }); await browser.close(); return; }
  console.log('link2d frame:', lk.url().slice(0, 130));
  // link2d 渐进式挂载:采样谱面节点数量变化
  const timeline = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const snap = await lk.evaluate(() => {
      const svg = document.querySelector('svg');
      const prog = document.querySelector('.rp-wrap .rp-label');
      return {
        svgNodes: svg ? svg.querySelectorAll('*').length : 0,
        prog: prog ? prog.textContent.trim() : '',
        emptyNext: !!document.getElementById('emptyNext'),
        noteBtn: !!document.getElementById('nextBtn'),
      };
    });
    timeline.push(`${i * 500}ms: ${JSON.stringify(snap)}`);
  }
  console.log('link2d timeline:\n' + timeline.join('\n'));
  console.log('errors:', errs.join(' | ') || '(none)');
  await page.screenshot({ path: 'D:/乐谱可视化/新建文件夹/scripts/e2e-link2d.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
