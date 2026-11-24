// 精确抓 window.toy 方法白名单 + share + saveVideo + player 能力
const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    // 方法白名单 Set
    const i0 = c.indexOf('var We=new Set(')
    if (i0 >= 0) {
      console.log('=== toy 方法白名单 ===')
      console.log(c.slice(i0, i0 + 700))
    }
    console.log('\n=== player 能力（getPlayerState/setPlayerState/onPlayerChange 附近） ===')
    const i1 = c.indexOf('getPlayerState')
    if (i1 >= 0) console.log(c.slice(i1 - 300, i1 + 200))
    console.log('\n=== saveVideoToPhotosAlbum 上下文（确认是否有 toy. 暴露） ===')
    const i2 = c.indexOf('saveVideoToPhotosAlbum')
    // 搜索是否作为 toy. 方法被封装
    const toyMethods = []
    const re = /\.([a-zA-Z]+)\s*=\s*(?:function|\([^)]*\)\s*=>|async)/g
    let m
    while ((m = re.exec(c)) !== null) {
      const name = m[1]
      if (/saveVideo|saveImage|share|record|export|download|player|Video|Album|openFile/i.test(name)) toyMethods.push(name)
    }
    console.log('可疑方法名:', [...new Set(toyMethods)].join(', '))
  })
}).on('error', (e) => console.error(e))
