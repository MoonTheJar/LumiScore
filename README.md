# LumiScore

浏览器里的 3D 乐谱可视化与视频导出工具。

A browser-based 3D score visualizer and video exporter.

## 是什么

LumiScore 在浏览器中把 MIDI / MusicXML 乐谱转成可交互的 3D 场景：音符悬浮于三维空间，随播放进度点亮，摄像机沿谱面平滑推进，并可将整段演示导出为视频。全部计算在本地完成，无需服务端。

LumiScore turns MIDI / MusicXML scores into an interactive 3D scene in the browser: notes float in space and light up with playback, the camera travels smoothly along the score, and the whole run can be exported as video. Everything runs client-side — no backend required.

## 功能

- 乐谱导入：MIDI、MusicXML、MXL（Verovio + WebMscore）
- 3D 乐谱场景：音符下落动画、自由摄像机运镜、可选发光与后期效果
- 2D 谱面预览：VexFlow 渲染，钢琴卷帘视图
- 演奏与试听：Tone.js / smplr 音源，内置示例曲与音色采样
- 视频导出：mediabunny 录制 + lamejs 音频合成
- 中英双语界面，深浅色主题
- 内置公共领域示例谱：Bach BWV 846、Bach BWV Anh.114、Chopin Op.28 No.4

## Features

- Score import: MIDI, MusicXML, MXL (Verovio + WebMscore)
- 3D score scene: falling-note animation, free camera moves, optional glow and post effects
- 2D score preview: VexFlow rendering and piano-roll view
- Playback: Tone.js / smplr instruments, bundled demo scores and sampled timbres
- Video export: mediabunny recording with lamejs audio synthesis
- Bilingual UI (Chinese / English), light and dark themes
- Bundled public-domain demo scores: Bach BWV 846, Bach BWV Anh.114, Chopin Op.28 No.4

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 框架 | SolidJS + TypeScript + Vite |
| 3D 渲染 | Three.js、three.quarks、meshline |
| 2D / 谱面 | PixiJS、VexFlow、Verovio |
| 音频 | Tone.js、smplr、@tonejs/midi、WebMscore |
| 视频导出 | mediabunny、@breezystack/lamejs |
| 测试 | Vitest、Playwright |

## 在线体验

- bilibili TOY：https://www.bilibili.com/toy/lumiscore/
- GitHub Pages：https://moonthjar.github.io/LumiScore/

## 本地运行

需要 Node.js 18 及以上。

```bash
npm install
npm run dev
```

构建静态站点（输出到 `lumiscore/`，相对路径，可放在任意子目录）：

```bash
npm run build:pages
```

完整的 TOY 发布包（含示例数据再生成与资源同步）：

```bash
npm run build:lumiscore
```

检查：

```bash
npm run check   # typecheck + lint + test
```

## 目录

- `src/` — 应用源码
- `public/` — 静态资源与示例谱
- `scripts/` — 构建与工具脚本
- `content/` — 站点内容
- `icons/` — 图标源文件

构建产物（`lumiscore/`、`deploy/`、`dist/`）与开发测试台均不纳入版本库。

## 许可

基于 [GPL-3.0-or-later](LICENSE) 开源。第三方组件遵循各自许可（LGPL-3.0、MIT、MPL-2.0、OFL-1.1 等），完整清单见应用内「关于」页。
