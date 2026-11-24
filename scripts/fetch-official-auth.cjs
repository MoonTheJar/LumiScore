// 验证密码后抓真实外壳 HTML,找 iframe 真实地址
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const SLUG = 'lumiscore-sdk-test';
const PW = '12345678abc';
const BASE = 'https://www.bilibili.com';

function req(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cookie': opts.cookie || '',
      ...(opts.headers || {}),
    };
    const r = https.request(u, { method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let text = buf.toString('utf8');
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') text = zlib.gunzipSync(buf).toString('utf8');
          else if (enc === 'br') text = zlib.brotliDecompressSync(buf).toString('utf8');
          else if (enc === 'deflate') text = zlib.inflateSync(buf).toString('utf8');
        } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  // 1) POST /toy/verify 拿 cookie
  const form = `slug=${encodeURIComponent(SLUG)}&password=${encodeURIComponent(PW)}`;
  const v = await req(`${BASE}/toy/verify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': BASE, 'Referer': `${BASE}/toy/${SLUG}/index.html` } }, form);
  console.log('verify status:', v.status);
  console.log('verify body:', v.body.slice(0, 300));
  const setCookies = (v.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log('cookies:', setCookies.slice(0, 200));
  // 2) 带 cookie 访问官方链接(不带 id 正确姿势)
  const page = await req(`${BASE}/toy/${SLUG}/index.html`, { cookie: setCookies });
  console.log('page status:', page.status);
  console.log('page len:', page.body.length);
  fs.writeFileSync('D:/乐谱可视化/新建文件夹/scripts/official-shell-auth.html', page.body);
  // 3) 找 iframe / 资源 URL
  const iframes = [...page.body.matchAll(/<iframe[^>]*src="([^"]+)"/g)].map(m => m[1]);
  console.log('iframes:', JSON.stringify(iframes));
  const srcHints = [...page.body.matchAll(/(?:src|href)="([^"]*(?:bilibilitoy|toy\/|lumiscore)[^"]*)"/g)].map(m => m[1]);
  console.log('url hints:', JSON.stringify(srcHints.slice(0, 20)));
})().catch(e => { console.error('ERR', e); process.exit(1); });
