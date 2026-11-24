const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 搜所有 URL（.js / sdk / client）
    const re = /[`'"]([^`'"]*?\.js[^`'"]*)[`'"]/g
    let m
    const urls = new Set()
    while ((m = re.exec(c)) !== null) {
      if (m[1].includes('sdk') || m[1].includes('toy') || m[1].includes('client') || m[1].includes('seed')) urls.add(m[1])
    }
    console.log('=== JS URLs ===')
    for (const u of urls) console.log(u)

    // 搜 s1.hdslb / bfs 路径
    console.log('\n=== bfs paths ===')
    const re2 = /[`'"](\/bfs\/[^`'"]*)[`'"]/g
    while ((m = re2.exec(c)) !== null) console.log(m[1])

    // 搜 toy-sdk / toy-client
    console.log('\n=== toy-sdk/client refs ===')
    for (const kw of ['toy-sdk', 'toy-client', 'sdk.js', 'client.js', 'injectScript', 'eval(']) {
      const idx = c.indexOf(kw)
      if (idx >= 0) console.log(`--- ${kw} @${idx} ---\n${c.slice(Math.max(0,idx-100), idx+200)}`)
    }
  })
}).on('error', (e) => console.error(e))
