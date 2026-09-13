// AM4 out-of-band edit reflection: the device-edit watch (HW-107 — the AM4 pushes nothing, so the
// registry polls readDeviceEditState on a timer). Transition-gated: cheap edited-bit/scene/channel
// reads every tick, the heavy fn-0x1F hash dumps only on the gated transitions. Split out of am4.ts.
import { readActiveBufferEditedBit, readAllParams } from 'forgefx-midi/devices/am4';
import { TransportConn } from '../descriptorConn.js';
import type { CadenceProfile } from '../telemetryProfiles.js';
import type { Am4Context } from './context.js';

export interface Am4EditSyncHost {
  getCadence(): CadenceProfile;
  emitScene(index: number): void;
  emitChanged(): void;
}

export class Am4EditSync {
  #context: Am4Context;
  #host: Am4EditSyncHost;
  #baseline: { edited: boolean; hash: string; scene: number; channels: string } | null = null;
  #selfEditPending = false;
  #lastHashAt = 0; // clock() of the last #hashPlacedParams dump — gates the rehash budget

  constructor(context: Am4Context, host: Am4EditSyncHost) {
    this.#context = context;
    this.#host = host;
  }

  /** Our own write dirtied the buffer — silently re-seed the baseline next tick. */
  markSelfEdit(): void { this.#selfEditPending = true; }

  /** One device-edit watch tick. Returns `{changed:true}` when a DEVICE-originated (front-panel /
   *  AM4-Edit) edit needs the registry to emit a reload; the latency-sensitive false→true case emits
   *  `changed` itself and returns false. Serialized behind the shared reader lock. */
  async readDeviceEditState(): Promise<{ changed: boolean }> {
    return this.#context.withReader(async () => {
      const dev = await this.#context.transport();
      const conn = new TransportConn(dev);
      let edited: boolean;
      try {
        edited = await readActiveBufferEditedBit(conn);
      } catch {
        return { changed: false }; // device busy / timeout — keep the last baseline, don't reload
      }
      // ── CHEAP, EVERY TICK ── struct (scene/location) + per-block active channel (0x7DD). No fn-0x1F
      // dumps here: the heavy #hashPlacedParams runs ONLY on the gated transitions below.
      const struct = await this.#context.readStructure();
      const scene = struct?.scene ?? 0;
      const placed = (struct?.slots ?? []).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none').map((sl) => sl.pidLow);
      const channels = await this.#context.refreshActiveChannels(placed);

      const rehashMs = this.#host.getCadence().editRehashMs; // 0 (reduced) = never dump on the latched path
      const base = this.#baseline;

      // First run, or our own write just dirtied the buffer → adopt as baseline and emit nothing. Seed a
      // hash ONLY when the buffer is dirty AND rehashing is enabled.
      if (base === null || this.#selfEditPending) {
        this.#selfEditPending = false;
        let hash = '';
        if (edited && rehashMs > 0) { hash = await this.#hashPlacedParams(conn); this.#lastHashAt = this.#context.clock(); }
        this.#baseline = { edited, hash, scene, channels };
        return { changed: false };
      }

      // Front-panel scene change (footswitch): emit a `scene` event (same shape gen-3 emits).
      if (scene !== base.scene) this.#host.emitScene(scene);

      let emittedChanged = false;                    // true once we've emitted `changed` directly this tick
      let wantChanged = channels !== base.channels;  // a front-panel channel switch is device-originated
      let hash = base.hash;

      if (edited && !base.edited) {
        // false→true: emit `changed` IMMEDIATELY (before the slow hash) so the reload is not gated on the
        // dump, THEN hash once to seed the successive-edit baseline (only when rehashing is enabled).
        this.#host.emitChanged();
        emittedChanged = true;
        if (rehashMs > 0) { hash = await this.#hashPlacedParams(conn); this.#lastHashAt = this.#context.clock(); }
        else hash = '';
      } else if (!edited && base.edited) {
        // true→false (device-side save): name/location may have changed → reload; reset the hash baseline
        // cheaply (nothing dirty to fingerprint — no dump).
        hash = '';
        wantChanged = true;
      } else if (edited && base.edited && rehashMs > 0 && this.#context.clock() - this.#lastHashAt >= rehashMs) {
        // Bit stays latched and the rehash budget elapsed: re-fingerprint the placed blocks.
        const fresh = await this.#hashPlacedParams(conn);
        this.#lastHashAt = this.#context.clock();
        if (fresh !== base.hash) { hash = fresh; wantChanged = true; }
      }

      this.#baseline = { edited, hash, scene, channels };
      return { changed: wantChanged && !emittedChanged };
    });
  }

  /** Fingerprint the placed blocks' current param values via fn-0x1F (channel-A quarter only — stable
   *  and small). Runs inside the reader lock (the caller already holds the lock). */
  async #hashPlacedParams(conn: TransportConn): Promise<string> {
    const s = await this.#context.readStructure(); // TTL-cached; the poll cadence keeps it warm
    const placed = (s?.slots ?? []).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none');
    const parts: string[] = [];
    for (const sl of placed) {
      try {
        const r = await readAllParams(conn, sl.pidLow);
        const stride = r.itemCount >= 4 ? Math.floor(r.itemCount / 4) : r.values.length;
        parts.push(`${sl.pidLow}:${r.values.slice(0, stride).join(',')}`);
      } catch {
        // block not readable this tick — skip it (its absence is itself part of the fingerprint)
      }
    }
    return parts.join('|');
  }
}
