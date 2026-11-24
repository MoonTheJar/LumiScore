// 构建期文字轮廓：opentype.js 解析字体 → 字符字形轮廓 → SVG path d
// 用于 3D 近场把真实文字（指法数字/歌词/力度记号/英文）挤出成立体字形
import opentype from 'opentype.js'

const fonts = new Map<string, opentype.Font>()
const pending = new Map<string, Promise<opentype.Font>>()

export async function loadFont(name: string, url: string): Promise<opentype.Font> {
  const hit = fonts.get(name)
  if (hit) return hit
  const p = pending.get(name) ?? (async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`font ${name} fetch failed: ${res.status}`)
    const buf = await res.arrayBuffer()
    const font = opentype.parse(buf)
    fonts.set(name, font)
    return font
  })()
  pending.set(name, p)
  return p
}

/** 取单个字符字形轮廓 → SVG path d（y 已翻转为 SVG 向下坐标系） */
export function charToD(font: opentype.Font, ch: string, size = 1000): string | null {
  const glyph = font.charToGlyph(ch)
  if (!glyph || !glyph.path || glyph.path.commands.length === 0) return null
  const cmds = glyph.path.commands
  let d = ''
  for (const c of cmds) {
    const y = (v: number): number => Math.round(-v * 100) / 100 // 字体 y 上 → SVG y 下
    const r = (v: number): number => Math.round(v * 100) / 100
    switch (c.type) {
      case 'M': d += `M${r(c.x)} ${y(c.y)}`; break
      case 'L': d += `L${r(c.x)} ${y(c.y)}`; break
      case 'C': d += `C${r(c.x1)} ${y(c.y1)} ${r(c.x2)} ${y(c.y2)} ${r(c.x)} ${y(c.y)}`; break
      case 'Q': d += `Q${r(c.x1)} ${y(c.y1)} ${r(c.x)} ${y(c.y)}`; break
      case 'Z': d += 'Z'; break
      default: break
    }
  }
  return d || null
}

/** 整段文字 → 逐字符字形轮廓 d 数组（按字符顺序；空格/无轮廓字符跳过） */
export function textToChars(font: opentype.Font, text: string): { ch: string; d: string }[] {
  const out: { ch: string; d: string }[] = []
  for (const ch of text) {
    if (ch.trim() === '') continue
    const d = charToD(font, ch)
    if (d) out.push({ ch, d })
  }
  return out
}
