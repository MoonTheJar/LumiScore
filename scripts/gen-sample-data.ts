// 把示例乐谱转成 MusicXML 数据包：MIDI 源走正式管线（midiToXml），
// 现成 MusicXML 源（如 MuseScore 导出）直接引用原文。
// 以 .md 后缀写入 public/samples/（平台白名单允许 .md；内容就是纯 XML 文本，
// 导入页 fetch 后按 MusicXML 解析）。dev 与 lumiscore 静态包共用同一目录。
// 运行：node scripts/gen-sample-data.ts（Node ≥22，strip-types）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import pkg from '@tonejs/midi'
import { midiToXml } from '../src/shared/midi-xml.ts'

const { Midi } = pkg as unknown as { Midi: typeof import('@tonejs/midi').Midi }
// 经 esbuild bundle 后从项目根执行（见 package.json gen:samples）
const root = process.cwd()
const outDir = resolve(root, 'public/samples')
mkdirSync(outDir, { recursive: true })

const samples: [string, string, string][] = [
  ['bach-prelude-in-c.mid', 'bach.md', '巴赫：C 大调前奏曲'],
  ['chopin-nocturne-op9-2.mid', 'chopin.md', '肖邦：夜曲 Op.9 No.2'],
  ['kamisama-no-manimani.musicxml', 'kamisama-no-manimani.md', '神的随波逐流（神のまにまに）'],
]

for (const [srcFile, mdFile, name] of samples) {
  const srcPath = resolve(root, 'public/samples', srcFile)
  let xml: string
  if (/\.(music)?xml$/i.test(srcFile)) {
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
