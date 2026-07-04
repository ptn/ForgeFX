// Detection state-machine unit tests — mocked Conn/Transport, NO hardware.
// Exercises DeviceRegistry.detect() through the test-only injection seam
// (__createRegistryForTest): handshake reply, MIDI port-name fallback, forced
// profile override, silent/absent device, and the telemetry-supervisor gates.
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { setProfileOverride, setConnOverride } from '../../src/transport/connection.js';
import type { Conn } from '../../src/transport/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';

export const DETECTION_CASE_COUNT = 9;

function makeRegistry(conn: Conn | null, mock: MockTransport): DeviceRegistry {
  return __createRegistryForTest({
    resolveConn: async () => conn,
    openConn: () => mock
  });
}

/** a. Serial FM3: handshake reply `F0 00 01 74 11 …` → active driver modelId 0x11, key 'fm3'. */
async function serialFm3(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const reg = makeRegistry({ transport: 'serial', id: '/dev/ttyACM0' }, mock);
  const r = await reg.detect();
  assertEqual(r.connected, true, 'serial FM3 connected');
  assertEqual(r.modelId, 0x11, 'serial FM3 modelId');
  assertEqual(r.name, 'FM3', 'serial FM3 name');
  const d = await reg.driver();
  assertEqual(d.modelId, 0x11, 'active driver modelId');
  assertEqual(d.key, 'fm3', 'active driver key');
  assert(mock.sent.some((f) => isIdentifyBroadcast(f)), 'handshake broadcast was sent');
}

/** b. MIDI-only Axe-Fx III replying (the Windows scenario): reply model 0x10 → driver 0x10 'axe3'. */
async function midiAxe3Replying(): Promise<void> {
  const mock = new MockTransport('midi', 'Axe-Fx III');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x10)] : []);
  const reg = makeRegistry(
    { transport: 'midi', id: 'Axe-Fx III MIDI In', inId: 'Axe-Fx III MIDI In', outId: 'Axe-Fx III MIDI Out' },
    mock
  );
  const r = await reg.detect();
  assertEqual(r.connected, true, 'MIDI III connected');
  assertEqual(r.modelId, 0x10, 'MIDI III modelId');
  const d = await reg.driver();
  assertEqual(d.modelId, 0x10, 'active driver modelId');
  assertEqual(d.key, 'axe3', 'active driver key');
}

/** c. Silent MIDI + Fractal port name: no handshake reply, inId 'Axe-Fx III MIDI In' → 0x10. */
async function silentMidiPortNameFallback(): Promise<void> {
  const mock = new MockTransport('midi', 'Axe-Fx III');
  // device never answers the broadcast (Windows USB-MIDI): reply stays the default []
  const reg = makeRegistry(
    { transport: 'midi', id: 'Axe-Fx III MIDI In', inId: 'Axe-Fx III MIDI In', outId: 'Axe-Fx III MIDI Out' },
    mock
  );
  const r = await reg.detect();
  assertEqual(r.connected, true, 'port-name fallback connected');
  assertEqual(r.modelId, 0x10, 'port-name fallback modelId');
  const d = await reg.driver();
  assertEqual(d.key, 'axe3', 'port-name fallback driver key');
}

/** d. Forced override 'am4': am4 driver active (0x15), handshake NOT sent, telemetry supervisor
 *     does not start even with an SSE subscriber. */
async function forcedAm4(): Promise<void> {
  const mock = new MockTransport('midi', 'AM4');
  const reg = makeRegistry({ transport: 'midi', id: 'AM4 MIDI In', inId: 'AM4 MIDI In', outId: 'AM4 MIDI Out' }, mock);
  setProfileOverride('am4');
  try {
    const r = await reg.detect();
    assertEqual(r.modelId, 0x15, 'forced am4 modelId');
    assertEqual(r.connected, true, 'forced am4 connected');
    const d = await reg.driver();
    assertEqual(d.modelId, 0x15, 'active driver modelId');
    assertEqual(d.key, 'am4', 'active driver key');
    assert(!mock.sent.some((f) => isIdentifyBroadcast(f)), 'handshake must be skipped on a forced profile');
    assertEqual(mock.sent.length, 0, 'forced detect sends nothing');
    // SSE subscriber present → meter supervisor would normally spin up; the AM4 driver's
    // capabilities (no gen-3 telemetry) must keep it off entirely.
    const unsub = reg.subscribe(() => {});
    await sleep(250); // longer than the 120 ms first meter tick
    assertEqual(mock.sent.length, 0, 'no telemetry frames may be fired at an AM4');
    unsub();
  } finally {
    setProfileOverride(null);
    setConnOverride(null);
  }
}

/** e. No device: resolveConn → null → detect() returns {connected:false, modelId:-1}. */
async function noDevice(): Promise<void> {
  const mock = new MockTransport();
  const reg = makeRegistry(null, mock);
  const r = await reg.detect();
  assertEqual(r.connected, false, 'no device connected flag');
  assertEqual(r.modelId, -1, 'no device modelId');
  assertEqual(r.port, null, 'no device port');
  assertEqual(mock.sent.length, 0, 'nothing sent with no device');
}

/** f. Silent MIDI + non-Fractal port name → no positive ID; the telemetry supervisor must NOT
 *     poll (no frames beyond the one handshake broadcast, even with an SSE subscriber). */
async function silentUnknownMidi(): Promise<void> {
  const mock = new MockTransport('midi', 'USB MIDI Interface');
  const reg = makeRegistry(
    { transport: 'midi', id: 'USB MIDI Interface', inId: 'USB MIDI Interface', outId: 'USB MIDI Interface' },
    mock
  );
  const r = await reg.detect();
  assertEqual(r.connected, false, 'unknown MIDI not identified');
  assertEqual(r.modelId, -1, 'unknown MIDI modelId');
  const unsub = reg.subscribe(() => {});
  // meter supervisor first tick at 120 ms, then 300 ms wait-for-driver cycles — cover a few
  await sleep(600);
  const nonHandshake = mock.sent.filter((f) => !isIdentifyBroadcast(f));
  assertEqual(nonHandshake.length, 0, 'no telemetry frames at an unidentified device');
  unsub();
}

/** g. Axe-Fx II (gen-2) handshake reply model 0x07 → driver 0x07 'axe2' (grid device). */
async function serialAxe2(): Promise<void> {
  const mock = new MockTransport('midi', 'Axe-Fx II XL+');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x07)] : []);
  const reg = makeRegistry(
    { transport: 'midi', id: 'Axe-Fx II XL+ MIDI In', inId: 'Axe-Fx II XL+ MIDI In', outId: 'Axe-Fx II XL+ MIDI Out' },
    mock
  );
  const r = await reg.detect();
  assertEqual(r.connected, true, 'Axe-Fx II connected');
  assertEqual(r.modelId, 0x07, 'Axe-Fx II modelId');
  const d = await reg.driver();
  assertEqual(d.modelId, 0x07, 'active driver modelId');
  assertEqual(d.key, 'axe2', 'active driver key');
  assertEqual(d.capabilities.slotModel, 'grid', 'Axe-Fx II is a grid device');
}

/** h. VP4 handshake reply model 0x14 → driver 0x14 'vp4' (linear 4-slot). */
async function serialVp4(): Promise<void> {
  const mock = new MockTransport('midi', 'VP4');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x14)] : []);
  const reg = makeRegistry({ transport: 'midi', id: 'VP4 MIDI In', inId: 'VP4 MIDI In', outId: 'VP4 MIDI Out' }, mock);
  const r = await reg.detect();
  assertEqual(r.connected, true, 'VP4 connected');
  assertEqual(r.modelId, 0x14, 'VP4 modelId');
  const d = await reg.driver();
  assertEqual(d.modelId, 0x14, 'active driver modelId');
  assertEqual(d.key, 'vp4', 'active driver key');
  assertEqual(d.capabilities.slotModel, 'linear', 'VP4 is a linear device');
  assertEqual(d.capabilities.slotCount, 4, 'VP4 has 4 slots');
}

/** i. Port-name fallback for the newly codec-enabled gen-2 / VP4, and the longest-name regression
 *     guard: enabling codec on "Axe-Fx II XL+" must NOT steal an "Axe-Fx III" port from 0x10. */
async function portNameNewDevices(): Promise<void> {
  const vp4Mock = new MockTransport('midi', 'VP4');
  const vp4Reg = makeRegistry({ transport: 'midi', id: 'VP4 USB MIDI', inId: 'VP4 USB MIDI', outId: 'VP4 USB MIDI' }, vp4Mock);
  assertEqual((await vp4Reg.detect()).modelId, 0x14, 'VP4 port-name fallback → 0x14');

  const a2Mock = new MockTransport('midi', 'Axe-Fx II XL+');
  const a2Reg = makeRegistry({ transport: 'midi', id: 'Axe-Fx II XL+ MIDI', inId: 'Axe-Fx II XL+ MIDI', outId: 'Axe-Fx II XL+ MIDI' }, a2Mock);
  assertEqual((await a2Reg.detect()).modelId, 0x07, 'Axe-Fx II port-name fallback → 0x07');

  // regression: an Axe-Fx III port must still resolve to 0x10, not be captured by the "Axe-Fx II" substring
  const a3Mock = new MockTransport('midi', 'Axe-Fx III');
  const a3Reg = makeRegistry({ transport: 'midi', id: 'Axe-Fx III MIDI In', inId: 'Axe-Fx III MIDI In', outId: 'Axe-Fx III MIDI Out' }, a3Mock);
  assertEqual((await a3Reg.detect()).modelId, 0x10, 'Axe-Fx III still wins the longest-name match');
}

export async function runDetectionTests(): Promise<void> {
  // isolation guard: these tests must never run against a persisted user override
  setConnOverride(null);
  setProfileOverride(null);
  await serialFm3();
  await midiAxe3Replying();
  await silentMidiPortNameFallback();
  await forcedAm4();
  await noDevice();
  await silentUnknownMidi();
  await serialAxe2();
  await serialVp4();
  await portNameNewDevices();
}
