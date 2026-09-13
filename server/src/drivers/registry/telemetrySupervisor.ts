// Telemetry supervisor: the cross-device polling loops (tuner / output meters / CPU / front-panel
// scene+channel+edit watches), the traffic emitter, and per-transport instrumentation. Split out of
// registryCore.ts (C3) — it owns every timer, not the drivers (drivers never poll on their own). The
// registry facade feeds it the shared transport, the active driver, and the event bus through
// TelemetryHost, so this module stays free of registry state.
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
import type { Transport } from '../../transport/types.js';
import type { DeviceDriver, DeviceEvent } from '../types.js';
import { cadenceFor, isTelemetryMode, TELEMETRY_MODES, type TelemetryMode, type CadenceProfile } from '../telemetryProfiles.js';
import { midiNoteName } from '../shared/notes.js';
import { TransportInstrumentation } from './instrumentation.js';

/** The /telemetry/config DTO: the current mode, its resolved cadence, and the full mode list.
 *  Cumulative-counter-free — traffic rides the SSE `traffic` event + /diag. */
export interface TelemetryConfigDto { mode: TelemetryMode; effective: CadenceProfile; modes: readonly TelemetryMode[]; }

/** What the supervisor needs from the registry facade — all resolved at call time so a reconnect or a
 *  fresh detect is picked up on the next reschedule. */
export interface TelemetryHost {
  /** The one shared open transport. */
  transport(): Promise<Transport>;
  /** The current transport instance synchronously (null before open) — the edit-push listener only
   *  attaches to an already-open port. */
  currentTransport(): Transport | null;
  /** The positively-identified active driver, or null. */
  activeDriver(): DeviceDriver | null;
  /** The detected model byte (-1 until identification) for cadence-family fallback. */
  detectedModelId(): number;
  /** The registry's lazy driver resolver (runs detection) — setTuner needs the attached unit. */
  driver(): Promise<DeviceDriver>;
  /** Event-bus emit. */
  emit(e: DeviceEvent): void;
  /** Live subscriber count — edit-watch/edit-push only run for a listening UI. */
  subscriberCount(): number;
}

/** Detected frequency (Hz) → musical note + cents offset (equal temperament, A4=440). */
function freqToNote(f: number): { note: string; cents: number; octave: number } | null {
  if (!(f > 0) || !Number.isFinite(f)) return null;
  const midi = 69 + 12 * Math.log2(f / 440);
  const nearest = Math.round(midi);
  return {
    note: midiNoteName(nearest),
    cents: Math.round((midi - nearest) * 100),
    octave: Math.floor(nearest / 12) - 1
  };
}

export class TelemetrySupervisor {
  #host: TelemetryHost;

  constructor(host: TelemetryHost) { this.#host = host; }

  // ── telemetry cadence mode (in-memory; resets to the balanced default on restart) ──
  #mode: TelemetryMode = 'balanced';
  /** The cadence bundle for the CURRENT mode + the ACTIVE driver's model family (falls back to the
   *  detected/provisional model, then generic). Resolved AT CALL TIME so a mode switch applies on the
   *  next reschedule of every loop without touching timers directly. */
  cadence(): CadenceProfile {
    const d = this.#host.activeDriver();
    const detected = this.#host.detectedModelId();
    const mid = d?.modelId ?? (detected >= 0 ? detected : null);
    return cadenceFor(mid, this.#mode);
  }
  /** GET /telemetry/config payload. */
  getTelemetryConfig(): TelemetryConfigDto {
    return { mode: this.#mode, effective: this.cadence(), modes: TELEMETRY_MODES };
  }
  /** Set the cadence mode (PUT /telemetry/config). Validates, stores in-memory, and emits a
   *  `telemetryConfig` event so every live UI reflects it. Throws on an unknown mode (the route maps
   *  that to 400). Returns the fresh DTO. */
  setTelemetryMode(mode: string): TelemetryConfigDto {
    if (!isTelemetryMode(mode)) throw new Error(`unknown telemetry mode '${mode}'`);
    this.#mode = mode;
    this.#host.emit({ type: 'telemetryConfig', mode });
    return this.getTelemetryConfig();
  }
  /** The accepted mode set — the route uses it to 400 an unknown value before calling the setter. */
  telemetryModes(): readonly TelemetryMode[] { return TELEMETRY_MODES; }
  get mode(): TelemetryMode { return this.#mode; }

  // ── per-transport instrumentation (traffic counters + echo guard + in-flight tracking) ──
  #inst = new TransportInstrumentation();

  /** Instrument a freshly-opened transport (traffic counters + echo guard + in-flight tracking). */
  instrumentTransport(t: Transport): void { this.#inst.instrument(t); }

  /** Run a supervisor-issued device call while marking it so it doesn't register as INTERACTIVE traffic
   *  (both meters and edit-watch poll concurrently — without this, one loop's request would make the
   *  other yield). */
  async #supervised<T>(fn: () => Promise<T>): Promise<T> { return this.#inst.supervised(fn); }
  /** Route-driven (non-supervisor) requests currently in flight — the supervisor yields to these. */
  interactiveInFlight(): number { return this.#inst.interactiveInFlight(); }

  /** The /diag + SSE `traffic` snapshot: cumulative counters + the currently-live loop set. */
  trafficSnapshot(): { txMsgs: number; txBytes: number; rxMsgs: number; rxBytes: number; since: number; loops: string[] } {
    return { ...this.#inst.traffic, since: this.#inst.since, loops: this.activeLoops() };
  }
  /** The currently-live supervisor loops, derived from which timers/listeners are active. */
  activeLoops(): string[] {
    const l: string[] = [];
    if (this.#metersTimer) l.push('meters');
    if (this.#editWatchTimer) l.push('editWatch');
    if (this.#tunerTimer) l.push('tuner');
    if (this.#editPushUnsub) l.push('editPush');
    return l;
  }

  /** Keep the watch baselines in sync with EVERY scene event (app writes via setScene included), so
   *  the poll never re-emits a scene change a client already saw. A scene switch also remaps per-block
   *  active channels — reset the channel-watch baseline too. */
  onEmit(e: DeviceEvent): void {
    if (e.type === 'scene') { this.#lastSceneIdx = e.index; this.#lastChannels = null; }
  }

  /** A subscriber appeared → stream what the active driver allows. Each start is idempotent. */
  startAll(): void {
    this.#startMeters(); // a listener is present → stream CPU + audio meters (gen-3 only)
    this.#startEditWatch(); // …and poll for front-panel edits on devices that don't push them (AM4 + FM3)
    this.#startEditPush(); // …and listen for gen-3's unsolicited front-panel state-broadcast bursts
    this.#startTraffic(); // …and stream ~1×/s device-link traffic counters
  }
  /** The last subscriber left → stop every subscriber-driven loop. */
  stopAll(): void {
    this.#stopMeters();
    this.#stopEditWatch();
    this.#stopEditPush();
    this.#stopTraffic();
  }

  /** Swap the active driver and re-gate the loops on its capabilities (a device without gen-3
   *  telemetry — the AM4 — must never receive gen-3 polls). Called by the registry's detect(). */
  reconcile(d: DeviceDriver | null): void {
    if (d && !d.capabilities.telemetry.outputMeters) this.#stopMeters();
    if (d && !d.capabilities.telemetry.tuner && this.#tunerTimer) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; }
    // Device-edit watch is capability-gated (deviceEditWatch = AM4 + FM3, which don't push): stop it on a device that doesn't need it,
    // start it on one that does when a listener is already connected (detect() can activate after subscribe).
    if (d && !d.capabilities.deviceEditWatch) this.#stopEditWatch();
    else if (d && d.capabilities.deviceEditWatch && this.#host.subscriberCount() > 0) this.#startEditWatch();
    // Device-edit push (gen-3): (re)attach the RX listener now that detect() has opened the transport +
    // picked the driver, or drop it on a device that doesn't push.
    if (d && !d.capabilities.deviceEditPush) this.#stopEditPush();
    else if (d && d.capabilities.deviceEditPush && this.#host.subscriberCount() > 0) this.#startEditPush();
  }

  /** Pause the supervisor for the duration of an exclusive operation (the device-cache self-describe
   *  walk saturates the port). Stops the tuner / meters / edit-watch / edit-push and returns a resume
   *  fn that restarts exactly what was running (respecting the live subscriber count + tuner-enabled
   *  state). Idempotent-safe: the resume closure captures the paused state. */
  pauseTelemetry(): () => void {
    const hadTuner = !!this.#tunerTimer;
    const hadMeters = !!this.#metersTimer;
    const hadEditWatch = !!this.#editWatchTimer;
    const hadEditPush = !!this.#editPushUnsub;
    if (this.#tunerTimer) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; }
    this.#stopMeters();
    this.#stopEditWatch();
    this.#stopEditPush();
    return () => {
      if (hadMeters) this.#startMeters();
      if (hadEditWatch) this.#startEditWatch();
      if (hadEditPush) this.#startEditPush();
      // the tuner page is still open (we only paused the poll) — just restart its poll timer.
      if (hadTuner && this.#tunerDriver && !this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 30);
    };
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
  #lastMeterTs = 0; // wall-clock of the last meter smoothing pass — the envelope follower scales by actual dt
  #lastSceneIdx: number | null = null; // last device-reported scene — front-panel scene-change watch
  #lastChannels: Map<number, number> | null = null; // last device-reported active channel per eid — channel-change watch
  static METER_FLOOR = -40; // display floor (matches FM3-Edit's Preset Leveling page)
  static METER_CEIL = 6; // meters run above 0 dB into clip (live-verified peaks to +5.8 dB)
  // Envelope-follower gap fractions, CALIBRATED FOR A 60 ms TICK (the historical meter cadence).
  // #meterFactor() rescales them to the actual elapsed dt so the ballistics hold at 100/400 ms ticks
  // (balanced/reduced) instead of getting sluggish.
  static METER_ATTACK = 0.7; // fraction of the gap closed when the level rises (snappy) @ 60 ms
  static METER_RELEASE = 0.35; // …when it falls (natural meter fall-off) @ 60 ms
  /** Rescale a 60 ms-calibrated envelope fraction to the actual elapsed dt (exponential time-constant),
   *  so meters keep their attack/release feel at any meter tick cadence. Clamped to a sane dt window. */
  static #meterFactor(base60: number, dtMs: number): number {
    const scale = Math.min(8, Math.max(0.25, dtMs / 60));
    return 1 - Math.pow(1 - base60, scale);
  }

  // Tuner: FM3-Edit opens the tuner page (fn 0x12 sub 0x1e) then POLLS fn 0x01 sub 0x19 field 0x02,
  // whose value field (float32 @ off 12) is the detected fundamental in Hz. We replicate that and
  // stream note/cents over SSE. (Reverse-engineered from an FM3-Edit capture.)
  async #pollTuner() {
    if (!this.#tunerTimer) return;
    const d = this.#tunerDriver;
    if (!d || !d.capabilities.telemetry.tuner) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; return; } // no tuner on this device
    // Drivers whose tuner isn't a gen-3 tuner-page poll (AM4 polls block 0x0023) resolve a full
    // reading themselves via readTuner(); everyone else uses the built-in gen-3 fn 0x01 poll.
    try {
      await this.#supervised(async () => {
        if (d.readTuner) {
          const r = await d.readTuner();
          if (r) this.#host.emit({ type: 'tuner', freq: Math.round(r.freq * 100) / 100, note: r.note, octave: r.octave, cents: r.cents });
        } else {
          const dev = await this.#host.transport();
          const frames = await dev.request(buildTunerPoll(d.modelId), {
            timeoutMs: 300,
            quietMs: 35,
            match: (fs) => fs.some((f) => isTunerResponse(f))
          });
          const f = frames.find((x) => isTunerResponse(x));
          if (f) {
            const freq = parseTunerFreqHz(f);
            this.#host.emit({ type: 'tuner', freq: Math.round(freq * 100) / 100, ...(freqToNote(freq) ?? {}) });
          }
        }
      });
    } catch {
      /* transient — keep polling */
    }
    // Cadence is family-fixed + mode-independent (gen-3 55 ms; AM4's four short reads → 100 ms), resolved
    // at reschedule time so it tracks the detected model.
    if (this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), this.cadence().tunerMs);
  }

  async setTuner(on: boolean) {
    const d = await this.#host.driver();
    if (!d.capabilities.telemetry.tuner) return { ok: false }; // no tuner on this device
    const dev = await this.#host.transport();
    if (on) {
      this.#tunerDriver = d;
      // Gen-3 opens/closes a device tuner PAGE; AM4's tuner block (0x0023) is always live, so a
      // readTuner driver skips the page open/close and just runs the poll timer.
      if (!d.readTuner) await dev.sendQueued(buildTunerPageOpen(d.modelId)); // open the tuner page
      if (!this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 30);
    } else {
      if (this.#tunerTimer) {
        clearTimeout(this.#tunerTimer);
        this.#tunerTimer = null;
      }
      if (!d.readTuner) await dev.sendQueued(buildTunerPageClose(d.modelId)); // leave tuner page (back to layout)
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
    const d = this.#host.activeDriver();
    if (d && !d.capabilities.telemetry.outputMeters) return; // no gen-3 meter frames on this device
    this.#metersTimer = setTimeout(() => this.#pollMeters(), this.cadence().meterTickMs); // primer at the mode's meter tick
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
    const d = this.#host.activeDriver();
    if (!d) {
      this.#metersTimer = setTimeout(() => this.#pollMeters(), 300);
      return;
    }
    if (!d.capabilities.telemetry.outputMeters) { this.#stopMeters(); return; }
    // Resolve the CURRENT-mode cadence once per tick (a mode switch applies from the next reschedule).
    const cad = this.cadence();
    // YIELD (FORGEFX-28): while a route-driven request is in flight (or queued behind one), SKIP this
    // tick's device I/O but keep the cadence — so a live edit never waits behind the meter round-robin.
    // A starvation guard forces the poll through after MAX_SKIPS consecutive skips so the front-panel
    // scene/channel watches never fully starve under sustained UI traffic.
    if (this.#inst.interactiveInFlight() > 0 && this.#meterSkips < TelemetrySupervisor.MAX_SKIPS) {
      this.#meterSkips++;
      if (this.#metersTimer) this.#metersTimer = setTimeout(() => this.#pollMeters(), cad.meterTickMs);
      return;
    }
    this.#meterSkips = 0;
    let slow = false;
    try {
      const dev = await this.#host.transport();
      // A slow link — a generic MIDI interface into 5-pin DIN (≈31.25 kbaud) — can't carry meter polling
      // without inflating every other request to seconds, so SKIP it there (a cheap re-check resumes it
      // instantly on a fast link). Fast USB-MIDI (Axe-Fx III / FM9) and USB-CDC serial are NOT slow.
      slow = dev.slow;
      if (!slow) await this.#supervised(async () => {
        // Envelope-follower dt: keep the meter ballistics constant in wall-clock terms across the
        // per-mode tick cadences (60/100/400 ms) by scaling the 60 ms-calibrated fractions to elapsed dt.
        const now = Date.now();
        const dt = this.#lastMeterTs ? now - this.#lastMeterTs : cad.meterTickMs;
        this.#lastMeterTs = now;
        const aUp = TelemetrySupervisor.#meterFactor(TelemetrySupervisor.METER_ATTACK, dt);
        const aDn = TelemetrySupervisor.#meterFactor(TelemetrySupervisor.METER_RELEASE, dt);
        // Read ALL 4 output meters back-to-back each tick (tiny 23-byte reads — this is exactly what
        // FM3-Edit's leveling page does; NOT the many-block sweep that stutters audio) so every bar
        // refreshes every tick, not once per round-robin → smooth, not choppy.
        for (let i = 0; i < 4; i++) {
          const meter = GEN3_OUTPUT_METERS[i]!;
          const frames = await dev.request(buildOutputMeterPoll(meter, d.modelId), { timeoutMs: 200, quietMs: 12, match: (fs) => fs.some((f) => isOutputMeterResponse(f, meter)) });
          const f = frames.find((x) => isOutputMeterResponse(x, meter));
          if (f) {
            const raw = meterRmsToDb(parseOutputMeterRms(f), TelemetrySupervisor.METER_FLOOR, TelemetrySupervisor.METER_CEIL);
            const prev = this.#mDb[i]!;
            const a = raw > prev ? aUp : aDn;
            this.#mDb[i] = prev + a * (raw - prev);
          }
        }
        this.#host.emit({ type: 'meters', out1L: this.#mDb[0]!, out1R: this.#mDb[1]!, out2L: this.#mDb[2]!, out2R: this.#mDb[3]! });
        // CPU is a heavy 590-byte read → poll it only occasionally (every Nth tick), off the meter path.
        if (this.#meterStep % cad.cpuEveryNTicks === 0) {
          const frames = await dev.request(buildCpuPoll(d.modelId), { timeoutMs: 400, quietMs: 25, match: (fs) => fs.some((f) => isCpuResponse(f)) });
          const f = frames.find((x) => isCpuResponse(x));
          if (f) this.#host.emit({ type: 'cpu', percent: cpuPercentFromRaw(parseCpuRawLoad(f)) });
        }
        // Front-panel CHANNEL-change watch: a device-side amp/block A–D switch emits no unsolicited
        // frame and moves no param value (only the active-channel pointer), so the edit-burst diff
        // can't see it — the amp TYPE NAME is per-channel, so Axis showed the old channel's model.
        // Poll the tiny fn 0x13 status dump on the meter round-robin (offset 2) and emit `blockState`
        // on any block's active-channel delta → Axis re-reads only live scene/block state. First read
        // only primes the baseline (no event).
        if (this.#meterStep % cad.channelEveryNTicks === 2 && d.getActiveChannels) {
          const chans = await d.getActiveChannels();
          if (chans.size > 0) {
            let moved = false;
            if (this.#lastChannels) {
              for (const [eid, ch] of chans) {
                if (this.#lastChannels.get(eid) !== ch) { moved = true; break; }
              }
            }
            if (moved) this.#host.emit({ type: 'blockState' });
            this.#lastChannels = chans;
          }
        }
        // Front-panel SCENE-change watch: gen-3 devices emit NO unsolicited frame on a scene switch
        // (FM3 field report 2026-07-06 — the panel changed, Axis didn't follow), so poll the tiny
        // fn 0x0C scene GET on the CPU cadence, offset half a cycle so the two heavier reads never
        // share a tick. Emits the SAME `scene` event the setScene write path emits, so clients need
        // no new wiring. First read only primes the baseline (no event).
        if (this.#meterStep++ % cad.sceneEveryNTicks === 4 && d.getScene) {
          const { index } = await d.getScene();
          if (Number.isInteger(index) && index >= 0) {
            if (this.#lastSceneIdx !== null && index !== this.#lastSceneIdx) this.#host.emit({ type: 'scene', index });
            this.#lastSceneIdx = index;
          }
        }
      });
    } catch {
      /* transient — keep polling */
    }
    // reschedule at the mode's meter tick (or the slow-link cadence)
    if (this.#metersTimer) this.#metersTimer = setTimeout(() => this.#pollMeters(), slow ? cad.meterSlowMs : cad.meterTickMs);
  }

  // ── device-edit watch (poll): catch front-panel edits on devices that DON'T push them (AM4 + FM3) ──
  // AM4 and FM3 emit no unsolicited frame on a front-panel knob turn (AM4 HW-107; FM3 tap-confirmed
  // 2026-07-04), so — while ≥1 SSE client listens and such a device is active — we poll the driver's
  // readDeviceEditState(): AM4 uses a device-true edited-bit + fn-0x1F content fingerprint (→ {changed}
  // → we emit `changed{scope:'preset'}`); FM3 re-reads the open block via fn-0x1F and emits per-param
  // `param` events itself (→ {changed:false}). Both suppress the app's own writes. Slow-link throttled.
  // (FM9 / Axe-Fx III DO push → they use the RX listener path instead; see #startEditPush.)
  #editWatchTimer: ReturnType<typeof setTimeout> | null = null;
  #startEditWatch() {
    if (this.#editWatchTimer) return;
    const d = this.#host.activeDriver();
    if (d && !d.capabilities.deviceEditWatch) return; // active device doesn't need it
    this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), this.cadence().editWatchMs);
  }
  #stopEditWatch() {
    if (this.#editWatchTimer) clearTimeout(this.#editWatchTimer);
    this.#editWatchTimer = null;
  }
  async #pollEditWatch() {
    if (!this.#editWatchTimer) return;
    const d = this.#host.activeDriver();
    // Wait for a positively-identified driver before poking the unit — subscribe() can start the watch
    // before detect() runs (mirrors #pollMeters' unknown-device guard).
    if (!d) { this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), 1000); return; }
    if (!d.capabilities.deviceEditWatch || !d.readDeviceEditState) { this.#stopEditWatch(); return; }
    const cad = this.cadence();
    // YIELD (FORGEFX-28): skip this tick's poll (keep the cadence) while a route-driven request is in
    // flight, with the same MAX_SKIPS starvation guard as the meter loop.
    if (this.#inst.interactiveInFlight() > 0 && this.#editWatchSkips < TelemetrySupervisor.MAX_SKIPS) {
      this.#editWatchSkips++;
      if (this.#editWatchTimer) this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), cad.editWatchMs);
      return;
    }
    this.#editWatchSkips = 0;
    let slow = false;
    try {
      const dev = await this.#host.transport();
      slow = dev.slow; // a generic 5-pin DIN adapter can't carry the extra poll — back off (see #pollMeters)
      if (!slow) await this.#supervised(async () => {
        const r = await d.readDeviceEditState!();
        if (r.changed) this.#host.emit({ type: 'changed', scope: 'preset' });
      });
    } catch {
      /* transient — keep polling */
    }
    if (this.#editWatchTimer) this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), slow ? cad.editWatchSlowMs : cad.editWatchMs);
  }

  // ── gen-3 device-edit PUSH: reflect front-panel / editor edits the unit broadcasts unsolicited ──
  // Unlike the AM4 (which pushes nothing → we poll), gen-3 devices emit an unsolicited 0x74/0x75/0x76
  // state-broadcast burst on a front-panel param edit. We keep ONE persistent onFrame listener (the
  // transport dispatches every inbound frame to all handlers — additive, coexists with request()'s
  // temporary waiters) that reassembles an unsolicited burst and asks the driver to decode it into
  // per-param `param` events. ECHO GUARD: the ONLY server-issued source of a 0x74 burst is our own
  // fn-0x1F BULK-READ poll (blockParams / meters sweep / cab / monitors) — so if a fn-0x1F read is in
  // flight the burst is that reply (its request() waiter consumes it) and we skip it; otherwise it's a
  // genuine front-panel edit. Crucially this counts ONLY fn-0x1F reads: gen-3 also runs a 60ms OUTPUT-
  // meter poll (fn 0x19) + tempo/scene/writes, none of which elicit a 0x74 burst — gating on those would
  // wrongly drop a front-panel edit that lands during the meter poll (the bug that broke gen-3 sync).
  #editPushUnsub: (() => void) | null = null;
  #burst: number[][] | null = null;
  #burstTimer: ReturnType<typeof setTimeout> | null = null;

  #startEditPush() {
    if (this.#editPushUnsub) return;
    const t = this.#host.currentTransport();
    if (!t?.isOpen) return; // not connected yet — reconcile re-attaches once detection opens the transport
    const d = this.#host.activeDriver();
    if (d && !d.capabilities.deviceEditPush) return; // active device doesn't push
    this.#editPushUnsub = t.onFrame((frame) => this.#onInboundFrame(frame));
  }
  #stopEditPush() {
    this.#editPushUnsub?.();
    this.#editPushUnsub = null;
    this.#resetBurst();
  }
  #resetBurst() {
    this.#burst = null;
    if (this.#burstTimer) { clearTimeout(this.#burstTimer); this.#burstTimer = null; }
  }
  #armBurstTimer() {
    if (this.#burstTimer) clearTimeout(this.#burstTimer);
    this.#burstTimer = setTimeout(() => this.#finalizeBurst(), 120); // flush even if the 0x76 end was lost
  }
  #onInboundFrame(frame: number[]) {
    const d = this.#host.activeDriver();
    if (!d?.capabilities.deviceEditPush || !d.decodeEditBurst) return;
    // Reply to our own fn-0x1F bulk-read — the request()'s own handler owns it; skip (+ drop any partial).
    if (this.#inst.pendingBulkReads > 0) { this.#resetBurst(); return; }
    const fn = frame[5];
    if (fn === 0x74) { this.#burst = [frame]; this.#armBurstTimer(); return; } // burst head (new supersedes partial)
    if (!this.#burst) return; // stray body/end/other with no head we own
    if (fn === 0x75) { this.#burst.push(frame); this.#armBurstTimer(); return; } // body chunk
    if (fn === 0x76) { this.#burst.push(frame); this.#finalizeBurst(); return; } // end terminator
    this.#finalizeBurst(); // any other frame mid-burst → the burst ended, flush what we have
  }
  #finalizeBurst() {
    const frames = this.#burst;
    this.#resetBurst();
    const d = this.#host.activeDriver();
    if (!frames || frames.length === 0 || !d?.decodeEditBurst) return;
    let res: { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean };
    try { res = d.decodeEditBurst(frames); } catch { return; }
    if (res.reload) { this.#host.emit({ type: 'changed', scope: 'grid' }); return; } // first sight → full reload
    for (const e of res.events) this.#host.emit({ type: 'param', effectId: e.effectId, paramId: e.paramId, norm: e.norm });
  }

  // Consecutive skips per yielding loop — a starvation guard forces a poll after MAX_SKIPS so a busy
  // UI never fully starves the front-panel watches.
  static MAX_SKIPS = 3;
  #meterSkips = 0;
  #editWatchSkips = 0;

  // ── traffic emitter: ~1×/s while ≥1 SSE client is listening; only emits when a counter moved ──
  #trafficTimer: ReturnType<typeof setInterval> | null = null;
  #lastTrafficEmit = { txMsgs: 0, txBytes: 0, rxMsgs: 0, rxBytes: 0 };
  #startTraffic() {
    if (this.#trafficTimer) return;
    this.#trafficTimer = setInterval(() => this.#emitTraffic(), 1000);
  }
  #stopTraffic() {
    if (this.#trafficTimer) clearInterval(this.#trafficTimer);
    this.#trafficTimer = null;
  }
  #emitTraffic() {
    const t = this.#inst.traffic;
    const p = this.#lastTrafficEmit;
    if (t.txMsgs === p.txMsgs && t.txBytes === p.txBytes && t.rxMsgs === p.rxMsgs && t.rxBytes === p.rxBytes) return; // no change → stay quiet
    this.#lastTrafficEmit = { ...t };
    this.#host.emit({ type: 'traffic', ...t, since: this.#inst.since, loops: this.activeLoops() });
  }
}
