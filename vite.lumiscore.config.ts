/// <reference types="node" />
// lumiscore 静态托管包专用构建（hash 路由版）：
//   根 index.html 是 hash 路由外壳（#/import … #/3dpreview），全屏 iframe 承载
//   pages/<步骤>/index.html 五个物理页；音色采样走 smplr 在线源（不打包），
//   示例曲为 samples/*.md（MusicXML 数据包）。
//
// 平台约束：根 index.html；整包相对路径（base: './'）可放任意子目录；
//   后缀白名单（无 .map/.mid/.sf3/.webmanifest）→ sourcemap 关闭、public 用子集。
import { defineConfig, type Plugin } from 'vite'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 主流程 5 步 + 独立测试台页（bench 不进 hash 路由/UI，仅直接 URL 打开 pages/bench/index.html）
const STEPS = ['import', '2dpreview', 'link2d', '3dconfig', '3dpreview', 'bench'] as const
const MIRROR = '.lumiscore-entry'

const flowMirror = (root: string): Plugin => ({
  name: 'lumiscore-flow-mirror',
  apply: 'build',
  buildStart() {
    rmSync(join(root, MIRROR), { recursive: true, force: true })
    for (const step of STEPS) {
      const html = readFileSync(join(root, 'src', step, 'index.html'), 'utf8')
        // 同目录 TS 入口改成项目根绝对路径（镜像目录里没有 main.ts）
        .replace('src="./main.ts"', `src="/src/${step}/main.ts"`)
      const dir = join(root, MIRROR, 'pages', step)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.html'), html)
    }
  },
  closeBundle() {
    const out = join(root, 'lumiscore')
    // 五页首帧都请求包根的 ../../shell-theme.css；publicDir 指向 deploy/public，
    // 所以这里单独把令牌副本补到发布包根，避免首帧 404 与样式闪动。
    // 注意：CI 全新检出时 outDir 可能尚未生成，写入前必须先建目录。
    const theme = join(root, 'public', 'shell-theme.css')
    if (existsSync(theme)) {
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'shell-theme.css'), readFileSync(theme))
    }
    // 镜像前缀 .lumiscore-entry/ 去掉：lumiscore/.lumiscore-entry/pages → lumiscore/pages。
    // 镜像深度与最终深度都是两级（pages/<step>），Vite 注入的 ../../assets 引用无需改写。
    const staged = join(out, MIRROR, 'pages')
    if (existsSync(staged)) {
      for (const step of STEPS) {
        const from = join(staged, step, 'index.html')
        const toDir = join(out, 'pages', step)
        mkdirSync(toDir, { recursive: true })
        if (existsSync(from)) {
          // Vite 按镜像三级深度（.lumiscore-entry/pages/<step>）注入 ../../../assets，
          // 最终落点 pages/<step> 是两级深度，统一减一级
          const html = readFileSync(from, 'utf8').replaceAll('../../../', '../../')
          writeFileSync(join(toDir, 'index.html'), html)
          rmSync(from, { force: true })
        }
      }
      rmSync(join(out, MIRROR), { recursive: true, force: true })
    }
    // 根入口：deploy/index.html → lumiscore/index.html
    // （注入的资源引用按 deploy/ 一级深度生成 assets/…，移到根后同样有效）
    const rootHtml = join(out, 'deploy', 'index.html')
    if (existsSync(rootHtml)) {
      // 入口原在 deploy/（一级深度），Vite 注入 ../assets/…；移到包根后去掉 ../
      const html = readFileSync(rootHtml, 'utf8').replaceAll('../assets/', 'assets/')
      writeFileSync(join(out, 'index.html'), html)
      rmSync(rootHtml, { force: true })
      rmSync(join(out, 'deploy'), { recursive: true })
    }
    rmSync(join(root, MIRROR), { recursive: true, force: true })
  },
})

export default defineConfig({
  base: './',
  publicDir: 'deploy/public',
  plugins: [flowMirror(process.cwd())],
  resolve: {
    alias: { events: 'events' },
  },
  build: {
    outDir: 'lumiscore',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        // 根入口（hash 外壳）：产物由 deploy/index.html → lumiscore/index.html
        root: 'deploy/index.html',
        ...Object.fromEntries(
          STEPS.map((step) => [
            `pages/${step}/index`,
            `${MIRROR}/pages/${step}/index.html`,
          ]),
        ),
      },
      output: {
        // pixi 运行时动态 import 渲染器，分包会形成循环依赖导致构造器崩溃，整块合一
        manualChunks(id: string) {
          if (id.includes('node_modules/pixi.js')) return 'pixi'
        },
      },
    },
  },
})
