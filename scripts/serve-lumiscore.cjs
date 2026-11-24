// lumiscore 静态包本地预览：默认以「项目根」为服务器根，
// 访问 http://localhost:19996/lumiscore/ 即可模拟【子目录部署】。
// 用法：node scripts/serve-lumiscore.cjs [端口] [服务器根目录]
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const port = Number(process.argv[2] ?? 19996)
const root = path.resolve(process.argv[3] ?? process.cwd())
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
}
http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(root, urlPath)
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden') }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    const buf = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404); res.end('not found: ' + urlPath)
  }
}).listen(port, () => {
  console.log(`lumiscore preview → http://localhost:${port}/lumiscore/  (root: ${root})`)
})
