// 抓最新官方 toy-sdk.js，搜视频/导出/分享/下载相关能力
const https = require('https')
https.get('https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js', (res) => {
  let c = ''
  res.on('data', (d) => (c += d))
  res.on('end', () => {
    console.log('toy-sdk.js length:', c.length)
    console.log('\n=== 方法名（toy.xxx 定义） ===')
    const re = /toy\.([a-zA-Z][a-zA-Z0-9]*)\s*[=:]/g
    let m
    const seen = new Set()
    while ((m = re.exec(c)) !== null) { if (!seen.has(m[1])) { seen.add(m[1]); console.log('  toy.' + m[1]) } }
    console.log('\n=== 视频/媒体/导出/下载/分享关键词 ===')
    for (const kw of ['video', 'record', 'MediaRecorder', 'saveVideo', 'exportVideo', 'publish', 'upload', 'download', 'share', 'toAlbum', 'Album', 'capture']) {
      let idx = c.indexOf(kw)
      let cnt = 0
      while (idx >= 0 && cnt < 3) {
        console.log(`--- ${kw} @${idx} ---`)
        console.log(c.slice(Math.max(0, idx - 80), idx + 160))
        idx = c.indexOf(kw, idx + kw.length)
        cnt++
      }
    }
    // 是否暴露 window.toy
    console.log('\n=== window.toy 暴露 ===')
    const ei = c.indexOf('window.toy')
    if (ei >= 0) console.log(c.slice(Math.max(0, ei - 150), ei + 200))
  })
}).on('error', (e) => console.error(e))
