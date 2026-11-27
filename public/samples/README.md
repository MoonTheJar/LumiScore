# 内置示例乐谱数据包

`scripts/gen-sample-data.ts` 把 `public/samples/` 下的源文件转成纯 MusicXML 数据包（`.md`），
供导入页三张演示卡直接载入。运行 `npm run gen:samples` 重新生成。

## 当前示例（公共领域乐谱）

| 数据包 | 源文件 | 说明 |
|---|---|---|
| `bach-prelude-c.md` | `bach-prelude-c-bwv846.mxl` | 巴赫：C 大调前奏曲 BWV 846（公共领域） |
| `bach-minuet-g.md` | `bach-minuet-g-bwv-anh114.mxl` | 巴赫：G 大调小步舞曲 BWV Anh.114（公共领域） |
| `chopin-prelude-e-minor.md` | `chopin-prelude-e-minor-op28-4.mxl` | 肖邦：E 小调前奏曲 Op.28 No.4（公共领域） |

支持源格式：`.mxl`（fflate 解包取根文件）、`.musicxml`/`.xml`（直接读取）、`.mid`（经 midi-xml 转 MusicXML）。

## 主站开发用素材（非示例卡）

`bach-prelude-in-c.mid`、`chopin-nocturne-op9-2.mid`、`satie-gnossienne-1.mid` 仅用于主站
SamplesGrid 开发预览（`src/core/samples.ts`），不属于 lumiscore 部署的示例卡。

## 数据包格式

`.md` 内容为去掉首尾空白的 MusicXML 文本。导入页通过 `fetch('samples/<id>.md')` 取文本后，
走与用户上传完全相同的解析管线（`parseScore` → 预处理 → Verovio 渲染 → 2D/3D）。
