// 测试台 fixture：同步构造写死的数据源并写入本页 sessionStorage
// （sessionStorage 按标签页隔离，不影响主流程标签页）。必须在 ../3dpreview/main
// 求值之前执行——flag.ts 先置标记，本模块再注入数据，最后 main.ts 才拉起场景管线。
import fixtureXml from './fixture.xml?raw'
import { autocorrectXml } from '../shared/score-preprocess'
import {
  computeAutoGraph,
  DEFAULT_AUTO_POLICY,
  parseXmlHeads,
} from '../shared/auto-links'
import { xmlToMidi } from '../shared/midi-xml'

const BENCH_NAME = '测试台示例曲'

// link2d 同款路径色（src/link2d/main.ts PALETTE）
const PALETTE = [
  '#2266ff', '#e11d48', '#16a34a', '#ea580c', '#7c3aed',
  '#0891b2', '#ca8a04', '#be185d', '#15803d', '#4f46e5',
  '#9333ea', '#0d9488',
]

type Pair = [string, string]

/** 大 Uint8Array → base64（分块 btoa，避免大数组展开实参栈溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* 隐私模式忽略 */
  }
}

// ① 统一给 <note> 注入 id（parseXmlHeads 的 noteId 与 Verovio g.note@id 同源），
//    自动连线的端点 id 才能被第五页 loadLinkTracks 解析。
const xmlWithIds = autocorrectXml(fixtureXml).xml

// ② 自动连线（与 link2d runAuto 同口径：同刻同小节边剔除、绝不跨轨）
const heads = parseXmlHeads(xmlWithIds)
const graph = computeAutoGraph(heads, DEFAULT_AUTO_POLICY)
const buckets = new Map<string, Pair[]>()
const trackKeyOf = (part: number, staff: number): string => `staff:${part}|${staff}`
for (const e of graph.edges) {
  const a = heads[e.from]
  const b = heads[e.to]
  if (!a || !b) continue
  if (Math.abs(a.onset - b.onset) < 1e-6 && a.measure === b.measure) continue
  const ka = trackKeyOf(a.part, a.staff)
  const kb = trackKeyOf(b.part, b.staff)
  if (ka !== kb) continue
  const arr = buckets.get(ka) ?? []
  arr.push([a.noteId, b.noteId])
  buckets.set(ka, arr)
}

// ③ 组装 midee.links（link2d LinksStore v5 形状；第五页 loadLinkTracks / readOffsets 消费）
let seq = 0
const paths = [...buckets.keys()].sort().map((key) => ({
  id: `p${++seq}`,
  color: PALETTE[(seq - 1) % PALETTE.length]!,
  trackKey: key,
  auto: buckets.get(key) ?? [],
  manual: [] as Pair[],
  ayStart: [] as number[],
  ayEnd: [] as number[],
  anchorsManual: false,
}))
const links = {
  v: 5,
  policy: DEFAULT_AUTO_POLICY,
  offStart: 0.7,
  offEnd: 0.7,
  termStartGap: 90,
  termEndGap: 90,
  paths,
  selected: paths[0]?.id ?? '',
  removed: [] as Pair[],
}

// ④ MIDI：由同一份 XML 直转（与谱面音符一一对应），供播放与事件对齐
const midiB64 = bytesToBase64(xmlToMidi(xmlWithIds))

write('midee.xml', xmlWithIds)
write('midee.name', BENCH_NAME)
write('midee.midi', midiB64)
write('midee.links', JSON.stringify(links))
