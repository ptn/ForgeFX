// Axe-Fx gen-1 driver unit tests — mocked transport, NO hardware. Covers the conservative read-only
// capabilities, a live grid() read over a hand-built MIDI_PATCH_DUMP (fn 0x04) response, and the
// offline decodePresetBytes() summary. gen-1 uses its OWN nibble-split codec (model 0x01).
import { buildGetPatchDump, nibbleSplit, GEN1_GRID_ROWS, GEN1_GRID_COLS } from 'forgefx-midi/gen1';
import { createGen1Driver } from '../../src/drivers/gen1.js';
import type { DriverCtx, DeviceEvent } from '../../src/drivers/types.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

export const GEN1_CASE_COUNT = 8;

function makeDriver(): { driver: ReturnType<typeof createGen1Driver>; mock: MockTransport } {
  const mock = new MockTransport('midi', 'Axe-Fx Ultra');
  const ctx: DriverCtx = { transport: async () => mock, emit: (_e: DeviceEvent) => {}, getCadence: () => cadenceFor(null, 'balanced') };
  return { driver: createGen1Driver(ctx), mock };
}

/** A byte-valid gen-1 MIDI_PATCH_DUMP (fn 0x04) edit-buffer frame: name (nibble pairs @13) + a 4×12
 *  effect grid (nibble-pair effect ids @77, column-major cells) + F7 at the pinned min length. */
function patchDumpFrame(name: string, cells: { index: number; effectId: number }[]): number[] {
  const bytes = new Array(270).fill(0);
  bytes[0] = 0xf0; bytes[1] = 0x00; bytes[2] = 0x01; bytes[3] = 0x74; bytes[4] = 0x01; bytes[5] = 0x04; bytes[6] = 0x01;
  let o = 13;
  for (const ch of name) { const [lo, hi] = nibbleSplit(ch.charCodeAt(0)); bytes[o++] = lo; bytes[o++] = hi; }
  // (null terminator pair + rest already 0 from fill)
  for (const c of cells) { const at = 77 + c.index * 4; const [lo, hi] = nibbleSplit(c.effectId); bytes[at] = lo; bytes[at + 1] = hi; }
  bytes[269] = 0xf7;
  return bytes;
}

export async function runGen1Tests(): Promise<void> {
  // 1. capabilities: a read-only gen-1 device — no grid edit / scenes / channels / save / telemetry.
  {
    const { driver } = makeDriver();
    const c = driver.capabilities;
    assertEqual(driver.modelId, 0x01, 'gen1 modelId');
    assertEqual(driver.key, 'gen1', 'gen1 key');
    assertEqual(c.slotModel, 'linear', 'gen1 slotModel (matches upstream descriptor)');
    assertEqual(c.gridEdit, false, 'gen1 no gridEdit');
    assertEqual(c.scenes, 0, 'gen1 no scenes');
    assertEqual(c.channels, false, 'gen1 no channels');
    assertEqual(c.supportsSave, false, 'gen1 no save');
    assertEqual(c.presetDump, false, 'gen1 presetDump false (param region opaque)');
    assertEqual(c.telemetry.tuner, false, 'gen1 no tuner');
  }

  // 2. write/scene methods are OMITTED so the routes answer 501.
  {
    const { driver } = makeDriver();
    const d = driver as unknown as Record<string, unknown>;
    assert(typeof d.setParam !== 'function', 'gen1 omits setParam');
    assert(typeof d.setScene !== 'function', 'gen1 omits setScene');
    assert(typeof d.placeCell !== 'function', 'gen1 omits placeCell');
    assert(typeof d.store !== 'function', 'gen1 omits store');
  }

  // 3. grid() issues the fn 0x03 GET (edit-buffer form) and parses the fn 0x04 dump.
  {
    const { driver, mock } = makeDriver();
    const frame = patchDumpFrame('LEAD TONE', [{ index: 0, effectId: 106 }, { index: 5, effectId: 100 }]);
    mock.reply = (req) => (req[5] === 0x03 ? [frame] : []);
    const grid = await driver.grid();
    assert(mock.sent.some((f) => f[5] === 0x03 && f[6] === 0x01), 'gen1 grid sent the edit-buffer GET_PATCH');
    assertEqual(grid.model, 'gen1', 'gen1 grid model');
    assertEqual(grid.name, 'LEAD TONE', 'gen1 grid preset name (nibble-decoded)');
    assertEqual(grid.rows, GEN1_GRID_ROWS, 'gen1 grid rows');
    assertEqual(grid.cols, GEN1_GRID_COLS, 'gen1 grid cols');
    assertEqual(grid.cells.length, 2, 'gen1 grid drops empty cells (2 placed)');
    const amp = grid.cells.find((c) => c.effectId === 106);
    assert(!!amp, 'gen1 grid has the amp cell');
    assertEqual(amp!.name, 'Amp 1', 'gen1 grid resolves the block name');
    assertEqual(amp!.row, 0, 'gen1 grid amp row (index 0, column-major)');
    assertEqual(amp!.col, 0, 'gen1 grid amp col');
    const comp = grid.cells.find((c) => c.effectId === 100);
    assertEqual(comp!.col, 1, 'gen1 grid comp col (index 5 → col 1)');
    assertEqual(comp!.row, 1, 'gen1 grid comp row (index 5 → row 1)');
  }

  // 4. grid() throws a clear error when the device is silent (route surfaces it as a 503).
  {
    const { driver } = makeDriver();
    let threw = false;
    try { await driver.grid(); } catch { threw = true; }
    assert(threw, 'gen1 grid throws when no dump comes back');
  }

  // 5. decodePresetBytes() summarizes an offline patch-dump .syx (name + placed blocks).
  {
    const { driver } = makeDriver();
    const frame = patchDumpFrame('OFFLINE', [{ index: 0, effectId: 106 }]);
    const sum = driver.decodePresetBytes(Uint8Array.from(frame));
    assertEqual(sum.name, 'OFFLINE', 'gen1 decode name');
    assertEqual(sum.model, 'gen1', 'gen1 decode model');
    assertEqual(sum.scenes.length, 0, 'gen1 decode has no scenes');
    assertEqual(sum.blocks.length, 1, 'gen1 decode block count');
    assertEqual(sum.blocks[0]!.effectId, 106, 'gen1 decode block effectId');
    assertEqual(sum.blocks[0]!.name, 'Amp 1', 'gen1 decode block name');
  }

  // 6. buildGetPatchDump edit-buffer request is the frame grid() sends.
  {
    const req = buildGetPatchDump(undefined, 0x01);
    assertEqual(req[5], 0x03, 'gen1 GET_PATCH function byte');
    assertEqual(req[6], 0x01, 'gen1 GET_PATCH edit-buffer flag');
  }

  // 7. decodePresetBytes throws on a non-gen-1-dump frame (route → 422).
  {
    const { driver } = makeDriver();
    let threw = false;
    try { driver.decodePresetBytes(Uint8Array.from([0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0xf7])); } catch { threw = true; }
    assert(threw, 'gen1 decode rejects a non-patch-dump frame');
  }

  // 8. empty grid (no placed blocks) still returns a valid DTO.
  {
    const { driver, mock } = makeDriver();
    mock.reply = (req) => (req[5] === 0x03 ? [patchDumpFrame('EMPTY', [])] : []);
    const grid = await driver.grid();
    assertEqual(grid.cells.length, 0, 'gen1 empty grid');
    assertEqual(grid.name, 'EMPTY', 'gen1 empty grid name');
  }
}
