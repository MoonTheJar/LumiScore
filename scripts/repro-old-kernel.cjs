// 模拟 B 站 App 旧内核（Chrome 84-87）：UA 带 wv + window.toy 26 项
// 关键：拦截 shell.css/test.css，把旧内核不支持的 CSS 特性整段丢弃后再注入
//   - color-mix(...) 声明 → 删除整条 declaration
//   - :has(...) 选择器 → 删除整条 rule
//   - 100dvh/100svh → 只留 100vh
//   - aspect-ratio 属性 → 删除该 declaration
//   - container queries → 删除 @container 块
// 这样模拟旧内核解析 CSS 后的真实效果，复现用户截图现象
const { chromium } = require('playwright');
const fs = require('fs');

const OLD_CSS = (raw) => {
  let css = raw;
  // 1) 删除 color-mix() 所在 declaration（整条 ; 或 } 截止）
  css = css.replace(/[^;{}]*color-mix\([^;]*;/g, '');
  // 2) 删除 :has(...) 规则块（选择器含 :has 的整条 rule）
  css = css.replace(/[^{}]*:has\([^{}]*\)[^{]*\{[^{}]*\}/g, '');
  // 3) dvh -> vh（保留 vh 前值）
  css = css.replace(/100dvh/g, '100vh').replace(/100svh/g, '100vh');
  // 4) aspect-ratio 属性声明删除（排除媒体查询头，只删以分号结尾的声明）
  css = css.replace(/[^{};]*aspect-ratio\s*:\s*[^;{}]*;/g, '');
  // 5) @container 块删除（container queries 不支持）
  css = css.replace(/@container[^{]*\{[\s\S]*?\n\}/g, '');
  return css;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Users\\蒙泽嘉\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
    headless: true,
  });
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 632 },
    userAgent: 'Mozilla/5.0 (Linux; Android 10; V2031A Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.101 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

  // 拦截 CSS：旧内核丢弃特性后注入
  await page.route(/shell\.css$|test\.css$/, async route => {
    const resp = await route.fetch();
    const raw = await resp.text();
    const old = OLD_CSS(raw);
    fs.writeFileSync(`D:/乐谱可视化/新建文件夹/scripts/oldkernel-${resp.url().split('/').pop()}`, old);
    await route.fulfill({ response: resp, body: old });
  });

  // 模拟 App 容器：完整 window.toy + biliInjectV2
  await page.addInitScript(() => {
    const toy = {};
    const names = ['isSupport','navigate','share','getQrCode','sharePicture','closeBrowser','getUserProfile','getCloudStorage','getSharedStorage','getAuthorProfile','getAuthorVideos','getAuthorRelation','getVideoUserActions','getRankList','getMyRank','checkInputSafety','requestCamera','requestMicrophone','stopMedia','onContainerChange','getContainerState','setContainerMode','onPlayerChange','getPlayerState','setPlayerState','onPageClose'];
    for (const n of names) toy[n] = () => {};
    toy.getContainerState = () => Promise.resolve({ orientation: 'portrait', immersive: false, safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, viewport: { width: 360, height: 632 } });
    toy.onContainerChange = (cb) => {};
    toy.setContainerMode = () => Promise.resolve({});
    window.toy = toy;
    window.biliInjectV2 = { postMessage: () => {} };
  });

  await page.goto('https://www.bilibilitoy.com/toy/preview/author_fsZhkOwm/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);
  // 诊断:脚本是否加载、setPage 是否存在、错误
  const diag = await page.evaluate(() => {
    const scripts = [...document.scripts].map(s => s.src || '(inline)');
    return {
      scripts,
      hasSetPage: typeof window.setPage,
      readyState: document.readyState,
      bodyMode: document.body.dataset.mode,
      testJs: !!document.querySelector('script[src$="test.js"]'),
      compatJs: !!document.querySelector('script[src$="compat.js"]'),
      toy: typeof window.toy,
    };
  });
  console.log('DIAG:', JSON.stringify(diag, null, 2));
  console.log('errors so far:', errs.join(' | ') || '(none)');

  // 逐页截图 + 状态 dump
  for (let n = 1; n <= 6; n++) {
    await page.evaluate((nn) => { setPage(nn); }, n);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `D:/乐谱可视化/新建文件夹/scripts/oldkernel-p${n}.png` });
    const d = await page.evaluate(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return 'missing';
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return `${cs.display} rect=${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      };
      const topbar = document.getElementById('shell-topbar').getBoundingClientRect();
      const float = document.getElementById('player-float');
      const fcs = getComputedStyle(float);
      const fr = float.getBoundingClientRect();
      const menus = [...document.querySelectorAll('.sh-topbar-group .sh-menu:not(.rail-panel-entry)')]
        .map(m => m.dataset.menu + '=' + (getComputedStyle(m).display));
      return {
        num: document.getElementById('page-num').textContent,
        mode: document.body.dataset.mode,
        topbar: { top: Math.round(topbar.top), h: Math.round(topbar.height), w: Math.round(topbar.width) },
        brand: vis('shell-topbar') && (() => { const b = document.querySelector('.sh-brand'); const r = b.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); })(),
        title: vis('title-text'),
        pagecount: vis('pagecount-btn'),
        stepBtn: vis('step-btn'),
        menus,
        next: vis('next-wrap'),
        float: `${fcs.display} rect=${Math.round(fr.x)},${Math.round(fr.y)} ${Math.round(fr.width)}x${Math.round(fr.height)}`,
        testCard: vis('test-card'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    console.log('P' + n + ':', JSON.stringify(d));
  }
  console.log('errors:', errs.join(' | ') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
