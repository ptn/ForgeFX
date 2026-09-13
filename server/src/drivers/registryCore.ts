// Device registry — everything that is CROSS-device: the one shared transport (a single exclusive
// MIDI/serial connection), connection selection/diagnostics, detection, the SSE event bus, and the
// telemetry supervisor (tuner / output meters / CPU polls). Drivers never open ports and never poll on
// their own — they get the transport + event emit through DriverCtx and are otherwise pure device logic.
//
// Since the browser-runtime split this module is the TRANSPORT-AGNOSTIC core: everything Node-specific
// (serial/MIDI port enumeration, connection open, the persisted overrides file) arrives via
// RegistryDeps, so the same registry runs over the real transports (drivers/registry.ts wires them and
// owns the process singleton) or a browser's Web MIDI implementation. NO node:/transport imports here —
// this module must load in a browser (transport/types.js is type-only).
//
// DeviceRegistry is now a FACADE (C3): the event bus, the telemetry supervisor (timers/polls/traffic)
// and the driver manager (factory cache + fn-0x00 detection + firmware/runtime-cache) live in
// registry/{eventBus,telemetrySupervisor,driverManager}.ts. This file owns the connection/transport
// lifecycle, the provisional profile, and the public reporting surface, delegating the rest.
import { DEVICE_MODELS } from 'forgefx-midi/shared';
import type { BuiltCache } from 'forgefx-midi/cache';
import type { Transport, Conn, ConnKind } from '../transport/types.js';
import { DEFAULT_PROFILE, profileForKey, type DeviceProfile } from '../devices.js';
import type { DeviceDriver, DeviceEvent, DriverCapabilities, DriverConfig } from './types.js';
import { EventBus } from './registry/eventBus.js';
import { TelemetrySupervisor, type TelemetryConfigDto } from './registry/telemetrySupervisor.js';
import { DriverManager } from './registry/driverManager.js';

export type { TelemetryConfigDto } from './registry/telemetrySupervisor.js';

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
  /** Load a persisted device cache for the given key (deviceCacheKey), or null when none exists.
   *  Injected so the core stays store-agnostic: the Node server reads defaultStore; a browser runtime
   *  its own. Absent → the registry never swaps in a runtime profile (static profile only). */
  loadDeviceCache?(key: string): BuiltCache | null | Promise<BuiltCache | null>;
  /** Runtime knobs handed to every driver through DriverCtx.config. The Node host derives them from
   *  the FORGEFX_* env vars (drivers/registry.ts); a browser host supplies its own. Absent → defaults. */
  driverConfig?: Partial<DriverConfig>;
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
  // The cross-device collaborators (C3). The bus fans events out; the supervisor owns every timer; the
  // manager owns the driver cache + detection. They talk back through the closures wired below.
  #eventBus: EventBus;
  #supervisor: TelemetrySupervisor;
  #manager: DriverManager;

  #transport: Transport | null = null;
  #connecting: Promise<Transport> | null = null;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
    this.#prof = ((): DeviceProfile => {
      const forced = deps.getProfileOverride();
      if (forced) { const p = profileForKey(forced); if (p) return p; }
      if (proc?.env.FORGEFX_DEVICE) { const p = profileForKey(proc.env.FORGEFX_DEVICE); if (p) return p; }
      return DEFAULT_PROFILE;
    })();

    this.#eventBus = new EventBus({
      onSubscribe: () => this.#supervisor.startAll(),
      onUnsubscribe: () => this.#supervisor.stopAll(),
      onEmit: (e) => this.#supervisor.onEmit(e)
    });
    this.#supervisor = new TelemetrySupervisor({
      transport: () => this.transport(),
      currentTransport: () => this.#transport,
      activeDriver: () => this.#manager.activeDriver,
      detectedModelId: () => this.#manager.detectedModelId,
      driver: () => this.driver(),
      emit: (e) => this.#eventBus.emit(e),
      subscriberCount: () => this.#eventBus.size
    });
    this.#manager = new DriverManager(deps, {
      transport: () => this.transport(),
      currentTransport: () => this.#transport,
      emit: (e) => this.#eventBus.emit(e),
      getCadence: () => this.#supervisor.cadence(),
      getProfile: () => this.#prof,
      setProfile: (p) => { this.#prof = p; },
      reconcile: (d) => this.#supervisor.reconcile(d)
    });
  }

  get profile() { return this.#prof; }

  /** The positively-detected model byte (-1 until detection identifies a unit). */
  get detectedModelId() { return this.#manager.detectedModelId; }
  /** The active driver's capabilities, or null when nothing is positively identified (the deviceCache
   *  service gates its selfDescribe precondition on this). */
  activeCapabilities(): DriverCapabilities | null { return this.#manager.activeCapabilities(); }
  /** Running firmware (populated best-effort on gen-3 during detect), or null. Includes the numeric
   *  major/minor the deviceCache key needs alongside the display `version`. */
  firmwareInfo(): { major: number; minor: number; version: string; build: string } | null { return this.#manager.firmwareInfo(); }
  /** Public emit seam: services (device-cache build progress) publish on the same SSE bus the drivers
   *  reach through DriverCtx.emit. */
  emitEvent(e: DeviceEvent): void { this.#eventBus.emit(e); }

  // ── telemetry cadence mode (in-memory; resets to the balanced default on restart) — supervisor-owned ──
  /** GET /telemetry/config payload. */
  getTelemetryConfig(): TelemetryConfigDto { return this.#supervisor.getTelemetryConfig(); }
  /** Set the cadence mode (PUT /telemetry/config). Validates, stores in-memory, and emits a
   *  `telemetryConfig` event so every live UI reflects it. Throws on an unknown mode (the route maps
   *  that to 400). Returns the fresh DTO. */
  setTelemetryMode(mode: string): TelemetryConfigDto { return this.#supervisor.setTelemetryMode(mode); }
  /** The accepted mode set — the route uses it to 400 an unknown value before calling the setter. */
  telemetryModes() { return this.#supervisor.telemetryModes(); }

  /**
   * The driver for the attached device. Runs detection once, lazily (like the old Device.#ready), so
   * direct API use (not just the Axis client, which calls /device/detect first) still adapts to the
   * attached unit. When nothing identified itself (silent handshake, unsupported model, no device),
   * this serves the provisional gen-3 profile's driver — exactly the pre-driver behavior, where every
   * route simply tried the default profile and transport errors surfaced as the clear
   * "No Fractal device found…" 503s.
   */
  async driver(): Promise<DeviceDriver> { return this.#manager.driver(); }

  /** The driver for a specific model byte, whatever unit is attached — for offline, transport-free
   *  work (e.g. decoding an AM4 .syx on a gen-3 host). Null when the model has no driver. */
  driverForModel(modelId: number): DeviceDriver | null { return this.#manager.driverForModel(modelId); }

  /** TEST-ONLY seam (see __setDriverForTest): pre-seed the driver cache for one model byte so the
   *  API suites can run against a hand-built fake driver. Production never calls this. */
  __seedDriver(modelId: number, d: DeviceDriver): void { this.#manager.__seedDriver(modelId, d); }

  /** TEST-ONLY seam: force the running-firmware snapshot (normally populated by the fn 0x08 query
   *  during detect) so suites that need a firmware stamp can set one without scripting the query. */
  __setFirmwareForTest(fw: { major: number; minor: number; version: string; build: string }): void { this.#manager.__setFirmwareForTest(fw); }

  /** TEST-ONLY: route-driven (non-supervisor) requests currently in flight — the value the supervisor
   *  yields on (FORGEFX-28). Production never calls this. */
  __interactiveInFlightForTest(): number { return this.#supervisor.interactiveInFlight(); }
  /** TEST-ONLY: re-run transport instrumentation to prove it is idempotent (a second wrap must be a
   *  no-op — double-wrapping would double-count the fn-0x1F echo guard and break edit reflection). */
  __instrumentTransportForTest(t: Transport): void { this.#supervisor.instrumentTransport(t); }

  // ── event bus (SSE source): live tuner/scene/tempo/cpu pushes ──
  subscribe(fn: (e: DeviceEvent, json: string) => void): () => void { return this.#eventBus.subscribe(fn); }
  /** Broadcast a shared-config change to every live UI (SSE + remote relay). Called by the store route on
   *  a `config` collection write. Does not touch the device — pure fan-out. */
  broadcastConfig(id: string, data: unknown, origin?: string) { this.#eventBus.broadcastConfig(id, data, origin); }

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
        this.#supervisor.instrumentTransport(t); // echo-guard + traffic counters + interactive-request tracking
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
      detected: this.#manager.detected,
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
      // Cumulative device-link traffic since the connection was instrumented (matches the SSE `traffic`
      // event's counters); telemetryMode surfaces the active cadence mode + its currently-active loops.
      telemetryMode: this.#supervisor.mode,
      traffic: this.#supervisor.trafficSnapshot(),
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
    this.#manager.reset(); // re-identify on the new port — never poll it with the old model
    return { ok: true, chosen: await this.#deps.resolveConn(), profileOverride: this.#deps.getProfileOverride() };
  }

  async deviceInfo() {
    await this.#manager.ready(); // ensure detection ran so modelId reflects the ACTUAL attached unit
    // Report the DETECTED model id/byte (the provisional gen-3 profile can't identify an AM4) so
    // consumers (e.g. the library) can tell what is actually attached.
    const mid = this.#manager.detectedModelId >= 0 ? this.#manager.detectedModelId : this.#prof.model;
    const m = DEVICE_MODELS[mid];
    const fw = this.#manager.firmwareInfo();
    // apiVersion mirrors /healthz's api.version — the unified-API handshake (placed mid-object so
    // the route-sweep diff stays additive-only).
    return { model: m?.name ?? this.#prof.name, modelByte: `0x${mid.toString(16)}`, modelId: mid, apiVersion: 2, capabilities: this.#manager.capabilitiesDto(mid), firmware: fw ? { version: fw.version, build: fw.build } : (null as null | { version: string; build: string }), port: this.port };
  }

  /** Detect the connected Fractal unit (delegated to the driver manager). */
  async detect() { return this.#manager.detect(); }

  /** Swap the active driver's profile for a device-cache-derived runtime profile (see driverManager). */
  async applyRuntimeCache(): Promise<void> { return this.#manager.applyRuntimeCache(); }

  /** Pause the telemetry supervisor for an exclusive operation; returns the resume fn (supervisor). */
  pauseTelemetry(): () => void { return this.#supervisor.pauseTelemetry(); }

  /** Open/close the device tuner + start/stop its poll (supervisor). */
  async setTuner(on: boolean) { return this.#supervisor.setTuner(on); }

  /** DEBUG probe: send a raw SysEx frame, return every response frame as hex (for FC read-decode). */
  async rawRequest(bytes: number[]): Promise<string[]> {
    const dev = await this.transport();
    const frames = await dev.request(bytes, { timeoutMs: 1200, quietMs: 120, match: (fs: number[][]) => fs.length > 0 });
    return frames.map((f) => f.map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
}

/** Build a DeviceRegistry over the given deps — the server wires the real transports
 *  (drivers/registry.ts singleton), the mocked tests and a browser runtime their own. */
export function createRegistry(deps: RegistryDeps): DeviceRegistry {
  return new DeviceRegistry(deps);
}
