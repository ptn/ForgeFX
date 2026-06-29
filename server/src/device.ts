// High-level FM3 device service. Wire protocol + catalog/params/rosters/enums/cab-IRs all via fractal-midi.
import {
  buildQueryPatchName,
  isQueryPatchNameResponse,
  parseQueryPatchNameResponse,
  buildStatusDump,
  buildRequestPresetDump,
  buildBlockBulkReadPoll,
  assembleGen3BlockBulkRead,
  buildSetParameter,
  buildSetParameterContinuous,
  buildSetBypass,
  buildSetChannel,
  buildSetGridCell,
  buildClearBlock,
  buildSetGridRouting,
  buildSwitchPresetSysEx,
  buildStorePreset,
  buildGetTempo,
  buildTempoTap,
  buildSetScene,
  buildGetScene,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT
} from 'fractal-midi/gen3/axe-fx-iii';
import { resolveEnumValues } from 'fractal-midi/gen3/axe-fx-iii';
import { wireToDisplay } from 'fractal-midi/shared';
import { autoDetectPath } from './transport/serial.js';
import { listConnections, resolveConn, openConn, getConnOverride, setConnOverride } from './transport/connection.js';
import type { Transport, Conn } from './transport/types.js';
import { decodePresetDump, slugForEffectId, effectRoster, blockInstances, blockRefForEid } from './codec/fm3PresetGrid.js';
import { DEVICE_MODELS, MODEL_BROADCAST } from './models.js';
import { DEFAULT_PROFILE, profileForModel, profileForKey, SLUG_FAMILY, type DeviceProfile, type TypeModel } from './devices.js';

// slug → { name, page=base effect id } from the authoritative codec base table (replaces the old
// defs.js pack lookup; block names + base ids are codec facts, not editor-cache definitions).
const BLOCK_META: Record<string, { name: string; page: number }> = (() => {
  const out: Record<string, { name: string; page: number }> = {};
  for (const e of effectRoster()) out[e.slug] = { name: e.name, page: e.page };
  return out;
})();

const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer
const CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// catalog unit code → display label (blank = show the bare number)
const UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%',
  degrees: '°', semitones: 'st', pf: 'pF', ratio: ':1'
};
// units that mark a musician-facing knob. 'numeric' = a plain unitless knob (Drive, Tone, Level,
// cut freqs…) — primary controls in many families; only 'unverified'/'count'/'enum' are non-knobs.
const KNOB_UNITS = new Set([
  'numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees'
]);

export interface GridCellDTO { row: number; col: number; effectId: number; name: string; isShunt: boolean; routeFlag: number; fromRows: number[]; }
export interface PresetGridDTO { model: string; name: string; crcValid: boolean; rows: number; cols: number; scenes: string[]; cells: GridCellDTO[]; source: 'dump'; }
export interface PresetBlockDTO { slug: string; name: string; effectId: number; row: number; col: number; fromRows: number[]; bypassed: boolean | null; channel: string | null; }
export interface NamedParam { id: number; name: string; value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean; }
export interface EnumParam { id: number; name: string; value: number; options: { value: number; label: string }[]; }
export interface MeterVal { norm: number; value: number; unit?: string; min?: number; max?: number; log?: boolean; }

// Live pushes streamed to Axis over SSE.
export type DeviceEvent =
  | { type: 'tuner'; freq: number; note?: string; cents?: number; octave?: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'scene'; index: number }
  | { type: 'cpu'; percent: number };

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Append 1/2/3… to labels that repeat within a list (e.g. the cab's four "Low Cut" mic params),
 * so the UI can tell otherwise-identical controls apart. Mutates the items' `name`. */
function dedupeLabels(items: { name: string }[]): void {
  const total = new Map<string, number>();
  for (const it of items) total.set(it.name, (total.get(it.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const it of items) {
    if ((total.get(it.name) ?? 0) > 1) {
      const n = (seen.get(it.name) ?? 0) + 1;
      seen.set(it.name, n);
      it.name = `${it.name} ${n}`;
    }
  }
}
/** Detected frequency (Hz) → musical note + cents offset (equal temperament, A4=440). */
function freqToNote(f: number): { note: string; cents: number; octave: number } | null {
  if (!(f > 0) || !Number.isFinite(f)) return null;
  const midi = 69 + 12 * Math.log2(f / 440);
  const nearest = Math.round(midi);
  return {
    note: NOTE_NAMES[((nearest % 12) + 12) % 12]!,
    cents: Math.round((midi - nearest) * 100),
    octave: Math.floor(nearest / 12) - 1
  };
}
/** Decode a 5-septet (35-bit) little-endian float32 starting at frame offset `off`. */
function decodeFloat32At(frame: number[], off: number): number {
  let u = 0;
  for (let i = 0; i < 5; i++) u |= (frame[off + i]! & 0x7f) << (7 * i);
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, u >>> 0, true);
  return dv.getFloat32(0, true);
}
/** Friendly param label: the catalog displayLabel, else tidy the raw NAME (strip family prefix, _→space). */
function paramLabel(p: { displayLabel?: string; name: string }): string {
  return p.displayLabel ?? p.name.replace(/^[A-Z0-9]+_/, '').replace(/_/g, ' ');
}

class Device {
  #transport: Transport | null = null;
  #connecting: Promise<Transport> | null = null;
  // active device profile (model byte, grid size, params, ranges, rosters). Starts from FORGEFX_DEVICE
  // if set, otherwise FM3, and is corrected to the real unit on the first detect.
  #prof: DeviceProfile = (process.env.FORGEFX_DEVICE ? profileForKey(process.env.FORGEFX_DEVICE) : undefined) ?? DEFAULT_PROFILE;
  #detected = false;
  get profile() { return this.#prof; }
  #gridCache: { grid: PresetGridDTO; at: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load

  // ── event bus (SSE source): live tuner/scene/tempo/cpu pushes ──
  #subscribers = new Set<(e: DeviceEvent) => void>();
  #tunerTimer: ReturnType<typeof setTimeout> | null = null;
  subscribe(fn: (e: DeviceEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }
  #emit(e: DeviceEvent) {
    for (const fn of this.#subscribers) {
      try {
        fn(e);
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
  }

  get port() { return this.#transport?.label ?? autoDetectPath(); }

  async #conn(): Promise<Transport> {
    if (this.#transport?.isOpen) return this.#transport;
    // share a single open across concurrent callers — the UI fires many requests on load, and
    // opening the same port twice fails the exclusive lock ("Cannot lock port").
    if (!this.#connecting) {
      this.#connecting = (async () => {
        const conn = await resolveConn(); // serial (FM3 CDC) or MIDI (Axe-Fx III), manual override wins
        if (!conn) throw new Error('No Fractal device found on any serial or MIDI port. Connect the unit, quit other editors, or pick it under Connection.');
        const t = openConn(conn);
        await t.open();
        this.#transport = t;
        return t;
      })().catch((e) => {
        this.#connecting = null; // allow a retry on the next request
        throw e;
      });
    }
    return this.#connecting;
  }

  /** Build a Fractal SysEx frame: F0 00 01 74 <model> <fn> <data…> <cs> F7. cs = XOR of all
   * preceding bytes & 0x7f (verified against captured frames). */
  #envelope(fn: number, data: number[]): number[] {
    const body = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, fn, ...data];
    let cs = 0;
    for (const b of body) cs ^= b;
    return [...body, cs & 0x7f, 0xf7];
  }

  // Tuner: FM3-Edit opens the tuner page (fn 0x12 sub 0x1e) then POLLS fn 0x01 sub 0x19 field 0x02,
  // whose value field (float32 @ off 12) is the detected fundamental in Hz. We replicate that and
  // stream note/cents over SSE. (Reverse-engineered from an FM3-Edit capture.)
  async #pollTuner() {
    if (!this.#tunerTimer) return;
    try {
      const dev = await this.#conn();
      const req = this.#envelope(0x01, [0x19, 0x00, 0x23, 0x00, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const frames = await dev.request(req, {
        timeoutMs: 300,
        quietMs: 35,
        match: (fs) => fs.some((f) => f[5] === 0x01 && f[6] === 0x19 && f[10] === 0x02)
      });
      const f = frames.find((x) => x[5] === 0x01 && x[6] === 0x19 && x[10] === 0x02);
      if (f) {
        const freq = decodeFloat32At(f, 12);
        this.#emit({ type: 'tuner', freq: Math.round(freq * 100) / 100, ...(freqToNote(freq) ?? {}) });
      }
    } catch {
      /* transient — keep polling */
    }
    if (this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 55);
  }

  /** Fire-and-forget write, serialized on the request chain (so it never injects mid-read). */
  async #send(bytes: number[]): Promise<{ ok: boolean }> {
    await (await this.#conn()).sendQueued(bytes);
    return { ok: true };
  }

  /** Write + watch a short window for a 0x64 rejection. For structural ops where a reject matters. */
  async #write(bytes: number[]): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const frames = await dev.request(bytes, { timeoutMs: 120, quietMs: 60, match: (fs) => fs.some((f) => f[5] === 0x64) });
    return { ok: !frames.some((f) => f[5] === 0x64) };
  }

  async health() {
    const conn = await resolveConn();
    return { ok: !!conn, device: this.#prof.name };
  }

  /** Every connection (serial + MIDI, Fractal flagged) + the chosen one + any manual override. */
  async connections() {
    return { chosen: await resolveConn(), override: getConnOverride(), ports: await listConnections() };
  }
  /** Manually pick a connection (persisted); null clears it back to auto-detect. Drops the live
   *  connection so the next request reconnects on the chosen port and re-runs the model handshake. */
  async selectConnection(conn: Conn | null) {
    setConnOverride(conn);
    if (this.#transport) {
      await this.#transport.close().catch(() => {});
      this.#transport = null;
    }
    this.#connecting = null;
    this.#detected = false;
    return { ok: true, chosen: await resolveConn() };
  }
  async deviceInfo() {
    return { model: this.#prof.name, modelByte: `0x${this.#prof.model.toString(16)}`, firmware: null as null | { version: string; build: string }, port: this.port };
  }

  /** Ensure the active profile matches the attached unit — runs detect once, lazily, so direct API
   * use (not just the Axis client) still adapts to an FM9 vs FM3 without an explicit detect call. */
  async #ready() {
    if (this.#detected) return;
    this.#detected = true;
    try {
      await this.detect();
    } catch {
      /* keep the default/env profile if detection fails */
    }
  }

  /** Auto-detect the connected Fractal unit. Broadcasts the fn 0x00 handshake to the wildcard
   * model 0x7F; the device replies with its own header, whose model byte (f[4]) identifies it.
   * Lets clients auto-connect and know whether a live codec exists for what's attached. */
  async detect(): Promise<{ connected: boolean; modelId: number; name: string; short: string; gen: number; supported: boolean; port: string | null }> {
    const port = this.port;
    if (!port) return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, port: null };
    try {
      const dev = await this.#conn();
      const body = [0xf0, 0x00, 0x01, 0x74, MODEL_BROADCAST, 0x00];
      let cs = 0;
      for (const b of body) cs ^= b;
      const probe = [...body, cs & 0x7f, 0xf7];
      const hdr = (f: number[]) => f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && f.length > 5;
      const frames = await dev.request(probe, { timeoutMs: 1500, quietMs: 60, match: (fs) => fs.some(hdr) });
      const f = frames.find(hdr);
      const modelId = f ? f[4]! : -1;
      const m = DEVICE_MODELS[modelId];
      // adopt the detected unit's profile so all reads/writes use its model byte, grid + ranges
      // (profileForModel falls back to FM3, so only switch when there's a real profile for this model)
      const p = profileForModel(modelId);
      if (p.model === modelId) this.#prof = p;
      this.#detected = true;
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        port
      };
    } catch {
      return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, port };
    }
  }

  /** Current preset number + name (one query). */
  async presetRef(): Promise<{ number: number; name: string }> {
    await this.#ready();
    const dev = await this.#conn();
    const frames = await dev.request(buildQueryPatchName('current', this.#prof.model), {
      timeoutMs: 1200,
      match: (fs) => fs.some((f) => isQueryPatchNameResponse(f, this.#prof.model))
    });
    const f = frames.find((x) => isQueryPatchNameResponse(x, this.#prof.model));
    if (!f) return { number: -1, name: '' };
    const r = parseQueryPatchNameResponse(f, this.#prof.model);
    return { number: r.presetNumber, name: r.name };
  }

  /** Routing grid via the hardware-validated dump decoder. Deduped + short-TTL cached. */
  async grid(): Promise<PresetGridDTO> {
    await this.#ready();
    if (this.#gridInflight) return this.#gridInflight; // coalesce concurrent callers
    if (this.#gridCache && Date.now() - this.#gridCache.at < Device.GRID_TTL_MS) return this.#gridCache.grid;
    this.#gridInflight = this.#dumpGrid();
    try {
      const g = await this.#gridInflight;
      this.#gridCache = { grid: g, at: Date.now() };
      return g;
    } finally {
      this.#gridInflight = null;
    }
  }

  async #dumpGrid(): Promise<PresetGridDTO> {
    const dev = await this.#conn();
    const frames = await dev.request(buildRequestPresetDump(EDIT_BUFFER, this.#prof.model), {
      timeoutMs: 5000,
      quietMs: 180,
      match: (fs) => fs.some((f) => f[5] === 0x79) // 0x79 = dump terminator
    });
    const d = decodePresetDump(frames, this.#prof.model);
    return {
      model: 'fm3',
      name: d.name,
      crcValid: d.crcValid,
      rows: d.rows,
      cols: d.cols,
      scenes: d.sceneNames,
      cells: d.grid.map((c) => ({ row: c.row, col: c.col, effectId: c.effectId, name: c.name, isShunt: c.isShunt, routeFlag: c.routeFlag, fromRows: c.fromRows })),
      source: 'dump'
    };
  }

  async #statusByEffectId(): Promise<Map<number, { bypassed: boolean; channel: number }>> {
    const dev = await this.#conn();
    const map = new Map<number, { bypassed: boolean; channel: number }>();
    try {
      // fractal-midi's isStatusDumpResponse is locked to model 0x10 (III), so match the
      // 0x13 frame ourselves (any model) and parse the id-id-dd triples inline.
      const frames = await dev.request(buildStatusDump(this.#prof.model), { timeoutMs: 1500, match: (fs) => fs.some((f) => f[5] === 0x13) });
      const f = frames.find((x) => x[5] === 0x13);
      if (f) {
        const payload = f.slice(6, f.length - 2);
        for (let i = 0; i + 2 < payload.length; i += 3) {
          const effectId = (payload[i]! & 0x7f) | ((payload[i + 1]! & 0x7f) << 7);
          const dd = payload[i + 2]! & 0x7f;
          map.set(effectId, { bypassed: (dd & 0x01) !== 0, channel: (dd >> 1) & 0x07 });
        }
      }
    } catch {
      /* status optional */
    }
    return map;
  }

  /** Placed blocks: position + routing + live bypass/channel. */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const g = await this.grid();
    const status = await this.#statusByEffectId();
    const out: PresetBlockDTO[] = [];
    for (const c of g.cells) {
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId) ?? '';
      const st = status.get(c.effectId);
      out.push({
        slug,
        name: c.name,
        effectId: c.effectId,
        row: c.row,
        col: c.col,
        fromRows: c.fromRows,
        bypassed: st ? st.bypassed : null,
        channel: st ? CH_LETTERS[st.channel] ?? null : null
      });
    }
    return out;
  }

  // ── catalog ──
  // Full placeable roster — one entry PER INSTANCE (Amp 1, …, Output 1, Output 2) so the palette can
  // place a specific instance instead of always re-sending instance 1 (which the device refuses once
  // that instance is on the grid). Instance count = the DEVICE-TRUE count from the profile
  // (`instanceLimits[slug]` else `defaultInstances`), clamped to the protocol's reserved ID range
  // (`blockInstances`). `page` is the exact effect id (firstId + instance-1).
  blocksCatalog() {
    const out: { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[] = [];
    for (const e of effectRoster()) {
      const fam = SLUG_FAMILY[e.slug];
      const paramCount = fam ? (this.#prof.params[fam]?.length ?? 0) : 0;
      const typeCount = this.#prof.rosterFor(e.slug).length;
      const limit = this.#prof.instanceLimits[e.slug] ?? this.#prof.defaultInstances;
      const n = Math.max(1, Math.min(blockInstances(e.slug), limit));
      for (let i = 0; i < n; i++) {
        out.push({ slug: e.slug, family: e.slug, instance: i + 1, name: n > 1 ? `${e.name} ${i + 1}` : e.name, page: e.page + i, paramCount, typeCount });
      }
    }
    return out;
  }
  blockTypes(slug: string): TypeModel[] {
    return this.#prof.rosterFor(slug);
  }

  /**
   * Read a placed block's params via the fn=0x1F bulk read. The 0x75 body is
   * CHANNEL-BLOCKED: index = channel*stride + paramId, stride = paramCount,
   * channelCount = values.length/stride (per-block, NOT always 4). `norm` = raw/65534
   * (knob position); `value`/`unit` are the device-true DISPLAY reading via this.#prof.ranges
   * (e.g. 1.2k Hz, -12 dB) where the cache has a range, else the 0..10 position.
   */
  async blockParams(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null }> {
    await this.#ready();
    const slug = slugForEffectId(eid) ?? ''; // address the EXACT placed instance, not the first of its family
    const meta = BLOCK_META[slug];
    const family = SLUG_FAMILY[slug.toLowerCase()];
    const blockName = meta?.name ?? family ?? slug;
    const page = meta?.page ?? -1;
    if (!family) {
      return { block: blockName, slug, page, named: [], enums: [], type: null }; // no device-true param family mapped
    }
    const defs = this.#prof.params[family] ?? [];
    // knob params = continuous, musician-facing: a float range + a real display unit
    // (drops enum selectors, internal 'numeric'/'unverified' params, and bypass flags).
    // knobs = every continuous param with a usable range. We expose ALL real controls (the UI
    // organizes them); only genuinely-dead params are dropped: no range (min===max) or the bypass flag.
    const seenIds = new Set<number>();
    const knobs = defs.filter((p) => {
      const range = this.#prof.ranges[family]?.[p.paramId];
      if (range?.kind !== 'float') return false;
      if (!KNOB_UNITS.has(p.unit ?? '')) return false;
      if (/bypass/i.test(p.displayLabel ?? p.name)) return false;
      if (range.displayMin === range.displayMax) return false; // unusable (0..0) knob
      if (seenIds.has(p.paramId)) return false; // dedupe same wire paramId (first wins)
      seenIds.add(p.paramId);
      return true;
    });
    // enums = every discrete selector. The family TYPE selector is excluded (header retype palette),
    // plus the raw bypass flag; everything else (modes, slopes, mics, mic/cab pickers…) is shown.
    const typeId = this.#paramId(family, 'type');
    const enumDefs = defs.filter((p) => {
      const range = this.#prof.ranges[family]?.[p.paramId];
      if (range?.kind !== 'enum' || p.paramId === typeId) return false;
      if (range.displayMax <= range.displayMin) return false;
      if (/^bypass$/i.test(p.displayLabel ?? p.name)) return false;
      return true;
    });
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    {
      const dev = await this.#conn();
      try {
        const activeCh = 0; // channel A (skip the per-open status dump — one fewer serial round-trip)
        const frames = await dev.request(buildBlockBulkReadPoll(eid, this.#prof.model), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = assembleGen3BlockBulkRead(frames, this.#prof.model);
        const stride = Math.max(1, ...defs.map((p) => p.paramId)) + 1;
        const channelCount = Math.max(1, Math.floor(bulk.values.length / stride));
        const base = Math.min(activeCh, channelCount - 1) * stride;
        for (const p of knobs) {
          const raw = bulk.values[base + p.paramId] ?? 0;
          named.push({ id: p.paramId, name: paramLabel(p), ...this.#display(family, p.paramId, raw) });
        }
        for (const p of enumDefs) {
          const range = this.#prof.ranges[family]![p.paramId]!;
          const max = Math.round(range.displayMax);
          const min = Math.round(range.displayMin);
          const raw = bulk.values[base + p.paramId] ?? 0;
          // discrete params store the ordinal; if the wire value looks 16-bit-scaled, unscale it
          const value = raw > max ? Math.round((raw / 65534) * (max - min)) + min : raw;
          enums.push({ id: p.paramId, name: paramLabel(p), value, options: this.#enumOptions(family, p.paramId, p.name, min, max) });
        }
        // current model/type (for EQ band layout etc.)
        if (typeId != null) {
          const roster = this.#prof.rosterFor(slug);
          const max = Math.max(0, roster.length - 1);
          const raw = bulk.values[base + typeId] ?? 0;
          const tv = raw > max ? Math.round((raw / 65534) * max) : raw;
          type = { value: tv, name: roster[tv]?.name ?? '' };
        }
      } catch {
        named.length = 0; // a mid-loop throw left partial data — reset before the zeroed fallback
        for (const p of knobs) named.push({ id: p.paramId, name: paramLabel(p), value: 0, norm: 0 });
      }
    }
    // disambiguate repeated labels within a block (e.g. the cab's 4× "Low Cut", amp's two "Depth")
    // so identical names get a 1/2/3 suffix the UI can tell apart.
    dedupeLabels(named);
    dedupeLabels(enums);
    return { block: blockName, slug, page, named, enums, type };
  }

  /** Cab block state for the IR picker: current mode (Legacy / DynaCab), per-slot bank + IR index +
   * dyna type, plus the option lists. IR names come from fractal-midi (profile.cabIrs() / GET /cab/irs).
   * Writes are plain setParam calls: bank = ord at param 0|1, IR index = raw index at param 4|5,
   * mode = ord at 31, dyna type = ord at 85|86. */
  async cabState(eid: number) {
    await this.#ready();
    const slug = slugForEffectId(eid) ?? '';
    const family = SLUG_FAMILY[slug.toLowerCase()];
    if (family !== 'CABINET') return { error: 'not a cab block' };
    let values: number[] = [];
    try {
      const dev = await this.#conn();
      const frames = await dev.request(buildBlockBulkReadPoll(eid, this.#prof.model), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
      values = assembleGen3BlockBulkRead(frames, this.#prof.model).values;
    } catch {
      /* device unreachable — return option lists with zeroed current state */
    }
    // discrete params store the ordinal; if it looks 16-bit-scaled, unscale against the known max
    const ord = (id: number, max: number) => { const raw = values[id] ?? 0; return max > 0 && raw > max ? Math.round((raw / 65534) * max) : raw; };
    const bankOptions = this.#enumOptions(family, 0, 'Bank', 0, 4).map((o) => o.label);
    const dynaLabels = this.#prof.enumLabelsFor(family, 85) ?? [];
    const dynaOptions = this.#enumOptions(family, 85, 'DynaCab Type', 0, Math.max(0, dynaLabels.length - 1));
    const modeOptions = this.#enumOptions(family, 31, 'Mode', 0, 1);
    const irBanks = this.#prof.cabIrs();
    const slots = [0, 1].map((s) => {
      const bankV = ord(s, bankOptions.length - 1);
      const bankLabel = bankOptions[bankV] ?? String(bankV);
      const list = irBanks[bankLabel] ?? [];
      const irIndex = ord(4 + s, Math.max(0, list.length - 1));
      const dynaV = ord(85 + s, Math.max(0, dynaOptions.length - 1));
      return { slot: s + 1, bankParam: s, irParam: 4 + s, dynaParam: 85 + s, bank: { value: bankV, label: bankLabel }, irIndex, irName: list[irIndex] ?? `#${irIndex}`, dyna: { value: dynaV, label: dynaOptions[dynaV]?.label ?? String(dynaV) } };
    });
    const modeV = ord(31, 1);
    return { modeParam: 31, mode: { value: modeV, label: modeOptions[modeV]?.label ?? '' }, modeOptions, bankOptions, dynaOptions, slots };
  }

  /** Per-block "meter" values for the always-on grid level fill + swipe controls.
   * For each placed block: one bulk read → the norm of its primary param (auto-picked Level/Mix/…)
   * plus any client-requested swipe-control paramIds (`wants[slug]`). One HTTP call, N serial reads. */
  async meters(wants: Record<string, number[]> = {}): Promise<
    { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[]
  > {
    const g = await this.grid();
    const out: { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[] = [];
    const dev = await this.#conn();
    for (const c of g.cells) {
    await this.#ready();
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      if (!slug || !family) continue;
      const defs = this.#prof.params[family] ?? [];
      const knobs = defs.filter((p) => {
        const r = this.#prof.ranges[family]?.[p.paramId];
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
        const frames = await dev.request(buildBlockBulkReadPoll(c.effectId, this.#prof.model), { timeoutMs: 2000, quietMs: 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = assembleGen3BlockBulkRead(frames, this.#prof.model);
        for (const id of wantIds) {
          const d = this.#display(family, id, bulk.values[id] ?? 0);
          vals[id] = { norm: d.norm, value: d.value, unit: d.unit, min: d.min, max: d.max, log: d.log };
        }
        const typeId = this.#paramId(family, 'type');
        if (typeId != null) {
          const roster = this.#prof.rosterFor(slug);
          const tmax = Math.max(0, roster.length - 1);
          const rawT = bulk.values[typeId] ?? 0;
          typeName = roster[rawT > tmax ? Math.round((rawT / 65534) * tmax) : rawT]?.name ?? '';
        }
      } catch {
        /* leave vals empty for this block */
      }
      out.push({ effectId: c.effectId, slug, defaultId: primary.paramId, defaultName: primary.displayLabel ?? primary.name, typeName, vals });
    }
    return out;
  }

  /** Build dropdown options for an enum param. Labels come from fractal-midi's enum overlay
   * (matched by device param name) where known; otherwise the bare ordinal. */
  #enumOptions(family: string, paramId: number, name: string, min: number, max: number): { value: number; label: string }[] {
    const cache = this.#prof.enumLabelsFor(family, paramId); // device-true labels from the editor cache
    const ov = resolveEnumValues(name); // III overlay fallback
    const out: { value: number; label: string }[] = [];
    for (let v = min; v <= max && out.length < 128; v++) {
      out.push({ value: v, label: cache?.[v] ?? ov?.values?.[v] ?? String(v) });
    }
    return out;
  }

  /** Map a raw 0..65534 wire value to {value, norm, unit, min, max, log} via the device-true FM3 range.
   * Taper from typecode: middle nibble 4/5 = log10 (e.g. freq cuts), else linear. */
  #display(family: string | undefined, paramId: number, raw: number): { value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean } {
    const norm = clamp01(raw / 65534);
    const range = family ? this.#prof.ranges[family]?.[paramId] : undefined;
    if (range && range.kind === 'float' && Number.isFinite(range.displayMin) && Number.isFinite(range.displayMax) && range.displayMin !== range.displayMax) {
      try {
        const taperNib = (range.typecode >> 4) & 0xf;
        const log = (taperNib === 4 || taperNib === 5) && range.displayMin > 0;
        const v = wireToDisplay(raw, { displayMin: range.displayMin, displayMax: range.displayMax, displayScale: log ? 'log10' : 'linear' });
        const unitCode = family ? this.#prof.params[family]?.find((x) => x.paramId === paramId)?.unit : undefined;
        return { value: round3(v), norm, unit: (unitCode && UNIT_LABEL[unitCode]) || undefined, min: range.displayMin, max: range.displayMax, log: log || undefined };
      } catch {
        /* fall through to 0..10 position */
      }
    }
    return { value: Math.round(norm * 1000) / 100, norm }; // 0..10 fallback
  }

  /** Resolve a param name (display label) → device-true paramId. 'Type' → the model-selector enum. */
  #paramId(family: string, name: string): number | undefined {
    const defs = this.#prof.params[family] ?? [];
    if (name.toLowerCase() === 'type') return defs.find((p) => p.unit === 'enum' && /TYPE$/i.test(p.name))?.paramId;
    return defs.find((p) => p.displayLabel === name || p.name === name)?.paramId;
  }

  // ── writes (all address the exact placed instance by effect id) ──
  async setParam(eid: number, paramId: number, value: number, continuous: boolean) {
    // continuous knob writes stream at high frequency → fire-and-forget (instant);
    // a discrete write (enum) is rarer + worth confirming, so reject-watch it.
    if (continuous) return this.#send(buildSetParameterContinuous(eid, paramId, clamp01(value), this.#prof.model));
    return this.#write(buildSetParameter(eid, paramId, value, this.#prof.model));
  }
  /** Change a block's model/type (the family TYPE selector ordinal). */
  async setType(eid: number, value: number) {
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
    const tid = family ? this.#paramId(family, 'type') : undefined;
    if (tid == null) return { ok: false };
    return this.#write(buildSetParameter(eid, tid, value, this.#prof.model));
  }
  async setBypass(eid: number, bypassed: boolean) {
    return this.#send(buildSetBypass(eid, bypassed, this.#prof.model)); // instant toggle
  }
  async setChannel(eid: number, channel: string) {
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (idx < 0 || idx > 3) return { ok: false };
    return this.#send(buildSetChannel(eid, idx as 0 | 1 | 2 | 3, this.#prof.model)); // instant
  }

  // ── telemetry: tuner / tempo / scene ──
  async setTuner(on: boolean) {
    const dev = await this.#conn();
    if (on) {
      await dev.sendQueued(this.#envelope(0x12, [0x1e])); // open the FM3 tuner page
      if (!this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 30);
    } else {
      if (this.#tunerTimer) {
        clearTimeout(this.#tunerTimer);
        this.#tunerTimer = null;
      }
      await dev.sendQueued(this.#envelope(0x12, [0x08])); // leave tuner page (back to layout)
    }
    return { ok: true };
  }
  /** Current tempo (BPM). fractal-midi's parser is 0x10-locked, so we parse the 0x14 payload
   * inline (LSB-first septet pair) for FM3 model 0x11. */
  async getTempo(): Promise<{ bpm: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(buildGetTempo(this.#prof.model), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x14) });
    const f = frames.find((x) => x[5] === 0x14);
    if (!f) return { bpm: 0 };
    const p = f.slice(6, f.length - 2);
    return { bpm: (p[0]! & 0x7f) | ((p[1]! & 0x7f) << 7) };
  }
  /** Set tempo the way FM3-Edit does (captured): a param write at the global-tempo address,
   * BPM as a 5-septet float32 value. (The 0x14 SET appears not to take on FM3.) */
  async setTempo(bpm: number) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, bpm, true);
    const u = dv.getUint32(0, true);
    const val = [u & 0x7f, (u >>> 7) & 0x7f, (u >>> 14) & 0x7f, (u >>> 21) & 0x7f, (u >>> 28) & 0x7f];
    const data = [0x09, 0x00, 0x02, 0x00, 0x20, 0x00, ...val, 0, 0, 0, 0];
    await (await this.#conn()).sendQueued(this.#envelope(0x01, data));
    this.#emit({ type: 'tempo', bpm });
    return { ok: true };
  }
  async tapTempo() {
    return this.#send(buildTempoTap());
  }
  /** Current scene index (0-based). Parse the 0x0C payload inline (parser is 0x10-locked). */
  async getScene(): Promise<{ index: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(buildGetScene(this.#prof.model), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x0c) });
    const f = frames.find((x) => x[5] === 0x0c);
    if (!f) return { index: 0 };
    return { index: (f.slice(6, f.length - 2)[0] ?? 0) & 0x07 };
  }
  async setScene(index: number) {
    if (index < 0 || index > 7) return { ok: false };
    const r = await this.#send(buildSetScene(index, this.#prof.model));
    // scene selects per-scene bypass/channel; status is read fresh each placedBlocks() call, so no
    // cache to bust — just notify subscribers so the UI follows.
    this.#emit({ type: 'scene', index });
    return r;
  }
  async placeCell(row: number, col: number, blockId: number) {
    // Guard against placing an instance the unit doesn't have (e.g. Amp 2 on an FM3, which has one
    // amp). The protocol reserves an ID range per family but each unit allows fewer — reject here so
    // the rule is authoritative server-side, not just a UI hint, and we don't waste a doomed write.
    const ref = blockRefForEid(blockId);
    if (ref) {
      const limit = this.#prof.instanceLimits[ref.slug] ?? this.#prof.defaultInstances;
      if (ref.instance > limit) {
        const err = new Error(`${this.#prof.name} has no ${ref.slug} ${ref.instance} (max ${limit} of this block)`);
        (err as Error & { statusCode?: number }).statusCode = 400; // client error, not a server fault
        throw err;
      }
    }
    // FM3 needs a cell-select (sub 0x30) before the insert (sub 0x32), or the block
    // lands at the default cell. buildClearBlock IS that select frame (no-op on an
    // empty cell). For blockId 0 this becomes select + insert-0 = clear, like the C#.
    await this.#write(buildClearBlock({ row, col, rows: this.#prof.rows }, this.#prof.model));
    const r = await this.#write(buildSetGridCell({ row, col, blockId, rows: this.#prof.rows }, this.#prof.model));
    this.#gridCache = null;
    return r;
  }
  /** Move the device's edit cursor to a cell (sub 0x30) so the FM3 screen follows the UI.
   * Non-destructive: this is the cursor-select frame (no companion = no clear). */
  async selectCell(row: number, col: number) {
    return this.#send(buildClearBlock({ row, col, rows: this.#prof.rows }, this.#prof.model));
  }
  async cable(srcRow: number, srcCol: number, destRow: number, connect: boolean) {
    const r = await this.#write(buildSetGridRouting({ srcRow, srcCol, destRow, rows: this.#prof.rows, op: connect ? ROUTING_OP_CONNECT : ROUTING_OP_DISCONNECT }, this.#prof.model));
    this.#gridCache = null;
    return r;
  }
  async selectPreset(n: number) {
    this.#gridCache = null;
    return this.#write(buildSwitchPresetSysEx(n, this.#prof.model));
  }
  async store(n: number) {
    return this.#write(buildStorePreset(n, this.#prof.model));
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

export const device = new Device();
