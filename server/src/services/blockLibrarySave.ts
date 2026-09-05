// Save a block back to a caller-selected `.blk` library — the write twin of
// blockLibraryImport.ts + editorCacheDiscovery.ts#discoverBlockFiles. The
// effectTypeId table + folder names are the editor's own category enum (validated
// on load — a wrong id makes the editor refuse the file), confirmed 1:1 against the
// author's 25-category FM3-Edit library. Node-only (node:fs) — imported by app.ts
// only, never the runtime/browser graph (see check-browser-safe.ts).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeGen3BlockFile } from 'forgefx-midi/devices/gen3';

/** effectTypeId + the category folder a block of that family saves under. */
export interface EffectTypeInfo {
  effectTypeId: number;
  folder: string;
}

/** editor pack slug → effectTypeId + library folder. Only the ids confirmed against the real
 *  library are mapped; anything else refuses to save (the editor would reject a guessed id). */
const EFFECT_TYPE_BY_SLUG: Readonly<Record<string, EffectTypeInfo>> = Object.freeze({
  comp: { effectTypeId: 7, folder: 'Compressor' },
  geq: { effectTypeId: 8, folder: 'Graphic EQ' },
  peq: { effectTypeId: 9, folder: 'Parametric EQ' },
  amp: { effectTypeId: 10, folder: 'Amplifier' },
  cab: { effectTypeId: 11, folder: 'Cabinet' },
  reverb: { effectTypeId: 12, folder: 'Reverb' },
  delay: { effectTypeId: 13, folder: 'Delay' },
  multitap: { effectTypeId: 14, folder: 'Multi Delay' },
  plex: { effectTypeId: 15, folder: 'Plex Delay' },
  chorus: { effectTypeId: 16, folder: 'Chorus' },
  flanger: { effectTypeId: 17, folder: 'Flanger' },
  rotary: { effectTypeId: 18, folder: 'Rotary' },
  phaser: { effectTypeId: 19, folder: 'Phaser' },
  wah: { effectTypeId: 20, folder: 'Wahwah' },
  tremolo: { effectTypeId: 22, folder: 'Tremolo-Panner' },
  pitch: { effectTypeId: 23, folder: 'Pitch Shifter' },
  filter: { effectTypeId: 24, folder: 'Filter' },
  drive: { effectTypeId: 25, folder: 'Drive' },
  enhancer: { effectTypeId: 26, folder: 'Enhancer' },
  mixer: { effectTypeId: 28, folder: 'Mixer' },
  return: { effectTypeId: 30, folder: 'Feedback Return' },
  synth: { effectTypeId: 31, folder: 'Synth' },
  megatap: { effectTypeId: 33, folder: 'Megatap Delay' },
  gate: { effectTypeId: 35, folder: 'Gate-Expander' },
  ringmod: { effectTypeId: 36, folder: 'Ring Modulator' },
  multicomp: { effectTypeId: 37, folder: 'Multiband Compressor' },
  tentap: { effectTypeId: 38, folder: 'Ten-Tap Delay' },
  resonator: { effectTypeId: 39, folder: 'Resonator' },
  volume: { effectTypeId: 40, folder: 'Volume-Pan' },
  input: { effectTypeId: 41, folder: 'Input 1' },
  looper: { effectTypeId: 50, folder: 'Looper' },
  multiplexer: { effectTypeId: 54, folder: 'Multiplex Delay' },
});

/** Resolve a block's pack slug to its editor effect-type id + library folder, or null (refuse). */
export function effectTypeForSlug(slug: string | undefined | null): EffectTypeInfo | null {
  if (!slug) return null;
  return EFFECT_TYPE_BY_SLUG[slug.toLowerCase()] ?? null;
}

/** Human-readable family name for a pack slug — used only to make the refusal message actionable. */
const SLUG_LABEL: Readonly<Record<string, string>> = Object.freeze({
  amp: 'Amp', cab: 'Cab', chorus: 'Chorus', comp: 'Compressor', delay: 'Delay', drive: 'Drive',
  enhancer: 'Enhancer', filter: 'Filter', flanger: 'Flanger', formant: 'Formant', gate: 'Gate',
  geq: 'Graphic EQ', input: 'Input', looper: 'Looper', megatap: 'Megatap Delay', mixer: 'Mixer',
  multicomp: 'Multiband Compressor', multiplexer: 'Multiplexer', multitap: 'Multi Delay',
  output: 'Output', peq: 'Parametric EQ', phaser: 'Phaser', pitch: 'Pitch', plex: 'Plex Delay',
  resonator: 'Resonator', return: 'Return', reverb: 'Reverb', ringmod: 'Ring Modulator',
  rotary: 'Rotary', send: 'Send', synth: 'Synth', tentap: 'Ten-Tap Delay', tremolo: 'Tremolo',
  volume: 'Volume/Pan', wah: 'Wah'
});

export function slugLabel(slug: string | undefined | null): string {
  if (!slug) return 'unknown block';
  return SLUG_LABEL[slug.toLowerCase()] ?? slug;
}

/** Validate + normalize a user-supplied block name into a safe filename / `.blk` name.
 *  Returns null when the name is unusable. Truncates to 40 chars (caller-friendly). */
export function sanitizeBlockName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (/[^\x20-\x7e]/.test(name)) return null; // printable ASCII only (the `.blk` name is 7-bit)
  if (/[\x00-\x1f/\\]/.test(name)) return null; // control chars + path separators
  if (name === '.' || name === '..' || name.startsWith('.')) return null;
  return name.slice(0, 40);
}

/** Everything needed to author one `.blk` file from a captured block. */
export interface SaveBlockSpec {
  modelId: number;
  firmware: { major: number; minor: number };
  effectTypeId: number;
  activeChannel: number;
  name: string;
  payload: number[];
}

/** Author the `.blk` bytes (fileVersion 5, exact payloadByteLength, XOR trailer). */
export function buildBlockLibraryFile(spec: SaveBlockSpec): Uint8Array {
  return writeGen3BlockFile({
    modelId: spec.modelId,
    firmware: spec.firmware,
    effectTypeId: spec.effectTypeId,
    xyState: spec.activeChannel,
    name: spec.name,
    payload: spec.payload,
  });
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface WriteResult {
  path: string;
  category: string;
  name: string;
}

/** Write `.blk` bytes to `<blocksDir>/<folder>/<name>_<timestamp>.blk`, creating the category
 *  folder if needed. Refuses to overwrite an existing file unless `overwrite` is set (the timestamp
 *  makes collisions rare; the check is the plan's explicit-overwrite rule). */
export function writeBlockLibraryFile(
  blocksDir: string,
  info: EffectTypeInfo,
  name: string,
  bytes: Uint8Array,
  overwrite: boolean,
): WriteResult {
  const dir = join(blocksDir, info.folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}_${timestamp()}.blk`);
  if (!overwrite && existsSync(path)) {
    throw Object.assign(new Error('a block with that name was just saved — retry or allow overwrite'), { code: 'EXISTS', path });
  }
  writeFileSync(path, bytes);
  return { path, category: info.folder, name };
}
