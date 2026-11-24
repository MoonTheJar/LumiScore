import { Metronome } from "./audio/Metronome";
import { INSTRUMENTS, SynthEngine } from "./audio/SynthEngine";
import { MasterClock } from "./core/clock/MasterClock";
import { type BusNoteEvent, InputBus } from "./core/input/InputBus";
import { lazyHandle } from "./core/lazyHandle";
import { parseMidiFile } from "./core/midi/parser";
import type { MidiFile, MidiTrack } from "./core/midi/types";
import { detectChord } from "./core/music/ChordDetector";
import {
	createLivePerformanceBus,
	type LivePerformanceBus,
} from "./core/performance/LivePerformanceBus";
import {
	booleanPersisted,
	indexPersisted,
	jsonPersisted,
	numberPersisted,
} from "./core/persistence";
import { fetchSampleMidi, getSample } from "./core/samples";
import type { AppServices } from "./core/services";
import {
	fitPitchRange,
	pitchSignature,
	resolveExportBitrate,
	resolveExportDims,
	speedToPps,
	trimAudioBuffer,
} from "./export/exportMath";
// VideoExporter pulls Mediabunny; OfflineAudioRenderer pulls Tone + instruments.
// Both are dynamic-imported from startExport(). Import order matters: load the
// offline-audio module first when audio is needed 隆陋 do not block Tone on the
// heavy VideoExporter chunk (see Promise.all removal below).
import { parseSubtitleFile } from "./services/LyricsParser";
import type { VideoExporter } from "./export/VideoExporter";
import { audioBufferToWav } from "./export/wav";
import { mountRotateHint } from "./ui/RotateHint";
import { setLocale, t } from "./i18n";
import { CaptureFanout } from "./midi/CaptureFanout";
import { ComputerKeyboardInput } from "./midi/ComputerKeyboardInput";
import { LiveLooper, type LiveLooperState } from "./midi/LiveLooper";
import { LiveNoteStore } from "./midi/LiveNoteStore";
import type { CapturedEvent } from "./midi/MidiEncoding";
import {
	encodeCapturedEvents,
	midiFileToBytes,
	triggerMidiDownload,
} from "./midi/MidiEncoding";
import { MidiInputManager } from "./midi/MidiInputManager";
import { SessionRecorder } from "./midi/SessionRecorder";
import { sessionToMidiFile } from "./midi/SessionToMidi";
import type { LearnController } from "./modes/LearnController";
import { setNextLiveOpts } from "./modes/LiveMode";
import { MODE_CAPTURES_LIVE, type ModeContext } from "./modes/ModeController";
import { PARTICLE_STYLES } from "./renderer/ParticleSystem";
import { PianoRollRenderer, KEYBOARD_HEIGHT_AUTO_MIN, BACKGROUND_MODES, type BackgroundMode } from "./renderer/PianoRollRenderer";
import {
	BORDER_STYLE_IDS,
	type BorderStyle,
	getTrackColor,
	hexToRgb,
	makeCustomTheme,
	rgbToHex,
	THEMES,
	type Theme,
} from "./renderer/theme";
import type { AppMode, AppStore } from "./store/state";
import { watch } from "./store/watch";
import {
	categorizeMidiDevice,
	midiLoadErrorType,
	track,
	trackActivation,
	trackEvent,
	trackEventSettled,
	trackMidiLoaded,
	trackMidiLoadFailed,
} from "./telemetry";
import { ChordOverlay } from "./ui/ChordOverlay";
import { ColorPickerHost } from "./ui/ColorPicker";
import { Controls } from "./ui/Controls";
import { CustomizeMenu } from "./ui/CustomizeMenu";
import { DropZone } from "./ui/DropZone";
// Modal classes that the user only reaches on demand (Record button, file
// picker, post-session card) are dynamic-imported in ensureXModal() helpers
// below so their JSX stays out of the initial bundle. The static side keeps
// the type imports for signatures.
import type { ExportModal, ExportOutput, ExportSettings } from "./ui/ExportModal";
import { AudioMenu } from "./ui/AudioMenu";
import { RollMenu } from "./ui/RollMenu";
import { KeyboardResizer } from "./ui/KeyboardResizer";
import type { SessionAction } from "./ui/PostSessionModal";
import { showError, showSuccess } from "./ui/Toast";
import { TrackPanel } from "./ui/TrackPanel";
import { hexToCSS, installViewportClassSync } from "./ui/utils";
import { whenIdle } from "./whenIdle";
import { VideoTranscoder } from "./services/VideoTranscoder";
import type { Accessor } from "solid-js";

// Total note count across all tracks 隆陋 the content-size signal attached to
// midi_loaded so we can tie which pieces drive retention. Structurally typed
// to avoid coupling this helper to the MidiFile import.
function countNotes(midi: {
	tracks: ReadonlyArray<{ notes: ReadonlyArray<unknown> }>;
}): number {
	return midi.tracks.reduce((n, t) => n + t.notes.length, 0);
}

export class App {
	private clock = new MasterClock();
	private renderer = new PianoRollRenderer();
	private synth = new SynthEngine();
	private inputBus = new InputBus();
	midiInput!: MidiInputManager;
	keyboardInput!: ComputerKeyboardInput;
	private liveNotes = new LiveNoteStore();
	private loopNotes = new LiveNoteStore();
	private liveLooper!: LiveLooper;
	private metronome = new Metronome();
	private sessionRec!: SessionRecorder;
	private capture!: CaptureFanout;
	// Lazy modals: race-safe lazy initialisation via lazyHandle 隆陋 each is
	// constructed at most once, even under concurrent get() calls.
	private postSessionHandle = lazyHandle(() =>
		import("./ui/PostSessionModal").then(({ PostSessionModal }) => {
			const m = new PostSessionModal(this.overlay);
			m.onAction = (action) => void this.handleSessionAction(action);
			return m;
		}),
	);
	private pendingSession: { events: CapturedEvent[]; duration: number } | null =
		null;
	private instrumentMenu!: InstrumentMenu;
	private rollMenu!: RollMenu;
	private audioMenu!: AudioMenu;
	private activeMouseNote: number | null = null;
	dropzone!: DropZone;
	private midiPickerHandle = lazyHandle(() =>
		import("./ui/MidiPickerModal").then(({ MidiPickerModal }) => {
			const m = new MidiPickerModal(this.overlay);
			return m;
		}),
	);

	private controls!: Controls;
	trackPanel!: TrackPanel;
	private colorPicker!: ColorPickerHost;
	private trackColorStore = jsonPersisted<Record<string, number>>(
		"midee.trackColors",
		{},
	);
	private exportHandle = lazyHandle(() =>
		import("./ui/ExportModal").then(({ ExportModal }) => {
			const m = new ExportModal(this.overlay);
			m.onStart = (settings) => void this.startExport(settings);
			m.onCancel = () => this.cancelExport();
			return m;
		}),
	);
	// Captured in init() so the lazy ensureXModal() helpers can construct
	// without re-querying the DOM.
	private overlay!: HTMLElement;
	private kbdResizer!: KeyboardResizer;
	private disposeRotateHint: (() => void) | null = null;
	private chordOverlay!: ChordOverlay;
	private customizeMenu!: CustomizeMenu;
	private videoTranscoder = new VideoTranscoder();
	private progressOverlay: HTMLDivElement | null = null;
	private videoImportProgress: Accessor<number> = () => 0;
	private setVideoImportProgress: (v: number) => void = () => {};
	private isTranscoding = false;
	private originalVideoUrl: string | null = null;
	private originalVideoFile: File | null = null;
	// Shared handles passed into subsystems (Controls today, mode controllers and
	// exercises in follow-up tasks). Assembled once in init() from this.clock,
	// this.synth, etc. so the constructor list stays authoritative.
	// Public so `createApp()` can thread `services`/`store` into AppCtx.
	services!: AppServices;
	readonly store: AppStore;

	constructor(store: AppStore) {
		this.store = store;
	}
	// Learn owns enough lifecycle state (hub, runner, overlay layer) that a
	// long-lived instance is cheapest. But constructing it pulls the entire
	// Learn module graph (LearnHub, ExerciseRunner, IntervalsEngine, 隆颅) into
	// the bundle, so we defer construction to first use. The mode context is
	// captured at boot so the lazy constructor doesn't need to re-derive it.
	private learnControllerHandle = lazyHandle(() =>
		import("./modes/LearnController").then(({ LearnController }) => {
			const c = new LearnController(this.modeContext);
			return c;
		}),
	);
	private modeContext!: ModeContext;
	private loadingEl: HTMLElement | null = null;
	private currentExporter: VideoExporter | null = null;
	// Throttle chord recomputation: only run when at least this many ms have
	// passed since the last call, OR the active-pitch set materially changed.
	private chordLastRunMs = 0;
	private chordLastSig = "";
	private chordOverlayOn = false;

	private themeIndex = themeIndexStore.load();
	private customTheme: Theme | null = null;
	private customColor = customColorStore.load();
	private hasImportedAudio = false;
	private instrumentIndex = instrumentIndexStore.load();
	private particleIndex = particleIndexStore.load();
	private velocityThreshold = velocityThresholdStore.load();
	private borderStyleIndex = borderStyleStore.load();
	private particleColorOverride: number | null = particleColorStore.load();
	private borderColorOverride: number | null = borderColorStore.load();
	private keyboardColorMode: 'note' | 'border' = keyboardColorModeStore.load();
	// Per-track persisted state. Source of truth for the live renderer Maps;
	// the global fields above are the fallback default + the current
	// CustomizeMenu choice applied to visible tracks.
	private particleStyleByTrack: Record<string, number> =
		particleStyleByTrackStore.load();
	private borderStyleByTrack: Record<string, number> =
		borderStyleByTrackStore.load();
	private particleColorByTrack: Record<string, number | null> =
		particleColorByTrackStore.load();
	private borderColorByTrack: Record<string, number | null> =
		borderColorByTrackStore.load();
	// Track open/close semantics: "visible" (renderer.visibleTrackIds) and
	// "audible" (synth disabled-track set) are each authoritative in their own
	// subsystem; the Tracks panel owns the button UI state. A track keeps its
	// assigned instrument across close/open cycles, and the global instrument
	// menu only rewrites voices for tracks that are audible.
	private audioPrimed = false;
	// Analytics one-shot flags. Reset when a new file is loaded so a user
	// who opens MIDI A then MIDI B gets `first_play` events for both.
	private firstPlayLogged = false;
	private firstLiveNoteLogged = false;
	private firstPedalLogged = false;
	private playbackMilestones = new Set<number>();
	// Loop station one-shots, scoped to the page session. We want to know
	// whether users ever reach each step in the loop funnel, not count every
	// state flip 隆陋 the state machine toggles rapidly during overdub.
	private loopArmedLogged = false;
	private loopRecordedLogged = false;
	private prevLooperState: LiveLooperState = "idle";
	// Sustain pedal state managed by LivePerformanceBus 隆陋 keyboard OR MIDI
	// sources merged with an OR. The bus owns sustained-pitches bookkeeping,
	// repress-release logic, and subscriber fan-out.
	private performanceBus!: LivePerformanceBus;
	private onVisibilityChange = (): void => {
		if (document.hidden) this.releaseAllLiveNotes();
	};
	private onWindowBlur = (): void => this.releaseAllLiveNotes();
	private onFirstPointerDown = (): void => this.primeInteractiveAudio();
	private onFirstKeyDown = (): void => this.primeInteractiveAudio();
	// Unsubscribe closures from every Signal.subscribe() in init(). Invoked from
	// dispose() so each Signal's listener set is cleared 隆陋 otherwise the
	// captured `this` leaks for the lifetime of the surrounding signals.
	private unsubs: Array<() => void> = [];

	async init(): Promise<void> {
		const canvas = document.querySelector<HTMLCanvasElement>("#pianoroll")!;
		const overlay = document.querySelector<HTMLElement>("#ui-overlay")!;
		this.overlay = overlay;

		// Flip `body.is-touch` / `body.is-narrow` so CSS can adapt (bottom-sheet
		// popovers, touch-friendly hit targets, etc.).
		installViewportClassSync();

		await this.renderer.init(canvas);
		this.renderer.attachClock(this.clock);
		this.renderer.setLiveNoteStore(this.liveNotes);
		this.renderer.setLoopNoteStore(this.loopNotes);

		this.midiInput = new MidiInputManager(this.clock);
		this.keyboardInput = new ComputerKeyboardInput(this.clock);

		this.liveLooper = new LiveLooper(
			this.clock,
			{
				onPlaybackNoteOn: (pitch, velocity, ctxTime) => {
					// Audio is sample-accurately scheduled via the AudioContext clock.
					this.synth.scheduleNoteOn(pitch, velocity, ctxTime);
					// Visuals and session capture fire at ~wall time by deferring the
					// work until ctxTime arrives. setTimeout jitter (~1篓C4 ms) is
					// imperceptible vs. audio, whereas drawing now (up to 150 ms early)
					// would visibly desync the falling notes.
					this.deferToCtxTime(ctxTime, () => {
						this.loopNotes.press(pitch, velocity, this.clock.currentTime);
						this.sessionRec.captureNoteOn(
							pitch,
							velocity,
							this.clock.currentTime,
						);
					});
				},
				onPlaybackNoteOff: (pitch, ctxTime) => {
					this.synth.scheduleNoteOff(pitch, ctxTime);
					this.deferToCtxTime(ctxTime, () => {
						this.loopNotes.release(pitch, this.clock.currentTime);
						this.sessionRec.captureNoteOff(pitch, this.clock.currentTime);
					});
				},
			},
			// Bar-snap when the metronome is running 隆陋 rounds loop length to the
			// nearest whole bar at current BPM (4/4). Off 隆煤 freeform length.
			(raw) => {
				if (!this.metronome.running.value) return raw;
				const secPerBar = (60 / this.metronome.bpm.value) * 4;
				const bars = Math.max(1, Math.round(raw / secPerBar));
				return bars * secPerBar;
			},
		);

		this.sessionRec = new SessionRecorder(this.clock);

		// Fan-out that routes capture events to both looper and sessionRec in
		// a single call. Eliminates the duplicated call pairs below.
		this.capture = new CaptureFanout(this.liveLooper, this.sessionRec);

		// LivePerformanceBus owns pedal merge (keyboard OR MIDI), sustained-pitch
		// bookkeeping, and subscriber fan-out for live performance events.
		this.performanceBus = createLivePerformanceBus();

		// Hook per-track state injection into renderer.loadMidi so both the
		// PlayMode effect path and the error-recovery path stay in sync.
		this.renderer.onLoadMidi = (tracks) => this.injectPerTrackState(tracks);
		this.renderer.setKeyboardColorMode(this.keyboardColorMode);

		this.services = {
			store: this.store,
			clock: this.clock,
			synth: this.synth,
			metronome: this.metronome,
			renderer: this.renderer,
			input: this.inputBus,
		};

		// Wire the LivePerformanceBus fan-out sinks. Audio and visual-key
		// feedback fire unconditionally (every mode). Capture-mode sinks
		// (looper + session + particles) gate on MODE_CAPTURES_LIVE.
		this.unsubs.push(
			this.performanceBus.subscribeNotes(
				// Audio + visual: always fire so every key-press is heard and seen.
				(evt) => {
					this.synth.liveNoteOn(evt.pitch, evt.velocity);
					this.liveNotes.press(evt.pitch, evt.velocity, evt.clockTime);
				},
				(evt) => {
					this.synth.liveNoteOff(evt.pitch);
				},
			),
			// Capture-mode note-off subscriber: looper + session recorder capture
			// every note-off (including pedal-sustained releases). Mode-gated so
			// Learn-mode practice doesn't pollute recordings.
			this.performanceBus.subscribeNotes(
				() => {},
				(evt) => {
					if (!MODE_CAPTURES_LIVE[this.store.state.mode]) return;
					// Synthetic pedal-up uses clockTime -1; SessionRecorder needs wall times.
					const t = evt.clockTime >= 0 ? evt.clockTime : this.clock.currentTime;
					this.capture.captureNoteOff(evt.pitch, t);
				},
			),
		);

		// Dropzone is shared across modes; its callbacks dispatch by the active
		// mode so Learn keeps its MIDI isolated from Play's.
		this.dropzone = new DropZone(
			overlay,
			(file, source) => {
				if (this.store.state.mode === "learn") {
					void this.ensureLearnController().then((c) =>
						c.loadMidiFromFile(file, source),
					);
				} else {
					void this.loadMidi(file, source);
				}
			},
			() => this.enterLiveMode(),
			(sampleId) => {
				if (this.store.state.mode === "learn") {
					void this.ensureLearnController().then((c) => c.loadSample(sampleId));
				} else {
					void this.loadSample(sampleId);
				}
			},
			() => this.store.setState("mode", "learn"),
		);

		this.controls = new Controls({
			container: overlay,
			services: this.services,
			onSeek: (t) => {
				this.synth.seek(t);
				this.liveNotes.reset();
			},
			onZoom: (pps) => this.renderer.setZoom(pps),
			onThemeCycle: () => this.cycleTheme(),
			onMidiConnect: () => void this.connectMidi(),
			onOpenRoll: () => this.rollMenu.toggle(),
			onOpenAudio: () => this.audioMenu.toggle(),
			onRecord: () => {
				// First-time vs repeat opens are derivable in PostHog funnels via
				// "first occurrence per user" 隆陋 no need for a duplicate event.
				track("export_opened", {
					has_midi: this.store.state.loadedMidi !== null,
				});
				void this.openExportModal();
			},
			onOpenFile: () => this.openFilePicker(),
			onModeRequest: (mode) => this.requestMode(mode),
			onLearnThis: () => this.enterLearnWithCurrentMidi(),
			onHome: () => this.enterHomeMode(),
			onInstrumentCycle: () => this.cycleInstrument(),
			onParticleCycle: () => this.cycleParticleStyle(),
			onLoopToggle: () => this.liveLooper.toggle(),
			onLoopClear: () => {
				const layers = this.liveLooper.layerCount.value;
				this.liveLooper.clear();
				if (layers > 0) track("loop_cleared", { layers });
			},
			onLoopSave: () => void this.saveLoopAsMidi(),
			onLoopUndo: () => {
				const before = this.liveLooper.layerCount.value;
				this.liveLooper.undo();
				if (before > 0) track("loop_undone", { layers_before: before });
			},
			onMetronomeToggle: () => {
				this.metronome.toggle();
				trackEvent("metronome_toggled", { on: this.metronome.running.value });
			},
			onMetronomeBpmChange: (bpm) => {
				this.metronome.setBpm(bpm);
				metronomeBpmStore.save(this.metronome.bpm.value);
				trackEventSettled("tempo_changed", { bpm: this.metronome.bpm.value });
			},
			onSessionToggle: () => this.toggleSessionRecord(),
			onChordToggle: () => this.toggleChordOverlay(),
			onOctaveShift: (delta) => {
				if (delta < 0) this.keyboardInput.shiftOctaveDown();
				else this.keyboardInput.shiftOctaveUp();
			},
		});

		const pushLoop = (): void =>
			this.controls.updateLoopState(
				this.liveLooper.state.value,
				this.liveLooper.layerCount.value,
			);
		this.unsubs.push(
			this.liveLooper.state.subscribe((s) => {
				this.trackLoopTransition(s);
				pushLoop();
			}),
			this.liveLooper.layerCount.subscribe(pushLoop),
		);
		pushLoop();

		this.metronome.setBpm(metronomeBpmStore.load());
		const pushMetronome = (): void => {
			this.controls.updateMetronome(
				this.metronome.running.value,
				this.metronome.bpm.value,
			);
			this.audioMenu?.setMetronomeOn(this.metronome.running.value);
			this.audioMenu?.setMetronomeBpm(this.metronome.bpm.value);
		};
		this.unsubs.push(
			this.metronome.running.subscribe(pushMetronome),
			this.metronome.bpm.subscribe(pushMetronome),
			this.metronome.beatCount.subscribe((count) => {
				if (count === 0) return;
				const isDownbeat = (count - 1) % 4 === 0;
				this.controls.pulseMetronomeBeat(isDownbeat);
			}),
		);
		pushMetronome();

		const pushSession = (): void =>
			this.controls.updateSessionRecording(
				this.sessionRec.recording.value,
				this.sessionRec.elapsed.value,
			);
		this.unsubs.push(
			this.sessionRec.recording.subscribe(pushSession),
			this.sessionRec.elapsed.subscribe(pushSession),
			this.liveLooper.progress.subscribe((p) =>
				this.controls.updateLoopProgress(p),
			),
		);
		pushSession();

		this.colorPicker = new ColorPickerHost(overlay);
		this.trackPanel = new TrackPanel(
			overlay,
			this.renderer,
			(id, enabled) => {
				this.synth.setTrackEnabled(id, enabled);
				this.audioMenu?.refreshEnabledState();
				trackEvent("track_toggled", { enabled });
			},
			(id, visible) => {
				this.renderer.setTrackVisible(id, visible);
				trackEvent("track_visibility_toggled", { visible });
			},
			() => this.openFilePicker(),
			(track, anchorEl) => {
				const defaultColor = getTrackColor(track, this.renderer.currentTheme);
				this.colorPicker.open({
					initialColor: defaultColor,
					defaultColor,
					trackName: track.name,
					scope: "track",
					anchorEl,
					onConfirm: (color) => {
						this.renderer.setTrackColorOverride(track.id, color);
						this.saveTrackColorOverride(track.id, color);
						trackEvent("track_color_changed", { overridden: true });
						// Bump TrackPanel's version signal so the per-track swatch re-
						// evaluates its colour live. Without this the swatch only
						// refreshes when the panel is reopened, because getColorOverride
						// reads a non-reactive renderer field.
						this.trackPanel?.refresh();
					},
					onReset: () => {
						this.renderer.setTrackColorOverride(track.id, null);
						this.saveTrackColorOverride(track.id, null);
						trackEvent("track_color_reset", { overridden: false });
						this.trackPanel?.refresh();
					},
				});
			},
			(trackId) => this.renderer.getTrackColorOverride(trackId),
			(id) =>
				t(
					INSTRUMENTS.find((i) => i.id === this.synth.getTrackInstrument(id))!
						.nameKey,
				),
		);
		this.restoreTrackColorOverrides();

		// Waterfall & keyboard dropdown (replaces the old Tracks pill). The
		// track list inside it is a second TrackPanelView sharing the same
		// TrackPanel signals, so visibility/audibility stay in sync.
		this.rollMenu = new RollMenu(this.controls.rollSlot, overlay);
		this.rollMenu.onCornerRatioChange = (v) => {
			this.renderer.setNoteCornerRatio(v);
			cornerRatioStore.save(v);
		};
		this.rollMenu.onColorModeChange = (mode, customColor) => {
			this.renderer.setNoteColorMode(mode, customColor);
			noteColorModeStore.save({ mode, color: customColor ?? null });
		};
		this.rollMenu.onOpenCustomColor = () => this.openNoteColorPicker();
		this.rollMenu.onSelectParticle = (i) => this.setParticleByIndex(i);
		this.rollMenu.onOpenParticleColor = () => this.openParticleColorPicker();
		this.rollMenu.setCornerRatio(cornerRatioStore.load());
		this.rollMenu.setColorMode(noteColorModeStore.load().mode);
		this.rollMenu.setCustomColorCss(
			hexToCSS(noteColorModeStore.load().color ?? 0x3b82f6),
		);
		this.renderer.setNoteCornerRatio(cornerRatioStore.load());
		const restoredNoteColor = noteColorModeStore.load();
		this.renderer.setNoteColorMode(
			restoredNoteColor.mode,
			restoredNoteColor.color ?? undefined,
		);
		this.syncRollMenuParticleState();
		this.refreshRollEmbed();

		// Audio control dropdown (replaces the old Instrument pill): voice,
		// per-track mute, metronome and global reverb.
		this.audioMenu = new AudioMenu(this.controls.audioSlot, overlay);
		this.audioMenu.onSelect = (id) => this.setInstrumentById(id);
		this.audioMenu.onTrackEnabledChange = (id, enabled) => {
			this.synth.setTrackEnabled(id, enabled);
			trackEvent("track_toggled", { enabled });
		};
		this.audioMenu.onMetronomeToggle = () => {
			this.metronome.toggle();
			trackEvent("metronome_toggled", { on: this.metronome.running.value });
		};
		this.audioMenu.onMetronomeBpmChange = (bpm) => {
			this.metronome.setBpm(bpm);
			metronomeBpmStore.save(this.metronome.bpm.value);
			trackEventSettled("tempo_changed", { bpm: this.metronome.bpm.value });
		};
		this.audioMenu.onReverbChange = (v) => {
			this.synth.setReverbWet(v);
			reverbWetStore.save(v);
		};
		this.unsubs.push(
			this.synth.loadingInstrument.subscribe((id) => {
				this.audioMenu.setLoading(id);
				this.controls.setInstrumentLoading(id !== null);
			}),
		);
		this.audioMenu.setLoading(this.synth.loadingInstrument.value);
		this.audioMenu.setMetronomeOn(this.metronome.running.value);
		this.audioMenu.setMetronomeBpm(this.metronome.bpm.value);
		this.audioMenu.setReverb(reverbWetStore.load());
		this.synth.setReverbWet(reverbWetStore.load());
		this.controls.setInstrumentLoading(
			this.synth.loadingInstrument.value !== null,
		);

		// ExportModal / PostSessionModal / MidiPickerModal are constructed lazily
		// (see ensureXModal helpers further down) 隆陋 none of them are visible at
		// boot, and keeping them out of the initial chunk shaves ~835 LOC of JSX
		// off the first-paint bundle.

		this.kbdResizer = new KeyboardResizer(
			overlay,
			() => this.renderer.currentKeyboardHeight,
			// Drag / saved heights pin the value 隆陋 window-resize re-derivation is
			// then skipped so the user's choice sticks (see PianoRollRenderer).
			(px) => this.renderer.setKeyboardHeightUser(px),
			// Double-click on the handle resets to the width-proportional auto height.
			() => this.renderer.clearKeyboardHeightOverride(),
		);
		this.kbdResizer.restoreSaved();
		this.kbdResizer.setPausedCallback(() => {
			const s = this.store.state.status;
			return s === "paused" || s === "ready";
		});
		// Portrait touch devices get a dismissible "rotate to landscape" strip.
		this.disposeRotateHint = mountRotateHint();

		this.chordOverlay = new ChordOverlay(this.controls.chordSlot);
		this.chordOverlayOn = chordOverlayStore.load();
		this.applyChordOverlayVisibility();		// File mode actively plays a MIDI 隆陋 the chord chip would just narrate
		// what the user is already hearing without contributing to "play along"
		// affordances. Keep it scoped to live/home where it confirms what the
		// player is sounding.
		this.unsubs.push(
			watch(
				() => this.store.state.mode,
				() => this.applyChordOverlayVisibility(),
			),
		);

		// Customization popover bundles theme / particles / chord toggle 隆陋
		// collapses three topbar pills into a single trigger.
		this.customizeMenu = new CustomizeMenu(
			this.controls.customizeSlot,
			overlay,
			THEMES,
			PARTICLE_STYLES,
			{
				onSelectTheme: (idx) => this.setThemeByIndex(idx),
				onSelectParticle: (idx) => this.setParticleByIndex(idx),
				onSelectBorderStyle: (idx) => this.setBorderStyleByIndex(idx),
				onOpenParticleColor: () => this.openParticleColorPicker(),
				onOpenBorderColor: () => this.openBorderColorPicker(),
				onOpenCustomThemeColor: () => this.openCustomThemeColorPicker(),
				onToggleChord: () => this.toggleChordOverlay(),
				onSelectThreshold: (v) => this.setVelocityThreshold(v),
				onVideoTrimApply: (start, end) => this.applyVideoTrim(start, end),
				onVideoTrimCancel: () => {
					// 脰脴脰脙虏脙录么脰碌
					this.customizeMenu.setFrontTrim(0)
					this.customizeMenu.setBackTrim(0)
			},
				onVideoImport: () => {
					void this.importMedia()
				},
				onLyricsImport: () => {
					void this.importLyrics()
				},
				onLyricsClear: () => {
					this.clearLyrics()
				},
				onImageScaleChange: (scale) => {
					this.renderer.setImageScale(scale)
				},
				onImageOffsetChange: (offsetX) => {
					this.renderer.setImageOffsetX(offsetX)
				},
				onOverlayOpacityChange: (o) => {
					this.renderer.setOverlayOpacity(o)
				},
				onVideoOpacityChange: (o) => {
					this.renderer.setVideoOpacity(o)
				},
				onVolumeChange: (v) => {
					this.store.setState("volume", v)
				},
				onMediaVolumeChange: (v) => {
					this.renderer.setVolume(v)
				},
				onPlaybackRateChange: (rate) => {
					this.renderer.setVideoPlaybackRate(rate)
				},
				// Locale change is rare, and almost every part of the UI was built
				// with the previous locale baked in via template literals. Reload
				// is the simplest correct path: persistence happens in setLocale,
				// boot picks it up, the next paint is fully translated. No stale
				// strings, no in-place re-render machinery to maintain.
				onSelectLocale: (code) => {
					void setLocale(code).then(() => window.location.reload());
				},
				onKeyboardColorModeChange: (mode) => {
					this.renderer.setKeyboardColorMode(mode);
				},
				onSelectBackgroundMode: (mode) => {
					this.renderer.setBackgroundMode(mode);
					backgroundModeStore.save(mode);
					this.customizeMenu?.setBackgroundModeIndex(
						BACKGROUND_MODES.findIndex((m) => m.id === mode),
					);
					trackEvent("background_mode_changed", { mode });
				},
				onOpenBackgroundSolidColor: () => this.openBackgroundSolidColorPicker(),
				onOpenBackgroundGlowColor: () => this.openBackgroundGlowColorPicker(),
				onBackgroundGlowIntensityChange: (v) => {
					this.renderer.setBackgroundGlowIntensity(v);
					bgGlowIntensityStore.save(v);
				},
				onBackgroundOpacityChange: (v) => {
					this.renderer.setBackgroundOpacity(v);
					bgOpacityStore.save(v);
				},
				onBackgroundDriftChange: (v) => {
					this.renderer.setBackgroundDrift(v);
					bgDriftStore.save(v);
				},
			},
		);
		this.customizeMenu.setChord(this.chordOverlayOn);
		this.syncCustomizeBackgroundState();
		this.restoreRendererBackgroundState();

		if (this.themeIndex < THEMES.length) {
			this.applyTheme(THEMES[this.themeIndex]!);
		} else {
			this.customTheme = makeCustomTheme(this.customColor);
			this.applyTheme(this.customTheme);
		}
		this.applyInstrument();
		this.applyParticleStyle();
		this.applyBorderStyle();
		this.applyParticleColorOverride();
		this.applyBorderColorOverride();
		this.syncCustomizeColorSwatches();
		this.applyVelocityThreshold();

		// Idle-time warmups. None of these affect first paint 隆陋 they trade
		// background bandwidth for "feels instant" on first-click flows. All
		// share the default deadline; on a typical browser they fire in the
		// same idle frame ~150-300 ms after boot, kicking off network fetches
		// in parallel.
		//   ? synth piano samples 隆煤 first-note latency
		//   ? @tonejs/midi 隆煤 sample-card click + record-export
		//   ? modal chunks 隆煤 first export / file-picker / post-session click
		//   ? LearnController (only when Learn is enabled) 隆煤 first Learn entry
		whenIdle(() => this.synth.preloadDefault());
		whenIdle(() => void import("@tonejs/midi"));
		whenIdle(() => {
			void import("./ui/ExportModal");
			void import("./ui/PostSessionModal");
			void import("./ui/MidiPickerModal");
	
		});
		whenIdle(() => void this.ensureLearnController());

		this.controls.updateMidiStatus(this.midiInput.status.value, "");
		this.dropzone.updateMidiStatus(this.midiInput.status.value, "");

		this.unsubs.push(
			this.clock.subscribe((t) => {
				// Export drives this same clock via seek() at frame cadence 隆陋 those
				// emissions are the encoder sweeping the timeline, not the user
				// watching. Without this gate a load隆煤export flow logs the 30/60/120s
				// milestones (and the playback_30s activation) for a piece nobody
				// played back.
				if (this.store.state.status === "exporting") return;
				// Engagement milestones are mode-agnostic (watched 隆脻30s counts as
				// a real user regardless of where the clock was ticking).
				for (const m of [30, 60, 120]) {
					if (t >= m && !this.playbackMilestones.has(m)) {
						this.playbackMilestones.add(m);
						track("playback_milestone", {
							seconds: m,
							mode: this.store.state.mode,
						});
						if (m === 30) trackActivation("playback_30s");
					}
				}
				this.maybeUpdateChordOverlay(t);
				// End-of-MIDI: auto-pause when clock reaches the end of the loaded MIDI
				// in play mode (Learn mode has its own end detection in PlayAlongEngine).
				if (this.store.state.mode === 'play' && this.store.state.status === 'playing') {
					const midi = this.store.state.loadedMidi;
					if (midi && midi.duration > 0 && t >= midi.duration) {
						this.clock.pause();
						this.clock.seek(midi.duration);
						this.store.setState('status', 'paused');
						this.synth.pause();
						this.renderer.pauseVideo();
					}
				}
			}),
		);
		this.unsubs.push(
			watch(
				() => this.store.state.status,
				(status) => {
					// Drives the synth for Play/Live only. Learn runs its own status
					// signal on `LearnState` and drives the synth from `LearnController`
					// so the two modes never race for control of the scheduler.
					const mode = this.store.state.mode;
					if (mode === "play" && status === "playing") {
						void this.synth.play(this.clock.currentTime);
						if (!this.firstPlayLogged) {
							this.firstPlayLogged = true;
							const midi = this.store.state.loadedMidi;
							track("first_play", {
								mode,
								duration_s: midi ? Math.round(midi.duration) : null,
							});
						}
					} else if (status === "paused") {
						this.synth.pause();
						if (mode === "live") {
							this.liveNotes.releaseAll(this.clock.currentTime);
							this.synth.liveReleaseAll();
						}
					}
				},
			),
			watch(
				() => this.store.state.volume,
				(v) => {
					this.synth.setVolume(v)
				},
			),
			watch(
				() => this.store.state.speed,
				(s) => {
					this.clock.speed = s;
					this.synth.setSpeed(s);
					this.renderer.setVideoPlaybackRate(s);
				},
			),
		);

		// 漏陇漏陇 Live input wiring (MIDI device + computer keyboard) 漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇
		// Each source re-publishes into the shared InputBus so downstream
		// consumers (the live-note handler here, and later exercise runners)
		// see one fan-out point instead of three. Pedal sources are kept
		// per-source because the bus merges them with an OR.
		this.unsubs.push(
			this.midiInput.noteOn.subscribe((evt) => {
				if (evt) this.inputBus.emitNoteOn(evt, "midi");
			}),
			this.midiInput.noteOff.subscribe((evt) => {
				if (evt) this.inputBus.emitNoteOff(evt, "midi");
			}),
			this.midiInput.pedal.subscribe((down) => {
				this.inputBus.emitPedal(down, "midi");
				if (down) {
					this.performanceBus.routePedalDown("midi");
					if (!this.firstPedalLogged) {
						this.firstPedalLogged = true;
						track("pedal_used", { source: "midi" });
					}
				} else {
					this.performanceBus.routePedalUp("midi");
				}
			}),
			this.keyboardInput.noteOn.subscribe((evt) => {
				if (evt) this.inputBus.emitNoteOn(evt, "keyboard");
			}),
			this.keyboardInput.noteOff.subscribe((evt) => {
				if (evt) this.inputBus.emitNoteOff(evt, "keyboard");
			}),
			this.keyboardInput.pedal.subscribe((down) => {
				this.inputBus.emitPedal(down, "keyboard");
				if (down) {
					this.performanceBus.routePedalDown("keyboard");
					if (!this.firstPedalLogged) {
						this.firstPedalLogged = true;
						track("pedal_used", { source: "keyboard" });
					}
				} else {
					this.performanceBus.routePedalUp("keyboard");
				}
			}),
			this.keyboardInput.octave.subscribe((o) => this.controls.updateOctave(o)),
			this.inputBus.noteOn.subscribe((evt) => {
				if (evt) this.handleLiveNoteOn(evt);
			}),
			this.inputBus.noteOff.subscribe((evt) => {
				if (evt) this.handleLiveNoteOff(evt);
			}),
		);

		// Mouse/touch on the on-screen keyboard 隆陋 down to press, move to slide
		// between keys (glissando), up/cancel/leave to release.
		canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
		canvas.addEventListener("pointermove", this.onCanvasPointerMove);
		canvas.addEventListener("pointerup", this.onCanvasPointerUp);
		canvas.addEventListener("pointercancel", this.onCanvasPointerUp);
		canvas.addEventListener("pointerleave", this.onCanvasPointerUp);

		// Update MIDI button whenever either status or device name changes.
		// Reading the *other* signal's current value avoids a stale-name flash.
		this.unsubs.push(
			this.midiInput.status.subscribe((status) => {
				this.controls.updateMidiStatus(status, this.midiInput.deviceName.value);
				this.dropzone.updateMidiStatus(status, this.midiInput.deviceName.value);
				if (status === "connected") {
					// Vendor enum instead of raw device name 隆陋 cardinality-friendly and
					// avoids leaking user-customised device labels.
					track("midi_device_connected", {
						vendor: categorizeMidiDevice(this.midiInput.deviceName.value),
					});
				}
			}),
			this.midiInput.deviceName.subscribe((name) => {
				this.controls.updateMidiStatus(this.midiInput.status.value, name);
				this.dropzone.updateMidiStatus(this.midiInput.status.value, name);
			}),
		);

		// Release all held notes when the page loses focus (prevents stuck notes)
		document.addEventListener("visibilitychange", this.onVisibilityChange);
		window.addEventListener("blur", this.onWindowBlur);
		window.addEventListener("pointerdown", this.onFirstPointerDown, {
			passive: true,
		});
		window.addEventListener("keydown", this.onFirstKeyDown, { passive: true });

		this.modeContext = {
			services: this.services,
			overlay,
			trackPanel: this.trackPanel,
			dropzone: this.dropzone,
			keyboardInput: this.keyboardInput,
			midiInput: this.midiInput,
			resetInteractionState: () => this.resetInteractionState(),
			openFilePicker: () => this.openFilePicker(),
			primeInteractiveAudio: () => this.primeInteractiveAudio(),
			setLearnFileName: (name) => this.controls.updateLearnFileName(name),
		};

		// Start in home. <HomeMode/>'s onMount handles the side effects.
		this.services.store.enterHome();
		void this.autoConnectMidi();
	}

	private releaseAllLiveNotes(): void {
		const now = this.clock.currentTime;
		this.liveNotes.releaseAll(now);
		this.synth.liveReleaseAll();
		// Emergency reset: clear all pedal state and release sustained pitches
		// so the bus doesn't think the pedal is still held when the user returns.
		this.performanceBus.forceReleaseAll(now);
	}

	// Called whenever a new MIDI is loaded so the telemetry flags scoped to
	// "this piece" fire for the next one too. `first_play` re-arms, playback
	// milestones reset so 30/60/120s fire again for the new file.
	private resetPlaybackTelemetry(): void {
		this.firstPlayLogged = false;
		this.playbackMilestones.clear();
	}

	// Loop funnel: fire once-per-session on `armed` and first `playing`, and
	// fire `loop_layer_added` every time an overdub passes commits as a new
	// layer (overdubbing 隆煤 playing). Skipping transitions that just return to
	// `idle` keeps the event stream tied to user intent, not UI housekeeping.
	private trackLoopTransition(next: LiveLooperState): void {
		const prev = this.prevLooperState;
		this.prevLooperState = next;
		if (!this.loopArmedLogged && (next === "armed" || next === "recording")) {
			this.loopArmedLogged = true;
			track("loop_armed");
		}
		if (
			!this.loopRecordedLogged &&
			next === "playing" &&
			prev === "recording"
		) {
			this.loopRecordedLogged = true;
			track("loop_recorded", { layers: this.liveLooper.layerCount.value });
		}
		if (next === "playing" && prev === "overdubbing") {
			track("loop_layer_added", { layers: this.liveLooper.layerCount.value });
		}
	}

	private handleLiveNoteOn(evt: BusNoteEvent): void {
		if (this.store.state.status === "exporting") return;
		const mode = this.store.state.mode;
		const captures = MODE_CAPTURES_LIVE[mode];
		if (mode === "home") this.enterLiveMode(false);

		if (!this.firstLiveNoteLogged) {
			this.firstLiveNoteLogged = true;
			track("first_live_note", { source: evt.source });
			trackActivation("live_note");
		}

		// Route through the bus: repress-release (note-off sinks, then on),
		// sustained-pitches bookkeeping, and note-on fan-out to audio+visual sinks.
		// Capture uses the bus's note-off path only 隆陋 no duplicate captureNoteOff
		// here (routeNoteOn already fans off to subscribers).
		this.performanceBus.routeNoteOn(evt);

		// Looper + session captures are live-performance concerns 隆陋 practice
		// key-presses (Learn) should not pollute a saved session recording.
		if (captures) {
			this.renderer.burstParticleAt(evt.pitch);
			this.capture.captureNoteOn(evt.pitch, evt.velocity, evt.clockTime);
		}

		// Live mode's "tap a note to start the session" shortcut.
		if (mode === "live") {
			const s = this.store.state.status;
			if (s === "idle" || s === "ready" || s === "paused") {
				this.clock.play();
				this.store.setState("status", "playing");
			}
		}
	}

	private handleLiveNoteOff(evt: BusNoteEvent): void {
		const mode = this.store.state.mode;
		if (mode === "home") return;

		// Visual key-up always fires 隆陋 the roll reflects hand motion even while
		// audio keeps ringing under the pedal.
		this.liveNotes.release(evt.pitch, evt.clockTime);

		// Route through the bus. When pedal is down the bus bookmarks the pitch;
		// when pedal lifts, bus subscribers fire for audio+visual release and
		// captures. When pedal is not down, subscribers fire immediately.
		this.performanceBus.routeNoteOff(evt);
	}

	private onCanvasPointerDown = (e: PointerEvent): void => {
		if (this.store.state.status === "exporting") return;

		// Check if the click hits a bar line first (only when paused)
		const isPaused = this.store.state.status === "paused" || this.store.state.status === "ready";
		if (isPaused) {
			const barIndex = this.renderer.hitTestBarLine(e.clientX, e.clientY);
			if (barIndex !== null) {
				e.preventDefault();
				(e.target as Element).setPointerCapture?.(e.pointerId);
				this.renderer.startBarLineDrag(barIndex, e.clientY, e.shiftKey, e.ctrlKey);
				return;
			}
		}

		const pitch = this.renderer.pitchAtClientPoint(e.clientX, e.clientY);
		if (pitch === null) return;

		this.primeInteractiveAudio();
		if (this.store.state.mode === "home") this.enterLiveMode(false);
		(e.target as Element).setPointerCapture?.(e.pointerId);
		e.preventDefault();

		if (this.activeMouseNote !== null) {
			this.inputBus.emitNoteOff(
				{
					pitch: this.activeMouseNote,
					velocity: 0,
					clockTime: this.clock.currentTime,
				},
				"touch",
			);
		}
		this.activeMouseNote = pitch;
		this.inputBus.emitNoteOn(
			{ pitch, velocity: 0.8, clockTime: this.clock.currentTime },
			"touch",
		);
	};

	private onCanvasPointerMove = (e: PointerEvent): void => {
		// Handle bar line drag first (before activeMouseNote check)
		if (this.renderer.isDraggingBarLine) {
			this.renderer.updateBarLineDrag(e.clientY);
			return;
		}

		// Change cursor when hovering over bar line (only when paused)
		const isPaused = this.store.state.status === "paused" || this.store.state.status === "ready";
		if (isPaused) {
			const barIndex = this.renderer.hitTestBarLine(e.clientX, e.clientY);
			this.renderer.canvas.style.cursor = barIndex !== null ? 'ns-resize' : '';
		} else {
			this.renderer.canvas.style.cursor = '';
		}

		// Only react while the user is actively pressing 隆陋 this is the glissando
		// path, not a hover state.
		if (this.activeMouseNote === null) return;
		if (this.store.state.status === "exporting") return;
		const pitch = this.renderer.pitchAtClientPoint(e.clientX, e.clientY);
		if (pitch === null || pitch === this.activeMouseNote) return;
		const prev = this.activeMouseNote;
		this.activeMouseNote = pitch;
		this.inputBus.emitNoteOff(
			{ pitch: prev, velocity: 0, clockTime: this.clock.currentTime },
			"touch",
		);
		this.inputBus.emitNoteOn(
			{ pitch, velocity: 0.8, clockTime: this.clock.currentTime },
			"touch",
		);
	};

	private onCanvasPointerUp = (): void => {
		if (this.renderer.isDraggingBarLine) {
			this.renderer.endBarLineDrag();
			return;
		}
		if (this.activeMouseNote === null) return;
		const pitch = this.activeMouseNote;
		this.activeMouseNote = null;
		this.inputBus.emitNoteOff(
			{ pitch, velocity: 0, clockTime: this.clock.currentTime },
			"touch",
		);
	};

	private async connectMidi(): Promise<void> {
		this.primeInteractiveAudio();
		// Once a user denies the prompt, browsers remember the choice and
		// `requestMIDIAccess()` resolves silently 隆陋 clicking the button again
		// does nothing visible. Detect that case and surface a help message
		// so the user knows they need to reset the permission via the browser
		// (lock icon 隆煤 Site settings 隆煤 MIDI devices 隆煤 Allow).
		const wasBlocked = this.midiInput.status.value === "blocked";
		track("midi_permission_requested", { was_blocked: wasBlocked });
		const ok = await this.midiInput.requestAccess();
		if (ok) {
			track("midi_permission_granted");
			return;
		}
		if (this.midiInput.status.value === "blocked") {
			track("midi_permission_denied", { was_blocked: wasBlocked });
			const msg = wasBlocked
				? t("error.midi.permissionBlocked")
				: t("error.midi.permissionDenied");
			this.showError(msg);
		}
	}

	private async autoConnectMidi(): Promise<void> {
		await this.midiInput.requestAccess({ silent: true });
	}

	// Play-mode MIDI loader. Learn has its own loader on LearnController that
	// never touches AppState 隆陋 see the mode dispatch at the DropZone callback.
	private async loadMidi(
		file: File,
		source: "drag" | "picker" = "picker",
	): Promise<void> {
		const previousMode = this.store.state.mode;
		const previousMidi = this.store.state.loadedMidi;
		this.resetInteractionState();
		this.store.beginPlayLoad();
		this.renderer.clearMidi();
		this.showLoading();

		try {
			// If the file is not a MIDI file (e.g. MuseScore), convert it first
			let fileToParse = file;
			const lowerName = file.name.toLowerCase();
			const isNativeMidi = lowerName.endsWith('.mid') || lowerName.endsWith('.midi');
			if (!isNativeMidi) {
				try {
					const ext = lowerName.substring(lowerName.lastIndexOf('.'));
					const res = await fetch(`/api/musescore-convert?ext=${encodeURIComponent(ext)}`, {
						method: 'POST',
						body: file,
					});
					if (!res.ok) throw new Error(`Conversion failed: ${res.status}`);
					const midiBlob = await res.blob();
					fileToParse = new File([midiBlob], file.name.replace(/\.[^.]+$/, '.mid'), { type: 'audio/midi' });
				} catch (convErr) {
					console.error('[loadMidi] MuseScore conversion failed:', convErr);
					this.store.completePlayLoadError('File conversion failed. Is MuseScore installed?');
					return;
				}
			}
			const midi = await parseMidiFile(fileToParse);
			this.synth.load(midi).catch((err) => {
				console.error("SynthEngine.load failed:", err);
				// Visuals load but there's no sound 隆陋 a silent session-killer that
				// produced zero telemetry before.
				trackEvent("synth_load_failed", { source });
			});
			// completePlayLoad flips mode to 'play'; <PlayMode/>'s effect then
			// drives renderer.loadMidi, trackPanel.render, document.title, and
			// dropzone.hide off the new loadedMidi.
			this.store.completePlayLoad(midi);
			this.resetPlaybackTelemetry();
			trackMidiLoaded({
				source,
				trackCount: midi.tracks.length,
				noteCount: countNotes(midi),
				durationS: Math.round(midi.duration),
				fileSizeKb: Math.round(file.size / 1024),
			});
		} catch (err) {
			console.error("Failed to load MIDI:", err);
			// Bucket the cause (not free-text 隆陋 cardinality + PII) so we can see
			// which files break instead of lumping everything as 'parse'.
			trackMidiLoadFailed({
				source,
				errorType: await midiLoadErrorType(err, file),
				fileExt: file.name.split(".").pop()?.toLowerCase() ?? null,
				fileSizeKb: Math.round(file.size / 1024),
			});
			if (previousMode === "play" && previousMidi) {
				// Manual surface restore 隆陋 the one place that can't lean on
				// <PlayMode/>'s effect: `loadedMidi` still holds the same
				// `previousMidi` reference (beginPlayLoad doesn't clear it), so the
				// effect never re-fires, yet clearMidi() above already wiped the
				// renderer.
				this.store.enterPlay();
				this.renderer.loadMidi(previousMidi);
				this.trackPanel.render(previousMidi);
				this.dropzone.hide();
			} else if (previousMode === "live") {
				this.enterLiveMode(false);
			} else if (previousMode === "home") this.enterHomeMode();
			else this.store.setState("status", "ready");
			const msg =
				err instanceof Error && err.name === "EmptyMidiError"
					? t("error.midi.empty")
					: t("error.midi.parseFailed");
			this.showError(msg);
		} finally {
			this.hideLoading();
		}
	}

	private cycleTheme(): void {
		this.setThemeByIndex((this.themeIndex + 1) % (THEMES.length + 1));
	}

	private setThemeByIndex(idx: number): void {
		if (idx < 0 || idx > THEMES.length || idx === this.themeIndex) return;
		this.colorPicker.close();
		this.themeIndex = idx;
		if (idx < THEMES.length) {
			this.customTheme = null;
			this.applyTheme(THEMES[idx]!);
		} else {
			// Custom theme slot
			this.customTheme = makeCustomTheme(this.customColor);
			this.applyTheme(this.customTheme);
		}
		themeIndexStore.save(idx);
		trackEvent("theme_changed", {
			theme: idx < THEMES.length ? THEMES[idx]!.name : "Custom",
		});
	}

	private cycleInstrument(): void {
		const from = INSTRUMENTS[this.instrumentIndex]?.id;
		this.instrumentIndex = (this.instrumentIndex + 1) % INSTRUMENTS.length;
		this.applyInstrument();
		instrumentIndexStore.save(this.instrumentIndex);
		trackEvent("instrument_changed", {
			from,
			to: INSTRUMENTS[this.instrumentIndex]!.id,
			method: "cycle",
		});
	}

	private setInstrumentById(id: string): void {
		const idx = INSTRUMENTS.findIndex((i) => i.id === id);
		if (idx < 0 || idx === this.instrumentIndex) return;
		const from = INSTRUMENTS[this.instrumentIndex]?.id;
		this.instrumentIndex = idx;
		this.applyInstrument();
		instrumentIndexStore.save(this.instrumentIndex);
		trackEvent("instrument_changed", { from, to: id, method: "menu" });
	}

	private applyInstrument(): void {
		const info = INSTRUMENTS[this.instrumentIndex]!;
		this.controls.updateInstrument(t(info.nameKey));
		this.audioMenu?.setCurrent(info.id);
		// The instrument menu is a bulk-apply: it rewrites the voice of every
		// track that is currently AUDIBLE (the "open" ones). Closed tracks
		// keep the instrument they were assigned when they are re-opened.
		const midi = this.store.state.loadedMidi;
		if (midi) {
			for (const track of midi.tracks) {
				// Audible = not muted. Muted tracks keep their assigned voice.
				if (!this.synth.getDisabledTrackIds().has(track.id)) {
					this.synth.setTrackInstrument(track.id, info.id);
				}
			}
		}
		// The global voice still backs live MIDI input and any unassigned track.
		void this.synth.setInstrument(info.id);
		this.trackPanel?.refresh();
	}

	private cycleParticleStyle(): void {
		this.setParticleByIndex((this.particleIndex + 1) % PARTICLE_STYLES.length);
	}

	private setParticleByIndex(idx: number): void {
		if (idx < 0 || idx >= PARTICLE_STYLES.length || idx === this.particleIndex)
			return;
		this.particleIndex = idx;
		this.applyParticleStyle();
		particleIndexStore.save(idx);
		trackEvent("particle_changed", { style: PARTICLE_STYLES[idx]!.id });
	}

	private applyParticleStyle(): void {
		const info = PARTICLE_STYLES[this.particleIndex]!;
		for (const trackId of this.renderer.visibleTrackIds) {
			this.particleStyleByTrack[trackId] = this.particleIndex;
		}
		particleStyleByTrackStore.save(this.particleStyleByTrack);
		this.renderer.applyParticleStyleToVisibleTracks(info.id);
		this.customizeMenu?.setParticle(this.particleIndex);
		this.rollMenu?.setParticleIndex(this.particleIndex);
	}

	// 芒鈥濃偓芒鈥濃偓 Waterfall border 芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓芒鈥濃偓
	// Border style + colour are global 芒鈧?one setting applies to every track. The
	// colour override is null when "follow the track colour" (the restore state).
	private setBorderStyleByIndex(idx: number): void {
		if (
			idx < 0 ||
			idx >= BORDER_STYLE_IDS.length ||
			idx === this.borderStyleIndex
		)
			return;
		this.borderStyleIndex = idx;
		this.applyBorderStyle();
		borderStyleStore.save(idx);
		trackEvent("border_style_changed", {
			style: BORDER_STYLE_IDS[idx] ?? "none",
		});
	}

	private applyBorderStyle(): void {
		const style = BORDER_STYLE_IDS[this.borderStyleIndex]!;
		for (const trackId of this.renderer.visibleTrackIds) {
			this.borderStyleByTrack[trackId] = this.borderStyleIndex;
		}
		borderStyleByTrackStore.save(this.borderStyleByTrack);
		this.renderer.applyBorderStyleToVisibleTracks(style);
		this.customizeMenu?.setBorderStyle(this.borderStyleIndex);
	}

	private applyParticleColorOverride(): void {
		for (const trackId of this.renderer.visibleTrackIds) {
			this.particleColorByTrack[trackId] = this.particleColorOverride;
		}
		particleColorByTrackStore.save(this.particleColorByTrack);
		this.renderer.applyParticleColorToVisibleTracks(this.particleColorOverride);
	}

	private applyBorderColorOverride(): void {
		for (const trackId of this.renderer.visibleTrackIds) {
			this.borderColorByTrack[trackId] = this.borderColorOverride;
		}
		borderColorByTrackStore.save(this.borderColorByTrack);
		this.renderer.applyBorderColorToVisibleTracks(this.borderColorOverride);
		this.updateKeyboardColorsFromBorder(this.borderColorOverride);
	}

	private updateKeyboardColorsFromBorder(borderColor: number | null): void {
		const baseTheme = this.themeIndex < THEMES.length 
			? THEMES[this.themeIndex]! 
			: this.customTheme ?? THEMES[0]!;
		if (borderColor === null) {
			this.applyTheme(baseTheme);
			return;
		}
		const br = (borderColor >> 16) & 0xff;
		const bg = (borderColor >> 8) & 0xff;
		const bb = borderColor & 0xff;
		const mixRatio = 0.3;
		const mixColor = (def: number, ratio: number): number => {
			const dr = (def >> 16) & 0xff;
			const dg = (def >> 8) & 0xff;
			const db = def & 0xff;
			const r = Math.round(dr + (br - dr) * ratio);
			const g = Math.round(dg + (bg - dg) * ratio);
			const b = Math.round(db + (bb - db) * ratio);
			return (r << 16) | (g << 8) | b;
		};
		const modifiedTheme: Theme = {
			...baseTheme,
			whiteKey: mixColor(0xe8e8f0, mixRatio),
			whiteKeyActive: mixColor(0xb0b4ff, mixRatio * 1.5),
			blackKey: mixColor(0x1a1a2e, mixRatio),
			blackKeyActive: mixColor(0x5558cc, mixRatio * 1.2),
			keyBorder: borderColor,
		};
		this.applyTheme(modifiedTheme);
	}

	// Push saved per-track particle/border state into the renderer after a MIDI
	// loads. Tracks without a saved value fall back to the global default.
	// Called via renderer.onLoadMidi so the PlayMode effect path and the
	// error-recovery path (which calls renderer.loadMidi directly) stay in sync.
	private injectPerTrackState(tracks: MidiTrack[]): void {
		for (const track of tracks) {
			const psIdx = this.particleStyleByTrack[track.id] ?? this.particleIndex;
			this.renderer.setParticleStyleForTrack(
				track.id,
				PARTICLE_STYLES[psIdx]!.id,
			);
			const bsIdx = this.borderStyleByTrack[track.id] ?? this.borderStyleIndex;
			this.renderer.setBorderStyleForTrack(track.id, BORDER_STYLE_IDS[bsIdx]!);
			const pc =
				this.particleColorByTrack[track.id] ?? this.particleColorOverride;
			this.renderer.setParticleColorForTrack(track.id, pc);
			const bc = this.borderColorByTrack[track.id] ?? this.borderColorOverride;
			this.renderer.setBorderColorForTrack(track.id, bc);
		}
		// Fallback (live input) follows the global default.
		this.renderer.setFallbackParticleStyle(
			PARTICLE_STYLES[this.particleIndex]!.id,
		);
		this.renderer.setFallbackParticleColor(this.particleColorOverride);
		// MIDI (re)loaded — keep the roll dropdown's embedded track list and the
		// audio dropdown's per-track voice toggles in sync with the panel.
		this.refreshRollEmbed();
	}

	// Push the current override swatches (CSS or null) into the customize menu
	// so the colour circles reflect the saved state on boot and after changes.
	private syncCustomizeColorSwatches(): void {
		this.customizeMenu?.setParticleColor(
			this.particleColorOverride !== null
				? hexToCSS(this.particleColorOverride)
				: null,
		);
		this.customizeMenu?.setBorderColor(
			this.borderColorOverride !== null
				? hexToCSS(this.borderColorOverride)
				: null,
		);
		this.rollMenu?.setParticleIndex(this.particleIndex);
		this.rollMenu?.setParticleColorCss(
			this.particleColorOverride !== null
				? hexToCSS(this.particleColorOverride)
				: null,
		);
	}

	// Push saved painted-background state into the renderer + the customize
	// menu on boot. Values are persisted alongside the theme/particle stores.
	private restoreRendererBackgroundState(): void {
		const mode = backgroundModeStore.load();
		this.renderer.setBackgroundMode(mode);
		this.renderer.setBackgroundSolidColor(bgSolidColorStore.load());
		this.renderer.setBackgroundGlowColor(bgGlowColorStore.load());
		this.renderer.setBackgroundGlowIntensity(bgGlowIntensityStore.load());
		this.renderer.setBackgroundOpacity(bgOpacityStore.load());
		this.renderer.setBackgroundDrift(bgDriftStore.load());
	}

	private syncCustomizeBackgroundState(): void {
		this.customizeMenu?.setBackgroundModeIndex(
			BACKGROUND_MODES.findIndex((m) => m.id === backgroundModeStore.load()),
		);
		this.customizeMenu?.setBackgroundSolidColorCss(
			hexToCSS(bgSolidColorStore.load()),
		);
		this.customizeMenu?.setBackgroundGlowColorCss(
			hexToCSS(bgGlowColorStore.load()),
		);
		this.customizeMenu?.setBackgroundGlowIntensity(
			bgGlowIntensityStore.load(),
		);
		this.customizeMenu?.setBackgroundOpacity(bgOpacityStore.load());
		this.customizeMenu?.setBackgroundDrift(bgDriftStore.load());
	}

	private openBackgroundSolidColorPicker(): void {
		this.colorPicker.close();
		this.colorPicker.open({
			initialColor: bgSolidColorStore.load(),
			defaultColor: 0x0b0e14,
			trackName: "",
			scope: "background",
			anchorEl: this.customizeMenu?.trigger ?? null,
			onConfirm: (color) => {
				this.renderer.setBackgroundSolidColor(color);
				this.customizeMenu?.setBackgroundSolidColorCss(hexToCSS(color));
				bgSolidColorStore.save(color);
				trackEvent("background_solid_color_changed", {});
			},
			onReset: () => {
				const def = 0x0b0e14;
				this.renderer.setBackgroundSolidColor(def);
				this.customizeMenu?.setBackgroundSolidColorCss(hexToCSS(def));
				bgSolidColorStore.save(def);
			},
		});
	}

	private openBackgroundGlowColorPicker(): void {
		this.colorPicker.close();
		this.colorPicker.open({
			initialColor: bgGlowColorStore.load(),
			defaultColor: 0x3b82f6,
			trackName: "",
			scope: "background",
			anchorEl: this.customizeMenu?.trigger ?? null,
			onConfirm: (color) => {
				this.renderer.setBackgroundGlowColor(color);
				this.customizeMenu?.setBackgroundGlowColorCss(hexToCSS(color));
				bgGlowColorStore.save(color);
				trackEvent("background_glow_color_changed", {});
			},
			onReset: () => {
				const def = 0x3b82f6;
				this.renderer.setBackgroundGlowColor(def);
				this.customizeMenu?.setBackgroundGlowColorCss(hexToCSS(def));
				bgGlowColorStore.save(def);
			},
		});
	}

	// Custom flat colour for every note block (roll dropdown → NoteRenderer).
	private openNoteColorPicker(): void {
		this.colorPicker.close();
		this.colorPicker.open({
			initialColor: this.renderer.getCustomNoteColor(),
			defaultColor: 0x3b82f6,
			trackName: "",
			scope: "note",
			anchorEl: this.rollMenu?.trigger ?? null,
			onConfirm: (color) => {
				this.renderer.setNoteColorMode("custom", color);
				this.rollMenu?.setColorMode("custom");
				this.rollMenu?.setCustomColorCss(hexToCSS(color));
				noteColorModeStore.save({ mode: "custom", color });
				trackEvent("note_color_changed", { overridden: true });
			},
			onReset: () => {
				this.renderer.setNoteColorMode("track");
				this.rollMenu?.setColorMode("track");
				noteColorModeStore.save({ mode: "track", color: null });
				trackEvent("note_color_reset", { overridden: false });
			},
		});
	}

	// Keep the roll dropdown's embedded track list in sync with the shared
	// TrackPanel signals. Called after MIDI loads and on boot.
	private refreshRollEmbed(): void {
		this.rollMenu?.setEmbedProps(
			this.trackPanel.getEmbedProps({ onLoadNew: () => this.openFilePicker() }),
		);
		this.audioMenu?.setTracks(
			(this.store.state.loadedMidi?.tracks ?? []).map((tr) => ({
				id: tr.id,
				name: tr.name,
			})),
		);
		this.audioMenu?.setEnabledState(this.trackPanel.enabledStateFn);
	}

	// Push the current particle selection into the roll dropdown's effect row.
	private syncRollMenuParticleState(): void {
		this.rollMenu?.setParticleIndex(this.particleIndex);
		this.rollMenu?.setParticleColorCss(
			this.particleColorOverride !== null
				? hexToCSS(this.particleColorOverride)
				: null,
		);
	}

	// Default colour for the particle/border pickers = the first track's current
	// colour (the thing they re-bind to on restore). Falls back to theme accent
	// when no MIDI is loaded 芒鈧?keeps the picker meaningful in live mode.
	private currentTrackDefaultColor(): number {
		const midi = this.store.state.loadedMidi;
		if (midi && midi.tracks.length > 0) {
			// First visible track's colour (the one the picker re-binds to on
			// restore). Falls back to the first track if none are visible.
			const visibleIds = this.renderer.visibleTrackIds;
			const track =
				midi.tracks.find((t) => visibleIds.has(t.id)) ?? midi.tracks[0]!;
			const ov = this.renderer.getTrackColorOverride(track.id);
			return ov !== null
				? ov
				: getTrackColor(track, this.renderer.currentTheme);
		}
		return this.renderer.currentTheme.trackColors[0] ?? 0xffffff;
	}

	private openParticleColorPicker(): void {
		const defaultColor = this.currentTrackDefaultColor();
		this.colorPicker.close();
		this.colorPicker.open({
			initialColor: this.particleColorOverride ?? defaultColor,
			defaultColor,
			trackName: "",
			scope: "particle",
			anchorEl: this.customizeMenu?.trigger ?? null,
			onConfirm: (color) => {
				this.particleColorOverride = color;
				this.applyParticleColorOverride();
				this.customizeMenu?.setParticleColor(hexToCSS(color));
				particleColorStore.save(color);
				trackEvent("particle_color_changed", { overridden: true });
			},
			onReset: () => {
				this.particleColorOverride = null;
				this.applyParticleColorOverride();
				this.customizeMenu?.setParticleColor(null);
				particleColorStore.save(null);
				trackEvent("particle_color_reset", { overridden: false });
			},
		});
	}

	private openBorderColorPicker(): void {
		const defaultColor = this.currentTrackDefaultColor();
		this.colorPicker.close();
		this.colorPicker.open({
			initialColor: this.borderColorOverride ?? defaultColor,
			defaultColor,
			trackName: "",
			scope: "border",
			anchorEl: this.customizeMenu?.trigger ?? null,
			onConfirm: (color) => {
				this.borderColorOverride = color;
				this.applyBorderColorOverride();
				this.customizeMenu?.setBorderColor(hexToCSS(color));
				borderColorStore.save(color);
				trackEvent("border_color_changed", { overridden: true });
			},
			onReset: () => {
				this.borderColorOverride = null;
				this.applyBorderColorOverride();
				this.customizeMenu?.setBorderColor(null);
				borderColorStore.save(null);
				trackEvent("border_color_reset", { overridden: false });
			},
		});
	}

	private openCustomThemeColorPicker(): void {
		this.colorPicker.close();
		const rgb = hexToRgb(this.customColor);
		const initialColor = rgb ? (rgb.r << 16) | (rgb.g << 8) | rgb.b : 0x6366f1;
		// Switch to custom slot immediately when opening the picker
		if (this.themeIndex < THEMES.length) {
			this.setThemeByIndex(THEMES.length);
		}
		this.colorPicker.open({
			initialColor,
			defaultColor: 0x6366f1,
			trackName: "",
			scope: "theme",
			anchorEl: this.customizeMenu?.trigger ?? null,
			onChange: (color: number) => {
				// Real-time preview: update theme as user adjusts color
				const hex = rgbToHex(
					(color >> 16) & 0xff,
					(color >> 8) & 0xff,
					color & 0xff,
				);
				this.customColor = hex;
				this.customTheme = makeCustomTheme(hex);
				this.applyTheme(this.customTheme);
			},
			onConfirm: (color) => {
				const hex = rgbToHex(
					(color >> 16) & 0xff,
					(color >> 8) & 0xff,
					color & 0xff,
				);
				this.customColor = hex;
				customColorStore.save(hex);
				this.customTheme = makeCustomTheme(hex);
				this.applyTheme(this.customTheme);
			},
			onReset: () => {
				const hex = "#6366f1";
				this.customColor = hex;
				customColorStore.save(hex);
				this.customTheme = makeCustomTheme(hex);
				this.applyTheme(this.customTheme);
			},
		});
	}

	private setVelocityThreshold(v: number): void {
		if (v === this.velocityThreshold) return;
		this.velocityThreshold = v;
		this.applyVelocityThreshold();
		velocityThresholdStore.save(v);
		trackEvent("velocity_threshold_changed", { value: v });
	}

	private applyVelocityThreshold(): void {
		this.renderer.setVelocityThreshold(this.velocityThreshold / 100);
		this.customizeMenu?.setThreshold(this.velocityThreshold);
	}

	private setKeyboardColorMode(mode: 'note' | 'border'): void {
		this.keyboardColorMode = mode;
		keyboardColorModeStore.save(mode);
		this.renderer.setKeyboardColorMode(mode);
		this.customizeMenu?.setKeyboardColorMode(mode);
	}

	private async startExport(settings: ExportSettings): Promise<void> {
		const midi = this.store.state.loadedMidi;
		const exportModal = this.exportHandle.peek();
		if (!midi || this.store.state.mode !== "play") {
			// ExportModal.onStart has already switched the card to the progress
			// phase — bail out explicitly instead of leaving it hanging there.
			exportModal?.close();
			this.showError(t("error.export.noMidi"));
			return;
		}
		if (!exportModal) return;

		// Batch mode: each configured item runs through the single-item
		// pipeline (see startBatchExport). Quick mode is the plain path below.
		if (settings.mode === "batch" && (settings.batchItems?.length ?? 0) > 0) {
			await this.startBatchExport(midi, exportModal, settings);
			return;
		}
		await this.exportOne(midi, exportModal, settings, undefined);
	}

	/**
	 * Runs one configured export (a quick export, or a single item of a batch
	 * run). Everything between pausing playback and restoring it lives here, so
	 * a batch can simply loop over items with per-item prepare/restore.
	 * `batchCtx` is undefined for quick exports; batch items pass {index,total}
	 * so failures propagate to startBatchExport and per-item toast/close are
	 * deferred to the batch summary.
	 */
	private async exportOne(
		midi: MidiFile,
		exportModal: ExportModal,
		settings: ExportSettings,
		batchCtx: { index: number; total: number } | undefined,
	): Promise<void> {
		const exportStartedAt = performance.now();
		// One settings shape shared across started / completed / failed so the
		// funnel can be sliced by social-format settings without a join. `stage`
		// is advanced as the pipeline progresses and reported on failure.
		const exportBase = {
			output: settings.output,
			resolution: settings.resolution,
			fps: settings.fps,
			focus: settings.focus,
			speed: settings.speed,
			midi_duration_s: Math.round(midi.duration),
			...(batchCtx
				? { batch_index: batchCtx.index, batch_total: batchCtx.total }
				: {}),
		};
		let exportStage: "serialize" | "audio_render" | "video_prepare" | "video_encode" =
			"serialize";
		let exportVideoUrl: string | null = null;
		track("export_started", exportBase);
		trackActivation("export_started");

		// MIDI-only output skips all render/encode work 隆陋 just re-serialise the
		// loaded MidiFile to .mid bytes. Especially useful after "Open in file
		// mode" from a live session, where the raw .mid was never downloaded.
		if (settings.output === "midi") {
			const hasOverrides = this.renderer.getBarLineOverrides().size > 0;
			const bytes = await midiFileToBytes(midi, hasOverrides ? (t) => this.renderer.remapTime(t) : undefined);
			triggerMidiDownload(bytes, `${sanitiseFilename(midi.name)}.mid`);
			if (!batchCtx) {
				exportModal.close();
				this.showSuccess(`隆媒 ${sanitiseFilename(midi.name)}.mid`);
			}
			track("export_completed", {
				...exportBase,
				elapsed_ms: Math.round(performance.now() - exportStartedAt),
			});
			return;
		}

		const wasPlaying = this.store.state.status === "playing";
		// Snapshot the playhead so we can restore position after export instead of
		// snapping back to t=0.
		const resumeAt = this.clock.currentTime;
		this.clock.pause();
		this.liveNotes.reset();
		this.synth.liveReleaseAll();
		this.store.setState("status", "exporting");
		this.synth.pause();
		// The metronome schedules clicks on its own look-ahead timer against the
		// *global* Tone context 隆陋 left running, it would keep scheduling straight
		// through OfflineAudioRenderer's setContext() swap into the offline
		// render. Stop it for the duration; restored in the finally below.
		const metronomeWasRunning = this.metronome.running.value;
		this.metronome.stop();
		this.renderer.pauseAutoRender();

		const needsVideo = settings.output !== "audio-only";
		const needsAudio = settings.output !== "video-only";

		// Only resize the canvas when we're actually rendering video.
		const originalCanvas = this.renderer.canvasSize;
		// For video-native resolution, use the imported video's original dimensions
		const videoDims = needsVideo && settings.resolution === 'video-native'
			? this.videoTranscoder.getCachedVideoInfo()
			: null;
		let target = needsVideo ? resolveExportDims(settings.resolution, videoDims) : null;
		// Override with video dimensions if matchCanvasToVideo is enabled
		if (settings.matchCanvasToVideo && videoDims && needsVideo) {
			target = { width: videoDims.width, height: videoDims.height };
		}
		const resized =
			target !== null &&
			(target.width !== originalCanvas.width ||
				target.height !== originalCanvas.height);
		if (target !== null) {
			this.renderer.resize(target.width, target.height, 1);
		}

		// Scale keyboard height proportionally to export resolution
		// 4K (2160p) should have 2x the keyboard height of 1080p
		const originalKeyboardHeight = this.renderer.currentKeyboardHeight;
		let keyboardHeightChanged = false;
		if (target !== null) {
			const scaleFactor = target.height / 1080;
			if (scaleFactor !== 1) {
				const scaledKeyboardHeight = Math.round(originalKeyboardHeight * scaleFactor);
				this.renderer.setKeyboardHeight(scaledKeyboardHeight);
				keyboardHeightChanged = true;
			}
		}

		// Snapshot viewport state so we can restore after export. Vertical/Square
		// exports optionally zoom onto the piece's pitch range + override scroll
		// speed for a more cinematic feel; landscape exports leave both untouched.
		const originalPps = this.renderer.currentPixelsPerSecond;
		const originalRange = this.renderer.pitchRange;
		const isSocialFormat =
			needsVideo &&
			(settings.resolution === "vertical" || settings.resolution === "square");
		let pitchChanged = false;
		let ppsChanged = false;
		if (needsVideo) {
			if (isSocialFormat && settings.focus === "fit") {
				const fit = fitPitchRange(midi);
				this.renderer.setPitchRange(fit.min, fit.max);
				pitchChanged = true;
			}
			// Apply current zoom from the floating control bar to all export formats
			const pps = speedToPps(settings.speed);
			if (pps !== originalPps) {
				this.renderer.setZoom(pps);
				ppsChanged = true;
			}
		}

		// Compute adjusted duration if bar line overrides exist
		const hasBarOverrides = this.renderer.getBarLineOverrides().size > 0;
		const exportDuration = hasBarOverrides
			? this.renderer.getAdjustedDuration()
			: midi.duration;

		// Batch items get a numbered stem (midee-1, midee-2, ...) so multiple
		// downloads don't overwrite each other; quick exports keep "midee".
		const stem = settings.midiName ?? "midee";
		const filename =
			settings.output === "audio-only"
				? `${stem}.${settings.audioFormat}`
				: `${stem}.mp4`;

		try {
			let audioBuffer: AudioBuffer | undefined;
			if (needsAudio) {
				// Load without VideoExporter: that chunk embeds Mediabunny (~tens of kB
				// parsed) and must not run before / in parallel with offline audio setup.
				const { renderAudioOffline } = await import(
					"./audio/OfflineAudioRenderer"
				);
				exportStage = "audio_render";
				exportModal.updateProgress("Rendering audio", 0);
				try {
					// Per-stage progress: pct flows straight through. The bar resets
					// between stages; the stage label makes that explicit.
					audioBuffer = await renderAudioOffline({
						midi,
						instrumentId: INSTRUMENTS[this.instrumentIndex]!.id,
						volume: this.store.state.volume,
						disabledTrackIds: this.synth.getDisabledTrackIds(),
						trackInstruments: this.synth.getTrackInstrumentMap(),
						reverbWet: this.synth.getReverbWet(),
						onRenderAudioProgressMode: (d) =>
							exportModal.setRenderAudioProgressMode(d),
						onProgress: (pct) =>
							exportModal.updateProgress("Rendering audio", pct),
					});
				} catch (err) {
					console.error("Offline audio render failed:", err);
					// Audio-only has nothing to export without it 隆陋 surface the error.
					if (settings.output === "audio-only") throw err;
					// av / video-only continue silently without sound 隆陋 a real quality
					// hit that was previously invisible. Mark it as a degradation.
					trackEvent("export_degraded", {
						stage: "audio_render",
						output: settings.output,
					});
					this.showError(t("error.audio.renderFailed"));
				}
			}

			// Audio-only ships WAV or MP3 隆陋 both are macOS-Gatekeeper-safe legacy audio
			// types (unlike the MP4-container .m4a this replaced) and need no codec. Trim
			// the offline render's tail to midi.duration first so the file isn't ~1.5s too
			// long, then download directly 隆陋 no VideoExporter. MP3's encoder (lamejs) is
			// dynamic-imported so it stays out of the initial bundle.
			if (settings.output === "audio-only") {
				if (!audioBuffer)
					throw new Error("Audio-only export requires a rendered audio buffer");
				const trimmed = trimAudioBuffer(audioBuffer, exportDuration);
				let bytes: Uint8Array;
				let mime: string;
				if (settings.audioFormat === "wav") {
					bytes = audioBufferToWav(trimmed);
					mime = "audio/wav";
				} else {
					const { audioBufferToMp3 } = await import("./export/mp3");
					bytes = audioBufferToMp3(trimmed);
					mime = "audio/mpeg";
				}
				const url = URL.createObjectURL(
					new Blob([bytes.slice().buffer], { type: mime }),
				);
				const a = document.createElement("a");
				a.href = url;
				a.download = filename;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 5000);
				if (!batchCtx) {
					exportModal.close();
					this.showSuccess(`隆媒 ${t("toast.export.ready", { filename })}`);
				}
				track("export_completed", {
					...exportBase,
					elapsed_ms: Math.round(performance.now() - exportStartedAt),
				});
				return;
			}

			// Prepare high-quality video source for export (if video background is present)
			let exportVideoUrl: string | null = null
			if (needsVideo && this.originalVideoFile && this.renderer.isVideoLoaded) {
				exportStage = "video_prepare"
				exportModal.updateProgress('Preparing video', 0)
				exportVideoUrl = URL.createObjectURL(this.originalVideoFile)
				await this.renderer.swapVideoSrc(exportVideoUrl)
				exportModal.updateProgress('Preparing video', 100)
			}

			exportStage = "video_encode";
			const { VideoExporter } = await import("./export/VideoExporter");
			const exporter = new VideoExporter(this.renderer.canvas);
			this.currentExporter = exporter;

			const exportAudio =
				audioBuffer && settings.output === "av"
					? trimAudioBuffer(audioBuffer, exportDuration)
					: audioBuffer;

			await exporter.export({
				fps: settings.fps,
				duration: exportDuration,
				mode: settings.output,
				filename,
				bitrate: resolveExportBitrate(settings.resolution, target),
				...(settings.codec ? { codec: settings.codec } : {}),
				...(exportAudio ? { audio: exportAudio } : {}),
				onSeek: (t) => this.clock.seek(t),
				onRenderFrame: async (t, dt) => {
					// If bar line overrides exist, map export time back to original time for rendering
					const renderTime = hasBarOverrides ? this.renderer.inverseRemapTime(t) : t;
					await this.renderer.renderManualFrame(renderTime, dt);
				},
				onProgress: (stage, pct) => exportModal.updateProgress(stage, pct),
			});
			if (!batchCtx) {
				exportModal.close();
				this.showSuccess(`隆媒 ${t("toast.export.ready", { filename })}`);
			}
			track("export_completed", {
				...exportBase,
				elapsed_ms: Math.round(performance.now() - exportStartedAt),
			});
		} catch (err) {
			const isCancel = err instanceof DOMException && err.name === "AbortError";
			if (!isCancel) {
				console.error("Export failed:", err);
				if (!batchCtx) this.showError((err as Error).message || t("error.export.generic"));
			}
			track(isCancel ? "export_cancelled" : "export_failed", {
				...exportBase,
				stage: exportStage,
				elapsed_ms: Math.round(performance.now() - exportStartedAt),
			});
			if (batchCtx) {
				// Batch: propagate so startBatchExport can count the failure
				// (AbortError also propagates — the batch loop treats it as
				// "user cancelled, stop the run").
				throw err;
			}
			exportModal.close();
		} finally {
			this.currentExporter = null;
			// Restore proxy video if we swapped to original
			if (exportVideoUrl) {
				URL.revokeObjectURL(exportVideoUrl)
				if (this.originalVideoUrl) {
					await this.renderer.swapVideoSrc(this.originalVideoUrl)
				}
			}
			if (target !== null) {
				// Match window dimensions instead of the stale originalCanvas values
				// in case the window was resized while we were exporting.
				this.renderer.resize(
					window.innerWidth,
					window.innerHeight,
					originalCanvas.resolution,
				);
			}
			if (pitchChanged)
				this.renderer.setPitchRange(originalRange.min, originalRange.max);
			if (ppsChanged) this.renderer.setZoom(originalPps);
			// Restore with the auto floor so a narrow-window auto height (as low
			// as KEYBOARD_HEIGHT_AUTO_MIN) isn't re-clamped up to 80 on restore.
			if (keyboardHeightChanged)
				this.renderer.setKeyboardHeight(originalKeyboardHeight, KEYBOARD_HEIGHT_AUTO_MIN);
			this.renderer.resumeAutoRender();
			this.clock.seek(resumeAt);
			if (metronomeWasRunning) this.metronome.start();
			this.store.setState("status", "ready");
			if (wasPlaying) {
				this.clock.play();
				this.store.setState("status", "playing");
			}
		}
	}

	/**
	 * Batch entry point: loops over the configured items and runs each through
	 * exportOne. An item's video/audio checkboxes map to the output type
	 * (av / video-only / audio-only); waterfall/instrument are carried through
	 * in customOptions for future per-layer rendering control — the renderer
	 * doesn't expose layer visibility yet, so they don't change the picture
	 * today (renderer layer TODO). A single failing item doesn't stop the
	 * batch; the user's Cancel (AbortError) stops the whole run.
	 */
	private async startBatchExport(
		midi: MidiFile,
		exportModal: ExportModal,
		settings: ExportSettings,
	): Promise<void> {
		const items = (settings.batchItems ?? []).filter(
			(item) => item.video || item.audio,
		);
		if (items.length === 0) {
			exportModal.close();
			this.showError(t("export.batch.noItems"));
			return;
		}
		let ok = 0;
		const failures: string[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			const output: ExportOutput =
				item.video && item.audio
					? "av"
					: item.video
						? "video-only"
						: "audio-only";
			const itemSettings: ExportSettings = {
				...settings,
				mode: "quick",
				output,
				customOptions: {
					video: item.video,
					audio: item.audio,
					waterfall: item.waterfall,
					instrument: item.instrument,
				},
				midiName: `midee-${i + 1}`,
			};
			try {
				await this.exportOne(midi, exportModal, itemSettings, {
					index: i,
					total: items.length,
				});
				ok++;
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					// User cancelled — stop the whole batch run.
					break;
				}
				const msg = err instanceof Error ? err.message : String(err);
				failures.push(`${itemSettings.midiName} (${output}): ${msg}`);
				console.error(`Batch item ${i + 1}/${items.length} failed:`, err);
			}
		}
		exportModal.close();
		if (ok > 0) this.showSuccess(t("export.batch.complete", { n: ok }));
		if (failures.length > 0) {
			this.showError(
				`${t("export.batch.failed", { n: failures.length })} — ${failures.join("; ")}`,
			);
		}
	}

	private cancelExport(): void {
		this.currentExporter?.cancel();
	}

	// Entry point for every "open MIDI" action 隆陋 top strip button, track panel,
	// play-mode entry without a loaded file, learn-hub upload CTA. Routes through
	// the unified `MidiPickerModal` (drop / file picker / samples).
	//
	// `target` pins the destination at *call time*, not at file-pick time. This
	// matters because `requestMode('play')` from Learn opens the picker without
	// Import audio/video file for background playback
	// Import audio/video file for background playback
	async importMedia(): Promise<void> {
		const modal = await this.midiPickerHandle.get()
		modal.open({
			mode: 'media',
			onFile: (file, progress) => this.handleMediaFile(file, progress),
		})
	}

	async importLyrics(): Promise<void> {
		const modal = await this.midiPickerHandle.get()
		modal.open({
			mode: 'lyrics',
			onFile: async (file, progress) => {
				try {
					const text = await file.text()
					const cues = parseSubtitleFile(file.name, text)
					if (cues.length === 0) {
						this.showError(t('error.lyrics.empty'))
						return
					}
					this.renderer.setSubtitle(cues)
					this.customizeMenu.setHasLyrics(true)
					this.showSuccess(t('toast.lyrics.importSuccess', { count: cues.length }))
				} catch (err) {
					console.error('Lyrics import failed:', err)
					this.showError(t('error.lyrics.empty'))
				}
			},
		})
	}

	clearLyrics(): void {
		this.renderer.clearSubtitle()
		this.customizeMenu.setHasLyrics(false)
	}

	private async handleMediaFile(file: File, progress?: (percent: number, status?: string) => void): Promise<void> {
		this.isTranscoding = true
		this.originalVideoFile = file
		const isAudio = file.type.startsWith('audio/')
		const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|bmp|apng)$/i.test(file.name)
		
		const report = (percent: number, status?: string) => {
			progress?.(percent, status)
		}
		
		try {
			if (isAudio) {
				const url = URL.createObjectURL(file)
				this.renderer.setVideoBackground(url, true)
				this.customizeMenu.setHasAudio(true)
				this.customizeMenu.setHasVideo(false)
				this.hasImportedAudio = true
				report(100, '脥锚鲁脡')
				this.showSuccess(t('toast.media.importSuccess.audio'))
				return
			}

			if (isImage) {
				const url = URL.createObjectURL(file)
				try {
					await this.renderer.setImageBackground(url, /\.gif$/i.test(file.name))
				} catch (err) {
					console.error('Image background import failed:', err)
					this.showError(t('error.media.importFailed'))
					return
				}
				// Image + audio can coexist (image is visual, audio is sound);
				// image + video are mutually exclusive (both fill the bottom slot).
				this.customizeMenu.setHasImage(true)
				this.customizeMenu.setHasVideo(false)
				this.hasImportedAudio = false
				report(100, '脥锚鲁脡')
				this.showSuccess(t('toast.media.importSuccess.image'))
				return
			}
			
			report(10, '露脕脠隆脢脫脝碌脰脨...')
			
			const info = await this.videoTranscoder.getVideoInfo(file)
			const midi = this.store.state.loadedMidi
			const midiDuration = midi?.duration || 0
			
			// Trim window (in the ORIGINAL file) is owned by the renderer's
			// time-axis mapping — the transcode below only compresses (the
			// ffmpeg.wasm path silently ignores startTime/endTime in passthrough
			// mode, and cutting here would fight the renderer mapping anyway).
			let startTime = 0
			let endTime = info.duration
			if (midiDuration > 0 && info.duration > midiDuration) {
				startTime = 0
				endTime = midiDuration
				console.log('[app] Auto-trimming video from', info.duration, 'to', midiDuration, 'seconds')
			}
			
			this.customizeMenu.setVideoDuration(endTime - startTime)
			report(30, '麓娄脌铆脢脫脝碌脰脨...')
			
			const _startTime = Date.now()
			const transcodeOpts: import('./services/VideoTranscoder').TranscodeOptions = {
				input: file,
				maxWidth: 480,
				maxFps: 15,
				onProgress: (p) => {
					report(30 + Math.round(p * 0.6), '脳陋脗毛脰脨...')
				}
			}
			const url = await this.videoTranscoder.transcode(transcodeOpts)
			
			const _elapsed = Date.now() - _startTime
			if (_elapsed < 800) {
				await new Promise(r => setTimeout(r, 800 - _elapsed))
			}
			report(95, '录麓陆芦脥锚鲁脡...')
			this.originalVideoUrl = url
			
			this.renderer.setVideoBackground(url, false)
			// Auto-trim tail (video longer than MIDI) via the renderer mapping;
			// untrimmed keeps (0,0) = whole file.
			if (endTime > 0 && endTime < info.duration) {
				this.renderer.setVideoTrimRange(0, endTime)
			} else {
				this.renderer.setVideoTrimRange(0, 0)
			}
			
			this.customizeMenu.setHasVideo(true)
			this.customizeMenu.setHasAudio(false)
			this.customizeMenu.setHasImage(false)
			this.hasImportedAudio = false
			
			report(100, '脥锚鲁脡')
			this.showSuccess(t('toast.media.importSuccess.video'))
		} catch (err) {
			console.error('Media import failed:', err)
			this.showError(t('error.media.importFailed'))
		} finally {
			this.isTranscoding = false
		}
	}

	private showVideoImportProgress(progress: number, statusText?: string): void {
		if (!this.progressOverlay) {
			this.progressOverlay = document.createElement('div')
			this.progressOverlay.className = 'video-import-progress'
			this.progressOverlay.innerHTML = `
				<div class="video-import-progress__title">碌录脠毛脢脫脝碌</div>
				<div class="video-import-progress__bar">
					<div class="video-import-progress__fill" style="width: 0%"></div>
				</div>
				<div class="video-import-progress__text">脳录卤赂脰脨...</div>
			`
			document.body.appendChild(this.progressOverlay)
		}

		const fill = this.progressOverlay.querySelector('.video-import-progress__fill') as HTMLDivElement
		const text = this.progressOverlay.querySelector('.video-import-progress__text') as HTMLDivElement

		if (fill) {
			fill.style.width = `${progress}%`
		}
		if (text) {
			if (statusText) {
				text.textContent = statusText
			} else if (progress < 10) {
				text.textContent = '脳录卤赂脰脨...'
			} else if (progress < 30) {
				text.textContent = `露脕脠隆脢脫脝碌脰脨... ${Math.round(progress)}%`
			} else if (progress < 90) {
				text.textContent = `麓娄脌铆脰脨... ${Math.round(progress)}%`
			} else if (progress < 100) {
				text.textContent = '录麓陆芦脥锚鲁脡...'
			} else {
				text.textContent = '脥锚鲁脡拢隆'
			}
		}
	}

	private hideVideoImportProgress(): void {
		if (this.progressOverlay) {
			this.progressOverlay.remove()
			this.progressOverlay = null
		}
	}

	// flipping the mode (we don't want a half-set-up Play surface flashing while
	// the user is still choosing). If we read `store.state.mode` inside the
	// file callback, it would still be 'learn' and the file would route to
	// LearnController instead of Play. Explicit target avoids the race.
	openFilePicker(target?: "play" | "learn"): void {
		const resolveTarget = (): "play" | "learn" =>
			target ?? (this.store.state.mode === "learn" ? "learn" : "play");
		void this.midiPickerHandle.get().then((modal) => {
			modal.open({
				mode: 'midi',
				onFile: (file, _progress) => {
					// Report progress for MIDI loading
					_progress(10, '陆芒脦枚 MIDI...')
					if (resolveTarget() === "learn") {
						void this.ensureLearnController().then((c) =>
							c.loadMidiFromFile(file, "picker"),
						);
					} else {
						void this.loadMidi(file, "picker");
					}
					_progress(100, '脥锚鲁脡')
				},
				onSample: (id) => {
					if (resolveTarget() === "learn") {
						void this.ensureLearnController().then((c) => c.loadSample(id));
					} else {
						void this.loadSample(id);
					}
				},
			});
		});
	}

	// Thin delegation wrapper 隆陋 AppCtx exposes this method so callers
	// (createApp.ts, Solid mode components) don't need to know about the
	// lazyHandle indirection.
	ensureLearnController(): Promise<LearnController> {
		return this.learnControllerHandle.get();
	}

	private capturePreviewFrame(): string | null {
		const midi = this.store.state.loadedMidi;
		if (!midi) return null;
		// Render frame at middle of MIDI
		const middleTime = midi.duration / 2;
		this.renderer.renderStaticFrame(middleTime);
		return this.renderer.canvas.toDataURL('image/jpeg', 0.8);
	}

	private openExportModal(): void {
		if (!this.store.state.loadedMidi || this.store.state.mode !== "play") {
			// Don't open the export card at all without something to export —
			// previously it opened, switched to the progress phase on submit,
			// and silently returned, leaving the card stuck.
			this.showError(t("error.export.noMidi"));
			return;
		}
		void this.exportHandle.get().then((m) => {
			// Pass cached video info so the modal can show video-native resolution option
			const info = this.videoTranscoder.getCachedVideoInfo();
			if (info) {
				m.setVideoInfo({ width: info.width, height: info.height, fps: info.fps });
			} else {
				m.setVideoInfo(null);
			}
			// Pass audio import state so the modal can conditionally show audio export options
			m.setAudioInfo(this.hasImportedAudio);
			// Capture preview frame at middle of MIDI
			m.setPreviewFrameCallback(() => this.capturePreviewFrame());
			m.open();
		});
	}

	// Play-mode sample loader. Learn has its own via LearnController.loadSample.
	private async loadSample(sampleId: string): Promise<void> {
		const sample = getSample(sampleId);
		if (!sample) return;
		this.primeInteractiveAudio();
		let midi: Awaited<ReturnType<typeof fetchSampleMidi>>;
		try {
			midi = await fetchSampleMidi(sample);
		} catch (err) {
			console.error("[loadSample] fetch failed", err);
			trackEvent("sample_load_failed", { sample_id: sampleId, target: "play" });
			this.showError(t("error.sample.fetchFailed"));
			return;
		}
		this.loadSessionAsFile(midi);
		this.resetPlaybackTelemetry();
		trackMidiLoaded({
			source: "sample",
			sampleId,
			trackCount: midi.tracks.length,
			noteCount: countNotes(midi),
			durationS: Math.round(midi.duration),
		});
		// Samples are a "watch it" gesture 隆陋 start playback as soon as the synth
		// is ready. Sample click counts as the user gesture that unlocks audio.
		setTimeout(() => {
			if (
				this.store.state.mode === "play" &&
				this.store.state.status !== "playing"
			) {
				this.clock.play();
				this.store.setState("status", "playing");
			}
		}, 250);
	}

	private requestMode(mode: Exclude<AppMode, "home">): void {
		if (mode === "live") {
			this.enterLiveMode();
			return;
		}
		if (mode === "learn") {
			// Re-clicking Learn while already inside an exercise pops back to the
			// hub. closeActiveExercise is idempotent (no-op when no runner) so this
			// is safe to call regardless of prior state.
			const lc = this.learnControllerHandle.peek();
			if (this.store.state.mode === "learn" && lc) {
				lc.closeActiveExercise("abandoned");
				return;
			}
			this.store.setState("mode", "learn");
			return;
		}
		if (this.store.state.loadedMidi) {
			this.enterPlayMode();
			return;
		}
		// Pin the target 隆陋 without it, the picker would read `state.mode` at
		// file-pick time and (if we came here from Learn) route the file back
		// into Learn instead of opening it in Play. The user clicked Play; honor
		// that even if their mode hasn't flipped yet.
		this.openFilePicker("play");
	}

	// Hands the currently-loaded Play MIDI off to Learn and switches modes.
	// Queueing on the controller (instead of relying on Learn re-reading
	// `loadedMidi`) keeps Learn's MIDI store decoupled from Play's 隆陋 the whole
	// reason LearnController has its own `learnState` in the first place.
	private enterLearnWithCurrentMidi(): void {
		const midi = this.store.state.loadedMidi;
		if (!midi) return;
		track("learn_from_play", { duration_s: Math.round(midi.duration) });
		void this.ensureLearnController().then((c) => {
			c.queueMidi(midi);
			this.store.setState("mode", "learn");
		});
	}

	// Thin delegators: each flips the store and lets Solid's mode shell run
	// the side effects (onMount in HomeMode/PlayMode/LiveMode/LearnMode).
	private enterHomeMode(): void {
		this.store.enterHome();
	}

	private enterLiveMode(primeAudio = true): void {
		setNextLiveOpts({ primeAudio });
		this.store.enterLive();
	}

	private enterPlayMode(): void {
		this.store.enterPlay();
	}

	// Schedules a UI side-effect to run at (roughly) the AudioContext time
	// `ctxTime`. Used so the visual press of a loop-played note lands with the
	// audio instead of up to 150 ms early when the scheduler runs ahead.
	private deferToCtxTime(ctxTime: number, fn: () => void): void {
		const ctxNow = this.synth.audioContextTime;
		const delayMs = Math.max(0, (ctxTime - ctxNow) * 1000);
		if (delayMs < 2) {
			fn();
			return;
		}
		setTimeout(fn, delayMs);
	}

	private toggleSessionRecord(): void {
		if (!this.sessionRec.recording.value) {
			this.primeInteractiveAudio();
			this.sessionRec.start();
			track("session_started");
			return;
		}
		const { events, duration } = this.sessionRec.stop();
		if (events.length === 0) {
			this.showError(t("toast.recording.empty"));
			track("session_record_empty");
			return;
		}
		// Hold the recording in memory and let the user pick next steps 隆陋 saving
		// a .mid, flipping into file mode to visualize + export MP4, or tossing it.
		this.pendingSession = { events, duration };
		const noteCount = events.reduce((n, e) => n + (e.type === "on" ? 1 : 0), 0);
		void this.postSessionHandle.get().then((m) => m.open(duration, noteCount));
		track("session_recorded", {
			duration_s: Math.round(duration),
			notes: noteCount,
		});
	}

	private async handleSessionAction(action: SessionAction): Promise<void> {
		const pending = this.pendingSession;
		// onAction only fires from inside the modal; if it ran, the modal exists.
		this.postSessionHandle.peek()?.close();
		if (!pending) return;

		track("session_action", {
			action,
			duration_s: Math.round(pending.duration),
		});

		if (action === "discard") {
			this.pendingSession = null;
			return;
		}

		if (action === "download") {
			const bytes = await encodeCapturedEvents(pending.events, {
				bpm: this.metronomeBpm(),
				closeOrphansAt: pending.duration,
				midiName: "midee session",
				trackName: "Live performance",
			});
			triggerMidiDownload(bytes, "midee-session.mid");
			this.showSuccess(
				`隆媒 ${t("toast.session.saved", { seconds: Math.round(pending.duration) })}`,
			);
			this.pendingSession = null;
			return;
		}

		if (action === "open-in-file") {
			const midi = sessionToMidiFile(
				pending.events,
				pending.duration,
				this.metronomeBpm(),
				`Live session 隆陇 ${Math.round(pending.duration)}s`,
			);
			this.pendingSession = null;
			this.loadSessionAsFile(midi);
		}
	}

	// Drops the live-session MidiFile into the same play-mode pipeline used by
	// imported .mid files 隆陋 so it immediately plays back as a rolling piano roll
	// with MP4 / WAV export available. Same contract as loadMidi(): after
	// completePlayLoad, <PlayMode/>'s effect owns the surface side effects
	// (renderer.loadMidi, trackPanel.render, dropzone.hide,
	// keyboardInput.enable, document.title) 隆陋 don't repeat them here.
	private loadSessionAsFile(midi: import("./core/midi/types").MidiFile): void {
		this.resetInteractionState();
		this.store.beginPlayLoad();
		this.renderer.clearMidi();
		this.synth
			.load(midi)
			.catch((err) => console.error("SynthEngine.load failed:", err));
		this.store.completePlayLoad(midi);
		this.resetPlaybackTelemetry();
	}

	private async saveLoopAsMidi(): Promise<void> {
		const snap = this.liveLooper.snapshot();
		if (snap.events.length === 0) return;
		const bytes = await encodeCapturedEvents(snap.events, {
			bpm: this.metronomeBpm(),
			closeOrphansAt: snap.duration,
			midiName: "midee loop",
			trackName: "Loop",
		});
		triggerMidiDownload(bytes, "midee-loop.mid");
		this.showSuccess(`隆媒 ${t("toast.loop.saved")}`);
		track("loop_saved", {
			duration_s: Math.round(snap.duration),
			layers: this.liveLooper.layerCount.value,
		});
	}

	private metronomeBpm(): number {
		return this.metronome.bpm.value;
	}

	// 漏陇漏陇 Chord overlay 漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇漏陇
	private toggleChordOverlay(): void {
		this.chordOverlayOn = !this.chordOverlayOn;
		this.applyChordOverlayVisibility();
		this.customizeMenu?.setChord(this.chordOverlayOn);
		chordOverlayStore.save(this.chordOverlayOn);
		track("chord_overlay_toggled", { on: this.chordOverlayOn });
		if (this.chordOverlayOn && this.chordOverlay.isVisible) {
			// Force a fresh reading on toggle-on so the user sees a chord (or "隆陋")
			// immediately, even if the clock isn't ticking right now. Only the
			// throttle timestamp is reset 隆陋 chordLastSig must stay in lockstep
			// with the overlay's displayed reading (see maybeUpdateChordOverlay),
			// so if the held pitches changed while the overlay was off this call
			// sees a signature mismatch and repaints.
			this.chordLastRunMs = 0;
			this.maybeUpdateChordOverlay(this.clock.currentTime);
		}
	}

	// Effective visibility = user's saved preference AND current mode supports it.
	// Play mode is excluded 隆陋 the chord readout is a "what am I playing?" cue,
	// not a passive playback annotation.
	private applyChordOverlayVisibility(): void {
		const allowedHere = this.store.state.mode !== "play";
		this.chordOverlay.setVisible(this.chordOverlayOn && allowedHere);
	}

	// Builds the active-pitch set from the right sources for the current mode,
	// detects a chord, and pushes it to the overlay. Gated on the overlay being
	// *visible* 隆陋 not just the saved preference 隆陋 because in play mode (where
	// the overlay never shows) collectActivePitches scans every elapsed note,
	// and the preference defaults to on for everyone. The whole body sits
	// behind the ~70ms throttle for the same reason: chords don't change at
	// 60 fps, so the worst-case readout latency is imperceptible while the
	// per-tick scan is not free on long files.
	//
	// Invariant: `chordLastSig` always matches what the overlay displays 隆陋
	// they are only ever written together below. Callers must not reset the
	// signature independently or a skipped update leaves a stale reading.
	private maybeUpdateChordOverlay(time: number): void {
		if (!this.chordOverlayOn || !this.chordOverlay.isVisible) return;
		const now = performance.now();
		if (now - this.chordLastRunMs < 70) return;
		this.chordLastRunMs = now;
		const pitches = this.collectActivePitches(time);
		const sig = pitchSignature(pitches);
		if (sig === this.chordLastSig) return;
		this.chordLastSig = sig;
		this.chordOverlay.update(detectChord(pitches));
	}

	private collectActivePitches(currentTime: number): Set<number> {
		const set = new Set<number>();
		const mode = this.store.state.mode;

		// Live performance 隆陋 what the player and looper are pressing right now.
		// Learn counts here too: the user plays along, so the chord readout should
		// narrate their held notes (the visibility gate already allows non-play).
		if (mode === "live" || mode === "home" || mode === "learn") {
			for (const [pitch] of this.liveNotes.heldNotes) set.add(pitch);
			for (const [pitch] of this.loopNotes.heldNotes) set.add(pitch);
			return set;
		}

		if (mode === "play") {
			// Play mode 隆陋 every visible-track note overlapping the playhead, plus
			// any live-keyboard notes the user is playing alongside the file.
			const midi = this.store.state.loadedMidi;
			if (midi) {
				for (const track of midi.tracks) {
					if (!this.renderer.isTrackVisible(track.id)) continue;
					if (track.isDrum) continue;
					for (const note of track.notes) {
						if (note.time > currentTime) break;
						if (note.time + note.duration > currentTime) set.add(note.pitch);
					}
				}
			}
			for (const [pitch] of this.liveNotes.heldNotes) set.add(pitch);
		}
		return set;
	}

	resetInteractionState(): void {
		this.clock.pause();
		this.clock.seek(0);
		this.synth.pause();
		this.synth.seek(0);
		this.liveNotes.reset();
		this.loopNotes.reset();
		this.liveLooper.clear();
		this.sessionRec.cancel();
		this.metronome.stop();
		this.synth.liveReleaseAll();
		this.closeTransientOverlays();
	}

	// Dismiss every modal-style overlay so mode switches and fresh-load flows
	// don't leave a stale picker / export / post-session card floating over the
	// new surface. Idempotent 隆陋 `.close()` is a no-op when the modal is already
	// hidden. Popovers (instrument menu, customize) close themselves on the
	// outside click that triggered the transition.
	private closeTransientOverlays(): void {
		this.exportHandle.peek()?.close();
		this.postSessionHandle.peek()?.close();
		this.midiPickerHandle.peek()?.close();
	}

	primeInteractiveAudio(): void {
		if (this.audioPrimed) return;
		this.audioPrimed = true;
		this.clock.prime();
		this.synth.primeLiveInput();
		window.removeEventListener("pointerdown", this.onFirstPointerDown);
		window.removeEventListener("keydown", this.onFirstKeyDown);
	}

	private saveTrackColorOverride(trackId: string, color: number | null): void {
		const all = this.trackColorStore.load();
		if (color === null) delete all[trackId];
		else all[trackId] = color;
		this.trackColorStore.save(all);
	}

	private restoreTrackColorOverrides(): void {
		const stored = this.trackColorStore.load();
		const map = new Map<string, number>();
		for (const [id, color] of Object.entries(stored)) {
			map.set(id, color);
		}
		this.renderer.setTrackColorOverrides(map);
	}

	private applyTheme(theme: Theme): void {
		this.renderer.setTheme(theme);
		this.customizeMenu?.setTheme(this.themeIndex);
		this.trackPanel?.setTheme(theme);
		const accent = theme.uiAccentCSS;
		document.documentElement.style.setProperty("--accent", accent);
		document.documentElement.style.setProperty("--accent-soft", `${accent}2e`);
		document.documentElement.style.setProperty("--accent-glow", `${accent}66`);
		// Refresh TrackPanel so per-track swatches reflect the new theme colours.
		this.trackPanel?.refresh();
	}

	private showLoading(): void {
		this.loadingEl = document.createElement("div");
		this.loadingEl.id = "loading-overlay";
		this.loadingEl.innerHTML = `
      <div class="loading-inner">
        <div class="loading-spinner"></div>
        <div class="loading-text">Loading隆颅</div>
      </div>
    `;
		document.querySelector("#ui-overlay")!.appendChild(this.loadingEl);
	}

	private hideLoading(): void {
		this.loadingEl?.remove();
		this.loadingEl = null;
	}

	private showError(message: string): void {
		showError(message);
	}

	private showSuccess(message: string): void {
		showSuccess(message);
	}

	dispose(): void {
		for (const unsub of this.unsubs) unsub();
		this.unsubs = [];
		this.releaseAllLiveNotes();
		document.removeEventListener("visibilitychange", this.onVisibilityChange);
		window.removeEventListener("blur", this.onWindowBlur);
		window.removeEventListener("pointerdown", this.onFirstPointerDown);
		window.removeEventListener("keydown", this.onFirstKeyDown);
		this.renderer.canvas.removeEventListener(
			"pointerdown",
			this.onCanvasPointerDown,
		);
		this.renderer.canvas.removeEventListener(
			"pointermove",
			this.onCanvasPointerMove,
		);
		this.renderer.canvas.removeEventListener(
			"pointerup",
			this.onCanvasPointerUp,
		);
		this.renderer.canvas.removeEventListener(
			"pointercancel",
			this.onCanvasPointerUp,
		);
		this.renderer.canvas.removeEventListener(
			"pointerleave",
			this.onCanvasPointerUp,
		);
		this.dropzone.dispose();
		this.controls.dispose();
		this.kbdResizer.dispose();
		this.midiInput.dispose();
		this.keyboardInput.dispose();
		this.liveLooper.dispose();
		this.sessionRec.dispose();
		this.metronome.dispose();
		this.chordOverlay.dispose();
		this.customizeMenu.dispose();
		this.disposeRotateHint?.();
		this.disposeRotateHint = null;
		this.clock.dispose();
		this.renderer.destroy();
		this.synth.dispose();
	}

	async applyVideoTrim(startTime: number, endTime: number): Promise<void> {
		if (!this.originalVideoFile) return
		if (endTime <= startTime) {
			console.warn('[app] applyVideoTrim: invalid window', startTime, endTime)
			return
		}
		
		// Trim is applied as a time-axis mapping on the renderer (the transcode
		// path ignores startTime/endTime when ffmpeg.wasm is unavailable, and
		// the imported element is already the compressed full-length copy), so
		// this is instant — playback, seek and export all map through the same
		// [startTime, endTime] window.
		this.renderer.setVideoTrimRange(startTime, endTime)
		this.customizeMenu.setVideoDuration(endTime - startTime)
		this.customizeMenu.setFrontTrim(0)
		this.customizeMenu.setBackTrim(0)
		this.showSuccess(t('toast.videoTrimApplied'))
	}
}

// User-preference persistence. Each entry exposes load()/save() backed by
// localStorage. Defined here (not in persistence.ts) because the defaults
// depend on runtime values 隆陋 current theme list, instrument list, etc.
const themeIndexStore = indexPersisted(
	"midee.themeIndex",
	Math.max(
		0,
		THEMES.findIndex((t) => t.name === "Sunset"),
	),
	THEMES.length + 1,
);
const customColorStore = jsonPersisted<string>(
	"midee.customThemeColor",
	"#6366f1",
);
// New visitors default to Upright (1.2 MB of self-hosted samples) so first-load
// is fast. Returning users keep whatever they had, including Salamander Grand.
const instrumentIndexStore = indexPersisted(
	"midee.instrumentIndex",
	Math.max(
		0,
		INSTRUMENTS.findIndex((i) => i.id === "upright"),
	),
	INSTRUMENTS.length,
);
const particleIndexStore = indexPersisted(
	"midee.particleIndex",
	Math.max(
		0,
		PARTICLE_STYLES.findIndex((s) => s.id === "embers"),
	),
	PARTICLE_STYLES.length,
);
const metronomeBpmStore = numberPersisted("midee.metronomeBpm", 120, 40, 240);
// Chord readout defaults *on*: it's the headline live-mode cue. The
// boolean store treats "no preference" as the fallback (true), and only
// an explicit "false" turns it off.
const chordOverlayStore = booleanPersisted("midee.chordOverlay", true);
const velocityThresholdStore = numberPersisted(
	"midee.velocityThreshold",
	0,
	-100,
	100,
);
const borderStyleStore = indexPersisted(
	"midee.borderStyle",
	2,
	BORDER_STYLE_IDS.length,
);
// null = follow the track colour; a number = global override for every track.
const particleColorStore = jsonPersisted<number | null>(
	"midee.particleColor",
	null,
);
const borderColorStore = jsonPersisted<number | null>(
	"midee.borderColor",
	null,
);
const keyboardColorModeStore = jsonPersisted<'note' | 'border'>(
	"midee.keyboardColorMode",
	"note",
	(v) => (v === 'note' || v === 'border' ? v : 'note'),
);
// Per-track persisted state (one entry per trackId). Tracks not in the
// record fall back to the global stores above.
const particleStyleByTrackStore = jsonPersisted<Record<string, number>>(
	"midee.particleStyleByTrack",
	{},
);
const borderStyleByTrackStore = jsonPersisted<Record<string, number>>(
	"midee.borderStyleByTrack",
	{},
);
const particleColorByTrackStore = jsonPersisted<Record<string, number | null>>(
	"midee.particleColorByTrack",
	{},
);
const borderColorByTrackStore = jsonPersisted<Record<string, number | null>>(
	"midee.borderColorByTrack",
	{},
);
// Waterfall note-block look (corner radius as share of shortest side + colour
// mode), audio ambience (reverb wet), and painted background state — all new
// with the roll/audio/background dropdown restructure.
const cornerRatioStore = numberPersisted("midee.noteCornerRatio", 0.35, 0, 0.5);
const noteColorModeStore = jsonPersisted<{
	mode: "track" | "custom";
	color: number | null;
}>(
	"midee.noteColorMode",
	{ mode: "track", color: null },
	(v) =>
		v &&
		(v.mode === "track" || v.mode === "custom") &&
		typeof v.color === "number"
			? v
			: { mode: "track", color: null },
);
const reverbWetStore = numberPersisted("midee.reverbWet", 0.2, 0, 1);
const backgroundModeStore = jsonPersisted<BackgroundMode>(
	"midee.backgroundMode",
	"theme",
	(v) => (BACKGROUND_MODES.some((m) => m.id === v) ? v : "theme"),
);
const bgSolidColorStore = jsonPersisted<number>(
	"midee.backgroundSolidColor",
	0x0b0e14,
);
const bgGlowColorStore = jsonPersisted<number>(
	"midee.backgroundGlowColor",
	0x3b82f6,
);
const bgGlowIntensityStore = numberPersisted(
	"midee.backgroundGlowIntensity",
	0.5,
	0,
	1,
);
const bgOpacityStore = numberPersisted("midee.backgroundOpacity", 1, 0.05, 1);
const bgDriftStore = numberPersisted("midee.backgroundDrift", 0, 0, 1);

// Strips characters that misbehave in filenames across Windows/macOS/Linux.
// Falls back to a constant if the result is empty.
function sanitiseFilename(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|]+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : "midee";
}


