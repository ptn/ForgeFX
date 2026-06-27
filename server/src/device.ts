// High-level FM3 device service. Wire protocol via fractal-midi; catalog/params via defs.
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
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT
} from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { wireToDisplay } from 'fractal-midi/shared';
import { FractalSerial, autoDetectPath } from './transport/serial.js';
import { decodePresetDump } from './codec/fm3PresetGrid.js';
import { allPacks, packBySlug, rosterBySlug, slugForEffectId, type TypeModel } from './defs.js';

const MODEL_FM3 = 0x11;
const FM3_ROWS = 4;
const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer
const CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// pack slug → FM3 catalog family (for device-true ranges/units from fractal-midi)
const SLUG_FAMILY: Record<string, string> = {
  amp: 'DISTORT', cab: 'CABINET', drive: 'FUZZ', comp: 'COMP', multicomp: 'MULTICOMP',
  peq: 'PEQ', geq: 'GEQ', reverb: 'REVERB', delay: 'DELAY', multitap: 'MULTITAP',
  chorus: 'CHORUS', flanger: 'FLANGER', phaser: 'PHASER', rotary: 'ROTARY', tremolo: 'TREMOLO',
  pitch: 'PITCH', wah: 'WAH', filter: 'FILTER', formant: 'FORMANT', enhancer: 'ENHANCER',
  mixer: 'MIXER', volume: 'VOLUME', input: 'INPUT', output: 'OUTPUT', gate: 'GATE',
  synth: 'SYNTH', ringmod: 'RINGMOD', looper: 'LOOPER', resonator: 'RESONATOR'
};
// catalog unit code → display label (blank = show the bare number)
const UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%',
  degrees: '°', semitones: 'st', pf: 'pF', ratio: ':1'
};
// units that mark a musician-facing knob (vs internal 'numeric'/'unverified'/'count'/'enum')
const KNOB_UNITS = new Set([
  'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees'
]);

export interface GridCellDTO { row: number; col: number; effectId: number; name: string; isShunt: boolean; routeFlag: number; fromRows: number[]; }
export interface PresetGridDTO { model: string; name: string; crcValid: boolean; rows: number; cols: number; scenes: string[]; cells: GridCellDTO[]; source: 'dump'; }
export interface PresetBlockDTO { slug: string; name: string; effectId: number; row: number; col: number; fromRows: number[]; bypassed: boolean | null; channel: string | null; }
export interface NamedParam { name: string; value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean; }

class Device {
  #serial: FractalSerial | null = null;
  #gridCache: { grid: PresetGridDTO; at: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load

  get port() { return this.#serial?.path ?? autoDetectPath(); }

  async #conn(): Promise<FractalSerial> {
    if (this.#serial?.isOpen) return this.#serial;
    this.#serial = new FractalSerial();
    await this.#serial.open();
    return this.#serial;
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
    const path = autoDetectPath();
    return { ok: !!path, device: 'FM3' };
  }
  async deviceInfo() {
    return { model: 'FM3', modelByte: '0x11', firmware: null as null | { version: string; build: string }, port: this.port };
  }

  /** Current preset number + name (one query). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const dev = await this.#conn();
    const frames = await dev.request(buildQueryPatchName('current', MODEL_FM3), {
      timeoutMs: 1200,
      match: (fs) => fs.some((f) => isQueryPatchNameResponse(f, MODEL_FM3))
    });
    const f = frames.find((x) => isQueryPatchNameResponse(x, MODEL_FM3));
    if (!f) return { number: -1, name: '' };
    const r = parseQueryPatchNameResponse(f, MODEL_FM3);
    return { number: r.presetNumber, name: r.name };
  }

  /** Routing grid via the hardware-validated dump decoder. Deduped + short-TTL cached. */
  async grid(): Promise<PresetGridDTO> {
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

  async #dumpGrid(): Promise<PresetGridDTO> {
    const dev = await this.#conn();
    const frames = await dev.request(buildRequestPresetDump(EDIT_BUFFER, MODEL_FM3), {
      timeoutMs: 5000,
      quietMs: 180,
      match: (fs) => fs.some((f) => f[5] === 0x79) // 0x79 = dump terminator
    });
    const d = decodePresetDump(frames, MODEL_FM3);
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

  /** Effect id of the placed instance for a slug. Uses the last known grid (effect ids
   * are stable until a structural edit, which invalidates the cache) so high-frequency
   * writes never trigger a fresh dump mid-drag. */
  async #effectIdForSlug(slug: string): Promise<number | null> {
    const g = this.#gridCache?.grid ?? (await this.grid());
    const cell = g.cells.find((c) => !c.isShunt && slugForEffectId(c.effectId) === slug.toLowerCase());
    return cell?.effectId ?? null;
  }

  async #statusByEffectId(): Promise<Map<number, { bypassed: boolean; channel: number }>> {
    const dev = await this.#conn();
    const map = new Map<number, { bypassed: boolean; channel: number }>();
    try {
      // fractal-midi's isStatusDumpResponse is locked to model 0x10 (III), so match the
      // 0x13 frame ourselves (any model) and parse the id-id-dd triples inline.
      const frames = await dev.request(buildStatusDump(MODEL_FM3), { timeoutMs: 1500, match: (fs) => fs.some((f) => f[5] === 0x13) });
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
  blocksCatalog() {
    return allPacks().map((p) => ({ slug: p.slug, name: p.name, page: p.page, paramCount: p.params.length, typeCount: rosterBySlug(p.slug).length }));
  }
  blockTypes(slug: string): TypeModel[] {
    return rosterBySlug(slug);
  }

  /**
   * Read a placed block's params via the fn=0x1F bulk read. The 0x75 body is
   * CHANNEL-BLOCKED: index = channel*stride + paramId, stride = paramCount,
   * channelCount = values.length/stride (per-block, NOT always 4). `norm` = raw/65534
   * (knob position); `value`/`unit` are the device-true DISPLAY reading via FM3_RANGES
   * (e.g. 1.2k Hz, -12 dB) where the cache has a range, else the 0..10 position.
   */
  async blockParams(slug: string): Promise<{ block: string; slug: string; page: number; named: NamedParam[] }> {
    const pack = packBySlug(slug);
    const family = SLUG_FAMILY[slug.toLowerCase()];
    const blockName = pack?.name ?? family ?? slug;
    const page = pack?.page ?? -1;
    if (!family) {
      if (!pack) throw new Error(`unknown block ${slug}`);
      return { block: blockName, slug, page, named: [] }; // no device-true param family mapped
    }
    const defs = FM3_PARAMS_BY_FAMILY[family] ?? [];
    // knob params = continuous, musician-facing: a float range + a real display unit
    // (drops enum selectors, internal 'numeric'/'unverified' params, and bypass flags).
    const knobs = defs.filter((p) => {
      if (FM3_RANGES[family]?.[p.paramId]?.kind !== 'float') return false;
      if (/bypass/i.test(p.displayLabel ?? p.name)) return false;
      return KNOB_UNITS.has(p.unit ?? '');
    });
    const eid = await this.#effectIdForSlug(slug);
    const named: NamedParam[] = [];
    if (eid != null) {
      const dev = await this.#conn();
      try {
        const activeCh = (await this.#statusByEffectId()).get(eid)?.channel ?? 0;
        const frames = await dev.request(buildBlockBulkReadPoll(eid, MODEL_FM3), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = assembleGen3BlockBulkRead(frames, MODEL_FM3);
        const stride = Math.max(1, ...defs.map((p) => p.paramId)) + 1;
        const channelCount = Math.max(1, Math.floor(bulk.values.length / stride));
        const base = Math.min(activeCh, channelCount - 1) * stride;
        for (const p of knobs) {
          const raw = bulk.values[base + p.paramId] ?? 0;
          named.push({ name: p.displayLabel ?? p.name, ...this.#display(family, p.paramId, raw) });
        }
      } catch {
        for (const p of knobs) named.push({ name: p.displayLabel ?? p.name, value: 0, norm: 0 });
      }
    }
    return { block: blockName, slug, page, named };
  }

  /** Map a raw 0..65534 wire value to {value, norm, unit, min, max, log} via the device-true FM3 range.
   * Taper from typecode: middle nibble 4/5 = log10 (e.g. freq cuts), else linear. */
  #display(family: string | undefined, paramId: number, raw: number): { value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean } {
    const norm = clamp01(raw / 65534);
    const range = family ? FM3_RANGES[family]?.[paramId] : undefined;
    if (range && range.kind === 'float' && Number.isFinite(range.displayMin) && Number.isFinite(range.displayMax)) {
      const taperNib = (range.typecode >> 4) & 0xf;
      const log = (taperNib === 4 || taperNib === 5) && range.displayMin > 0;
      const v = wireToDisplay(raw, { displayMin: range.displayMin, displayMax: range.displayMax, displayScale: log ? 'log10' : 'linear' });
      const unitCode = family ? FM3_PARAMS_BY_FAMILY[family]?.find((x) => x.paramId === paramId)?.unit : undefined;
      return { value: round3(v), norm, unit: (unitCode && UNIT_LABEL[unitCode]) || undefined, min: range.displayMin, max: range.displayMax, log: log || undefined };
    }
    return { value: Math.round(norm * 1000) / 100, norm }; // 0..10 fallback
  }

  /** Resolve a param name (display label) → device-true paramId. 'Type' → the model-selector enum. */
  #paramId(family: string, name: string): number | undefined {
    const defs = FM3_PARAMS_BY_FAMILY[family] ?? [];
    if (name.toLowerCase() === 'type') return defs.find((p) => p.unit === 'enum' && /TYPE$/i.test(p.name))?.paramId;
    return defs.find((p) => p.displayLabel === name || p.name === name)?.paramId;
  }

  // ── writes ──
  async setParam(slug: string, param: string, value: number, continuous: boolean) {
    const eid = await this.#effectIdForSlug(slug);
    const family = SLUG_FAMILY[slug.toLowerCase()];
    if (eid == null || !family) return { ok: false };
    const pid = this.#paramId(family, param);
    if (pid == null) return { ok: false };
    // continuous knob writes stream at high frequency → fire-and-forget (instant, like the C#);
    // a typed/discrete write (retype) is rare + worth confirming, so reject-watch it.
    if (continuous) return this.#send(buildSetParameterContinuous(eid, pid, clamp01(value), MODEL_FM3));
    return this.#write(buildSetParameter(eid, pid, value, MODEL_FM3));
  }
  async setBypass(slug: string, bypassed: boolean) {
    const eid = await this.#effectIdForSlug(slug);
    if (eid == null) return { ok: false };
    return this.#send(buildSetBypass(eid, bypassed, MODEL_FM3)); // instant toggle
  }
  async setChannel(slug: string, channel: string) {
    const eid = await this.#effectIdForSlug(slug);
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (eid == null || idx < 0 || idx > 3) return { ok: false };
    return this.#send(buildSetChannel(eid, idx as 0 | 1 | 2 | 3, MODEL_FM3)); // instant
  }
  async placeCell(row: number, col: number, blockId: number) {
    // FM3 needs a cell-select (sub 0x30) before the insert (sub 0x32), or the block
    // lands at the default cell. buildClearBlock IS that select frame (no-op on an
    // empty cell). For blockId 0 this becomes select + insert-0 = clear, like the C#.
    await this.#write(buildClearBlock({ row, col, rows: FM3_ROWS }, MODEL_FM3));
    const r = await this.#write(buildSetGridCell({ row, col, blockId, rows: FM3_ROWS }, MODEL_FM3));
    this.#gridCache = null;
    return r;
  }
  /** Move the device's edit cursor to a cell (sub 0x30) so the FM3 screen follows the UI.
   * Non-destructive: this is the cursor-select frame (no companion = no clear). */
  async selectCell(row: number, col: number) {
    return this.#send(buildClearBlock({ row, col, rows: FM3_ROWS }, MODEL_FM3));
  }
  async cable(srcRow: number, srcCol: number, destRow: number, connect: boolean) {
    const r = await this.#write(buildSetGridRouting({ srcRow, srcCol, destRow, rows: FM3_ROWS, op: connect ? ROUTING_OP_CONNECT : ROUTING_OP_DISCONNECT }, MODEL_FM3));
    this.#gridCache = null;
    return r;
  }
  async selectPreset(n: number) {
    this.#gridCache = null;
    return this.#write(buildSwitchPresetSysEx(n, MODEL_FM3));
  }
  async store(n: number) {
    return this.#write(buildStorePreset(n, MODEL_FM3));
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

export const device = new Device();
