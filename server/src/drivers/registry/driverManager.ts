// Driver manager: the per-model driver factory/cache, the fn-0x00 detection state machine that picks
// the active driver, the running-firmware probe (fn 0x08) and the device-cache runtime-profile swap.
// Split out of registryCore.ts (C3) — the registry facade owns connection/transport + reporting and
// delegates all device-identity concerns here. Drivers never open ports: they get the shared transport
// through DriverCtx, wired from the host.
import {
  DEVICE_MODELS,
  buildIdentifyBroadcast,
  isFractalHeaderFrame,
  parseIdentifyResponse,
  modelFromPortName,
  buildFirmwareVersionQuery,
  parseFirmwareVersionReply,
  formatFirmwareVersion,
  FN_FIRMWARE_VERSION
} from 'forgefx-midi/shared';
import type { BuiltCache } from 'forgefx-midi/cache';
import type { Conn, Transport } from '../../transport/types.js';
import { PROFILES, profileForModel, runtimeProfileFrom, type DeviceProfile } from '../../devices.js';
import { DEVICE_CATALOG, modelIdForForcedKey } from '../deviceCatalog.js';
import { capabilitiesDto } from './capabilities.js';
import { deviceCacheKey } from '../../services/deviceCacheKey.js';
import { DEFAULT_DRIVER_CONFIG, type DeviceDriver, type DeviceEvent, type DriverConfig, type DriverCtx } from '../types.js';
import type { CadenceProfile } from '../telemetryProfiles.js';

/** The Node/browser-injected deps the manager needs (a structural subset of RegistryDeps). */
export interface DriverManagerDeps {
  /** Resolve the active connection (manual override → serial auto → MIDI auto). */
  resolveConn(): Promise<Conn | null>;
  /** Manual device-profile override key (persisted; 'fm3'/'fm9'/'axe3'/'am4'); null = auto. */
  getProfileOverride(): string | null;
  /** Load a persisted device cache for the given key, or null when none exists. Absent → the manager
   *  never swaps in a runtime profile. */
  loadDeviceCache?(key: string): BuiltCache | null | Promise<BuiltCache | null>;
  /** Runtime knobs handed to every driver through DriverCtx.config. Absent → DEFAULT_DRIVER_CONFIG. */
  driverConfig?: Partial<DriverConfig>;
}

/** What the manager needs from the registry facade / telemetry supervisor. */
export interface DriverManagerHost {
  /** The one shared open transport. */
  transport(): Promise<Transport>;
  /** The current transport instance synchronously (null before open) — used for the best-effort
   *  port label on a detection failure. */
  currentTransport(): Transport | null;
  /** Event-bus emit. */
  emit(e: DeviceEvent): void;
  /** The supervisor-resolved cadence for DriverCtx.getCadence(). */
  getCadence(): CadenceProfile;
  /** The provisional gen-3 profile (reporting fallback + the un-identified driver's profile). */
  getProfile(): DeviceProfile;
  /** Adopt a detected / forced / runtime profile so reporting stays in sync. */
  setProfile(p: DeviceProfile): void;
  /** Re-gate the telemetry supervisor on the newly active driver. */
  reconcile(d: DeviceDriver | null): void;
}

export class DriverManager {
  #deps: DriverManagerDeps;
  #host: DriverManagerHost;
  #ctx: DriverCtx;
  #config: DriverConfig;
  // The active driver — set ONLY by detect()/onActivate from a positively identified (or forced) model.
  // No identification → no active driver → the telemetry supervisor never fires a frame at an unknown
  // unit (this replaces the old `#modelId === -1` wait-loop AND every #isAm4() gate).
  #active: DeviceDriver | null = null;
  // One driver instance per model byte (grid caches etc. survive re-detects of the same unit).
  #drivers = new Map<number, DeviceDriver>();
  #modelId = -1; // the ACTUAL attached/forced model byte (-1 = not identified yet)
  // Running firmware, populated best-effort during detect() on gen-3 units (fn 0x08). null until a
  // reply lands (silence/timeout/non-gen-3 keeps it null).
  #firmware: { major: number; minor: number; version: string; build: string } | null = null;
  #detected = false;

  constructor(deps: DriverManagerDeps, host: DriverManagerHost) {
    this.#deps = deps;
    this.#host = host;
    this.#config = { ...DEFAULT_DRIVER_CONFIG, ...deps.driverConfig };
    this.#ctx = { transport: () => host.transport(), emit: (e) => host.emit(e), getCadence: () => host.getCadence(), config: this.#config };
  }

  get activeDriver(): DeviceDriver | null { return this.#active; }
  get detected(): boolean { return this.#detected; }
  /** The positively-detected model byte (-1 until detection identifies a unit). */
  get detectedModelId(): number { return this.#modelId; }
  /** The active driver's capabilities, or null when nothing is positively identified (the deviceCache
   *  service gates its selfDescribe precondition on this). */
  activeCapabilities() { return this.#active?.capabilities ?? null; }
  /** Running firmware (populated best-effort on gen-3 during detect), or null. Includes the numeric
   *  major/minor the deviceCache key needs alongside the display `version`. */
  firmwareInfo(): { major: number; minor: number; version: string; build: string } | null { return this.#firmware; }

  /** Map a manual profile-override key to a model byte via the deviceCatalog (gen-3 keys match the
   *  profile key; descriptor devices carry their own aliases). -1 = unknown. */
  #forcedModelId(key: string): number {
    return modelIdForForcedKey(key);
  }

  /** Driver factory: model byte → per-device driver over the shared transport (deviceCatalog). */
  #driverFor(modelId: number): DeviceDriver | null {
    const cached = this.#drivers.get(modelId);
    if (cached) return cached;
    const entry = DEVICE_CATALOG.get(modelId);
    if (!entry) return null;
    const d = entry.create(this.#ctx);
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
    await this.ready();
    return this.#active ?? this.#driverFor(this.#host.getProfile().model)!;
  }

  /** The driver for a specific model byte, whatever unit is attached — for offline, transport-free
   *  work (e.g. decoding an AM4 .syx on a gen-3 host). Null when the model has no driver. */
  driverForModel(modelId: number): DeviceDriver | null {
    return this.#driverFor(modelId);
  }

  /** TEST-ONLY seam (see __setDriverForTest): pre-seed the driver cache for one model byte so the
   *  API suites can run against a hand-built fake driver. Production never calls this. */
  __seedDriver(modelId: number, d: DeviceDriver): void {
    this.#drivers.set(modelId, d);
  }

  /** TEST-ONLY seam: force the running-firmware snapshot (normally populated by the fn 0x08 query
   *  during detect) so suites that need a firmware stamp can set one without scripting the query. */
  __setFirmwareForTest(fw: { major: number; minor: number; version: string; build: string }): void {
    this.#firmware = fw;
  }

  /** The capabilities object /device and /device/detect serve — see registry/capabilities.ts. */
  capabilitiesDto(mid: number): Record<string, unknown> | null {
    return capabilitiesDto(this.#driverFor(mid), mid);
  }

  /** Ensure the active driver matches the attached unit — runs detect once, lazily, so direct API
   * use (not just the Axis client) still adapts to an FM9 vs FM3 without an explicit detect call. */
  async ready() {
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
    // FM9). The old guard used the serial-only port, which is null for a MIDI-only unit, so the
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
      if (p.model === modelId) this.#host.setProfile(p); // gen-3; AM4 keeps the provisional profile but reports 0x15 below
      this.#modelId = modelId;
      this.#detected = true;
      this.#activate(modelId >= 0 ? this.#driverFor(modelId) : null);
      await this.#afterActivate(modelId); // firmware populate + runtime-cache profile swap (best-effort)
      let port: string | null = null;
      try { const t = await this.#host.transport(); port = t.label ?? conn.id; } catch { /* dead port — report best-effort */ }
      const m = DEVICE_MODELS[modelId];
      console.log(`[forgefx] detect: FORCED profile '${forced}' → model 0x${modelId >= 0 ? modelId.toString(16) : '?'} (handshake skipped)`);
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        capabilities: this.capabilitiesDto(modelId),
        port: port ?? conn.id
      };
    }
    try {
      const dev = await this.#host.transport();
      const port = dev.label ?? conn.id;
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
      if (p.model === modelId) this.#host.setProfile(p);
      this.#modelId = modelId;
      this.#detected = true;
      this.#activate(modelId >= 0 ? this.#driverFor(modelId) : null);
      await this.#afterActivate(modelId); // firmware populate + runtime-cache profile swap (best-effort)
      // Report what actually handles the unit — the ACTIVE DRIVER, not the vestigial gen-3 profile. A
      // non-gen-3 unit (the AM4) has a real driver (its own codec + capabilities) even though the gen-3
      // profile keeps its FM3 default; logging "profile fm3 kept default" for an AM4 reads as a detection
      // failure when detection in fact succeeded. Only genuinely unhandled models fall through to it.
      const drv = this.#active;
      if (drv) {
        const c = drv.capabilities;
        const shape = c.slotModel === 'grid' && c.grid ? `${c.grid.rows}x${c.grid.cols} grid` : `${c.slotCount ?? '?'} linear slots`;
        console.log(`[forgefx] active driver: ${drv.key} (model 0x${modelId.toString(16)}, ${shape}) — ${p.model === modelId ? 'gen-3 profile adopted' : 'own codec (no gen-3 profile, as expected)'}`);
      } else {
        console.log(`[forgefx] no driver for 0x${modelId >= 0 ? modelId.toString(16) : '?'} — kept default profile ${this.#host.getProfile().key} (0x${this.#host.getProfile().model.toString(16)})`);
      }
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        capabilities: this.capabilitiesDto(modelId),
        port
      };
    } catch {
      return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, capabilities: null, port: this.#host.currentTransport()?.label ?? conn.id };
    }
  }

  /** Swap the active driver and re-gate the telemetry supervisor on its capabilities. */
  #activate(d: DeviceDriver | null) {
    this.#active = d;
    this.#host.reconcile(d);
  }

  /** Post-activation best-effort work, run inside detect() after the driver is chosen: populate the
   *  running firmware (gen-3 fn 0x08) then, if a device cache exists for this model+firmware, swap the
   *  driver's static profile for the device-true runtime one. Both are wrapped so neither can fail
   *  detection — silence/timeout/no-cache simply leave the static behavior in place. */
  async #afterActivate(modelId: number): Promise<void> {
    await this.#populateFirmware(modelId);
    await this.applyRuntimeCache();
  }

  /** Best-effort firmware-version read (fn 0x08) over the shared transport — gen-3 only (the query is
   *  HW-verified on the FM3, shared on FM9/III; AM4/gen1/gen2 are never queried). Silence/timeout or a
   *  non-gen-3 model leaves `#firmware` null; never throws (detection must not depend on it). */
  async #populateFirmware(modelId: number): Promise<void> {
    if (modelId < 0 || DEVICE_MODELS[modelId]?.gen !== 3) return;
    try {
      const dev = await this.#host.transport();
      const frames = await dev.request(buildFirmwareVersionQuery(modelId), {
        timeoutMs: 800,
        quietMs: 40,
        match: (fs) => fs.some((f) => isFractalHeaderFrame(f) && f[5] === FN_FIRMWARE_VERSION)
      });
      const f = frames.find((x) => isFractalHeaderFrame(x) && x[5] === FN_FIRMWARE_VERSION);
      const v = f ? parseFirmwareVersionReply(f) : null;
      if (v) this.#firmware = { major: v.major, minor: v.minor, version: formatFirmwareVersion(v.major, v.minor), build: v.build ?? '' };
    } catch {
      /* silence / timeout / dead port → firmware stays null */
    }
  }

  /** Swap the active driver's profile for a device-cache-derived RUNTIME profile when a cache doc
   *  exists for the attached model+firmware. Called on a fresh detect AND by the deviceCache service
   *  after a build/import completes. No-op without a loadDeviceCache hook, a driver that can ADOPT a
   *  runtime profile (selfDescribe walk OR cacheImport byte-source), known firmware, or a stored cache.
   *  Never throws. */
  async applyRuntimeCache(): Promise<void> {
    if (!this.#deps.loadDeviceCache) return;
    const d = this.#active;
    const mid = this.#modelId;
    const canAdopt = !!d && (d.capabilities.selfDescribe || d.capabilities.cacheImport) && !!d.applyRuntimeProfile;
    if (mid < 0 || !canAdopt || !this.#firmware) return;
    const key = deviceCacheKey(mid, this.#firmware.major, this.#firmware.minor);
    let built: BuiltCache | null = null;
    try { built = (await this.#deps.loadDeviceCache(key)) ?? null; } catch { built = null; }
    if (!built) return;
    const runtime = runtimeProfileFrom(built, PROFILES[mid] ?? this.#host.getProfile());
    d.applyRuntimeProfile!(runtime);
    if (PROFILES[mid]) this.#host.setProfile(runtime); // keep /diag + reporting profile in sync for gen-3
  }

  /** Drop the device-identity snapshot after a connection switch: the next detect() re-identifies,
   *  so the telemetry supervisor must never poll the new port with the old model. */
  reset(): void {
    this.#detected = false;
    this.#firmware = null;
    this.#active = null;
  }
}
