// Wrong-model-byte guard — the regression test for the entire wrong-codec bug class.
// For each gen-3 driver (Axe-Fx III 0x10 / FM3 0x11 / FM9 0x12): build the driver over a mock
// transport that records every outgoing frame, smoke-invoke every frame-emitting method, then
// assert EVERY recorded frame carries the driver's own model byte at f[4]. A driver must be
// physically unable to emit another device's frames.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { setProfileOverride, setConnOverride } from '../../src/transport/connection.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep, hex } from '../helpers/mock.js';

const GEN3_MODELS = [0x10, 0x11, 0x12] as const;
const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');

// One entry per smoke-invoked driver method (FM3 adds the 2 FC live reads), plus 1 registry
// tuner case per model, plus the gen-3 channel-stride regression.
export const MODELBYTE_CASE_COUNT = GEN3_MODELS.length * 25 + 2 + GEN3_MODELS.length + 1;

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function enc14(v: number): [number, number] {
  return [v & 0x7f, (v >> 7) & 0x7f];
}

function blockBulkFrames(model: number, effectId: number, values: readonly number[]): number[][] {
  const itemCount = values.length;
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(model, 0x74, [...enc14(effectId), ...enc14(itemCount), 0x07]),
    sysex(model, 0x75, body),
    sysex(model, 0x76, []),
  ];
}

function eidFor(slug: string): number {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page; // instance 1 effect id
}

/** Invoke a driver method, tolerating its no-reply error path — the frames it emitted before
 *  throwing are already recorded on the mock, which is all this suite asserts on. */
async function tolerant(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* mock returns no reply frames — request/decode errors are expected; frames are recorded */
  }
}

async function smokeDriver(model: number): Promise<void> {
  const prof = PROFILES[model]!;
  const mock = new MockTransport('serial', `mock-${prof.key}`);
  mock.isOpen = true;
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  assertEqual(driver.modelId, model, `driver ${prof.key} modelId`);

  const amp = eidFor('amp');
  const cab = eidFor('cab');

  // every frame-emitting driver method (mock replies: silence — the drivers' error paths tolerate it)
  await tolerant('setParam continuous', () => driver.setParam(amp, 1, 0.5, true));
  await tolerant('setParam discrete', () => driver.setParam(amp, 1, 3, false));
  await tolerant('setType', () => driver.setType(amp, 1));
  await tolerant('setBypass', () => driver.setBypass(amp, true));
  await tolerant('setChannel', () => driver.setChannel(amp, 'B'));
  await tolerant('setScene', () => driver.setScene(2));
  await tolerant('getScene', () => driver.getScene());
  await tolerant('setSceneName', () => driver.setSceneName(0, 'Scene Test'));
  await tolerant('setPresetName', () => driver.setPresetName('Preset Test'));
  await tolerant('selectPreset', () => driver.selectPreset(5));
  await tolerant('store', () => driver.store(5));
  await tolerant('placeCell', () => driver.placeCell(0, 1, amp));
  await tolerant('selectCell', () => driver.selectCell(0, 1));
  await tolerant('cable', () => driver.cable(0, 0, 1, true));
  await tolerant('getTempo', () => driver.getTempo());
  await tolerant('setTempo', () => driver.setTempo(120));
  await tolerant('tapTempo', () => driver.tapTempo());
  await tolerant('presetRef', () => driver.presetRef());
  await tolerant('blockParams', () => driver.blockParams(amp));
  await tolerant('readParams', () => driver.readParams(amp, [1, 2]));
  await tolerant('readRange', () => driver.readRange(amp, [1]));
  await tolerant('rawBlock', () => driver.rawBlock(amp));
  await tolerant('bindModifier', () => driver.bindModifier(1, amp, 1, 0));
  await tolerant('cabState', () => driver.cabState(cab));
  await tolerant('grid (preset-dump read)', () => driver.grid()); // dump request ×3 retries, then decode throws
  if (driver.capabilities.fcLiveRead) {
    await tolerant('fcReadSwitch', () => driver.fcReadSwitch!(0, 0, 0));
    await tolerant('fcReadState', () => driver.fcReadState!(0, 0, 0));
  }

  assert(mock.sent.length >= 25, `driver ${prof.key}: smoke emitted ${mock.sent.length} frames (expected ≥25)`);
  if (model === 0x11) {
    assert(
      mock.sent.some((f) => compactHex(f) === 'f0000174110116003a00000001000000000000000038f7'),
      'FM3 setChannel uses FM3-Edit fn=0x01 sub=0x0016 frame',
    );
    assert(
      mock.sent.some((f) => compactHex(f) === 'f0000174110124000000010002000000000000000032f7'),
      'FM3 setScene uses FM3-Edit fn=0x01 sub=0x0024 frame',
    );
  } else {
    assert(mock.sent.some((f) => f[5] === 0x0b), `driver ${prof.key}: setChannel stays on spec fn=0x0b`);
    assert(mock.sent.some((f) => f[5] === 0x0c), `driver ${prof.key}: setScene stays on spec fn=0x0c`);
  }
  for (const f of mock.sent) {
    assertEqual(f[0], 0xf0, `driver ${prof.key}: frame starts with F0 (${hex(f)})`);
    if (f[4] !== model) {
      throw new Error(`driver ${prof.key} (0x${model.toString(16)}) emitted a frame with model byte 0x${(f[4] ?? -1).toString(16)}: ${hex(f)}`);
    }
  }
}

/** Registry-level tuner path (frames are built in the telemetry supervisor from the ACTIVE
 *  driver's model byte): page-open, polls, page-close must all carry the detected model. */
async function smokeTuner(model: number): Promise<void> {
  setConnOverride(null);
  setProfileOverride(null);
  const mock = new MockTransport('serial', `mock-tuner-0x${model.toString(16)}`);
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
  const reg = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: '/dev/mock' }),
    openConn: () => mock
  });
  await reg.setTuner(true); // lazily detects, opens the tuner page, starts the poll timer
  await sleep(150); // let a few fn 0x11 tuner polls fire
  await reg.setTuner(false);
  const nonHandshake = mock.sent.filter((f) => !isIdentifyBroadcast(f));
  assert(nonHandshake.length >= 3, `tuner 0x${model.toString(16)}: expected open+poll+close frames, got ${nonHandshake.length}`);
  for (const f of nonHandshake) {
    if (f[4] !== model) {
      throw new Error(`tuner path for 0x${model.toString(16)} emitted model byte 0x${(f[4] ?? -1).toString(16)}: ${hex(f)}`);
    }
  }
}

async function smokeFm3AmpChannelStride(): Promise<void> {
  const model = 0x11;
  const prof = PROFILES[model]!;
  const amp = eidFor('amp');
  const codec = createModernFractalCodec(model);
  const stride = prof.rangeSections.DISTORT?.stride;
  assertEqual(stride, 144, 'FM3 DISTORT fn=0x1f stride');

  const typeId = 6; // DISTORT_TYPE / Amp model selector in the generated FM3 table.
  const channelAType = 213; // 5153 50W Blue in the user's live regression preset.
  const channelBType = 316; // 5153 100W Stealth Red.
  const values = new Array(stride * 4).fill(0);
  values[typeId] = channelAType;
  values[stride + typeId] = channelBType;

  const statusB = sysex(model, 0x13, [
    ...enc14(amp),
    (1 << 1) | (4 << 4), // bypass=false, active channel=B, four channels.
  ]);
  const bulk = blockBulkFrames(model, amp, values);
  const mock = new MockTransport('serial', 'mock-fm3-channel-stride');
  mock.isOpen = true;
  mock.reply = (req) => {
    if (compactHex(req) === compactHex(codec.buildStatusDump())) return [statusB];
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(amp))) return bulk;
    return [];
  };
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const r = await driver.blockParams(amp);
  assertEqual(r.type?.value, channelBType, 'FM3 blockParams slices Amp channel B by generated DISTORT stride');
  assertEqual(r.type?.name, '5153 100W Stealth Red', 'FM3 blockParams returns the channel-B Amp model name');
}

export async function runModelByteTests(): Promise<void> {
  for (const m of GEN3_MODELS) await smokeDriver(m);
  for (const m of GEN3_MODELS) await smokeTuner(m);
  await smokeFm3AmpChannelStride();
}
