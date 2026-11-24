// 测试台模式标记 + 硬编码场景预设。
// 必须在 fixture.ts 与 ../3dpreview/main 求值之前执行（ESM 按 import 声明顺序求值），
// 3dpreview/main.ts 据此进入 BENCH 分支（锁定编辑、不读不写用户存档）。
import { defaultObjMat, presetDefaultTune } from '../3dpreview/materials3d'
import type { SurfSettings } from '../3dpreview/settings-panel'

;(window as unknown as Record<string, unknown>).__LUMI_BENCH__ = true

// 硬编码场景预设：白膜——全白平面材质，关掉水面/玻璃/发光等全部特效
// （小球保留路径色：它是后续交互的测试目标，需要可见）。
// 其余字段走 surf 默认值（3dpreview main 的 normalizeSurf 会逐项钳位兜底）。
const benchSurf = {
	waterOn: false,
	glowBall: 0,
	glowLit: 0,
	glowGround: 0,
	glowSky: 0,
	bloomStrength: 0,
	mat: {
		score: { ...defaultObjMat('paper'), color: 0xffffff },
		ground: { ...defaultObjMat('flat'), color: 0xffffff },
		ball: defaultObjMat('flat'),
	},
	matTune: {
		score: presetDefaultTune('paper'),
		ground: presetDefaultTune('flat'),
		ball: presetDefaultTune('flat'),
	},
} as unknown as Partial<SurfSettings>
;(window as unknown as Record<string, unknown>).__LUMI_BENCH_SURF__ = benchSurf
