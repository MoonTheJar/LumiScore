/**
 * DecoderDetect.ts
 *
 * Decoder detection service:
 * - System FFmpeg (Node.js server-side, best for large files)
 * - Browser WASM FFmpeg (auto-fetched, fallback)
 * - Cloud FFmpeg (remote API, last resort)
 * - WebCodecs browser decoders
 * - MIDI parser
 * - MuseScore (local installation)
 */

export type DecoderStatus = 'available' | 'unavailable' | 'checking' | 'decoding'

export interface DecoderInfo {
  name: string
  status: DecoderStatus
  detail?: string
  progress?: number
}

// Use a variable to prevent esbuild from mangling the import string
const FFMPEG_MODULE = '@ffmpeg/ffmpeg'

/**
 * Tier 1: System FFmpeg via Node.js server
 */
export async function detectSystemFFmpeg(): Promise<DecoderInfo> {
  try {
    const res = await fetch('/api/ffmpeg-check', { method: 'HEAD' })
    if (res.ok) {
      return { name: '系统 FFmpeg (Node)', status: 'available', detail: '服务端系统 FFmpeg 可用' }
    }
    return { name: '系统 FFmpeg (Node)', status: 'unavailable', detail: '服务端未启用 FFmpeg' }
  } catch {
    return { name: '系统 FFmpeg (Node)', status: 'unavailable', detail: '服务端未连接' }
  }
}

/**
 * Tier 2: Browser WASM FFmpeg (ffmpeg.wasm)
 */
export async function detectWasmFFmpeg(): Promise<DecoderInfo> {
  try {
    await import(FFMPEG_MODULE)
    return { name: '浏览器 FFmpeg (WASM)', status: 'available', detail: 'ffmpeg.wasm 已安装' }
  } catch {
    return { name: '浏览器 FFmpeg (WASM)', status: 'unavailable', detail: '未安装 @ffmpeg/ffmpeg' }
  }
}

/**
 * Tier 3: Cloud FFmpeg API
 */
export async function detectCloudFFmpeg(): Promise<DecoderInfo> {
  try {
    const res = await fetch('/api/ffmpeg-cloud-check', { method: 'HEAD' })
    if (res.ok) {
      return { name: '云端 FFmpeg', status: 'available', detail: '云端转码服务可用' }
    }
    return { name: '云端 FFmpeg', status: 'unavailable', detail: '云端服务未配置' }
  } catch {
    return { name: '云端 FFmpeg', status: 'unavailable', detail: '云端服务未连接' }
  }
}

/**
 * WebCodecs browser decoders (VideoDecoder / AudioDecoder)
 */
export async function detectBrowserDecoder(): Promise<DecoderInfo> {
  const win = window as any
  if (typeof win.VideoDecoder === 'undefined') {
    return {
      name: '浏览器解码器 (WebCodecs)',
      status: 'unavailable',
      detail: '浏览器不支持 VideoDecoder',
    }
  }

  const videoCodecs = [
    { codec: 'avc1.42E01E', width: 1920, height: 1080, label: 'H.264' },
    { codec: 'vp09.00.10.08', width: 1920, height: 1080, label: 'VP9' },
    { codec: 'av01.0.01M.08', width: 1920, height: 1080, label: 'AV1' },
  ]

  const supported: string[] = []
  for (const c of videoCodecs) {
    try {
      const result = await win.VideoDecoder.isConfigSupported({
        codec: c.codec,
        codedWidth: c.width,
        codedHeight: c.height,
      })
      if (result.supported) supported.push(c.label)
    } catch {
      // ignore
    }
  }

  if (typeof win.AudioDecoder !== 'undefined') {
    const audioCodecs = [
      { codec: 'mp4a.40.2', sampleRate: 44100, channels: 2, label: 'AAC' },
      { codec: 'opus', sampleRate: 48000, channels: 2, label: 'Opus' },
    ]
    for (const c of audioCodecs) {
      try {
        const result = await win.AudioDecoder.isConfigSupported({
          codec: c.codec,
          sampleRate: c.sampleRate,
          numberOfChannels: c.channels,
        })
        if (result.supported) supported.push(c.label)
      } catch {
        // ignore
      }
    }
  }

  if (supported.length > 0) {
    return {
      name: '浏览器解码器 (WebCodecs)',
      status: 'available',
      detail: '支持: ' + supported.join(', '),
    }
  }

  return {
    name: '浏览器解码器 (WebCodecs)',
    status: 'unavailable',
    detail: '未检测到可用的解码器',
  }
}

/**
 * MIDI parser detection
 */
export async function detectMidiDecoder(): Promise<DecoderInfo> {
  try {
    await import('@tonejs/midi')
    return { name: 'MIDI 解析器', status: 'available', detail: '@tonejs/midi 已加载' }
  } catch {
    return { name: 'MIDI 解析器', status: 'unavailable', detail: '@tonejs/midi 未加载' }
  }
}

/**
 * MuseScore local installation detection
 */
export async function detectMuseScore(): Promise<DecoderInfo> {
  try {
    const res = await fetch('/api/musescore-check', { method: 'HEAD' })
    if (res.ok) {
      return { name: 'MuseScore (本地)', status: 'available', detail: '本地 MuseScore 可用' }
    }
    return { name: 'MuseScore (本地)', status: 'unavailable', detail: '未检测到 MuseScore' }
  } catch {
    return { name: 'MuseScore (本地)', status: 'unavailable', detail: '服务未连接' }
  }
}
