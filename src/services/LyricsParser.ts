// Subtitle / lyric parsing: LRC (with optional enhanced timestamps) and SRT.
// Both produce the same normalized cue shape so the renderer can treat them
// identically on the clock timeline.

export interface SubtitleCue {
  /** Start time in seconds (clock timeline). */
  start: number
  /** End time in seconds (clock timeline). */
  end: number
  /** Display text (empty cues are skipped). */
  text: string
}

const LRC_LINE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const SRT_BLOCK_TIME =
  /(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/

function toSeconds(m: number, s: number, frac: number, fracDigits: number): number {
  return m * 60 + s + frac / Math.pow(10, Math.max(1, fracDigits || 3))
}

/**
 * Parse enhanced/plain LRC text. Multiple [..] tags on one line attach the
 * same text to several timestamps (common for repeated choruses).
 */
export function parseLrc(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const times: number[] = []
    LRC_LINE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = LRC_LINE.exec(line)) !== null) {
      const m = Number(match[1])
      const s = Number(match[2])
      const fracRaw = match[3]
      const frac = fracRaw ? Number(fracRaw) : 0
      times.push(toSeconds(m, s, frac, fracRaw ? fracRaw.length : 0))
    }
    if (times.length === 0) continue
    const textPart = line.replace(LRC_LINE, '').trim()
    if (!textPart) continue
    // Sort ascending (enhanced LRC may list tags out of order).
    times.sort((a, b) => a - b)
    for (const t of times) {
      cues.push({ start: t, end: Number.MAX_SAFE_INTEGER, text: textPart })
    }
  }
  cues.sort((a, b) => a.start - b.start)
  // Close each cue at the next cue's start so a line shows until the next one.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!
    const next = cues[i + 1]
    if (next) {
      cues[i] = { ...cue, end: Math.max(cue.start, next.start) }
    } else {
      // Last cue: keep it on screen for 4s after its start.
      cues[i] = { ...cue, end: cue.start + 4 }
    }
  }
  return cues.filter((c) => c.text.length > 0)
}

/**
 * Parse SRT text. Handles CRLF, BOM, blank-line separated blocks and
 * comma or dot decimal separators in timestamps.
 */
export function parseSrt(text: string): SubtitleCue[] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = clean.split(/\n{2,}/)
  const cues: SubtitleCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim())
    const timeLine = lines.find((l) => SRT_BLOCK_TIME.test(l))
    if (!timeLine) continue
    const m = SRT_BLOCK_TIME.exec(timeLine)!
    const m1 = m[1]!, m2 = m[2]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m8 = m[8]!
    const start = toSeconds(Number(m1), Number(m2), Number(m4), m4.length)
    const end = toSeconds(Number(m5), Number(m6), Number(m8), m8.length)
    const textPart = lines
      .filter((l) => l !== timeLine && !/^\d+$/.test(l) && l.length > 0)
      .join('\n')
    if (!textPart) continue
    cues.push({ start, end, text: textPart })
  }
  cues.sort((a, b) => a.start - b.start)
  return cues
}

/** Detect format from filename, falling back to LRC for plain .txt. */
export function parseSubtitleFile(name: string, text: string): SubtitleCue[] {
  const lower = name.toLowerCase()
  if (lower.endsWith('.srt')) return parseSrt(text)
  return parseLrc(text) // .lrc and .txt (best-effort)
}
