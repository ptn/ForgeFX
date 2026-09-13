// Gen-3 FC / raw-address collaborator: per-pid GET (sub 01/1a), the structured sub-01 switch read,
// the sub-0x1b live value channel, and the raw sparse bulk read used for FC / Modifier blocks (whose
// params carry no display range). Split out of gen3.ts.
import type { FcSwitchState, FcReadState } from '../types.js';
import { driverConfig } from '../types.js';
import { enc14, gen3Frame, unpackF32 } from '../shared/gen3Frame.js';
import type { Gen3Host } from './host.js';

export class FcReader {
  #host: Gen3Host;

  constructor(host: Gen3Host) { this.#host = host; }

  /** Read specific paramIds of an effect via per-pid fn 0x01 GET (sub 01 00) — the path FM3-Edit uses
   *  to load FC state. Returns {pid: float value}. The RX value is a 5×7-bit packed float32 at byte 12. */
  async readParams(eid: number, pids: number[]): Promise<Record<number, number>> {
    const dev = await this.#host.conn();
    const out: Record<number, number> = {};
    // Proper gen-3 GET: fn 0x01 with sub 01 00 + EMPTY value (NOT buildGetParameter, which uses the
    // SET-typed sub 09 00 and therefore WRITES 0). Frame: F0 00 01 74 <model> 01 01 00 <eid> <pid> 0*9 cs F7.
    const buildGet = (e: number, p: number): number[] =>
      gen3Frame(this.#host.profile.model, 0x01, 0x01, 0x00, [...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (const pid of pids) {
      try {
        const frames = await dev.request(buildGet(eid, pid), {
          timeoutMs: 800,
          quietMs: 50,
          match: (fs) => fs.some((f) => f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid)
        });
        const f = frames.find((fr) => fr[5] === 0x01 && fr[6] === 0x01 && fr[7] === 0x00 && (fr[8]! | (fr[9]! << 7)) === eid && (fr[10]! | (fr[11]! << 7)) === pid);
        if (f) {
          if (driverConfig(this.#host.ctx).getDump) console.log(`GETDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
          out[pid] = unpackF32(f.slice(12, 17));
        }
      } catch {
        /* skip unreadable pid */
      }
    }
    return out;
  }

  /** FC read path: sub 0x1a range-read (the opcode FM3-Edit uses on FC-page entry; the plain 01 00 GET
   *  returns junk for eid 199). The 60-byte response carries a NORMALIZED float32 at byte 12 (0..1 over
   *  the param's range). Returns {pid: norm}; logs the raw frame when FORGEFX_GETDUMP is set. */
  async readRange(eid: number, pids: number[]): Promise<Record<number, number>> {
    const dev = await this.#host.conn();
    const out: Record<number, number> = {};
    const buildGet = (e: number, p: number): number[] =>
      gen3Frame(this.#host.profile.model, 0x01, 0x1a, 0x00, [...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (const pid of pids) {
      try {
        const match = (f: number[]) => f[5] === 0x01 && f[6] === 0x1a && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
        const frames = await dev.request(buildGet(eid, pid), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (f) {
          if (driverConfig(this.#host.ctx).getDump) console.log(`RANGEDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
          out[pid] = unpackF32(f.slice(12, 17));
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /**
   * FC (eid 199) structured switch-config read — the per-switch read FM3-Edit uses on FC-page entry.
   *
   * Request: function 0x01, **sub-action 0x01**, addressed by a *config selector*: frame
   *   `F0 00 01 74 <model> 01 01 00 <sel:2×7bit LE> 0*9 cs F7`. selector = config*2 + side,
   *   side 0 = TAP, 1 = HOLD. config is the standard FC config index (layout*12 + view*3 + switch).
   *
   * Response: an **87-byte** frame whose body (bytes after `F0 00 01 74 <model> 01 01`) carries the
   *   config echo at body[14] and the side flag (0x40 = HOLD) at body[15]. The interior packed field
   *   record is NOT decoded — the raw bytes are returned for the caller.
   */
  async fcReadSwitch(layout: number, view: number, sw: number): Promise<FcSwitchState> {
    const dev = await this.#host.conn();
    const model = this.#host.profile.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC switch read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const buildSelRead = (sel: number): number[] =>
      gen3Frame(this.#host.profile.model, 0x01, 0x01, 0x00, [...enc14(sel), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // body = frame bytes after the 7-byte header (F0 00 01 74 <model> 01 01), minus checksum+F7
    const readSide = async (side: 0 | 1): Promise<{ present: boolean; raw: number[] }> => {
      const sel = config * 2 + side;
      try {
        const match = (f: number[]) =>
          f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === sel && f.length >= 80;
        const frames = await dev.request(buildSelRead(sel), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (!f) return { present: false, raw: [] };
        const body = f.slice(7, -2);
        if (driverConfig(this.#host.ctx).getDump) console.log(`FCDUMP sel=${sel} body=${body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
        // validate the config/side echo (body[14]=config, body[15] bit 0x40 = HOLD)
        const echoCfg = body[14] ?? -1;
        const echoSide = (body[15] ?? 0) & 0x40 ? 1 : 0;
        const present = echoCfg === config && echoSide === side;
        return { present, raw: body };
      // (empty-slot heuristic computed by the caller from raw[16..]; see fcReadSwitch return)
      } catch {
        return { present: false, raw: [] };
      }
    };
    const tap = await readSide(0);
    const hold = await readSide(1);
    // Empty-slot heuristic: an unassigned switch returns its primary value region (body[18],[19]) as
    // 0,0 (confirmed live: an explicitly-unassigned switch reads 0,0 while an assigned/templated one
    // carries a non-zero value there). This is the one interior signal that is stable enough to surface;
    // it is a presence hint, not a field decode.
    const emptyOf = (b: number[]) => !b.length || ((b[18] ?? 0) === 0 && (b[19] ?? 0) === 0);
    return {
      effectId: model.effectId,
      layout,
      view,
      switch: sw,
      config,
      tap: { selector: config * 2, present: tap.present, empty: emptyOf(tap.raw), raw: tap.raw },
      hold: { selector: config * 2 + 1, present: hold.present, empty: emptyOf(hold.raw), raw: hold.raw }
    };
  }

  /**
   * FC current-state read via the **sub-0x1b value channel** — the one that actually reflects param
   * edits. Request `F0 00 01 74 <model> 01 1b 00 <eid:2×7bit> <pid:2×7bit> 0*9 cs F7`; the response
   * carries the field's **raw value as a little-endian 7-bit int at body byte 12** (ordinal for enums,
   * ASCII for label chars). Distinct from `readRange` (sub 0x1a → normalized 0..1) and from
   * `fcReadSwitch` (sub 0x01 → a compiled snapshot that does NOT track edits).
   */
  async fcReadState(layout: number, view: number, sw: number): Promise<FcReadState> {
    const dev = await this.#host.conn();
    const model = this.#host.profile.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC state read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const eid = model.effectId;
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const build = (pid: number): number[] =>
      gen3Frame(this.#host.profile.model, 0x01, 0x1b, 0x00, [...enc14(eid), ...enc14(pid), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const read = async (pid: number): Promise<number | null> => {
      const match = (f: number[]) =>
        f[5] === 0x01 && f[6] === 0x1b && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
      try {
        const frames = await dev.request(build(pid), { timeoutMs: 800, quietMs: 40, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        return f ? (f[12]! | (f[13]! << 7)) : null; // raw ordinal / ASCII, LE 7-bit
      } catch {
        return null;
      }
    };
    const pidOf = (field: string, idx = 0): number => {
      const fd = model.fields[field];
      if (!fd || fd.base == null || fd.stride == null) throw new Error(`FC field '${field}' has no base/stride on this device`);
      return fd.base + config * fd.stride + idx;
    };
    const readLabel = async (field: string): Promise<string> => {
      let s = '';
      for (let i = 0; i < (model.labelLen ?? 0); i++) {
        const c = await read(pidOf(field, i));
        if (c && c > 0) s += String.fromCharCode(c); // 0 = NUL pad
      }
      return s;
    };
    const fields: Record<string, number | null> = {};
    for (const field of ['tapCategory', 'tapFunction', 'tapDisplay', 'holdCategory', 'holdFunction', 'holdDisplay', 'color']) {
      fields[field] = await read(pidOf(field));
    }
    return { effectId: eid, layout, view, switch: sw, config, fields, tapLabel: await readLabel('tapLabel'), holdLabel: await readLabel('holdLabel') };
  }

  /** Sparse bulk-read of one effect's non-zero param values, keyed by paramId — for FC (eid 199) /
   *  Modifier (eid 3), whose params carry no display range so blockParams returns them empty. */
  async readRawValues(eid: number): Promise<Record<number, number>> {
    const dev = await this.#host.conn();
    const frames = await dev.request(this.#host.codec.buildBlockBulkReadPoll(eid), {
      timeoutMs: 2500,
      quietMs: 120,
      match: (fs) => fs.some((f) => f[5] === 0x76)
    });
    const bulk = this.#host.codec.assembleGen3BlockBulkRead(frames);
    const values: Record<number, number> = {};
    bulk.values.forEach((v, i) => {
      if (v) values[i] = v;
    });
    return values;
  }

  async rawBlock(eid: number): Promise<{ eid: number; values: Record<number, number> }> {
    return { eid, values: await this.readRawValues(eid) };
  }
}
