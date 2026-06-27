// High-level FM3 device service. Wire protocol via fractal-midi; catalog/params via defs.
import {
  buildQueryPatchName,
  isQueryPatchNameResponse,
  parseQueryPatchNameResponse,
  buildStatusDump,
  isStatusDumpResponse,
  parseStatusDumpResponse,
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
import { FractalSerial, autoDetectPath } from './transport/serial.js';
import { decodePresetDump } from './codec/fm3PresetGrid.js';
import { allPacks, packBySlug, rosterBySlug, slugForEffectId, paramIndex, type TypeModel } from './defs.js';

const MODEL_FM3 = 0x11;
const FM3_ROWS = 4;
const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer
const CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export interface GridCellDTO { row: number; col: number; effectId: number; name: string; isShunt: boolean; routeFlag: number; fromRows: number[]; }
export interface PresetGridDTO { model: string; name: string; crcValid: boolean; rows: number; cols: number; scenes: string[]; cells: GridCellDTO[]; source: 'dump'; }
export interface PresetBlockDTO { slug: string; name: string; effectId: number; row: number; col: number; fromRows: number[]; bypassed: boolean | null; channel: string | null; }
export interface NamedParam { name: string; value: number; norm: number; unit?: string; }

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

  /** Send a write frame; treat any 0x64 MULTIPURPOSE_RESPONSE as a rejection. */
  async #write(bytes: number[]): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const frames = await dev.request(bytes, { timeoutMs: 200, quietMs: 70, match: (fs) => fs.some((f) => f[5] === 0x64) });
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

  async #grid(): Promise<PresetGridDTO> {
    return this.grid();
  }

  /** Effect id of the placed instance for a slug (first match in the current grid). */
  async #effectIdForSlug(slug: string): Promise<number | null> {
    const g = await this.#grid();
    const cell = g.cells.find((c) => !c.isShunt && slugForEffectId(c.effectId) === slug.toLowerCase());
    return cell?.effectId ?? null;
  }

  async #statusByEffectId(): Promise<Map<number, { bypassed: boolean; channel: number }>> {
    const dev = await this.#conn();
    const map = new Map<number, { bypassed: boolean; channel: number }>();
    try {
      const frames = await dev.request(buildStatusDump(MODEL_FM3), { timeoutMs: 1500, match: (fs) => fs.some((f) => isStatusDumpResponse(f)) });
      const f = frames.find((x) => isStatusDumpResponse(x));
      if (f) for (const e of parseStatusDumpResponse(f)) map.set(e.effectId, { bypassed: e.bypassed, channel: e.channel });
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

  /** Read a placed block's params (bulk read), mapped through its definition pack. */
  async blockParams(slug: string): Promise<{ block: string; slug: string; page: number; named: NamedParam[] }> {
    const pack = packBySlug(slug);
    if (!pack) throw new Error(`unknown block ${slug}`);
    const eid = await this.#effectIdForSlug(slug);
    const named: NamedParam[] = [];
    if (eid != null) {
      const dev = await this.#conn();
      try {
        const frames = await dev.request(buildBlockBulkReadPoll(eid, MODEL_FM3), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = assembleGen3BlockBulkRead(frames, MODEL_FM3);
        for (const p of pack.params) {
          if (p.name.toLowerCase() === 'type') continue;
          const raw = bulk.values[p.index] ?? 0;
          named.push({ name: p.name, value: raw, norm: clamp01(raw / 65535), unit: p.unit });
        }
      } catch {
        // fall back to a structural list (names only) so the editor still renders
        for (const p of pack.params) if (p.name.toLowerCase() !== 'type') named.push({ name: p.name, value: 0, norm: 0, unit: p.unit });
      }
    }
    return { block: pack.name, slug: pack.slug, page: pack.page, named };
  }

  // ── writes ──
  async setParam(slug: string, param: string, value: number, continuous: boolean) {
    const eid = await this.#effectIdForSlug(slug);
    const pid = paramIndex(slug, param);
    if (eid == null || pid == null) return { ok: false };
    const frame = continuous ? buildSetParameterContinuous(eid, pid, clamp01(value), MODEL_FM3) : buildSetParameter(eid, pid, value, MODEL_FM3);
    return this.#write(frame);
  }
  async setBypass(slug: string, bypassed: boolean) {
    const eid = await this.#effectIdForSlug(slug);
    if (eid == null) return { ok: false };
    return this.#write(buildSetBypass(eid, bypassed, MODEL_FM3));
  }
  async setChannel(slug: string, channel: string) {
    const eid = await this.#effectIdForSlug(slug);
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (eid == null || idx < 0 || idx > 3) return { ok: false };
    return this.#write(buildSetChannel(eid, idx as 0 | 1 | 2 | 3, MODEL_FM3));
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

export const device = new Device();
