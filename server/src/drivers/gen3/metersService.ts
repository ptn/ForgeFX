// Gen-3 telemetry collaborator: per-block grid meters, live per-block audio monitors, and the looper
// page's waveform/position/level + transport control. Split out of gen3.ts.
import {
  buildBlockMonitorPoll,
  isBlockMonitorResponse,
  parseBlockMonitorNorm,
  parseOutputMeterRms,
  meterRmsToDb,
  buildLooperWaveformPoll,
  isLooperWaveformResponse,
  parseLooperWaveform,
  buildLooperControl,
} from 'forgefx-midi/gen3/axe-fx-iii';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY } from '../../devices.js';
import type { MeterVal } from '../types.js';
import { KNOB_UNITS, channelSlice } from './support.js';
import type { Gen3Host } from './host.js';
import type { ParamDisplay } from './paramDisplay.js';
import type { GridReader } from './gridReader.js';

export class MetersService {
  #host: Gen3Host;
  #paramDisplay: ParamDisplay;
  #grid: GridReader;

  constructor(host: Gen3Host, paramDisplay: ParamDisplay, grid: GridReader) {
    this.#host = host;
    this.#paramDisplay = paramDisplay;
    this.#grid = grid;
  }

  /** Per-block "meter" values for the always-on grid level fill + swipe controls.
   * For each placed block: one bulk read → the norm of its primary param (auto-picked Level/Mix/…)
   * plus any client-requested swipe-control paramIds (`wants[slug]`). One HTTP call, N serial reads. */
  async meters(wants: Record<string, number[]> = {}): Promise<
    { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[]
  > {
    const prof = this.#host.profile;
    const g = await this.#grid.grid();
    const out: { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[] = [];
    const dev = await this.#host.conn();
    const status = await this.#host.statusByEffectId().catch(() => new Map<number, { bypassed: boolean; channel: number }>());
    for (const c of g.cells) {
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      if (!slug || !family) continue;
      const defs = prof.params[family] ?? [];
      const knobs = defs.filter((p) => {
        const r = prof.ranges[family]?.[p.paramId];
        if (r?.kind !== 'float' || r.displayMin === r.displayMax || (r.displayMin === 0 && r.displayMax === 1)) return false;
        const label = p.displayLabel ?? p.name;
        return KNOB_UNITS.has(p.unit ?? '') && !/bypass/i.test(label) && !/_/.test(label) && !/^[A-Z][A-Z0-9+]*$/.test(label);
      });
      const primary = knobs.find((p) => /level|mix|master|volume|gain|drive/i.test(p.displayLabel ?? p.name)) ?? knobs[0];
      if (!primary) continue;
      const wantIds = new Set<number>([primary.paramId, ...(wants[slug] ?? [])]);
      const vals: Record<number, MeterVal> = {};
      let typeName = '';
      try {
        const frames = await dev.request(this.#host.codec.buildBlockBulkReadPoll(c.effectId), { timeoutMs: 2000, quietMs: 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = this.#host.codec.assembleGen3BlockBulkRead(frames);
        const activeCh = status.get(c.effectId)?.channel ?? 0;
        const { base } = channelSlice(prof, family, bulk, activeCh);
        for (const id of wantIds) {
          const d = this.#paramDisplay.display(family, id, bulk.values[base + id] ?? 0);
          vals[id] = { norm: d.norm, value: d.value, unit: d.unit, min: d.min, max: d.max, log: d.log };
        }
        const typeId = this.#paramDisplay.paramId(family, 'type');
        if (typeId != null) {
          const roster = prof.rosterFor(slug);
          const tmax = Math.max(0, roster.length - 1);
          const rawT = bulk.values[base + typeId] ?? 0;
          typeName = roster[rawT > tmax ? Math.round((rawT / 65534) * tmax) : rawT]?.name ?? '';
        }
      } catch {
        /* leave vals empty for this block */
      }
      out.push({ effectId: c.effectId, slug, defaultId: primary.paramId, defaultName: primary.displayLabel ?? primary.name, typeName, vals });
    }
    return out;
  }

  /** Live audio meters per placed monitored block. Reads each block's primary monitor level via the
   *  block-level GET (fn 0x01 sub 0x01 00 by effectId); the level is a normalized 0..1 float at
   *  response offset 12-16 (LSB-first 5×7bit → uint32 → float32-LE — confirmed from the FM3 capture
   *  2026-07-02; note the standard gen-3 float decoder does NOT apply to this field). Mapped to dB
   *  via the profile's monitor table. Gen-3 only; [] if the device has no monitor table. */
  async liveMonitors(onlyEid?: number): Promise<{ effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[]> {
    const prof = this.#host.profile;
    const mon = prof.monitorParams;
    if (!mon) return [];
    // family → ALL its monitor defs (a block can expose several: OUTPUT VU L+R, M-Comp 3 bands, cab
    // gain+VU, drive gain+supply+headroom). Previously only the family's first def was read.
    const byFamily = new Map<string, { paramName: string; family: string; pid: number; role: string; minDb?: number; maxDb?: number }[]>();
    for (const [paramName, def] of Object.entries(mon)) {
      const arr = byFamily.get(def.family) ?? [];
      arr.push({ paramName, ...def });
      byFamily.set(def.family, arr);
    }
    const dev = await this.#host.conn();
    const model = prof.model;
    const out: { effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[] = [];
    // Which block(s) to poll. Axis polls the OPEN block (onlyEid) at UI rate — resolve its family
    // straight from the effectId; do NOT fetch grid() here. grid()'s 500ms cache expires right at the
    // ~500ms meter-poll interval, so a full ~24KB preset dump was firing on every tick and serializing
    // behind every read → link latency ballooned to ~400ms. Only the (rare) all-blocks call needs grid().
    const eids = onlyEid != null ? [onlyEid] : (await this.#grid.grid()).cells.filter((c) => !c.isShunt).map((c) => c.effectId);
    for (const eid of eids) {
      const slug = slugForEffectId(eid);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      const defs = family ? byFamily.get(family) : undefined;
      if (!defs) continue;
      // Poll each monitor pid via the capture-confirmed fn 0x01 sub 0x19 state read (FM3-Edit's live-meter
      // poll; value is a normalized 0..1 float mapped to dB by the table's linear range). Model-generic.
      for (const def of defs) {
        try {
          const frames = await dev.request(buildBlockMonitorPoll(eid, def.pid, model), {
            timeoutMs: 800, quietMs: 40,
            match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, def.pid))
          });
          const r = frames.find((f) => isBlockMonitorResponse(f, eid, def.pid));
          if (!r) continue;
          // The OUTPUT block's VU (eid 0x2a, pid 16/17 = sub 0x10/0x11) is the SAME frame as the
          // leveling meters → its value is RMS ENERGY, not a 0..1 norm. Decode it via 10·log10 and
          // renormalize into [min,max] for the bar. Every other block monitor is a 0..1 norm.
          let norm: number;
          let db: number | null;
          if (def.family === 'OUTPUT') {
            const lo = def.minDb ?? -40, hi = def.maxDb ?? 6;
            db = meterRmsToDb(parseOutputMeterRms(r), lo, hi);
            norm = hi > lo ? (db - lo) / (hi - lo) : 0;
          } else {
            norm = parseBlockMonitorNorm(r);
            db = def.minDb != null && def.maxDb != null ? def.minDb + norm * (def.maxDb - def.minDb) : null;
          }
          out.push({ effectId: eid, family: def.family, paramName: def.paramName, role: def.role, norm, db, minDb: def.minDb, maxDb: def.maxDb });
        } catch {
          /* skip this monitor */
        }
      }
    }
    return out;
  }

  /** Looper page telemetry: the live waveform envelope + playhead position + level (FM3 capture 2026-07-04;
   *  gen-3 shared). Waveform = fn 0x01 sub 0x23 (~595 raw 7-bit magnitudes → 0..1); position = sub 0x19
   *  pid 14 (0..1 across the loop); level = sub 0x19 pid 22. Returns empty with NO device I/O when the
   *  block isn't a looper, so Axis can poll it for whatever block is open without cost. */
  async looperTelemetry(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }> {
    if (slugForEffectId(eid) !== 'looper') return { wave: [], position: null, level: null };
    const dev = await this.#host.conn();
    const model = this.#host.profile.model;
    let wave: number[] = [];
    let position: number | null = null;
    let level: number | null = null;
    try {
      const wf = await dev.request(buildLooperWaveformPoll(eid, model), { timeoutMs: 900, quietMs: 60, match: (fs) => fs.some((f) => isLooperWaveformResponse(f, eid)) });
      const r = wf.find((f) => isLooperWaveformResponse(f, eid));
      if (r) wave = parseLooperWaveform(r);
    } catch { /* no waveform this tick */ }
    for (const [pid, isPos] of [[14, true], [22, false]] as const) {
      try {
        const fr = await dev.request(buildBlockMonitorPoll(eid, pid, model), { timeoutMs: 500, quietMs: 40, match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, pid)) });
        const rr = fr.find((f) => isBlockMonitorResponse(f, eid, pid));
        if (rr) { const v = parseBlockMonitorNorm(rr); if (isPos) position = v; else level = v; }
      } catch { /* skip */ }
    }
    return { wave, position, level };
  }

  /** Toggle a looper transport control (record/play/stop/overdub/undo/once/reverse/half) — the sub-0x10
   *  float-1.0/0.0 write FM3-Edit uses (capture 2026-07-04). `action` resolves to the block's control pid
   *  via the device catalog, so it's model-agnostic. Fire-and-forget (serialized). */
  async looperControl(eid: number, action: string, on: boolean): Promise<{ ok: boolean }> {
    if (slugForEffectId(eid) !== 'looper') return { ok: false };
    const NAME: Record<string, string> = {
      record: 'LOOPER_RECORD', play: 'LOOPER_PLAY', stop: 'LOOPER_STOP', overdub: 'LOOPER_DUB',
      undo: 'LOOPER_UNDO', once: 'LOOPER_ONCE', reverse: 'LOOPER_REVERSE', half: 'LOOPER_HALF'
    };
    const name = NAME[action];
    if (!name) return { ok: false };
    const pid = (this.#host.profile.params['LOOPER'] ?? []).find((p) => p.name === name)?.paramId;
    if (pid == null) return { ok: false };
    const dev = await this.#host.conn();
    await dev.sendQueued(buildLooperControl(eid, pid, on, this.#host.profile.model));
    return { ok: true };
  }
}
