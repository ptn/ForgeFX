// VP4 driver unit tests — mocked transport, NO hardware. Verifies capabilities + that the allowlisted
// beta writes emit byte-exact VP4 frames, that the undecoded (gated) writes are refused/omitted, and
// (R-B1) that grid() reads the whole-preset STRUCTURE blob to populate scene names, current scene, and
// the true 4-slot chain.
import { buildVp4SetParam, buildVp4SetBypass, buildVp4Save, buildVp4GetStructureBlob } from 'forgefx-midi/gen3/vp4';
import { encode14, fractalChecksum, packValueChunked } from 'forgefx-midi/shared';
import { createVp4Driver } from '../../src/drivers/vp4.js';
import type { DriverCtx, DeviceEvent } from '../../src/drivers/types.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { MockTransport, assert, assertEqual, hex } from '../helpers/mock.js';

export const VP4_CASE_COUNT = 9;

function makeDriver(): { driver: ReturnType<typeof createVp4Driver>; mock: MockTransport } {
  const mock = new MockTransport('midi', 'VP4');
  const ctx: DriverCtx = { transport: async () => mock, emit: (_e: DeviceEvent) => {}, getCadence: () => cadenceFor(null, 'balanced') };
  return { driver: createVp4Driver(ctx), mock };
}
const eqFrame = (a: number[], b: number[], msg: string) => assert(hex(a) === hex(b), `${msg}: got ${hex(a)} want ${hex(b)}`);

const EID = 100; // an arbitrary gen-3 effectId; the VP4 builders address it verbatim

/** Build a byte-valid VP4 structure-blob response frame (the exact shape parseVp4StructureBlob accepts):
 *  a 192-byte raw record (status@0, currentScene@8, preset name@16, 4×32 scene names@48, 4×u32 chain@176)
 *  packed 7→8 chunked, wrapped in the eid206/pid0/tc=0x1f envelope with a real checksum. */
function structureFrame(opts: { currentScene: number; presetName: string; sceneNames: string[]; chain: number[] }): number[] {
  const raw = new Uint8Array(192);
  raw[0] = 0x00; // status flag
  raw[8] = opts.currentScene & 0xff;
  const writeName = (off: number, s: string) => { for (let i = 0; i < s.length && i < 31; i++) raw[off + i] = s.charCodeAt(i) & 0x7f; };
  writeName(16, opts.presetName);
  for (let s = 0; s < 4; s++) writeName(48 + s * 32, opts.sceneNames[s] ?? '');
  for (let s = 0; s < 4; s++) {
    const e = opts.chain[s] ?? 0;
    const o = 176 + s * 4;
    raw[o] = e & 0xff; raw[o + 1] = (e >> 8) & 0xff; raw[o + 2] = (e >> 16) & 0xff; raw[o + 3] = (e >> 24) & 0xff;
  }
  const packed = [...packValueChunked(raw)];
  const [eLo, eHi] = encode14(206);
  const [pLo, pHi] = encode14(0);
  const [lLo, lHi] = encode14(192);
  const body = [0xf0, 0x00, 0x01, 0x74, 0x14, 0x01, eLo, eHi, pLo, pHi, 0x1f, 0x00, 0x00, 0x00, lLo, lHi, ...packed];
  return [...body, fractalChecksum(body), 0xf7];
}

export async function runVp4Tests(): Promise<void> {
  // 1. capabilities: a linear 4-slot device, no grid edit, no gen-3 telemetry, save allowlisted.
  {
    const { driver } = makeDriver();
    const c = driver.capabilities;
    assertEqual(c.slotModel, 'linear', 'vp4 slotModel');
    assertEqual(c.slotCount, 4, 'vp4 slotCount');
    assertEqual(c.gridEdit, false, 'vp4 no gridEdit');
    assertEqual(c.supportsSave, true, 'vp4 supportsSave');
    assertEqual(c.telemetry.outputMeters, false, 'vp4 no output meters');
    assertEqual(c.fullCapture, false, 'vp4 no full capture (write-sweep gated — factory-reset incident)');
    assertEqual(driver.modelId, 0x14, 'vp4 modelId');
    assertEqual(driver.key, 'vp4', 'vp4 key');
  }

  // 2. gated methods are OMITTED so the routes answer 501 (no placeCell / setScene / selectPreset / …).
  {
    const { driver } = makeDriver();
    const d = driver as unknown as Record<string, unknown>;
    assert(typeof d.placeCell !== 'function', 'vp4 omits placeCell (block placement undecoded)');
    assert(typeof d.setScene !== 'function', 'vp4 omits setScene (scene switch undecoded)');
    assert(typeof d.selectPreset !== 'function', 'vp4 omits selectPreset');
    assert(typeof d.setPresetName !== 'function', 'vp4 omits setPresetName');
  }

  // 3. continuous setParam → the VP4-specific swapped-septet float frame (value is the 0..1 norm).
  {
    const { driver, mock } = makeDriver();
    await driver.setParam(EID, 0, 0.5, true);
    eqFrame(mock.sent[0], buildVp4SetParam(EID, 0, 0.5, { continuous: true }), 'vp4 continuous setParam');
  }

  // 4. discrete setParam is UNDECODED → clean 400, no frame sent.
  {
    const { driver, mock } = makeDriver();
    let threw = false;
    try { await driver.setParam(EID, 0, 3, false); } catch (e) { threw = true; assertEqual((e as { statusCode?: number }).statusCode, 400, 'vp4 discrete setParam is a 400'); }
    assert(threw, 'vp4 discrete setParam must throw (gated)');
    assertEqual(mock.sent.length, 0, 'vp4 discrete setParam sends nothing');
  }

  // 5. setBypass → the VP4-specific bypass frame.
  {
    const { driver, mock } = makeDriver();
    await driver.setBypass(EID, true);
    eqFrame(mock.sent[0], buildVp4SetBypass(EID, true), 'vp4 setBypass');
  }

  // 6. store → the VP4 save frame.
  {
    const { driver, mock } = makeDriver();
    await driver.store(0);
    eqFrame(mock.sent[0], buildVp4Save(), 'vp4 store/save');
  }

  // 7. grid() issues the structure-blob GET and, on a valid response, populates the 4 scene names,
  //    the true chain (physical slot order — empty slots dropped), and the preset name.
  {
    const { driver, mock } = makeDriver();
    const frame = structureFrame({ currentScene: 2, presetName: 'My Preset', sceneNames: ['Clean', 'Crunch', 'Lead', 'Solo'], chain: [100, 0, 142, 0] });
    mock.reply = (req) => (hex([...req]) === hex(buildVp4GetStructureBlob()) ? [frame] : []);
    const grid = await driver.grid();
    assert(mock.sent.some((f) => hex(f) === hex(buildVp4GetStructureBlob())), 'vp4 grid sent the structure GET');
    assertEqual(grid.name, 'My Preset', 'vp4 grid preset name from structure');
    assertEqual(grid.scenes.join(','), 'Clean,Crunch,Lead,Solo', 'vp4 grid scene names from structure');
    assertEqual(grid.cells.length, 2, 'vp4 grid drops empty chain slots (2 of 4 filled)');
    assertEqual(grid.cells[0]!.effectId, 100, 'vp4 grid slot-0 effectId');
    assertEqual(grid.cells[0]!.col, 0, 'vp4 grid slot-0 col (physical order)');
    assertEqual(grid.cells[1]!.effectId, 142, 'vp4 grid slot-2 effectId');
    assertEqual(grid.cells[1]!.col, 2, 'vp4 grid slot-2 col (physical order)');
  }

  // 8. getScene() reads the current scene (0-based) from the structure blob.
  {
    const { driver, mock } = makeDriver();
    const frame = structureFrame({ currentScene: 3, presetName: 'X', sceneNames: ['a', 'b', 'c', 'd'], chain: [0, 0, 0, 0] });
    mock.reply = (req) => (hex([...req]) === hex(buildVp4GetStructureBlob()) ? [frame] : []);
    const r = await driver.getScene();
    assertEqual(r.index, 3, 'vp4 getScene current scene from structure');
  }

  // 9. structure register silent → grid() falls back gracefully (no throw; empty discovery-order read).
  {
    const { driver } = makeDriver();
    const grid = await driver.grid(); // mock replies [] to everything (reader getPreset also silent)
    assertEqual(grid.model, 'vp4', 'vp4 grid fallback still returns a DTO');
    assertEqual(grid.cells.length, 0, 'vp4 grid fallback empty when nothing responds');
  }
}
