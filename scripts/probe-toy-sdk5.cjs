const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 从 Do 函数开始，打印后面 3000 字符
    const idx = c.indexOf('function Do(')
    if (idx >= 0) {
      console.log('==== Do function ====')
      console.log(c.slice(idx, idx + 3000))
    }
  })
}).on('error', (e) => console.error(e))
