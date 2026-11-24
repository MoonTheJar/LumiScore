const https = require('https');
const fs = require('fs');
const url = 'https://www.bilibili.com/toy/lumiscore-sdk-test/51035314058240/index.html';
https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } }, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    fs.writeFileSync('D:/乐谱可视化/新建文件夹/scripts/official-html.html', body);
    console.log('status:', res.statusCode);
    console.log('length:', body.length);
    console.log('--- first 2000 chars ---');
    console.log(body.slice(0, 2000));
    console.log('--- has data-mode script:', body.includes("data-mode"));
    console.log('--- has compat.js:', body.includes('compat.js'));
    console.log('--- has toy-sdk.js(local):', body.includes('toy-sdk.js'));
  });
}).on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
