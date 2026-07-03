// Device registry — everything that is CROSS-device: the one shared transport (a single exclusive
// MIDI/serial connection), connection selection/diagnostics, the fn 0x00 detection state machine that
// picks the active per-device driver, the SSE event bus, and the telemetry supervisor (tuner / output
// meters / CPU polls). Drivers never open ports and never poll on their own — they get the transport +
// event emit through DriverCtx and are otherwise pure device logic.
//
// Since the browser-runtime split this module is the TRANSPORT-AGNOSTIC core: everything Node-specific
// (serial/MIDI port enumeration, connection open, the persisted overrides file) arrives via
// RegistryDeps, so the same registry runs over the real transports (drivers/registry.ts wires them and
// owns the process singleton) or a browser's Web MIDI implementation. NO node:/transport imports here —
// this module must load in a browser (transport/types.js is type-only).
import {
  DEVICE_MODELS,
  buildIdentifyBroadcast,
  isFractalHeaderFrame,
  parseIdentifyResponse,
  modelFromPortName
} from 'forgefx-midi/shared';
import {
  buildTunerPageOpen,
  buildTunerPageClose,
  buildTunerPoll,
  isTunerResponse,
  parseTunerFreqHz,
  GEN3_OUTPUT_METERS,
  buildOutputMeterPoll,
  isOutputMeterResponse,
  parseOutputMeterRms,
  meterRmsToDb,
  buildCpuPoll,
  isCpuResponse,
  parseCpuRawLoad,
  cpuPercentFromRaw
} from 'forgefx-midi/gen3/axe-fx-iii';
// Per-device capability declarations (the package's single source of truth: scenes, channels, slot
// model, save, …). Surfaced via /device so Axis drives its UI from what each model actually supports,
// instead of hardcoded per-model assumptions.
import { FM3_DESCRIPTOR, FM9_DESCRIPTOR, AXEFX3_DESCRIPTOR, VP4_DESCRIPTOR } from 'forgefx-midi/devices/gen3';
import { AM4_DESCRIPTOR } from 'forgefx-midi/devices/am4';
import type { Transport, Conn, ConnKind } from '../transport/types.js';
import { DEFAULT_PROFILE, PROFILES, profileForModel, profileForKey, type DeviceProfile } from '../devices.js';
import { createGen3Driver } from './gen3.js';
import { createAm4Driver, type Am4Driver } from './am4.js';
import type { DeviceDriver, DeviceEvent, DriverCtx } from './types.js';

const DESCRIPTOR_BY_MODEL: Record<number, { capabilities: Record<string, unknown> }> = {
  0x10: AXEFX3_DESCRIPTOR as never,
  0x11: FM3_DESCRIPTOR as never,
  0x12: FM9_DESCRIPTOR as never,
  0x14: VP4_DESCRIPTOR as never,
  0x15: AM4_DESCRIPTOR as never
};

// Gen-3 virtual effects Axis exposes as rail screens (ToolRail's VIRTUAL map + the Modifier flyout's
// effectId 3) — surfaced in the capabilities DTO so the client stops hardcoding them per model.
const GEN3_VIRTUAL_EFFECTS: readonly { eid: number; slug: string; name: string }[] = [
  { eid: 1, slug: 'global', name: 'Setup' },
  { eid: 2, slug: 'controllers', name: 'Controllers' },
  { eid: 3, slug: 'modifier', name: 'Modifier' },
  { eid: 199, slug: 'fc', name: 'Footswitches' }
];
// gen-3 grid shunt effect-id base (shunt eids = 1024+); the AM4's linear chain has no shunts.
const GEN3_SHUNT_BASE = 1024;

/** One selectable connection as the deps' lister reports it (serial + MIDI, Fractal flagged) —
 *  structurally identical to transport/connection.ts's ConnInfo, re-declared here so the core stays
 *  free of transport imports. */
export interface ConnInfo {
  transport: ConnKind;
  id: string;
  label: string;
  fractal: boolean;
  model?: string;
  /** MIDI only: which endpoint this entry is (the picker offers In + Out separately). */
  dir?: 'input' | 'output';
}

/**
 * Everything Node-specific the registry needs, injected: connection resolution/opening/listing, the
 * persisted connection + profile overrides, serial path autodetect and MIDI availability. The server
 * wires the real transport/connection.ts functions (drivers/registry.ts); the mocked unit tests and a
 * browser runtime supply their own.
 */
export interface RegistryDeps {
  /** Resolve the active connection (manual override → serial auto → MIDI auto). */
  resolveConn(): Promise<Conn | null>;
  /** Open a Transport over a resolved connection. */
  openConn(conn: Conn): Transport;
  /** Every selectable connection, for /ports + /diag. */
  listConnections(): Promise<ConnInfo[]>;
  /** Manual connection override (persisted); null = auto. */
  getConnOverride(): Conn | null;
  setConnOverride(c: Conn | null): void;
  /** Manual device-profile override key (persisted; 'fm3'/'fm9'/'axe3'/'am4'); null = auto. */
  getProfileOverride(): string | null;
  setProfileOverride(key: string | null): void;
  /** Serial auto-detect path — display fallback while no transport is open. */
  autoDetectPath(): string | null;
  /** Native MIDI binding availability (diagnostics only). */
  midiAvailable(): boolean;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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

// The Node process object where available (server/Electron) — a browser runtime has none, and /diag
// must still answer there. Guarded access, not an import, so the browser bundle stays clean.
const proc = typeof process !== 'undefined' ? process : null;

export class DeviceRegistry {
  // Everything Node-specific — the real transport/connection.ts functions in production (wired by
  // drivers/registry.ts), mock implementations in the unit tests, Web MIDI in a browser runtime.
  #deps: RegistryDeps;
  // Provisional gen-3 profile (model byte, grid size, params, ranges, rosters). Starts from a persisted
  // manual profile override (Axis "Connection & Device"), then FORGEFX_DEVICE, else FM3; corrected to the
  // real unit on the first auto-detect (only when no override is set). Used for reporting (health/diag/
  // /ports) and as the fallback driver's profile when the attached unit hasn't identified itself.
  #prof: DeviceProfile;
  constructor(deps: RegistryDeps) {
    this.#deps = deps;
    this.#prof = ((): DeviceProfile => {
      const forced = deps.getProfileOverride();
      if (forced) { const p = profileForKey(forced); if (p) return p; }
      if (proc?.env.FORGEFX_DEVICE) { const p = profileForKey(proc.env.FORGEFX_DEVICE); if (p) return p; }
      return DEFAULT_PROFILE;
    })();
  }

  #transport: Transport | null = null;
  #connecting: Promise<Transport> | null = null;
  #detected = false;
  #modelId = -1; // the ACTUAL attached/forced model byte (-1 = not identified yet)
  // The active driver — set ONLY by detect() from a positively identified (or forced) model. No
  // identification → no active driver → the telemetry supervisor never fires a frame at an unknown
  // unit (this replaces the old `#modelId === -1` wait-loop AND every #isAm4() gate).
  #active: DeviceDriver | null = null;
  // One driver instance per model byte (grid caches etc. survive re-detects of the same unit).
  #drivers = new Map<number, DeviceDriver>();
  #ctx: DriverCtx = { transport: () => this.transport(), emit: (e) => this.#emit(e) };

  get profile() { return this.#prof; }

  /** Driver factory: model byte → per-device driver over the shared transport. */
  #driverFor(modelId: number): DeviceDriver | null {
    const cached = this.#drivers.get(modelId);
    if (cached) return cached;
    const make: Record<number, () => DeviceDriver> = {
      0x10: () => createGen3Driver(PROFILES[0x10]!, this.#ctx),
      0x11: () => createGen3Driver(PROFILES[0x11]!, this.#ctx),
      0x12: () => createGen3Driver(PROFILES[0x12]!, this.#ctx),
      0x15: () => createAm4Driver(this.#ctx)
    };
    const f = make[modelId];
    if (!f) return null;
    const d = f();
    this.#drivers.set(modelId, d);
    return d;
  }

  /**
   * The driver for the attached device. Runs detection once, lazily (like the old Device.#ready), so
   * direct API use (not just the Axis client, which calls /device/detect first) still adapts to the
   * attached unit. When nothing identified itself (silent handshake, unsupported model, no device),
   * this serves the provisional gen-3 profile's driver — exactly the pre-driver behavior, where every
   * route simply tried the default profile and transport errors surfaced as the clear
   * "No Fractal device found…" 503s.
   */
  async driver(): Promise<DeviceDriver> {
    await this.#ready();
    return this.#active ?? this.#driverFor(this.#prof.model)!;
  }

  /** The AM4 driver instance — used by the /preset/decode model-byte dispatch (offline decode of an
   *  AM4 .syx works whatever unit is attached) and pre-fold by the /am4/* singleton routes. */
  am4(): Am4Driver {
    return this.#driverFor(0x15) as Am4Driver;
  }

  /** TEST-ONLY seam (see __setDriverForTest): pre-seed the driver cache for one model byte so the
   *  API suites can run against a hand-built fake driver. Production never calls this. */
  __seedDriver(modelId: number, d: DeviceDriver): void {
    this.#drivers.set(modelId, d);
  }

  /** Map a manual profile-override key to a model byte. Gen-3 keys resolve via profileForKey; AM4 has no
   *  gen-3 profile (it uses the separate am4 codec) so it maps to its model byte directly. -1 = unknown. */
  #forcedModelId(key: string): number {
    const p = profileForKey(key);
    if (p) return p.model;
    if (key === 'am4') return 0x15;
    return -1;
  }

  // ── event bus (SSE source): live tuner/scene/tempo/cpu pushes ──
  #subscribers = new Set<(e: DeviceEvent) => void>();
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

  get port() { return this.#transport?.label ?? this.#deps.autoDetectPath(); }

  /** The ONE shared open transport — every driver reads/writes through this, so AM4 + gen-3 never
   *  double-open the single exclusive MIDI/serial connection. */
  async transport(): Promise<Transport> {
    if (this.#transport?.isOpen) return this.#transport;
    // share a single open across concurrent callers — the UI fires many requests on load, and
    // opening the same port twice fails the exclusive lock ("Cannot lock port").
    if (!this.#connecting) {
      this.#connecting = (async () => {
        const conn = await this.#deps.resolveConn(); // serial (FM3 CDC) or MIDI (Axe-Fx III), manual override wins
        if (!conn) throw new Error('No Fractal device found on any serial or MIDI port. Connect the unit, quit other editors, or pick it under Connection.');
        const t = this.#deps.openConn(conn);
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

  async health() {
    const conn = await this.#deps.resolveConn();
    return { ok: !!conn, device: this.#prof.name };
  }

  /** Full connection diagnostic for the desktop debug log — platform, MIDI availability, every
   *  serial + MIDI in/out port, the resolved connection, and the live transport state. */
  async diagnostics() {
    let ports: ConnInfo[] = [];
    let listError: string | null = null;
    let resolved: Conn | null = null;
    try { ports = await this.#deps.listConnections(); } catch (e) { listError = (e as Error).message; }
    try { resolved = await this.#deps.resolveConn(); } catch (e) { listError = (listError ?? '') + ' | resolve: ' + (e as Error).message; }
    const midi = ports.filter((p) => p.transport === 'midi');
    return {
      ok: true,
      platform: proc?.platform ?? 'browser',
      arch: proc?.arch ?? '',
      versions: { node: proc?.versions.node ?? '', napi: proc?.versions.napi ?? '' },
      profile: { key: this.#prof.key, name: this.#prof.name, model: `0x${this.#prof.model.toString(16)}` },
      detected: this.#detected,
      midiAvailable: this.#deps.midiAvailable(),
      ports: {
        serial: ports.filter((p) => p.transport === 'serial').map((p) => ({ id: p.id, fractal: p.fractal, model: p.model })),
        midiIn: midi.filter((p) => p.dir === 'input').map((p) => ({ id: p.id, fractal: p.fractal })),
        midiOut: midi.filter((p) => p.dir === 'output').map((p) => ({ id: p.id, fractal: p.fractal }))
      },
      override: this.#deps.getConnOverride(),
      profileOverride: this.#deps.getProfileOverride(),
      resolved,
      transportOpen: !!this.#transport?.isOpen,
      transportLabel: this.#transport?.label ?? null,
      listError
    };
  }

  /** Every connection (serial + MIDI, Fractal flagged) + the chosen one + any manual override. */
  async connections() {
    return {
      chosen: await this.#deps.resolveConn(),
      override: this.#deps.getConnOverride(),
      profileOverride: this.#deps.getProfileOverride(),
      profile: { key: this.#prof.key, name: this.#prof.name, model: `0x${this.#prof.model.toString(16)}` },
      ports: await this.#deps.listConnections()
    };
  }
  /** Manually pick a connection (persisted); null clears it back to auto-detect. Optionally force the
   *  device profile (`model` key: fm3/fm9/axe3/am4, or 'auto'/null to clear). Drops the live connection so
   *  the next request reconnects on the chosen port; a forced profile skips the handshake in detect(). */
  async selectConnection(conn: Conn | null, model?: string | null) {
    this.#deps.setConnOverride(conn);
    if (model !== undefined) {
      this.#deps.setProfileOverride(model && model !== 'auto' ? model : null);
      const forced = this.#deps.getProfileOverride();
      if (forced) { const p = profileForKey(forced); if (p) this.#prof = p; } // apply gen-3 profile now (AM4 handled in detect)
    }
    if (this.#transport) {
      await this.#transport.close().catch(() => {});
      this.#transport = null;
    }
    this.#connecting = null;
    this.#detected = false;
    this.#active = null; // the next detect re-identifies — never poll the new port with the old model
    return { ok: true, chosen: await this.#deps.resolveConn(), profileOverride: this.#deps.getProfileOverride() };
  }

  /** Phase-6 extended capability matrix for a model byte — the ADDITIVE superset fields merged into
   *  the curated descriptor subset (see #capabilitiesDto). Derived from the driver's own
   *  DriverCapabilities + which optional driver methods it implements (capability-, never
   *  model-gated), so the DTO can't drift from what the routes actually answer. Null when no driver
   *  exists for the model (e.g. VP4) — the curated subset is then served alone. */
  #extendedCaps(mid: number): Record<string, unknown> | null {
    const d = this.#driverFor(mid);
    if (!d) return null;
    const c = d.capabilities;
    const grid = c.slotModel === 'grid';
    const prof = grid ? profileForModel(mid) : null;
    return {
      presets: {
        count: grid ? 512 : 104, // 512 slots on every gen-3 unit; 104 (A01..Z04) on the AM4
        addressing: grid ? 'numeric' : 'bankLetter',
        canRename: !!d.setPresetName,
        canScanNames: !!d.scanPresets,
        canDeepScan: c.presetDump,
        liveQuery: !!d.presetRef
      },
      gridRouting: c.gridEdit,
      gridCursorSelect: !!d.selectCell,
      shuntBase: grid ? GEN3_SHUNT_BASE : null,
      // both codecs serve full param catalogs server-side (gen-3 tables + AM4 KNOWN_PARAMS) — Axis
      // can drop its client-side `!c.pack` gates on either device.
      paramsWithoutPack: true,
      tempo: !!d.getTempo,
      tuner: c.telemetry.tuner,
      meters: {
        blockMeters: !!d.meters,
        liveMonitors: !!d.liveMonitors && !!prof?.monitorParams,
        outputLevels: c.telemetry.outputMeters,
        cpu: c.telemetry.cpu
      },
      sceneNamesWritable: !!d.setSceneName,
      fc: { model: c.fcModel, liveState: c.fcLiveRead },
      modifiers: { model: (d.modifierModel?.() ?? null) != null, bind: c.modBind },
      cabIrs: c.cabIrs,
      firmwareValidate: !!d.validateFirmware,
      backupDump: !!d.backupPreset,
      restoreDump: !!d.restorePreset,
      versionStore: !!d.dumpRaw && !!d.loadPresetBytes,
      deviceParams: !!d.setParamByKey,
      virtualEffects: grid ? GEN3_VIRTUAL_EFFECTS : []
    };
  }

  /** The capabilities object /device and /device/detect serve: the curated descriptor subset
   *  (unchanged keys, byte-compatible) with the Phase-6 extended matrix merged in BEFORE
   *  `supportsSave`, so a pretty-printed JSON diff against the pre-Phase-6 sweep stays
   *  additive-only (appending after the last key would rewrite its comma line). */
  #capabilitiesDto(mid: number): Record<string, unknown> | null {
    const c = DESCRIPTOR_BY_MODEL[mid]?.capabilities as Record<string, unknown> | undefined;
    if (!c) return null;
    // curated subset (drop the RegExp preset_location_format — not JSON-clean, not needed by the UI)
    return {
      slotModel: c.slot_model, slotCount: c.slot_count, grid: c.grid,
      hasScenes: !!c.has_scenes, sceneCount: c.scene_count ?? 0,
      hasChannels: !!c.has_channels, channelNames: c.channel_names ?? [], channelBlocks: c.channel_blocks ?? [],
      ...(this.#extendedCaps(mid) ?? {}),
      supportsSave: !!c.supports_save
    };
  }

  async deviceInfo() {
    await this.#ready(); // ensure detection ran so #modelId reflects the ACTUAL attached unit
    // Report the DETECTED model id/byte (the provisional gen-3 profile can't identify an AM4) so
    // consumers (e.g. the library) can tell what is actually attached.
    const mid = this.#modelId >= 0 ? this.#modelId : this.#prof.model;
    const m = DEVICE_MODELS[mid];
    // apiVersion mirrors /healthz's api.version — the unified-API handshake (placed mid-object so
    // the route-sweep diff stays additive-only).
    return { model: m?.name ?? this.#prof.name, modelByte: `0x${mid.toString(16)}`, modelId: mid, apiVersion: 2, capabilities: this.#capabilitiesDto(mid), firmware: null as null | { version: string; build: string }, port: this.port };
  }

  /** Ensure the active driver matches the attached unit — runs detect once, lazily, so direct API
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
  async detect(): Promise<{ connected: boolean; modelId: number; name: string; short: string; gen: number; supported: boolean; capabilities: Record<string, unknown> | null; port: string | null }> {
    // Gate on a connection resolvable over ANY transport — serial CDC (FM3) OR USB-MIDI (Axe-Fx III /
    // FM9). The old guard used the serial-only `this.port`, which is null for a MIDI-only unit, so the
    // handshake was skipped and the profile stayed on the default model byte — the Windows Axe-Fx III
    // "device offline" bug (macOS worked only because the III also exposes a serial node there).
    const conn = await this.#deps.resolveConn();
    if (!conn) return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, capabilities: null, port: null };
    // Forced profile (Axis "Connection & Device" override): trust the chosen model, skip the handshake.
    // This is the MIDI-DIN→USB-adapter case — a generic MIDI interface into an FM3 won't answer the 0x7F
    // broadcast or carry a Fractal port name, so auto-detect can't ID it. We still open the transport (so a
    // dead port is visible) but never let a silent handshake downgrade the user's explicit choice.
    const forced = this.#deps.getProfileOverride();
    if (forced) {
      const modelId = this.#forcedModelId(forced);
      const p = profileForModel(modelId);
      if (p.model === modelId) this.#prof = p; // gen-3; AM4 keeps the provisional profile but reports 0x15 below
      this.#modelId = modelId;
      this.#detected = true;
      this.#activate(modelId >= 0 ? this.#driverFor(modelId) : null);
      let port: string | null = null;
      try { await this.transport(); port = this.#transport?.label ?? conn.id; } catch { /* dead port — report best-effort */ }
      const m = DEVICE_MODELS[modelId];
      console.log(`[forgefx] detect: FORCED profile '${forced}' → model 0x${modelId >= 0 ? modelId.toString(16) : '?'} (handshake skipped)`);
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        capabilities: this.#capabilitiesDto(modelId),
        port: port ?? conn.id
      };
    }
    try {
      const dev = await this.transport();
      const port = this.#transport?.label ?? conn.id;
      const frames = await dev.request(buildIdentifyBroadcast(), { timeoutMs: 1500, quietMs: 60, match: (fs) => fs.some((f) => isFractalHeaderFrame(f)) });
      const f = frames.find((x) => isFractalHeaderFrame(x));
      let modelId = f ? parseIdentifyResponse(f)!.modelId : -1;
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
      this.#activate(modelId >= 0 ? this.#driverFor(modelId) : null);
      console.log(`[forgefx] active profile: ${this.#prof.key} (model 0x${this.#prof.model.toString(16)}, ${this.#prof.rows}x${this.#prof.cols}) ${p.model === modelId ? 'adopted' : 'kept default — no profile for 0x' + (modelId >= 0 ? modelId.toString(16) : '?')}`);
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        capabilities: this.#capabilitiesDto(modelId),
        port
      };
    } catch {
      return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, capabilities: null, port: this.#transport?.label ?? conn.id };
    }
  }

  /** Swap the active driver and re-gate the telemetry supervisor on its capabilities (a device
   *  without gen-3 telemetry — the AM4 — must never receive gen-3 polls). */
  #activate(d: DeviceDriver | null) {
    this.#active = d;
    if (d && !d.capabilities.telemetry.outputMeters) this.#stopMeters();
    if (d && !d.capabilities.telemetry.tuner && this.#tunerTimer) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; }
  }

  /** DEBUG probe: send a raw SysEx frame, return every response frame as hex (for FC read-decode). */
  async rawRequest(bytes: number[]): Promise<string[]> {
    const dev = await this.transport();
    const frames = await dev.request(bytes, { timeoutMs: 1200, quietMs: 120, match: (fs: number[][]) => fs.length > 0 });
    return frames.map((f) => f.map((b) => b.toString(16).padStart(2, '0')).join(''));
  }

  // ── telemetry supervisor: tuner / output meters / CPU ──
  // Timers live HERE, not in the drivers: they run only while (a) a driver whose capabilities allow the
  // poll is active — or, for the tuner, the driver setTuner() was invoked with — and (b) for the meters,
  // ≥1 SSE subscriber is listening. All cadence + smoothing constants moved verbatim from the old Device.
  #tunerTimer: ReturnType<typeof setTimeout> | null = null;
  // The driver the tuner was opened against (setTuner ran driver()) — polls use ITS model byte.
  #tunerDriver: DeviceDriver | null = null;
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

  // Tuner: FM3-Edit opens the tuner page (fn 0x12 sub 0x1e) then POLLS fn 0x01 sub 0x19 field 0x02,
  // whose value field (float32 @ off 12) is the detected fundamental in Hz. We replicate that and
  // stream note/cents over SSE. (Reverse-engineered from an FM3-Edit capture.)
  async #pollTuner() {
    if (!this.#tunerTimer) return;
    const d = this.#tunerDriver;
    if (!d || !d.capabilities.telemetry.tuner) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; return; } // no gen-3 tuner on this device
    try {
      const dev = await this.transport();
      const frames = await dev.request(buildTunerPoll(d.modelId), {
        timeoutMs: 300,
        quietMs: 35,
        match: (fs) => fs.some((f) => isTunerResponse(f))
      });
      const f = frames.find((x) => isTunerResponse(x));
      if (f) {
        const freq = parseTunerFreqHz(f);
        this.#emit({ type: 'tuner', freq: Math.round(freq * 100) / 100, ...(freqToNote(freq) ?? {}) });
      }
    } catch {
      /* transient — keep polling */
    }
    if (this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 55);
  }

  async setTuner(on: boolean) {
    const d = await this.driver();
    if (!d.capabilities.telemetry.tuner) return { ok: false }; // no gen-3 tuner on this device (AM4)
    const dev = await this.transport();
    if (on) {
      this.#tunerDriver = d;
      await dev.sendQueued(buildTunerPageOpen(d.modelId)); // open the tuner page
      if (!this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 30);
    } else {
      if (this.#tunerTimer) {
        clearTimeout(this.#tunerTimer);
        this.#tunerTimer = null;
      }
      await dev.sendQueued(buildTunerPageClose(d.modelId)); // leave tuner page (back to layout)
    }
    return { ok: true };
  }

  // Live output meters + CPU. Reverse-engineered from FM3-Edit's Preset Leveling page (see
  // fm3-scratchpad findings/live-capture-2026-07.md):
  //   METERS — fn 0x01 sub 0x19, round-robin over Output 1/2 × L/R (addr 0x2A/0x2B, sub 0x10/0x11).
  //     Reply bytes[12..16] = 5-septet-LE float32 = RMS energy → dB = 10·log10(v), floor −40. The REAL,
  //     calibrated meters (matched the live readout to ~1 dB). 0x2E bytes 35/36 saturate → not used.
  //   CPU — fn 0x01 sub 0x2E, byte 37 = block DSP load → CPU% ≈ CPU_BASE + byte37·CPU_SLOPE. That's a
  //     590-byte frame, so we read it only once per round-robin cycle (meters are tiny 23-byte reads).
  // Runs while ≥1 SSE client is subscribed AND the active driver's telemetry capability allows it.
  #startMeters() {
    if (this.#metersTimer) return;
    if (this.#active && !this.#active.capabilities.telemetry.outputMeters) return; // no gen-3 meter frames on this device
    this.#metersTimer = setTimeout(() => this.#pollMeters(), 120);
  }
  #stopMeters() {
    if (this.#metersTimer) clearTimeout(this.#metersTimer);
    this.#metersTimer = null;
  }
  async #pollMeters() {
    if (!this.#metersTimer) return;
    // Wait until a driver is ACTIVE (positively identified) before poking the unit — the SSE
    // subscription can start the meter poll before detect() runs, and we must not fire gen-3 frames at
    // an as-yet-unknown device (e.g. an auto-detected AM4). Once detect() activates a driver we either
    // proceed (its capabilities allow) or stop (they don't).
    const d = this.#active;
    if (!d) {
      this.#metersTimer = setTimeout(() => this.#pollMeters(), 300);
      return;
    }
    if (!d.capabilities.telemetry.outputMeters) { this.#stopMeters(); return; }
    let slow = false;
    try {
      const dev = await this.transport();
      // A slow link — a generic MIDI interface into 5-pin DIN (≈31.25 kbaud) — can't carry meter polling
      // without inflating every other request to seconds, so SKIP it there (a cheap 2 s re-check resumes it
      // instantly on a fast link). Fast USB-MIDI (Axe-Fx III / FM9) and USB-CDC serial are NOT slow.
      slow = dev.slow;
      if (!slow) {
        // Read ALL 4 output meters back-to-back each tick (tiny 23-byte reads — this is exactly what
        // FM3-Edit's leveling page does; NOT the many-block sweep that stutters audio) so every bar
        // refreshes every tick, not once per round-robin → smooth, not choppy.
        for (let i = 0; i < 4; i++) {
          const meter = GEN3_OUTPUT_METERS[i]!;
          const frames = await dev.request(buildOutputMeterPoll(meter, d.modelId), { timeoutMs: 200, quietMs: 12, match: (fs) => fs.some((f) => isOutputMeterResponse(f, meter)) });
          const f = frames.find((x) => isOutputMeterResponse(x, meter));
          if (f) {
            const raw = meterRmsToDb(parseOutputMeterRms(f), DeviceRegistry.METER_FLOOR, DeviceRegistry.METER_CEIL);
            const prev = this.#mDb[i]!;
            const a = raw > prev ? DeviceRegistry.METER_ATTACK : DeviceRegistry.METER_RELEASE;
            this.#mDb[i] = prev + a * (raw - prev);
          }
        }
        this.#emit({ type: 'meters', out1L: this.#mDb[0]!, out1R: this.#mDb[1]!, out2L: this.#mDb[2]!, out2R: this.#mDb[3]! });
        // CPU is a heavy 590-byte read → poll it only occasionally (every ~8th tick), off the meter path.
        if (this.#meterStep++ % 8 === 0) {
          const frames = await dev.request(buildCpuPoll(d.modelId), { timeoutMs: 400, quietMs: 25, match: (fs) => fs.some((f) => isCpuResponse(f)) });
          const f = frames.find((x) => isCpuResponse(x));
          if (f) this.#emit({ type: 'cpu', percent: cpuPercentFromRaw(parseCpuRawLoad(f)) });
        }
      }
    } catch {
      /* transient — keep polling */
    }
    // short gap after the 4 reads → ~8–10 full meter refreshes/sec
    if (this.#metersTimer) this.#metersTimer = setTimeout(() => this.#pollMeters(), slow ? 2000 : 60);
  }
}

/** Build a DeviceRegistry over the given deps — the server wires the real transports
 *  (drivers/registry.ts singleton), the mocked tests and a browser runtime their own. */
export function createRegistry(deps: RegistryDeps): DeviceRegistry {
  return new DeviceRegistry(deps);
}
