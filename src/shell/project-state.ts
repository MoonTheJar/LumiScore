// 工程 zip 的状态中枢：导出时收集「会话工程数据 + 本机偏好 + 3D 场景设置 + 已下载资源清单」，
// 导入时据此还原。sessionStorage 存随谱面走的工程数据；localStorage 存本机偏好（主题/语言/
// 音频/播放/悬浮窗位置等）。3D 场景整份 surf 由 3dpreview 持久化到 SURF_KEY，这里只搬运。
export const PROJECT_VERSION = 1;
export const PROJECT_FILE = "project.json";
export const SURF_KEY = "midee.surf3d";

/** 随谱面传递的工程数据（sessionStorage） */
const SESSION_KEYS = [
	"midee.name",
	"midee.xml",
	"midee.midi",
	"midee.midiOrig",
	"midee.layout",
	"midee.scoreMeta",
	"midee.symbolEdits",
	"midee.links",
	"midee.pathSvg",
	"midee.trajShape",
	"midee.dark2d",
] as const;

/** 本机偏好（localStorage，全局非谱面专属）；悬浮窗位置/固定与逐谱自动连线策略另行收集 */
const PREF_KEYS = [
	"midee.theme",
	"midee.motion",
	"midee.accent",
	"midee.locale",
	"midee.playOriginal",
	"midee.autoSoundfont",
	"midee.autoPoll",
	"midee.downloadMirror",
	"midee.volume",
	"midee.speed",
	"midee.trailPct",
	"midee.avOffset",
	"midee.fontCacheLimit",
	"midee.tracks.groupsExpanded",
	"lumiscore.recentColors",
] as const;

export interface ResourceEntry {
	id: string;
	category: string;
	name: string;
	bytes: number;
	downloadedAt: number;
	/** 重下直链/页面（font/piano 由程序自动管理，无手动链接） */
	url: string;
}

export interface ProjectState {
	version: number;
	app: string;
	exportedAt: string;
	/** 导出时所在步骤（1..5），导入后跳回该步 */
	step: number;
	name: string;
	session: Record<string, string>;
	prefs: Record<string, string>;
	surf: Record<string, unknown> | null;
	resources: ResourceEntry[];
}

function readSS(k: string): string | null {
	try {
		return sessionStorage.getItem(k);
	} catch {
		return null;
	}
}
function readLS(k: string): string | null {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
}

/** 已下载资源的重下链接：音色=FluidR3_GM 整包直链，贴图=Poly Haven 资产页 */
export function resourceUrl(category: string, id: string): string {
	if (category === "soundfont")
		return `https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/${id}-mp3.js`;
	if (category === "texture") return `https://polyhaven.com/a/${id}`;
	return "";
}

/** 直接读持久化的资源元数据（不依赖运行时驱动注册，任意页面都可收集） */
export function collectResources(): ResourceEntry[] {
	let meta: Record<
		string,
		{ category: string; name: string; bytes: number; downloadedAt: number }
	> = {};
	try {
		meta = JSON.parse(readLS("midee.resMeta") || "{}");
	} catch {
		meta = {};
	}
	return Object.entries(meta).map(([id, m]) => ({
		id,
		category: m.category,
		name: m.name,
		bytes: m.bytes,
		downloadedAt: m.downloadedAt,
		url: resourceUrl(m.category, id),
	}));
}

export interface CollectOpts {
	/** 含本机偏好 + 3D 场景设置（默认 true） */
	prefs?: boolean;
	/** 含已下载资源清单（默认 true） */
	resources?: boolean;
}

export function collectProjectState(
	step: number,
	opts: CollectOpts = {},
): ProjectState {
	const wantPrefs = opts.prefs !== false;
	const wantRes = opts.resources !== false;
	const session: Record<string, string> = {};
	for (const k of SESSION_KEYS) {
		const v = readSS(k);
		if (v !== null) session[k] = v;
	}
	const name = session["midee.name"] ?? "score";

	const prefs: Record<string, string> = {};
	if (wantPrefs) {
		for (const k of PREF_KEYS) {
			const v = readLS(k);
			if (v !== null) prefs[k] = v;
		}
		// 悬浮窗位置/固定（midee.float.*）与逐谱自动连线策略（midee.policy.<曲名>）
		try {
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k?.startsWith("midee.float.")) {
					const v = localStorage.getItem(k);
					if (v !== null) prefs[k] = v;
				}
			}
		} catch {
			/* noop */
		}
		const policyKey = `midee.policy.${name}`;
		const pv = readLS(policyKey);
		if (pv !== null) prefs[policyKey] = pv;
	}

	let surf: Record<string, unknown> | null = null;
	if (wantPrefs) {
		try {
			surf = JSON.parse(readLS(SURF_KEY) ?? "null");
		} catch {
			surf = null;
		}
	}

	return {
		version: PROJECT_VERSION,
		app: "星跃谱 LumiScore",
		exportedAt: new Date().toISOString(),
		step,
		name,
		session,
		prefs,
		surf,
		resources: wantRes ? collectResources() : [],
	};
}

/** 还原工程状态：先清掉旧会话工程数据再写入，避免残留上一页/上一谱的脏数据。返回应跳去的步骤。 */
export function applyProjectState(state: ProjectState): number {
	try {
		for (const k of SESSION_KEYS) sessionStorage.removeItem(k);
		for (const [k, v] of Object.entries(state.session ?? {})) {
			sessionStorage.setItem(k, v);
		}
	} catch {
		/* noop */
	}
	try {
		// 清掉旧悬浮窗布局，再写入工程带来的（避免残留无关键）
		const floatKeys: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k?.startsWith("midee.float.")) floatKeys.push(k);
		}
		for (const k of floatKeys) localStorage.removeItem(k);
		for (const [k, v] of Object.entries(state.prefs ?? {})) {
			localStorage.setItem(k, v);
		}
		if (state.surf) localStorage.setItem(SURF_KEY, JSON.stringify(state.surf));
	} catch {
		/* noop */
	}
	const step = Number(state.step);
	return step >= 1 && step <= 5 ? step : 2;
}
