// Gen-3 device driver (Axe-Fx III / FM3 / FM9) — the shared grid codec driven through a per-device
// profile. Wire protocol + catalog/params/rosters/enums/cab-IRs all via forgefx-midi. One driver
// instance per model byte; EVERY frame is built by a codec bound to that byte
// (createModernFractalCodec), so nothing here can fall back to a defaulted model.
import {
  createModernFractalCodec,
  buildSetTempoViaParam,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT,
  type ModernFractalCodec
} from 'forgefx-midi/gen3/axe-fx-iii';
import {
  effectRoster, blockRefForEid, slugForEffectId, blockInstances,
  retargetPresetDumpToEditBuffer,
  type DecodedBlock
} from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY, type DeviceProfile, type TypeModel, type DeviceLayout, type SelectorValues } from '../devices.js';
import { blockHelpBySlug } from '../help.js';
import { selectModifierSlot } from './modifierSlots.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx,
  PresetGridDTO, PresetBlockDTO, PresetSummary, NamedParam, EnumParam,
  FcSwitchState, FcReadState
} from './types.js';
import { driverConfig } from './types.js';

import {
  BLOCK_META, CH_LETTERS, paramLabel,
  clamp01, channelSlice, type ParamCandidate,
} from './gen3/support.js';
import { Gen3Host } from './gen3/host.js';
import { ParamDisplay } from './gen3/paramDisplay.js';
import { PresetDecoder } from './gen3/presetDecoder.js';
import { GridReader } from './gen3/gridReader.js';
import { CabService } from './gen3/cabService.js';
import { MetersService } from './gen3/metersService.js';
import { FcReader } from './gen3/fcReader.js';
import { EditSync } from './gen3/editSync.js';

// Preserved public export path (registryCore imports GEN3_SHUNT_ID_BASE from './gen3.js').
export { GEN3_SHUNT_ID_BASE } from './gen3/support.js';

class Gen3Driver implements DeviceDriver {
  #prof: DeviceProfile;
  #codec: ModernFractalCodec;
  #ctx: DriverCtx;
  #host: Gen3Host;
  #paramDisplay: ParamDisplay;
  #decoder: PresetDecoder;
  #grid: GridReader;
  #cab: CabService;
  #meters: MetersService;
  #fc: FcReader;
  #editSync: EditSync;
  readonly capabilities: DriverCapabilities;

  constructor(profile: DeviceProfile, ctx: DriverCtx) {
    this.#prof = profile;
    this.#codec = createModernFractalCodec(profile.model); // every frame carries THIS device's model byte
    this.#ctx = ctx;
    this.#host = new Gen3Host(this.#codec, ctx, profile);
    this.#paramDisplay = new ParamDisplay(() => this.#host.profile);
    this.#decoder = new PresetDecoder(this.#host);
    this.#grid = new GridReader(this.#host, this.#decoder);
    this.#cab = new CabService(this.#host, this.#paramDisplay);
    this.#meters = new MetersService(this.#host, this.#paramDisplay, this.#grid);
    this.#fc = new FcReader(this.#host);
    this.#editSync = new EditSync(this.#host);
    this.capabilities = {
      slotModel: 'grid',
      grid: { rows: profile.rows, cols: profile.cols },
      gridEdit: true,
      scenes: 8,
      channels: true,
      presetDump: true,
      presetConvert: true, // full gen-3 lift (routing grid + per-scene block state + amp knobs)
      telemetry: { tuner: true, outputMeters: true, cpu: true },
      fcModel: !!profile.fcModel,
      fcLiveRead: !!profile.fcModel?.liveState,
      modBind: !!profile.modModel,
      cabIrs: Object.keys(profile.cabIrs()).length > 0,
      editorLayouts: true, // FM3 / FM9 / Axe-Fx III all ship *_LAYOUTS (profile.layoutFor)
      supportsSave: true,
      // Live self-describe walk (fn 0x01 DEFINITION/ENUM-LABEL sweep) is HW-verified on the FM3 and
      // shares the gen-3 protocol on the FM9 / Axe-Fx III → the on-connect device-cache build is offered.
      selfDescribe: true,
      // Same buildCache path as the live walk → an official-editor .cache file can be imported too.
      cacheImport: true,
      // FULL-mode self-describe (write-sweep taper capture) is CaptureRig-proven on the trio the rig
      // sweeps: Axe-Fx III (0x10) / FM3 (0x11) / FM9 (0x12). Gated to those model bytes explicitly.
      fullCapture: profile.model === 0x10 || profile.model === 0x11 || profile.model === 0x12,
      // Device-edit reflection splits by whether the unit PUSHES front-panel edits:
      //  • FM9 / Axe-Fx III / VP4 push an unsolicited 0x74/0x75/0x76 burst → registry LISTENS (deviceEditPush).
      //  • FM3 (0x11) proven NOT to push (tap 2026-07-04: a front-panel knob emitted zero unsolicited
      //    frames) → registry POLLS the open block instead (deviceEditWatch → readDeviceEditState below),
      //    the same poll-fallback shape as the AM4. Disable in the field via DriverCtx.config.fm3EditSync
      //    (Node reads FORGEFX_FM3_EDITSYNC into it).
      deviceEditPush: profile.model !== 0x11,
      deviceEditWatch: profile.model === 0x11 && driverConfig(ctx).fm3EditSync
    };
  }

  get modelId() { return this.#prof.model; }
  get key() { return this.#prof.key; }
  get name() { return this.#prof.name; }
  get profile() { return this.#prof; }

  /** Adopt a device-cache-derived runtime profile (device-true rosters / enum labels / ranges). The
   *  model byte is unchanged so the codec bound at construction stays valid; only the data the reads
   *  resolve through (#prof) is swapped. Idempotent — re-applying a fresh profile just replaces it. */
  applyRuntimeProfile(profile: DeviceProfile): void {
    this.#prof = profile;
    this.#host.setProfile(profile);
    this.#paramDisplay.invalidateUnitIndex();
  }

  #conn() { return this.#ctx.transport(); }
  #emit: DriverCtx['emit'] = (e) => this.#ctx.emit(e);

  /** Fire-and-forget write, serialized on the request chain (so it never injects mid-read). */
  #send(bytes: number[]): Promise<{ ok: boolean }> { return this.#host.send(bytes); }

  /** Write + watch a short window for a 0x64 rejection. For structural ops where a reject matters. */
  #write(bytes: number[]): Promise<{ ok: boolean }> { return this.#host.write(bytes); }

  /** Current preset number + name (one query). */
  presetRef(): Promise<{ number: number; name: string }> { return this.#host.presetRef(); }

  /** Routing grid. Deduped + short-TTL cached; FM3 reads it live, everything else dumps the preset. */
  grid(): Promise<PresetGridDTO> { return this.#grid.grid(); }

  /** Read scene labels separately from the live grid. Eight serial reads must never delay the canvas. */
  sceneNames(): Promise<string[]> { return this.#grid.sceneNames(); }

  /** Decode any preset by number (non-disruptive — does NOT switch the active preset) into a
   *  library-friendly summary: name, scene names, and the unique effect blocks it contains. */
  presetSummary(presetNumber: number, withParams = false): Promise<PresetSummary> {
    return this.#decoder.presetSummary(presetNumber, withParams);
  }

  /** Full per-block params (every family/param) for one device preset — the deep-search / detail source. */
  presetParams(presetNumber: number): Promise<DecodedBlock[]> {
    return this.#decoder.presetParams(presetNumber);
  }

  /** Raw .syx bytes (the backup blob) + decoded summary for one slot — the backups service's source. */
  dumpRaw(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }> {
    return this.#decoder.dumpRaw(n);
  }

  /** Verbatim .syx dump for POST /preset/backup (capability `backupDump`) — the library's
   *  export-to-disk + audition source. Location omitted → the currently selected preset's slot
   *  (gen-3 dumps by slot; the raw edit-buffer stream is a different frame format, not a .syx). */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const n = location ?? (await this.presetRef()).number;
    const { bytes, summary } = await this.dumpRaw(n);
    return { location: n, code: null, name: summary.name, bytes: Array.from(bytes) };
  }

  /** Decode a preset from raw .syx bytes (a saved/exported dump) — offline, no device needed. */
  decodePresetBytes(bytes: Uint8Array): PresetSummary {
    return this.#decoder.decodePresetBytes(bytes);
  }

  /** Decompressed preset body as hex — for per-block param-decode RE (diff bodies across known param
   *  changes to locate offsets). Dumps the active edit buffer. */
  presetBodyHex(): Promise<{ len: number; hex: string }> { return this.#decoder.presetBodyHex(); }

  /** Live active-channel per placed block (effectId → channel 0-3), from the fn 0x13 status dump. */
  getActiveChannels(): Promise<Map<number, number>> { return this.#grid.activeChannels(); }

  /** Placed blocks: position + routing + live bypass/channel. */
  placedBlocks(): Promise<PresetBlockDTO[]> { return this.#grid.placedBlocks(); }

  /** LIGHTWEIGHT per-block scene state — just bypass + active channel from the fn 0x13 status dump,
   *  NO preset dump. Keeps scene changes snappy and OFF the heavy, crash-prone dump path. */
  sceneState(): Promise<{ effectId: number; bypassed: boolean; channel: string | null }[]> {
    return this.#grid.sceneState();
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
  async blockParams(eid: number, options: { observe?: boolean } = {}): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    if (options.observe !== false) this.#editSync.setWatched(eid); // the block the user opened is the device-edit poll target
    const codecSlug = slugForEffectId(eid) ?? ''; // audio blocks resolve via the codec
    // virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199) resolve via the profile's effectId map
    const family = SLUG_FAMILY[codecSlug.toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const slug = codecSlug || (family ? family.toLowerCase() : ''); // virtual effects key on the family name
    const meta = BLOCK_META[codecSlug];
    const blockName = meta?.name ?? family ?? slug;
    const page = meta?.page ?? -1;
    // Seed the editor-authentic layout with the family's fallback variant; once the block's CURRENT
    // type is read below we re-resolve to the type-matched (or firmware-pinned) variant.
    let layout = family ? this.#prof.layoutFor(family) : undefined;
    if (!family) {
      return { block: blockName, slug, page, named: [], enums: [], type: null, layout }; // no device-true param family mapped
    }
    const defs = this.#prof.params[family] ?? [];
    // Classify EVERY catalog def for the family into named (kind 'float') or enums (kind 'enum') —
    // nothing is silently dropped any more (Phase 1.2). A def that used to vanish entirely (no range
    // row, a degenerate 0..0 range, or a paramId that collides with an earlier def's wire address)
    // now ships flagged `unusable` instead: the device's layout can still name that paramId, so the
    // renderer must be able to resolve every one it names. Only two categories stay excluded, because
    // they're real device semantics re-surfaced elsewhere: the raw bypass flag, and the family TYPE
    // selector (re-surfaced as `type` below).
    const typeId = this.#paramDisplay.paramId(family, 'type');
    const seenIds = new Set<number>();
    const unusableFor = (paramId: number, range: ParamCandidate['range']): NamedParam['unusable'] => {
      if (seenIds.has(paramId)) return 'duplicate-id'; // a later def collided with an earlier def's wire paramId
      seenIds.add(paramId);
      if (!range) return 'no-range';
      if (range.kind === 'float' && range.displayMin === range.displayMax) return 'degenerate-range';
      if (range.kind === 'enum' && range.displayMax <= range.displayMin) return 'degenerate-range';
      return undefined;
    };
    const knobs: ParamCandidate[] = [];
    const enumCands: ParamCandidate[] = [];
    for (const p of defs) {
      const range = this.#prof.ranges[family]?.[p.paramId];
      const isEnum = range ? range.kind === 'enum' : p.unit === 'enum'; // no range row → guess from the catalog unit code
      if (isEnum) {
        if (p.paramId === typeId || /^bypass$/i.test(p.displayLabel ?? p.name)) continue;
        enumCands.push({ p, range, unusable: unusableFor(p.paramId, range) });
      } else {
        if (/bypass/i.test(p.displayLabel ?? p.name)) continue;
        knobs.push({ p, range, unusable: unusableFor(p.paramId, range) });
      }
    }
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    {
      const dev = await this.#conn();
      try {
        // Read the block's CURRENT channel (A-D) so a channel switch actually reloads that channel's
        // params/type: the fn-0x1F body is channel-blocked and holds ALL channels, so we must slice the
        // active one, not always channel A. Costs one status round-trip per open — worth it for correctness.
        const activeCh = (await this.#host.statusByEffectId()).get(eid)?.channel ?? 0;
        const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: dev.slow ? 8000 : 2500, quietMs: dev.slow ? 600 : 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        const { stride, base } = channelSlice(this.#prof, family, bulk, activeCh);
        // Prime the device-edit-push baseline with the OPEN channel's values so a later front-panel
        // edit's burst diffs cleanly to the moved param (no first-sight reload — see decodeEditBurst).
        this.#editSync.observeBlock(eid, activeCh, bulk.values.slice(base, base + stride), options.observe !== false);
        for (const { p, range, unusable } of knobs) {
          const raw = bulk.values[base + p.paramId] ?? 0;
          named.push({
            id: p.paramId, name: paramLabel(p), ...this.#paramDisplay.display(family, p.paramId, raw),
            paramName: p.name, family, step: range?.step, default: this.#paramDisplay.defaultDisplay(family, p.paramId, range),
            taper: range?.taper, taperPoints: range?.taperPoints, unitCode: p.unit, kind: range?.kind ?? 'float',
            unusable
          });
        }
        for (const { p, range, unusable } of enumCands) {
          const max = range ? Math.round(range.displayMax) : 0;
          const min = range ? Math.round(range.displayMin) : 0;
          const raw = bulk.values[base + p.paramId] ?? 0;
          // discrete params store the ordinal; if the wire value looks 16-bit-scaled, unscale it
          const value = max > min && raw > max ? Math.round((raw / 65534) * (max - min)) + min : raw;
          enums.push({
            id: p.paramId, name: paramLabel(p), value,
            options: max > min ? this.#paramDisplay.enumOptions(family, p.paramId, p.name, min, max) : [],
            paramName: p.name, family, step: range?.step, default: this.#paramDisplay.defaultDisplay(family, p.paramId, range),
            taper: range?.taper, taperPoints: range?.taperPoints, unitCode: p.unit, kind: range?.kind ?? 'enum',
            unusable
          });
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
        for (const { p } of knobs) named.push({ id: p.paramId, name: paramLabel(p), value: 0, norm: 0 });
      }
    }
    // Current value of any page/control selector param, keyed by its editor symbol: the family type
    // selector answers with the type just decoded; other selectors (EQ type, drive type, …) with the
    // block's read enum/knob value. Lets layoutFor filter the served pages down to the ones the editor
    // would actually show — collapsing e.g. the amp's per-model 'Authentic' pages to the current model.
    const valueByPid = new Map<number, number>();
    for (const e of enums) valueByPid.set(e.id, e.value);
    for (const n of named) if (typeof n.value === 'number') valueByPid.set(n.id, n.value);
    const selectors: SelectorValues = (selectorParamName) => {
      const pid = this.#paramDisplay.paramId(family, selectorParamName);
      if (pid == null) return undefined;
      if (typeId != null && pid === typeId) return type?.value;
      return valueByPid.get(pid);
    };
    // Re-resolve the layout to the variant selected by the block's CURRENT type value (EQ band count,
    // amp firmware-pinned variant, etc.) and filter its pages to the current selector/firmware state;
    // falls back to the null/first variant when type is unknown.
    layout = this.#prof.layoutFor(family, type?.value, selectors);
    // Fold each param's curated help blurb/tip (GET /help/blocks/:slug) onto it, keyed by the editor
    // symbol (paramName) — one response, one source of UI truth, no second Axis fetch (Phase 1.5).
    const help = blockHelpBySlug(this.#prof, slug);
    if (help) {
      for (const n of named) { const h = n.paramName ? help.paramsByName[n.paramName] : undefined; if (h) n.help = h; }
      for (const e of enums) { const h = e.paramName ? help.paramsByName[e.paramName] : undefined; if (h) e.help = h; }
    }
    return { block: blockName, slug, page, named, enums, type, layout };
  }

  /** Read specific paramIds of an effect via per-pid fn 0x01 GET (sub 01 00) — the path FM3-Edit
   *  uses to load FC state. Returns {pid: float value}. The RX value is a 5×7-bit packed float32 at
   *  byte 12 of the response frame (after F0 00 01 74 <model> 01 | 01 00 | eid:2 | pid:2). */
  readParams(eid: number, pids: number[]): Promise<Record<number, number>> {
    return this.#fc.readParams(eid, pids);
  }

  readRange(eid: number, pids: number[]): Promise<Record<number, number>> {
    return this.#fc.readRange(eid, pids);
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
  fcReadSwitch(layout: number, view: number, sw: number): Promise<FcSwitchState> {
    return this.#fc.fcReadSwitch(layout, view, sw);
  }

  fcReadState(layout: number, view: number, sw: number): Promise<FcReadState> {
    return this.#fc.fcReadState(layout, view, sw);
  }

  rawBlock(eid: number): Promise<{ eid: number; values: Record<number, number> }> {
    return this.#fc.rawBlock(eid);
  }

  cabIrs(refresh = false): Promise<Record<string, string[]>> { return this.#cab.cabIrs(refresh); }

  cabState(eid: number): Promise<unknown> { return this.#cab.cabState(eid); }

  /** Per-block "meter" values for the always-on grid level fill + swipe controls. */
  meters(wants: Record<string, number[]> = {}) {
    return this.#meters.meters(wants);
  }

  liveMonitors(onlyEid?: number) {
    return this.#meters.liveMonitors(onlyEid);
  }

  looperTelemetry(eid: number) {
    return this.#meters.looperTelemetry(eid);
  }

  looperControl(eid: number, action: string, on: boolean) {
    return this.#meters.looperControl(eid, action, on);
  }

  /** FM3 device-edit POLL (capability deviceEditWatch — FM3 doesn't push, unlike FM9/III). */
  readDeviceEditState(): Promise<{ changed: boolean }> { return this.#editSync.readDeviceEditState(); }

  /** Decode a reassembled unsolicited 0x74/0x75/0x76 burst into per-param events (capability deviceEditPush). */
  decodeEditBurst(frames: number[][]) { return this.#editSync.decodeEditBurst(frames); }

  // ── writes (all address the exact placed instance by effect id) ──
  async setParam(eid: number, paramId: number, value: number, continuous: boolean) {
    // continuous knob writes stream at high frequency → fire-and-forget (instant);
    // a discrete write (enum) is rarer + worth confirming, so reject-watch it.
    const r = continuous ? await this.#send(this.#codec.buildSetParameterContinuous(eid, paramId, clamp01(value))) : await this.#write(this.#codec.buildSetParameter(eid, paramId, value));
    this.#editSync.noteLocalWrite(); // pause the FM3 device-edit poll briefly so it doesn't echo our own write mid-drag
    this.#emit({ type: 'param', effectId: eid, paramId, norm: value }); // live: other UIs move the knob
    return r;
  }
  /** Change a block's model/type (the family TYPE selector ordinal). */
  async setType(eid: number, value: number) {
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
    const tid = family ? this.#paramDisplay.paramId(family, 'type') : undefined;
    if (tid == null) return { ok: false };
    const r = await this.#write(this.#codec.buildSetParameter(eid, tid, value));
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setBypass(eid: number, bypassed: boolean) {
    const r = await this.#send(this.#codec.buildSetBypass(eid, bypassed)); // instant toggle
    this.#host.invalidateStatus(); // the fn-0x13 dump now reports the new bypass
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setChannel(eid: number, channel: string) {
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (idx < 0 || idx > 3) return { ok: false };
    const wireChannel = idx as 0 | 1 | 2 | 3;
    const frame = this.#prof.sceneChannelWriteMode === 'fm3-edit-fn01'
      ? this.#codec.buildSetChannelNative(eid, wireChannel)
      : this.#codec.buildSetChannel(eid, wireChannel);
    const r = await this.#send(frame); // instant
    this.#host.invalidateStatus(); // the block's active channel is part of the fn-0x13 dump
    this.#emit({ type: 'blockState', effectId: eid });
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
    await this.#write(this.#codec.buildSetParameter(slotEid, f.targetEffectId.pid, targetEffectId));
    await this.#write(this.#codec.buildSetParameter(slotEid, f.targetParam.pid, targetParam));
    await this.#write(this.#codec.buildSetParameter(slotEid, f.source.pid, source));
    return { ok: true, slotEid, slot, targetEffectId, targetParam, source };
  }

  /** Resolve the modifier slot bound to a target parameter (or the first free slot) — READ-ONLY.
   *  Reads each slot's source/targetEffectId/targetParam via the standard bulk read; never writes. */
  async resolveModifierSlot(targetEffectId: number, targetParam: number) {
    const mm = this.#prof.modModel;
    if (!mm) return { ok: false, error: 'device has no modifier model' };
    const { effectId, slotCount, fields } = mm;
    const sourcePid = fields.source?.pid;
    const targetEffectIdPid = fields.targetEffectId?.pid;
    const targetParamPid = fields.targetParam?.pid;
    if (sourcePid == null || targetEffectIdPid == null || targetParamPid == null) {
      return { ok: false, error: 'modifier model is missing the binding fields (source/targetEffectId/targetParam)' };
    }
    const resolution = await selectModifierSlot(slotCount, targetEffectId, targetParam, async (slot) => {
      const values = await this.#fc.readRawValues(effectId + (slot - 1));
      return {
        source: values[sourcePid] ?? 0,
        targetEffectId: values[targetEffectIdPid] ?? 0,
        targetParam: values[targetParamPid] ?? 0
      };
    });
    if (resolution.kind === 'noFreeSlot') return { ok: false, error: 'no_free_slot', slotCount };
    return { ok: true, matched: resolution.kind === 'matched', slot: resolution.slot, slotCount };
  }

  /** Modifier address model for GET /mod/model — the profile's ModModel plus the Phase-6 superset
   *  field `bindingSupported` (gen-3 binds via /mod/bind). Prepended so the JSON stays additive-only
   *  against the pre-Phase-6 sweep baseline. */
  modifierModel(): Record<string, unknown> | null {
    const mm = this.#prof.modModel;
    if (!mm) return null;
    if (mm.sources.length) return { bindingSupported: true, ...mm };
    const source = mm.fields.source;
    const def = source ? (this.#prof.params.MOD ?? []).find((p) => p.paramId === source.pid) : undefined;
    const range = source ? this.#prof.ranges.MOD?.[source.pid] : undefined;
    const options = def && range?.kind === 'enum'
      ? this.#paramDisplay.enumOptions('MOD', source!.pid, def.name, Math.round(range.displayMin), Math.round(range.displayMax))
      : [];
    const sources = options.every((option) => option.label !== String(option.value))
      ? options.map((option) => ({ ordinal: option.value, name: option.label }))
      : [];
    return { bindingSupported: true, ...mm, sources };
  }

  // ── tempo / scene ──
  /** Current tempo (BPM). Parsed via the bound codec's 0x14 payload parser (LSB-first septet pair). */
  async getTempo(): Promise<{ bpm: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildGetTempo(), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x14) });
    const f = frames.find((x) => x[5] === 0x14);
    if (!f) return { bpm: 0 };
    return { bpm: this.#codec.parseTempoResponse(f).bpm };
  }
  /** Set tempo the way FM3-Edit does (captured): a param write at the global-tempo address,
   * BPM as a 5-septet float32 value. (The 0x14 SET appears not to take on FM3.) */
  async setTempo(bpm: number) {
    await (await this.#conn()).sendQueued(buildSetTempoViaParam(bpm, this.#prof.model));
    this.#emit({ type: 'tempo', bpm });
    return { ok: true };
  }
  async tapTempo() {
    return this.#send(this.#codec.buildTempoTap());
  }
  /** Current scene index (0-based). Parsed via the bound codec's 0x0C payload parser. */
  async getScene(): Promise<{ index: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildGetScene(), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x0c) });
    const f = frames.find((x) => x[5] === 0x0c);
    if (!f) return { index: -1 }; // FAILED read (racy/late on a busy link) — sentinel so the scene watch
    //                               and UI skip it, instead of fabricating scene 1 (caused a 2↔1 badge flicker)
    return { index: this.#codec.parseSceneResponse(f).scene };
  }
  async setScene(index: number) {
    if (index < 0 || index > 7) return { ok: false };
    const frame = this.#prof.sceneChannelWriteMode === 'fm3-edit-fn01'
      ? this.#codec.buildSetSceneNative(index)
      : this.#codec.buildSetScene(index);
    const r = await this.#send(frame);
    // A scene selects its own per-block bypass/channel → bust the cached fn-0x13 status so the next
    // placedBlocks()/sceneState() reflects the new scene; then notify subscribers so the UI follows.
    this.#host.invalidateStatus();
    this.#emit({ type: 'scene', index });
    return r;
  }
  /** Rename a scene (0..7) in the WORKING BUFFER (fn 0x01 sub 0x2b, via fractal-midi's buildSetSceneName).
   *  Visible immediately; NOT persisted to flash — that's a separate store op. Name is 32-char ASCII max.
   *  #write watches briefly for a 0x64 rejection so the caller learns if the device refused it. */
  async setSceneName(index: number, name: string) {
    if (index < 0 || index > 7) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32); // printable ASCII, 32 max
    this.#grid.invalidateScenes(); // the live grid path serves scene names from here
    return this.#write(this.#codec.buildSetSceneName(index, clean));
  }
  /** Rename the working-buffer PRESET (fn 0x01 sub 0x28, via fractal-midi's buildRenamePreset). Visible
   *  immediately; persist to flash is the separate store op. Name is 32-char printable ASCII max. */
  async setPresetName(name: string) {
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    return this.#write(this.#codec.buildRenamePreset(clean));
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
    await this.#write(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
    const r = await this.#write(this.#codec.buildSetGridCell({ row, col, blockId, rows: this.#prof.rows }));
    this.#grid.invalidate();
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  /** Move the device's edit cursor to a cell (sub 0x30) so the FM3 screen follows the UI.
   * Non-destructive: this is the cursor-select frame (no companion = no clear). */
  async selectCell(row: number, col: number) {
    return this.#send(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
  }
  async cable(srcRow: number, srcCol: number, destRow: number, connect: boolean) {
    const r = await this.#write(this.#codec.buildSetGridRouting({ srcRow, srcCol, destRow, rows: this.#prof.rows, op: connect ? ROUTING_OP_CONNECT : ROUTING_OP_DISCONNECT }));
    this.#grid.invalidate();
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async selectPreset(n: number) {
    this.#grid.invalidate();
    this.#host.invalidateStatus();
    const r = await this.#write(this.#codec.buildSwitchPresetSysEx(n));
    // Clear AGAIN after the write: a grid/status read that landed while the switch was in flight would
    // otherwise have re-cached the OUTGOING preset's layout/state for the rest of the TTL — visible now
    // that the live path makes the follow-up read fast enough to hit that window.
    this.#grid.invalidate();
    this.#host.invalidateStatus();
    this.#emit({ type: 'changed', scope: 'preset' });
    return r;
  }
  /** Reload the CURRENT preset from flash by re-selecting it — the FULL-mode self-describe walk's
   *  non-destructive per-block safety net. Reuses presetRef() (current number) + selectPreset() (the
   *  wire builder), so no new preset-switch bytes are minted here. No-op when no preset is resolvable. */
  async reloadPreset(): Promise<void> {
    const { number } = await this.presetRef();
    if (number >= 0) await this.selectPreset(number);
  }
  async store(n: number) {
    return this.#write(this.#codec.buildStorePreset(n));
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
    retargetPresetDumpToEditBuffer(bytes);
    if (dev.sendPaced) await dev.sendPaced(bytes);
    else await dev.sendQueued(bytes);
    this.#grid.invalidate(); // edit buffer changed → next grid/blocks read reflects it
    this.#grid.invalidateScenes(); // …including its scene names
    this.#host.invalidateStatus(); // …and the per-block bypass/channel dump
    return { ok: true };
  }

  /** Apply a whole block's raw values to a placed block in ONE 0x74/0x75/0x76 burst — the same
   *  EFFECT_DUMP write FM3-Edit emits to apply a saved `.blk` block. Replaces the ~10s per-param
   *  apply loop (one setChannel/setType/setParam round-trip per param). `block.values` are
   *  channel-blocked positional wire values; the burst head's blockId is the target's effect id. */
  async applyBlock(eid: number, block: { itemCount: number; values: number[] }, activeChannel: number): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const burst = this.#codec.buildGen3BlockBulkWrite({ blockId: eid, itemCount: block.itemCount, values: block.values });
    const bytes = burst.flat();
    if (dev.sendPaced) await dev.sendPaced(bytes);
    else await dev.sendQueued(bytes);
    // Restore the saved block's active channel after the bulk write.
    await this.setChannel(eid, String.fromCharCode(65 + activeChannel));
    this.#grid.invalidate();
    this.#editSync.noteLocalWrite(); // pause the FM3 device-edit poll so it doesn't echo the burst
    this.#emit({ type: 'changed', scope: 'grid' });
    return { ok: true };
  }

  /** Capture a placed block's whole burst for saving back to the `.blk` library. Reuses the fn 0x1F
   *  bulk-read poll `blockParams` already uses (no second wire path); the payload is rebuilt with
   *  `buildGen3BlockBulkWrite` so the 0x75 body pages carry `encode14(pageLen)` byte-exactly like a
   *  real saved file (see forgefx-midi's bulkwrite goldens). */
  async captureBlockForSave(eid: number, scope: 'current' | 'all'): Promise<{
    blockId: number;
    itemCount: number;
    values: number[];
    activeChannel: number;
    slug: string;
    payload: number[];
  }> {
    const codecSlug = slugForEffectId(eid) ?? '';
    const family = SLUG_FAMILY[codecSlug.toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const slug = codecSlug || (family ? family.toLowerCase() : '');
    const activeCh = (await this.#host.statusByEffectId()).get(eid)?.channel ?? 0;
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), {
      timeoutMs: dev.slow ? 8000 : 2500,
      quietMs: dev.slow ? 600 : 120,
      match: (fs) => fs.some((f) => f[5] === 0x76),
    });
    const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
    const { stride, channelCount, base } = channelSlice(this.#prof, family, bulk, activeCh);

    let values: number[];
    let xyState: number;
    if (scope === 'current' && channelCount > 1) {
      // Current channel keeps its live slice; the other channels reset to the device default.
      const defs = family ? (this.#prof.params[family] ?? []) : [];
      const defaults = new Array<number>(stride).fill(0);
      for (const p of defs) {
        if (p.paramId >= stride) continue;
        const range = family ? this.#prof.ranges[family]?.[p.paramId] : undefined;
        defaults[p.paramId] = range?.defaultRaw ?? 0;
      }
      values = new Array<number>(stride * channelCount).fill(0);
      for (let ch = 0; ch < channelCount; ch++) {
        const src = ch === activeCh ? bulk.values.slice(base, base + stride) : defaults;
        for (let i = 0; i < stride; i++) values[ch * stride + i] = src[i] ?? 0;
      }
      xyState = activeCh;
    } else {
      values = bulk.values.slice();
      xyState = activeCh;
    }

    const blockId = bulk.blockId || eid;
    const payload = this.#codec.buildGen3BlockBulkWrite({ blockId, itemCount: values.length, values }).flat();
    return { blockId, itemCount: values.length, values, activeChannel: xyState, slug, payload };
  }
}

/** Create a gen-3 driver bound to one device profile (Axe-Fx III / FM3 / FM9). */
export function createGen3Driver(profile: DeviceProfile, ctx: DriverCtx): Gen3Driver {
  return new Gen3Driver(profile, ctx);
}
export type { Gen3Driver };
