// ── 贴图资源注册（共享：shell 下载弹窗 + 3D 页共用） ───────────
// 把「贴图」分类的注册从 3D main.ts 抽出来，让非 3D 页面的「下载资源」
// 弹窗也能看到贴图分类。下载逻辑只依赖 polyhaven 的直链，不涉及 3D 内存。
// 3D 页通过 setTextureHooks() 注入 inUse / deactivate（管理 GPU 贴图）。

import { registerCategory, setCatalog, type CategoryDriver } from '../shared/resource-manager'
import { mapUrl, fetchTextureList } from './polyhaven'
import { texNameZh, catLeafZh } from './ph-names'

/** 流式拉取单个贴图分片，按 Content-Length 上报 0-100 进度 */
async function fetchBlobProgressive(url: string, onProgress: (p: number) => void): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`贴图 HTTP ${res.status}`)
  const total = Number(res.headers.get('Content-Length')) || 0
  if (!res.body || !total) {
    const blob = await res.blob()
    onProgress(100)
    return blob
  }
  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress(Math.min(100, Math.round((received / total) * 100)))
  }
  onProgress(100)
  return new Blob(chunks)
}

const textureDriver: CategoryDriver = {
  catalog: [],
  downloadable: true,
  download: async (id, onProgress) => {
    onProgress(5)
    // 三片并行下载，各自 0-100 取平均后映射到整体 5-100
    const sub = [0, 0, 0]
    const update = () => onProgress(5 + Math.round((sub.reduce((a, b) => a + b, 0) / 3) * 0.95))
    const [diff, nor, rough] = await Promise.all([
      fetchBlobProgressive(mapUrl(id, 'diff'), (p) => { sub[0] = p; update() }),
      fetchBlobProgressive(mapUrl(id, 'nor_gl'), (p) => { sub[1] = p; update() }),
      fetchBlobProgressive(mapUrl(id, 'rough'), (p) => { sub[2] = p; update() }),
    ])
    onProgress(100)
    const bytes = diff.size + nor.size + rough.size
    return { value: { diff, nor, rough }, bytes }
  },
  inUse: () => false,
  deactivate: () => { /* noop，3D 页会替换 */ },
}

registerCategory('texture', textureDriver)

/** 3D 页注入 inUse / deactivate（管理 GPU 贴图生命周期） */
export function setTextureHooks(hooks: {
  inUse?: (id: string) => boolean
  deactivate?: (id: string) => void
}): void {
  if (hooks.inUse) textureDriver.inUse = hooks.inUse
  if (hooks.deactivate) textureDriver.deactivate = hooks.deactivate
}

// ── 拉取 Poly Haven 清单后回填到资源管理器（懒加载） ──
let texCatalogLoaded = false
let texCatalogLoading: Promise<void> | null = null
export async function ensureTextureCatalog(): Promise<void> {
  if (texCatalogLoaded) return
  if (texCatalogLoading) return texCatalogLoading
  texCatalogLoading = (async () => {
    try {
      const list = await fetchTextureList()
      setCatalog('texture', list.map((a) => ({
        id: a.id,
        name: a.name,
        label: texNameZh(a.name),
        group: catLeafZh(a.category || a.categories?.[0] || ''),
      })))
      texCatalogLoaded = true
    } catch {
      /* 清单拉取失败不影响已下载贴图的展示；下次再试 */
      texCatalogLoading = null
    }
  })()
  return texCatalogLoading
}
