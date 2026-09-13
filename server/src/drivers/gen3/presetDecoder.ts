// Gen-3 preset-dump collaborator: fetch + decode a preset dump into summaries, full per-block params,
// raw .syx bytes, and the decompressed body. Owns the incomplete-dump retry. Split out of gen3.ts so
// the driver facade and GridReader share one dump path.
import { readBlockParamsForModel, modelsFromBlocks, blockRefForEid, type DecodedBlock } from 'forgefx-midi/devices/gen3';
import type { PresetSummary } from '../types.js';
import { EDIT_BUFFER } from './support.js';
import { decodeDump, decodeRawBody, type DecodedDump, type DecodedDumpDTO } from './dump.js';
import type { Gen3Host } from './host.js';

export class PresetDecoder {
  #host: Gen3Host;

  constructor(host: Gen3Host) { this.#host = host; }

  /** Read a preset dump, retrying when it arrives incomplete. On Windows USB-MIDI a big multi-packet
   *  dump (Axe-Fx III presets ≈ 18 frames / 32 KB) intermittently drops its 0x78 payload chunks between
   *  the 0x77 header and the 0x79 terminator → "no 0x78 chunks found". A re-read almost always succeeds. */
  async dumpFrames(target: number): Promise<number[][]> {
    const dev = await this.#host.conn();
    // A slow link (5-pin MIDI) transfers each ~3082B dump chunk in ~1s, so a multi-chunk preset dump takes
    // several seconds with ~1s gaps between chunks. The USB-tuned windows (5s / 180ms quiet) give up mid
    // dump. Widen them so the transfer completes; the 0x79-terminator `match` still returns the instant the
    // dump is whole, so a fast link isn't slowed.
    const slow = dev.slow;
    let frames: number[][] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      frames = await dev.request(this.#host.codec.buildRequestPresetDump(target), {
        timeoutMs: slow ? 25000 : 5000,
        quietMs: slow ? 1500 : 180,
        match: (fs) => fs.some((f) => f[5] === 0x79) // 0x79 = dump terminator
      });
      const ok = frames.some((f) => f[5] === 0x78) && frames.some((f) => f[5] === 0x79);
      if (ok) return frames;
      console.log(`[forgefx] presetDump: incomplete attempt ${attempt}/3 (frames=${frames.length}, 0x78=${frames.some((f) => f[5] === 0x78)}, 0x79=${frames.some((f) => f[5] === 0x79)}) — retrying`);
    }
    return frames; // still incomplete → let decodePresetDump throw its clear error
  }

  /** Decode a dump-frame window through the profile-bound pipeline (used by summaries and GridReader). */
  decode(frames: readonly (readonly number[])[]): DecodedDump {
    return decodeDump(frames, this.#host.profile);
  }

  /** Decode any preset by number (non-disruptive — does NOT switch the active preset) into a
   *  library-friendly summary: name, scene names, and the unique effect blocks it contains. */
  async presetSummary(presetNumber: number, withParams = false): Promise<PresetSummary> {
    const frames = await this.dumpFrames(presetNumber);
    const decoded = this.decode(frames);
    const blocks = this.#decodeBlocks(decoded);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(blocks), presetNumber);
    if (withParams) summary.params = blocks; // cache build: summary + full params in one dump
    return summary;
  }

  /** Full per-block params (every family/param) for one device preset — the deep-search / detail source. */
  async presetParams(presetNumber: number): Promise<DecodedBlock[]> {
    const frames = await this.dumpFrames(presetNumber);
    return this.#decodeBlocks(this.decode(frames));
  }

  /** Raw .syx bytes (the backup blob) + decoded summary for one slot — the backups service's source. */
  async dumpRaw(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }> {
    const frames = await this.dumpFrames(n);
    const decoded = this.decode(frames);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(this.#decodeBlocks(decoded)), n);
    return { bytes: Uint8Array.from(frames.flat()), summary };
  }

  /** Decode a preset from raw .syx bytes (a saved/exported dump) — offline, no device needed. Splits
   *  the byte stream into F0..F7 SysEx frames and runs the same decoder. For a file-based library. */
  decodePresetBytes(bytes: Uint8Array): PresetSummary {
    const frames: number[][] = [];
    let cur: number[] | null = null;
    for (const b of bytes) {
      if (b === 0xf0) cur = [b];
      else if (cur) {
        cur.push(b);
        if (b === 0xf7) {
          frames.push(cur);
          cur = null;
        }
      }
    }
    const decoded = this.decode(frames);
    const blocks = this.#decodeBlocks(decoded);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(blocks), -1);
    summary.params = blocks; // offline files embed full params (few files → fine for search/storage)
    return summary;
  }

  /** Decompressed preset body as hex — for per-block param-decode RE (diff bodies across known param
   *  changes to locate offsets). Dumps the active edit buffer. */
  async presetBodyHex(): Promise<{ len: number; hex: string }> {
    const dev = await this.#host.conn();
    const frames = await dev.request(this.#host.codec.buildRequestPresetDump(EDIT_BUFFER), {
      timeoutMs: 5000,
      quietMs: 180,
      match: (fs) => fs.some((f) => f[5] === 0x79)
    });
    const body = decodeRawBody(frames, this.#host.profile.model);
    return { len: body.length, hex: Buffer.from(body).toString('hex') };
  }

  /** Decode every placed block's full params from the preset body, table-driven via the universal
   *  layout (u16 array @ header+0x2e, paramId order) + the fractal-midi catalog (FM3_PARAMS/RANGES/
   *  ENUM_OVERRIDES/ROSTERS). `decoded` supplies the grid's placed effectIds so only placed blocks are
   *  read (rejects phantom headers). Empty for non-FM3. The model/type search index is derived from
   *  this via `modelsFromBlocks`. */
  #decodeBlocks(decoded: DecodedDump): DecodedBlock[] {
    if (decoded.dump.modelId !== 0x11) return []; // gate on the PRESET's model (not the connected device) — so
    try {                                         // an offline FM3 .syx decodes even when no FM3 is attached
      const placedEids = new Set<number>(decoded.dump.grid.filter((c) => !c.isShunt && c.effectId).map((c) => c.effectId));
      return readBlockParamsForModel(decoded.body, placedEids, decoded.dump.modelId);
    } catch {
      return [];
    }
  }

  #summarizeDump(d: DecodedDumpDTO, models: Record<string, string[]>, presetNumber: number): PresetSummary {
    const seen = new Map<number, { effectId: number; slug: string | null; name: string; instance: number | null }>();
    for (const c of d.grid) {
      if (c.isShunt || !c.effectId || seen.has(c.effectId)) continue;
      const ref = blockRefForEid(c.effectId);
      seen.set(c.effectId, { effectId: c.effectId, slug: ref?.slug ?? null, name: c.name, instance: ref?.instance ?? null });
    }
    return { number: presetNumber, name: d.name, model: d.modelName, crcValid: d.crcValid, crc: d.crc, scenes: d.sceneNames, blocks: [...seen.values()], models, amps: models.amp ?? [] };
  }
}
