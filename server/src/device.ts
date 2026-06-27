// High-level FM3 device service: owns the serial transport and exposes typed ops
// built on the fractal-midi codec. Endpoints call this; it never touches HTTP.
import {
  buildRequestGridLayout,
  parseGen3GridLayout,
  buildQueryPatchName,
  isQueryPatchNameResponse,
  parseQueryPatchNameResponse
} from 'fractal-midi/gen3/axe-fx-iii';
import { FractalSerial, autoDetectPath } from './transport/serial.js';

const MODEL_FM3 = 0x11;
const FM3_ROWS = 4;
const FM3_COLS = 14;

export interface GridCellDTO {
  row: number;
  col: number;
  effectId: number;
  name: string;
  isShunt: boolean;
  fromRows: number[];
}
export interface PresetGridDTO {
  cells: GridCellDTO[];
  rows: number;
  cols: number;
  name: string;
  model: string;
  crcValid: boolean;
  source: 'live-2e';
}

class Device {
  #serial: FractalSerial | null = null;

  get port() {
    return this.#serial?.path ?? autoDetectPath();
  }

  async #conn(): Promise<FractalSerial> {
    if (this.#serial?.isOpen) return this.#serial;
    this.#serial = new FractalSerial();
    await this.#serial.open();
    return this.#serial;
  }

  async health() {
    const path = autoDetectPath();
    return { ok: !!path, device: 'FM3', model: 'fm3', port: path };
  }

  /** Current preset name (proves the link is live). */
  async presetName(): Promise<string | null> {
    const dev = await this.#conn();
    const frames = await dev.request(buildQueryPatchName('current', MODEL_FM3), {
      timeoutMs: 1200,
      match: (fs) => fs.some((f) => isQueryPatchNameResponse(f))
    });
    const f = frames.find((x) => isQueryPatchNameResponse(x));
    return f ? parseQueryPatchNameResponse(f).name : null;
  }

  /** Live routing grid via fn=0x01 sub=0x2E. BETA on FM3 (see probes/grid-read.ts). */
  async grid(): Promise<PresetGridDTO> {
    const dev = await this.#conn();
    const frames = await dev.request(buildRequestGridLayout(MODEL_FM3), { timeoutMs: 2000 });
    const resp = frames.find((f) => f[5] === 0x01 && f[6] === 0x2e) ?? frames.sort((a, b) => b.length - a.length)[0];
    if (!resp) throw new Error('no grid-layout response');
    const raw = parseGen3GridLayout(resp, MODEL_FM3);
    const cells: GridCellDTO[] = raw.map((c) => ({
      row: c.row,
      col: c.col,
      effectId: c.effectId ?? -1,
      name: c.isShunt ? `Shunt ${c.shuntIndex ?? ''}`.trim() : `eid ${c.effectId}`,
      isShunt: c.isShunt,
      fromRows: maskToRows(c.cableInputMask)
    }));
    return { cells, rows: FM3_ROWS, cols: FM3_COLS, name: '', model: 'fm3', crcValid: true, source: 'live-2e' };
  }
}

function maskToRows(mask: number): number[] {
  const rows: number[] = [];
  for (let r = 0; r < FM3_ROWS; r++) if (mask & (1 << r)) rows.push(r);
  return rows;
}

export const device = new Device();
