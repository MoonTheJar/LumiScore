// Draggable colour-picker popover for per-track colour overrides.
//
// Responsibilities:
//   - Floating glass panel (position: fixed, high z-index) anchored near the
//     triggering swatch; draggable by its title bar (pointer events, same
//     pattern as FloatingHud).
//   - HSV picker on a single <canvas>: a hue bar (top) + a saturation/value
//     square (bottom), each with a live indicator.
//   - Hex (#RRGGBB) text input with live validation.
//   - Colour preview swatch + hex read-out, plus a small "default" reference.
//   - Apply / Cancel / Reset-to-default actions.
//   - Closes on outside click, Esc, or any action.
//
// HSV (hue/sat/val) is the source of truth; the hex number is derived via a
// memo so the wheel, the input, and the preview never disagree. Hue is
// preserved when the colour is achromatic (s=0 or v=0) so dragging back out of
// grey keeps the last hue instead of snapping to red.

import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { render } from "solid-js/web";
import { t } from "../i18n";
import { icons } from "./icons";
import { raiseZ } from "./utils";

// = Colour conversions ======================================================
// hex number <-> hex string <-> RGB <-> HSV. All pure; used to keep the wheel,
// the hex input, and the preview in sync from a single HSV source of truth.

function hexToRgb(hex: number): [number, number, number] {
	return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function rgbToHex(r: number, g: number, b: number): number {
	return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function hexToCSS(hex: number): string {
	return `#${hex.toString(16).padStart(6, "0")}`;
}

function cssToHex(css: string): number | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
	if (!m) return null;
	return parseInt(m[1]!, 16);
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	const s = max === 0 ? 0 : d / max;
	const v = max;
	return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return [
		Math.round((r + m) * 255),
		Math.round((g + m) * 255),
		Math.round((b + m) * 255),
	];
}

// = Canvas layout ===========================================================
// All in CSS pixels; the backing store is scaled by devicePixelRatio in
// setupCanvas() so indicators stay crisp on HiDPI screens.

const W = 200; // canvas width
const HUE_H = 24; // hue bar height (top)
const GAP = 8; // gap between hue bar and SV square
const SV_H = 176; // saturation/value square height (bottom)
const H = HUE_H + GAP + SV_H; // total canvas height = 208

const clamp = (v: number, lo: number, hi: number): number =>
	Math.max(lo, Math.min(hi, v));

// = Component ===============================================================

export interface ColorPickerProps {
	initialColor: number;
	defaultColor: number;
	trackName: string;
	// Which scope this picker edits. Drives the title label and the restore
	// hint 鈥?track restores to theme, particle/border restore to track.
	scope?: "track" | "particle" | "border" | "theme" | "note" | "background";
	onConfirm: (color: number) => void;
	onReset: () => void;
	onClose: () => void;
	onChange?: (color: number) => void;
	anchorEl?: HTMLElement | null;
}

export function ColorPicker(props: ColorPickerProps) {
	// HSV is the source of truth, initialised from props.initialColor.
	const initRgb = hexToRgb(props.initialColor);
	const initHsv = rgbToHsv(initRgb[0], initRgb[1], initRgb[2]);
	const [hue, setHue] = createSignal(initHsv[0]);
	const [sat, setSat] = createSignal(initHsv[1]);
	const [val, setVal] = createSignal(initHsv[2]);

	// Hex input text + validity. Kept as a plain signal (not derived) so a
	// partially-typed value isn't clobbered while the user is editing.
	const [hexText, setHexText] = createSignal(hexToCSS(props.initialColor));
	const [hexValid, setHexValid] = createSignal(true);

	// Pin state: mirrors FloatingHud. Pinned panels resist any future
	// auto-dismiss path and serve as a visual anchor consistent with other HUDs.
	const [pinned, setPinned] = createSignal(false);
	function togglePin(): void {
		setPinned((p) => !p);
	}

	// The canonical colour, derived from HSV. Every read-out (preview, confirm,
	// indicator fill) uses this so the wheel and the value never disagree.
	const color = createMemo(() => {
		const [r, g, b] = hsvToRgb(hue(), sat(), val());
		return rgbToHex(r, g, b);
	});

	// Real-time preview: call onChange whenever color changes.
	createEffect(() => {
		if (props.onChange) {
			const rgb = hexToRgb(color());
			if (rgb) {
				props.onChange((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
			}
		}
	});

	// Panel position (fixed). Anchored near the triggering element on open.
	const [posX, setPosX] = createSignal(0);
	const [posY, setPosY] = createSignal(0);

	let canvasRef!: HTMLCanvasElement;
	let panelEl!: HTMLDivElement;
	let overlayEl!: HTMLDivElement;
	let ctx: CanvasRenderingContext2D | null = null;

	// Which canvas region a drag started in ('hue' | 'sv' | null). Non-reactive.
	let dragRegion: "hue" | "sv" | null = null;
	// Panel-drag state. Non-reactive.
	let panelDragging = false;
	let panelDragStartX = 0;
	let panelDragStartY = 0;
	let panelDragOriginX = 0;
	let panelDragOriginY = 0;

	// -- Canvas drawing -------------------------------------------------------

	function setupCanvas(): void {
		const c = canvasRef;
		if (!c) return;
		const dpr = window.devicePixelRatio || 1;
		c.width = Math.round(W * dpr);
		c.height = Math.round(H * dpr);
		c.style.width = `${W}px`;
		c.style.height = `${H}px`;
		ctx = c.getContext("2d");
		if (ctx) ctx.scale(dpr, dpr);
	}

	function drawWheel(): void {
		const g = ctx;
		if (!g) return;
		g.clearRect(0, 0, W, H);

		// Hue bar (top): horizontal rainbow.
		const hueGrad = g.createLinearGradient(0, 0, W, 0);
		hueGrad.addColorStop(0 / 360, "#ff0000");
		hueGrad.addColorStop(60 / 360, "#ffff00");
		hueGrad.addColorStop(120 / 360, "#00ff00");
		hueGrad.addColorStop(180 / 360, "#00ffff");
		hueGrad.addColorStop(240 / 360, "#0000ff");
		hueGrad.addColorStop(300 / 360, "#ff00ff");
		hueGrad.addColorStop(360 / 360, "#ff0000");
		g.fillStyle = hueGrad;
		g.fillRect(0, 0, W, HUE_H);

		// SV square (bottom): pure hue, then a white->transparent horizontal
		// overlay (saturation 0..1 left->right), then a transparent->black
		// vertical overlay (value 1..0 top->bottom).
		const svY = HUE_H + GAP;
		const [hr, hg, hb] = hsvToRgb(hue(), 1, 1);
		g.fillStyle = `rgb(${hr}, ${hg}, ${hb})`;
		g.fillRect(0, svY, W, SV_H);

		const satGrad = g.createLinearGradient(0, svY, W, svY);
		satGrad.addColorStop(0, "rgba(255, 255, 255, 1)");
		satGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
		g.fillStyle = satGrad;
		g.fillRect(0, svY, W, SV_H);

		const valGrad = g.createLinearGradient(0, svY, 0, svY + SV_H);
		valGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
		valGrad.addColorStop(1, "rgba(0, 0, 0, 1)");
		g.fillStyle = valGrad;
		g.fillRect(0, svY, W, SV_H);

		// Hue indicator: white vertical line with a dark core (visible on any hue).
		const hx = (hue() / 360) * W;
		g.lineWidth = 3;
		g.strokeStyle = "#ffffff";
		g.beginPath();
		g.moveTo(hx, 0);
		g.lineTo(hx, HUE_H);
		g.stroke();
		g.lineWidth = 1;
		g.strokeStyle = "rgba(0, 0, 0, 0.55)";
		g.beginPath();
		g.moveTo(hx, 0);
		g.lineTo(hx, HUE_H);
		g.stroke();

		// SV indicator: ring filled with the current colour, white + dark outline.
		const sx = sat() * W;
		const sy = svY + (1 - val()) * SV_H;
		g.beginPath();
		g.arc(sx, sy, 6, 0, Math.PI * 2);
		g.fillStyle = hexToCSS(color());
		g.fill();
		g.lineWidth = 2.5;
		g.strokeStyle = "#ffffff";
		g.stroke();
		g.lineWidth = 1;
		g.strokeStyle = "rgba(0, 0, 0, 0.5)";
		g.stroke();
	}

	// -- Canvas interaction ---------------------------------------------------

	function regionAt(x: number, y: number): "hue" | "sv" | null {
		if (y >= 0 && y <= HUE_H) return "hue";
		if (y >= HUE_H + GAP && y <= H) return "sv";
		return null;
	}

	function applyCanvasPointer(e: PointerEvent): void {
		if (!dragRegion) return;
		const c = canvasRef;
		if (!c) return;
		const rect = c.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		if (dragRegion === "hue") {
			setHue(clamp(x / W, 0, 1) * 360);
		} else {
			const svY = HUE_H + GAP;
			setSat(clamp(x / W, 0, 1));
			setVal(clamp(1 - (y - svY) / SV_H, 0, 1));
		}
		// Sync the hex field to the new colour (the user is driving the wheel, not
		// typing, so overwriting the input here is the desired behaviour).
		setHexText(hexToCSS(color()));
		setHexValid(true);
	}

	function onCanvasPointerDown(e: PointerEvent): void {
		e.preventDefault();
		const c = canvasRef;
		if (!c) return;
		const rect = c.getBoundingClientRect();
		const reg = regionAt(e.clientX - rect.left, e.clientY - rect.top);
		if (!reg) return;
		dragRegion = reg;
		try {
			c.setPointerCapture(e.pointerId);
		} catch {
			// pointer capture can throw if the pointer is no longer active; ignore
		}
		applyCanvasPointer(e);
	}

	function onCanvasPointerMove(e: PointerEvent): void {
		if (!dragRegion) return;
		e.preventDefault();
		applyCanvasPointer(e);
	}

	function onCanvasPointerUp(e: PointerEvent): void {
		if (!dragRegion) return;
		dragRegion = null;
		try {
			canvasRef?.releasePointerCapture(e.pointerId);
		} catch {
			// ignore
		}
	}

	// -- Hex input ------------------------------------------------------------

	function onHexInput(
		e: InputEvent & { currentTarget: HTMLInputElement; target: Element },
	): void {
		const v = e.currentTarget.value;
		setHexText(v);
		const parsed = cssToHex(v);
		if (parsed === null) {
			setHexValid(false);
			return;
		}
		setHexValid(true);
		const [r, g, b] = hexToRgb(parsed);
		const [h, s, vv] = rgbToHsv(r, g, b);
		// Preserve the current hue when the colour is achromatic (grey/white/black)
		// so the hue bar doesn't snap to red while the user edits the hex field.
		if (s > 0 && vv > 0) setHue(h);
		setSat(s);
		setVal(vv);
	}

	// -- Panel dragging (title bar) ------------------------------------------

	function onTitlePointerDown(e: PointerEvent): void {
		// Only the primary button starts a drag.
		if (e.button !== 0) return;
		// Pinned: lock in place, no drag.
		if (pinned()) return;
		e.preventDefault();
		panelDragging = true;
		panelDragStartX = e.clientX;
		panelDragStartY = e.clientY;
		panelDragOriginX = posX();
		panelDragOriginY = posY();
		document.addEventListener("pointermove", onPanelPointerMove);
		document.addEventListener("pointerup", onPanelPointerUp);
	}

	function onPanelPointerMove(e: PointerEvent): void {
		if (!panelDragging) return;
		const w = panelEl?.offsetWidth ?? 280;
		const h = panelEl?.offsetHeight ?? 420;
		const nx = clamp(
			panelDragOriginX + (e.clientX - panelDragStartX),
			8,
			Math.max(8, window.innerWidth - w - 8),
		);
		const ny = clamp(
			panelDragOriginY + (e.clientY - panelDragStartY),
			8,
			Math.max(8, window.innerHeight - h - 8),
		);
		setPosX(nx);
		setPosY(ny);
	}

	function onPanelPointerUp(): void {
		panelDragging = false;
		document.removeEventListener("pointermove", onPanelPointerMove);
		document.removeEventListener("pointerup", onPanelPointerUp);
	}

	// Outside-click and Esc no longer close the picker - only the X button
	// (props.onClose) does. The overlay div is kept only to block the
	// underlying UI while the picker is open.

	// -- Actions --------------------------------------------------------------

	function onConfirmClick(): void {
		props.onConfirm(color());
		// Don't close - only the X button closes. Lets the user keep tuning.
	}

	// Restore: snap the wheel back to the caller-supplied default colour
	// (theme colour for track pickers, current track colour for border /
	// particle pickers) and delegate to props.onReset() so the caller can
	// actually clear its override store. Writing defaultColor via onConfirm
	// here would instead *set* an override equal to the default, which defeats
	// the point of "restore" (the swatch would then read as overridden).
	function onResetClick(): void {
		const [r, g, b] = hexToRgb(props.defaultColor);
		const [h, s, v] = rgbToHsv(r, g, b);
		setHue(h);
		setSat(s);
		setVal(v);
		setHexText(hexToCSS(props.defaultColor));
		setHexValid(true);
		props.onReset();
	}

	// -- Positioning + lifecycle ---------------------------------------------

	function computeInitialPos(): { x: number; y: number } {
		const w = 280;
		const h = 420;
		const anchor = props.anchorEl;
		if (anchor) {
			const r = anchor.getBoundingClientRect();
			let x = r.right + 12;
			let y = r.top;
			// Flip to the left side if there is no room on the right.
			if (x + w > window.innerWidth - 8) x = r.left - w - 12;
			// If neither side fits, sit just inside the left edge under the anchor.
			if (x < 8) x = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8));
			if (y + h > window.innerHeight - 8)
				y = Math.max(8, window.innerHeight - h - 8);
			return { x, y };
		}
		// No anchor: centre, biased toward the upper third.
		return {
			x: clamp(
				(window.innerWidth - w) / 2,
				8,
				Math.max(8, window.innerWidth - w - 8),
			),
			y: clamp(
				(window.innerHeight - h) / 3,
				8,
				Math.max(8, window.innerHeight - h - 8),
			),
		};
	}

	function clampToViewport(): void {
		const w = panelEl?.offsetWidth ?? 280;
		const h = panelEl?.offsetHeight ?? 420;
		setPosX(clamp(posX(), 8, Math.max(8, window.innerWidth - w - 8)));
		setPosY(clamp(posY(), 8, Math.max(8, window.innerHeight - h - 8)));
	}

	onMount(() => {
		const p = computeInitialPos();
		setPosX(p.x);
		setPosY(p.y);
		setupCanvas();
		drawWheel();
		// Re-clamp once layout is measurable so an anchor near an edge doesn't
		// leave the panel hanging off-screen.
		requestAnimationFrame(clampToViewport);
		if (overlayEl) raiseZ(overlayEl);
	});

	// Redraw whenever HSV changes (wheel drag or hex input). Declared after
	// onMount so its initial run sees the canvas sized by setupCanvas().
	createEffect(() => {
		hue();
		sat();
		val();
		drawWheel();
	});

	onCleanup(() => {
		document.removeEventListener("pointermove", onPanelPointerMove);
		document.removeEventListener("pointerup", onPanelPointerUp);
	});

	// -- Render ---------------------------------------------------------------

	return (
		<div class="color-picker-overlay" ref={overlayEl!}>
			<div
				class="color-picker-panel"
				ref={panelEl!}
				onPointerDown={() => {
					if (overlayEl) raiseZ(overlayEl);
				}}
				style={{ left: `${posX()}px`, top: `${posY()}px` }}
				role="dialog"
				aria-modal="true"
				aria-label={t(`colorPicker.title.${props.scope ?? "track"}`)}
			>
				<div class="color-picker-titlebar" onPointerDown={onTitlePointerDown}>
					<span
						class="color-picker-drag"
						aria-hidden="true"
						innerHTML={icons.grip(10)}
					/>
					<button
						class="color-picker-pin"
						classList={{ "color-picker-pin--on": pinned() }}
						type="button"
						aria-label={t("hud.aria.pin")}
						aria-pressed={pinned()}
						data-tip={t("hud.pin")}
						onClick={togglePin}
						innerHTML={icons.pin(12)}
					/>
					<span class="color-picker-title-text">
						<span class="color-picker-title-label">
							{t(`colorPicker.title.${props.scope ?? "track"}`)}
						</span>
						<span class="color-picker-title-name">{props.trackName}</span>
					</span>
					<button
						class="color-picker-close"
						type="button"
						aria-label={t("colorPicker.aria.close")}
						onClick={() => props.onClose()}
						innerHTML={icons.close(13)}
					/>
				</div>

				<div class="color-picker-body">
					<canvas
						class="color-picker-wheel"
						ref={canvasRef!}
						onPointerDown={onCanvasPointerDown}
						onPointerMove={onCanvasPointerMove}
						onPointerUp={onCanvasPointerUp}
					/>

					<div class="color-picker-hex-row">
						<span class="color-picker-hex-label">{t("colorPicker.hex")}</span>
						<input
							class="color-picker-hex-input"
							classList={{ "is-invalid": !hexValid() }}
							type="text"
							value={hexText()}
							spellcheck={false}
							autocomplete="off"
							maxlength={7}
							onInput={onHexInput}
						/>
					</div>

					<div class="color-picker-preview-row">
						<span
							class="color-picker-preview"
							style={{ background: hexToCSS(color()) }}
						/>
						<span class="color-picker-preview-hex">
							{hexToCSS(color()).toUpperCase()}
						</span>
						<span
							class="color-picker-default"
							title={t(`colorPicker.resetHint.${props.scope ?? "track"}`)}
						>
							<span
								class="color-picker-default-swatch"
								style={{ background: hexToCSS(props.defaultColor) }}
							/>
						</span>
					</div>

					<div class="color-picker-actions">
						{props.scope !== "theme" && (
							<>
								<button
									class="color-picker-btn color-picker-btn--reset"
									type="button"
									onClick={onResetClick}
								>
									<span innerHTML={icons.undo(13)} />
									{t("colorPicker.reset")}
								</button>
								<span class="color-picker-actions-spacer" />
							</>
						)}

						<button
							class="color-picker-btn color-picker-btn--confirm"
							type="button"
							onClick={onConfirmClick}
						>
							<span innerHTML={icons.check(12)} />
							{t("colorPicker.confirm")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

// = Imperative host =========================================================
// Mirrors TrackPanel: a wrapper div is created up front and a SolidJS root is
// rendered into it on each open() (props vary per track), then disposed on
// close(). The host owns the lifecycle so callers (app.ts / TrackPanel) only
// deal with open(props) / close() / dispose().

export class ColorPickerHost {
	private disposeRoot: (() => void) | null = null;
	private wrapper: HTMLDivElement | null = null;

	constructor(container: HTMLElement) {
		const wrapper = document.createElement("div");
		container.appendChild(wrapper);
		this.wrapper = wrapper;
	}

	open(props: Omit<ColorPickerProps, "onClose">): void {
		// Replace any currently-open picker; the new one raises itself on mount.
		if (this.disposeRoot) this.close();
		const wrapper = this.wrapper;
		if (!wrapper) return;
		this.disposeRoot = render(
			() => <ColorPicker {...props} onClose={() => this.close()} />,
			wrapper,
		);
	}

	close(): void {
		this.disposeRoot?.();
		this.disposeRoot = null;
	}

	dispose(): void {
		this.close();
		this.wrapper?.remove();
		this.wrapper = null;
	}
}
