// ── 页面级资源缓存登记表 ───────────────────────────────────────
// 网络字体分片 / 钢琴采样 / 在线音色 / 网络贴图这些缓存都散落在各自的模块里，
// 且全是「模块级内存 Map」。这里提供一张轻量登记表：各模块加载时自注册，
// 设置里的「缓存设置」按当前页已加载的模块聚合统计，并支持逐项卸载。
//
// 注意：能清的只有本页内存缓存；浏览器 HTTP 磁盘缓存由浏览器自身管理，
// 脚本无法逐项清空（面板底部会如实说明，避免虚假承诺）。

/** 可调参数（目前只有字体分片数量上限用到） */
export interface CacheAdjust {
  labelKey: string
  hintKey: string
  min: number
  max: number
  step: number
  get: () => number
  set: (v: number) => void
}

export interface CacheEntry {
  id: string
  /** 显示名 i18n key */
  labelKey: string
  /** 一句话说明 i18n key */
  descKey: string
  /** 同步统计：条目数 + 估算字节 */
  stats: () => { count: number; bytes: number }
  /** 卸载并返回释放的条目数 */
  clear: () => number
  adjust?: CacheAdjust
}

const registry = new Map<string, CacheEntry>()

export function registerCache(entry: CacheEntry): void {
  registry.set(entry.id, entry)
}

/** 当前页已加载的缓存模块（注册顺序即展示顺序） */
export function listCaches(): CacheEntry[] {
  return [...registry.values()]
}

export function totalCache(): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const e of registry.values()) {
    try {
      const s = e.stats()
      count += s.count
      bytes += s.bytes
    } catch {
      /* 单个模块统计失败不影响整体 */
    }
  }
  return { count, bytes }
}

export function clearAllCaches(): number {
  let n = 0
  for (const e of registry.values()) {
    try {
      n += e.clear()
    } catch {
      /* 单个模块卸载失败不影响其他 */
    }
  }
  return n
}

/** 字节数 → 人类可读（1024 进制） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
