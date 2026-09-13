// Telemetry-supervisor lifecycle characterization tests — mocked Conn/Transport, NO hardware.
// Pins the externally-observable loop set (diagnostics().traffic.loops) as the supervisor is
// capability-gated by subscriptions + the active driver, and the pause/resume contract the
// device-cache build relies on. Behavior-preserving split guard for registryCore.ts C3.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn before transport loads
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registryTest.js';
import { setProfileOverride, setConnOverride } from '../../src/transport/connection.js';
import type { Conn } from '../../src/transport/types.js';
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

export const SUPERVISOR_CASE_COUNT = 3;

const serial = (mock: MockTransport): Conn => ({ transport: 'serial', id: mock.label });

function makeReg(mock: MockTransport): DeviceRegistry {
  return __createRegistryForTest({
    resolveConn: async () => serial(mock),
    openConn: () => mock,
    listConnections: async () => [] // keep diagnostics() offline + fast
  });
}

/** Minimal fake gen-3 driver (model 0x11) whose capability flags a supervisor test toggles. */
function fakeDriver(opts: {
  outputMeters?: boolean;
  tuner?: boolean;
  editWatch?: boolean;
  editPush?: boolean;
}): DeviceDriver {
  const caps = {
    slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
    presetDump: true, presetConvert: false,
    telemetry: { tuner: !!opts.tuner, outputMeters: !!opts.outputMeters, cpu: false },
    fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: false,
    supportsSave: true, selfDescribe: false, cacheImport: false, fullCapture: false,
    deviceEditWatch: !!opts.editWatch, deviceEditPush: !!opts.editPush
  } as DriverCapabilities;
  return {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities: caps,
    grid: async () => ({ model: 'fm3', name: 'x', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' as const }),
    ...(opts.editWatch ? { readDeviceEditState: async () => ({ changed: false }) } : {}),
    ...(opts.editPush ? { decodeEditBurst: () => ({ events: [], reload: false }) } : {})
  } as DeviceDriver;
}

async function loopsOf(reg: DeviceRegistry): Promise<string[]> {
  return (await reg.diagnostics()).traffic.loops;
}

/** a. Subscribe starts only the loops the ACTIVE driver's capabilities allow; unsubscribe stops all. */
async function loopGating(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const reg = makeReg(mock);
  reg.__seedDriver(0x11, fakeDriver({ outputMeters: true, editPush: true }));
  await reg.detect();
  assertEqual((await loopsOf(reg)).join(','), '', 'no loops before a subscriber');
  const unsub = reg.subscribe(() => {});
  assertEqual((await loopsOf(reg)).sort().join(','), 'editPush,meters', 'meters + editPush while subscribed');
  unsub();
  assertEqual((await loopsOf(reg)).join(','), '', 'all loops stopped after the last unsubscribe');
}

/** b. detect() re-gates the edit-watch on the new driver when a subscriber is already present
 *     (the subscribe-before-detect path #activate must reconcile). */
async function reconcileOnActivate(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const reg = makeReg(mock);
  reg.__seedDriver(0x11, fakeDriver({ editWatch: true }));
  const unsub = reg.subscribe(() => {}); // no active driver yet → both ungated primes start
  assertEqual((await loopsOf(reg)).join(','), 'meters,editWatch', 'ungated primes before a driver is active');
  await reg.detect(); // reconcile stops meters (fake has no outputMeters), keeps the edit-watch
  assertEqual((await loopsOf(reg)).join(','), 'editWatch', 'reconcile stops meters once a poll-driven device activates');
  unsub();
}

/** c. pauseTelemetry stops the tuner + meters; resume restores exactly what was running. */
async function pauseResume(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const reg = makeReg(mock);
  reg.__seedDriver(0x11, fakeDriver({ outputMeters: true, tuner: true }));
  await reg.detect();
  const unsub = reg.subscribe(() => {});
  await reg.setTuner(true);
  assert((await loopsOf(reg)).includes('meters'), 'meters running before pause');
  assert((await loopsOf(reg)).includes('tuner'), 'tuner running before pause');
  const resume = reg.pauseTelemetry();
  assertEqual((await loopsOf(reg)).join(','), '', 'pause stops the tuner + meters');
  resume();
  const after = (await loopsOf(reg)).sort();
  assertEqual(after.join(','), 'meters,tuner', 'resume restarts exactly the tuner + meters');
  unsub();
  await reg.setTuner(false); // the tuner timer is NOT released by unsubscribe — turn it off explicitly
}

export async function runRegistrySupervisorTests(): Promise<void> {
  setConnOverride(null);
  setProfileOverride(null);
  await loopGating();
  await reconcileOnActivate();
  await pauseResume();
}
