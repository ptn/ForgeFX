import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { MockTransport, assertEqual } from '../helpers/mock.js';

// Live FM3 slot 0 reply for "TDR Vox mix". Its bytes 12-13 are 0x01, 0x00,
// proving the response does not echo the request's 14-bit flat index (0x1000).
const TDR_VOX_MIX_REPLY = [
  0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x2a, 0x11, 0x0a,
  0x22, 0x02, 0x59, 0x5e, 0x78, 0x10, 0x1b, 0x2d, 0x17, 0x40, 0x00, 0x62,
  0x39, 0x1c, 0x4d, 0x24, 0x06, 0x6b, 0x25, 0x70, 0x20, 0x18, 0x40, 0x00,
  0x00, 0x03, 0x15, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7c, 0xf7,
];

export async function runFm3CabIrTests(): Promise<void> {
  const mock = new MockTransport();
  mock.reply = (request) => {
    if (request[5] !== 0x01 || request[6] !== 0x4b) return [];
    return [TDR_VOX_MIX_REPLY];
  };
  const driver = createGen3Driver(PROFILES[0x11]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(null, 'balanced'),
  });

  const user = (await driver.cabIrs()).USER!;
  assertEqual(user.length, 512, 'FM3 USER slot count');
  assertEqual(user[0], 'TDR Vox mix', 'FM3 response without echoed index is accepted');
  assertEqual(user[511], 'TDR Vox mix', 'response is associated with its serialized request');
  assertEqual(mock.sent.length, 512, 'one read per FM3 USER slot');

  const cab = effectRoster().find((block) => block.slug === 'cab');
  if (!cab) throw new Error('FM3 cab effect missing from the roster');
  mock.sent.length = 0;
  await driver.cabState!(cab.page);
  assertEqual(mock.sent.some((frame) => frame[5] === 0x01 && frame[6] === 0x4b), false, 'cab state must not read the live USER catalog');
}

export const FM3_CAB_IR_CASE_COUNT = 5;
