const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 搜方向/沉浸相关字符串
    const keywords = ['landscape', 'portrait', 'immersive', 'orientation', 'fullscreen', 'safeArea', 'containerMode', 'setContainerMode', 'getContainerState', 'onContainerChange']
    for (const kw of keywords) {
      let idx = 0, n = 0
      console.log(`\n==== ${kw} ====`)
      while ((idx = c.toLowerCase().indexOf(kw.toLowerCase(), idx)) >= 0 && n < 4) {
        const s = Math.max(0, idx - 120)
        const e = Math.min(c.length, idx + 180)
        console.log(`--- @${idx} ---`)
        console.log(c.slice(s, e))
        idx += kw.length; n++
      }
    }
  })
}).on('error', (e) => console.error(e))
