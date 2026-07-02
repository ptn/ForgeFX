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
  buildSetSceneName,
  buildRenamePreset,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT
} from 'fractal-midi/gen3/axe-fx-iii';
import { resolveEnumValues } from 'fractal-midi/gen3/axe-fx-iii';
import { wireToDisplay } from 'fractal-midi/shared';
import { autoDetectPath } from './transport/serial.js';
import { listConnections, resolveConn, openConn, getConnOverride, setConnOverride, getProfileOverride, setProfileOverride } from './transport/connection.js';
import { midiAvailable } from './transport/midi.js';
import type { Transport, Conn } from './transport/types.js';
import { decodePresetDump, decodePresetBody, slugForEffectId, effectRoster, blockInstances, blockRefForEid } from './codec/fm3PresetGrid.js';
import { readBlockParamsFull, modelsFromBlocks, type DecodedBlock } from './codec/fm3BlockParams.js';
import * as store from './store.js';
import { DEVICE_MODELS, MODEL_BROADCAST, modelFromPortName } from './models.js';
import { DEFAULT_PROFILE, profileForModel, profileForKey, SLUG_FAMILY, type DeviceProfile, type TypeModel, type DeviceLayout } from './devices.js';

// slug → { name, page=base effect id } from the authoritative codec base table (replaces the old
// defs.js pack lookup; block names + base ids are codec facts, not editor-cache definitions).
const BLOCK_META: Record<string, { name: string; page: number }> = (() => {
  const out: Record<string, { name: string; page: number }> = {};
  for (const e of effectRoster()) out[e.slug] = { name: e.name, page: e.page };
  return out;
})();

const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer

/** Library-friendly decoded preset: name, scenes, and the unique effect blocks it contains. */
export type PresetSummary = {
  number: number;
  name: string;
  model: string;
  crcValid: boolean;
  /** Content fingerprint (stored CRC16) — changes when the preset changes; used to detect stale cache. */
  crc: number;
  scenes: string[];
  blocks: { effectId: number; slug: string | null; name: string; instance: number | null }[];
  /** Distinct model names in use per block family (amp/drive/cab/reverb/…) — for "presets using model X".
   *  Keyed by family slug; only families with a decoded model are present. FM3 only. */
  models: Record<string, string[]>;
  /** Amp model names in use (distinct across the amp's 4 channels) — for "presets using amp X". FM3 only.
   *  Back-compat alias of `models.amp` (the library still binds to this). */
  amps: string[];
  /** Full per-block decoded params (every family, every param) — for deep search ("amp gain > 7").
   *  Populated for offline file decode + the on-demand /params endpoint; omitted from the bulk device
   *  scan to keep summaries light (use `models` for type search there, fetch /params for deep queries). */
  params?: DecodedBlock[];
};
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
/** One side (tap/hold) of an FC switch as read by the sub-0x01 structured read. `present` = the
 *  device returned a record whose config/side echo matched the request; `raw` = the 78-byte response
 *  body (the per-switch record is at raw[16..]; field offsets within it are not yet decoded — see
 *  Device.fcReadSwitch). */
export interface FcSideState { selector: number; present: boolean; empty: boolean; raw: number[]; }
export interface FcSwitchState {
  effectId: number;
  layout: number; view: number; switch: number; config: number;
  tap: FcSideState; hold: FcSideState;
}
/** Decoded current switch state read back from the unit (via the sub-0x1b value channel). Field values
 *  are raw ordinals (category/function/display/color) keyed by FC field name; labels are decoded text.
 *  `null` = the field could not be read. This is the read that actually tracks param edits. */
export interface FcReadState {
  effectId: number;
  layout: number; view: number; switch: number; config: number;
  fields: Record<string, number | null>;
  tapLabel: string; holdLabel: string;
}

// Live pushes streamed to Axis over SSE.
export type DeviceEvent =
  | { type: 'tuner'; freq: number; note?: string; cents?: number; octave?: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'scene'; index: number }
  | { type: 'cpu'; percent: number }
  // Live cross-UI sync (Axis Cloud Remote + multi-window): a mutation happened, so other UIs update.
  // `param` carries the new normalized value (cheap knob update); `changed` = structural (grid/preset)
  // change → reload. Emitted by the mutating methods below; streamed via SSE + the remote relay channel.
  | { type: 'param'; effectId: number; paramId: number; norm: number }
  | { type: 'changed'; scope: 'grid' | 'preset' }
  /** Live output level meters in dB (−40…0, floor-clamped), from the Preset Leveling poll (fn 0x19).
   *  Output 1 & 2, each L/R. Decoded from a 5-septet float (RMS) → 10·log10 → dB; smoothed. */
  | { type: 'meters'; out1L: number; out1R: number; out2L: number; out2R: number }
  /** A shared Axis config doc (layouts / swipe-quick-actions / tags / surface …) was written by one UI —
   *  streamed to the others so layouts/quick-actions/arrange stay in sync live, both directions. `origin` is
   *  the writer's client id so it can ignore its own echo (and not reload while it's mid-edit). */
  | { type: 'config'; id: string; data: unknown; origin?: string };

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
  // active device profile (model byte, grid size, params, ranges, rosters). Starts from a persisted
  // manual profile override (Axis "Connection & Device"), then FORGEFX_DEVICE, else FM3; corrected to the
  // real unit on the first auto-detect (only when no override is set).
  #prof: DeviceProfile = ((): DeviceProfile => {
    const forced = getProfileOverride();
    if (forced) { const p = profileForKey(forced); if (p) return p; }
    if (process.env.FORGEFX_DEVICE) { const p = profileForKey(process.env.FORGEFX_DEVICE); if (p) return p; }
    return DEFAULT_PROFILE;
  })();
  #detected = false;
  #modelId = -1; // the ACTUAL attached/forced model byte. AM4 (0x15) keeps the default gen-3 #prof, so
  //                #prof.model alone can't tell it apart — telemetry polls gate on this instead.
  get profile() { return this.#prof; }
  /** True for an AM4 (separate codec — must NOT receive gen-3 telemetry polls like the fn 0x19 meters). */
  #isAm4() { return this.#modelId === 0x15 || getProfileOverride() === 'am4'; }
  /** Map a manual profile-override key to a model byte. Gen-3 keys resolve via profileForKey; AM4 has no
   *  gen-3 profile (it uses the separate am4 codec) so it maps to its model byte directly. -1 = unknown. */
  #forcedModelId(key: string): number {
    const p = profileForKey(key);
    if (p) return p.model;
    if (key === 'am4') return 0x15;
    return -1;
  }
  #gridCache: { grid: PresetGridDTO; at: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load

  // ── event bus (SSE source): live tuner/scene/tempo/cpu pushes ──
  #subscribers = new Set<(e: DeviceEvent) => void>();
  #tunerTimer: ReturnType<typeof setTimeout> | null = null;
  #metersTimer: ReturnType<typeof setTimeout> | null = null;
  // Smoothed output-meter levels in dB (−40…0). Values come from the Preset Leveling poll (fn 0x19),
  // decoded from a 5-septet float (RMS energy). They're instantaneous (drop to −40 between transients),
  // so we run an asymmetric envelope follower (fast attack / slow release) for a natural meter feel.
  #mDb = [-40, -40, -40, -40]; // [out1L, out1R, out2L, out2R]
  #meterStep = 0; // round-robin index over the 4 meters (+ a CPU read) — one small read per tick
  static METER_FLOOR = -40; // display floor (matches FM3-Edit's Preset Leveling page)
  static METER_CEIL = 6; // meters run above 0 dB into clip (live-verified peaks to +5.8 dB)
  static METER_ATTACK = 0.7; // fraction of the gap closed when the level rises (snappy)
  static METER_RELEASE = 0.35; // …when it falls (natural meter fall-off; updates are frequent now)
  // The 4 leveling meters: (addr, sub) → index into #mDb. addr 0x2A=Output 1, 0x2B=Output 2; sub 0x10=L, 0x11=R.
  static METER_ADDR = [
    { addr: 0x2a, sub: 0x10 },
    { addr: 0x2a, sub: 0x11 },
    { addr: 0x2b, sub: 0x10 },
    { addr: 0x2b, sub: 0x11 },
  ];
  subscribe(fn: (e: DeviceEvent) => void): () => void {
    this.#subscribers.add(fn);
    this.#startMeters(); // a listener is present → stream CPU + audio meters (gen-3 only)
    return () => {
      this.#subscribers.delete(fn);
      if (this.#subscribers.size === 0) this.#stopMeters();
    };
  }
  /** Broadcast a shared-config change to every live UI (SSE + remote relay). Called by the store route on
   *  a `config` collection write. Does not touch the device — pure fan-out. */
  broadcastConfig(id: string, data: unknown, origin?: string) {
    this.#emit({ type: 'config', id, data, origin });
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

  /** Shared open transport — the parallel Am4Device reuses this so AM4 + gen-3 never double-open the
   *  single exclusive MIDI/serial connection. */
  openTransport(): Promise<Transport> {
    return this.#conn();
  }

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
    if (this.#isAm4()) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; return; } // no gen-3 tuner on AM4
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

  // Live output meters + CPU. Reverse-engineered from FM3-Edit's Preset Leveling page (see
  // fm3-scratchpad findings/live-capture-2026-07.md):
  //   METERS — fn 0x01 sub 0x19, round-robin over Output 1/2 × L/R (addr 0x2A/0x2B, sub 0x10/0x11).
  //     Reply bytes[12..16] = 5-septet-LE float32 = RMS energy → dB = 10·log10(v), floor −40. The REAL,
  //     calibrated meters (matched the live readout to ~1 dB). 0x2E bytes 35/36 saturate → not used.
  //   CPU — fn 0x01 sub 0x2E, byte 37 = block DSP load → CPU% ≈ CPU_BASE + byte37·CPU_SLOPE. That's a
  //     590-byte frame, so we read it only once per round-robin cycle (meters are tiny 23-byte reads).
  // gen-3 only (the AM4 has no such frame). Runs while ≥1 SSE client is subscribed. One small read/tick.
  static CPU_BASE = 32;
  static CPU_SLOPE = 0.5;
  #startMeters() {
    if (this.#metersTimer) return;
    if (this.#isAm4()) return; // AM4 uses a separate codec — no gen-3 meter frames
    if (![0x10, 0x11, 0x12].includes(this.#prof.model)) return; // gen-3 only
    this.#metersTimer = setTimeout(() => this.#pollMeters(), 120);
  }
  #stopMeters() {
    if (this.#metersTimer) clearTimeout(this.#metersTimer);
    this.#metersTimer = null;
  }
  /** Decode a leveling meter reply → dB (5-septet float @ off12 → RMS → 10·log10, floor-clamped). */
  #meterDb(f: number[]): number {
    let v = 0;
    for (let i = 0; i < 5; i++) v |= (f[12 + i]! & 0x7f) << (7 * i);
    const rms = new Float32Array(new Uint32Array([v >>> 0]).buffer)[0]!;
    if (!(rms > 1e-7)) return Device.METER_FLOOR;
    const db = 10 * Math.log10(rms);
    return Math.max(Device.METER_FLOOR, Math.min(Device.METER_CEIL, db));
  }
  async #pollMeters() {
    if (!this.#metersTimer) return;
    if (this.#isAm4()) { this.#stopMeters(); return; } // detect() may have flipped us to AM4 after start
    let slow = false;
    try {
      const dev = await this.#conn();
      // A slow link — a generic MIDI interface into 5-pin DIN (≈31.25 kbaud) — can't carry meter polling
      // without inflating every other request to seconds, so SKIP it there (a cheap 2 s re-check resumes it
      // instantly on a fast link). Fast USB-MIDI (Axe-Fx III / FM9) and USB-CDC serial are NOT slow.
      slow = dev.slow;
      if (!slow) {
        // Read ALL 4 output meters back-to-back each tick (tiny 23-byte reads — this is exactly what
        // FM3-Edit's leveling page does; NOT the many-block sweep that stutters audio) so every bar
        // refreshes every tick, not once per round-robin → smooth, not choppy.
        for (let i = 0; i < 4; i++) {
          const { addr, sub } = Device.METER_ADDR[i]!;
          const req = this.#envelope(0x01, [0x19, 0x00, addr, 0x00, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          const hit = (f: number[]) => f[5] === 0x01 && f[6] === 0x19 && f[8] === addr && f[10] === sub && f.length === 23;
          const frames = await dev.request(req, { timeoutMs: 200, quietMs: 12, match: (fs) => fs.some(hit) });
          const f = frames.find(hit);
          if (f) {
            const raw = this.#meterDb(f);
            const prev = this.#mDb[i]!;
            const a = raw > prev ? Device.METER_ATTACK : Device.METER_RELEASE;
            this.#mDb[i] = prev + a * (raw - prev);
          }
        }
        this.#emit({ type: 'meters', out1L: this.#mDb[0]!, out1R: this.#mDb[1]!, out2L: this.#mDb[2]!, out2R: this.#mDb[3]! });
        // CPU is a heavy 590-byte read → poll it only occasionally (every ~8th tick), off the meter path.
        if (this.#meterStep++ % 8 === 0) {
          const req = this.#envelope(0x01, [0x2e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          const big = (f: number[]) => f[5] === 0x01 && f[6] === 0x2e && f.length >= 590;
          const frames = await dev.request(req, { timeoutMs: 400, quietMs: 25, match: (fs) => fs.some(big) });
          const f = frames.find(big);
          if (f) this.#emit({ type: 'cpu', percent: Math.round((Device.CPU_BASE + f[37]! * Device.CPU_SLOPE) * 10) / 10 });
        }
      }
    } catch {
      /* transient — keep polling */
    }
    // short gap after the 4 reads → ~8–10 full meter refreshes/sec
    if (this.#metersTimer) this.#metersTimer = setTimeout(() => this.#pollMeters(), slow ? 2000 : 60);
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

  /** Full connection diagnostic for the desktop debug log — platform, MIDI availability, every
   *  serial + MIDI in/out port, the resolved connection, and the live transport state. */
  async diagnostics() {
    let ports: Awaited<ReturnType<typeof listConnections>> = [];
    let listError: string | null = null;
    let resolved: Awaited<ReturnType<typeof resolveConn>> = null;
    try { ports = await listConnections(); } catch (e) { listError = (e as Error).message; }
    try { resolved = await resolveConn(); } catch (e) { listError = (listError ?? '') + ' | resolve: ' + (e as Error).message; }
    const midi = ports.filter((p) => p.transport === 'midi');
    return {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      versions: { node: process.versions.node, napi: process.versions.napi },
      profile: { key: this.#prof.key, name: this.#prof.name, model: `0x${this.#prof.model.toString(16)}` },
      detected: this.#detected,
      midiAvailable: midiAvailable(),
      ports: {
        serial: ports.filter((p) => p.transport === 'serial').map((p) => ({ id: p.id, fractal: p.fractal, model: p.model })),
        midiIn: midi.filter((p) => p.dir === 'input').map((p) => ({ id: p.id, fractal: p.fractal })),
        midiOut: midi.filter((p) => p.dir === 'output').map((p) => ({ id: p.id, fractal: p.fractal }))
      },
      override: getConnOverride(),
      profileOverride: getProfileOverride(),
      resolved,
      transportOpen: !!this.#transport?.isOpen,
      transportLabel: this.#transport?.label ?? null,
      listError
    };
  }

  /** Every connection (serial + MIDI, Fractal flagged) + the chosen one + any manual override. */
  async connections() {
    return {
      chosen: await resolveConn(),
      override: getConnOverride(),
      profileOverride: getProfileOverride(),
      profile: { key: this.#prof.key, name: this.#prof.name, model: `0x${this.#prof.model.toString(16)}` },
      ports: await listConnections()
    };
  }
  /** Manually pick a connection (persisted); null clears it back to auto-detect. Optionally force the
   *  device profile (`model` key: fm3/fm9/axe3/am4, or 'auto'/null to clear). Drops the live connection so
   *  the next request reconnects on the chosen port; a forced profile skips the handshake in detect(). */
  async selectConnection(conn: Conn | null, model?: string | null) {
    setConnOverride(conn);
    if (model !== undefined) {
      setProfileOverride(model && model !== 'auto' ? model : null);
      const forced = getProfileOverride();
      if (forced) { const p = profileForKey(forced); if (p) this.#prof = p; } // apply gen-3 profile now (AM4 handled in detect)
    }
    if (this.#transport) {
      await this.#transport.close().catch(() => {});
      this.#transport = null;
    }
    this.#connecting = null;
    this.#detected = false;
    return { ok: true, chosen: await resolveConn(), profileOverride: getProfileOverride() };
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
    // Gate on a connection resolvable over ANY transport — serial CDC (FM3) OR USB-MIDI (Axe-Fx III /
    // FM9). The old guard used the serial-only `this.port`, which is null for a MIDI-only unit, so the
    // handshake was skipped and the profile stayed on the default model byte — the Windows Axe-Fx III
    // "device offline" bug (macOS worked only because the III also exposes a serial node there).
    const conn = await resolveConn();
    if (!conn) return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, port: null };
    // Forced profile (Axis "Connection & Device" override): trust the chosen model, skip the handshake.
    // This is the MIDI-DIN→USB-adapter case — a generic MIDI interface into an FM3 won't answer the 0x7F
    // broadcast or carry a Fractal port name, so auto-detect can't ID it. We still open the transport (so a
    // dead port is visible) but never let a silent handshake downgrade the user's explicit choice.
    const forced = getProfileOverride();
    if (forced) {
      const modelId = this.#forcedModelId(forced);
      const p = profileForModel(modelId);
      if (p.model === modelId) this.#prof = p; // gen-3; AM4 keeps default profile but reports 0x15 below
      this.#modelId = modelId;
      this.#detected = true;
      if (this.#isAm4()) { this.#stopMeters(); } // never run gen-3 telemetry against an AM4
      let port: string | null = null;
      try { await this.#conn(); port = this.#transport?.label ?? conn.id; } catch { /* dead port — report best-effort */ }
      const m = DEVICE_MODELS[modelId];
      console.log(`[forgefx] detect: FORCED profile '${forced}' → model 0x${modelId >= 0 ? modelId.toString(16) : '?'} (handshake skipped)`);
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        port: port ?? conn.id
      };
    }
    try {
      const dev = await this.#conn();
      const port = this.#transport?.label ?? conn.id;
      const body = [0xf0, 0x00, 0x01, 0x74, MODEL_BROADCAST, 0x00];
      let cs = 0;
      for (const b of body) cs ^= b;
      const probe = [...body, cs & 0x7f, 0xf7];
      const hdr = (f: number[]) => f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && f.length > 5;
      const frames = await dev.request(probe, { timeoutMs: 1500, quietMs: 60, match: (fs) => fs.some(hdr) });
      const f = frames.find(hdr);
      let modelId = f ? f[4]! : -1;
      // MIDI fallback: USB-MIDI Fractal units (Axe-Fx III on Windows, which has no serial node) may not
      // answer the 0x7F broadcast — infer the model from the port name so the profile still switches.
      if (modelId < 0 && conn.transport === 'midi') {
        const inferred = modelFromPortName(conn.inId ?? conn.id);
        if (inferred != null) modelId = inferred;
      }
      console.log(`[forgefx] detect: transport=${conn.transport} frames=${frames.length} modelId=0x${modelId >= 0 ? modelId.toString(16) : '?'} (handshake=${f ? 'reply' : 'silent'})`);
      const m = DEVICE_MODELS[modelId];
      // adopt the detected unit's profile so all reads/writes use its model byte, grid + ranges
      // (profileForModel falls back to FM3, so only switch when there's a real profile for this model)
      const p = profileForModel(modelId);
      if (p.model === modelId) this.#prof = p;
      this.#modelId = modelId;
      this.#detected = true;
      if (this.#isAm4()) this.#stopMeters();
      console.log(`[forgefx] active profile: ${this.#prof.key} (model 0x${this.#prof.model.toString(16)}, ${this.#prof.rows}x${this.#prof.cols}) ${p.model === modelId ? 'adopted' : 'kept default — no profile for 0x' + (modelId >= 0 ? modelId.toString(16) : '?')}`);
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
      return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, port: this.#transport?.label ?? conn.id };
    }
  }

  /** Current preset number + name (one query). */
  async presetRef(): Promise<{ number: number; name: string }> {
    await this.#ready();
    const dev = await this.#conn();
    const frames = await dev.request(buildQueryPatchName('current', this.#prof.model), {
      timeoutMs: dev.slow ? 4000 : 1200, // slow link: give the reply time to arrive (match returns early)
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

  /** Read a preset dump, retrying when it arrives incomplete. On Windows USB-MIDI a big multi-packet
   *  dump (Axe-Fx III presets ≈ 18 frames / 32 KB) intermittently drops its 0x78 payload chunks between
   *  the 0x77 header and the 0x79 terminator → "no 0x78 chunks found". A re-read almost always succeeds. */
  async #dumpFrames(target: number): Promise<number[][]> {
    const dev = await this.#conn();
    // A slow link (5-pin MIDI) transfers each ~3082B dump chunk in ~1s, so a multi-chunk preset dump takes
    // several seconds with ~1s gaps between chunks. The USB-tuned windows (5s / 180ms quiet) give up mid
    // dump. Widen them so the transfer completes; the 0x79-terminator `match` still returns the instant the
    // dump is whole, so a fast link isn't slowed.
    const slow = dev.slow;
    let frames: number[][] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      frames = await dev.request(buildRequestPresetDump(target, this.#prof.model), {
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

  async #dumpGrid(): Promise<PresetGridDTO> {
    const frames = await this.#dumpFrames(EDIT_BUFFER);
    // diagnostic: did the dump arrive? (Windows MIDI large-SysEx debugging) — frame count, the function
    // bytes seen, total bytes, and whether the 0x79 terminator came through.
    const fns = [...new Set(frames.map((f) => f[5]))].map((x) => '0x' + (x ?? 0).toString(16));
    const bytes = frames.reduce((n, f) => n + f.length, 0);
    console.log(`[forgefx] presetDump: frames=${frames.length} bytes=${bytes} fns=[${fns.join(',')}] terminator=${frames.some((f) => f[5] === 0x79)}`);
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

  /** Decode any preset by number (non-disruptive — does NOT switch the active preset) into a
   *  library-friendly summary: name, scene names, and the unique effect blocks it contains. The
   *  foundation for a preset browser/library (search by block, collections, tags). Param-level facts
   *  (amp model etc.) are a follow-up once the per-block param decode lands. */
  async presetSummary(presetNumber: number, withParams = false): Promise<PresetSummary> {
    await this.#ready();
    const frames = await this.#dumpFrames(presetNumber);
    const decoded = decodePresetDump(frames, this.#prof.model);
    const blocks = this.#decodeBlocks(frames, decoded);
    const summary = this.#summarizeDump(decoded, modelsFromBlocks(blocks), presetNumber);
    if (withParams) summary.params = blocks; // cache build: summary + full params in one dump
    return summary;
  }

  /** Full per-block params (every family/param) for one device preset — the deep-search / detail source. */
  async presetParams(presetNumber: number): Promise<DecodedBlock[]> {
    await this.#ready();
    const frames = await this.#dumpFrames(presetNumber);
    return this.#decodeBlocks(frames, decodePresetDump(frames, this.#prof.model));
  }

  // ── backups / version control ──
  /** Raw .syx bytes (the backup blob) + decoded summary for one slot. */
  async #dumpRaw(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }> {
    await this.#ready();
    const frames = await this.#dumpFrames(n);
    const decoded = decodePresetDump(frames, this.#prof.model);
    const summary = this.#summarizeDump(decoded, modelsFromBlocks(this.#decodeBlocks(frames, decoded)), n);
    return { bytes: Uint8Array.from(frames.flat()), summary };
  }
  /** Snapshot one preset into the version store (dedup'd by CRC). Returns the version, or null if empty. */
  async backupPreset(n: number, source: 'manual' | 'auto' | 'backup' = 'manual', backupId?: string): Promise<store.PresetVersion | null> {
    const { bytes, summary } = await this.#dumpRaw(n);
    if (!summary.crcValid || !summary.name.trim()) return null;
    return store.addPresetVersion({ location: n, crc: summary.crc, name: summary.name, model: summary.model, source, backupId }, bytes);
  }
  /** Full-device backup: snapshot every populated slot under one backup id. */
  async backupDevice(label: string, from = 0, to = 511): Promise<store.Backup> {
    const b = store.createBackup(label || 'Device backup', this.#prof.name);
    let count = 0;
    for (let n = from; n <= to; n++) {
      try { if (await this.backupPreset(n, 'backup', b.id)) count++; } catch { /* empty/unreadable slot */ }
    }
    store.setBackupCount(b.id, count);
    return { ...b, count };
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
    const decoded = decodePresetDump(frames, this.#prof.model);
    const blocks = this.#decodeBlocks(frames, decoded);
    const summary = this.#summarizeDump(decoded, modelsFromBlocks(blocks), -1);
    summary.params = blocks; // offline files embed full params (few files → fine for search/storage)
    return summary;
  }

  /** Decode every placed block's full params from the preset body, table-driven via the universal
   *  layout (u16 array @ header+0x2e, paramId order) + the fractal-midi catalog (FM3_PARAMS/RANGES/
   *  ENUM_OVERRIDES/ROSTERS). `decoded` supplies the grid's placed effectIds so only placed blocks are
   *  read (rejects phantom headers). Empty for non-FM3. The model/type search index is derived from
   *  this via `modelsFromBlocks`. */
  #decodeBlocks(frames: readonly (readonly number[])[], decoded: ReturnType<typeof decodePresetDump>): DecodedBlock[] {
    if (decoded.modelId !== 0x11) return []; // gate on the PRESET's model (not the connected device) — so
    try {                                    // an offline FM3 .syx decodes even when no FM3 is attached
      const { body } = decodePresetBody(frames, decoded.modelId);
      const placedEids = new Set<number>(decoded.grid.filter((c) => !c.isShunt && c.effectId).map((c) => c.effectId));
      return readBlockParamsFull(body, placedEids);
    } catch {
      return [];
    }
  }

  #summarizeDump(d: ReturnType<typeof decodePresetDump>, models: Record<string, string[]>, presetNumber: number): PresetSummary {
    const seen = new Map<number, { effectId: number; slug: string | null; name: string; instance: number | null }>();
    for (const c of d.grid) {
      if (c.isShunt || !c.effectId || seen.has(c.effectId)) continue;
      const ref = blockRefForEid(c.effectId);
      seen.set(c.effectId, { effectId: c.effectId, slug: ref?.slug ?? null, name: c.name, instance: ref?.instance ?? null });
    }
    return { number: presetNumber, name: d.name, model: d.modelName, crcValid: d.crcValid, crc: d.crc, scenes: d.sceneNames, blocks: [...seen.values()], models, amps: models.amp ?? [] };
  }

  /** Decompressed preset body as hex — for per-block param-decode RE (diff bodies across known param
   *  changes to locate offsets). Dumps the active edit buffer. */
  async presetBodyHex(): Promise<{ len: number; hex: string }> {
    const dev = await this.#conn();
    const frames = await dev.request(buildRequestPresetDump(EDIT_BUFFER, this.#prof.model), {
      timeoutMs: 5000,
      quietMs: 180,
      match: (fs) => fs.some((f) => f[5] === 0x79)
    });
    const { body } = decodePresetBody(frames, this.#prof.model);
    return { len: body.length, hex: Buffer.from(body).toString('hex') };
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
  async blockParams(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    await this.#ready();
    const codecSlug = slugForEffectId(eid) ?? ''; // audio blocks resolve via the codec
    // virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199) resolve via the profile's effectId map
    const family = SLUG_FAMILY[codecSlug.toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const slug = codecSlug || (family ? family.toLowerCase() : ''); // virtual effects key on the family name
    const meta = BLOCK_META[codecSlug];
    const blockName = meta?.name ?? family ?? slug;
    const page = meta?.page ?? -1;
    const layout = family ? this.#prof.layoutFor(family) : undefined; // editor-authentic pages (Default layout seed)
    if (!family) {
      return { block: blockName, slug, page, named: [], enums: [], type: null, layout }; // no device-true param family mapped
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
        const frames = await dev.request(buildBlockBulkReadPoll(eid, this.#prof.model), { timeoutMs: dev.slow ? 8000 : 2500, quietMs: dev.slow ? 600 : 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
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
    return { block: blockName, slug, page, named, enums, type, layout };
  }

  /** Read specific paramIds of an effect via per-pid fn 0x01 GET (sub 01 00) — the path FM3-Edit
   *  uses to load FC state. Returns {pid: float value}. The RX value is a 5×7-bit packed float32 at
   *  byte 12 of the response frame (after F0 00 01 74 <model> 01 | 01 00 | eid:2 | pid:2). */
  async readParams(eid: number, pids: number[]): Promise<Record<number, number>> {
    await this.#ready();
    const dev = await this.#conn();
    const out: Record<number, number> = {};
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const unpackF32 = (b: number[]): number => {
      const v = ((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0;
      return new Float32Array(new Uint32Array([v]).buffer)[0]!;
    };
    // Proper gen-3 GET: fn 0x01 with sub 01 00 + EMPTY value (NOT buildGetParameter, which uses the
    // SET-typed sub 09 00 and therefore WRITES 0). Frame: F0 00 01 74 <model> 01 01 00 <eid> <pid> 0*9 cs F7.
    const buildGet = (e: number, p: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x01, 0x00, ...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    for (const pid of pids) {
      try {
        const frames = await dev.request(buildGet(eid, pid), {
          timeoutMs: 800,
          quietMs: 50,
          match: (fs) => fs.some((f) => f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid)
        });
        const f = frames.find((fr) => fr[5] === 0x01 && fr[6] === 0x01 && fr[7] === 0x00 && (fr[8]! | (fr[9]! << 7)) === eid && (fr[10]! | (fr[11]! << 7)) === pid);
        if (f) {
          if (process.env.FORGEFX_GETDUMP) console.log(`GETDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
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
   *  the param's range). Returns {pid: norm}; logs the raw frame when FORGEFX_GETDUMP is set (calibration). */
  async readRange(eid: number, pids: number[]): Promise<Record<number, number>> {
    await this.#ready();
    const dev = await this.#conn();
    const out: Record<number, number> = {};
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const unpackF32 = (b: number[]): number => {
      const v = ((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0;
      return new Float32Array(new Uint32Array([v]).buffer)[0]!;
    };
    const buildGet = (e: number, p: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x1a, 0x00, ...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    for (const pid of pids) {
      try {
        const match = (f: number[]) => f[5] === 0x01 && f[6] === 0x1a && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
        const frames = await dev.request(buildGet(eid, pid), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (f) {
          if (process.env.FORGEFX_GETDUMP) console.log(`RANGEDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
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
   * Request: function 0x01, **sub-action 0x01** (NOT the per-pid 01-00 GET), addressed by a *config
   *   selector* (NOT a paramId): frame `F0 00 01 74 <model> 01 01 00 <sel:2×7bit LE> 0*9 cs F7`.
   *   selector = config*2 + side, side 0 = TAP, 1 = HOLD. (A windowed request form with the high
   *   selector byte = 8 returns the same record; the low form is used here.) config is the standard
   *   FC config index (layout*12 + view*3 + switch).
   *
   * Response: an **87-byte** frame whose body (the 78 bytes after `F0 00 01 74 <model> 01 01`) is:
   *   [0]      00
   *   [1..2]   selector echo (2×7bit LE) — equals the request selector
   *   [3..4]   00 00
   *   [5..9]   session/window context value (NOT per-switch; shared across all configs in a session —
   *            confirmed live: identical for every selector at a given moment, changes on window state,
   *            not on switch content). Ignored.
   *   [10..11] 00 00
   *   [12..13] 38 00  (record-format constant)
   *   [14]     config index (0..107) — echoes the selector's config, AUTHORITATIVE.
   *   [15]     side flag: bit 0x40 set = HOLD, clear = TAP — AUTHORITATIVE (confirmed live & in capture).
   *   [16..]   packed per-switch field record. The field byte offsets within this record are NOT yet
   *            decoded with confidence (see note) — the raw bytes are returned for the caller.
   *
   * ⚠ Field-offset note: the body[14]/[15] config+side echo is confirmed byte-exact against both the
   *   live device and the FM3-Edit capture. The interior field layout (category / value-slots / label)
   *   is NOT decoded: it is a packed format that is neither the 5×7bit-f32 used by writes nor plain
   *   7-bit-ASCII for the label, and it could not be validated on the live device because sub-0x09
   *   param writes to (eid 199, pid) do not surface in this read (exhaustively verified: writing any FC
   *   config param changes zero bytes of any selector's response — the structured read serves the
   *   device's compiled/active layout snapshot, decoupled from the param edit buffer). Until a ground-
   *   truth correlation is available, only `present`, `config`, `side` are trustworthy; `raw` carries
   *   the undecoded record so a future decode can be added without another wire round-trip.
   */
  async fcReadSwitch(layout: number, view: number, sw: number): Promise<FcSwitchState> {
    await this.#ready();
    const dev = await this.#conn();
    const model = this.#prof.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC switch read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const buildSelRead = (sel: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x01, 0x00, ...enc14(sel), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
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
        if (process.env.FORGEFX_GETDUMP) console.log(`FCDUMP sel=${sel} body=${body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
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
   * ASCII for label chars) — verified live (category→1=Bank, colour→ordinal) and against the FM3-Edit
   * capture (colour tracked 3/5/1). This is distinct from `readRange` (sub 0x1a → normalized 0..1) and
   * from `fcReadSwitch` (sub 0x01 → a compiled snapshot that does NOT track edits).
   */
  async fcReadState(layout: number, view: number, sw: number): Promise<FcReadState> {
    await this.#ready();
    const dev = await this.#conn();
    const model = this.#prof.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC state read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const eid = model.effectId;
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const build = (pid: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x1b, 0x00, ...enc14(eid), ...enc14(pid), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
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

  /** Raw bulk-read of any effect's param values indexed by paramId — for FC (eid 199) / Modifier
   *  (eid 3), whose params carry no display range so blockParams returns them empty. Sparse
   *  (only non-zero pids), first channel. The client computes pids from the FC/Modifier model. */
  async rawBlock(eid: number): Promise<{ eid: number; values: Record<number, number> }> {
    await this.#ready();
    const dev = await this.#conn();
    const frames = await dev.request(buildBlockBulkReadPoll(eid, this.#prof.model), {
      timeoutMs: 2500,
      quietMs: 120,
      match: (fs) => fs.some((f) => f[5] === 0x76)
    });
    const bulk = assembleGen3BlockBulkRead(frames, this.#prof.model);
    const values: Record<number, number> = {};
    bulk.values.forEach((v, i) => {
      if (v) values[i] = v;
    });
    return { eid, values };
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

  /** Live audio meters per placed monitored block. Reads each block's primary monitor level via the
   *  block-level GET (fn 0x01 sub 0x01 00 by effectId); the level is a normalized 0..1 float at
   *  response offset 12-16 (LSB-first 5×7bit → uint32 → float32-LE — confirmed from the FM3 capture
   *  2026-07-02; note the standard gen-3 float decoder does NOT apply to this field). Mapped to dB
   *  via the profile's monitor table. Gen-3 only; [] if the device has no monitor table. */
  async liveMonitors(onlyEid?: number): Promise<{ effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[]> {
    const mon = this.#prof.monitorParams;
    if (!mon || ![0x10, 0x11, 0x12].includes(this.#prof.model)) return [];
    // family → its primary monitor def (first table entry for that family)
    const primaryByFamily = new Map<string, { paramName: string; family: string; role: string; minDb?: number; maxDb?: number }>();
    for (const [paramName, def] of Object.entries(mon)) if (!primaryByFamily.has(def.family)) primaryByFamily.set(def.family, { paramName, ...def });
    const decodeNorm = (f: number[], o: number): number => {
      let v = 0;
      for (let i = 0; i < 5; i++) v |= (f[o + i]! & 0x7f) << (7 * i);
      const val = new Float32Array(new Uint32Array([v >>> 0]).buffer)[0]!;
      return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
    };
    const g = await this.grid();
    const dev = await this.#conn();
    const model = this.#prof.model;
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const out: { effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[] = [];
    for (const c of g.cells) {
      if (c.isShunt) continue;
      if (onlyEid != null && c.effectId !== onlyEid) continue; // gentle single-block poll
      const slug = slugForEffectId(c.effectId);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      const pm = family ? primaryByFamily.get(family) : undefined;
      if (!pm) continue;
      const req = [0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x01, 0x00, ...enc14(c.effectId), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0; for (const b of req) cs ^= b; req.push(cs & 0x7f, 0xf7);
      const match = (r: number[]) => r[5] === 0x01 && r[6] === 0x01 && r[7] === 0x00 && (r[8]! | (r[9]! << 7)) === c.effectId && r.length >= 18;
      try {
        const frames = await dev.request(req, { timeoutMs: 800, quietMs: 40, match: (fs) => fs.some(match) });
        const r = frames.find(match);
        if (!r) continue;
        const norm = decodeNorm(r, 12);
        const db = pm.minDb != null && pm.maxDb != null ? pm.minDb + norm * (pm.maxDb - pm.minDb) : null;
        out.push({ effectId: c.effectId, family: pm.family, paramName: pm.paramName, role: pm.role, norm, db, minDb: pm.minDb, maxDb: pm.maxDb });
      } catch {
        /* skip this block */
      }
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

  /** DEBUG probe: send a raw SysEx frame, return every response frame as hex (for FC read-decode). */
  async rawRequest(bytes: number[]): Promise<string[]> {
    const dev = await this.#conn();
    const frames = await dev.request(bytes, { timeoutMs: 1200, quietMs: 120, match: (fs: number[][]) => fs.length > 0 });
    return frames.map((f) => f.map((b) => b.toString(16).padStart(2, '0')).join(''));
  }

  // ── writes (all address the exact placed instance by effect id) ──
  async setParam(eid: number, paramId: number, value: number, continuous: boolean) {
    // continuous knob writes stream at high frequency → fire-and-forget (instant);
    // a discrete write (enum) is rarer + worth confirming, so reject-watch it.
    const r = continuous ? await this.#send(buildSetParameterContinuous(eid, paramId, clamp01(value), this.#prof.model)) : await this.#write(buildSetParameter(eid, paramId, value, this.#prof.model));
    this.#emit({ type: 'param', effectId: eid, paramId, norm: value }); // live: other UIs move the knob
    return r;
  }
  /** Change a block's model/type (the family TYPE selector ordinal). */
  async setType(eid: number, value: number) {
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
    const tid = family ? this.#paramId(family, 'type') : undefined;
    if (tid == null) return { ok: false };
    const r = await this.#write(buildSetParameter(eid, tid, value, this.#prof.model));
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setBypass(eid: number, bypassed: boolean) {
    const r = await this.#send(buildSetBypass(eid, bypassed, this.#prof.model)); // instant toggle
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setChannel(eid: number, channel: string) {
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (idx < 0 || idx > 3) return { ok: false };
    const r = await this.#send(buildSetChannel(eid, idx as 0 | 1 | 2 | 3, this.#prof.model)); // instant
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }

  /**
   * Bind a modifier slot to a target parameter. The modifier→target link lives on the modifier's own
   * eid as two params: targetEffectId (the block) + targetParam (the paramId), plus the source. Slot is
   * 1-based; slot N = modModel.effectId + (N-1). Writes the three discrete SETs that activate the link.
   */
  async bindModifier(slot: number, targetEffectId: number, targetParam: number, source: number) {
    const mm = this.#prof.modModel;
    if (!mm) return { ok: false, error: 'device has no modifier model' };
    const f = mm.fields;
    if (!f.targetEffectId || !f.targetParam || !f.source) {
      return { ok: false, error: 'modifier model is missing the target-binding fields (source/targetEffectId/targetParam)' };
    }
    const slotEid = mm.effectId + (Math.max(1, Math.floor(slot)) - 1);
    await this.#write(buildSetParameter(slotEid, f.targetEffectId.pid, targetEffectId, this.#prof.model));
    await this.#write(buildSetParameter(slotEid, f.targetParam.pid, targetParam, this.#prof.model));
    await this.#write(buildSetParameter(slotEid, f.source.pid, source, this.#prof.model));
    return { ok: true, slotEid, slot, targetEffectId, targetParam, source };
  }

  // ── telemetry: tuner / tempo / scene ──
  async setTuner(on: boolean) {
    if (this.#isAm4()) return { ok: false }; // no gen-3 tuner on AM4
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
  /** Rename a scene (0..7) in the WORKING BUFFER (fn 0x01 sub 0x2b, via fractal-midi's buildSetSceneName).
   *  Visible immediately; NOT persisted to flash — that's a separate store op. Name is 32-char ASCII max.
   *  #write watches briefly for a 0x64 rejection so the caller learns if the device refused it. */
  async setSceneName(index: number, name: string) {
    if (index < 0 || index > 7) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32); // printable ASCII, 32 max
    return this.#write(buildSetSceneName(index, clean, this.#prof.model));
  }
  /** Rename the working-buffer PRESET (fn 0x01 sub 0x28, via fractal-midi's buildRenamePreset). Visible
   *  immediately; persist to flash is the separate store op. Name is 32-char printable ASCII max. */
  async setPresetName(name: string) {
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    return this.#write(buildRenamePreset(clean, this.#prof.model));
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
    this.#emit({ type: 'changed', scope: 'grid' });
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
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async selectPreset(n: number) {
    this.#gridCache = null;
    const r = await this.#write(buildSwitchPresetSysEx(n, this.#prof.model));
    this.#emit({ type: 'changed', scope: 'preset' });
    return r;
  }
  async store(n: number) {
    return this.#write(buildStorePreset(n, this.#prof.model));
  }

  /** Load a raw preset dump (.syx bytes) straight into the device's EDIT BUFFER — no slot is touched
   *  (only `store` writes a slot). This is how you play a preset that isn't on the device (e.g. a
   *  cloud-only backup), sidestepping the slot limit. Sent paced (the FM3 CDC drops a flooded write).
   *
   *  The dump's preset-dump header (func 0x77) carries the TARGET slot as a 14-bit, MSB-first
   *  7-bit pair. A dump captured from slot N still names N — re-sending it verbatim makes the unit
   *  treat it as a store-to-N, NOT a load. Retargeting the header to 0x3FFF (`7F 7F`, the
   *  edit-buffer sentinel) is exactly what FM3-Edit's "Audition" does: the preset goes live in the
   *  edit buffer, no slot is written. We patch that field and fix the frame checksum in place. */
  async loadPresetBytes(syx: Uint8Array): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const bytes = Array.from(syx);
    retargetDumpToEditBuffer(bytes);
    if (dev.sendPaced) await dev.sendPaced(bytes);
    else await dev.sendQueued(bytes);
    this.#gridCache = null; // edit buffer changed → next grid/blocks read reflects it
    return { ok: true };
  }
  /** Load a stored version snapshot into the edit buffer. */
  async loadVersion(id: string): Promise<{ ok: boolean }> {
    const bytes = store.getPresetVersionBytes(id);
    if (!bytes) throw new Error('version not found');
    return this.loadPresetBytes(bytes);
  }
  /** Restore a version to its origin slot: load it into the edit buffer, then commit it to that slot
   *  (DESTRUCTIVE for that slot). This is the "Restore this version to device" action — unlike
   *  loadVersion, it persists to the preset's location, not just the edit buffer. */
  async restoreVersion(id: string): Promise<{ ok: boolean; location: number }> {
    const v = store.getPresetVersion(id);
    if (!v) throw new Error('version not found');
    if (v.location < 0) throw new Error('version has no slot to restore to');
    await this.loadVersion(id);
    await this.store(v.location);
    return { ok: true, location: v.location };
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

/** Fractal SysEx checksum: XOR of every byte from F0 up to (not including) the checksum, masked 0x7F. */
function fractalChecksum(frame: number[], f0: number, cksumIdx: number): number {
  let x = 0;
  for (let i = f0; i < cksumIdx; i++) x ^= frame[i] ?? 0;
  return x & 0x7f;
}

/** Rewrite a preset dump's header (func 0x77) to target the edit buffer (0x3FFF) instead of a slot,
 *  fixing the header checksum in place. Mutates `bytes`. No-op if no 0x77 header is found. */
function retargetDumpToEditBuffer(bytes: number[]): void {
  for (let i = 0; i + 7 < bytes.length; i++) {
    // Fractal preset-dump header: F0 00 01 74 <model> 77 <numHi> <numLo> ... <cksum> F7
    if (bytes[i] !== 0xf0 || bytes[i + 1] !== 0x00 || bytes[i + 2] !== 0x01 || bytes[i + 3] !== 0x74) continue;
    if (bytes[i + 5] !== 0x77) continue;
    bytes[i + 6] = 0x7f; // numHi  ┐ 0x3FFF = edit-buffer sentinel
    bytes[i + 7] = 0x7f; // numLo  ┘
    const end = bytes.indexOf(0xf7, i); // checksum sits just before the frame's F7
    if (end > i + 1) bytes[end - 1] = fractalChecksum(bytes, i, end - 1);
    return; // only the first (dump-begin) header carries the target
  }
}

export const device = new Device();
