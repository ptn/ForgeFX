// Axe-Fx II (gen-2) driver unit tests — mocked transport, NO hardware. Verifies the driver's
// capabilities and that its write methods emit byte-exact frames from the forgefx-midi builders.
// (The read path — grid()/blockParams() — is exercised by the descriptor reader's own goldens
// upstream; here we prove the ForgeFX wiring emits the right wire frames.)
import {
  buildSetBlockParameterValue,
  buildSetBlockParameterValueInteger,
  buildSetBlockBypass,
  buildSetBlockChannel,
  buildSetGridCell,
  buildSetSceneNumber,
  buildSwitchPreset,
} from 'forgefx-midi/gen2/axe-fx-ii';
import { createGen2Driver } from '../../src/drivers/gen2.js';
import type { DriverCtx, DeviceEvent } from '../../src/drivers/types.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { MockTransport, assert, assertEqual, hex } from '../helpers/mock.js';

export const GEN2_CASE_COUNT = 8;

function makeDriver(): { driver: ReturnType<typeof createGen2Driver>; mock: MockTransport; events: DeviceEvent[] } {
  const mock = new MockTransport('midi', 'Axe-Fx II XL+');
  const events: DeviceEvent[] = [];
  const ctx: DriverCtx = { transport: async () => mock, emit: (e) => events.push(e), getCadence: () => cadenceFor(null, 'balanced') };
  return { driver: createGen2Driver(ctx), mock, events };
}
const eqFrame = (a: number[], b: number[], msg: string) => assert(hex(a) === hex(b), `${msg}: got ${hex(a)} want ${hex(b)}`);

const AMP1 = 106; // Amp 1 effectId (groupCode AMP)

export async function runGen2Tests(): Promise<void> {
  // 1. capabilities: a 4×12 grid device, 8 scenes, X/Y channels, no gen-3 telemetry.
  {
    const { driver } = makeDriver();
    const c = driver.capabilities;
    assertEqual(c.slotModel, 'grid', 'gen2 slotModel');
    assertEqual(c.grid?.rows, 4, 'gen2 rows');
    assertEqual(c.grid?.cols, 12, 'gen2 cols');
    assertEqual(c.scenes, 8, 'gen2 scenes');
    assertEqual(c.channels, true, 'gen2 channels');
    assertEqual(c.gridEdit, true, 'gen2 gridEdit');
    assertEqual(c.telemetry.tuner, false, 'gen2 no tuner telemetry');
    assertEqual(c.fullCapture, false, 'gen2 no full capture (no gen-3 self-describe walk)');
    assertEqual(driver.modelId, 0x07, 'gen2 modelId');
    assertEqual(driver.key, 'axe2', 'gen2 key');
  }

  // 2. continuous setParam → fn 0x2e SET_PARAM_DIRECT with the display value derived from the norm.
  //    amp.input_drive: paramId 1, display range 0..10 (linear) → norm 0.5 = display 5.
  {
    const { driver, mock } = makeDriver();
    await driver.setParam(AMP1, 1, 0.5, true);
    eqFrame(mock.sent[0], buildSetBlockParameterValue({ effectId: AMP1, paramId: 1 }, 5), 'gen2 continuous setParam');
  }

  // 3. discrete setParam → fn 0x02 integer write (value is the raw ordinal, rounded).
  {
    const { driver, mock } = makeDriver();
    await driver.setParam(AMP1, 0, 3, false);
    eqFrame(mock.sent[0], buildSetBlockParameterValueInteger({ effectId: AMP1, paramId: 0 }, 3), 'gen2 discrete setParam');
  }

  // 4. setBypass → fn 0x02 paramId 255 bypass write.
  {
    const { driver, mock } = makeDriver();
    await driver.setBypass(AMP1, true);
    eqFrame(mock.sent[0], buildSetBlockBypass(AMP1, true), 'gen2 setBypass');
  }

  // 5. setChannel → fn 0x11 channel switch (Y).
  {
    const { driver, mock } = makeDriver();
    await driver.setChannel(AMP1, 'Y');
    eqFrame(mock.sent[0], buildSetBlockChannel(AMP1, 'Y'), 'gen2 setChannel Y');
  }

  // 6. placeCell → fn 0x5A grid cell (0-based row/col from Axis → 1-based wire), emits changed{grid}.
  {
    const { driver, mock, events } = makeDriver();
    await driver.placeCell(1, 2, AMP1); // row 1, col 2 (0-based) → wire row 2, col 3
    eqFrame(mock.sent[0], buildSetGridCell({ row: 2, col: 3, blockId: AMP1 }), 'gen2 placeCell');
    assert(events.some((e) => e.type === 'changed' && e.scope === 'grid'), 'placeCell emits changed{grid}');
  }

  // 7. setScene → fn 0x29 scene switch (0-based passthrough), emits scene event.
  {
    const { driver, mock, events } = makeDriver();
    await driver.setScene(3);
    eqFrame(mock.sent[0], buildSetSceneNumber(3), 'gen2 setScene');
    assert(events.some((e) => e.type === 'scene' && e.index === 3), 'setScene emits scene event');
  }

  // 8. selectPreset → PC+bank switch preset (wire index).
  {
    const { driver, mock } = makeDriver();
    await driver.selectPreset(42);
    eqFrame(mock.sent[0], buildSwitchPreset(42), 'gen2 selectPreset');
  }
}
