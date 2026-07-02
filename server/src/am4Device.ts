// AM4 device path (model 0x15) — a parallel module to the gen-3 Device. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the gen-3 Device owns (device.openTransport()), since only one device is ever connected at a time.
// Codec is fractal-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
  parseReadResponse,
  isReadResponse,
  BLOCK_SLOT_PID_LOW,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_NAMES_BY_VALUE,
  buildSetParam,
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
  // block-param read (fn 0x1F GET_ALL_PARAMS → 0x74/0x75/0x76 triple) + per-param decode
  buildGetAllParams,
  isReadResponseLong,
  parseLongReadBypassFlag,
  READ_TYPE_LONG,
  KNOWN_PARAMS,
  decode as am4Decode,
  roundDisplayValue,
  formatUnitSuffix,
  BLOCK_TYPE_VALUES,
  TOTAL_LOCATIONS,
  type Param,
  type ParamKey
} from 'forgefx-midi/am4';
import { device, type PresetGridDTO, type NamedParam, type EnumParam } from './device.js';

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

export interface Am4Slot {
  slot: number; // 1..4 signal-chain position
  blockType: string; // canonical block name, 'none' if empty
  pidLow: number; // the block's pidLow (its type value)
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

// ── Block-param read (fn 0x1F GET_ALL_PARAMS → the 0x74 header / 0x75 chunk(s) / 0x76 footer triple).
// The package's am4 shared/readOps.readAllParams collects this over a MidiConnection; we mirror its
// framing here so the whole read stays inside ForgeFX's serialized request chain (dev.request) — the
// helper functions below are byte-exact copies of readOps' private decode14/decode16Packed/isAm4Fn/
// decodeChunkPayload + decodeChannelParams (reader.ts). See "package export gap" in the findings note:
// buildGetAllParams IS exported, but the collect + chunk-decode helpers are not, so they're replicated.
const AM4_FN_ALL_HEADER = 0x74; // targetId + itemCount
const AM4_FN_ALL_CHUNK = 0x75;  // packed 16-bit values
const AM4_FN_ALL_FOOTER = 0x76; // end of the broadcast triple
/** F0 00 01 74 15 <fn> … — AM4 envelope for the given function byte. */
const isAm4Fn = (b: number[], fn: number) =>
  b.length >= 7 && b[0] === 0xf0 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x74 && b[4] === 0x15 && b[5] === fn;
const decode14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const decode16Packed = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
/** 0x75 chunk body → its 16-bit ushort values (bytes[6..7]=itemCount, then N×3 packed septets). */
function decodeChunkPayload(bytes: number[]): number[] {
  const itemCount = decode14(bytes[6]!, bytes[7]!);
  const out: number[] = [];
  const start = 8, end = bytes.length - 2; // exclude checksum + F7
  for (let i = 0; i < itemCount; i++) {
    const off = start + i * 3;
    if (off + 2 >= end) break;
    out.push(decode16Packed(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!));
  }
  return out;
}
/** One block chunk: its announced itemCount + the flat 16-bit value sequence (channel-blocked). */
interface Am4Chunk { itemCount: number; values: number[]; }
/** Assemble the 0x74/0x75/0x76 triple (targetId=pidLow) from the collected reply frames. */
function assembleAllParams(frames: number[][], pidLow: number): Am4Chunk | null {
  let header: { itemCount: number } | undefined;
  const values: number[] = [];
  for (const f of frames) {
    if (isAm4Fn(f, AM4_FN_ALL_HEADER)) {
      if (decode14(f[6]!, f[7]!) !== pidLow || header) continue; // unrelated / duplicate
      header = { itemCount: decode14(f[8]!, f[9]!) };
    } else if (isAm4Fn(f, AM4_FN_ALL_CHUNK) && header) {
      for (const v of decodeChunkPayload(f)) values.push(v);
    }
  }
  return header ? { itemCount: header.itemCount, values } : null;
}
/** Decode one chunk 16-bit value → display value, mirroring get_param's per-param rule (reader.ts
 *  decodeChunkValue): enum → enumValues[wire] (raw fallback); else internal = wire/65534 → am4Decode. */
function decodeChunkValue(param: Param, wire: number): number | string {
  if (param.unit === 'enum') return param.enumValues?.[wire] ?? wire;
  return roundDisplayValue(param, am4Decode(param, wire / 65534));
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

class Am4Device {
  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  #emptySlots = (): Am4Slot[] => [1, 2, 3, 4].map((n) => ({ slot: n, blockType: 'none', pidLow: 0 }));

  /** One atomic fn-0x1F read of the preset structure → the 4 slots' block types + preset name + scene. */
  async #readStructure(): Promise<{ slots: Am4Slot[]; name: string; scene: number } | null> {
    const dev = await device.openTransport();
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
      fromRows: i > 0 ? [0] : [] // linear: each slot feeds from the previous
    }));
    return { model: 'am4', name: s?.name ?? '', crcValid: true, rows: 1, cols: 4, scenes: [], cells, source: 'dump' };
  }

  /** Read every parameter of the block sitting at `pidLow` (its block-type value, e.g. 58=amp, 118=drive
   *  — the `effectId` the grid/slots report) and return it in the SAME shape as the gen-3 Device.blockParams
   *  so Axis renders the AM4's params through the existing block editor unchanged.
   *
   *  Read path: the fn 0x1F GET_ALL_PARAMS broadcast (0x74 header → 0x75 chunk(s) → 0x76 footer), collected
   *  via ONE dev.request per pidLow with a match on the 0x76 footer — this mirrors the package's
   *  am4 shared/readOps.readAllParams framing but stays inside ForgeFX's serialized request chain (so it
   *  can't interleave with telemetry / other reads). We read the ACTIVE channel (quarter 0 = channel A,
   *  matching gen-3's activeCh=0) out of the channel-blocked chunk. This is far cheaper than N per-param
   *  fn 0x02 GETs (~1-2 round-trips per block vs 200+ for the amp).
   *
   *  Decode reuses the package's per-param pipeline verbatim: enums via `param.enumValues`, continuous via
   *  `decode()` + `roundDisplayValue()`; ranges/units/log from the KNOWN_PARAMS entry. `named` carries the
   *  continuous knobs, `enums` the discrete selectors — exactly as gen-3 splits them. */
  async blockParams(pidLow: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null }> {
    const blockName = BLOCK_NAMES_BY_VALUE[pidLow];
    if (!blockName || blockName === 'none') {
      this.#log(`blockParams: unknown pidLow ${pidLow}`);
      return { block: blockName ?? `0x${pidLow.toString(16)}`, slug: blockName ?? '', page: -1, named: [], enums: [], type: null };
    }
    // The block's params can span more than one pidLow register (amp = 58 tone-stack + 62 cab + 206 misc),
    // so gather every distinct pidLow this block owns and read each as its own fn 0x1F chunk.
    const params = Object.values(KNOWN_PARAMS).filter((p) => p.block === blockName) as Param[];
    const pidLows = [...new Set(params.map((p) => p.pidLow))].sort((a, b) => a - b);
    const dev = await device.openTransport();
    const chunks = new Map<number, Am4Chunk>();
    for (const pl of pidLows) {
      const req = buildGetAllParams(pl);
      try {
        const frames = await dev.request(req, { timeoutMs: dev.slow ? 2000 : 800, quietMs: dev.slow ? 200 : 80, match: (fs) => fs.some((f) => isAm4Fn(f, AM4_FN_ALL_FOOTER)) });
        const asm = assembleAllParams(frames, pl);
        if (asm) chunks.set(pl, asm);
      } catch {
        /* leave this pidLow's chunk unread — its params just won't appear */
      }
    }
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    for (const p of params) {
      const chunk = chunks.get(p.pidLow);
      if (!chunk) continue;
      // channel-blocked chunk: idx = channel*stride + pidHigh (stride = itemCount/4) for channel-bearing
      // blocks; else a single copy at pidHigh. We read channel A (quarter 0).
      const idx = chunk.itemCount > 0 && chunk.itemCount % 4 === 0 ? (chunk.itemCount / 4) * 0 + p.pidHigh : p.pidHigh;
      if (idx >= chunk.values.length) continue;
      const wire = chunk.values[idx]!;
      if (p.unit === 'enum') {
        const options = Object.entries(p.enumValues ?? {}).map(([v, label]) => ({ value: Number(v), label }));
        const value = wire;
        // the block's own type selector is surfaced separately (like gen-3's `type`), not as a plain enum
        if (p.name === 'type') { type = { value, name: p.enumValues?.[value] ?? '' }; continue; }
        enums.push({ id: p.pidHigh, name: am4ParamLabel(p), value, options });
      } else {
        const display = decodeChunkValue(p, wire);
        named.push({
          id: p.pidHigh,
          name: am4ParamLabel(p),
          value: typeof display === 'number' ? display : Number(display) || 0,
          norm: wire / 65534,
          unit: AM4_UNIT_LABEL[p.unit] ?? undefined,
          min: p.displayMin,
          max: p.displayMax,
          log: p.scaling === 'log10' || undefined
        });
      }
    }
    // bypass state (long-form read, action 0x0D) — best-effort, appended as a virtual enum so the UI
    // gets the block's active/bypassed state alongside its params (gen-3 exposes bypass via the grid).
    try {
      const readBytes = buildReadParam({ pidLow, pidHigh: 0x0003 }, READ_TYPE_LONG);
      const bf = await dev.request(readBytes, { timeoutMs: dev.slow ? 1500 : 600, quietMs: dev.slow ? 150 : 60, match: (fs) => fs.some((f) => isReadResponseLong(readBytes, f)) });
      const resp = bf.find((f) => isReadResponseLong(readBytes, f));
      if (resp) {
        const bypassed = parseLongReadBypassFlag(resp);
        enums.unshift({ id: 0x0003, name: 'Bypass', value: bypassed ? 1 : 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] });
      }
    } catch {
      /* bypass read failed — omit it, params are still valid */
    }
    this.#log(`blockParams ${blockName} (pidLow ${pidLow}): ${named.length} knobs, ${enums.length} enums${type ? ` type=${type.name}` : ''}`);
    return { block: blockName, slug: blockName, page: -1, named, enums, type };
  }

  /** One READ_PRESET_NAME (action 0x0012) round-trip for a location — non-destructive (does not load the
   *  preset). Returns the decoded name + whether the slot is empty, or null if no name frame came back. */
  async #readPresetName(dev: Awaited<ReturnType<typeof device.openTransport>>, location: number): Promise<{ name: string; isEmpty: boolean } | null> {
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
    const dev = await device.openTransport();
    const r = await this.#readPresetName(dev, location);
    return { location, name: r?.name ?? '' };
  }

  /** Scan the AM4 preset library — every stored location (0..103, A01..Z04) by name, one non-destructive
   *  READ_PRESET_NAME per slot. Serial by necessity (the AM4 correlates name responses by arrival order,
   *  so reads can't be pipelined) → ~104 MIDI round-trips (~60-120ms each on serial, so on the order of
   *  10s). `signal` lets a caller cancel a long scan; on abort we return what we've read so far. Locations
   *  whose name frame didn't decode are reported with isEmpty:true and a blank name (best-effort). */
  async scanPresets(signal?: AbortSignal): Promise<{ count: number; presets: { location: number; code: string; name: string; isEmpty: boolean }[] }> {
    const dev = await device.openTransport();
    const presets: { location: number; code: string; name: string; isEmpty: boolean }[] = [];
    for (let location = 0; location < TOTAL_LOCATIONS; location++) {
      if (signal?.aborted) break;
      const r = await this.#readPresetName(dev, location).catch(() => null);
      presets.push({ location, code: formatLocationCode(location), name: r?.name ?? '', isEmpty: r ? r.isEmpty : true });
    }
    this.#log(`scanPresets: read ${presets.length}/${TOTAL_LOCATIONS} (${presets.filter((p) => !p.isEmpty).length} named)`);
    return { count: presets.length, presets };
  }

  /** Set a parameter by its display value (e.g. 'amp.gain', 7.5). */
  async setParam(key: string, displayValue: number) {
    const dev = await device.openTransport();
    const frame = buildSetParam(key as ParamKey, displayValue);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 60, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Toggle/set a block's bypass by its pidLow. */
  async setBypass(blockPidLow: number, bypassed: boolean) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSetBlockBypass(blockPidLow, bypassed));
    return { ok: true };
  }

  /** Switch the active scene (0..3). */
  async switchScene(index: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSwitchScene(index));
    return { ok: true, scene: index };
  }

  /** Switch the active preset by location index (0..103, A01..Z04). */
  async switchPreset(location: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSwitchPreset(location));
    return { ok: true, location };
  }

  /** Save the active edit buffer to a stored location (0..103). Wire action 0x1B —
   *  hardware-confirmed byte-exact against a live AM4 capture (2026-07-02). */
  async storePreset(location: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSaveToLocation(location));
    return { ok: true, location, code: formatLocationCode(location) };
  }

  /** Back up a preset off the device as a verbatim .syx dump (the 6-message 0x77/0x78/0x79 stream).
   *  `location` omitted → the active edit buffer. Returns the raw bytes (byte-identical, replayable)
   *  plus the decoded location + name. Community-beta: the dump-request path is capture-derived. */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const dev = await device.openTransport();
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
    const dev = await device.openTransport();
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

export const am4 = new Am4Device();
