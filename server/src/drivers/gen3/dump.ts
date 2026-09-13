// Gen-3 preset-dump decode (forgefx-midi devices/gen3 pipeline). Split out of gen3.ts (C3).
// Adapter producing the exact DTO the pre-Phase-4 server-local codec (fm3PresetGrid.ts
// decodePresetDump) returned — field-level parity was proven over 429 real FM3 dumps
// (scripts/diff-decoders.ts, Phase 2). The JSON shapes downstream are the HTTP contract
// Axis consumes and must not drift.
import { parsePresetDump, decodeRawPatch, decodeGen3Body } from 'forgefx-midi/devices/gen3';
import type { DeviceProfile } from '../../devices.js';

/** The old decodePresetDump DTO, byte-identical on the HTTP surface. */
export interface DecodedDumpDTO {
  modelId: number;
  modelName: string;
  name: string;
  crcValid: boolean;
  /** Stored CRC16 of the preset body — a content fingerprint (changes when the preset changes). */
  crc: number;
  rows: number;
  cols: number;
  grid: { effectId: number; row: number; col: number; routeFlag: number; name: string; isShunt: boolean; fromRows: number[] }[];
  sceneNames: string[];
}
/** Decoded dump: the DTO plus the decompressed body (per-block param decode source). */
export interface DecodedDump {
  dump: DecodedDumpDTO;
  body: Uint8Array;
  decompSize: number;
}

/** Keep only the dump frames (0x77 header / 0x78 chunks / 0x79 footer) and flatten to the byte
 *  stream the package parser takes. The live request window can interleave unrelated frames
 *  (beacons, other replies) that the strict frame-walking parser would reject; the old decoder
 *  skipped them the same way. */
export function dumpBytesFromFrames(frames: readonly (readonly number[])[]): Uint8Array {
  const chunks: (readonly number[])[] = [];
  let total = 0;
  for (const f of frames) {
    if (f.length < 8 || f[0] !== 0xf0 || f[1] !== 0x00 || f[2] !== 0x01 || f[3] !== 0x74) continue;
    const fn = f[5];
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) { chunks.push(f); total += f.length; }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of chunks) { out.set(f, off); off += f.length; }
  return out;
}

/** Just the decompressed preset body (raw_patch → Huffman) from a dump-frame window — the source
 *  for per-block param-decode RE (diff bodies across known param changes to locate offsets). */
export function decodeRawBody(frames: readonly (readonly number[])[], model: number): Uint8Array {
  const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, model);
  return decodeRawPatch(parsed.chunkPayloads).body;
}

/** Full dump decode via the package pipeline (parse → raw_patch/CRC/Huffman → structured body),
 *  mapped to the old server DTO. rows/cols/modelName come from the profile — the same values the
 *  old codec's DIMS dict held; the preset name is the raw_patch header ASCII at 0x08..0x28
 *  (NUL-stop, trimmed), exactly the old decoder's source. */
export function decodeDump(frames: readonly (readonly number[])[], prof: DeviceProfile): DecodedDump {  const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, prof.model);
  const raw = decodeRawPatch(parsed.chunkPayloads);
  const body3 = decodeGen3Body(raw.body, prof.model);
  let name = '';
  for (let i = 0x08; i < 0x28; i++) {
    const b = raw.rawPatch[i] ?? 0;
    if (b === 0) break;
    name += String.fromCharCode(b);
  }
  const grid = (body3.grid ?? []).map((c) => ({
    effectId: c.effect_id,
    row: c.row,
    col: c.col,
    routeFlag: c.route_flag,
    name: c.name,
    isShunt: c.is_shunt ?? false,
    fromRows: c.from_rows ?? []
  }));
  return {
    dump: {
      modelId: prof.model,
      modelName: prof.name,
      name: name.trim(),
      crcValid: raw.crcValid,
      crc: raw.storedCrc,
      rows: prof.rows,
      cols: prof.cols,
      grid,
      sceneNames: body3.scene_names ?? []
    },
    body: raw.body,
    decompSize: raw.decompSize
  };
}
