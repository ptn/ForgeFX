// AM4 device driver (model 0x15) — a parallel driver to the gen-3 one. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the registry owns (ctx.transport()), since only one device is ever connected at a time.
// Codec is forgefx-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
  BLOCK_SLOT_PID_LOW,
  resolveBlockTypeValue,
  buildSetParam,
  buildSetParamNorm,
  buildSetFloatParam,
  buildSetBlockType,
  buildSetBlockBypass,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchScene,
  buildSwitchPreset,
  buildGetPresetName,
  parseGetPresetNameResponse,
  // Tuner readout (block 0x0023) — live-poll reads decoded upstream (BigCapture 2026-07-05).
  // (buildReadParam already imported above for the atomic structure read.)
  buildReadActiveChannel,
  parseActiveChannelResponse,
  READ_TYPE_LIVE_POLL,
  parseReadResponse,
  isPollResponse,
  AM4_TUNER_PID_LOW,
  AM4_TUNER_CHANNEL,
  decodeAm4Tuner,
  isCommandAck,
  buildSaveToLocation,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  parseAm4PresetDump,
  am4DumpLocation,
  decodeAm4PresetNameFromFrame,
  parseAm4Firmware,
  formatLocationCode,
  AM4_MOD_EFFECT_ORDINAL,
  AM4_MOD_SLOT_COUNT,
  AM4_MOD_FIELDS,
  AM4_MODIFIER_SOURCES,
  AM4_MOD_OPERATIONS,
  AM4_MOD_CHANNELS,
  // param catalog — the reader returns DECODED display values keyed by param name; we join it
  // against KNOWN_PARAMS here to recover the unit / range / enum-option / norm metadata the DTO carries.
  KNOWN_PARAMS,
  TOTAL_LOCATIONS,
  type Param,
  type ParamKey
} from 'forgefx-midi/am4';
// The VERIFIED high-level descriptor reader (hardware-confirmed upstream). We drive it over the shared
// descriptorConn adapter, which wraps ForgeFX's Transport as the MidiConnection the reader expects.
import { AM4_DESCRIPTOR, readActiveBufferEditedBit, readAllParams } from 'forgefx-midi/devices/am4';
import type { PresetSnapshot } from 'forgefx-midi/core';
import type { Transport } from '../transport/types.js';
import type { DeviceDriver, DriverCapabilities, DriverCtx, PresetGridDTO, PresetBlockDTO, NamedParam, EnumParam, Am4Slot, OfflinePresetBank } from './types.js';
import { am4LayoutFor, type TypeModel, type DeviceLayout } from '../devices.js';
import { TransportConn } from './descriptorConn.js';
import { ReaderCache } from './shared/readerCache.js';
import { midiNoteName } from './shared/notes.js';
import { slotParamValues } from './shared/params.js';
import {
  ATOMIC_READ_TYPE, STRUCT_BYTES, isStructResponse, unpackMsb, parseAm4Structure, am4StructDebugLines, splitSysex, am4DecodeEnrichment,
} from './am4/support.js';
import {
  am4BankFromBytes, am4BlocksCatalog, am4BlockTypes, am4Grid, am4JoinBlockParams, am4PlacedBlocks,
} from './am4/views.js';

// Re-exported from the split-out support module so the public `drivers/am4.js` path keeps them.
export { am4NoneSelector, am4DecodeEnrichment } from './am4/support.js';

class Am4Driver implements DeviceDriver {
  readonly modelId = 0x15;
  readonly key = 'am4';
  readonly name = 'AM4';
  readonly capabilities: DriverCapabilities = {
    slotModel: 'linear',
    slotCount: 4,
    gridEdit: true, // slot block-type write (buildSetBlockType): place/change/clear a block in slots 1..4
    scenes: 4,
    channels: true, // 2026-07-08: every block has an independent A/B/C/D channel register (see setChannel)
    presetDump: false, // AM4 backups run their own verbatim dump path (/am4/preset/backup), not the gen-3 one
    presetConvert: true, // partial lift (name + scenes + amp block per-channel params) via the AM4 dump decode
    telemetry: { tuner: true, outputMeters: false, cpu: false }, // tuner via block-0x0023 live-poll (readTuner); no gen-3 meter/CPU frames
    fcModel: false,
    fcLiveRead: false,
    modBind: false, // modifier model is data-only (see modifierModel); the wire binding is not captured
    cabIrs: false,
    editorLayouts: true, // AM4 ships AM4_LAYOUTS (served via am4LayoutFor in blockParams)
    supportsSave: true,
    selfDescribe: false, // the AM4 has its own (non-gen-3) codec; the gen-3 self-describe walk does not apply
    cacheImport: true, // byte-source import via AM4_CACHE_PARAMS/AM4_SEEDS (codec >= 0.3.20); no live walk
    fullCapture: false, // the AM4 has no gen-3 self-describe walk → no write-sweep full capture
    deviceEditWatch: true // AM4 pushes NOTHING on front-panel / AM4-Edit edits (HW-107) → registry polls readDeviceEditState()
  };

  #ctx: DriverCtx;
  constructor(ctx: DriverCtx) { this.#ctx = ctx; }

  /** The ONE shared transport (single exclusive MIDI/serial connection, owned by the registry). */
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  #emptySlots = (): Am4Slot[] => [1, 2, 3, 4].map((n) => ({ slot: n, blockType: 'none', pidLow: 0 }));

  // ── VERIFIED-reader plumbing (shared ReaderCache: reader lock + TTL preset cache) ─────────────
  // The AM4 differences from gen-2/VP4 are the cadence-derived TTL (see #cacheTtlMs) and the structure
  // + active-channel refresh a fresh preset dump triggers (onLoaded).
  #readerCache = new ReaderCache({
    descriptor: AM4_DESCRIPTOR,
    openTransport: () => this.#openTransport(),
    ttlMs: () => this.#cacheTtlMs(),
    clock: () => this.#now(),
    getPresetOptions: { include_channel_state: true },
    log: (s) => this.#log(s),
    onLoaded: async (snap) => {
      // Resolve the REAL active channel per placed block from the device (0x07DD) so placedBlocks /
      // blockParams slice the channel the UNIT is actually on — not the channel-A fallback. The
      // structure read (TTL-cached; clears #activeChannel on a preset/scene change) gives the pidLows.
      const placed = (await this.#readStructure())?.slots.filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none').map((sl) => sl.pidLow) ?? [];
      await this.#refreshActiveChannels(placed);
      this.#log(`readPreset: ${snap.slots.length} placed block(s), scene ${snap.active_scene ?? '?'} (${snap._meta.read_duration_ms ?? '?'}ms)`);
    },
  });
  // Cache TTLs are DERIVED from the active cadence (0.8×editWatchMs, clamped ≥500) rather than a fixed
  // 500 ms — so one edit-watch tick never does a redundant double struct read, and a /telemetry/config
  // mode switch keeps every cache coherent (getCadence resolves at call time against the active model
  // byte). editWatchMs is 1500/2000/4000 (perf/balanced/reduced) ⇒ TTL 1200/1600/3200, always < the
  // tick so each tick still re-reads once, but the two reads WITHIN a tick coalesce.
  #cacheTtlMs(): number { return Math.max(500, Math.round(0.8 * this.#ctx.getCadence().editWatchMs)); }
  // Injectable clock (test seam): the cache TTLs + the edit-watch rehash budget read it, so the
  // time-gated dump decisions can be driven deterministically. Defaults to Date.now in production.
  #now: () => number = () => Date.now();
  /** TEST-ONLY (FORGEFX-25 edit-watch tests): inject the clock the cache TTLs + rehash budget read. */
  __setClockForTest(fn: () => number): void { this.#now = fn; }
  // Active-channel tracking (eid/pidLow → channel idx 0..3). Two sources keep it current:
  //   1) DEVICE read — #refreshActiveChannels reads the real active channel from register 0x07DD (byte
  //      50; decoded FORGEFXMID-16/18 from Channels.pcapng). The channel-SELECT register 0x07D2 is
  //      write-only for switching and reads back cached firmware state, so 0x07DD is the reliable source.
  //      readPreset and the edit-watch call it, so front-panel / AM4-Edit channel switches now reflect.
  //   2) OPTIMISTIC — setChannel() records the target index immediately for instant UI feedback; the next
  //      device read confirms/corrects it. Both feed the slice in #slotParamValues / placedBlocks so the
  //      active channel's params (e.g. reverb type) surface instead of the channel-A fallback.
  // Cleared when the preset/scene context changes (see #readStructure), then repopulated from the device.
  #activeChannel = new Map<number, number>(); // eid (pidLow) → channel idx 0..3
  #ctxSig: string | null = null;
  static #CHAN_LETTERS = ['A', 'B', 'C', 'D'] as const;

  /** ONE atomic getPreset dump of the active buffer via the VERIFIED reader, cached briefly (TTL) so a
   *  grid + block-param page load reuses a single read. Serialized behind the shared reader lock. */
  readPreset(): Promise<PresetSnapshot | null> { return this.#readerCache.readPreset(); }

  // Brief TTL cache of the last structure read: one page load fans out into /preset/grid +
  // /preset/blocks (+ presetRef polls), each of which needs the same fn-0x1F structure — the beta
  // log showed every load doing back-to-back identical struct reads. Invalidated on writes.
  #structCache: { s: { slots: Am4Slot[]; name: string; scene: number; location: number }; at: number } | null = null;
  // (struct TTL is the shared cadence-derived #cacheTtlMs — see the note on the ReaderCache ttlMs.)

  /** One atomic fn-0x1F read of the preset structure → the 4 slots' block types + preset name +
   *  scene + current stored location. TTL-cached (see #structCache). */
  async #readStructure(): Promise<{ slots: Am4Slot[]; name: string; scene: number; location: number } | null> {
    if (this.#structCache && this.#now() - this.#structCache.at < this.#cacheTtlMs()) return this.#structCache.s;
    const dev = await this.#openTransport();
    const read = buildReadParam({ pidLow: BLOCK_SLOT_PID_LOW, pidHigh: 0x0000 }, ATOMIC_READ_TYPE);
    try {
      const frames = await dev.request(read, { timeoutMs: 1500, quietMs: 80, match: (fs) => fs.some(isStructResponse) });
      const f = frames.find(isStructResponse);
      if (!f) return null;
      const b = unpackMsb(f.slice(16, f.length - 2), STRUCT_BYTES); // 16-byte header … <septets> cksum F7
      if (process.env.AM4_DEBUG !== '0') {
        // DEBUG: dump the unpacked structure + auto-locate block-type codes at every offset, so we can
        // confirm/fix the slot offset against a real preset. Remove once the slot layout is pinned.
        for (const line of am4StructDebugLines(b)) this.#log(line);
      }
      const s = parseAm4Structure(b);
      // Drop optimistic channel tracking when the preset/scene context changes — a switch remaps every
      // block's active channel on the device, and we have no way to read the new mapping (0x07d2 is
      // unreadable), so falling back to channel A is the safe default until the user re-selects.
      const sig = `${s.location}:${s.scene}`;
      if (sig !== this.#ctxSig) { this.#ctxSig = sig; this.#activeChannel.clear(); }
      this.#structCache = { s, at: this.#now() };
      return s;
    } catch {
      return null;
    }
  }

  /** Drop both TTL caches after any device write — the next read must reflect the change. */
  #invalidate() {
    this.#readerCache.invalidate();
    this.#structCache = null;
    // Our own write also flips the device's "edited" bit + moves param values, so tell the device-edit
    // watcher to silently re-seed its baseline next tick instead of misreading it as a front-panel edit.
    this.#selfEditPending = true;
  }

  // ── Device-edit watch: catch front-panel / AM4-Edit edits the unit does NOT push (HW-107) ─────────
  // The registry supervisor polls readDeviceEditState() (capability deviceEditWatch) while an SSE client
  // is listening. TRANSITION-GATED (FORGEFX-25 — fixes the audio dropouts a user hit): the old detector
  // ran a full fn-0x1F GET_ALL_PARAMS dump of EVERY placed block on EVERY tick while the edited bit was
  // latched (~3.3 KB/s sustained), and serializing those multi-frame dumps audibly glitched the AM4's
  // audio path. AM4-Edit at idle only polls the small 0x7DD register — it never dumps. So we now split
  // the tick into a CHEAP steady-state path and a GATED heavy path:
  //
  //   Every tick (cheap, always): readActiveBufferEditedBit (one GET_PATCH read — we NEVER hash that
  //     frame: bytes 29/30/31/236 free-run) + the struct read (scene/location) + #refreshActiveChannels
  //     (0x7DD per placed block). ZERO fn-0x1F dumps here.
  //   fn-0x1F hash dumps (#hashPlacedParams) ONLY when:
  //     • edited bit false→true (and not self-edit): emit `changed` IMMEDIATELY (before the slow hash),
  //       then hash once to seed the successive-edit baseline (skipped when rehashing is disabled).
  //     • bit stays latched: re-hash at most every ctx.getCadence().editRehashMs — but this is now 0
  //       (DISABLED) in EVERY mode (FORGEFX-25 follow-up: the periodic latched re-dump glitched AM4 audio
  //       after a channel swap). With rehashMs=0 this branch never runs; on-device edits reflect on
  //       save/scene/channel only. Kept parameterised so a future view-gated rehash can re-enable it.
  //     • edited bit true→false (device-side save): emit `changed` (name/location may have changed) and
  //       reset the hash baseline cheaply — no dump.
  //   #selfEditPending (our own write dirtied the buffer): silent re-seed, no `changed`; the seed hash
  //     follows the rehash budget (only seeds when rehashing is enabled) so the baseline stays consistent
  //     and the NEXT front-panel edit is still detected.
  //
  // #lastHashAt is the wall-clock (via #now) of the last dump so the rehash budget is enforceable. All
  // `changed` reloads still funnel to Axis exactly as before — the false→true case emits directly (for
  // latency) and returns changed:false to avoid a double emit; channel/save/rehash ride the return value
  // (the registry emits `changed{scope:'preset'}` on true), and scene rides its own `scene` event.
  //
  // ASSUMPTION (implement-now, verify-after — needs a hardware capture): two zero-edit fn-0x1F reads
  // return byte-identical value arrays (the fn-0x1F payload is stable). A false positive only costs a
  // redundant reload; it never misses a real edit.
  #deviceEditBaseline: { edited: boolean; hash: string; scene: number; channels: string } | null = null;
  #selfEditPending = false;
  #lastHashAt = 0; // #now() of the last #hashPlacedParams dump — gates the rehash budget

  /** One device-edit watch tick. Returns `{changed:true}` when a DEVICE-originated (front-panel /
   *  AM4-Edit) edit needs the registry to emit a reload; the latency-sensitive false→true case emits
   *  `changed` itself and returns false. Silent right after our own writes and on read failure (never
   *  churns the UI on a transient timeout). Transition-gated — see the block comment above. Serialized
   *  behind the shared reader lock. */
  async readDeviceEditState(): Promise<{ changed: boolean }> {
    return this.#readerCache.withReader(async () => {
      const dev = await this.#readerCache.transport();
      const conn = new TransportConn(dev);
      let edited: boolean;
      try {
        edited = await readActiveBufferEditedBit(conn);
      } catch {
        return { changed: false }; // device busy / timeout — keep the last baseline, don't reload
      }
      // ── CHEAP, EVERY TICK ── struct (scene/location) + per-block active channel (0x7DD). No fn-0x1F
      // dumps here: the heavy #hashPlacedParams runs ONLY on the gated transitions below.
      const struct = await this.#readStructure();
      const scene = struct?.scene ?? 0;
      const placed = (struct?.slots ?? []).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none').map((sl) => sl.pidLow);
      const channels = await this.#refreshActiveChannels(placed);

      const rehashMs = this.#ctx.getCadence().editRehashMs; // 0 (reduced) = never dump on the latched path
      const base = this.#deviceEditBaseline;

      // First run, or our own write just dirtied the buffer → adopt as baseline and emit nothing. Seed a
      // hash ONLY when the buffer is dirty AND rehashing is enabled — otherwise there is nothing to
      // compare against later, so the dump would be wasted. After a self-edit this keeps the baseline
      // consistent so the NEXT front-panel edit is still detected (correctness first).
      if (base === null || this.#selfEditPending) {
        this.#selfEditPending = false;
        let hash = '';
        if (edited && rehashMs > 0) { hash = await this.#hashPlacedParams(conn); this.#lastHashAt = this.#now(); }
        this.#deviceEditBaseline = { edited, hash, scene, channels };
        return { changed: false };
      }

      // Front-panel scene change (footswitch): emit a `scene` event (same shape gen-3 emits) so Axis
      // moves the badge AND reloads the per-scene grid/params. Separate from the edit `changed` signal,
      // and cheap — struct-derived, no dump.
      if (scene !== base.scene) this.#ctx.emit({ type: 'scene', index: scene });

      let emittedChanged = false;                    // true once we've emitted `changed` directly this tick
      let wantChanged = channels !== base.channels;  // a front-panel channel switch is device-originated
      let hash = base.hash;

      if (edited && !base.edited) {
        // false→true: emit `changed` IMMEDIATELY (before the slow hash) so the reload is not gated on the
        // dump, THEN hash once to seed the successive-edit baseline (only when rehashing is enabled).
        this.#ctx.emit({ type: 'changed', scope: 'preset' });
        emittedChanged = true;
        if (rehashMs > 0) { hash = await this.#hashPlacedParams(conn); this.#lastHashAt = this.#now(); }
        else hash = '';
      } else if (!edited && base.edited) {
        // true→false (device-side save): name/location may have changed → reload; reset the hash baseline
        // cheaply (nothing dirty to fingerprint — no dump).
        hash = '';
        wantChanged = true;
      } else if (edited && base.edited && rehashMs > 0 && this.#now() - this.#lastHashAt >= rehashMs) {
        // Bit stays latched and the rehash budget elapsed: re-fingerprint the placed blocks. A diff means
        // the front panel moved a param while already dirty → reload + adopt the new baseline.
        const fresh = await this.#hashPlacedParams(conn);
        this.#lastHashAt = this.#now();
        if (fresh !== base.hash) { hash = fresh; wantChanged = true; }
      }

      this.#deviceEditBaseline = { edited, hash, scene, channels };
      // A `changed` already emitted directly (false→true) is NOT re-signalled via the return value —
      // that would double-fire the registry's emit.
      return { changed: wantChanged && !emittedChanged };
    });
  }

  /** Fingerprint the placed blocks' current param values via fn-0x1F (channel-A quarter only — stable
   *  and small; B/C/D would add churn). Plain string join, not a digest — the arrays are short. Runs
   *  inside the reader lock (the caller already holds the lock). */
  async #hashPlacedParams(conn: TransportConn): Promise<string> {
    const s = await this.#readStructure(); // TTL-cached; the poll cadence keeps it warm
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

  /** Read each placed block's REAL active channel from the device (0x07DD long read, byte 50 —
   *  decoded in FORGEFXMID-16/18 from Channels.pcapng) and update #activeChannel to the device truth.
   *  Unlike the 0x07D2 SELECT register (write-only for switching; reads back cached firmware state),
   *  0x07DD reads back a clean 0..3 index, so this reflects channel switches made on the UNIT / in
   *  AM4-Edit — not just the ones AXIS made. Returns a stable signature (`pidLow:idx|…`) the edit-watch
   *  uses to detect a front-panel channel switch. Best-effort per block: a read miss leaves that block's
   *  tracked value (or the channel-A fallback) untouched. Callers already hold the reader lock. */
  async #refreshActiveChannels(placedPidLows: number[]): Promise<string> {
    if (!placedPidLows.length) return '';
    const dev = await this.#openTransport();
    const isFor = (f: number[], pidLow: number) => f[6] === (pidLow & 0x7f) && f[7] === ((pidLow >> 7) & 0x7f);
    const parts: string[] = [];
    for (const pidLow of placedPidLows) {
      try {
        const req = buildReadActiveChannel(pidLow);
        const frames = await dev.request(req, {
          timeoutMs: dev.slow ? 1200 : 800,
          quietMs: dev.slow ? 100 : 50,
          match: (fs) => fs.some((f) => isFor(f, pidLow) && parseActiveChannelResponse(f) !== null),
        });
        const idx = frames
          .filter((f) => isFor(f, pidLow))
          .map((f) => parseActiveChannelResponse(f))
          .find((v) => v !== null);
        if (idx != null) {
          this.#activeChannel.set(pidLow, idx);
          parts.push(`${pidLow}:${idx}`);
        }
      } catch {
        // block unreadable this tick — keep the tracked/fallback channel, don't churn
      }
    }
    return parts.join('|');
  }

  /** Live current-preset query (unified GET /preset; capability presets.liveQuery) — feeds the
   *  Axis top-bar preset display. Number is the stored location decoded from the structure's
   *  int32 @0x00 (see STRUCT_LOCATION_OFFSET); -1 when the structure read fails (Axis ignores
   *  refs with a negative number). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const s = await this.#readStructure();
    return { number: s?.location ?? -1, name: s?.name ?? '' };
  }

  /** The 4 slots as a PresetGridDTO (1 row × 4, linear chain) so Axis renders the AM4 on the existing
   *  Signal Grid — no separate view needed to get it on screen + testable.
   *
   *  EMPTY slots are OMITTED (no cell), matching gen-3 semantics. They were previously emitted as
   *  shunt cells to draw the pass-through chain, but a gen-3 shunt is a REMOVABLE routing cell —
   *  Axis tapped them into clearCell writes, reported every drop target as occupied, and never
   *  rendered the empty-cell "add a block" button (the whole add/drag/drop path was dead on AM4). */
  async grid(): Promise<PresetGridDTO> {
    const s = await this.#readStructure();
    const slots = s?.slots ?? this.#emptySlots();
    this.#log(`grid: "${s?.name ?? ''}" — ${slots.map((x) => x.blockType).join(', ')}`);
    return am4Grid(slots, s?.name ?? '');
  }

  /** Placed blocks in the unified PresetBlockDTO shape (GET /preset/blocks): the 4-slot chain as
   *  row 1 / col 1..4, fromRows [] (linear — the grid DTO carries the chain). Bypass + channel state
   *  ride the TTL-cached atomic reader dump (the same read blockParams uses); null when that read is
   *  unavailable. Channel comes from the dump's `params_by_channel` key — the reader defaults to
   *  reading only the currently-active channel (see getPreset's `include_channel_state`), so there's
   *  exactly one key to report; 'unknown' channel_status (selector read failed) still surfaces its
   *  best-effort fallback key rather than null, consistent with blockParams(). */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const s = await this.#readStructure();
    const slots = (s?.slots ?? this.#emptySlots()).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none');
    const snap = slots.length ? await this.readPreset() : null;
    return am4PlacedBlocks(slots, snap, this.#activeChannel, Am4Driver.#CHAN_LETTERS);
  }

  /** Read every parameter of the block sitting at `pidLow` (its block-type value, e.g. 58=amp, 118=drive
   *  — the `effectId` the grid/slots report) and return it in the SAME shape as the gen-3 blockParams
   *  so Axis renders the AM4's params through the existing block editor unchanged.
   *
   *  Read path: the VERIFIED descriptor reader's getPreset() atomic dump (see readPreset), cached for the
   *  page load. We pull the slot whose block_type maps to this pidLow and translate its params. getPreset
   *  returns DECODED DISPLAY values keyed by param name (flat `params` for non-channel blocks, or the
   *  active-channel dict inside `params_by_channel` for channel-bearing blocks); we join each against its
   *  KNOWN_PARAMS entry to recover unit / range / enum-option metadata + reconstruct `value`/`norm`.
   *
   *  Mapping (reader field → DTO field):
   *    slot params[name] (display) → NamedParam.value / EnumParam.value (via enum-label→ordinal lookup)
   *    KNOWN_PARAMS[key].unit      → NamedParam.unit (AM4_UNIT_LABEL) / enum split
   *    KNOWN_PARAMS[key].display{Min,Max} → NamedParam.{min,max} + norm (position of value in [min,max])
   *    KNOWN_PARAMS[key].scaling === 'log10' → NamedParam.log (+ log-curve norm inverse)
   *    slot.bypassed              → the leading 'Bypass' EnumParam
   *  `named` carries the continuous knobs, `enums` the discrete selectors, and the block's own `type`
   *  selector is surfaced separately — exactly as gen-3 splits them, so Axis renders both the same way. */
  async blockParams(pidLow: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    // instance-aware: pidLow may be an instance code (base+N, e.g. drive #2 = 0x77) — the catalog
    // is keyed by the BASE pidLow, the wire address stays the instance code (see encId/setParam)
    const resolved = resolveBlockTypeValue(pidLow);
    const blockName = resolved?.name;
    if (!blockName || blockName === 'none') {
      this.#log(`blockParams: unknown pidLow ${pidLow}`);
      return { block: blockName ?? `0x${pidLow.toString(16)}`, slug: blockName ?? '', page: -1, named: [], enums: [], type: null };
    }
    const basePidLow = resolved.base;
    const snap = await this.readPreset();
    // Find the placed slot for THIS pidLow, then its DECODED param dict (flat, or the one
    // active-channel dict for channel-bearing blocks — getPreset nests exactly one channel per slot).
    // Match by POSITION via the structure (a preset can hold two instances of the same block type);
    // fall back to the name match when the structure read is unavailable.
    const chainSlot = (await this.#readStructure())?.slots.find((sl) => sl.pidLow === pidLow)?.slot;
    const slot = (chainSlot !== undefined ? snap?.slots.find((s) => s.slot === chainSlot) : undefined)
      ?? snap?.slots.find((s) => s.block_type === blockName);
    const decoded = slotParamValues(slot, this.#activeChannel.get(pidLow), Am4Driver.#CHAN_LETTERS);
    const { named, enums, type } = am4JoinBlockParams(blockName, basePidLow, decoded, slot?.bypassed);
    // Editor-authentic layout (v2), resolved to the variant for this block's current type value. AM4
    // controls join to the catalog by cacheId in the codec; unresolved paramIds ride through as null
    // (display-only). Same wire shape as the gen-3 driver so Axis renders both through one path.
    const layout = am4LayoutFor(blockName, type?.value);
    this.#log(`blockParams ${blockName} (pidLow ${pidLow}): ${named.length} knobs, ${enums.length} enums${type ? ` type=${type.name}` : ''}`);
    return { block: blockName, slug: blockName, page: -1, named, enums, type, layout };
  }

  /** One READ_PRESET_NAME (action 0x0012) round-trip for a location — non-destructive (does not load the
   *  preset). Returns the decoded name + whether the slot is empty, or null if no name frame came back. */
  async #readPresetName(dev: Transport, location: number): Promise<{ name: string; isEmpty: boolean } | null> {
    const req = buildGetPresetName(location);
    const frames = await dev.request(req, { timeoutMs: dev.slow ? 1200 : 600, quietMs: dev.slow ? 120 : 60, match: (fs) => fs.length > 0 });
    for (const f of frames) {
      try {
        const r = parseGetPresetNameResponse(f, location);
        return { name: r.isEmpty ? '' : r.name.trim(), isEmpty: r.isEmpty };
      } catch {
        /* not the name frame */
      }
    }
    return null;
  }

  /** Stored preset name at a location (0..103). */
  async presetName(location: number): Promise<{ location: number; name: string }> {
    const dev = await this.#openTransport();
    const r = await this.#readPresetName(dev, location);
    return { location, name: r?.name ?? '' };
  }

  /** Scan the AM4 preset library — every stored location (0..103, A01..Z04) by name, via the VERIFIED
   *  reader's scanLocations (one non-destructive READ_PRESET_NAME per slot, ~104 serial round-trips).
   *  Serialized behind the shared reader lock. `scanned[i]` is location index i (the scan starts at 0), so we map by
   *  offset; if the reader bailed early (`failed_at`) the remaining locations are reported empty. `signal`
   *  can veto the scan before it starts — scanLocations reads the whole range atomically, so it cannot
   *  interrupt mid-scan (an already-aborted signal returns an all-empty list without touching the wire). */
  async scanPresets(signal?: AbortSignal): Promise<{ count: number; presets: { location: number; code: string; name: string; isEmpty: boolean }[] }> {
    const presets: { location: number; code: string; name: string; isEmpty: boolean }[] = [];
    if (signal?.aborted) {
      for (let location = 0; location < TOTAL_LOCATIONS; location++) presets.push({ location, code: formatLocationCode(location), name: '', isEmpty: true });
      return { count: presets.length, presets };
    }
    const result = await this.#readerCache.withReader(async () => {
      await this.#readerCache.transport();
      return this.#readerCache.reader.scanLocations!(this.#readerCache.dispatchCtx(), 0, TOTAL_LOCATIONS - 1);
    }).catch(() => ({ scanned: [] as { location: string; name: string; is_empty: boolean }[] }));
    // scanned[] is in location order from 0; index === location. Fill any tail the reader didn't reach.
    for (let location = 0; location < TOTAL_LOCATIONS; location++) {
      const s = result.scanned[location];
      presets.push({ location, code: formatLocationCode(location), name: s ? s.name.trim() : '', isEmpty: s ? s.is_empty : true });
    }
    this.#log(`scanPresets: read ${result.scanned.length}/${TOTAL_LOCATIONS} (${presets.filter((p) => !p.isEmpty).length} named)`);
    return { count: presets.length, presets };
  }

  /** Set a parameter by its display value (e.g. 'amp.gain', 7.5). (Named apart from the generic
   *  driver setParam(eid,pid,…) — the AM4 addresses by catalog key here, not by wire address.) */
  async setParamByKey(key: string, displayValue: number) {
    const dev = await this.#openTransport();
    const frame = buildSetParam(key as ParamKey, displayValue);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 60, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Write a continuous param by wire ADDRESS (the block editor's effectId=pidLow + paramId=pidHigh),
   *  normalized 0..1 (action SET_NORM — hardware-verified). Invalidates the preset cache so the next read
   *  reflects the change. */
  async setParamNorm(pidLow: number, pidHigh: number, norm: number) {
    const dev = await this.#openTransport();
    const n = Math.max(0, Math.min(1, norm));
    const frame = buildSetParamNorm({ pidLow, pidHigh }, n);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Write a discrete/enum param by wire ADDRESS to a raw internal value (the enum ordinal). */
  async setParamValue(pidLow: number, pidHigh: number, value: number) {
    const dev = await this.#openTransport();
    const frame = buildSetFloatParam({ pidLow, pidHigh }, value);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Generic driver write (unified PUT /preset/blocks/:addr/params/:paramId): addr = pidLow,
   *  paramId = pidHigh. continuous:true → SET_NORM with `value` as the 0..1 norm; continuous:false →
   *  discrete/enum ordinal write. Thin dispatch over the hardware-verified wire methods.
   *  `paramId` may be a composite address minted by blockParams() for a foreign sub-block (e.g. the
   *  amp page's integrated cab): any value > 0xffff carries its own pidLow in the high bits, which wins
   *  over `addr` so the write lands on the right sub-block. Bare pidHighs (≤ 0x7d2) keep using `addr`. */
  async setParam(pidLow: number, pidHigh: number, value: number, continuous: boolean) {
    if (pidHigh > 0xffff) { pidLow = pidHigh >>> 16; pidHigh &= 0xffff; }
    return continuous ? this.setParamNorm(pidLow, pidHigh, value) : this.setParamValue(pidLow, pidHigh, value);
  }

  /** Toggle/set a block's bypass by its pidLow. */
  async setBypass(blockPidLow: number, bypassed: boolean) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetBlockBypass(blockPidLow, bypassed));
    this.#invalidate();
    return { ok: true };
  }

  /** Switch a placed block's active channel (A/B/C/D) — POST /preset/blocks/:eid/channel, mirrors
   *  gen-3's setChannel. Unlike gen-3 (dedicated wire frame + fn-0x13 status read), AM4's channel is
   *  an ordinary enum SET_PARAM at `<block>.channel` (pidHigh=0x07d2, hardware-confirmed on
   *  amp/drive/reverb/delay, pattern-extended to every block — see forgefx-midi's params.ts), so this
   *  is a thin wrapper over the existing generic key-write path. */
  async setChannel(eid: number, channel: string) {
    const blockName = resolveBlockTypeValue(eid)?.name;
    if (!blockName || blockName === 'none') return { ok: false };
    const idx = ['A', 'B', 'C', 'D'].indexOf(channel.toUpperCase());
    if (idx < 0) return { ok: false };
    const res = await this.setParamByKey(`${blockName}.channel`, idx);
    // Remember the channel we just selected — the device won't read it back (0x07d2 is unreadable), so
    // this is the only way subsequent reads reflect the switch (keyed by the eid the caller addresses,
    // so two instances of a block type track independently). #invalidate() drops the dump caches but
    // NOT this map; #readStructure clears it on a preset/scene context change.
    this.#activeChannel.set(eid, idx);
    this.#invalidate();
    this.#ctx.emit({ type: 'blockState', effectId: eid });
    return res;
  }

  /** Rename the current preset (POST /preset/name; capability presets.canRename). AM4's rename command
   *  (`buildSetPresetName`, capture-verified) targets a STORED location, so we rename the location the
   *  edit buffer was loaded from (struct int32 @0x00). This persists immediately — no separate store is
   *  needed, unlike gen-3's edit-buffer rename. Returns {ok:false} (not 501) when the location can't be
   *  read or is out of range. Enables the top-bar rename button + the library rename-and-save flow. */
  async setPresetName(name: string): Promise<{ ok: boolean }> {
    const loc = (await this.#readStructure())?.location ?? -1;
    if (!Number.isInteger(loc) || loc < 0 || loc > 103) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32); // printable ASCII, ≤32 (codec throws otherwise)
    const dev = await this.#openTransport();
    const frame = buildSetPresetName(loc, clean);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'preset' });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Rename a scene (POST /scene/name; capability sceneNamesWritable). `index` is 0-based (UI passes
   *  scene-1). AM4's `buildSetSceneName` (capture-verified) writes to the WORKING BUFFER only — the name
   *  shows live but persists to the preset only on the next store (same as gen-3). */
  async setSceneName(index: number, name: string): Promise<{ ok: boolean }> {
    if (!Number.isInteger(index) || index < 0 || index > 3) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    const dev = await this.#openTransport();
    const frame = buildSetSceneName(index, clean);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'preset' });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Change a placed block's model/type (POST /preset/blocks/:eid/type). AM4 addresses blocks by pidLow
   *  (= the eid the grid reports); the model selector is the block's `type` enum param, written by its
   *  wire ordinal (the same discrete-SET path plain enums use). Mirrors gen-3's setType so the type
   *  picker's selection actually applies — without it the route answered 501 and retype was rejected. */
  async setType(pidLow: number, value: number): Promise<{ ok: boolean }> {
    const blockName = resolveBlockTypeValue(pidLow)?.name;
    const typeParam = blockName
      ? (Object.values(KNOWN_PARAMS) as Param[]).find((p) => p.block === blockName && p.name === 'type')
      : undefined;
    if (!typeParam) return { ok: false };
    const res = await this.setParamValue(pidLow, typeParam.pidHigh, value);
    this.#ctx.emit({ type: 'changed', scope: 'grid' });
    return res;
  }

  /** Placeable-block catalog (GET /blocks) — powers the "add a block" palette. The AM4 roster is fixed
   *  (one instance per type; see BLOCK_TYPE_VALUES). `page` is the block's own type code, which the palette
   *  hands straight back to placeCell → buildSetBlockType. Without this the palette is empty and "add FX"
   *  silently does nothing. `paramCount`/`typeCount` are derived from KNOWN_PARAMS for a richer palette row. */
  blocksCatalog(): { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[] {
    return am4BlocksCatalog();
  }

  /** Block "type" roster (GET /blocks/:slug/types) — the amp/drive/delay/… model list the type picker
   *  shows. AM4 stores it as the block's `type` enum param (surfaced separately from plain enums in
   *  blockParams); without this the route answered 501 and the picker rendered empty, so "select type of
   *  block" silently did nothing. Mirrors gen-3's rosterFor DTO — manufacturer/basedOn are gen-3-only
   *  catalog fields the AM4 tables don't carry, hence null. Returns [] for a slug with no type selector. */
  blockTypes(slug: string): TypeModel[] {
    return am4BlockTypes(slug);
  }

  /** Grid edit (unified PUT /preset/grid/cell) on the AM4's 1×4 linear chain: place/change the block in a
   *  slot, or clear it (blockId 0 — the UI's clearCell). `col` is the 1-indexed slot (1..4, from Axis'
   *  wire conversion); `row` is always 1 on a linear device and is ignored. `blockId` is the target block's
   *  own type code (the effectId the grid/slots report), matching buildSetBlockType's blockTypeValue. */
  async placeCell(row: number, col: number, blockId: number): Promise<{ ok: boolean }> {
    if (!Number.isInteger(col) || col < 1 || col > 4) {
      const err = new Error(`AM4 has 4 linear slots; slot must be 1..4, got ${col}`) as Error & { statusCode?: number };
      err.statusCode = 400; // client error, not a server fault
      throw err;
    }
    const dev = await this.#openTransport();
    const frame = buildSetBlockType(col as 1 | 2 | 3 | 4, blockId);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'grid' }); // live: other UIs / SSE re-read the chain
    this.#log(`placeCell: slot ${col} <- ${blockId ? `blockType 0x${blockId.toString(16)}` : 'cleared'}`);
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Switch the active scene (0..3). */
  async switchScene(index: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchScene(index));
    this.#invalidate();
    return { ok: true, scene: index };
  }

  /** Current scene index (0-based), read from the atomic fn-0x1F preset structure. */
  async getScene(): Promise<{ index: number }> {
    const s = await this.#readStructure();
    return { index: s?.scene ?? 0 };
  }

  /** Live tuner reading via block-0x0023 live-poll (4 channels: note-index / freq / cents / string).
   *  Values are absolute float32 (decoded upstream). The registry supervisor calls this on the tuner
   *  cadence while the tuner view is active; it emits the same `{type:'tuner', freq, note, octave,
   *  cents}` event gen-3 uses (Axis renders both identically). Returns null on any incomplete read so
   *  the supervisor keeps polling without churning the overlay. Serialized behind the shared reader lock. */
  async readTuner(): Promise<{ freq: number; note: string; octave: number; cents: number } | null> {
    return this.#readerCache.withReader(async () => {
      const dev = await this.#openTransport();
      const readCh = async (ch: number): Promise<number | null> => {
        const req = buildReadParam({ pidLow: AM4_TUNER_PID_LOW, pidHigh: ch }, READ_TYPE_LIVE_POLL);
        const hit = (f: number[]) => isPollResponse(f) && f[6] === AM4_TUNER_PID_LOW && f[8] === ch;
        try {
          const frames = await dev.request(req, { timeoutMs: dev.slow ? 400 : 250, quietMs: dev.slow ? 60 : 30, match: (fs) => fs.some(hit) });
          const f = frames.find(hit);
          return f ? parseReadResponse(f).asFloat32() : null;
        } catch {
          return null;
        }
      };
      const noteIndex = await readCh(AM4_TUNER_CHANNEL.NOTE_INDEX);
      const freqHz = await readCh(AM4_TUNER_CHANNEL.FREQ_HZ);
      const cents = await readCh(AM4_TUNER_CHANNEL.CENTS);
      const stringBand = await readCh(AM4_TUNER_CHANNEL.STRING_BAND);
      if (noteIndex === null || freqHz === null || cents === null) return null; // incomplete → skip this tick
      const r = decodeAm4Tuner({ noteIndex, freqHz, cents, stringBand: stringBand ?? 0 });
      // Split the device-true note into gen-3's {note, octave} (NOTE_NAMES indexed by MIDI%12, C=0).
      const note = midiNoteName(r.midiNote);
      const octave = Math.floor(r.midiNote / 12) - 1;
      return { freq: r.freqHz, note, octave, cents: r.cents };
    });
  }

  /** Generic driver scene switch (unified POST /scene). */
  async setScene(index: number) {
    return this.switchScene(index);
  }

  /** Switch the active preset by location index (0..103, A01..Z04). */
  async switchPreset(location: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchPreset(location));
    this.#invalidate();
    return { ok: true, location };
  }

  /** Generic driver preset select (unified POST /preset/select) — adds the bank-letter `code`. */
  async selectPreset(n: number): Promise<{ ok: boolean; code: string }> {
    const r = await this.switchPreset(n);
    return { ok: r.ok, code: formatLocationCode(n) };
  }

  /** Generic driver store-to-slot (unified POST /preset/store) → {ok, location, code}. */
  async store(n: number) {
    return this.storePreset(n);
  }

  /** Generic stored-name lookup (unified GET /presets/:n) — the AM4 answers with the real stored
   *  name plus the bank-letter `code` (additive; gen-3 keeps its {number, name:''} stub). */
  async storedPresetName(n: number): Promise<{ number: number; name: string; code: string }> {
    const r = await this.presetName(n);
    return { number: n, name: r.name, code: formatLocationCode(n) };
  }

  /** Save the active edit buffer to a stored location (0..103). Wire action 0x1B —
   *  hardware-confirmed byte-exact against a live AM4 capture (2026-07-02). */
  async storePreset(location: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSaveToLocation(location));
    return { ok: true, location, code: formatLocationCode(location) };
  }

  /** Back up a preset off the device as a verbatim .syx dump (the 6-message 0x77/0x78/0x79 stream).
   *  `location` omitted → the active edit buffer. Returns the raw bytes (byte-identical, replayable)
   *  plus the decoded location + name. Community-beta: the dump-request path is capture-derived. */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[]; sceneNames?: string[]; crcValid?: boolean }> {
    const dev = await this.#openTransport();
    const req = location == null ? buildRequestActiveBufferDump() : buildRequestStoredPresetDump(location);
    const frames = await dev.request(req, { timeoutMs: 5000, quietMs: 200, match: (fs) => fs.some((f) => f[4] === 0x15 && f[5] === 0x79) });
    const dumpMsgs = frames.filter((f) => f[4] === 0x15 && (f[5] === 0x77 || f[5] === 0x78 || f[5] === 0x79));
    const raw = Uint8Array.from(dumpMsgs.flat());
    const dump = parseAm4PresetDump(raw); // validates every envelope + checksum; throws on malformed
    const loc = am4DumpLocation(dump);
    // ADDITIVE opt-in decode (crcValid + scene names) atop the opaque, byte-identical `bytes` — a
    // corrupt dump degrades to no extra fields (am4DecodeEnrichment never throws) and still backs up.
    const enrich = am4DecodeEnrichment(dump.raw);
    this.#log(`backup ${loc.code ?? '(active)'} "${decodeAm4PresetNameFromFrame(dump.raw)}" ${dump.raw.length}B${enrich ? ` crc=${enrich.crcValid ? 'ok' : 'BAD'}` : ''}`);
    return {
      location: loc.active ? null : (loc.index ?? null),
      code: loc.code ?? null,
      name: decodeAm4PresetNameFromFrame(dump.raw),
      bytes: [...dump.raw],
      ...(enrich ? { sceneNames: enrich.sceneNames, crcValid: enrich.crcValid } : {})
    };
  }

  /** Restore a preset .syx (single 12,352-byte dump) to the device by verbatim re-emit (goes back to
   *  the location encoded in the dump's 0x77 header). Validates the dump before sending. */
  async restorePreset(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }> {
    const dump = parseAm4PresetDump(Uint8Array.from(bytes)); // validate first — throws on bad envelope/checksum
    const loc = am4DumpLocation(dump);
    const dev = await this.#openTransport();
    for (const msg of splitSysex([...dump.raw])) await dev.sendQueued(msg);
    this.#invalidate();
    this.#log(`restore -> ${loc.code ?? '(active)'} (${dump.raw.length}B, 6 msgs)`);
    return { ok: true, location: loc.active ? null : (loc.index ?? null), code: loc.code ?? null };
  }

  /** Offline decode of an AM4 .syx (a single dump or a whole bank, e.g. the 104-preset factory file):
   *  returns each preset's location + name. No device needed — for library import / browsing. */
  decodePresetBank(bytes: number[]): OfflinePresetBank {
    return am4BankFromBytes(bytes);
  }

  /** AM4 modifier address model (16 slots) — field map + enums recovered from the editor def cache,
   *  cross-validated with the resolver table. Data-only: the wire binding (CONNECT_MODIFIER) is not
   *  yet captured, so this exposes the model for a UI/editor, not a bind builder. */
  modifierModel() {
    return {
      effectOrdinal: AM4_MOD_EFFECT_ORDINAL,
      slotCount: AM4_MOD_SLOT_COUNT,
      fields: AM4_MOD_FIELDS,
      sources: AM4_MODIFIER_SOURCES,
      operations: AM4_MOD_OPERATIONS,
      channels: AM4_MOD_CHANNELS,
      bindingSupported: false,
      note: 'AM4 modifier field map + enums are data-only; the wire binding opcode (CONNECT_MODIFIER) is not yet captured.'
    };
  }

  /** Validate an AM4 firmware .syx (fn 0x7D/0x7E/0x7F envelope) — integrity check only, NOT a flasher.
   *  Reports message/block counts + the header/finalize tags. */
  validateFirmware(bytes: number[]) {
    try {
      const fw = parseAm4Firmware(Uint8Array.from(bytes));
      return {
        valid: true,
        messages: fw.messageCount,
        blocks: fw.blockPayloads.length,
        headerTag: [...fw.headerPayload],
        finalizeTag: [...fw.finalizePayload]
      };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }
}

/** Create the AM4 driver over the shared transport. */
export function createAm4Driver(ctx: DriverCtx): Am4Driver {
  return new Am4Driver(ctx);
}
export type { Am4Driver };
