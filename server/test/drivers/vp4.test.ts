// VP4 driver unit tests — mocked transport, NO hardware. Verifies capabilities + that the allowlisted
// beta writes emit byte-exact VP4 frames, and that the undecoded (gated) writes are refused/omitted.
import { buildVp4SetParam, buildVp4SetBypass, buildVp4Save } from 'forgefx-midi/gen3/vp4';
import { createVp4Driver } from '../../src/drivers/vp4.js';
import type { DriverCtx, DeviceEvent } from '../../src/drivers/types.js';
import { MockTransport, assert, assertEqual, hex } from '../helpers/mock.js';

export const VP4_CASE_COUNT = 6;

function makeDriver(): { driver: ReturnType<typeof createVp4Driver>; mock: MockTransport } {
  const mock = new MockTransport('midi', 'VP4');
  const ctx: DriverCtx = { transport: async () => mock, emit: (_e: DeviceEvent) => {} };
  return { driver: createVp4Driver(ctx), mock };
}
const eqFrame = (a: number[], b: number[], msg: string) => assert(hex(a) === hex(b), `${msg}: got ${hex(a)} want ${hex(b)}`);

const EID = 100; // an arbitrary gen-3 effectId; the VP4 builders address it verbatim

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
}
