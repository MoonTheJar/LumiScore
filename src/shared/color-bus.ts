/**
 * 中央颜色调度器（ColorBus）。
 *
 * 设计：所有可调颜色元素以一个稳定 id 注册；变色时 publish 一次。
 * 颜色窗里的「跟随」下拉直接枚举其他已注册元素：
 *   - 开启「同步」= 订阅该 id，目标变色实时跟随；
 *   - 关闭「同步」= 只取一次快照，之后不再跟随。
 * 这样避免颜色窗两两互绑，新增元素只要 register + publish 即可被跟随。
 */
export type ColorId = string;

type Listener = (color: number) => void;

class ColorBusImpl {
	private colors = new Map<ColorId, number>();
	private names = new Map<ColorId, string>();
	private listeners = new Map<ColorId, Set<Listener>>();

	/** 注册一个可调颜色元素（重复注册只更新显示名）。initialColor 给一个初始值。 */
	register(id: ColorId, name: string, initialColor: number): void {
		this.names.set(id, name);
		if (!this.colors.has(id)) this.colors.set(id, initialColor);
	}

	/** 某元素变色 → 广播给所有订阅者。 */
	publish(id: ColorId, color: number): void {
		this.colors.set(id, color);
		const set = this.listeners.get(id);
		if (!set) return;
		for (const cb of set) {
			try {
				cb(color);
			} catch {
				/* 单个订阅出错不影响其他 */
			}
		}
	}

	/** 订阅某元素颜色变化，返回退订函数。 */
	subscribe(id: ColorId, cb: Listener): () => void {
		if (!this.listeners.has(id)) this.listeners.set(id, new Set());
		this.listeners.get(id)!.add(cb);
		// 立即回一次当前色，保证订阅时就对齐
		const cur = this.colors.get(id);
		if (cur !== undefined) {
			try {
				cb(cur);
			} catch {
				/* noop */
			}
		}
		return () => {
			this.listeners.get(id)?.delete(cb);
		};
	}

	/** 取一次当前色（不同步跟随）。 */
	peek(id: ColorId): number | undefined {
		return this.colors.get(id);
	}

	/** 列出所有可跟随元素（排除自己）。 */
	listExclude(selfId: ColorId): { id: ColorId; name: string }[] {
		const out: { id: ColorId; name: string }[] = [];
		for (const [id, name] of this.names) {
			if (id === selfId) continue;
			out.push({ id, name });
		}
		return out;
	}
}

export const ColorBus = new ColorBusImpl();
