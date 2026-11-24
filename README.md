# LumiScore

> 浏览器里的 3D 乐谱可视化与视频导出工具

LumiScore 是一个运行在浏览器中的 3D 乐谱可视化 Web 应用：导入 MIDI / MusicXML，在可交互的 3D 场景中渲染乐谱与音符动画，并可一键导出为视频。线上版本已发布于 bilibili TOY。

## 在线体验

- **bilibili TOY**：https://www.bilibili.com/toy/lumiscore/ （短链：https://b23.tv/GtGrj2K ）

## 功能特性

- 多格式乐谱导入：MIDI、MusicXML / MXL（基于 Verovio 与 WebMscore）
- 3D 乐谱场景渲染（Three.js）与 2D 谱面预览（VexFlow）
- 钢琴卷帘、音符下落动画、自由摄像机运镜
- 内置示例曲目与音源（Tone.js / smplr）
- 一键导出视频（mediabunny 录制 + lamejs 合成音频 MP3）
- 中文 / English 界面

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 框架 | SolidJS + TypeScript + Vite |
| 3D 渲染 | Three.js、three.quarks、meshline |
| 2D / 谱面 | PixiJS、VexFlow、Verovio |
| 音频 | Tone.js、smplr、@tonejs/midi、WebMscore |
| 视频导出 | mediabunny、@breezystack/lamejs |
| 测试 | Vitest、Playwright |

## 快速开始

需要 Node.js 18 及以上。

```bash
npm install
npm run dev
```

构建线上版本（输出到 `lumiscore/`，部署资源同步到 `deploy/`，二者均不纳入版本库）：

```bash
npm run build:lumiscore
```

检查：

```bash
npm run check   # typecheck + lint + test
```

## 项目结构

- `src/` — 应用源码
- `public/` — 静态资源
- `scripts/` — 构建与工具脚本
- `content/` — 站点内容生成
- `icons/` — 图标源文件

> 开发期的测试台（`shell-test/`）与构建产物（`lumiscore/`、`deploy/`、`assets/`）已通过 `.gitignore` 排除，不出现在本仓库中。

## 开源许可

本项目基于 [GPL-3.0-or-later](LICENSE) 开源。

部分第三方组件遵循其各自许可（LGPL-3.0、MIT、MPL-2.0、OFL-1.1 等），完整清单见应用内「关于」页的开源声明。
