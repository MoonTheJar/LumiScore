// 静态资源根（public 目录在构建产物中的对应位置）。
// 五个流程页固定位于 <根>/src/<步骤>/index.html（dev 与 lumiscore 静态包同构），
// 因此相对当前页面向上两级即站点根；不依赖部署在域名根还是子目录（相对路径）。
//
// 已知脆弱点：宿主把 /pages/import（既不带尾斜杠也不补 index.html）直接吐出来时，
// document.baseURI 会把最后一段当文件名丢掉，基准就少一级 → webmscore / samples / logo
// 全部 404，而且是静默的。下面用一次极小的探测自纠：favicon 固定就在 <根>icons/ 下，
// 拿它当探针，猜错了就上下各试一级，纠正后 live binding 会让所有调用方拿到新值。
export let PUB_ROOT: string = new URL('../../', document.baseURI).href

const PROBE = 'icons/lumiscore-favicon.svg'
const CANDIDATES = ['../../../', '../../', '../', './']

void async function checkPubRoot(): Promise<void> {
  // 走默认缓存：favicon 通常早就在内存里，正常情况这次探测几乎零成本
  try {
    const hit = await fetch(new URL(PROBE, PUB_ROOT).href)
    if (hit.ok) return
  } catch {
    /* 落到下面的逐级试探 */
  }
  for (const rel of CANDIDATES) {
    const guess = new URL(rel, document.baseURI).href
    try {
      const hit = await fetch(new URL(PROBE, guess).href)
      if (!hit.ok) continue
    } catch {
      continue
    }
    if (guess !== PUB_ROOT) {
      PUB_ROOT = guess
      console.info('[lumiscore] 静态资源根已纠正为', PUB_ROOT)
    }
    return
  }
  console.warn('[lumiscore] 未能确定静态资源根，部分资源可能加载不到：', PUB_ROOT)
}()
