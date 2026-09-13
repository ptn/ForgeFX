// Gen-3 out-of-band edit reflection: the FM3 poll fallback (deviceEditWatch) that re-reads the open
// block and diffs it, plus the push-burst diff (deviceEditPush) the registry's RX listener hands us.
// Owns the last-known snapshot, the watched block/channel, and the local-write echo guard. Split out
// of gen3.ts so the driver facade owns no edit-sync state.
import type { ModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY } from '../../devices.js';
import { clamp01, channelSlice } from './support.js';
import type { Gen3Host } from './host.js';

export class EditSync {
  #host: Gen3Host;
  #snapshot = new Map<number, number[]>(); // effectId → last-known active-channel wire values
  #watchedEid: number | null = null; // FM3 poll target: the block Axis last opened (set in blockParams)
  #watchedChannel = 0; // active channel (0-3) of the watched block — the burst slice the poll diffs against
  #lastLocalEditAt = 0; // ms of the last local param write — the FM3 poll pauses briefly after (no self-echo)

  constructor(host: Gen3Host) { this.#host = host; }

  /** The block the user just opened is the device-edit poll target. */
  setWatched(eid: number): void { this.#watchedEid = eid; }

  /** Prime the push-diff baseline with the OPEN channel's values so a later front-panel edit's burst
   *  diffs cleanly to the moved param (no first-sight reload — see decodeEditBurst). */
  observeBlock(eid: number, channel: number, values: number[], watchChannel: boolean): void {
    if (watchChannel) this.#watchedChannel = channel;
    this.#snapshot.set(eid, values);
  }

  /** Record a local param write so the poll pauses briefly and never echoes our own edit mid-drag. */
  noteLocalWrite(): void { this.#lastLocalEditAt = Date.now(); }

  /** FM3 device-edit POLL (capability deviceEditWatch — FM3 doesn't push, unlike FM9/III). The registry
   *  supervisor calls this on a timer; we re-read the currently-open block via the fn-0x1F bulk read and
   *  reuse decodeEditBurst's diff to emit per-param `param` events for any knob moved on the front panel.
   *  Returns {changed:true} only for a first-sight reload (registry emits `changed`); per-param events are
   *  emitted directly here. Paused for ~2s after a local write so it never echoes our own edit mid-drag. */
  async readDeviceEditState(): Promise<{ changed: boolean }> {
    const eid = this.#watchedEid;
    if (eid == null) return { changed: false }; // no block opened yet — nothing to watch
    if (Date.now() - this.#lastLocalEditAt < 2000) return { changed: false }; // mid local edit → skip (avoid echo)
    const dev = await this.#host.conn();
    let frames: number[][];
    try {
      frames = await dev.request(this.#host.codec.buildBlockBulkReadPoll(eid), { timeoutMs: dev.slow ? 4000 : 1500, quietMs: dev.slow ? 300 : 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
    } catch { return { changed: false }; } // no reply / timeout — keep last baseline
    const res = this.decodeEditBurst(frames);
    if (res.reload) return { changed: true }; // first sight of this block → let the registry emit a reload
    for (const e of res.events) this.#host.emit({ type: 'param', effectId: e.effectId, paramId: e.paramId, norm: e.norm });
    return { changed: false }; // per-param events already emitted
  }

  decodeEditBurst(frames: number[][]): { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean } {
    let bulk: ReturnType<ModernFractalCodec['assembleGen3BlockBulkRead']>;
    try { bulk = this.#host.codec.assembleGen3BlockBulkRead(frames); } catch { return { events: [], reload: false }; }
    const eid = bulk.blockId;
    if (bulk.values.length === 0) return { events: [], reload: false }; // head-only / empty — nothing to read
    const prof = this.#host.profile;
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()] ?? prof.familyForEffectId(eid);
    const defs = family ? (prof.params[family] ?? []) : [];
    if (!family || defs.length === 0) return { events: [], reload: false }; // no param family mapped
    // Slice the block's ACTIVE channel (the one blockParams surfaced) — the body is channel-blocked, so
    // diffing against channel A while the user has B-D open would flag every A/B-different param as "moved".
    const { stride, base } = channelSlice(prof, family, bulk, eid === this.#watchedEid ? this.#watchedChannel : 0);
    const cur = bulk.values.slice(base, base + stride);
    const prev = this.#snapshot.get(eid);
    this.#snapshot.set(eid, cur);
    // First sight of this block (never opened) → we can't diff. Ask the registry for a full reload so the
    // edit isn't lost; subsequent edits on this block then diff per-param.
    if (!prev) return { events: [], reload: true };
    const events: { effectId: number; paramId: number; norm: number }[] = [];
    for (const p of defs) {
      const id = p.paramId;
      if (id >= stride) continue;
      if (cur[id] === undefined || cur[id] === prev[id]) continue; // unchanged / truncated → skip
      if (!prof.ranges[family]?.[id]) continue; // only real controls (skip internal/bypass churn)
      events.push({ effectId: eid, paramId: id, norm: clamp01((cur[id] ?? 0) / 65534) });
    }
    return { events, reload: false };
  }
}
