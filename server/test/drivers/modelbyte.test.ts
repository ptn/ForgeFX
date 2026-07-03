// Wrong-model-byte guard — the regression test for the entire wrong-codec bug class.
// For each gen-3 driver (Axe-Fx III 0x10 / FM3 0x11 / FM9 0x12): build the driver over a mock
// transport that records every outgoing frame, smoke-invoke every frame-emitting method, then
// assert EVERY recorded frame carries the driver's own model byte at f[4]. A driver must be
// physically unable to emit another device's frames.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { setProfileOverride, setConnOverride } from '../../src/transport/connection.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep, hex } from '../helpers/mock.js';

const GEN3_MODELS = [0x10, 0x11, 0x12] as const;

// One entry per smoke-invoked driver method (FM3 adds the 2 FC live reads), plus 1 registry
// tuner case per model.
export const MODELBYTE_CASE_COUNT = GEN3_MODELS.length * 25 + 2 + GEN3_MODELS.length;

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
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {} });
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

export async function runModelByteTests(): Promise<void> {
  for (const m of GEN3_MODELS) await smokeDriver(m);
  for (const m of GEN3_MODELS) await smokeTuner(m);
}
