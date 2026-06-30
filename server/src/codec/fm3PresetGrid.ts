// Gen-3 Fractal preset-dump decoder → routing grid + placed blocks.
//
// Ported from ForgeFX's own hardware-validated C# Fm3PresetCodec (crcValid on FM3),
// which reimplements the Apache-2.0 reference codec in TheAndrewStaker/mcp-midi-control
// (packages/fractal-gen3/src/preset{Dump,Huffman,Body}.ts), itself crediting BoodieTraps'
// `fractal-syx-codec`. Attribution retained per Apache-2.0 (see NOTICE).
//
// Pipeline: 0x78 chunks → reassemble (3 wire bytes → u16) → 16384B raw_patch →
// CRC16/CCITT check + dynamic-Huffman body → grid @ body 0x104 (column-major, 2 words/cell).

import { AXE_FX_III_BLOCKS } from 'fractal-midi/gen3/axe-fx-iii';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

// raw_patch field offsets
const CRC_OFFSET = 0x04;
const DECOMP_SIZE_OFFSET = 0x48;
const COMP_SIZE_OFFSET = 0x4a;
const BODY_OFFSET = 0x4c;
const CRC_INIT = 0xaa55;

// decompressed-body offsets
const GRID_BASE = 0x104;
const SCENE_NAME_BASE = 0x04;

export interface GridCell {
  effectId: number;
  row: number;
  col: number;
  routeFlag: number;
  name: string;
  isShunt: boolean;
  fromRows: number[];
}
export interface DecodedPreset {
  modelId: number;
  modelName: string;
  name: string;
  crcValid: boolean;
  rows: number;
  cols: number;
  grid: GridCell[];
  sceneNames: string[];
}

const DIMS: Record<number, { rows: number; cols: number; name: string }> = {
  0x10: { rows: 6, cols: 14, name: 'Axe-Fx III' },
  0x11: { rows: 4, cols: 12, name: 'FM3' },
  0x12: { rows: 6, cols: 14, name: 'FM9' }
};

/** Decode a preset dump (array of SysEx frames, each F0..F7) into grid + metadata. */
export function decodePresetDump(frames: readonly (readonly number[])[], expectedModel?: number): DecodedPreset {
  const { modelId, chunks } = collectChunks(frames, expectedModel);
  const rawPatch = reassemble(chunks);

  const storedCrc = u16(rawPatch, CRC_OFFSET);
  const computedCrc = computeCrc(rawPatch);
  const decompSize = u16(rawPatch, DECOMP_SIZE_OFFSET);
  const compSize = u16(rawPatch, COMP_SIZE_OFFSET);

  const comp = rawPatch.subarray(BODY_OFFSET, BODY_OFFSET + Math.min(compSize, rawPatch.length - BODY_OFFSET));
  const body = huffmanUncompress(comp, decompSize);

  const dim = DIMS[modelId] ?? { rows: 4, cols: 12, name: `model_0x${modelId.toString(16)}` };
  const grid = body.length >= 0x1c4 ? parseGrid(body, dim.rows, dim.cols) : [];
  const sceneNames = readSceneNames(body);
  const name = asciiName(rawPatch, 0x08, 32);

  return { modelId, modelName: dim.name, name, crcValid: storedCrc === computedCrc, rows: dim.rows, cols: dim.cols, grid, sceneNames };
}

/** Decompressed preset body (+ model + grid), for per-block param decoding. The body holds each
 *  block's params after the grid region (0x104..); exposes the internals decodePresetDump consumes. */
export function decodePresetBody(frames: readonly (readonly number[])[], expectedModel?: number): { modelId: number; body: Uint8Array; decompSize: number } {
  const { modelId, chunks } = collectChunks(frames, expectedModel);
  const rawPatch = reassemble(chunks);
  const decompSize = u16(rawPatch, DECOMP_SIZE_OFFSET);
  const compSize = u16(rawPatch, COMP_SIZE_OFFSET);
  const comp = rawPatch.subarray(BODY_OFFSET, BODY_OFFSET + Math.min(compSize, rawPatch.length - BODY_OFFSET));
  return { modelId, body: huffmanUncompress(comp, decompSize), decompSize };
}

// Amp model in the decompressed body — device-diff confirmed (setType N → byte at 0x123c = N exactly).
// u16 LE; the amp's 4 channels (A-D) are at +0x120 (288) stride. (FM3 layout, model 0x11.)
const AMP_MODEL_OFFSET = 0x123c;
const AMP_CHANNEL_STRIDE = 0x120;
/** The amp model ordinal for each of the 4 channels (A-D). Map via FM3_ROSTERS.amp for names. */
export function readAmpModels(body: Uint8Array): number[] {
  const out: number[] = [];
  for (let n = 0; n < 4; n++) {
    const o = AMP_MODEL_OFFSET + n * AMP_CHANNEL_STRIDE;
    if (o + 1 < body.length) out.push(body[o]! | (body[o + 1]! << 8));
  }
  return out;
}

// ---- 1. dump frames → 0x78 chunk payloads ----
function collectChunks(frames: readonly (readonly number[])[], expectedModel?: number) {
  const chunks: number[][] = [];
  let modelId = expectedModel ?? 0;
  for (const f of frames) {
    if (f.length < 8 || f[0] !== SYSEX_START || f[f.length - 1] !== SYSEX_END) continue;
    if (f[1] !== 0x00 || f[2] !== 0x01 || f[3] !== 0x74) continue;
    const model = f[4]!;
    const func = f[5]!;
    if (modelId === 0) modelId = model;
    if (func === 0x78) chunks.push(f.slice(6, f.length - 2)); // payload between func and checksum
  }
  if (chunks.length === 0) throw new Error('no 0x78 preset chunks found in dump');
  return { modelId, chunks };
}

// ---- 2. reassemble 3-byte-septet chunk image → raw_patch ----
function reassemble(chunks: number[][]): Uint8Array {
  const words: number[] = [];
  for (const c of chunks) {
    const n = Math.floor((c.length - 2) / 3);
    for (let k = 0; k < n; k++) {
      const o = 2 + k * 3;
      words.push((c[o]! | (c[o + 1]! << 7) | (c[o + 2]! << 14)) & 0xffff);
    }
  }
  const img = new Uint8Array(words.length * 2);
  for (let k = 0; k < words.length; k++) {
    img[k * 2] = words[k]! & 0xff;
    img[k * 2 + 1] = (words[k]! >> 8) & 0xff;
  }
  return img;
}

// ---- 3. dynamic-Huffman decompression ----
interface HuffNode {
  value: number; // >=0 leaf, -1 internal
  left?: HuffNode;
  right?: HuffNode;
}
class BitReader {
  #data: Uint8Array;
  #pos = 0;
  #bit = 0;
  constructor(data: Uint8Array) {
    this.#data = data;
  }
  get exhausted() {
    return this.#pos >= this.#data.length;
  }
  readBit(): number {
    const b = this.#pos < this.#data.length ? this.#data[this.#pos]! : 0;
    const out = (b >> (7 - this.#bit)) & 1;
    if (++this.#bit === 8) {
      this.#bit = 0;
      this.#pos++;
    }
    return out;
  }
  readByteValue(): number {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | this.readBit();
    return v;
  }
}
function buildTree(r: BitReader): HuffNode {
  if (r.readBit() === 1) return { value: r.readByteValue() };
  const left = buildTree(r);
  const right = buildTree(r);
  return { value: -1, left, right };
}
function huffmanUncompress(data: Uint8Array, outputSize: number): Uint8Array {
  if (data.length === 0 || outputSize <= 0) return new Uint8Array(0);
  const r = new BitReader(data);
  const root = buildTree(r);
  const out = new Uint8Array(outputSize);
  let i = 0;
  for (; i < outputSize && !r.exhausted; i++) {
    let node = root;
    while (node.value < 0) node = (r.readBit() === 1 ? node.right : node.left)!;
    out[i] = node.value & 0xff;
  }
  return i === outputSize ? out : out.subarray(0, i);
}

// ---- 4. grid parse (column-major, 2 words/cell) ----
function parseGrid(body: Uint8Array, rows: number, cols: number): GridCell[] {
  const wordsPerCol = rows * 2;
  const cells: GridCell[] = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const idx = col * wordsPerCol + row * 2;
      const eid = u16(body, GRID_BASE + idx * 2);
      const flag = u16(body, GRID_BASE + (idx + 1) * 2);
      if (eid === 0) continue;
      const isShunt = eid > 1000;
      const name = isShunt ? `Shunt ${eid - 1023}` : effectName(eid) ?? `eid_${eid}`;
      const fromRows: number[] = [];
      for (let r = 0; r < rows; r++) if (flag & (1 << r)) fromRows.push(r);
      cells.push({ effectId: eid, row, col, routeFlag: flag, name, isShunt, fromRows });
    }
  }
  return cells;
}

// grid effect-id → family base; instances 1..4 are base..base+3
const EFFECT_BASES: Record<number, string> = {
  37: 'Input', 42: 'Output', 46: 'Comp', 50: 'GEQ', 54: 'PEQ', 58: 'Amp', 62: 'Cab', 66: 'Reverb',
  70: 'Delay', 74: 'MultiTap', 78: 'Chorus', 82: 'Flanger', 86: 'Rotary', 90: 'Phaser', 94: 'Wah',
  98: 'Formant', 102: 'Vol/Pan', 106: 'Tremolo', 110: 'Pitch', 114: 'Filter', 118: 'Drive',
  122: 'Enhancer', 126: 'Mixer', 130: 'Synth', 138: 'Megatap', 146: 'Gate', 150: 'RingMod',
  154: 'MultiComp', 158: 'Ten-Tap', 162: 'Resonator', 166: 'Looper', 178: 'Plex Delay',
  182: 'Send', 186: 'Return', 191: 'Multiplexer'
};
export function effectName(eid: number): string | null {
  if (EFFECT_BASES[eid]) return `${EFFECT_BASES[eid]} 1`;
  for (const [baseId, name] of Object.entries(EFFECT_BASES)) {
    const d = eid - Number(baseId);
    if (d > 0 && d <= 3) return `${name} ${d + 1}`;
  }
  return null;
}

// EFFECT_BASES base name → editor pack slug (lowercased pack key the client sends).
// This is the authoritative, complete roster — eid→slug no longer depends on a def pack existing.
const BASE_SLUG: Record<string, string> = {
  Input: 'input', Output: 'output', Comp: 'comp', GEQ: 'geq', PEQ: 'peq', Amp: 'amp', Cab: 'cab',
  Reverb: 'reverb', Delay: 'delay', MultiTap: 'multitap', Chorus: 'chorus', Flanger: 'flanger',
  Rotary: 'rotary', Phaser: 'phaser', Wah: 'wah', Formant: 'formant', 'Vol/Pan': 'volume',
  Tremolo: 'tremolo', Pitch: 'pitch', Filter: 'filter', Drive: 'drive', Enhancer: 'enhancer',
  Mixer: 'mixer', Synth: 'synth', Megatap: 'megatap', Gate: 'gate', RingMod: 'ringmod',
  MultiComp: 'multicomp', 'Ten-Tap': 'tentap', Resonator: 'resonator', Looper: 'looper',
  'Plex Delay': 'plex', Send: 'send', Return: 'return', Multiplexer: 'multiplexer'
};
// Friendly palette names for the EFFECT_BASES base keys (else the base key is used as-is).
const PRETTY_NAME: Record<string, string> = {
  Comp: 'Compressor', MultiComp: 'Multiband Comp', PEQ: 'Parametric EQ', GEQ: 'Graphic EQ',
  'Vol/Pan': 'Volume/Pan', RingMod: 'Ring Modulator', MultiTap: 'Multitap Delay',
  Megatap: 'Megatap Delay', 'Ten-Tap': 'Ten-Tap Delay', Drive: 'Drive', Cab: 'Cab',
  Send: 'Send', Return: 'Return'
};

// How many consecutive instances each family supports (Amp 1..N), from the v1.4 spec catalog.
// `instance_N_id = firstId + (N-1)`. Most families = 4, Input = 5; the device (and the per-device
// `maxInstances` cap in the profile) is the final arbiter of how many are actually placeable.
const GROUP_SLUG: Record<string, string> = {
  IN: 'input', OUT: 'output', CMP: 'comp', GEQ: 'geq', PEQ: 'peq', AMP: 'amp', CAB: 'cab',
  REV: 'reverb', DLY: 'delay', MTD: 'multitap', CHO: 'chorus', FLG: 'flanger', ROT: 'rotary',
  PHA: 'phaser', WAH: 'wah', FRM: 'formant', VOL: 'volume', PTR: 'tremolo', PIT: 'pitch',
  FIL: 'filter', FUZ: 'drive', ENH: 'enhancer', MIX: 'mixer', SYN: 'synth', MGD: 'megatap',
  GAT: 'gate', RNG: 'ringmod', MBC: 'multicomp', TTD: 'tentap', RES: 'resonator', LPR: 'looper',
  PLX: 'plex', SND: 'send', RTN: 'return', MUX: 'multiplexer'
};
const INSTANCE_COUNT: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const b of AXE_FX_III_BLOCKS) {
    const slug = GROUP_SLUG[b.groupCode];
    if (slug) out[slug] = b.instances;
  }
  return out;
})();
/** Number of addressable instances a block family supports (default 4 if unlisted). */
export const blockInstances = (slug: string): number => INSTANCE_COUNT[slug.toLowerCase()] ?? 4;

/** Full placeable-block roster from the authoritative base table: { slug, name, page=base eid }. */
export function effectRoster(): { slug: string; name: string; page: number }[] {
  return Object.entries(EFFECT_BASES)
    .map(([id, base]) => ({ slug: BASE_SLUG[base] ?? base.toLowerCase(), name: PRETTY_NAME[base] ?? base, page: Number(id) }))
    .filter((e) => !!e.slug)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** effect id → { slug, instance } (1-based), or null for shunts / unknown / clear (eid 0). */
export function blockRefForEid(eid: number): { slug: string; instance: number } | null {
  if (EFFECT_BASES[eid]) {
    const slug = BASE_SLUG[EFFECT_BASES[eid]];
    return slug ? { slug, instance: 1 } : null;
  }
  for (const [baseId, name] of Object.entries(EFFECT_BASES)) {
    const d = eid - Number(baseId);
    if (d > 0 && d <= 3) {
      const slug = BASE_SLUG[name];
      return slug ? { slug, instance: d + 1 } : null;
    }
  }
  return null;
}

/** effect id (base..base+3) → editor pack slug, from the decoder's authoritative base table. */
export function slugForEffectId(eid: number): string | null {
  if (EFFECT_BASES[eid]) return BASE_SLUG[EFFECT_BASES[eid]] ?? null;
  for (const [baseId, name] of Object.entries(EFFECT_BASES)) {
    const d = eid - Number(baseId);
    if (d > 0 && d <= 3) return BASE_SLUG[name] ?? null;
  }
  return null;
}

// ---- helpers ----
function readSceneNames(body: Uint8Array): string[] {
  const scenes: string[] = [];
  if (body.length >= 0x104) for (let i = 0; i < 8; i++) scenes.push(asciiName(body, SCENE_NAME_BASE + i * 32, 32));
  return scenes;
}
function u16(b: Uint8Array, off: number): number {
  return off + 1 < b.length ? (b[off]! | (b[off + 1]! << 8)) & 0xffff : 0;
}
function asciiName(data: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && start + i < data.length; i++) {
    const b = data[start + i]!;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.trim();
}
// CRC-16/CCITT (poly 0x1021, MSB-first), CRC field treated as zero.
function computeCrc(rawPatch: Uint8Array): number {
  const tmp = Uint8Array.from(rawPatch);
  tmp[CRC_OFFSET] = 0;
  tmp[CRC_OFFSET + 1] = 0;
  let crc = CRC_INIT;
  for (const bb of tmp) {
    crc ^= (bb << 8) & 0xffff;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? ((crc << 1) ^ 0x1021) : crc << 1) & 0xffff;
  }
  return crc;
}
