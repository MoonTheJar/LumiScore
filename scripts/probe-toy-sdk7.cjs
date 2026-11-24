const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 搜 postMessage 调用
    const re = /\.postMessage\(/g
    let m
    let n = 0
    while ((m = re.exec(c)) !== null && n < 10) {
      console.log(`\n--- postMessage @${m.index} ---`)
      console.log(c.slice(Math.max(0, m.index - 300), m.index + 200))
      n++
    }
    // 搜 handler / method 构造
    console.log('\n\n==== handler: ====')
    let idx = 0
    n = 0
    while ((idx = c.indexOf('handler:', idx)) >= 0 && n < 5) {
      console.log(c.slice(Math.max(0, idx - 100), idx + 150))
      idx += 8; n++
    }
  })
}).on('error', (e) => console.error(e))
