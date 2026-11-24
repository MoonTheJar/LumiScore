import { createSignal, For, type Accessor } from "solid-js";
import { render } from "solid-js/web";
import { LOCALES, type LocaleCode, locale, t } from "../i18n";
import type {
	ParticleStyle,
	ParticleStyleInfo,
} from "../renderer/ParticleSystem";
import {
	BORDER_STYLE_IDS,
	type BorderStyle,
	type Theme,
} from "../renderer/theme";
import { BACKGROUND_MODES, type BackgroundMode } from "../renderer/PianoRollRenderer";
import { icons } from "./icons";
import { isNarrowViewport } from "./utils";

// Aesthetics popover 锟斤拷 collapses theme, particles, and chord overlay (three
// previously-separate topbar pills) into one trigger. Reduces topbar noise
// while keeping every option one tap away once opened.
//
// Pattern mirrors InstrumentMenu: a pill trigger anchored in the topbar +
// an absolutely-positioned popover anchored under it (or rendered as a
// bottom sheet on narrow viewports via shared CSS).

export interface CustomizeMenuCallbacks {
	onSelectTheme: (index: number) => void;
	onSelectParticle: (index: number) => void;
	onSelectBorderStyle: (index: number) => void;
	onOpenParticleColor: () => void;
	onOpenBorderColor: () => void;
	onOpenCustomThemeColor: () => void;
	onToggleChord: () => void;
	onSelectThreshold: (value: number) => void;
	onSelectLocale: (code: LocaleCode) => void;
	onKeyboardColorModeChange?: (mode: 'note' | 'border') => void;
	onVideoImport?: () => void;
	onVideoTrimChange?: (frontTrim: number, backTrim: number) => void;
	onOverlayOpacityChange?: (opacity: number) => void;
	onVideoOpacityChange?: (opacity: number) => void;
	onVideoTrimApply?: (startTime: number, endTime: number) => void;
	onVideoTrimCancel?: () => void;
	onLyricsImport?: () => void;
	onLyricsClear?: () => void;
	onImageScaleChange?: (scale: number) => void;
	onImageOffsetChange?: (offsetX: number) => void;
	onVolumeChange?: (volume: number) => void;
	onMediaVolumeChange?: (volume: number) => void;
	onPlaybackRateChange?: (rate: number) => void;
	// 鈹€鈹€ Waterfall background painting 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
	onSelectBackgroundMode?: (mode: BackgroundMode) => void;
	onOpenBackgroundSolidColor?: () => void;
	onOpenBackgroundGlowColor?: () => void;
	onBackgroundGlowIntensityChange?: (v: number) => void;
	onBackgroundOpacityChange?: (v: number) => void;
	onBackgroundDriftChange?: (v: number) => void;
}

interface TriggerProps {
	label: () => string;
	accent: () => string;
	isOpen: () => boolean;
	onToggle: () => void;
	registerEl: (el: HTMLButtonElement) => void;
}

function TriggerView(props: TriggerProps) {
	return (
		<button
			ref={(el) => props.registerEl(el)}
			class="ts-pill ts-pill--customize"
			classList={{ "ts-pill--open": props.isOpen() }}
			id="ts-customize"
			type="button"
			aria-label={t("customize.aria")}
			data-tip={t("customize.aria")}
			onClick={() => props.onToggle()}
		>
			<span
				class="ts-customize-icon"
				id="ts-customize-icon"
				aria-hidden="true"
				style={{ color: props.accent() }}
				innerHTML={icons.palette(16)}
			/>
			<span class="ts-customize-label" id="ts-customize-label">
				{props.label()}
			</span>
			<svg
				class="ts-customize-chev"
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<polyline points="6 9 12 15 18 9" />
			</svg>
		</button>
	);
}

interface MenuProps {
	themes: readonly Theme[];
	particles: readonly ParticleStyleInfo[];
	themeIndex: () => number;
	particleIndex: () => number;
	borderIndex: () => number;
	particleColorCss: () => string | null;
	borderColorCss: () => string | null;
	chordOn: () => boolean;
	threshold: () => number;
	keyboardColorMode: () => 'note' | 'border';
	isOpen: () => boolean;
	isSheet: () => boolean;
	hasVideo: () => boolean;
	hasAudio: () => boolean;
	hasImage: () => boolean;
	hasLyrics: () => boolean;
	frontTrim: () => number;
	backTrim: () => number;
	imageScale: () => number;
	imageOffsetX: () => number;
	overlayOpacity: () => number;
	videoOpacity: () => number;
	videoDuration: () => number;
	volume: () => number;
	mediaVolume: () => number;
	playbackRate: () => number;
	onVolumeChange: (volume: number) => void;
	onMediaVolumeChange: (volume: number) => void;
	onPlaybackRateChange: (rate: number) => void;
	onSelectTheme: (i: number) => void;
	onSelectParticle: (i: number) => void;
	onSelectBorderStyle: (i: number) => void;
	onOpenParticleColor: () => void;
	onOpenBorderColor: () => void;
	onOpenCustomThemeColor: () => void;
	onToggleChord: () => void;
	onSelectThreshold: (value: number) => void;
	onSelectLocale: (code: LocaleCode) => void;
	onKeyboardColorModeChange?: (mode: 'note' | 'border') => void;
	onVideoImport: () => void;
	onVideoTrimChange: (frontTrim: number, backTrim: number) => void;
	onOverlayOpacityChange: (opacity: number) => void;
	onVideoOpacityChange: (opacity: number) => void;
	onVideoTrimApply: (startTime: number, endTime: number) => void;
	onVideoTrimCancel: () => void;
	onLyricsImport?: () => void;
	onLyricsClear?: () => void;
	onImageScaleChange?: (scale: number) => void;
	onImageOffsetChange?: (offsetX: number) => void;
	// 鈹€鈹€ Waterfall background painting 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
	backgroundModeIndex: () => number;
	backgroundSolidColorCss: () => string;
	backgroundGlowColorCss: () => string;
	backgroundGlowIntensity: () => number;
	backgroundOpacity: () => number;
	backgroundDrift: () => number;
	onSelectBackgroundMode: (i: number) => void;
	onOpenBackgroundSolidColor: () => void;
	onOpenBackgroundGlowColor: () => void;
	onBackgroundGlowIntensityChange: (v: number) => void;
	onBackgroundOpacityChange: (v: number) => void;
	onBackgroundDriftChange: (v: number) => void;
	registerEl: (el: HTMLElement) => void;
}

function MenuView(props: MenuProps) {
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	return (
		<div
			ref={(el) => props.registerEl(el)}
			class="ts-popover ts-customize-menu"
			classList={{
				"ts-popover--open": props.isOpen(),
				"popover--sheet": props.isSheet(),
			}}
		>
			<div class="panel-header">
				<span class="panel-label">{t("customize.title")}</span>
			</div>

			<div class="ts-customize-body">
				<div class="customize-section">
					<div class="customize-section-head">
						<span class="customize-section-label">{t("customize.background")}</span>
					</div>
					<div class="customize-particle-row customize-background-mode-row">
						<For each={BACKGROUND_MODES}>
							{(bm, i) => (
								<button
									class="customize-particle-chip customize-background-mode-chip"
									classList={{
										"customize-particle-chip--on":
											props.backgroundModeIndex() === i(),
									}}
									type="button"
									title={t(bm.key)}
									aria-label={t(bm.key)}
									onClick={() => props.onSelectBackgroundMode(i())}
								>
									<span class="customize-background-mode-glyph" aria-hidden="true">
										<span
											class="customize-background-mode-swatch"
											style={{
												background:
													bm.id === "theme" || bm.id === "themeGlow" || bm.id === "gradient" || bm.id === "grid" || bm.id === "dots"
														? "var(--panel-bg, #12141c)"
														: props.backgroundSolidColorCss(),
											}}
										/>
									</span>
									<span class="customize-particle-chip-label">{t(bm.key)}</span>
								</button>
							)}
						</For>
					</div>
					{(props.backgroundModeIndex() === 1) && (
						<div class="customize-opacity-row">
							<span class="customize-opacity-row-label">{t("customize.background.solidColor")}</span>
							<button
								class="customize-color-swatch customize-bg-color-swatch"
								type="button"
								title={t("customize.background.solidColor")}
								aria-label={t("customize.background.solidColor")}
								style={{ background: props.backgroundSolidColorCss() }}
								onClick={() => props.onOpenBackgroundSolidColor()}
							/>
						</div>
					)}
					{(props.backgroundModeIndex() === 5) && (
						<div class="customize-opacity-row">
							<span class="customize-opacity-row-label">{t("customize.background.glowColor")}</span>
							<button
								class="customize-color-swatch customize-bg-color-swatch"
								type="button"
								title={t("customize.background.glowColor")}
								aria-label={t("customize.background.glowColor")}
								style={{ background: props.backgroundGlowColorCss() }}
								onClick={() => props.onOpenBackgroundGlowColor()}
							/>
						</div>
					)}
					{(props.backgroundModeIndex() === 4 || props.backgroundModeIndex() === 5 || props.backgroundModeIndex() === 6) && (
						<div class="customize-opacity-row">
							<span class="customize-opacity-row-label">{t("customize.background.glowIntensity")}</span>
							<input
								type="range"
								class="customize-media-slider"
								min="0"
								max="1"
								step="0.01"
								value={props.backgroundGlowIntensity()}
								style={{ "--pct": `${props.backgroundGlowIntensity() * 100}%` }}
								onInput={(e) => props.onBackgroundGlowIntensityChange(parseFloat(e.currentTarget.value))}
							/>
						</div>
					)}
					<div class="customize-opacity-row">
						<span class="customize-opacity-row-label">{t("customize.background.opacity")}</span>
						<input
							type="range"
							class="customize-media-slider"
							min="0.05"
							max="1"
							step="0.01"
							value={props.backgroundOpacity()}
							style={{ "--pct": `${((props.backgroundOpacity() - 0.05) / 0.95) * 100}%` }}
							onInput={(e) => props.onBackgroundOpacityChange(parseFloat(e.currentTarget.value))}
						/>
					</div>
					<div class="customize-opacity-row">
						<span class="customize-opacity-row-label">{t("customize.background.drift")}</span>
						<input
							type="range"
							class="customize-media-slider"
							min="0"
							max="1"
							step="0.01"
							value={props.backgroundDrift()}
							style={{ "--pct": `${props.backgroundDrift() * 100}%` }}
							onInput={(e) => props.onBackgroundDriftChange(parseFloat(e.currentTarget.value))}
						/>
					</div>
				</div>

				<div class="customize-section">
					<div class="customize-section-head">
						<span class="customize-section-label">{t("customize.theme")}</span>
					</div>
					<div class="customize-theme-grid">
						<button
							class="customize-theme-tile customize-theme-tile--custom"
							classList={{
								"customize-theme-tile--on":
									props.themeIndex() >= props.themes.length,
							}}
							type="button"
							title={t("customize.theme.custom")}
							aria-label={`${t("customize.theme.custom")} theme`}
							onClick={() => props.onOpenCustomThemeColor()}
						>
							<span class="customize-theme-tile-dot customize-theme-tile-dot--custom">
								<svg
									width="10"
									height="10"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<circle cx="12" cy="12" r="10" />
									<path d="M12 8v8" />
									<path d="M8 12h8" />
								</svg>
							</span>
							<span class="customize-theme-tile-label">
								{t("customize.theme.custom")}
							</span>
						</button>
						<For each={props.themes}>
							{(theme, i) => (
								<button
									class="customize-theme-tile"
									classList={{
										"customize-theme-tile--on": props.themeIndex() === i(),
									}}
									type="button"
									title={theme.name}
									aria-label={`${theme.name} theme`}
									onClick={() => props.onSelectTheme(i())}
								>
									<span
										class="customize-theme-tile-dot"
										style={{ background: theme.uiAccentCSS }}
									/>
									<span class="customize-theme-tile-label">{theme.name}</span>
								</button>
							)}
						</For>
					</div>
				</div>

				<div class="customize-section">
					<div class="customize-section-head">
						<span class="customize-section-label">
							{t("customize.particles")}
						</span>
					</div>
					<div class="customize-particle-row">
						<button
							class="customize-color-swatch"
							classList={{
								"customize-color-swatch--off":
									props.particleColorCss() === null,
							}}
							type="button"
							title={t("customize.particleColor")}
							aria-label={t("customize.particleColor")}
							style={{ background: props.particleColorCss() ?? "transparent" }}
							onClick={() => props.onOpenParticleColor()}
						/>
						<For each={props.particles}>
							{(p, i) => (
								<button
									class="customize-particle-chip"
									classList={{
										"customize-particle-chip--on":
											props.particleIndex() === i(),
									}}
									type="button"
									title={p.name}
									aria-label={`${p.name} particles`}
									onClick={() => props.onSelectParticle(i())}
								>
									<span
										class="customize-particle-chip-glyph"
										data-style={p.id}
										aria-hidden="true"
										innerHTML={
											PARTICLE_GLYPHS[p.id] ?? PARTICLE_GLYPHS["sparks"] ?? ""
										}
									/>
									<span class="customize-particle-chip-label">{p.name}</span>
								</button>
							)}
						</For>
					</div>
				</div>

				<div class="customize-section">
					<div class="customize-section-head">
						<span class="customize-section-label">{t("customize.border")}</span>
					</div>
					<div class="customize-particle-row">
						<button
							class="customize-color-swatch"
							classList={{
								"customize-color-swatch--off": props.borderColorCss() === null,
							}}
							type="button"
							title={t("customize.borderColor")}
							aria-label={t("customize.borderColor")}
							style={{ background: props.borderColorCss() ?? "transparent" }}
							onClick={() => props.onOpenBorderColor()}
						/>
						<For each={BORDER_STYLE_IDS}>
							{(bs, i) => (
								<button
									class="customize-particle-chip"
									classList={{
										"customize-particle-chip--on": props.borderIndex() === i(),
									}}
									type="button"
									title={t(`customize.border.${bs}`)}
									aria-label={t(`customize.border.${bs}`)}
									onClick={() => props.onSelectBorderStyle(i())}
								>
									<span class="customize-particle-chip-label">
										{t(`customize.border.${bs}`)}
									</span>
								</button>
							)}
						</For>
					</div>
				</div>

				<div class="customize-section">
					<div class="customize-section-head">
						<span class="customize-section-label">
							{t("customize.language")}
						</span>
					</div>
					<div class="customize-locale-row">
						<For each={LOCALES}>
							{(l) => (
								<button
									class="customize-locale-chip"
									classList={{
										"customize-locale-chip--on": l.code === locale.value,
									}}
									type="button"
									data-locale={l.code}
									aria-label={l.nativeName}
									onClick={() => props.onSelectLocale(l.code)}
								>
									<span class="customize-locale-chip-label">
										{l.nativeName}
									</span>
								</button>
							)}
						</For>
					</div>
				</div>

				<div class="customize-section customize-section--toggle">
					<button
						class="customize-toggle"
						classList={{ "customize-toggle--on": props.chordOn() }}
						type="button"
						aria-pressed={props.chordOn() ? "true" : "false"}
						onClick={() => props.onToggleChord()}
					>
						<span class="customize-toggle-body">
							<span class="customize-toggle-name">{t("customize.chord")}</span>
							<span class="customize-toggle-sub">
								{t("customize.chord.sub")}
							</span>
						</span>
						<span class="customize-toggle-switch" aria-hidden="true">
							<span class="customize-toggle-knob"></span>
						</span>
					</button>
				</div>

				<div class="customize-section customize-section--advanced">
					<button
						class="customize-advanced-head"
						type="button"
						aria-expanded={advancedOpen() ? "true" : "false"}
						onClick={() => setAdvancedOpen((o) => !o)}
					>
						<span
							class="customize-advanced-chevron"
							classList={{ "customize-advanced-chevron--open": advancedOpen() }}
							aria-hidden="true"
							innerHTML={icons.chevronDown(12)}
						/>
						<span class="customize-advanced-title">
							{t("customize.advanced")}
						</span>
						<span class="customize-advanced-sub">
							{t("customize.velocityThreshold.sub")}
						</span>
					</button>
				</div>
				{advancedOpen() && (
					<div class="customize-section customize-section--advanced-body">
						<div class="customize-stepper">
							<button
								class="customize-stepper-btn"
								type="button"
								aria-label={t("customize.velocityThreshold.dec")}
								data-tip={t("customize.velocityThreshold.dec")}
								onClick={() =>
									props.onSelectThreshold(Math.max(-100, props.threshold() - 5))
								}
							>
								<span aria-hidden="true">-</span>
							</button>
							<span
								class="customize-stepper-value"
								data-tip={t("customize.velocityThreshold.tip")}
							>
								{props.threshold() > 0 ? "+" : ""}
								{props.threshold()}
							</span>
							<button
								class="customize-stepper-btn"
								type="button"
								aria-label={t("customize.velocityThreshold.inc")}
								data-tip={t("customize.velocityThreshold.inc")}
								onClick={() =>
									props.onSelectThreshold(Math.min(100, props.threshold() + 5))
								}
							>
								<span aria-hidden="true">+</span>
							</button>
						</div>
						<p class="customize-advanced-hint">
							{t("customize.velocityThreshold.hint")}
						</p>
						<div class="customize-row">
							<button
								class="customize-btn customize-btn--accent"
								type="button"
								onClick={() => props.onKeyboardColorModeChange?.(props.keyboardColorMode() === "note" ? "border" : "note")}
							>
								{t("customize.keyboardColorMode")}: {t(props.keyboardColorMode() === "note" ? "customize.keyboardColorMode.note" : "customize.keyboardColorMode.border")}
							</button>
						</div>
					</div>
				)}

				{/* Background media: import image/video/animation + subtitles,
				    then tune scale/offset/opacity/trim for the imported layer */}
				<div class="customize-section">
					<div class="customize-section-head">
						<span class="customize-section-label">{t("customize.background.media")}</span>
					</div>
					<div class="customize-video-section">
							<div class="customize-media-actions">
							<button
								class="customize-video-import-btn"
								type="button"
								onClick={() => props.onVideoImport()}
							>
							{t("customize.video.import")}
							</button>
							<button
								class="customize-video-import-btn"
								type="button"
								onClick={() => props.onLyricsImport?.()}
							>
							{t("customize.lyrics.import")}
							</button>
							</div>

							{/* Lyrics loaded status + clear */}
							{props.hasLyrics() && (
								<div class="customize-lyrics-row">
									<span class="customize-lyrics-badge">{t("customize.lyrics.loaded")}</span>
									<button
										class="customize-lyrics-clear"
										type="button"
										onClick={() => props.onLyricsClear?.()}
									>
										{t("customize.lyrics.clear")}
									</button>
								</div>
							)}

							{/* Image background controls - only when an image is imported */}
							{props.hasImage() && (
								<>
									<div class="customize-opacity-row">
										<span class="customize-opacity-row-label">{t("customize.image.scale")}</span>
										<input
											type="range"
											class="customize-media-slider"
											min="0.1"
											max="3"
											step="0.05"
											value={props.imageScale()}
											style={{ '--pct': `${((props.imageScale() - 0.1) / 2.9) * 100}%` }}
											onInput={(e) => props.onImageScaleChange?.(parseFloat(e.currentTarget.value))}
										/>
									</div>
									<div class="customize-opacity-row">
										<span class="customize-opacity-row-label">{t("customize.image.offsetX")}</span>
										<input
											type="range"
											class="customize-media-slider"
											min="-1"
											max="1"
											step="0.01"
											value={props.imageOffsetX()}
											style={{ '--pct': `${((props.imageOffsetX() + 1) / 2) * 100}%` }}
											onInput={(e) => props.onImageOffsetChange?.(parseFloat(e.currentTarget.value))}
										/>
									</div>
								</>
							)}

							{/* Media controls - only when media imported */}
							{(props.hasVideo() || props.hasAudio()) && (
							<div class="customize-media-row">
								<span class="customize-media-row-label">{t("customize.video.waterfall")}</span>
								<span class="customize-media-row-icon" innerHTML={icons.volume(12)} />
								<input
									type="range"
									class="customize-media-slider"
									min="0"
									max="1"
									step="0.01"
									value={props.volume()}
									style={{ '--pct': `${props.volume() * 100}%` }}
									onInput={(e) => {
										const v = parseFloat(e.currentTarget.value);
										e.currentTarget.style.setProperty('--pct', `${v * 100}%`);
										const bubble = e.currentTarget.parentElement?.querySelector('.customize-media-bubble') as HTMLElement;
										if (bubble) { bubble.textContent = Math.round(v * 100) + '%'; bubble.style.opacity = '1'; }
										props.onVolumeChange(v);
									}}
									onPointerUp={(e) => {
										const bubble = e.currentTarget.parentElement?.querySelector('.customize-media-bubble') as HTMLElement;
										if (bubble) bubble.style.opacity = '0';
									}}
									onPointerLeave={(e) => {
										const bubble = e.currentTarget.parentElement?.querySelector('.customize-media-bubble') as HTMLElement;
										if (bubble) bubble.style.opacity = '0';
									}}
								/>
								<span class="customize-media-bubble">{Math.round(props.volume() * 100)}%</span>
								<span class="customize-media-row-speed">{props.playbackRate().toFixed(1)}x</span>
								<input
									type="range"
									class="customize-media-slider"
									min="0.25"
									max="2"
									step="0.05"
									value={props.playbackRate()}
									style={{ '--pct': `${((props.playbackRate() - 0.25) / 1.75) * 100}%` }}
									onInput={(e) => {
										const v = parseFloat(e.currentTarget.value);
										e.currentTarget.style.setProperty('--pct', `${((v - 0.25) / 1.75) * 100}%`);
										const speedLabel = e.currentTarget.parentElement?.querySelector('.customize-media-row-speed') as HTMLElement;
										if (speedLabel) speedLabel.textContent = v.toFixed(1) + 'x';
										props.onPlaybackRateChange(v);
									}}
								/>
							</div>
							)}

							{/* 锟劫诧拷锟斤拷透锟斤拷锟斤拷 - always visible */}
							<div class="customize-opacity-row">
								<span class="customize-opacity-row-label">{t("customize.video.overlayOpacity")}</span>
								<input
									type="range"
									class="customize-media-slider"
									min="0"
									max="1"
									step="0.01"
									value={props.overlayOpacity()}
									style={{ '--pct': `${props.overlayOpacity() * 100}%` }}
									onInput={(e) => props.onOverlayOpacityChange(parseFloat(e.currentTarget.value))}
								/>
							</div>

							{/* 锟斤拷锟斤拷频 controls - only when video/audio imported */}
							{(props.hasVideo() || props.hasAudio()) && (
								<>
									<div class="customize-media-row">
										<span class="customize-media-row-label">{t("customize.video.mediaLabel")}</span>
										<span class="customize-media-row-icon" innerHTML={icons.volume(12)} />
										<input
											type="range"
											class="customize-media-slider"
											min="0"
											max="1"
											step="0.01"
											value={props.mediaVolume()}
											style={{ '--pct': `${props.mediaVolume() * 100}%` }}
											onInput={(e) => {
												const v = parseFloat(e.currentTarget.value);
												e.currentTarget.style.setProperty('--pct', `${v * 100}%`);
												const bubble = e.currentTarget.parentElement?.querySelector('.customize-media-bubble') as HTMLElement;
												if (bubble) { bubble.textContent = Math.round(v * 100) + '%'; bubble.style.opacity = '1'; }
												props.onMediaVolumeChange(v);
											}}
											onPointerUp={(e) => {
												const bubble = e.currentTarget.parentElement?.querySelector('.customize-media-bubble') as HTMLElement;
												if (bubble) bubble.style.opacity = '0';
											}}
											onPointerLeave={(e) => {
												const bubble = e.currentTarget.parentElement?.querySelector('.customize-media-bubble') as HTMLElement;
												if (bubble) bubble.style.opacity = '0';
											}}
										/>
										<span class="customize-media-bubble">{Math.round(props.mediaVolume() * 100)}%</span>
										<span class="customize-media-row-speed">{props.playbackRate().toFixed(1)}x</span>
										<input
											type="range"
											class="customize-media-slider"
											min="0.25"
											max="2"
											step="0.05"
											value={props.playbackRate()}
											style={{ '--pct': `${((props.playbackRate() - 0.25) / 1.75) * 100}%` }}
											onInput={(e) => {
												const v = parseFloat(e.currentTarget.value);
												e.currentTarget.style.setProperty('--pct', `${((v - 0.25) / 1.75) * 100}%`);
												const speedLabel = e.currentTarget.parentElement?.querySelector('.customize-media-row-speed') as HTMLElement;
												if (speedLabel) speedLabel.textContent = v.toFixed(1) + 'x';
												props.onPlaybackRateChange(v);
											}}
										/>
									</div>

									{/* 锟斤拷频锟斤拷透锟斤拷锟斤拷 - only when video imported */}
									{props.hasVideo() && (
										<div class="customize-opacity-row">
											<span class="customize-opacity-row-label">{t("customize.video.videoOpacity")}</span>
											<input
												type="range"
												class="customize-media-slider"
												min="0"
												max="1"
												step="0.01"
												value={props.videoOpacity()}
												style={{ '--pct': `${props.videoOpacity() * 100}%` }}
												onInput={(e) => props.onVideoOpacityChange(parseFloat(e.currentTarget.value))}
											/>
										</div>
									)}

									{/* 锟矫硷拷 controls - only when video imported */}
									{props.hasVideo() && (
										<div class="customize-trim-section">
											<div class="customize-trim-row">
												<span class="customize-trim-label">{t("customize.video.frontTrim")}</span>
												<input
													type="number"
													class="customize-trim-input"
													step="0.1"
													min="0"
													value={props.frontTrim()}
													onInput={(e) => props.onVideoTrimChange(parseFloat(e.currentTarget.value) || 0, props.backTrim())}
												/>
												<button class="customize-trim-arrow customize-trim-arrow--left" type="button"
													onClick={() => props.onVideoTrimChange(Math.max(0, props.frontTrim() - 0.1), props.backTrim())}
													aria-label="Decrease front trim"
												>
													<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
												</button>
												<button class="customize-trim-arrow customize-trim-arrow--right" type="button"
													onClick={() => props.onVideoTrimChange(props.frontTrim() + 0.1, props.backTrim())}
													aria-label="Increase front trim"
												>
													<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
												</button>
											</div>
											<div class="customize-trim-row">
												<span class="customize-trim-label">{t("customize.video.backTrim")}</span>
												<input
													type="number"
													class="customize-trim-input"
													step="0.1"
													min="0"
													value={props.backTrim()}
													onInput={(e) => props.onVideoTrimChange(props.frontTrim(), parseFloat(e.currentTarget.value) || 0)}
												/>
												<button class="customize-trim-arrow customize-trim-arrow--left" type="button"
													onClick={() => props.onVideoTrimChange(props.frontTrim(), Math.max(0, props.backTrim() - 0.1))}
													aria-label="Decrease back trim"
												>
													<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
												</button>
												<button class="customize-trim-arrow customize-trim-arrow--right" type="button"
													onClick={() => props.onVideoTrimChange(props.frontTrim(), props.backTrim() + 0.1)}
													aria-label="Increase back trim"
												>
													<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
												</button>
											</div>
											<div class="customize-video-trim-actions">
												<button
													class="customize-video-trim-btn customize-video-trim-btn--cancel"
													type="button"
													onClick={() => props.onVideoTrimCancel()}
												>
													{t("customize.video.cancel")}
												</button>
												<button
													class="customize-video-trim-btn customize-video-trim-btn--apply"
													type="button"
													onClick={() => props.onVideoTrimApply(props.frontTrim(), props.videoDuration() - props.backTrim())}
												>
													{t("customize.video.apply")}
												</button>
											</div>
										</div>
										)}
									</>
								)}
							</div>
			</div>
		</div>
		</div>
	);
}
export class CustomizeMenu {
	readonly trigger: HTMLButtonElement;
	private menu!: HTMLElement;
	private isOpen = false;
	private disposeTrigger: (() => void) | null = null;
	private disposeMenu: (() => void) | null = null;
	private menuWrapper: HTMLDivElement | null = null;

	private readonly setThemeIdx: (v: number) => void;
	private readonly themeIdxFn: () => number;
	private readonly setParticleIdx: (v: number) => void;
	private readonly particleIdxFn: () => number;
	private readonly setBorderIdx: (v: number) => void;
	private readonly borderIdxFn: () => number;
	private readonly particleColorSetter: (v: string | null) => void;
	private readonly particleColorFn: () => string | null;
	private readonly borderColorSetter: (v: string | null) => void;
	private readonly borderColorFn: () => string | null;
	private readonly setChordOn: (v: boolean) => void;
	private readonly chordOnFn: () => boolean;
	private readonly setIsOpen: (v: boolean) => void;
	private readonly setIsSheet: (v: boolean) => void;
	private readonly setLabel: (v: string) => void;
	private readonly setAccent: (v: string) => void;
	private readonly setThresholdIdx: (v: number) => void;
	private readonly thresholdFn: () => number;
	private readonly setKeyboardColorModeIdx: (v: 'note' | 'border') => void;
	private readonly keyboardColorModeFn: () => 'note' | 'border';

	private hasVideoFn: Accessor<boolean> = () => false;
	private setHasVideoFn: ((v: boolean) => void) | null = null;
	private hasAudioFn: Accessor<boolean> = () => false;
	private setHasAudioFn: ((v: boolean) => void) | null = null;
	private hasImageFn: Accessor<boolean> = () => false;
	private setHasImageFn: ((v: boolean) => void) | null = null;
	private hasLyricsFn: Accessor<boolean> = () => false;
	private setHasLyricsFn: ((v: boolean) => void) | null = null;
	private frontTrimFn: Accessor<number> = () => 0;
	private setFrontTrimFn: ((v: number) => void) | null = null;
	private backTrimFn: Accessor<number> = () => 0;
	private setBackTrimFn: ((v: number) => void) | null = null;
	private imageScaleFn: Accessor<number> = () => 1;
	private setImageScaleFn: ((v: number) => void) | null = null;
	private imageOffsetXFn: Accessor<number> = () => 0;
	private setImageOffsetXFn: ((v: number) => void) | null = null;
	private overlayOpacityFn: Accessor<number> = () => 1;
	private setOverlayOpacityFn: ((v: number) => void) | null = null;
	private videoOpacityFn: Accessor<number> = () => 1;
	private setVideoOpacityFn: ((v: number) => void) | null = null;
	private videoDurationFn: Accessor<number> = () => 0;
	private setVideoDurationFn: ((v: number) => void) | null = null;
	private volumeFn: Accessor<number> = () => 1;
	private setVolumeFn: ((v: number) => void) | null = null;
	private mediaVolumeFn: Accessor<number> = () => 1;
	private setMediaVolumeFn: ((v: number) => void) | null = null;
	private playbackRateFn: Accessor<number> = () => 1;
	private setPlaybackRateFn: ((v: number) => void) | null = null;
	private backgroundModeIdxFn: Accessor<number> = () => 0;
	private setBackgroundModeIdxFn: ((v: number) => void) | null = null;
	private backgroundSolidColorCssFn: Accessor<string> = () => "#0b0e14";
	private setBackgroundSolidColorCssFn: ((v: string) => void) | null = null;
	private backgroundGlowColorCssFn: Accessor<string> = () => "#3b82f6";
	private setBackgroundGlowColorCssFn: ((v: string) => void) | null = null;
	private backgroundGlowIntensityFn: Accessor<number> = () => 0.5;
	private setBackgroundGlowIntensityFn: ((v: number) => void) | null = null;
	private backgroundOpacityFn: Accessor<number> = () => 1;
	private setBackgroundOpacityFn: ((v: number) => void) | null = null;
	private backgroundDriftFn: Accessor<number> = () => 0;
	private setBackgroundDriftFn: ((v: number) => void) | null = null;

	private onDocPointer = (e: PointerEvent): void => {
		const target = e.target as Node;
		if (this.menu.contains(target)) return;
		if (this.trigger.contains(target)) return;
		this.close();
	};
	private onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && this.isOpen) this.close();
	};
	private onResize = (): void => {
		if (!this.isOpen) return;
		if (this.menu.classList.contains("popover--sheet") || isNarrowViewport()) {
			this.close();
			return;
		}
		this.positionUnder();
	};

	constructor(
		triggerHost: HTMLElement,
		popoverHost: HTMLElement,
		private themes: readonly Theme[],
		particles: readonly ParticleStyleInfo[],
		private callbacks: CustomizeMenuCallbacks,
	) {
		const [themeIdx, setThemeIdx] = createSignal(0);
		const [particleIdx, setParticleIdx] = createSignal(0);
		const [borderIdx, setBorderIdx] = createSignal(0);
		const [particleColor, setParticleColor] = createSignal<string | null>(null);
		const [borderColor, setBorderColor] = createSignal<string | null>(null);
		const [chordOn, setChordOn] = createSignal(false);
		const [threshold, setThresholdIdx] = createSignal(0);
		const [keyboardColorMode, setKeyboardColorModeIdx] = createSignal<'note' | 'border'>('note');
		const [isOpen, setIsOpen] = createSignal(false);
		const [isSheet, setIsSheet] = createSignal(false);
		const [label, setLabel] = createSignal(t("customize.theme"));
		const [accent, setAccent] = createSignal("var(--accent)");

		this.themeIdxFn = themeIdx;
		this.setThemeIdx = setThemeIdx;
		this.particleIdxFn = particleIdx;
		this.setParticleIdx = setParticleIdx;
		this.borderIdxFn = borderIdx;
		this.setBorderIdx = setBorderIdx;
		this.particleColorFn = particleColor;
		this.particleColorSetter = setParticleColor;
		this.borderColorFn = borderColor;
		this.borderColorSetter = setBorderColor;
		this.chordOnFn = chordOn;
		this.setChordOn = setChordOn;
		this.thresholdFn = threshold;
		this.setThresholdIdx = setThresholdIdx;
		this.setIsOpen = setIsOpen;
		this.keyboardColorModeFn = keyboardColorMode;
		this.setKeyboardColorModeIdx = setKeyboardColorModeIdx;
		this.setIsSheet = setIsSheet;
		this.setLabel = setLabel;
		this.setAccent = setAccent;

		const [hasVideo, setHasVideo] = createSignal(false);
		const [hasAudio, setHasAudio] = createSignal(false);
		const [hasImage, setHasImage] = createSignal(false);
		const [hasLyrics, setHasLyrics] = createSignal(false);
		const [frontTrim, setFrontTrim] = createSignal(0);
		const [backTrim, setBackTrim] = createSignal(0);
		const [imageScale, setImageScale] = createSignal(1);
		const [imageOffsetX, setImageOffsetX] = createSignal(0);
		const [overlayOpacity, setOverlayOpacity] = createSignal(1);
		const [videoOpacity, setVideoOpacity] = createSignal(1);
		const [videoDuration, setVideoDuration] = createSignal(0);
		const [volume, setVolume] = createSignal(1);
		const [mediaVolume, setMediaVolume] = createSignal(1);
		const [playbackRate, setPlaybackRate] = createSignal(1);
		this.hasVideoFn = hasVideo; this.setHasVideoFn = setHasVideo;
		this.hasAudioFn = hasAudio; this.setHasAudioFn = setHasAudio;
		this.hasImageFn = hasImage; this.setHasImageFn = setHasImage;
		this.hasLyricsFn = hasLyrics; this.setHasLyricsFn = setHasLyrics;
		this.frontTrimFn = frontTrim; this.setFrontTrimFn = setFrontTrim;
		this.backTrimFn = backTrim; this.setBackTrimFn = setBackTrim;
		this.imageScaleFn = imageScale; this.setImageScaleFn = setImageScale;
		this.imageOffsetXFn = imageOffsetX; this.setImageOffsetXFn = setImageOffsetX;
		this.overlayOpacityFn = overlayOpacity; this.setOverlayOpacityFn = setOverlayOpacity;
		this.videoOpacityFn = videoOpacity; this.setVideoOpacityFn = setVideoOpacity;
		this.videoDurationFn = videoDuration; this.setVideoDurationFn = setVideoDuration;
		this.volumeFn = volume; this.setVolumeFn = setVolume;
		this.mediaVolumeFn = mediaVolume; this.setMediaVolumeFn = setMediaVolume;
		this.playbackRateFn = playbackRate; this.setPlaybackRateFn = setPlaybackRate;

		const [backgroundModeIdx, setBackgroundModeIdx] = createSignal(0);
		const [backgroundSolidColorCss, setBackgroundSolidColorCss] = createSignal("#0b0e14");
		const [backgroundGlowColorCss, setBackgroundGlowColorCss] = createSignal("#3b82f6");
		const [backgroundGlowIntensity, setBackgroundGlowIntensity] = createSignal(0.5);
		const [backgroundOpacity, setBackgroundOpacity] = createSignal(1);
		const [backgroundDrift, setBackgroundDrift] = createSignal(0);
		this.backgroundModeIdxFn = backgroundModeIdx; this.setBackgroundModeIdxFn = setBackgroundModeIdx;
		this.backgroundSolidColorCssFn = backgroundSolidColorCss; this.setBackgroundSolidColorCssFn = setBackgroundSolidColorCss;
		this.backgroundGlowColorCssFn = backgroundGlowColorCss; this.setBackgroundGlowColorCssFn = setBackgroundGlowColorCss;
		this.backgroundGlowIntensityFn = backgroundGlowIntensity; this.setBackgroundGlowIntensityFn = setBackgroundGlowIntensity;
		this.backgroundOpacityFn = backgroundOpacity; this.setBackgroundOpacityFn = setBackgroundOpacity;
		this.backgroundDriftFn = backgroundDrift; this.setBackgroundDriftFn = setBackgroundDrift;

		// Trigger: render into its own wrapper so the host gets exactly our pill
		// and nothing else. We capture the button ref so existing callers can
		// continue treating `.trigger` as a real DOM node.
		const triggerWrapper = document.createElement("div");
		triggerWrapper.style.display = "contents";
		triggerHost.appendChild(triggerWrapper);
		let triggerEl!: HTMLButtonElement;
		this.disposeTrigger = render(
			() => (
				<TriggerView
					label={label}
					accent={accent}
					isOpen={isOpen}
					onToggle={() => this.toggle()}
					registerEl={(el) => {
						triggerEl = el;
					}}
				/>
			),
			triggerWrapper,
		);
		this.trigger = triggerEl;

		const menuWrapper = document.createElement("div");
		popoverHost.appendChild(menuWrapper);
		this.menuWrapper = menuWrapper;
		this.disposeMenu = render(
			() => (
				<MenuView
					themes={themes}
					particles={particles}
					themeIndex={themeIdx}
					particleIndex={particleIdx}
					borderIndex={borderIdx}
					keyboardColorMode={keyboardColorMode}
					particleColorCss={particleColor}
					borderColorCss={borderColor}
					chordOn={chordOn}
					threshold={threshold}
					isOpen={isOpen}
					isSheet={isSheet}
					hasVideo={this.hasVideoFn}
					hasAudio={this.hasAudioFn}
					hasImage={this.hasImageFn}
					hasLyrics={this.hasLyricsFn}
					frontTrim={this.frontTrimFn}
					backTrim={this.backTrimFn}
					imageScale={this.imageScaleFn}
					imageOffsetX={this.imageOffsetXFn}
					overlayOpacity={this.overlayOpacityFn}
					videoOpacity={this.videoOpacityFn}
					videoDuration={this.videoDurationFn}
					volume={this.volumeFn}
					mediaVolume={this.mediaVolumeFn}
					playbackRate={this.playbackRateFn}
					onVolumeChange={(v) => { this.setVolumeFn?.(v); this.callbacks.onVolumeChange?.(v) }}
					onMediaVolumeChange={(v) => { this.setMediaVolumeFn?.(v); this.callbacks.onMediaVolumeChange?.(v) }}
					onPlaybackRateChange={(v) => { this.setPlaybackRateFn?.(v); this.callbacks.onPlaybackRateChange?.(v) }}
					onSelectTheme={(i) => callbacks.onSelectTheme(i)}
					onSelectParticle={(i) => callbacks.onSelectParticle(i)}
					onSelectBorderStyle={(i) => callbacks.onSelectBorderStyle(i)}
					onKeyboardColorModeChange={(mode) => callbacks.onKeyboardColorModeChange?.(mode)}
					onOpenParticleColor={() => callbacks.onOpenParticleColor()}
					onOpenBorderColor={() => callbacks.onOpenBorderColor()}
					onOpenCustomThemeColor={() => callbacks.onOpenCustomThemeColor()}
					onToggleChord={() => callbacks.onToggleChord()}
					onSelectThreshold={(v) => callbacks.onSelectThreshold(v)}
					onSelectLocale={(code) => callbacks.onSelectLocale(code)}
					onVideoImport={() => callbacks.onVideoImport?.()}
					onLyricsImport={() => callbacks.onLyricsImport?.()}
					onLyricsClear={() => callbacks.onLyricsClear?.()}
					onImageScaleChange={(s) => { this.setImageScaleFn?.(s); callbacks.onImageScaleChange?.(s) }}
					onImageOffsetChange={(o) => { this.setImageOffsetXFn?.(o); callbacks.onImageOffsetChange?.(o) }}
					onVideoTrimChange={(f, b) => {
						// Update the internal signals FIRST 鈥?app.ts never registers an
						// onVideoTrimChange callback, so without this the typed values
						// never reach the signals and "Apply" always re-exports with
						// startTime=0 (trim silently no-ops).
						this.setFrontTrimFn?.(f);
						this.setBackTrimFn?.(b);
						callbacks.onVideoTrimChange?.(f, b);
					}}
					onOverlayOpacityChange={(v) => { this.setOverlayOpacityFn?.(v); callbacks.onOverlayOpacityChange?.(v) }}
					onVideoOpacityChange={(v) => { this.setVideoOpacityFn?.(v); callbacks.onVideoOpacityChange?.(v) }}
					onVideoTrimApply={(start, end) => this.callbacks.onVideoTrimApply?.(start, end)}
					onVideoTrimCancel={() => this.callbacks.onVideoTrimCancel?.()}
					backgroundModeIndex={backgroundModeIdx}
					backgroundSolidColorCss={backgroundSolidColorCss}
					backgroundGlowColorCss={backgroundGlowColorCss}
					backgroundGlowIntensity={backgroundGlowIntensity}
					backgroundOpacity={backgroundOpacity}
					backgroundDrift={backgroundDrift}
					onSelectBackgroundMode={(i) => {
						this.setBackgroundModeIdxFn?.(i);
						const mode = BACKGROUND_MODES[i]?.id;
						if (mode) callbacks.onSelectBackgroundMode?.(mode);
					}}
					onOpenBackgroundSolidColor={() => callbacks.onOpenBackgroundSolidColor?.()}
					onOpenBackgroundGlowColor={() => callbacks.onOpenBackgroundGlowColor?.()}
					onBackgroundGlowIntensityChange={(v) => { this.setBackgroundGlowIntensityFn?.(v); callbacks.onBackgroundGlowIntensityChange?.(v) }}
					onBackgroundOpacityChange={(v) => { this.setBackgroundOpacityFn?.(v); callbacks.onBackgroundOpacityChange?.(v) }}
					onBackgroundDriftChange={(v) => { this.setBackgroundDriftFn?.(v); callbacks.onBackgroundDriftChange?.(v) }}
					registerEl={(el) => {
						this.menu = el;
					}}
				/>
			),
			menuWrapper,
		);
	}

	// 锟斤拷锟斤拷 Public state setters (App pushes the active selection in) 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷
	setTheme(index: number): void {
		this.setThemeIdx(index);
		const theme = this.themes[index];
		if (!theme) {
			// Custom theme 锟斤拷 use the label but keep accent from caller
			this.setLabel(t("customize.theme.custom"));
			return;
		}
		// Tint the palette glyph with the active theme accent 锟斤拷 keeps the live
		// "current theme" signal the old colour swatch carried.
		this.setAccent(theme.uiAccentCSS);
		this.setLabel(theme.name);
	}

	setParticle(index: number): void {
		this.setParticleIdx(index);
	}

	setBorderStyle(index: number): void {
		this.setBorderIdx(index);
	}

	setParticleColor(css: string | null): void {
		this.particleColorSetter(css);
	}

	setBorderColor(css: string | null): void {
		this.borderColorSetter(css);
	}

	setChord(on: boolean): void {
		this.setChordOn(on);
	}

	setThreshold(v: number): void {
		this.setThresholdIdx(v);
	}

	setKeyboardColorMode(mode: 'note' | 'border'): void {
		this.setKeyboardColorModeIdx(mode);
	}

	setVideoDuration(duration: number): void {
		this.setVideoDurationFn?.(duration);
	}

	setVolume(volume: number): void {
		this.setVolumeFn?.(volume);
	}

	setPlaybackRate(rate: number): void {
		this.setPlaybackRateFn?.(rate);
	}

	setHasVideo(has: boolean = true): void {
		this.setHasVideoFn?.(has);
	}

	setHasAudio(has: boolean = true): void {
		this.setHasAudioFn?.(has);
	}

	setHasImage(has: boolean = true): void {
		this.setHasImageFn?.(has);
	}

	setHasLyrics(has: boolean = true): void {
		this.setHasLyricsFn?.(has);
	}

	setImageScale(scale: number): void {
		this.setImageScaleFn?.(scale);
	}

	setImageOffsetX(offsetX: number): void {
		this.setImageOffsetXFn?.(offsetX);
	}

	setFrontTrim(v: number): void {
		this.setFrontTrimFn?.(v);
	}

	setBackTrim(v: number): void {
		this.setBackTrimFn?.(v);
	}

	// 锟斤拷锟斤拷 Open / close 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷
	private toggle(): void {
		this.isOpen ? this.close() : this.open();
	}

	private open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		this.setIsOpen(true);
		if (isNarrowViewport()) {
			this.setIsSheet(true);
			this.menu.style.top = "";
			this.menu.style.right = "";
			this.menu.style.left = "";
		} else {
			this.setIsSheet(false);
			this.positionUnder();
		}
		setTimeout(() => {
			document.addEventListener("pointerdown", this.onDocPointer);
			document.addEventListener("keydown", this.onKey);
			window.addEventListener("resize", this.onResize);
		}, 0);
	}

	private close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.setIsOpen(false);
		this.setIsSheet(false);
		document.removeEventListener("pointerdown", this.onDocPointer);
		document.removeEventListener("keydown", this.onKey);
		window.removeEventListener("resize", this.onResize);
	}

	private positionUnder(): void {
		const rect = this.trigger.getBoundingClientRect();
		const menuW = this.menu.offsetWidth || 280;
		const right = Math.max(12, window.innerWidth - rect.right);
		const top = rect.bottom + 8;
		this.menu.style.right = `${right}px`;
		this.menu.style.top = `${top}px`;
		this.menu.style.left = "";
		const desiredLeft = window.innerWidth - right - menuW;
		if (desiredLeft < 12)
			this.menu.style.right = `${Math.max(12, window.innerWidth - menuW - 12)}px`;
	}

	getCurrentTheme(): number {
		return this.themeIdxFn();
	}
	getCurrentParticle(): number {
		return this.particleIdxFn();
	}
	isChordOn(): boolean {
		return this.chordOnFn();
	}
	// 鈹€鈹€ Background state setters (App pushes current values in) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
	setBackgroundModeIndex(index: number): void {
		this.setBackgroundModeIdxFn?.(index);
	}
	setBackgroundSolidColorCss(css: string): void {
		this.setBackgroundSolidColorCssFn?.(css);
	}
	setBackgroundGlowColorCss(css: string): void {
		this.setBackgroundGlowColorCssFn?.(css);
	}
	setBackgroundGlowIntensity(v: number): void {
		this.setBackgroundGlowIntensityFn?.(v);
	}
	setBackgroundOpacity(v: number): void {
		this.setBackgroundOpacityFn?.(v);
	}
	setBackgroundDrift(v: number): void {
		this.setBackgroundDriftFn?.(v);
	}

	dispose(): void {
		this.close();
		this.disposeTrigger?.();
		this.disposeMenu?.();
		this.disposeTrigger = null;
		this.disposeMenu = null;
		this.menuWrapper?.remove();
		this.menuWrapper = null;
	}
}

// Kept for call sites that still import the ParticleStyle type by name.
export type { ParticleStyle };

// Lightweight inline SVGs that hint at each particle style's behaviour.
// All use currentColor so they pick up theme accent on hover / when active.
const PARTICLE_GLYPHS: Record<string, string> = {
	sparks: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/>
    <path d="M5.6 5.6l2.8 2.8"/><path d="M15.6 15.6l2.8 2.8"/>
    <path d="M5.6 18.4l2.8-2.8"/><path d="M15.6 8.4l2.8-2.8"/>
  </svg>`,
	embers: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="17" r="1.6"/>
    <circle cx="13" cy="13" r="2" opacity="0.85"/>
    <circle cx="17" cy="8" r="1.3" opacity="0.7"/>
    <circle cx="10" cy="9" r="1" opacity="0.55"/>
    <circle cx="6" cy="11" r="0.8" opacity="0.45"/>
  </svg>`,
	bloom: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="3" fill="currentColor"/>
    <circle cx="12" cy="12" r="6" opacity="0.6"/>
    <circle cx="12" cy="12" r="9.5" opacity="0.3"/>
  </svg>`,
	sparkle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 4l1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4z"/>
    <path d="M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" opacity="0.7"/>
  </svg>`,
	none: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" opacity="0.5"/>
    <line x1="6" y1="18" x2="18" y2="6" opacity="0.7"/>
  </svg>`,
};
