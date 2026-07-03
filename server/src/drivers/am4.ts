// AM4 device driver (model 0x15) — a parallel driver to the gen-3 one. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the registry owns (ctx.transport()), since only one device is ever connected at a time.
// Codec is forgefx-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
  BLOCK_SLOT_PID_LOW,
  BLOCK_NAMES_BY_VALUE,
  buildSetParam,
  buildSetParamNorm,
  buildSetFloatParam,
  buildSetBlockBypass,
  buildSwitchScene,
  buildSwitchPreset,
  buildGetPresetName,
  parseGetPresetNameResponse,
  isCommandAck,
  buildSaveToLocation,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  parseAm4PresetDump,
  parseAm4PresetBank,
  am4DumpLocation,
  decodeAm4PresetNameFromFrame,
  parseAm4Firmware,
  formatLocationCode,
  AM4_PRESET_FRAME_SIZE,
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
// The VERIFIED high-level descriptor reader (hardware-confirmed upstream). We drive it over an adapter
// that wraps ForgeFX's Transport as the MidiConnection the reader expects (see Am4Conn below).
import { AM4_DESCRIPTOR } from 'forgefx-midi/devices/am4';
import type { MidiConnection } from 'forgefx-midi/core/midi';
import type { DispatchCtx, PresetSnapshot } from 'forgefx-midi/core';
import type { Transport } from '../transport/types.js';
import type { DeviceDriver, DriverCapabilities, DriverCtx, PresetGridDTO, PresetBlockDTO, NamedParam, EnumParam, Am4Slot } from './types.js';

/** Split a raw byte stream into its complete F0..F7 SysEx messages. */
function splitSysex(bytes: number[]): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) { i++; continue; }
    const end = bytes.indexOf(0xf7, i);
    if (end < 0) break;
    out.push(bytes.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

// ── AM4 preset-structure read (fn 0x01, readType 0x1F) — wire-decoded in fractal-midi's am4 SYSEX-MAP.
// ONE request returns a 192-byte structure (220 septets, continuous MSB-first 7→8 bitstream) carrying
// the preset name, active scene, and — at 0xB0/B4/B8/BC — the four per-slot block-type codes (int32 LE).
// This is how the chain is actually read; the per-slot short reads (0x0E) return 0 for placement.
const ATOMIC_READ_TYPE = 0x1f;
const STRUCT_BYTES = 192;
const STRUCT_SLOT_OFFSETS = [0xb0, 0xb4, 0xb8, 0xbc]; // int32 LE block-type code, slot 1..4
const STRUCT_NAME_OFFSET = 0x10;
const STRUCT_SCENE_OFFSET = 0x08;

/** The 192-byte structure response: F0 …74 15 01 …[1f 00]… <220 septets> cksum F7. */
function isStructResponse(r: number[]): boolean {
  return r.length >= 230 && r[0] === 0xf0 && r[4] === 0x15 && r[5] === 0x01
    && r[10] === 0x1f && r[11] === 0x00 && r[r.length - 1] === 0xf7;
}
/** Continuous MSB-first 7→8 bitstream unpack (load-bearing direction — LSB-first scrambles the fields). */
function unpackMsb(septets: number[], rawLen: number): Uint8Array {
  const out = new Uint8Array(rawLen);
  let acc = 0, nbits = 0, o = 0;
  for (const s of septets) {
    acc = (acc << 7) | (s & 0x7f);
    nbits += 7;
    while (nbits >= 8 && o < rawLen) { nbits -= 8; out[o++] = (acc >> nbits) & 0xff; }
    acc &= (1 << nbits) - 1; // keep acc bounded (nbits < 8 after the loop)
  }
  return out;
}
const int32LE = (b: Uint8Array, o: number) => (((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0);
function asciiAt(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) { const c = b[off + i] ?? 0; if (c === 0) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); }
  return s.trim();
}

// ── MidiConnection adapter over ForgeFX's Transport ──────────────────────────────────────────────
// The VERIFIED descriptor reader (getPreset / scanLocations) talks to a `MidiConnection`: it registers
// a `receiveSysExMatching` waiter, then `send`s the request, on the RAW transport (NOT the serialized
// dev.request chain). Two reader calls racing on the shared transport would interleave their waiters +
// sends, so Am4Driver serializes every reader call behind #withReader (a per-instance promise-chain
// mutex). close() is a no-op — the registry owns the transport's lifecycle; we never tear it down.
class Am4Conn implements MidiConnection {
  hasInput = true;
  lastSendError: Error | undefined = undefined;
  #t: Transport;
  constructor(t: Transport) { this.#t = t; }

  send(bytes: number[]): void {
    try {
      this.#t.send(bytes);
      this.lastSendError = undefined;
    } catch (e) {
      this.lastSendError = e instanceof Error ? e : new Error(String(e));
    }
  }

  onMessage(handler: (bytes: number[]) => void): () => void {
    return this.#t.onFrame(handler);
  }

  /** Resolve on the next complete inbound SysEx frame; reject on timeout. Clears the subscription +
   *  timer on BOTH paths so no dangling onFrame handler leaks past the wait. */
  receiveSysEx(timeoutMs = 1000): Promise<number[]> {
    return this.#waitFor(() => true, timeoutMs);
  }

  /** Resolve on the first inbound SysEx frame satisfying `pred`; reject on timeout. */
  receiveSysExMatching(pred: (bytes: number[]) => boolean, timeoutMs = 1000): Promise<number[]> {
    return this.#waitFor(pred, timeoutMs);
  }

  #waitFor(pred: (bytes: number[]) => boolean, timeoutMs: number): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const timer = setTimeout(() => { unsub?.(); reject(new Error(`AM4 receiveSysEx timeout after ${timeoutMs}ms`)); }, timeoutMs);
      unsub = this.#t.onFrame((frame) => {
        if (!pred(frame)) return;
        clearTimeout(timer);
        unsub?.();
        resolve(frame);
      });
    });
  }

  close(): void { /* no-op: the registry owns the transport lifecycle */ }
}

// AM4 unit tag → the display label the gen-3 blockParams DTO uses (so Axis renders both the same way).
// Blank = show the bare number (count/semitones/ratio are unitless integers; knob_0_10/20 are 0..N knobs).
const AM4_UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%', degrees: '°', pf: 'pF'
};
/** A pretty param label from a KNOWN_PARAMS key's name: displayLabel if present, else name with _→space. */
function am4ParamLabel(p: Param): string {
  return p.displayLabel ?? p.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

class Am4Driver implements DeviceDriver {
  readonly modelId = 0x15;
  readonly key = 'am4';
  readonly name = 'AM4';
  readonly capabilities: DriverCapabilities = {
    slotModel: 'linear',
    slotCount: 4,
    gridEdit: false,
    scenes: 4,
    channels: false,
    presetDump: false, // AM4 backups run their own verbatim dump path (/am4/preset/backup), not the gen-3 one
    blockParamDecode: false,
    telemetry: { tuner: false, outputMeters: false, cpu: false }, // no gen-3 telemetry frames on AM4
    fcModel: false,
    fcLiveRead: false,
    modBind: false, // modifier model is data-only (see modifierModel); the wire binding is not captured
    cabIrs: false,
    supportsSave: true
  };

  #ctx: DriverCtx;
  constructor(ctx: DriverCtx) { this.#ctx = ctx; }

  /** The ONE shared transport (single exclusive MIDI/serial connection, owned by the registry). */
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  #emptySlots = (): Am4Slot[] => [1, 2, 3, 4].map((n) => ({ slot: n, blockType: 'none', pidLow: 0 }));

  // ── VERIFIED-reader plumbing ─────────────────────────────────────────────────────────────────
  // #reader is the descriptor's DeviceReader (getPreset / scanLocations / …). getPreset/scanLocations
  // are optional on the interface, so we assert them present (the AM4 descriptor implements both).
  #reader = AM4_DESCRIPTOR.reader;
  // #readerLock serializes every reader call: the reader drives the RAW transport (bare send + onFrame
  // waiter), which bypasses dev.request's serialization, so two overlapping getPreset calls would
  // interleave on the shared port. Each #withReader appends to this chain and awaits its predecessor.
  #readerLock: Promise<unknown> = Promise.resolve();
  // Brief TTL cache of the last full getPreset dump: a grid render + several blockParams reads on one
  // page load then reuse ONE ~500 ms atomic read (mirrors the gen-3 driver's #gridCache pattern).
  #presetCache: { snap: PresetSnapshot; at: number } | null = null;
  static #PRESET_TTL_MS = 500;

  /** Serialize `fn` behind the in-instance reader mutex so no two reader calls interleave on the
   *  shared transport. Returns fn's result; the lock advances whether fn resolves or throws. */
  async #withReader<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#readerLock.then(fn, fn);
    // Keep the chain alive on rejection (swallow here; the awaited `run` still surfaces the error).
    this.#readerLock = run.catch(() => undefined);
    return run;
  }

  /** Build the reader's DispatchCtx. The reader ONLY touches ctx.conn; the descriptor field is required
   *  by the type but unused on the read path, so we hand it the descriptor itself. */
  #dispatchCtx(): DispatchCtx {
    return { conn: new Am4Conn(this.#lastTransport!), descriptor: AM4_DESCRIPTOR };
  }
  #lastTransport: Transport | null = null;

  /** ONE atomic getPreset dump of the active buffer via the VERIFIED reader, cached briefly (TTL) so a
   *  grid + block-param page load reuses a single ~500 ms read. Serialized behind #withReader. */
  async readPreset(): Promise<PresetSnapshot | null> {
    const now = Date.now();
    if (this.#presetCache && now - this.#presetCache.at < Am4Driver.#PRESET_TTL_MS) return this.#presetCache.snap;
    return this.#withReader(async () => {
      // Re-check the cache inside the lock — a call we queued behind may have just filled it.
      const t = Date.now();
      if (this.#presetCache && t - this.#presetCache.at < Am4Driver.#PRESET_TTL_MS) return this.#presetCache.snap;
      this.#lastTransport = await this.#openTransport();
      try {
        const snap = await this.#reader.getPreset!(this.#dispatchCtx(), {});
        this.#presetCache = { snap, at: Date.now() };
        this.#log(`readPreset: ${snap.slots.length} placed block(s), scene ${snap.active_scene ?? '?'} (${snap._meta.read_duration_ms ?? '?'}ms)`);
        return snap;
      } catch (e) {
        this.#log(`readPreset failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }

  /** One atomic fn-0x1F read of the preset structure → the 4 slots' block types + preset name + scene. */
  async #readStructure(): Promise<{ slots: Am4Slot[]; name: string; scene: number } | null> {
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
        this.#log(`struct[192]: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
        const hits: string[] = [];
        for (let o = 0; o + 4 <= STRUCT_BYTES; o++) { const v = int32LE(b, o); if (v && BLOCK_NAMES_BY_VALUE[v]) hits.push(`0x${o.toString(16)}=${BLOCK_NAMES_BY_VALUE[v]}`); }
        this.#log(`block-code scan: ${hits.join(' ') || '(none)'}`);
      }
      const slots: Am4Slot[] = STRUCT_SLOT_OFFSETS.map((off, i) => {
        const code = int32LE(b, off);
        return { slot: i + 1, blockType: BLOCK_NAMES_BY_VALUE[code] ?? (code ? `0x${code.toString(16)}` : 'none'), pidLow: code };
      });
      return { slots, name: asciiAt(b, STRUCT_NAME_OFFSET, 32), scene: int32LE(b, STRUCT_SCENE_OFFSET) };
    } catch {
      return null;
    }
  }

  /** Read the 4 signal-chain slots → which block sits in each (the AM4 equivalent of the grid). */
  async slots(): Promise<Am4Slot[]> {
    const out = (await this.#readStructure())?.slots ?? this.#emptySlots();
    this.#log(`slots: ${out.map((s) => `${s.slot}:${s.blockType}`).join(' ')}`);
    return out;
  }

  /** The 4 slots as a PresetGridDTO (1 row × 4, linear chain) so Axis renders the AM4 on the existing
   *  Signal Grid — no separate view needed to get it on screen + testable. */
  async grid(): Promise<PresetGridDTO> {
    const s = await this.#readStructure();
    const slots = s?.slots ?? this.#emptySlots();
    this.#log(`grid: "${s?.name ?? ''}" — ${slots.map((x) => x.blockType).join(', ')}`);
    const cells = slots.map((sl, i) => ({
      row: 0,
      col: i,
      effectId: sl.pidLow,
      name: sl.blockType === 'none' ? '' : sl.blockType,
      isShunt: sl.blockType === 'none',
      routeFlag: 0,
      fromRows: i > 0 ? [0] : [], // linear: each slot feeds from the previous
      // ADDITIVE (Phase 6): the AM4 block dictionary is already slug-shaped ('amp', 'drive', …) —
      // surface it so Axis can key params/help/icons without its `!c.pack` gates. Omitted for
      // empty/unknown cells (nothing derivable there).
      ...(sl.pidLow && BLOCK_NAMES_BY_VALUE[sl.pidLow] ? { slug: BLOCK_NAMES_BY_VALUE[sl.pidLow] } : {})
    }));
    return { model: 'am4', name: s?.name ?? '', crcValid: true, rows: 1, cols: 4, scenes: [], cells, source: 'dump' };
  }

  /** Placed blocks in the unified PresetBlockDTO shape (GET /preset/blocks): the 4-slot chain as
   *  row 1 / col 1..4, fromRows [] (linear — the grid DTO carries the chain), channel null (no
   *  channels on AM4). Bypass state rides the TTL-cached atomic reader dump (the same read
   *  blockParams uses); null when that read is unavailable. */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const s = await this.#readStructure();
    const slots = (s?.slots ?? this.#emptySlots()).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none');
    const snap = slots.length ? await this.readPreset() : null;
    return slots.map((sl) => {
      const slug = BLOCK_NAMES_BY_VALUE[sl.pidLow] ?? sl.blockType;
      const byp = snap?.slots.find((x) => x.block_type === slug)?.bypassed;
      return { slug, name: sl.blockType, effectId: sl.pidLow, row: 1, col: sl.slot, fromRows: [], bypassed: byp ?? null, channel: null };
    });
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
  async blockParams(pidLow: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null }> {
    const blockName = BLOCK_NAMES_BY_VALUE[pidLow];
    if (!blockName || blockName === 'none') {
      this.#log(`blockParams: unknown pidLow ${pidLow}`);
      return { block: blockName ?? `0x${pidLow.toString(16)}`, slug: blockName ?? '', page: -1, named: [], enums: [], type: null };
    }
    const snap = await this.readPreset();
    // Find the placed slot whose block_type is this block, then its DECODED param dict (flat, or the one
    // active-channel dict for channel-bearing blocks — getPreset nests exactly one channel per slot).
    const slot = snap?.slots.find((s) => s.block_type === blockName);
    const decoded = this.#slotParamValues(slot);
    // The reader's decoded keys should match KNOWN_PARAMS names verbatim, but casing/space/underscore
    // drift between the catalog and the descriptor reader would silently drop every param (display
    // undefined → skipped), leaving a block like `amp` with 154 recovered knobs rendering empty. Index
    // the decoded dict by a normalized key so a cosmetic mismatch still resolves to the right value.
    const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '');
    const decByNorm = new Map(Object.entries(decoded).map(([k, v]) => [norm(k), v]));
    const lookup = (name: string) => (name in decoded ? decoded[name] : decByNorm.get(norm(name)));

    const params = Object.values(KNOWN_PARAMS).filter((p) => p.block === blockName) as Param[];
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    for (const p of params) {
      const display = lookup(p.name);
      if (display === undefined) continue; // param not in the dump (channel-gated / not placed)
      if (p.unit === 'enum') {
        const options = Object.entries(p.enumValues ?? {}).map(([v, label]) => ({ value: Number(v), label }));
        const value = this.#enumOrdinal(p, display);
        // the block's own type selector is surfaced separately (like gen-3's `type`), not as a plain enum
        if (p.name === 'type') { type = { value, name: p.enumValues?.[value] ?? String(display) }; continue; }
        enums.push({ id: p.pidHigh, name: am4ParamLabel(p), value, options });
      } else {
        const value = typeof display === 'number' ? display : Number(display) || 0;
        named.push({
          id: p.pidHigh,
          name: am4ParamLabel(p),
          value,
          norm: this.#normOf(p, value),
          unit: AM4_UNIT_LABEL[p.unit] ?? undefined,
          min: p.displayMin,
          max: p.displayMax,
          log: p.scaling === 'log10' || undefined
        });
      }
    }
    // bypass state — the reader already read it into slot.bypassed as part of the same atomic dump, so we
    // surface it as a leading virtual enum (gen-3 exposes bypass via the grid) with no extra round-trip.
    if (slot && slot.bypassed !== undefined) {
      enums.unshift({ id: 0x0003, name: 'Bypass', value: slot.bypassed ? 1 : 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] });
    }
    this.#log(`blockParams ${blockName} (pidLow ${pidLow}): ${named.length} knobs, ${enums.length} enums${type ? ` type=${type.name}` : ''}`);
    return { block: blockName, slug: blockName, page: -1, named, enums, type };
  }

  /** The decoded (display-value) param dict for a placed slot: `params` on non-channel blocks, else the
   *  single active-channel dict the reader nested under `params_by_channel`. Empty when the slot is absent. */
  #slotParamValues(slot: PresetSnapshot['slots'][number] | undefined): Record<string, number | string> {
    if (!slot) return {};
    if (slot.params) return slot.params as Record<string, number | string>;
    const byCh = slot.params_by_channel;
    if (byCh) { const first = Object.values(byCh)[0]; if (first) return first as Record<string, number | string>; }
    return {};
  }

  /** Reverse a decoded enum DISPLAY value back to its wire ordinal: the reader hands us `enumValues[wire]`
   *  (a label) or the raw ordinal when unlabeled. Match the label against the enum table; fall back to a
   *  numeric coercion (the reader's raw-int fallback path). */
  #enumOrdinal(p: Param, display: number | string): number {
    if (typeof display === 'number') return display;
    for (const [ord, label] of Object.entries(p.enumValues ?? {})) if (label === display) return Number(ord);
    return Number(display) || 0;
  }

  /** Slider position (0..1) of a display value within [displayMin, displayMax] — the inverse of the
   *  package's decode(): linear by default, log10 for log-scaled params. Purely presentational (Axis uses
   *  it to seat the knob); clamped to [0,1] and 0 on a degenerate range. */
  #normOf(p: Param, value: number): number {
    const { displayMin: lo, displayMax: hi } = p;
    let n: number;
    if (p.scaling === 'log10' && lo > 0 && hi > 0 && hi !== lo) n = Math.log(value / lo) / Math.log(hi / lo);
    else if (hi !== lo) n = (value - lo) / (hi - lo);
    else n = 0;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
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
   *  Serialized behind #withReader. `scanned[i]` is location index i (the scan starts at 0), so we map by
   *  offset; if the reader bailed early (`failed_at`) the remaining locations are reported empty. `signal`
   *  can veto the scan before it starts — scanLocations reads the whole range atomically, so it cannot
   *  interrupt mid-scan (an already-aborted signal returns an all-empty list without touching the wire). */
  async scanPresets(signal?: AbortSignal): Promise<{ count: number; presets: { location: number; code: string; name: string; isEmpty: boolean }[] }> {
    const presets: { location: number; code: string; name: string; isEmpty: boolean }[] = [];
    if (signal?.aborted) {
      for (let location = 0; location < TOTAL_LOCATIONS; location++) presets.push({ location, code: formatLocationCode(location), name: '', isEmpty: true });
      return { count: presets.length, presets };
    }
    const result = await this.#withReader(async () => {
      this.#lastTransport = await this.#openTransport();
      return this.#reader.scanLocations!(this.#dispatchCtx(), 0, TOTAL_LOCATIONS - 1);
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
    this.#presetCache = null;
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Write a discrete/enum param by wire ADDRESS to a raw internal value (the enum ordinal). */
  async setParamValue(pidLow: number, pidHigh: number, value: number) {
    const dev = await this.#openTransport();
    const frame = buildSetFloatParam({ pidLow, pidHigh }, value);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#presetCache = null;
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Generic driver write (unified PUT /preset/blocks/:addr/params/:paramId): addr = pidLow,
   *  paramId = pidHigh. continuous:true → SET_NORM with `value` as the 0..1 norm; continuous:false →
   *  discrete/enum ordinal write. Thin dispatch over the hardware-verified wire methods. */
  async setParam(pidLow: number, pidHigh: number, value: number, continuous: boolean) {
    return continuous ? this.setParamNorm(pidLow, pidHigh, value) : this.setParamValue(pidLow, pidHigh, value);
  }

  /** Toggle/set a block's bypass by its pidLow. */
  async setBypass(blockPidLow: number, bypassed: boolean) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetBlockBypass(blockPidLow, bypassed));
    return { ok: true };
  }

  /** Switch the active scene (0..3). */
  async switchScene(index: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchScene(index));
    return { ok: true, scene: index };
  }

  /** Current scene index (0-based), read from the atomic fn-0x1F preset structure. */
  async getScene(): Promise<{ index: number }> {
    const s = await this.#readStructure();
    return { index: s?.scene ?? 0 };
  }

  /** Generic driver scene switch (unified POST /scene). */
  async setScene(index: number) {
    return this.switchScene(index);
  }

  /** Switch the active preset by location index (0..103, A01..Z04). */
  async switchPreset(location: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchPreset(location));
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
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const dev = await this.#openTransport();
    const req = location == null ? buildRequestActiveBufferDump() : buildRequestStoredPresetDump(location);
    const frames = await dev.request(req, { timeoutMs: 5000, quietMs: 200, match: (fs) => fs.some((f) => f[4] === 0x15 && f[5] === 0x79) });
    const dumpMsgs = frames.filter((f) => f[4] === 0x15 && (f[5] === 0x77 || f[5] === 0x78 || f[5] === 0x79));
    const raw = Uint8Array.from(dumpMsgs.flat());
    const dump = parseAm4PresetDump(raw); // validates every envelope + checksum; throws on malformed
    const loc = am4DumpLocation(dump);
    this.#log(`backup ${loc.code ?? '(active)'} "${decodeAm4PresetNameFromFrame(dump.raw)}" ${dump.raw.length}B`);
    return { location: loc.active ? null : (loc.index ?? null), code: loc.code ?? null, name: decodeAm4PresetNameFromFrame(dump.raw), bytes: [...dump.raw] };
  }

  /** Restore a preset .syx (single 12,352-byte dump) to the device by verbatim re-emit (goes back to
   *  the location encoded in the dump's 0x77 header). Validates the dump before sending. */
  async restorePreset(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }> {
    const dump = parseAm4PresetDump(Uint8Array.from(bytes)); // validate first — throws on bad envelope/checksum
    const loc = am4DumpLocation(dump);
    const dev = await this.#openTransport();
    for (const msg of splitSysex([...dump.raw])) await dev.sendQueued(msg);
    this.#log(`restore -> ${loc.code ?? '(active)'} (${dump.raw.length}B, 6 msgs)`);
    return { ok: true, location: loc.active ? null : (loc.index ?? null), code: loc.code ?? null };
  }

  /** Offline decode of an AM4 .syx (a single dump or a whole bank, e.g. the 104-preset factory file):
   *  returns each preset's location + name. No device needed — for library import / browsing. */
  decodeSyx(bytes: number[]): { count: number; presets: { index: number; location: number | null; code: string | null; name: string }[] } {
    const raw = Uint8Array.from(bytes);
    const dumps = raw.length > AM4_PRESET_FRAME_SIZE && raw.length % AM4_PRESET_FRAME_SIZE === 0
      ? parseAm4PresetBank(raw)
      : [parseAm4PresetDump(raw)];
    const presets = dumps.map((d, index) => {
      const l = am4DumpLocation(d);
      return { index, location: l.active ? null : (l.index ?? null), code: l.code ?? null, name: decodeAm4PresetNameFromFrame(d.raw) };
    });
    return { count: presets.length, presets };
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
