// ── 在线 GM 音色（midi-js-soundfonts 音源，多源竞速 + 多重兜底） ───────
// 这是【可视化工具】：音色只影响听感，绝不能拖死播放。加载策略：
//   A. 整包：smplr Soundfont 拉 <乐器>-mp3.js（内含全部音符 base64，一次请求）
//   B. 逐音：只下载本轨实际用到的 <乐器>-mp3/<音名>.mp3，用 Tone.Sampler 拼装
//   A/B 竞速，先成功的胜（败者立即释放）；整体超时或失败 → 本地合成器。
// 音源顺序：官方 gleitz → 作者镜像 goldst → jsDelivr CDN（含国内可达的 fastly）。
import { getContext, Sampler } from 'tone'
import { Soundfont, getSoundfontNames } from 'smplr'
import { registerCache } from '../shared/cache-registry'
import { getStored, registerCategory } from '../shared/resource-manager'
import { getAutoPoll, getDownloadMirror } from '../shared/audio-prefs'

/** 播放器需要的最小乐器接口（Tone 合成器与 smplr 共同实现） */
export interface InstrumentRuntime {
  triggerAttackRelease(note: string, duration: number, time: number, velocity: number): void
  releaseAll(): void
  dispose(): void
  /** 音色出口（播放器再链到每轨 Gain） */
  output: { connect(dest: unknown): void }
}

export const SOUND_BASES = [
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/', // 官方
  'https://goldst.dev/midi-js-soundfonts/FluidR3_GM/', // 作者镜像
  'https://fastly.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/', // fastly（国内友好）
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@master/FluidR3_GM/', // jsDelivr
]

/** 镜像源中文名（供下载资源页下拉展示） */
export const SOUND_BASE_LABELS = ['官方 GitHub', '作者镜像', 'jsDelivr Fastly', 'jsDelivr CDN']

/** 兜底镜像（SOUND_BASES 至少有一个元素，这里取首个；类型安全起见给字面量兜底） */
const FALLBACK_BASE = SOUND_BASES[0] ?? 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/'

/** 整包 .js 直链（资源管理器下载 / 缓存 key 都以乐器名为 id） */
function wholeUrl(sfName: string): string {
  return `${SOUND_BASES[0]}${sfName}-mp3.js`
}

/**
 * 「使用中」判定：由播放器注入——只有轨道显式选用该音色（下拉指定）时才算使用中。
 * 自动兜底拉取的音色不算，避免「刚下载完还没选就显示使用中」。
 * 未注入（非播放页）时一律视为闲置。
 */
let inUseProvider: ((sfName: string) => boolean) | null = null
export function setSoundfontInUseProvider(fn: ((sfName: string) => boolean) | null): void {
  inUseProvider = fn
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`音色加载超时(${ms}ms): ${label}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// ── 镜像轮询：文本（整包 .js）与二进制（逐音 .mp3）分别缓存 ──────────
function rewriteToBase(urlPath: string, base: string): string {
  for (const known of SOUND_BASES) {
    if (urlPath.startsWith(known)) return base + urlPath.slice(known.length)
  }
  return urlPath
}
async function fetchTextMirrors(urlPath: string, onProgress?: (p: number) => void): Promise<string> {
  let lastErr: unknown = null
  const bases = getAutoPoll()
    ? SOUND_BASES
    : [SOUND_BASES[getDownloadMirror()] ?? FALLBACK_BASE]
  for (const base of bases) {
    try {
      const res = await fetch(rewriteToBase(urlPath, base))
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue }
      const total = Number(res.headers.get('Content-Length')) || 0
      // 流式读取 body，按已接收字节 / Content-Length 上报进度；
      // 无 body 流或无 Content-Length 时回退到整包 text()。
      if (!res.body || !total) {
        const text = await res.text()
        onProgress?.(100)
        return text
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let received = 0
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        text += decoder.decode(value, { stream: true })
        onProgress?.(Math.min(100, Math.round((received / total) * 100)))
      }
      text += decoder.decode()
      onProgress?.(100)
      return text
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('所有音色镜像不可用')
}
async function fetchBufMirrors(urlPath: string): Promise<ArrayBuffer> {
  let lastErr: unknown = null
  const bases = getAutoPoll()
    ? SOUND_BASES
    : [SOUND_BASES[getDownloadMirror()] ?? FALLBACK_BASE]
  for (const base of bases) {
    try {
      const res = await fetch(rewriteToBase(urlPath, base))
      if (res.ok) return await res.arrayBuffer()
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('所有音色镜像不可用')
}
// Response body 只能消费一次：缓存解析后的文本/缓冲，同音色多轨并发共享
const textCache = new Map<string, Promise<string>>()
const bufCache = new Map<string, Promise<ArrayBuffer>>()
/** 下载字节数（统计用：文本按 UTF-16 估算，二进制取真实 byteLength） */
const textBytes = new Map<string, number>()
const bufBytes = new Map<string, number>()
function cachedText(urlPath: string): Promise<string> {
  let p = textCache.get(urlPath)
  if (!p) {
    p = fetchTextMirrors(urlPath).then((text) => {
      textBytes.set(urlPath, text.length * 2)
      return text
    })
    textCache.set(urlPath, p)
    p.catch(() => { textCache.delete(urlPath); textBytes.delete(urlPath) })
  }
  return p
}
function cachedBuf(urlPath: string): Promise<ArrayBuffer> {
  let p = bufCache.get(urlPath)
  if (!p) {
    p = fetchBufMirrors(urlPath).then((buf) => {
      bufBytes.set(urlPath, buf.byteLength)
      return buf
    })
    bufCache.set(urlPath, p)
    p.catch(() => { bufCache.delete(urlPath); bufBytes.delete(urlPath) })
  }
  return p
}

/** 注入给 smplr 的存储：每次返回独立 body 的 Response，可被多乐器并发消费 */
const mirrorStorage = {
  fetch(url: string): Promise<Response> {
    if (!/^https?:\/\//.test(url)) return fetch(url)
    return cachedText(url).then(
      (text) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/javascript' } }),
    )
  },
}

// ── GM 程序号（0-127）→ midi-js-soundfonts 音色名 ─────────────────
export const GM_PROGRAM_NAMES = [
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honky_tonk_piano',
  'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone', 'tubular_bells', 'dulcimer',
  'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz', 'electric_guitar_clean',
  'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'guitar_harmonics',
  'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass', 'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
  'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani',
  'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2', 'choir_aahs', 'voice_oohs', 'synth_voice', 'orchestra_hit',
  'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2',
  'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet',
  'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi', 'whistle', 'ocarina',
  'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff', 'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass__lead',
  'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir', 'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep',
  'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere', 'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi',
  'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai',
  'tinkle_bell', 'agogo', 'steel_drums', 'woodblock', 'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal',
  'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause', 'gunshot',
] as const

// GM1 十六族分组名（中文）
export const GM_FAMILY_NAMES: string[] = [
  '钢琴', '色彩打击', '风琴', '吉他', '贝斯', '弦乐', '合奏', '铜管',
  '簧管', '管乐', '合成主音', '合成铺底', '合成效果', '民族', '打击', '音效',
]
// GM 128 乐器中文名（与 GM_PROGRAM_NAMES 一一对应）
export const GM_CHINESE_NAMES: string[] = [
  '大钢琴', '明亮钢琴', '电钢琴', '酒吧钢琴', '电钢琴 1', '电钢琴 2', '拨弦古钢琴', '击弦古钢琴',
  '钢片琴', '钟琴', '八音盒', '颤音琴', '马林巴', '木琴', '管钟', '扬琴',
  '拉杆风琴', '打击风琴', '摇滚风琴', '教堂风琴', '簧风琴', '手风琴', '口琴', '探戈手风琴',
  '尼龙吉他', '钢弦吉他', '爵士吉他', '清音吉他', '闷音吉他', '过载吉他', '失真吉他', '吉他和音',
  '原声贝斯', '指弹贝斯', '拨片贝斯', '无品贝斯', '拍弦贝斯 1', '拍弦贝斯 2', '合成贝斯 1', '合成贝斯 2',
  '小提琴', '中提琴', '大提琴', '低音提琴', '颤弓弦乐', '拨弦弦乐', '竖琴', '定音鼓',
  '弦乐合奏 1', '弦乐合奏 2', '合成弦乐 1', '合成弦乐 2', '人声「啊」', '人声「嘟」', '合成人声', '乐队齐奏',
  '小号', '长号', '大号', '弱音小号', '圆号', '铜管组', '合成铜管 1', '合成铜管 2',
  '高音萨克斯', '中音萨克斯', '次中音萨克斯', '上低音萨克斯', '双簧管', '英国管', '大管', '单簧管',
  '长笛', '短笛', '竖笛', '排箫', '吹瓶', '尺八', '哨笛', '陶笛',
  '方波主音', '锯齿波主音', '汽笛风琴', '吹管主音', '查兰格', '人声主音', '五度主音', '贝斯主音',
  '新世纪铺底', '温暖铺底', '复音铺底', '合唱铺底', '弓弦铺底', '金属铺底', '光环铺底', '风声铺底',
  '雨声', '配乐', '水晶', '气氛', '明亮', '鬼怪', '回声', '科幻',
  '西塔尔', '班卓琴', '三味线', '古筝', '卡林巴', '风笛', '古提琴', '唢呐',
  '叮当铃', '阿哥哥鼓', '钢鼓', '木鱼', '太鼓', '旋律嗵鼓', '合成鼓', '反转钹',
  '吉他换把', '呼吸声', '海浪', '鸟鸣', '电话铃', '直升机', '掌声', '枪声',
]

let sfNameSet: Set<string> | null = null
function normalizeSfName(name: string | null | undefined): string | null {
  if (!name) return null
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!n) return null
  if (!sfNameSet) {
    try { sfNameSet = new Set(getSoundfontNames()) } catch { sfNameSet = new Set(GM_PROGRAM_NAMES as unknown as string[]) }
  }
  return sfNameSet.has(n) ? n : null
}

/** MIDI 程序号（优先）/轨道名 → 可用 soundfont 音色名；鼓组或无法判定返回 null */
export function resolveSoundfontName(program: number | null | undefined, family: string | null | undefined, trackName: string | null | undefined): string | null {
  if (family && /drum|perc|鼓|打击/i.test(family)) return null
  if (typeof program === 'number' && program >= 0 && program <= 127) {
    const n = normalizeSfName(GM_PROGRAM_NAMES[program])
    if (n) return n
  }
  // 轨道名兜底：程序号缺失/为默认钢琴时，按名字猜更具体的音色。
  // 顺序 = 优先级，具体乐器在族类之前；中英文缩写都覆盖。
  const rules: [RegExp, string][] = [
    [/harpsichord|大键琴/, 'harpsichord'],
    [/piano|grand|upright|钢琴|pno\b/, 'acoustic_grand_piano'],
    [/rhodes/, 'electric_piano_2'],
    [/electric|digital|电钢/, 'electric_piano_1'],
    [/violin|小提琴|vln\b/, 'violin'],
    [/viola|中提/, 'viola'],
    [/cello|大提/, 'cello'],
    [/contrabass|double\s*bass|低音提琴/, 'contrabass'],
    [/fiddle|古提琴/, 'fiddle'],
    [/strings|弦乐|tremolo|pizzicato/, 'string_ensemble_1'],
    [/piccolo|短笛/, 'piccolo'],
    [/flute|长笛|wind|吹管|recorder|竖笛|shakuhachi|尺八|ocarina|陶笛|排箫|pan\s*flute/, 'flute'],
    [/oboe|双簧/, 'oboe'],
    [/english\s*horn|英国管/, 'english_horn'],
    [/clarinet|单簧/, 'clarinet'],
    [/bassoon|大管|巴松/, 'bassoon'],
    [/trumpet|小号|tpt\b|cornet/, 'trumpet'],
    [/trombone|长号|tbn\b/, 'trombone'],
    [/tuba|大号/, 'tuba'],
    [/french\s*horn|圆号|horn\b/, 'french_horn'],
    [/brass|铜管/, 'brass_section'],
    [/soprano\s*sax/, 'soprano_sax'],
    [/tenor\s*sax/, 'tenor_sax'],
    [/baritone\s*sax/, 'baritone_sax'],
    [/sax|萨克/, 'alto_sax'],
    [/guitar|吉他|ukulele|尤克里里|mandolin|曼陀林/, 'acoustic_guitar_steel'],
    [/bass|贝斯/, 'acoustic_bass'],
    [/harp|竖琴|koto|古筝|guzheng/, 'orchestral_harp'],
    [/sitar|西塔尔/, 'sitar'],
    [/timpani|定音鼓/, 'timpani'],
    [/xylophone|木琴/, 'xylophone'],
    [/marimba|马林巴/, 'marimba'],
    [/vibraphone|颤音琴/, 'vibraphone'],
    [/glock|钟琴/, 'glockenspiel'],
    [/celesta|钢片琴/, 'celesta'],
    [/music\s*box|八音盒/, 'music_box'],
    [/bell|铃|tubular|管钟|chime/, 'tubular_bells'],
    [/choir|合唱|人声|vocal|aahs/, 'choir_aahs'],
    [/voice|oohs/, 'voice_oohs'],
    [/organ|风琴|harmonica|口琴/, 'drawbar_organ'],
    [/accordion|手风琴|bandoneon/, 'accordion'],
    [/pad|氛围/, 'pad_2_warm'],
    [/pluck|拨弦/, 'pizzicato_strings'],
    [/drum|perc|鼓|打击/, 'synth_drum'],
  ]
  const n0 = (trackName ?? '').toLowerCase()
  for (const [re, sf] of rules) {
    if (re.test(n0)) {
      const n = normalizeSfName(sf)
      if (n) return n
    }
  }
  return null
}

// ── 在线方案 A：smplr 整包 ─────────────────────────────────────
function loadWhole(sfName: string): Promise<InstrumentRuntime> {
  const ctx = getContext().rawContext as AudioContext
  const bus = ctx.createGain()
  // extraGain 曾设为 5：FluidR3 采样本身已接近满刻度，再乘 5 后多轨叠加必然
  // 削波爆音（甚至触发浏览器输出限幅的「噗」声）。这里保持原电平，
  // bus 压到 0.8 留少量 headroom，整体响度由 player 侧 limiter 统一兜底。
  bus.gain.value = 0.8
  const sf = Soundfont(ctx, {
    kit: 'FluidR3_GM',
    instrument: sfName,
    storage: mirrorStorage,
    destination: bus,
    extraGain: 1,
  })
  return sf.ready.then(() => ({
    triggerAttackRelease: (note, duration, time, velocity) => {
      sf.start({ note, duration, time, velocity: Math.max(1, Math.round(velocity * 127)) })
    },
    releaseAll: () => sf.stop(),
    dispose: () => sf.dispose(),
    // bus 是原生 GainNode（rawContext 创建）。直连 Tone 节点包装对象时，
    // standardized-audio-context 的包装表在并发 dispose 竞态下会抛
    // “A value with the given key could not be found”；统一改连 Tone 节点的
    // 原生入口（.input/_gainNode），原生→原生不走包装查询。
    output: {
      connect(dest: unknown): void {
        const d = dest as { input?: unknown; _gainNode?: AudioNode } | null
        const target = (d?.input ?? d?._gainNode ?? dest) as AudioNode
        bus.connect(target)
      },
    },
  }))
}

// ── 在线方案 B：只下载本轨用到的音，Tone.Sampler 拼装 ─────────────
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function fileNameOfMidi(m: number): string {
  return `${FLATS[m % 12]!}${Math.floor(m / 12) - 1}.mp3`
}
function noteNameOfMidi(m: number): string {
  return `${SHARPS[m % 12]!}${Math.floor(m / 12) - 1}`
}

// 解码缓存：同一音色包内的音符文件常被多条轨重复请求（大总谱很常见，
// 比如 3 个弦乐轨都用到 C4）。以前每个音轨都把同一份 mp3 重新解码一遍，
// 20 轨就是几百次 decodeAudioData，主线程直接卡死 → 播放断续。
// 用「文件 URL → 解码后的 AudioBuffer」缓存，跨轨共享同一份解码结果。
const decodedCache = new Map<string, Promise<AudioBuffer>>()

// 全局并发闸门：同时最多 6 个下载/解码在跑，其余排队。
// 不限制时 20 轨 × 每轨几十个音符会瞬间打出上千个请求。
const MAX_INFLIGHT = 6
let inflight = 0
const pending: Array<() => void> = []
function withGate<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      inflight++
      task()
        .then(resolve, reject)
        .finally(() => {
          inflight--
          pending.shift()?.()
        })
    }
    if (inflight < MAX_INFLIGHT) run()
    else pending.push(run)
  })
}

function decodeNoteFile(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const cached = decodedCache.get(url)
  if (cached) return cached
  const p = withGate(async () => {
    const buf = await cachedBuf(url)
    return await ctx.decodeAudioData(buf.slice(0))
  }).catch((e) => {
    // 解码失败不留在缓存里，下次还能重试
    decodedCache.delete(url)
    throw e
  })
  decodedCache.set(url, p)
  return p
}

function loadPerNote(
  sfName: string,
  pitches: Iterable<number>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<InstrumentRuntime> {
  const uniq = [...new Set(pitches)].filter((m) => m >= 0 && m <= 127)
  if (!uniq.length) return Promise.reject(new Error('该轨无可下载音符'))
  return (async () => {
    const ctx = getContext().rawContext as AudioContext
    const urls: Record<string, AudioBuffer> = {}
    let done = 0
    const results = await Promise.allSettled(
      uniq.map(async (m) => {
        const file = fileNameOfMidi(m)
        const buf = await decodeNoteFile(ctx, `${SOUND_BASES[0]}${sfName}-mp3/${file}`)
        done++
        // 进度节流：每批统一上报时才会触发 UI 更新（见 cachedBuf 的流式回调）
        onProgress?.(done, uniq.length)
        return [noteNameOfMidi(m), buf] as const
      }),
    )
    for (const r of results) if (r.status === 'fulfilled') urls[r.value[0]] = r.value[1]
    if (!Object.keys(urls).length) throw new Error(`逐音采样全部失败：${sfName}`)
    const sampler = new Sampler({ urls, release: 1, attack: 0, volume: -3 })
    return {
      triggerAttackRelease: (note, duration, time, velocity) =>
        sampler.triggerAttackRelease(note, duration, time, velocity),
      releaseAll: () => sampler.releaseAll(),
      dispose: () => sampler.dispose(),
      output: sampler,
    }
  })()
}

/**
 * 加载在线音色：整包/逐音竞速（先成功先用），15 秒整体超时。
 * onProgress 只覆盖逐音方案（n/total 已下载音符）；整包无细粒度进度，
 * 成功时上报 (1,1)。任何失败都向上抛，由调用方走兜底链。
 */
export async function createSoundfontRuntime(
  sfName: string,
  pitches: Iterable<number> = [],
  onProgress?: (loaded: number, total: number) => void,
): Promise<InstrumentRuntime> {
  // 优先用资源管理器里已下载的整包（全站共享，无需重复请求）
  const stored = await getStored(sfName)
  if (stored) {
    const url = wholeUrl(sfName)
    textCache.set(url, Promise.resolve(stored as string))
    textBytes.set(url, (stored as string).length * 2)
  }
  const candidates: Promise<InstrumentRuntime>[] = [
    withTimeout(loadWhole(sfName), 15000, '整包'),
    withTimeout(loadPerNote(sfName, pitches, onProgress), 15000, '逐音'),
  ]
  // 竞速：先成功的胜，其余立即释放
  const rt = await new Promise<InstrumentRuntime>((resolve, reject) => {
    let pending = candidates.length
    let settled = false
    const failures: unknown[] = []
    candidates.forEach((p, i) => {
      p.then(
        (r) => {
          if (settled) { try { r.dispose() } catch { /* noop */ } return }
          settled = true
          onProgress?.(1, 1) // 完成上报（整包无细粒度进度，统一拉满）
          candidates.forEach((q, j) => {
            if (j === i) return
            q.then((loser) => { try { loser.dispose() } catch { /* noop */ } }).catch(() => undefined)
          })
          resolve(r)
        },
        (err) => {
          failures.push(err)
          pending--
          if (!settled && pending === 0) reject(new Error(failures.map(String).join(' | ')))
        },
      )
    })
  })
  return rt
}

// 登记到「设置 → 缓存设置」：统计已下载的音色包 / 逐音采样，支持卸载
registerCache({
  id: 'soundfont',
  labelKey: 'cache.soundfont',
  descKey: 'cache.soundfont.desc',
  stats: () => {
    let bytes = 0
    for (const n of textBytes.values()) bytes += n
    for (const n of bufBytes.values()) bytes += n
    return { count: textCache.size + bufCache.size, bytes }
  },
  clear: () => {
    const n = textCache.size + bufCache.size
    textCache.clear()
    bufCache.clear()
    textBytes.clear()
    bufBytes.clear()
    return n
  },
})

// ── 资源管理器：GM 128 乐器可手动下载，全站共用 ───────────────────
registerCategory('soundfont', {
  catalog: GM_PROGRAM_NAMES.map((n, i) => ({
    id: n,
    name: n,
    label: GM_CHINESE_NAMES[i] ?? n,
    group: GM_FAMILY_NAMES[Math.floor(i / 8)] ?? '其他',
  })),
  downloadable: true,
  download: async (id, onProgress) => {
    onProgress(3)
    // fetchTextMirrors 内部流式上报 0-100，映射到整体 3-100（预留 3% 给请求建立）
    const text = await fetchTextMirrors(wholeUrl(id), (p) => onProgress(3 + Math.round(p * 0.97)))
    onProgress(100)
    return { value: text, bytes: text.length * 2 }
  },
  activate: (id, value) => {
    const url = wholeUrl(id)
    textCache.set(url, Promise.resolve(value as string))
    textBytes.set(url, (value as string).length * 2)
  },
  deactivate: (id) => {
    const url = wholeUrl(id)
    textCache.delete(url)
    textBytes.delete(url)
  },
  inUse: (id) => inUseProvider?.(id) ?? false,
})

