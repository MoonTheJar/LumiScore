const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', headless: true });
  // 模拟 Toy 容器：UA 带 wv + 完整 window.toy 26 项
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 700 },
    userAgent: 'Mozilla/5.0 (Linux; Android 10; V2031A Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.101 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  await page.addInitScript(() => {
    // 在页面脚本之前注入完整 window.toy（模拟 App 内）
    const toy = {};
    const names = ['isSupport','navigate','share','getQrCode','sharePicture','closeBrowser','getUserProfile','getCloudStorage','getSharedStorage','getAuthorProfile','getAuthorVideos','getAuthorRelation','getVideoUserActions','getRankList','getMyRank','checkInputSafety','requestCamera','requestMicrophone','stopMedia','onContainerChange','getContainerState','setContainerMode','onPlayerChange','getPlayerState','setPlayerState','onPageClose'];
    for (const n of names) toy[n] = typeof n === 'function' ? n : (() => {});
    toy.getContainerState = () => Promise.resolve({ orientation: 'portrait', immersive: false, safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, viewport: { width: 390, height: 632 } });
    toy.onContainerChange = (cb) => {};
    toy.setContainerMode = () => Promise.resolve({});
    window.toy = toy;
    window.biliInjectV2 = { postMessage: () => {} };
  });
  await page.goto('http://127.0.0.1:8124/index.html', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1800);
  // prod 模式（默认）
  for (let n = 1; n <= 6; n++) {
    await page.evaluate((nn) => { setPage(nn); }, n);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `D:/乐谱可视化/新建文件夹/scripts/container-prod-p${n}.png` });
    const d = await page.evaluate(() => {
      const f = document.getElementById('player-float');
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      const topbar = document.getElementById('shell-topbar').getBoundingClientRect();
      const controls = document.getElementById('toy-controls');
      const diag = document.getElementById('toy-diag');
      const ctrlDisp = controls ? getComputedStyle(controls).display : 'missing';
      const diagDisp = diag ? getComputedStyle(diag).display : 'missing';
      const title = document.getElementById('title-text').getBoundingClientRect();
      return {
        num: document.getElementById('page-num').textContent,
        floatDisp: cs.display,
        float: r.height ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) } : 'hidden',
        topbar: { top: Math.round(topbar.top), h: Math.round(topbar.height) },
        controls: ctrlDisp, diag: diagDisp,
        title: { x: Math.round(title.x), w: Math.round(title.width) },
      };
    });
    console.log('P' + n + ':', JSON.stringify(d));
  }
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
