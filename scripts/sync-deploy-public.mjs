// 把 lumiscore 静态包需要的 public 子集同步到 deploy/public。
// 只包含五步骤流程运行时需要、且在平台后缀白名单内的资源：
//   icons(lumiscore 2 个 svg) / fonts(Bravura+Liberation woff2) /
//   webmscore(.data + 2 .wasm) / samples(示例曲 .md，内容为 MusicXML) /
//   instrument-samples/piano(8 个 A/C 基音 mp3 ≈1.2MB，钢琴音色本地兜底采样)
// 不含：samples/*.mid（后缀不允许，仅主站用）、soundfont(.sf3)、
//       主站 favicon png、manifest、sitemap 等。
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'public')
const dst = resolve(root, 'deploy/public')

const copies = [
  'icons/lumiscore-favicon.svg',
  'icons/lumiscore-logo.svg',
  'fonts/Bravura.woff2',
  'fonts/Bravura.ttf', // SMuFL 音乐字形轮廓（text→path 用原字体，非 leland）
  'fonts/Liberation.woff2',
  'fonts/Liberation.ttf', // 3D 文字矢量挤出（opentype.js 解析字体轮廓）
  'fonts/leland.otf', // SMuFL 音乐字形轮廓（VexFlow Leland Text）
  'fonts/noto-7000.ttf', // 中文 7000 子集（3D opentype.js 转 path）
  'fonts/noto-7000.woff2', // 同子集 woff2（2D 页 @font-face CSS 兜底）
  'webmscore',
  'instrument-samples/piano',
]

// samples 目录只同步 .md（示例曲 MusicXML 数据包），排除 .mid/README 等
const SAMPLES_DST = 'samples'

function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true })
  for (const name of readdirSync(fromDir)) {
    const a = join(fromDir, name)
    const b = join(toDir, name)
    if (statSync(a).isDirectory()) copyTree(a, b)
    else cpSync(a, b)
  }
}

rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
for (const rel of copies) {
  const a = resolve(src, rel)
  const b = resolve(dst, rel)
  if (statSync(a).isDirectory()) copyTree(a, b)
  else { mkdirSync(dirname(b), { recursive: true }); cpSync(a, b) }
  console.log('copied', rel)
}

// 示例曲：仅 .md（MusicXML 数据包）
const samplesSrc = resolve(src, 'samples')
const samplesOut = resolve(dst, SAMPLES_DST)
if (statSync(samplesSrc).isDirectory()) {
  mkdirSync(samplesOut, { recursive: true })
  for (const name of readdirSync(samplesSrc)) {
    // 仅示例数据包；README 等说明文档不打包
    if (name.toLowerCase() === 'readme.md') continue
    if (!name.toLowerCase().endsWith('.md')) continue
    cpSync(resolve(samplesSrc, name), resolve(samplesOut, name))
    console.log('copied', `${SAMPLES_DST}/${name}`)
  }
}
console.log('deploy/public synced →', dst)
