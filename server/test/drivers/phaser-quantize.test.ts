// Phaser Quantize is a knob in the editor layout but a 32-value discrete value on the wire.
// Its device range is 1..32, where the first position reads OFF; labels are indexed from the
// range minimum rather than directly by the one-based wire value.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11;

export const PHASER_QUANTIZE_CASE_COUNT = 6;

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function enc14(v: number): [number, number] { return [v & 0x7f, (v >> 7) & 0x7f]; }

function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(0x75, body),
    sysex(0x76, []),
  ];
}

export async function runPhaserQuantizeTests(): Promise<void> {
  const prof = PROFILES[MODEL]!;
  const phaser = effectRoster().find((x) => x.slug === 'phaser')?.page;
  assert(phaser != null, 'Phaser effect must exist');

  const codec = createModernFractalCodec(MODEL);
  const stride = prof.rangeSections.PHASER!.stride;
  const values = new Array(stride * 4).fill(0);
  for (let channel = 0; channel < 4; channel++) values[channel * stride + 23] = 1;
  const status = sysex(0x13, [...enc14(phaser!), (1 << 1) | (4 << 4)]);
  const bulk = blockBulkFrames(phaser!, values);
  const mock = new MockTransport('serial', 'mock-fm3-phaser');
  mock.isOpen = true;
  mock.reply = (req) => {
    if (req.join(',') === codec.buildStatusDump().join(',')) return [status];
    if (req.join(',') === codec.buildBlockBulkReadPoll(phaser!).join(',')) return bulk;
    return [];
  };

  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const result = await driver.blockParams(phaser!);
  const quantize = result.enums.find((e) => e.paramName === 'PHASER_LFOQUANTIZE');

  assert(quantize != null, 'Phaser Quantize must be served as a discrete parameter');
  assertEqual(quantize!.value, 1, 'first Quantize wire value');
  assertEqual(quantize!.options.length, 32, 'Quantize option count');
  assert(quantize!.options[0]?.value === 1 && quantize!.options[0]?.label === 'OFF', 'first Quantize option must be wire value 1 labelled OFF');
  assert(quantize!.options[1]?.value === 2 && quantize!.options[1]?.label === '2', 'second Quantize option must be wire value 2 labelled 2');
  assert(quantize!.options[31]?.value === 32 && quantize!.options[31]?.label === '32', 'last Quantize option must be wire value 32 labelled 32');
}
