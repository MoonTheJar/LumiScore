// GM program number → project instrument mapping.
//
// MIDI files carry a General MIDI program number (0–127) per track when the
// author included a Program Change event. @tonejs/midi exposes it as
// `track.instrument.number` and marks percussion tracks via
// `track.instrument.percussion`. This module maps those GM numbers onto the
// project's 13 instruments (see src/audio/instruments.ts), falling back to
// 'piano' when the track carries no usable identifier — the "default piano"
// the user asked for.

import type { InstrumentId } from '../../audio/instruments'

// GM1 instrument families, bucketed by program number. Keys are closed
// inclusive ranges [start, end]; the value is the closest project voice.
const GM_FAMILY_RANGES: ReadonlyArray<readonly [start: number, end: number, instrument: InstrumentId]> = [
  // 0–7 Piano family
  [0, 3, 'piano'], // acoustic grands + honky-tonk
  [4, 7, 'rhodes'], // electric pianos, harpsichord, clavinet
  // 8–15 Chromatic percussion
  [8, 11, 'bells'], // celesta, glockenspiel, music box, vibraphone
  [12, 15, 'marimba'], // marimba, xylophone, tubular bells, dulcimer
  // 16–23 Organ family → closest keyed voice is the digital stage piano
  [16, 23, 'digital'],
  // 24–31 Guitar family
  [24, 31, 'guitar'],
  // 32–39 Bass family
  [32, 39, 'bass'],
  // 40–47 Strings family — solo bowed strings use the violin sample set,
  // ensemble/plucked strings fall to the synth strings patch.
  [40, 43, 'violin'],
  [44, 47, 'strings'],
  // 48–55 Ensemble → synth strings section
  [48, 55, 'strings'],
  // 56–63 Brass → no brass voice; the sustained sawtooth strings patch is the
  // closest long-note approximation.
  [56, 63, 'strings'],
  // 64–79 Reed + Pipe families → flute voice (no woodwind beyond flute)
  [64, 71, 'flute'],
  [72, 79, 'flute'],
  // 80–87 Synth leads → bright digital keys
  [80, 87, 'digital'],
  // 88–95 Synth pads + 96–103 FX → pad
  [88, 103, 'pad'],
  // 104–111 Ethnic/misc → mallet voice reads closest for plucked folk timbres
  [104, 111, 'marimba'],
  // 112–127 Percussive + sound effects → short pluck as a percussive stand-in
  [112, 127, 'pluck'],
]

// GM drums have no per-instrument program meaning that maps onto our voices;
// the short percussive pluck is the closest stand-in.
const DRUM_INSTRUMENT: InstrumentId = 'pluck'

// Default when a track has no program change / the number is out of range.
// Deliberately 'piano' (not the app's boot voice 'upright'): per the product
// requirement, unlabelled tracks should get the default piano.
const DEFAULT_INSTRUMENT: InstrumentId = 'piano'

export function gmProgramToInstrument(program: number, isDrum: boolean): InstrumentId {
  if (isDrum) return DRUM_INSTRUMENT
  for (const [start, end, instrument] of GM_FAMILY_RANGES) {
    if (program >= start && program <= end) return instrument
  }
  return DEFAULT_INSTRUMENT
}
