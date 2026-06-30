// AM4 device path (model 0x15) — a parallel module to the gen-3 Device. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the gen-3 Device owns (device.openTransport()), since only one device is ever connected at a time.
// Codec is fractal-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
  parseReadResponse,
  isReadResponse,
  BLOCK_SLOT_PID_LOW,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_NAMES_BY_VALUE,
  buildSetParam,
  buildSetBlockBypass,
  buildSwitchScene,
  buildSwitchPreset,
  buildGetPresetName,
  parseGetPresetNameResponse,
  isCommandAck,
  type ParamKey
} from 'fractal-midi/am4';
import { device, type PresetGridDTO } from './device.js';

export interface Am4Slot {
  slot: number; // 1..4 signal-chain position
  blockType: string; // canonical block name, 'none' if empty
  pidLow: number; // the block's pidLow (its type value)
}

// ── AM4 preset-structure read (fn 0x01, readType 0x1F) — wire-decoded in fractal-midi's am4 SYSEX-MAP.
// ONE request returns a 192-byte structure (220 septets, continuous MSB-first 7→8 bitstream) carrying
// the preset name, active scene, and — at 0xB0/B4/B8/BC — the four per-slot block-type codes (int32 LE).
// This is how the chain is actually read; the per-slot short reads (0x0E) return 0 for placement.
const ATOMIC_READ_TYPE = 0x1f;
const STRUCT_BYTES = 192;
const STRUCT_SLOT_OFFSETS = [0xb0, 0xb4, 0xb8, 0xbc]; // int32 LE block-type code, slot 1..4
const STRUCT_NAME_OFFSET = 0x10;
const STRUCT_SCENE_OFFSET = 0x08;

/** The 192-byte structure response: F0 …74 15 01 …[1f 00]… <220 septets> cksum F7. */
function isStructResponse(r: number[]): boolean {
  return r.length >= 230 && r[0] === 0xf0 && r[4] === 0x15 && r[5] === 0x01
    && r[10] === 0x1f && r[11] === 0x00 && r[r.length - 1] === 0xf7;
}
/** Continuous MSB-first 7→8 bitstream unpack (load-bearing direction — LSB-first scrambles the fields). */
function unpackMsb(septets: number[], rawLen: number): Uint8Array {
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
const int32LE = (b: Uint8Array, o: number) => (((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0);
function asciiAt(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) { const c = b[off + i] ?? 0; if (c === 0) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); }
  return s.trim();
}

class Am4Device {
  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  #emptySlots = (): Am4Slot[] => [1, 2, 3, 4].map((n) => ({ slot: n, blockType: 'none', pidLow: 0 }));

  /** One atomic fn-0x1F read of the preset structure → the 4 slots' block types + preset name + scene. */
  async #readStructure(): Promise<{ slots: Am4Slot[]; name: string; scene: number } | null> {
    const dev = await device.openTransport();
    const read = buildReadParam({ pidLow: BLOCK_SLOT_PID_LOW, pidHigh: 0x0000 }, ATOMIC_READ_TYPE);
    try {
      const frames = await dev.request(read, { timeoutMs: 1500, quietMs: 80, match: (fs) => fs.some(isStructResponse) });
      const f = frames.find(isStructResponse);
      if (!f) return null;
      const b = unpackMsb(f.slice(16, f.length - 2), STRUCT_BYTES); // 16-byte header … <septets> cksum F7
      const slots: Am4Slot[] = STRUCT_SLOT_OFFSETS.map((off, i) => {
        const code = int32LE(b, off);
        return { slot: i + 1, blockType: BLOCK_NAMES_BY_VALUE[code] ?? (code ? `0x${code.toString(16)}` : 'none'), pidLow: code };
      });
      return { slots, name: asciiAt(b, STRUCT_NAME_OFFSET, 32), scene: int32LE(b, STRUCT_SCENE_OFFSET) };
    } catch {
      return null;
    }
  }

  /** Read the 4 signal-chain slots → which block sits in each (the AM4 equivalent of the grid). */
  async slots(): Promise<Am4Slot[]> {
    const out = (await this.#readStructure())?.slots ?? this.#emptySlots();
    this.#log(`slots: ${out.map((s) => `${s.slot}:${s.blockType}`).join(' ')}`);
    return out;
  }

  /** The 4 slots as a PresetGridDTO (1 row × 4, linear chain) so Axis renders the AM4 on the existing
   *  Signal Grid — no separate view needed to get it on screen + testable. */
  async grid(): Promise<PresetGridDTO> {
    const s = await this.#readStructure();
    const slots = s?.slots ?? this.#emptySlots();
    this.#log(`grid: "${s?.name ?? ''}" — ${slots.map((x) => x.blockType).join(', ')}`);
    const cells = slots.map((sl, i) => ({
      row: 0,
      col: i,
      effectId: sl.pidLow,
      name: sl.blockType === 'none' ? '' : sl.blockType,
      isShunt: sl.blockType === 'none',
      routeFlag: 0,
      fromRows: i > 0 ? [0] : [] // linear: each slot feeds from the previous
    }));
    return { model: 'am4', name: s?.name ?? '', crcValid: true, rows: 1, cols: 4, scenes: [], cells, source: 'dump' };
  }

  /** Stored preset name at a location (0..103). */
  async presetName(location: number): Promise<{ location: number; name: string }> {
    const dev = await device.openTransport();
    const req = buildGetPresetName(location);
    const frames = await dev.request(req, { timeoutMs: 1000, quietMs: 80, match: (fs) => fs.length > 0 });
    for (const f of frames) {
      try {
        const r = parseGetPresetNameResponse(f, location);
        return { location, name: r.isEmpty ? '' : r.name };
      } catch {
        /* not the name frame */
      }
    }
    return { location, name: '' };
  }

  /** Set a parameter by its display value (e.g. 'amp.gain', 7.5). */
  async setParam(key: string, displayValue: number) {
    const dev = await device.openTransport();
    const frame = buildSetParam(key as ParamKey, displayValue);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 60, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Toggle/set a block's bypass by its pidLow. */
  async setBypass(blockPidLow: number, bypassed: boolean) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSetBlockBypass(blockPidLow, bypassed));
    return { ok: true };
  }

  /** Switch the active scene (0..3). */
  async switchScene(index: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSwitchScene(index));
    return { ok: true, scene: index };
  }

  /** Switch the active preset by location index (0..103, A01..Z04). */
  async switchPreset(location: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSwitchPreset(location));
    return { ok: true, location };
  }
}

export const am4 = new Am4Device();
