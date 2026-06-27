// High-level FM3 device service: owns the serial transport and exposes typed ops
// built on the fractal-midi codec. Endpoints call this; it never touches HTTP.
import { buildQueryPatchName, isQueryPatchNameResponse, parseQueryPatchNameResponse } from 'fractal-midi/gen3/axe-fx-iii';
import { fractalChecksum } from 'fractal-midi/shared';
import { FractalSerial, autoDetectPath } from './transport/serial.js';
import { decodePresetDump } from './codec/fm3PresetGrid.js';

const MODEL_FM3 = 0x11;
const FN_REQUEST_EDIT_BUFFER_DUMP = 0x43; // not re-exported by the barrel; build inline

/** F0 00 01 74 <model> 0x43 <cksum> F7 — request the live edit-buffer dump. */
function editBufferDumpReq(model: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, FN_REQUEST_EDIT_BUFFER_DUMP];
  return [...body, fractalChecksum(body), 0xf7];
}

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
  source: 'dump';
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

  /**
   * Routing grid via the preset dump (request edit buffer → reassemble → Huffman → grid).
   * Hardware-validated decoder (crcValid on FM3). The live sub=0x2E path is a future
   * optimization (FM3 format still being calibrated — see probes/grid-read.ts).
   */
  async grid(): Promise<PresetGridDTO> {
    const dev = await this.#conn();
    const frames = await dev.request(editBufferDumpReq(MODEL_FM3), {
      timeoutMs: 5000,
      quietMs: 150,
      match: (fs) => fs.some((f) => f[5] === 0x79) // 0x79 = dump terminator
    });
    const d = decodePresetDump(frames, MODEL_FM3);
    const cells: GridCellDTO[] = d.grid.map((c) => ({
      row: c.row,
      col: c.col,
      effectId: c.effectId,
      name: c.name,
      isShunt: c.isShunt,
      fromRows: c.fromRows
    }));
    return { cells, rows: d.rows, cols: d.cols, name: d.name, model: 'fm3', crcValid: d.crcValid, source: 'dump' };
  }
}

export const device = new Device();
