// Shared reader plumbing for the descriptor-based drivers (AM4 / gen-2 / VP4). Each driver had a
// byte-identical copy of the per-instance reader-lock (#withReader) plus a brief TTL cache around the
// descriptor's one-shot getPreset dump. The reader drives the RAW transport (bare send + onFrame
// waiter) which bypasses dev.request's serialization, so overlapping reads would interleave on the
// shared port; this class owns the mutex + cache + the transport the DispatchCtx is built from.
//
// The drivers differ only in: the cache TTL (AM4 derives it from the live cadence, gen-2/VP4 use a
// fixed 500 ms), the getPreset options, and whatever extra device work a fresh dump triggers (AM4
// refreshes structure + active channels). Those are the constructor callbacks.
import type { DeviceDescriptor, DispatchCtx, GetPresetOptions, PresetSnapshot } from 'forgefx-midi/core';
import { dispatchCtx } from '../descriptorConn.js';
import type { Transport } from '../../transport/types.js';

/** Fixed preset/structure cache TTL for the 500 ms drivers (gen-2, VP4). One page load fans out into
 *  several reads, so coalescing that burst matters more than freshness; AM4 derives its own from the
 *  live cadence instead (see its ReaderCache ttlMs). */
export const PRESET_TTL_MS = 500;

export interface ReaderCacheOptions {
  descriptor: DeviceDescriptor;
  /** Resolve the registry-owned transport (called lazily on each read). */
  openTransport: () => Promise<Transport>;
  /** Cache TTL in ms, evaluated at each call so a cadence-derived TTL stays live. */
  ttlMs: () => number;
  /** Injectable clock (test seam); defaults to Date.now. */
  clock?: () => number;
  /** Options forwarded to the descriptor reader's getPreset. */
  getPresetOptions?: GetPresetOptions;
  /** Failure log sink; success text is the driver's own (see onLoaded). */
  log?: (s: string) => void;
  /** Runs inside the reader lock after a fresh dump — log it, and do any extra device reads. */
  onLoaded?: (snap: PresetSnapshot) => void | Promise<void>;
}

export class ReaderCache {
  readonly #descriptor: DeviceDescriptor;
  readonly #openTransport: () => Promise<Transport>;
  readonly #ttlMs: () => number;
  readonly #clock: () => number;
  readonly #getPresetOptions: GetPresetOptions;
  readonly #log?: (s: string) => void;
  readonly #onLoaded?: (snap: PresetSnapshot) => void | Promise<void>;
  #lock: Promise<unknown> = Promise.resolve();
  #presetCache: { snap: PresetSnapshot; at: number } | null = null;
  #lastTransport: Transport | null = null;

  constructor(opts: ReaderCacheOptions) {
    this.#descriptor = opts.descriptor;
    this.#openTransport = opts.openTransport;
    this.#ttlMs = opts.ttlMs;
    this.#clock = opts.clock ?? (() => Date.now());
    this.#getPresetOptions = opts.getPresetOptions ?? {};
    this.#log = opts.log;
    this.#onLoaded = opts.onLoaded;
  }

  get reader() { return this.#descriptor.reader; }
  get cached(): PresetSnapshot | null { return this.#presetCache?.snap ?? null; }

  /** Serialize `fn` behind the in-instance reader mutex so no two reader calls interleave on the
   *  shared transport. Returns fn's result; the lock advances whether fn resolves or throws. */
  withReader<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    // Keep the chain alive on rejection (swallow here; the awaited `run` still surfaces the error).
    this.#lock = run.catch(() => undefined);
    return run;
  }

  /** Open (or reuse the registry's) transport and remember it for the next dispatchCtx(). */
  async transport(): Promise<Transport> {
    this.#lastTransport = await this.#openTransport();
    return this.#lastTransport;
  }

  /** Build the reader's DispatchCtx. The reader ONLY touches ctx.conn; the descriptor field is
   *  required by the type but unused on the read path, so we hand it the descriptor itself. */
  dispatchCtx(): DispatchCtx { return dispatchCtx(this.#descriptor, this.#lastTransport!); }

  /** Drop the cached preset snapshot after any device write so the next read reflects the change. */
  invalidate(): void { this.#presetCache = null; }

  /** ONE atomic getPreset dump of the active buffer, cached briefly (TTL) so a grid + block-param
   *  page load reuses a single read. Serialized behind withReader. */
  async readPreset(): Promise<PresetSnapshot | null> {
    const now = this.#clock();
    if (this.#presetCache && now - this.#presetCache.at < this.#ttlMs()) return this.#presetCache.snap;
    return this.withReader(async () => {
      // Re-check the cache inside the lock — a call we queued behind may have just filled it.
      const t = this.#clock();
      if (this.#presetCache && t - this.#presetCache.at < this.#ttlMs()) return this.#presetCache.snap;
      this.#lastTransport = await this.#openTransport();
      try {
        const snap = await this.#descriptor.reader.getPreset!(this.dispatchCtx(), this.#getPresetOptions);
        this.#presetCache = { snap, at: this.#clock() };
        await this.#onLoaded?.(snap);
        return snap;
      } catch (e) {
        this.#log?.(`readPreset failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }
}
