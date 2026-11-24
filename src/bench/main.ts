// 测试台入口：先置模式标记 + 同步注入写死 fixture，再拉起第五页的 3D 场景管线。
// 必须用动态 import：静态导入会被打包器提升到本模块顶部、先于 flag/fixture 求值
// （bundler 中所有 import 都先执行），main 会以「非测试台」姿态启动（BENCH=false、
// 读不到 fixture 数据）。动态 import 在本模块体执行完后才加载，flag/fixture 已就位。
// 3dpreview/main.ts 顶层末尾会自行调用 __lumiReady()，这里无需重复上报。
import './flag'
import './fixture'
void import('../3dpreview/main')
