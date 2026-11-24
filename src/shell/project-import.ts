// 工程 zip 导入：识别含 project.json 的星跃谱工程包，还原会话数据/本机偏好/3D 场景设置，
// 并跳回导出时所在步骤。非工程 zip（mxl/mscz/gpx 等）返回 null，交回单文件导入流水线。
import { unzipSync } from "fflate";
import {
	applyProjectState,
	PROJECT_FILE,
	type ProjectState,
} from "./project-state";

export interface ProjectImportResult {
	step: number;
	name: string;
}

/** 是 zip 且含 project.json → 还原工程并返回目标步骤；不是工程包返回 null；
 *  是工程包但 project.json 损坏 → 抛错（由调用方提示）。 */
export function tryImportProjectZip(
	buf: Uint8Array,
): ProjectImportResult | null {
	if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return null;
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(buf);
	} catch {
		return null;
	}
	const raw = files[PROJECT_FILE];
	if (!raw) return null;
	const state = JSON.parse(new TextDecoder().decode(raw)) as ProjectState;
	if (!state || typeof state !== "object" || !state.session) {
		throw new Error("project.json 缺少 session 数据");
	}
	const step = applyProjectState(state);
	return { step, name: state.name || "score" };
}
