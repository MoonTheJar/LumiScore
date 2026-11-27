// 把示例乐谱转成 MusicXML 数据包：MIDI 源走正式管线（midiToXml），
// 现成 MusicXML 源（如 MuseScore 导出）直接引用原文。
// 以 .md 后缀写入 public/samples/（平台白名单允许 .md；内容就是纯 XML 文本，
// 导入页 fetch 后按 MusicXML 解析）。dev 与 lumiscore 静态包共用同一目录。
// 运行：node scripts/gen-sample-data.ts（Node ≥22，strip-types）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { unzipSync } from 'fflate'
import pkg from '@tonejs/midi'
import { midiToXml } from '../src/shared/midi-xml.ts'

const { Midi } = pkg as unknown as { Midi: typeof import('@tonejs/midi').Midi }
// 经 esbuild bundle 后从项目根执行（见 package.json gen:samples）
const root = process.cwd()
const outDir = resolve(root, 'public/samples')
mkdirSync(outDir, { recursive: true })

/** 解包 .mxl（fflate）：优先读 META-INF/container.xml 指向的根文件，否则找第一个 .xml */
function unpackMxl(buf: Uint8Array): string {
  const files = unzipSync(buf)
  let xmlName = ''
  const container = files['META-INF/container.xml']
  if (container) {
    const m = /full-path="([^"]+)"/.exec(new TextDecoder().decode(container))
    if (m) xmlName = m[1]
  }
  if (!xmlName) xmlName = Object.keys(files).find((n) => /\.(musicxml|xml)$/i.test(n)) ?? ''
  const data = files[xmlName]
  if (!data) throw new Error('MXL 内未找到 MusicXML 根文件')
  return new TextDecoder().decode(data).trim()
}

const samples: [string, string, string][] = [
  ['bach-prelude-c-bwv846.mxl', 'bach-prelude-c.md', '巴赫：C 大调前奏曲 BWV 846'],
  ['bach-minuet-g-bwv-anh114.mxl', 'bach-minuet-g.md', '巴赫：G 大调小步舞曲 BWV Anh.114'],
  ['chopin-prelude-e-minor-op28-4.mxl', 'chopin-prelude-e-minor.md', '肖邦：E 小调前奏曲 Op.28 No.4'],
]

for (const [srcFile, mdFile, name] of samples) {
  const srcPath = resolve(root, 'public/samples', srcFile)
  let xml: string
  if (/\.mxl$/i.test(srcFile)) {
    // 压缩 MusicXML：解包取根文件
    xml = unpackMxl(new Uint8Array(readFileSync(srcPath)))
  } else if (/\.(music)?xml$/i.test(srcFile)) {
    // 现成 MusicXML 源（如 MuseScore 导出）：直接作为数据包内容
    xml = readFileSync(srcPath, 'utf8').trim()
  } else {
    // MIDI 源：先确认能被 @tonejs/midi 解析（与 midiToXml 同源输入），再走正式管线
    const bytes = new Uint8Array(readFileSync(srcPath))
    const parsed = new Midi(bytes as never)
    if (!parsed.tracks.some((t) => t.notes.length)) throw new Error(`${srcFile} 无音符`)
    xml = midiToXml(bytes, name)
  }
  writeFileSync(resolve(outDir, mdFile), xml, 'utf8')
  console.log(`${srcFile} → samples/${mdFile} (${(xml.length / 1024).toFixed(0)} KB XML)`)
}
