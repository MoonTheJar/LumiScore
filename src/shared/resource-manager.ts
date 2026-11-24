// ── 全站共享资源管理器 ─────────────────────────────────────────
// 网络音色 / 网络贴图这些「下载后全站共用」的资源统一在这里登记、下载、
// 持久化（IndexedDB）、卸载。每个资源有独立的状态机：
//   idle        未下载
//   downloading 下载中（带 progress 0-100）
//   done        已下载（IndexedDB 里有 blob）
//   failed      下载失败（网络/超时）
//   error       数据异常（已下载但解析失败）
//
// 字体分片不在此管理（按需取字符，不进下载目录），钢琴采样是本地静态包，
// 这两类只展示「已缓存/已内置」状态，不提供手动下载。
//
// 各资源模块（smplr-soundfont / 3d 贴图）通过 registerCategory 注册：
//   - catalog: 该类所有可下载资源的清单
//   - download: 取一个资源，返回 { value, bytes }（value 存进 IndexedDB）
//   - inUse:    该资源当前是否被场景占用（决定状态显示「使用中/闲置中」）

export type ResCategory = 'soundfont' | 'texture' | 'font' | 'piano'
export type ResStatus = 'idle' | 'queued' | 'downloading' | 'done' | 'failed' | 'error'

export interface ResState {
  id: string
  category: ResCategory
  name: string
  /** 显示名（来自目录，如中文名） */
  label?: string
  /** 折叠分类名（来自目录） */
  group?: string
  status: ResStatus
  progress: number
  bytes: number
  inUse: boolean
  error?: string
  updatedAt: number
}

export interface ResDef {
  id: string
  name: string
  /** 显示名（可选，优先于 name，如乐器中文名） */
  label?: string
  /** 折叠分类名（可选，如「钢琴」「Wood」） */
  group?: string
}

export interface CategoryDriver {
  catalog: ResDef[]
  /** 是否支持手动下载（字体 = false） */
  downloadable: boolean
  download: (id: string, onProgress: (p: number) => void) => Promise<{ value: unknown; bytes: number }>
  /** 该资源当前是否被场景使用（用于「使用中/闲置中」标注） */
  inUse?: (id: string) => boolean
  /** 从 IndexedDB 取出后激活到内存（可选，音色/贴图需要） */
  activate?: (id: string, value: unknown) => void
  /** 从内存移除（保留 IndexedDB）；delete 时会先调它 */
  deactivate?: (id: string) => void
}

const DB_NAME = 'lumiscore-resources'
const DB_VERSION = 1
const STORE = 'resources'
const META_KEY = 'midee.resMeta'

// ── IndexedDB 封装 ─────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}
function dbPut(key: string, value: unknown): Promise<void> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  }))
}
function dbGet(key: string): Promise<unknown | undefined> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}
function dbDelete(key: string): Promise<void> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  }))
}

// ── 状态元数据（localStorage，仅 id→{category,name,bytes,downloadedAt}） ──
interface ResMeta { category: ResCategory; name: string; bytes: number; downloadedAt: number }
function loadMeta(): Record<string, ResMeta> {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') } catch { return {} }
}
function saveMeta(m: Record<string, ResMeta>): void {
  try { localStorage.setItem(META_KEY, JSON.stringify(m)) } catch { /* quota */ }
}

// ── 运行时状态（内存；页面加载时从 IndexedDB + meta 重建 done 状态） ──
const drivers = new Map<ResCategory, CategoryDriver>()
const states = new Map<string, ResState>()
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 把目录里的可选字段（label/group）写到 state 上；undefined 不赋值（exactOptionalPropertyTypes） */
function applyDef(s: ResState, def: ResDef): void {
  if (def.label) s.label = def.label
  else delete s.label
  if (def.group) s.group = def.group
  else delete s.group
}

export function registerCategory(cat: ResCategory, driver: CategoryDriver): void {
  drivers.set(cat, driver)
  // 重建该类已下载资源的状态
  const meta = loadMeta()
  const catalogIds = new Set(driver.catalog.map((d) => d.id))
  for (const def of driver.catalog) {
    const m = meta[def.id]
    if (m) {
      const st: ResState = {
        id: def.id, category: cat, name: def.name,
        status: 'done', progress: 100, bytes: m.bytes,
        inUse: driver.inUse?.(def.id) ?? false, updatedAt: m.downloadedAt,
      }
      applyDef(st, def)
      states.set(def.id, st)
    } else if (!states.has(def.id)) {
      const st: ResState = {
        id: def.id, category: cat, name: def.name,
        status: 'idle', progress: 0, bytes: 0,
        inUse: false, updatedAt: 0,
      }
      applyDef(st, def)
      states.set(def.id, st)
    }
  }
  // catalog 未加载（如贴图清单还没拉）时，已下载的资源也要恢复状态，
  // 否则 listDownloaded 返回空，下拉列表里看不到已下载项
  for (const [id, m] of Object.entries(meta)) {
    if (m.category !== cat || catalogIds.has(id) || states.has(id)) continue
    states.set(id, {
      id, category: cat, name: m.name,
      status: 'done', progress: 100, bytes: m.bytes,
      inUse: driver.inUse?.(id) ?? false, updatedAt: m.downloadedAt,
    })
  }
  emit()
}

export function listCategories(): ResCategory[] {
  return [...drivers.keys()]
}

export function getDriver(cat: ResCategory): CategoryDriver | undefined {
  return drivers.get(cat)
}

/** 更新某类的资源清单（贴图清单从 Poly Haven 拉取后回填） */
export function setCatalog(cat: ResCategory, catalog: ResDef[]): void {
  const driver = drivers.get(cat)
  if (!driver) return
  driver.catalog = catalog
  const meta = loadMeta()
  for (const def of catalog) {
    if (!states.has(def.id)) {
      const m = meta[def.id]
      const st: ResState = {
        id: def.id, category: cat, name: def.name,
        status: m ? 'done' : 'idle',
        progress: m ? 100 : 0,
        bytes: m?.bytes ?? 0,
        inUse: driver.inUse?.(def.id) ?? false,
        updatedAt: m?.downloadedAt ?? 0,
      }
      applyDef(st, def)
      states.set(def.id, st)
    } else {
      // 目录更新时同步显示名/分组
      applyDef(states.get(def.id)!, def)
    }
  }
  emit()
}

/** 某类的全部资源（含未下载的 idle） */
export function listResources(cat: ResCategory): ResState[] {
  const driver = drivers.get(cat)
  if (!driver) return []
  const out: ResState[] = []
  const seen = new Set<string>()
  for (const def of driver.catalog) {
    seen.add(def.id)
    const s = states.get(def.id)
    if (s) {
      // 实时刷新 inUse + 显示名/分组
      s.inUse = driver.inUse?.(def.id) ?? false
      applyDef(s, def)
      out.push(s)
    } else {
      const st: ResState = { id: def.id, category: cat, name: def.name, status: 'idle', progress: 0, bytes: 0, inUse: false, updatedAt: 0 }
      applyDef(st, def)
      out.push(st)
    }
  }
  // 已下载但不在当前 catalog 里的资源（catalog 未加载时也能展示）
  for (const s of states.values()) {
    if (s.category !== cat || seen.has(s.id)) continue
    s.inUse = driver.inUse?.(s.id) ?? false
    out.push(s)
  }
  return out
}

/** 只看已下载（done / failed / error）的资源，用于右栏列表 */
export function listDownloaded(cat: ResCategory): ResState[] {
  return listResources(cat).filter((s) => s.status !== 'idle' || s.bytes > 0)
}

export function getState(id: string): ResState | undefined {
  return states.get(id)
}

/** 从 IndexedDB 取已下载资源的 blob/值（用于运行时激活） */
export function getStored(id: string): Promise<unknown | undefined> {
  return dbGet(id)
}

/** 是否已下载（IndexedDB 中有值） */
export async function isStored(id: string): Promise<boolean> {
  return (await dbGet(id)) !== undefined
}

// ── 下载队列（并发上限）─────────────────────────────────────────
// 一次导入大总谱可能同时请求十几二十个音色包，全部并发会互相抢带宽、
// 进度条乱跳、甚至把浏览器连接池打满导致「卡在下载中」。统一排队：
// 最多 MAX_CONCURRENT 个真正跑，其余标 queued 显示「排队中」。
const MAX_CONCURRENT = 3
let running = 0
const waitQueue: string[] = []

function pumpQueue(): void {
  while (running < MAX_CONCURRENT && waitQueue.length) {
    const id = waitQueue.shift()!
    const state = states.get(id)
    if (!state || state.status !== 'queued') continue // 期间被删除/重下，跳过
    running++
    void runDownload(id).finally(() => {
      running--
      pumpQueue()
    })
  }
}

// ── 下载 ───────────────────────────────────────────────────────
export async function downloadResource(id: string): Promise<void> {
  const state = states.get(id)
  if (!state) return
  const driver = drivers.get(state.category)
  if (!driver || !driver.downloadable) return
  if (state.status === 'downloading' || state.status === 'queued') return

  state.status = 'queued'
  state.progress = 0
  delete state.error
  emit()
  waitQueue.push(id)
  pumpQueue()
}

/** 真正执行一次下载（只由 pumpQueue 调用，保证并发上限） */
async function runDownload(id: string): Promise<void> {
  const state = states.get(id)
  if (!state) return
  const driver = drivers.get(state.category)
  if (!driver || !driver.downloadable) return

  state.status = 'downloading'
  state.progress = 0
  delete state.error
  emit()

  try {
    const { value, bytes } = await driver.download(id, (p) => {
      state.progress = Math.round(p)
      emit()
    })
    await dbPut(id, value)
    state.status = 'done'
    state.progress = 100
    state.bytes = bytes
    state.updatedAt = Date.now()
    const meta = loadMeta()
    meta[id] = { category: state.category, name: state.name, bytes, downloadedAt: state.updatedAt }
    saveMeta(meta)
    driver.activate?.(id, value)
  } catch (e) {
    state.status = 'failed'
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    emit()
  }
}

/** 重新下载：先删再下 */
export async function redownloadResource(id: string): Promise<void> {
  await deleteResource(id, /* keepMeta */ false)
  await downloadResource(id)
}

/** 删除：清 IndexedDB + 内存 + 激活态；keepMeta 仅供内部 redownload 用 */
export async function deleteResource(id: string, keepMeta = false): Promise<void> {
  const state = states.get(id)
  if (!state) return
  const driver = drivers.get(state.category)
  try { driver?.deactivate?.(id) } catch { /* noop */ }
  try { await dbDelete(id) } catch { /* noop */ }
  if (!keepMeta) {
    const meta = loadMeta()
    delete meta[id]
    saveMeta(meta)
  }
  state.status = 'idle'
  state.progress = 0
  state.bytes = 0
  delete state.error
  state.updatedAt = 0
  emit()
}

/** 刷新某类的 inUse 标记（场景切换后调用） */
export function refreshInUse(cat: ResCategory): void {
  const driver = drivers.get(cat)
  if (!driver?.inUse) return
  let changed = false
  for (const s of states.values()) {
    if (s.category !== cat) continue
    const next = driver.inUse(s.id)
    if (s.inUse !== next) { s.inUse = next; changed = true }
  }
  if (changed) emit()
}
