const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    console.log('len=' + c.length)
    // postMessage 上下文
    console.log('\n==== postMessage contexts ====')
    let idx = 0, n = 0
    while ((idx = c.indexOf('postMessage', idx)) >= 0 && n < 8) {
      const s = Math.max(0, idx - 180)
      const e = Math.min(c.length, idx + 220)
      console.log(`--- @${idx} ---`)
      console.log(c.slice(s, e))
      idx += 11
      n++
    }
    // 找 client sdk js url
    console.log('\n==== .js refs ====')
    const re = /["'`]([^"'`]*\.js[^"'`]*)["'`]/g
    let m
    const seen = new Set()
    while ((m = re.exec(c)) !== null) {
      if (!seen.has(m[1]) && m[1].includes('toy')) {
        seen.add(m[1])
        console.log(m[1])
      }
    }
    // 找 toyClient / window.parent 相关
    console.log('\n==== parent / iframe contentWindow ====')
    idx = 0; n = 0
    while ((idx = c.indexOf('contentWindow', idx)) >= 0 && n < 5) {
      const s = Math.max(0, idx - 150)
      const e = Math.min(c.length, idx + 200)
      console.log(`--- @${idx} ---`)
      console.log(c.slice(s, e))
      idx += 13; n++
    }
  })
}).on('error', (e) => console.error(e))
