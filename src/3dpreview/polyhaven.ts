// ── Poly Haven 在线贴图 API 封装 ──────────────────────────────
// 文档：https://polyhaven.com/api（公开 API，允许 CORS）
// 流程：
//   1. fetchTextureList() 拉全部纹理资源（869 个，约 200KB JSON）
//   2. 用户从下拉选一个 → fetchAssetInfo(id) 拉简介 + 物理参数
//   3. applyTexture(id) 用 dl.polyhaven.org 的 1K jpg 直链作为 three.js 贴图 URL
// 纹理 URL 规律：https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{id}/{id}_{map}_1k.jpg
//   map ∈ { diff, nor_gl, rough, disp, ao, ... }

import { registerCache } from '../shared/cache-registry'

export interface PHAsset {
  id: string
  name: string
  categories: string[]
  /** 三级分类路径（如 "Wood/Veneer/Oak Veneer"），用于多级折叠分组 */
  category: string
  tags: string[]
  preview: string
  description?: string
}

const API = 'https://api.polyhaven.com'
const DL = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k'

let cache: PHAsset[] | null = null
/** 列表接口原始 JSON 的字节数（统计用） */
let listBytes = 0
const infoCache = new Map<string, { description: string; categories: string[]; tags: string[] }>()

/** 拉全部纹理资源列表（按名称排序）。
 *  实测与 4+ 个音色包并发下载时偶发 net::ERR_HTTP2_PROTOCOL_ERROR
 *  （中转链路抖动），一次失败会让贴图分类空置且无重试入口；
 *  这里内部重试 3 次（600ms 退避），瞬时抖动不再造成空列表。 */
export async function fetchTextureList(): Promise<PHAsset[]> {
  if (cache) return cache
  let lastErr: unknown = null
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${API}/assets?type=textures`)
      if (!r.ok) throw new Error(`polyhaven ${r.status}`)
      const raw = await r.text()
      listBytes = new TextEncoder().encode(raw).length
      // 注意：Poly Haven 返回的是 { [id]: { name, ... } } 映射，id 是外层 key，
      // value 对象本身不含 id 字段（直接读 a.id 会得到 undefined，导致贴图 URL 全 404）。
      const json = JSON.parse(raw) as Record<string, {
        name: string; categories: string[]; category?: string; tags: string[]; thumbnail_url: string
      }>
      cache = Object.entries(json).map(([id, a]) => ({
        id,
        name: a.name,
        categories: a.categories ?? [],
        category: a.category ?? (a.categories ?? [])[0] ?? '',
        tags: a.tags ?? [],
        preview: a.thumbnail_url ?? '',
      })).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      return cache
    } catch (e) {
      lastErr = e
      if (i < 2) await new Promise((r) => setTimeout(r, 600))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 拉单个资源详情（分类 + 标签），用于金属度判定与悬停 tooltip。
 * 实测 `/asset/:id` 单资源端点现已返回 404 HTML（不可用），而列表接口
 * （/assets?type=textures）的每个条目已带 categories/tags，故以列表缓存为权威来源。
 */
export async function fetchAssetInfo(id: string): Promise<{ description: string; categories: string[]; tags: string[] }> {
  const hit = infoCache.get(id)
  if (hit) return hit
  const list = await fetchTextureList()
  const a = list.find((x) => x.id === id)
  if (!a) throw new Error(`polyhaven asset not found: ${id}`)
  const info = { description: '', categories: a.categories, tags: a.tags }
  infoCache.set(id, info)
  return info
}

/** 贴图直链（1K jpg，够用且快） */
export function mapUrl(id: string, kind: 'diff' | 'nor_gl' | 'rough' | 'ao'): string {
  return `${DL}/${id}/${id}_${kind}_1k.jpg`
}

// 登记到「设置 → 缓存设置」：这里只清「贴图索引」，图片本体由浏览器 HTTP 缓存管理
registerCache({
  id: 'texIndex',
  labelKey: 'cache.texIndex',
  descKey: 'cache.texIndex.desc',
  stats: () => ({ count: cache ? 1 + infoCache.size : 0, bytes: cache ? listBytes : 0 }),
  clear: () => {
    const n = cache ? 1 : 0
    cache = null
    listBytes = 0
    infoCache.clear()
    return n
  },
})
