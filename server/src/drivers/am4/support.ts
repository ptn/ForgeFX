// AM4 driver primitives: byte helpers, the fn-0x1F preset-structure parse, and the small label
// maps shared by the driver's DTO builders. Split out of am4.ts (C3) — no device/transport state here.
import { BLOCK_NAMES_BY_VALUE, resolveBlockTypeValue, RAW_INT_NONE_SENTINEL, type Param } from 'forgefx-midi/am4';
import { decodeAm4PresetDumpBytes } from 'forgefx-midi/devices/am4';
import type { Am4Slot, EnumParam } from '../types.js';

/** Split a raw byte stream into its complete F0..F7 SysEx messages. */
export function splitSysex(bytes: number[]): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) { i++; continue; }
    const end = bytes.indexOf(0xf7, i);
    if (end < 0) break;
    out.push(bytes.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

/** Raw-int MIDI-config registers (the `_cc` CC-assignment slots) read back the literal string
 *  'None' (RAW_INT_NONE_SENTINEL = 128, decoded upstream by decodeRawIntRegister) when unassigned.
 *  Such a value is NOT a knob position: coercing it in blockParams' continuous branch would land a
 *  broken `Number('None') || 0` → 0 (a real CC). Surface it instead as a single-option selector so
 *  Axis renders "None" verbatim. Returns null for any numeric (or numeric-string) display — the
 *  normal knob/enum path handles those. Exported for unit tests. */
export function am4NoneSelector(id: number, name: string, display: number | string): EnumParam | null {
  if (typeof display !== 'string') return null;
  if (display.trim() === '' || Number.isFinite(Number(display))) return null; // numeric string → normal path
  return { id, name, value: RAW_INT_NONE_SENTINEL, options: [{ value: RAW_INT_NONE_SENTINEL, label: display }] };
}

/** Opt-in container decode of a verbatim AM4 preset dump (the 6-message 0x77/0x78/0x79 stream) →
 *  the CRC-validity flag + the four plaintext scene names, for enriching the backup / offline-decode
 *  DTOs. ADDITIVE: the opaque `bytes` round-trip is untouched. Returns null (never throws) on a
 *  malformed/corrupt dump so the enrichment silently degrades and the opaque backup still succeeds.
 *  Exported for unit tests. */
export function am4DecodeEnrichment(rawBytes: Uint8Array): { sceneNames: string[]; crcValid: boolean } | null {
  try {
    const d = decodeAm4PresetDumpBytes(rawBytes);
    return { sceneNames: [...d.sceneNames].map((s) => s.trim()), crcValid: d.crcValid };
  } catch {
    return null;
  }
}

// ── AM4 preset-structure read (fn 0x01, readType 0x1F) — wire-decoded in fractal-midi's am4 SYSEX-MAP.
// ONE request returns a 192-byte structure (220 septets, continuous MSB-first 7→8 bitstream) carrying
// the preset name, active scene, and — at 0xB0/B4/B8/BC — the four per-slot block-type codes (int32 LE).
// This is how the chain is actually read; the per-slot short reads (0x0E) return 0 for placement.
export const ATOMIC_READ_TYPE = 0x1f;
export const STRUCT_BYTES = 192;
export const STRUCT_SLOT_OFFSETS = [0xb0, 0xb4, 0xb8, 0xbc]; // int32 LE block-type code, slot 1..4
export const STRUCT_NAME_OFFSET = 0x10;
export const STRUCT_SCENE_OFFSET = 0x08;
// int32 LE @0x00 = the CURRENT stored-preset location (0..103). Verified against a beta log
// (log (8).txt, 2026-07-03) across 7 presets: every /preset/select round-trip left this field
// equal to the selected location (Interface=0, Electric=2, AC-20=7, …, Bass NoAmp DI=11).
export const STRUCT_LOCATION_OFFSET = 0x00;

/** The 192-byte structure response: F0 …74 15 01 …[1f 00]… <220 septets> cksum F7. */
export function isStructResponse(r: number[]): boolean {
  return r.length >= 230 && r[0] === 0xf0 && r[4] === 0x15 && r[5] === 0x01
    && r[10] === 0x1f && r[11] === 0x00 && r[r.length - 1] === 0xf7;
}
/** Continuous MSB-first 7→8 bitstream unpack (load-bearing direction — LSB-first scrambles the fields). */
export function unpackMsb(septets: number[], rawLen: number): Uint8Array {
  const out = new Uint8Array(rawLen);
  let acc = 0, nbits = 0, o = 0;
  for (const s of septets) {
    acc = (acc << 7) | (s & 0x7f);
    nbits += 7;
    while (nbits >= 8 && o < rawLen) { nbits -= 8; out[o++] = (acc >> nbits) & 0xff; }
    acc &= (1 << nbits) - 1; // keep acc bounded (nbits < 8 after the loop)
  }
  return out;
}
export const int32LE = (b: Uint8Array, o: number) => (((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0);
export function asciiAt(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) { const c = b[off + i] ?? 0; if (c === 0) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); }
  return s.trim();
}

export interface Am4Structure {
  slots: Am4Slot[];
  name: string;
  scene: number;
  location: number;
}

/** Decode the 192-byte fn-0x1F body into the four slot codes + preset name/scene/location. */
export function parseAm4Structure(b: Uint8Array): Am4Structure {
  const slots: Am4Slot[] = STRUCT_SLOT_OFFSETS.map((off, i) => {
    const code = int32LE(b, off);
    // instance-aware: a second instance of a block type occupies base+1 (e.g. drive 0x76 +
    // drive 0x77 in the factory "Bass NoAmp DI") — resolve it instead of showing a hex code
    const name = resolveBlockTypeValue(code)?.name;
    return { slot: i + 1, blockType: name ?? (code ? `0x${code.toString(16)}` : 'none'), pidLow: code };
  });
  return {
    slots,
    name: asciiAt(b, STRUCT_NAME_OFFSET, 32),
    scene: int32LE(b, STRUCT_SCENE_OFFSET),
    location: int32LE(b, STRUCT_LOCATION_OFFSET),
  };
}

/** Debug dump of the unpacked structure + auto-located block-type codes at every offset, so we can
 *  confirm/fix the slot offset against a real preset. Remove once the slot layout is pinned. */
export function am4StructDebugLines(b: Uint8Array): string[] {
  const hex = `struct[192]: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const hits: string[] = [];
  for (let o = 0; o + 4 <= STRUCT_BYTES; o++) {
    const v = int32LE(b, o);
    if (v && BLOCK_NAMES_BY_VALUE[v]) hits.push(`0x${o.toString(16)}=${BLOCK_NAMES_BY_VALUE[v]}`);
  }
  return [hex, `block-code scan: ${hits.join(' ') || '(none)'}`];
}

// AM4 unit tag → the display label the gen-3 blockParams DTO uses (so Axis renders both the same way).
// Blank = show the bare number (count/semitones/ratio are unitless integers; knob_0_10/20 are 0..N knobs).
export const AM4_UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%', degrees: '°', pf: 'pF'
};
/** A pretty param label from a KNOWN_PARAMS key's name: displayLabel if present, else name with _→space. */
export function am4ParamLabel(p: Param): string {
  return p.displayLabel ?? p.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
/** Display name for a block slug in the "add a block" palette. Acronyms/compounds that Title-Case badly
 *  get an explicit label; everything else is just capitalized (drive → Drive, reverb → Reverb). */
export const AM4_BLOCK_LABEL: Record<string, string> = { geq: 'Graphic EQ', peq: 'Parametric EQ', volpan: 'Vol/Pan', ingate: 'Input Gate' };
export function am4BlockLabel(slug: string): string {
  return AM4_BLOCK_LABEL[slug] ?? slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
