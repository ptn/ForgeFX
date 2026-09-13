// MIDI note-name math shared by the tuner paths (gen-3 registry fallback + the AM4 tuner read).
// C=0, equal temperament. Both consumers historically inlined the same NOTE_NAMES + `%12` wrap.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number → pitch-class name (handles negatives). */
export function midiNoteName(midi: number): string { return NOTE_NAMES[((midi % 12) + 12) % 12]!; }
