const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 找 script 注入 / iframe.contentWindow
    const patterns = ['createElement(`script`)', 'createElement("script")', 'contentWindow.', 'mountToyHost', 'allowedOrigins', 'postMessage(`{', 'method:`toy.']
    for (const p of patterns) {
      let idx = c.indexOf(p)
      if (idx >= 0) {
        console.log(`\n==== ${p} @ ${idx} ====`)
        console.log(c.slice(Math.max(0, idx - 200), Math.min(c.length, idx + 500)))
      } else {
        console.log(`\n==== ${p} NOT FOUND ====`)
      }
    }
    // 找 window.ToySDK / window.toy / window.bl 等全局注入
    console.log('\n==== window 全局赋值 ====')
    const re = /window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g
    let m
    const seen = new Set()
    while ((m = re.exec(c)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); console.log('window.' + m[1]) }
    }
  })
}).on('error', (e) => console.error(e))
