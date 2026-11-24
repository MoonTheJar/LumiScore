# Toy SDK 开发文档 · 星跃谱 LumiScore

> 面向「星跃谱 LumiScore」的 B 站 Toy 平台能力接入参考。基于官方 SDK（`//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js`）与容器适配层 `toy-sdk.js` 的实测结论编写。

---

## 1. 接入方式

在页面 `<head>` 或 `</body>` 前引入官方 SDK：

```html
<script src="//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
```

加载后全局可用 `window.toy`。除 `onContainerChange`（同步返回取消函数）外，其余方法返回 `Promise`。

**关键事实（已实测确认）**：
- 仅当页面运行在 B 站 Toy 容器（App 内 webview 或 B 站网页容器）时 `window.toy` 才存在且可用。
- 脱离容器的系统浏览器 / 本地开发环境，`window.toy` 为 `undefined`——**调用前必须判空，页面需在无 SDK 时完全降级可用**。
- 容器内 iframe 实际域名为 `https://www.bilibilitoy.com`。

---

## 2. 已跑通的核心三件（布局适配必需）

| 方法 | 作用 | 返回 |
|---|---|---|
| `toy.getContainerState()` | 读一次当前容器状态 | `Promise<ToyContainerState>` |
| `toy.setContainerMode({orientation, immersive})` | 切横竖屏 / 沉浸 | `Promise<void>`（不代表已生效，需配合监听） |
| `toy.onContainerChange(cb)` | 监听容器变化，先收一次当前状态，之后仅在变化时通知 | `() => void`（取消函数） |

**`ToyContainerState` 结构**：
```ts
{
  deviceType: string,
  viewport: { width: number, height: number },
  orientation: 'portrait' | 'landscape',
  immersive: boolean,
  safeArea: { top: number, right: number, bottom: number, left: number },
  changedFields: string[]   // onContainerChange 时标出本次变化的字段；主动读取恒为空数组
}
```

**`setContainerMode` 参数**：
```ts
{ orientation?: 'portrait' | 'landscape' | 'auto', immersive?: boolean }
// auto = 跟随系统；不传 = 保持当前
// 方向 + 沉浸需同时变更时一次传齐
```

**确认切换是否成功**：先 `onContainerChange` 监听，再 `setContainerMode`，收到与目标一致的状态变化才算成功；没有变化（如旧客户端不支持）不能当作成功。

> 注意：`onContainerChange` / `getContainerState` / `setContainerMode` **仅 B 站 App 内支持**，Web 端调用会抛错，务必先 `isSupport` 判断或判空降级。

---

## 3. 容器适配层实现（toy-sdk.js）

适配层职责：检测容器 → 读取状态 → 把安全区与方向注入 CSS 变量 → 提供可复制的切换控件。**无 SDK 时完全降级，不注入不建控件不报错。**

注入到 `<html>` 的 CSS 变量：
```
--toy-safe-top / --toy-safe-right / --toy-safe-bottom / --toy-safe-left
--toy-orientation   (portrait | landscape)
--toy-immersive     (true | false)
```

CSS 消费示例：
```css
header {
  padding-top: calc(env(safe-area-inset-top, 0px) + var(--toy-safe-top, 0px));
}
```

另暴露 `window.__toyState`：最近一次容器状态，非 Toy 环境为 `null`。

---

## 4. 五类能力详解与应用建议

### ① 导出 / 分享类 —— 最适合把 3D 视觉做成产品

| 方法 | 说明 | 环境 |
|---|---|---|
| `saveImageToAlbum({url 或 base64Data, hintMsg})` | 保存图片到相册；base64 ≤5MB，建议 ≤2M | **仅 App** |
| `share({path})` | 拉起 B 站分享面板；path 相对当前 Toy 根，如 `result.html?score=100` | **仅 App** |
| `getQrCode({path, size})` | 生成 Toy 内页面二维码，返回 PNG base64；不传即首页 | App + Web |

**星跃谱建议**：3D 预览页加「保存当前画面」→ `saveImageToAlbum`；出图后一键 `share` 分享成品。

### ② 用户 / 榜单 / 存储类 —— 可做"精准度排行榜"

| 方法 | 说明 |
|---|---|
| `getUserProfile()` | 头像 / 昵称 / 当前 Toy 内假名 ID（不暴露 UID） |
| `submitScore({board, score})` | 上报分数到榜位（1~5），只增不减、幂等 |
| `getRankList({board, period, limit})` | 读榜单（游客可读）；period: all/month/week/day |
| `getMyRank({board, period})` | 查自己在榜；用 `ranked` 字段判断是否上榜 |
| `getCloudStorage(keys?)` / `setCloudStorage(items)` / `removeCloudStorage(keys)` | 按「玩家 + 本 Toy」隔离的存档，≤128 键，value ≤1024 字节 |
| `getSharedStorage(storageId, keys?)` / `setSharedStorage` / `removeSharedStorage` | 按「玩家 + 存档」隔离，多 Toy 共享 |

**星跃谱建议**：`submitScore` + `getRankList` 做"同人曲节奏精准度 / 完成度排行榜"；`setCloudStorage` 存用户设置与进度。

### ③ 权限 / 媒体类

| 方法 | 说明 |
|---|---|
| `requestCamera({facingMode})` / `requestMicrophone()` | 申请权限，返回原生 MediaStream；必须用户手势触发 |
| `stopMedia(stream)` | 用完必须释放采集设备 |
| `checkInputSafety({text, scene})` | 玩家输入合规检测，返回 ok/rejected/unavailable |

### ④ 跳转类

| 方法 | 说明 |
|---|---|
| `navigate({type, id})` | 跳 video/space/search/opus/tribee/toy；需手势触发 |
| `closeBrowser()` | 关闭 WebView 容器（仅 App） |

### ⑤ 辅助

| 方法 | 说明 |
|---|---|
| `isSupport(ability)` | 调用前判断环境是否支持（App+Web 均可） |

---

## 5. 星跃谱五条优化灵感

1. **3D 预览页横屏沉浸**：进入 3D 页时 `setContainerMode({orientation:'landscape', immersive:true})`，配合 `onContainerChange` 监听容器变化动态重排；退出回竖屏。看谱最舒适。
2. **保存当前画面**：3D 页加「保存画面」→ `saveImageToAlbum`，视觉成品一键存相册。
3. **精准度排行榜**：`submitScore` + `getRankList` 做"节奏精准度 / 完成度榜单"，增加传播动机。
4. **跨设备接力二维码**：`getQrCode` 做 PC 扫码手机接力，或结算页海报。
5. **用户画像与合规**：`getUserProfile` 展示头像昵称做个性化；用户生成内容（昵称/留言）用 `checkInputSafety` 校验。

---

## 6. 频率限制与最佳实践

- 云存储 / 共享存档 / 排行榜按 **Toy 全体玩家共享额度**，越多人玩越要压低单人请求。
- 存档当存档不当内存：只在结算 / 过关 / 页面隐藏等关键节点落盘；批量读写，勿 for 循环逐 key。
- 榜单 / 存档拉一次本地缓存，不轮询；排行榜按事件提交一次。
- 限流识别：`error.type === 'http_error' && error.code === 307044`，指数退避重试，不立即重试。
- Web 端不支持的方法调用会抛 `[ToySDK]` 前缀错误，先 `isSupport` 判断。

---

*文档基于官方 SDK 文档与实测，适配层 `toy-sdk.js` 为可复用实现。*
