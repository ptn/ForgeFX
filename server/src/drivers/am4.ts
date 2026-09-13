// AM4 device driver (model 0x15) — a parallel driver to the gen-3 one. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the registry owns (ctx.transport()), since only one device is ever connected at a time.
// Codec is forgefx-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
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
  READ_TYPE_LIVE_POLL,
  parseReadResponse,
  isPollResponse,
  AM4_TUNER_PID_LOW,
  AM4_TUNER_CHANNEL,
  decodeAm4Tuner,
  isCommandAck,
  buildSaveToLocation,
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
import type { PresetSnapshot } from 'forgefx-midi/core';
import type { Transport } from '../transport/types.js';
import type { DeviceDriver, DriverCapabilities, DriverCtx, PresetGridDTO, PresetBlockDTO, Am4Slot } from './types.js';
import { driverConfig } from './types.js';
import type { TypeModel } from '../devices.js';
import { midiNoteName } from './shared/notes.js';
import { Am4Context } from './am4/context.js';
import { Am4EditSync } from './am4/editSync.js';
import { Am4PresetBank } from './am4/presetBank.js';
import { Am4BlockParams } from './am4/blockParams.js';
import { am4BlocksCatalog, am4BlockTypes, am4Grid, am4PlacedBlocks } from './am4/views.js';

// Re-exported from the split-out support module so the public `drivers/am4.js` path keeps them.
export { am4NoneSelector, am4DecodeEnrichment } from './am4/support.js';

const AM4_CHAN_LETTERS = ['A', 'B', 'C', 'D'] as const;

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
  #context: Am4Context;
  #editSync: Am4EditSync;
  #bank: Am4PresetBank;
  #blockParams: Am4BlockParams;

  constructor(ctx: DriverCtx) {
    this.#ctx = ctx;
    this.#context = new Am4Context({
      openTransport: () => this.#openTransport(),
      getCadence: () => this.#ctx.getCadence(),
      log: (s) => this.#log(s),
      am4Debug: driverConfig(this.#ctx).am4Debug,
    });
    this.#editSync = new Am4EditSync(this.#context, {
      getCadence: () => this.#ctx.getCadence(),
      emitScene: (index) => this.#ctx.emit({ type: 'scene', index }),
      emitChanged: () => this.#ctx.emit({ type: 'changed', scope: 'preset' }),
    });
    this.#bank = new Am4PresetBank({
      openTransport: () => this.#openTransport(),
      invalidate: () => this.#invalidate(),
      log: (s) => this.#log(s),
    });
    this.#blockParams = new Am4BlockParams(this.#context, { log: (s) => this.#log(s) });
  }

  /** The ONE shared transport (single exclusive MIDI/serial connection, owned by the registry). */
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  #emptySlots = (): Am4Slot[] => [1, 2, 3, 4].map((n) => ({ slot: n, blockType: 'none', pidLow: 0 }));

  /** ONE atomic getPreset dump of the active buffer via the VERIFIED reader, cached briefly (TTL). */
  readPreset(): Promise<PresetSnapshot | null> { return this.#context.readPreset(); }

  /** TEST-ONLY (FORGEFX-25 edit-watch tests): inject the clock the cache TTLs + rehash budget read. */
  __setClockForTest(fn: () => number): void { this.#context.setClockForTest(fn); }

  /** Drop both TTL caches after any device write — the next read must reflect the change. */
  #invalidate() {
    this.#context.invalidate();
    // Our own write also flips the device's "edited" bit + moves param values, so tell the device-edit
    // watcher to silently re-seed its baseline next tick instead of misreading it as a front-panel edit.
    this.#editSync.markSelfEdit();
  }

  /** One device-edit watch tick (capability deviceEditWatch) — see Am4EditSync for the gate. */
  readDeviceEditState(): Promise<{ changed: boolean }> { return this.#editSync.readDeviceEditState(); }

  /** Live current-preset query (unified GET /preset; capability presets.liveQuery) — feeds the
   *  Axis top-bar preset display. Number is the stored location decoded from the structure's
   *  int32 @0x00 (see STRUCT_LOCATION_OFFSET); -1 when the structure read fails (Axis ignores
   *  refs with a negative number). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const s = await this.#context.readStructure();
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
    const s = await this.#context.readStructure();
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
    const s = await this.#context.readStructure();
    const slots = (s?.slots ?? this.#emptySlots()).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none');
    const snap = slots.length ? await this.readPreset() : null;
    return am4PlacedBlocks(slots, snap, this.#context.activeChannel, AM4_CHAN_LETTERS);
  }

  /** Read every parameter of the block at `pidLow` in the unified blockParams DTO (see Am4BlockParams). */
  blockParams(pidLow: number) { return this.#blockParams.blockParams(pidLow); }

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
    const result = await this.#context.withReader(async () => {
      await this.#context.transport();
      return this.#context.reader.scanLocations!(this.#context.dispatchCtx(), 0, TOTAL_LOCATIONS - 1);
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
    this.#context.activeChannel.set(eid, idx);
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
    const loc = (await this.#context.readStructure())?.location ?? -1;
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
    const s = await this.#context.readStructure();
    return { index: s?.scene ?? 0 };
  }

  /** Live tuner reading via block-0x0023 live-poll (4 channels: note-index / freq / cents / string).
   *  Values are absolute float32 (decoded upstream). The registry supervisor calls this on the tuner
   *  cadence while the tuner view is active; it emits the same `{type:'tuner', freq, note, octave,
   *  cents}` event gen-3 uses (Axis renders both identically). Returns null on any incomplete read so
   *  the supervisor keeps polling without churning the overlay. Serialized behind the shared reader lock. */
  async readTuner(): Promise<{ freq: number; note: string; octave: number; cents: number } | null> {
    return this.#context.withReader(async () => {
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

  /** Back up a preset off the device as a verbatim .syx dump (see Am4PresetBank). */
  backupPreset(location?: number) { return this.#bank.backupPreset(location); }

  /** Restore a preset .syx by verbatim re-emit to the encoded location (see Am4PresetBank). */
  restorePreset(bytes: number[]) { return this.#bank.restorePreset(bytes); }

  /** Offline decode of an AM4 .syx dump/bank — location + name per preset (see Am4PresetBank). */
  decodePresetBank(bytes: number[]) { return this.#bank.decodePresetBank(bytes); }

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

  /** Validate an AM4 firmware .syx envelope (see Am4PresetBank). */
  validateFirmware(bytes: number[]) { return this.#bank.validateFirmware(bytes); }
}

/** Create the AM4 driver over the shared transport. */
export function createAm4Driver(ctx: DriverCtx): Am4Driver {
  return new Am4Driver(ctx);
}
export type { Am4Driver };
