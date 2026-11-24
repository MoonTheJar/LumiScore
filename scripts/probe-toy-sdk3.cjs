const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-host.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 找 message 事件监听（host 端接收 iframe 消息）
    console.log('==== addEventListener("message") 上下文 ====')
    let idx = 0, n = 0
    while ((idx = c.indexOf('addEventListener', idx)) >= 0 && n < 10) {
      const s = Math.max(0, idx - 100)
      const e = Math.min(c.length, idx + 500)
      const chunk = c.slice(s, e)
      if (chunk.includes('message') || chunk.includes('Message')) {
        console.log(`--- @${idx} ---`)
        console.log(chunk)
        n++
      }
      idx += 16
    }
    // 找 onmessage
    console.log('\n==== onmessage 上下文 ====')
    idx = 0; n = 0
    while ((idx = c.indexOf('onmessage', idx)) >= 0 && n < 5) {
      const s = Math.max(0, idx - 150)
      const e = Math.min(c.length, idx + 400)
      console.log(`--- @${idx} ---`)
      console.log(c.slice(s, e))
      idx += 9; n++
    }
    // 找 iframeMessageId / iframeCallbackId（入站消息字段）
    console.log('\n==== iframeMessageId 上下文 ====')
    idx = 0; n = 0
    while ((idx = c.indexOf('iframeMessageId', idx)) >= 0 && n < 5) {
      const s = Math.max(0, idx - 200)
      const e = Math.min(c.length, idx + 300)
      console.log(`--- @${idx} ---`)
      console.log(c.slice(s, e))
      idx += 15; n++
    }
  })
}).on('error', (e) => console.error(e))
