const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const url = 'https://www.bilibili.com/toy/lumiscore-sdk-test/51035314058240/index.html';
https.get(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept-Encoding': 'gzip, deflate, br',
  },
}, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    const buf = Buffer.concat(chunks);
    console.log('status:', res.statusCode);
    console.log('content-encoding:', res.headers['content-encoding']);
    console.log('content-type:', res.headers['content-type']);
    let text = buf.toString('utf8');
    if (res.headers['content-encoding'] === 'gzip') {
      text = zlib.gunzipSync(buf).toString('utf8');
    } else if (res.headers['content-encoding'] === 'br') {
      text = zlib.brotliDecompressSync(buf).toString('utf8');
    } else if (res.headers['content-encoding'] === 'deflate') {
      text = zlib.inflateSync(buf).toString('utf8');
    }
    fs.writeFileSync('D:/乐谱可视化/新建文件夹/scripts/official-html-decoded.html', text);
    console.log('decoded length:', text.length);
    console.log('--- first 3000 chars ---');
    console.log(text.slice(0, 3000));
    console.log('--- has data-mode:', text.includes('data-mode'));
    console.log('--- has compat.js:', text.includes('compat.js'));
    console.log('--- has test-card:', text.includes('test-card'));
    console.log('--- has export-panel:', text.includes('export-panel'));
  });
}).on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
