// AM4 shared device context: the verified reader's lock + TTL preset cache, the TTL structure read,
// the live active-channel map, and the injectable clock. Split out of am4.ts so the driver facade and
// its collaborators (edit-sync / block params / preset bank) share one reader/cache story.
import {
  buildReadParam,
  BLOCK_SLOT_PID_LOW,
  buildReadActiveChannel,
  parseActiveChannelResponse,
} from 'forgefx-midi/am4';
import { AM4_DESCRIPTOR } from 'forgefx-midi/devices/am4';
import type { PresetSnapshot } from 'forgefx-midi/core';
import type { Transport } from '../../transport/types.js';
import type { CadenceProfile } from '../telemetryProfiles.js';
import { ReaderCache } from '../shared/readerCache.js';
import {
  ATOMIC_READ_TYPE, STRUCT_BYTES, isStructResponse, unpackMsb, parseAm4Structure, am4StructDebugLines,
} from './support.js';

export interface Am4ContextHost {
  openTransport(): Promise<Transport>;
  getCadence(): CadenceProfile;
  log(s: string): void;
}

export interface Am4Structure {
  slots: { slot: number; blockType: string; pidLow: number }[];
  name: string;
  scene: number;
  location: number;
}

export class Am4Context {
  #host: Am4ContextHost;
  #readerCache: ReaderCache;
  #structCache: { s: Am4Structure; at: number } | null = null;
  #now: () => number = () => Date.now();
  #activeChannel = new Map<number, number>(); // eid (pidLow) → channel idx 0..3
  #ctxSig: string | null = null;

  constructor(host: Am4ContextHost) {
    this.#host = host;
    this.#readerCache = new ReaderCache({
      descriptor: AM4_DESCRIPTOR,
      openTransport: () => host.openTransport(),
      ttlMs: () => this.cacheTtlMs(),
      clock: () => this.#now(),
      getPresetOptions: { include_channel_state: true },
      log: (s) => host.log(s),
      onLoaded: async (snap) => {
        // Resolve the REAL active channel per placed block from the device (0x07DD) so placedBlocks /
        // blockParams slice the channel the UNIT is actually on — not the channel-A fallback.
        const placed = (await this.readStructure())?.slots.filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none').map((sl) => sl.pidLow) ?? [];
        await this.refreshActiveChannels(placed);
        host.log(`readPreset: ${snap.slots.length} placed block(s), scene ${snap.active_scene ?? '?'} (${snap._meta.read_duration_ms ?? '?'}ms)`);
      },
    });
  }

  /** TEST-ONLY (FORGEFX-25 edit-watch tests): inject the clock the cache TTLs + rehash budget read. */
  setClockForTest(fn: () => number): void { this.#now = fn; }

  clock(): number { return this.#now(); }

  get activeChannel(): Map<number, number> { return this.#activeChannel; }

  /** Cache TTLs are DERIVED from the active cadence (0.8×editWatchMs, clamped ≥500) rather than a fixed
   *  500 ms — so one edit-watch tick never does a redundant double struct read, and a /telemetry/config
   *  mode switch keeps every cache coherent (getCadence resolves at call time). */
  cacheTtlMs(): number { return Math.max(500, Math.round(0.8 * this.#host.getCadence().editWatchMs)); }

  /** ONE atomic getPreset dump of the active buffer via the VERIFIED reader, cached briefly (TTL). */
  readPreset(): Promise<PresetSnapshot | null> { return this.#readerCache.readPreset(); }

  /** Drop both TTL caches after any device write — the next read must reflect the change. */
  invalidate(): void { this.#readerCache.invalidate(); this.#structCache = null; }

  // ── reader plumbing (block params / scan / tuner share the one reader lock) ──
  withReader<T>(fn: () => Promise<T>): Promise<T> { return this.#readerCache.withReader(fn); }
  transport(): Promise<Transport> { return this.#readerCache.transport(); }
  get reader() { return this.#readerCache.reader; }
  dispatchCtx() { return this.#readerCache.dispatchCtx(); }

  /** One atomic fn-0x1F read of the preset structure → the 4 slots' block types + preset name + scene +
   *  current stored location. TTL-cached. */
  async readStructure(): Promise<Am4Structure | null> {
    if (this.#structCache && this.#now() - this.#structCache.at < this.cacheTtlMs()) return this.#structCache.s;
    const dev = await this.#host.openTransport();
    const read = buildReadParam({ pidLow: BLOCK_SLOT_PID_LOW, pidHigh: 0x0000 }, ATOMIC_READ_TYPE);
    try {
      const frames = await dev.request(read, { timeoutMs: 1500, quietMs: 80, match: (fs) => fs.some(isStructResponse) });
      const f = frames.find(isStructResponse);
      if (!f) return null;
      const b = unpackMsb(f.slice(16, f.length - 2), STRUCT_BYTES); // 16-byte header … <septets> cksum F7
      if (process.env.AM4_DEBUG !== '0') {
        for (const line of am4StructDebugLines(b)) this.#host.log(line);
      }
      const s = parseAm4Structure(b);
      // Drop optimistic channel tracking when the preset/scene context changes — a switch remaps every
      // block's active channel on the device, and we cannot read the new mapping (0x07d2 is unreadable),
      // so falling back to channel A is the safe default until the user re-selects.
      const sig = `${s.location}:${s.scene}`;
      if (sig !== this.#ctxSig) { this.#ctxSig = sig; this.#activeChannel.clear(); }
      this.#structCache = { s, at: this.#now() };
      return s;
    } catch {
      return null;
    }
  }

  /** Read each placed block's REAL active channel from the device (0x07DD long read, byte 50) and update
   *  the map to the device truth. Returns a stable signature (`pidLow:idx|…`) the edit-watch uses to
   *  detect a front-panel channel switch. Best-effort per block. */
  async refreshActiveChannels(placedPidLows: number[]): Promise<string> {
    if (!placedPidLows.length) return '';
    const dev = await this.#host.openTransport();
    const isFor = (f: number[], pidLow: number) => f[6] === (pidLow & 0x7f) && f[7] === ((pidLow >> 7) & 0x7f);
    const parts: string[] = [];
    for (const pidLow of placedPidLows) {
      try {
        const req = buildReadActiveChannel(pidLow);
        const frames = await dev.request(req, {
          timeoutMs: dev.slow ? 1200 : 800,
          quietMs: dev.slow ? 100 : 50,
          match: (fs) => fs.some((f) => isFor(f, pidLow) && parseActiveChannelResponse(f) !== null),
        });
        const idx = frames
          .filter((f) => isFor(f, pidLow))
          .map((f) => parseActiveChannelResponse(f))
          .find((v) => v !== null);
        if (idx != null) {
          this.#activeChannel.set(pidLow, idx);
          parts.push(`${pidLow}:${idx}`);
        }
      } catch {
        // block unreadable this tick — keep the tracked/fallback channel, don't churn
      }
    }
    return parts.join('|');
  }
}
