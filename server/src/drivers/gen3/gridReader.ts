// Gen-3 routing-grid collaborator: the deduped/TTL grid read (FM3 live sub-0x2E layout or preset
// dump), scene labels, and the placed-block / scene-state projections. Split out of gen3.ts so the
// driver facade stops owning the grid cache + fallback branch.
import { buildRequestGridLayout, parseGen3GridLayout } from 'forgefx-midi/gen3/axe-fx-iii';
import { effectName, slugForEffectId } from 'forgefx-midi/devices/gen3';
import type { PresetGridDTO, PresetBlockDTO } from '../types.js';
import {
  EDIT_BUFFER, FM3_MODEL, GEN3_SCENES, GEN3_SHUNT_ID_BASE, SHUNT_INDEX_OFFSET,
  rowsFromMask, isGridLayoutResponse, CH_LETTERS,
} from './support.js';
import type { Gen3Host } from './host.js';
import type { PresetDecoder } from './presetDecoder.js';

export class GridReader {
  #host: Gen3Host;
  #decoder: PresetDecoder;
  #gridCache: { grid: PresetGridDTO; at: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load

  /** Scene names by preset number. The sub-0x2E frame carries none, so they come from the 8 small
   *  fn-0x0E QUERY SCENE NAME reads — cached per preset, since only a preset change can alter them
   *  (a rename goes through setSceneName, which busts the cache). */
  #sceneCache: { preset: number; names: string[] } | null = null;

  constructor(host: Gen3Host, decoder: PresetDecoder) {
    this.#host = host;
    this.#decoder = decoder;
  }

  /** Bust the live-grid + scene caches after an edit-buffer / grid-structure change. */
  invalidate(): void { this.#gridCache = null; }

  /** Bust the cached scene labels after a scene rename. */
  invalidateScenes(): void { this.#sceneCache = null; }

  /** Routing grid. Deduped + short-TTL cached; FM3 reads it live, everything else dumps the preset. */
  async grid(): Promise<PresetGridDTO> {
    if (this.#gridInflight) return this.#gridInflight; // coalesce concurrent callers
    if (this.#gridCache && Date.now() - this.#gridCache.at < GridReader.GRID_TTL_MS) return this.#gridCache.grid;
    this.#gridInflight = this.#readGrid();
    try {
      const g = await this.#gridInflight;
      this.#gridCache = { grid: g, at: Date.now() };
      return g;
    } finally {
      this.#gridInflight = null;
    }
  }

  /** FM3: read the routing grid with the LIVE sub-0x2E layout query (a single small frame, tens of
   *  milliseconds) instead of pulling and Huffman-decompressing the whole preset (~1.2s on a slow
   *  link — the audible gap after a preset change). This is what FM3-Edit does: it never dumps a
   *  preset to draw the grid, it polls this query continuously.
   *
   *  Fallback, never a hard dependency: any failure (timeout, no reply, short/malformed frame, no
   *  cached scene names) falls through to the dump. A slow-but-correct grid always beats a wrong one. */
  async #readGrid(): Promise<PresetGridDTO> {
    if (this.#host.profile.model === FM3_MODEL) {
      try {
        return await this.#liveGrid();
      } catch (e) {
        console.log(`[forgefx] liveGrid: falling back to the preset dump (${(e as Error)?.message ?? String(e)})`);
      }
    }
    return this.#dumpGrid();
  }

  /** Read scene labels separately from the live grid. Eight serial reads must never delay the canvas. */
  async sceneNames(): Promise<string[]> {
    const ref = await this.#host.presetRef();
    return ref.number >= 0 ? this.#sceneNames(ref.number) : [];
  }

  async #sceneNames(preset: number): Promise<string[]> {
    if (this.#sceneCache?.preset === preset) return this.#sceneCache.names;
    const dev = await this.#host.conn();
    const names: string[] = [];
    for (let i = 0; i < GEN3_SCENES; i++) {
      const frames = await dev.request(this.#host.codec.buildQuerySceneName(i), {
        timeoutMs: dev.slow ? 1500 : 600,
        quietMs: dev.slow ? 120 : 40,
        match: (fs) => fs.some((f) => this.#host.codec.isQuerySceneNameResponse(f))
      });
      const f = frames.find((x) => this.#host.codec.isQuerySceneNameResponse(x));
      if (!f) throw new Error(`no scene-name reply for scene ${i}`);
      names.push(this.#host.codec.parseQuerySceneNameResponse(f).name);
    }
    this.#sceneCache = { preset, names };
    return names;
  }

  /** Live routing grid (fn 0x01 / sub 0x2E), FM3 only. Three small round trips in the steady state
   *  (preset ref + grid frame, scene names cached), ten right after a preset change. */
  async #liveGrid(): Promise<PresetGridDTO> {
    const prof = this.#host.profile;
    const dev = await this.#host.conn();
    // The 0x2E frame carries neither the preset name nor its number — presetRef() supplies both, and
    // the number is what keys the scene-name cache to THIS preset (never the one we just left).
    const ref = await this.#host.presetRef();
    if (ref.number < 0) throw new Error('no current-preset reply (cannot key scene names)');
    // A cold scene-name cache takes eight serial reads. Return the canvas first;
    // Axis requests the labels separately after the grid is visible.
    const scenes = this.#sceneCache?.preset === ref.number
      ? this.#sceneCache.names
      : Array.from({ length: GEN3_SCENES }, (_, i) => `Scene ${i + 1}`);
    const frames = await dev.request(buildRequestGridLayout(prof.model), {
      timeoutMs: dev.slow ? 4000 : 1200,
      quietMs: dev.slow ? 300 : 80,
      match: (fs) => fs.some(isGridLayoutResponse)
    });
    const f = frames.find(isGridLayoutResponse);
    if (!f) throw new Error('no sub-0x2E grid-layout reply');
    return {
      model: prof.key,
      name: ref.name,
      crcValid: false, // no CRC over the live read (unlike the dump's verified body)
      rows: prof.rows,
      cols: prof.cols,
      scenes,
      cells: parseGen3GridLayout(f, prof.model).map((c) => {
        // Shunt ids must land in the SAME absolute space the dump reports (Axis's shunt allocator
        // keys new routing cells off `effectId >= shuntBase`). The FM3 cell's 12-bit id field is
        // wide enough to hold the stored `SHUNT_BASE + n` directly, but the decoder documents it as
        // a "sequential index" — accept either: a value already in the shunt range passes through,
        // a small index is rebased. Both readings then produce dump-compatible ids.
        const raw = (c.isShunt ? c.shuntIndex : c.effectId) ?? 0;
        const effectId = c.isShunt ? (raw >= GEN3_SHUNT_ID_BASE ? raw : SHUNT_INDEX_OFFSET + raw) : raw;
        return {
          row: c.row,
          col: c.col,
          effectId,
          // same naming convention as the dump decoder's parseGrid (presetBody.ts)
          name: c.isShunt ? `Shunt ${effectId - SHUNT_INDEX_OFFSET}` : (effectName(effectId) ?? `eid_${effectId}`),
          isShunt: c.isShunt,
          routeFlag: c.cableInputMask,
          // FM3's mask is normalized to "bit r = fed from row r of the previous column" and is
          // byte-exact against a real multi-row preset with cross-row cables — the same thing the
          // dump's `from_rows` carries, and the ONLY thing Axis draws cables from.
          fromRows: rowsFromMask(c.cableInputMask, prof.rows)
        };
      }),
      source: 'live'
    };
  }

  async #dumpGrid(): Promise<PresetGridDTO> {
    const frames = await this.#decoder.dumpFrames(EDIT_BUFFER);
    // diagnostic: did the dump arrive? (Windows MIDI large-SysEx debugging) — frame count, the function
    // bytes seen, total bytes, and whether the 0x79 terminator came through.
    const fns = [...new Set(frames.map((f) => f[5]))].map((x) => '0x' + (x ?? 0).toString(16));
    const bytes = frames.reduce((n, f) => n + f.length, 0);
    console.log(`[forgefx] presetDump: frames=${frames.length} bytes=${bytes} fns=[${fns.join(',')}] terminator=${frames.some((f) => f[5] === 0x79)}`);
    const d = this.#decoder.decode(frames).dump;
    return {
      model: this.#host.profile.key,
      name: d.name,
      crcValid: d.crcValid,
      rows: d.rows,
      cols: d.cols,
      scenes: d.sceneNames,
      cells: d.grid.map((c) => ({ row: c.row, col: c.col, effectId: c.effectId, name: c.name, isShunt: c.isShunt, routeFlag: c.routeFlag, fromRows: c.fromRows })),
      source: 'dump'
    };
  }

  /** Placed blocks: position + routing + live bypass/channel. */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const g = await this.grid();
    const status = await this.#host.statusByEffectId();
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

  /** LIGHTWEIGHT per-block scene state — just bypass + active channel from the fn 0x13 status dump,
   *  NO preset dump. A scene switch never changes the grid STRUCTURE, only per-block bypass/channel/
   *  param values — so the UI can reuse its cached grid and re-apply just this. */
  async sceneState(): Promise<{ effectId: number; bypassed: boolean; channel: string | null }[]> {
    const status = await this.#host.statusByEffectId();
    return [...status].map(([effectId, s]) => ({ effectId, bypassed: s.bypassed, channel: CH_LETTERS[s.channel] ?? null }));
  }

  /** Live active-channel per placed block (effectId → channel 0-3), from the fn 0x13 status dump.
   *  Feeds the registry's front-panel channel-change watch. One small round-trip. */
  async activeChannels(): Promise<Map<number, number>> {
    const status = await this.#host.statusByEffectId();
    const out = new Map<number, number>();
    for (const [eid, st] of status) out.set(eid, st.channel);
    return out;
  }
}
