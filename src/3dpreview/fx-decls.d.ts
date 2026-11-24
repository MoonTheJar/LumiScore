// 无类型声明的特效/字体依赖：最小 d.ts（仅覆盖 3D 页与 shared/font-outline 用到的 API）
declare module "opentype.js" {
	namespace opentype {
		interface CmdM {
			type: "M";
			x: number;
			y: number;
		}
		interface CmdL {
			type: "L";
			x: number;
			y: number;
		}
		interface CmdC {
			type: "C";
			x: number;
			y: number;
			x1: number;
			y1: number;
			x2: number;
			y2: number;
		}
		interface CmdQ {
			type: "Q";
			x: number;
			y: number;
			x1: number;
			y1: number;
		}
		interface CmdZ {
			type: "Z";
		}
		type PathCommand = CmdM | CmdL | CmdC | CmdQ | CmdZ;
		interface Path {
			commands: PathCommand[];
			getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
			toPathData(decimalPlaces?: number): string;
		}
		interface Glyph {
			path: Path;
			index: number;
		}
		class Font {
			unitsPerEm: number;
			charToGlyph(ch: string): Glyph | undefined;
		getAdvanceWidth(text: string, fontSize?: number): number;
			getPath(
				text: string,
				x: number,
				y: number,
				fontSize: number,
				options?: { kerning?: boolean },
			): Path;
		}
		function parse(buffer: ArrayBuffer): Font;
	}
	export = opentype;
}
