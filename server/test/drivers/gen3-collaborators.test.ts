// Characterization tests for the gen-3 collaborator seams that the god-class split moves behind the
// driver facade: FcReader (per-pid GET / sub-0x1b state / structured switch reads), MetersService
// (per-block monitors, looper telemetry + transport) and EditSync (push-burst diffing + poll fallback).
// These paths had no direct suite — the split is behavior-preserving, so these lock the wire decode
// BEFORE the code moves. Mocked transport, no hardware.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, SLUG_FAMILY } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16, buildLooperControl } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const FM3 = PROFILES[MODEL]!;

export const GEN3_COLLABORATOR_CASE_COUNT = 12;

const FM3_PRESET_5 = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)));

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** 5×7-bit LE packed float32 — the gen-3 response value encoding. */
function f32(x: number): number[] {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x, true);
  const u = dv.getUint32(0, true);
  return [u & 0x7f, (u >> 7) & 0x7f, (u >> 14) & 0x7f, (u >> 21) & 0x7f, (u >> 28) & 0x7f];
}

/** fn 0x01 sub-action reply carrying a packed float32 READ value at byte 12 (23-byte monitor frame). */
function valueReply(sub: number, eid: number, pid: number, value: number): number[] {
  return sysex(0x01, [sub, 0x00, ...enc14(eid), ...enc14(pid), ...f32(value), 0, 0, 0, 0]);
}

/** fn 0x01 sub-action reply whose byte-12 field is a plain LE 7-bit int (the sub-0x1b FC value channel). */
function intReply(sub: number, eid: number, pid: number, value: number): number[] {
  return sysex(0x01, [sub, 0x00, ...enc14(eid), ...enc14(pid), value & 0x7f, (value >> 7) & 0x7f, 0, 0, 0]);
}

function rosterEid(slug: string): number {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page;
}

/** fn=0x74/0x75/0x76 block-bulk-read reply frames carrying `values`. */
function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(0x75, body),
    sysex(0x76, []),
  ];
}

/** fn=0x13 status dump: id-id-dd triples, dd = (channel << 1) | bypassed. */
function statusFrame(effectId: number, channel: number): number[] {
  return sysex(0x13, [...enc14(effectId), (channel & 0x07) << 1]);
}

function makeDriver(mock: MockTransport, profile: DeviceProfile = FM3, events: { type: string; [k: string]: unknown }[] = []) {
  mock.isOpen = true;
  return createGen3Driver(profile, {
    transport: async () => mock,
    emit: (e) => events.push(e as { type: string; [k: string]: unknown }),
    getCadence: () => cadenceFor(null, 'balanced'),
  });
}

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

// ── FcReader ────────────────────────────────────────────────────────────────

async function fcReaderTests(): Promise<void> {
  const amp = rosterEid('amp');
  const mock = new MockTransport('serial', 'mock-fc');
  // readParams (sub 01), readRange (sub 1a) and fcReadState (sub 1b) all return the same value shape.
  mock.reply = (req) => {
    const fn = req[5], sub = req[6];
    if (fn === 0x01 && (sub === 0x01 || sub === 0x1a || sub === 0x1b)) {
      const eid = (req[8]! | (req[9]! << 7));
      const pid = (req[10]! | (req[11]! << 7));
      return [valueReply(sub, eid, pid, pid === 4 ? 3.5 : 0.25)];
    }
    return [];
  };
  const driver = makeDriver(mock);

  const params = await driver.readParams(amp, [4, 5]);
  assertEqual(params[4], 3.5, 'readParams decodes the packed float32 at byte 12');
  assertEqual(params[5], 0.25, 'readParams keys each pid to its own reply');
  const range = await driver.readRange(amp, [4]);
  assertEqual(range[4], 3.5, 'readRange shares the 5×7-bit float decode');

  // fcReadSwitch: sub-0x01 structured read. Selector = config*2 + side; body[14]=config, body[15] bit
  // 0x40 = HOLD, body[18..19] = the empty-slot heuristic. Script side 0 assigned, side 1 empty.
  const fcMock = new MockTransport('serial', 'mock-fc-switch');
  fcMock.reply = (req) => {
    if (req[5] !== 0x01 || req[6] !== 0x01 || req[7] !== 0x00) return [];
    const sel = (req[8]! | (req[9]! << 7));
    const side = sel % 2;
    const f = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, 0x01, 0x00, ...enc14(sel), ...new Array(70).fill(0)];
    f[21] = Math.floor(sel / 2); // body[14] = config echo
    f[22] = side ? 0x40 : 0; // body[15] = side flag
    f[25] = side ? 0 : 1; // body[18]
    f[26] = side ? 0 : 1; // body[19]
    f[f.length - 1] = 0xf7;
    return [f];
  };
  const fcSwitch = await makeDriver(fcMock).fcReadSwitch!(0, 0, 0);
  assertEqual(fcSwitch.effectId, FM3.fcModel!.effectId, 'fcReadSwitch reports the FC effectId');
  assertEqual(fcSwitch.config, 0, 'fcReadSwitch config = layout*perLayout + view*switches + switch');
  assertEqual(fcSwitch.tap.present, true, 'tap side echoes config/side → present');
  assertEqual(fcSwitch.tap.empty, false, 'assigned tap side is not empty');
  assertEqual(fcSwitch.hold.present, true, 'hold side echo validated independently');
  assertEqual(fcSwitch.hold.empty, true, 'zero value region marks an empty hold slot');

  // fcReadState: sub-0x1b value channel. Return a deterministic value per pid and echo it through the
  // driver's own field/label address math to prove the read tracks edits (unlike the 0x01 snapshot).
  const fcStateMock = new MockTransport('serial', 'mock-fc-state');
  const stateValue = (pid: number) => (pid % 26) + 65;
  fcStateMock.reply = (req) => {
    if (req[5] !== 0x01 || req[6] !== 0x1b) return [];
    const pid = (req[10]! | (req[11]! << 7));
    return [intReply(0x1b, req[8]! | (req[9]! << 7), pid, stateValue(pid))];
  };
  const fcState = await makeDriver(fcStateMock).fcReadState!(0, 0, 1);
  const fc = FM3.fcModel!;
  const pidOf = (field: string, idx = 0) => fc.fields[field]!.base! + 1 * fc.fields[field]!.stride! + idx;
  assertEqual(fcState.config, 1, 'fcReadState resolves config 1 for layout 0/view 0/switch 1');
  assertEqual(fcState.fields.color, stateValue(pidOf('color')), 'fcReadState returns the raw field ordinal');
  const expectedLabel = (field: string) =>
    Array.from({ length: fc.labelLen! }, (_, i) => String.fromCharCode(stateValue(pidOf(field, i)))).join('');
  assertEqual(fcState.tapLabel, expectedLabel('tapLabel'), 'fcReadState decodes the tap label ASCII run');
  assertEqual(fcState.holdLabel, expectedLabel('holdLabel'), 'fcReadState decodes the hold label ASCII run');
}

// ── MetersService ───────────────────────────────────────────────────────────

async function metersTests(): Promise<void> {
  const output = rosterEid('output');
  const comp = rosterEid('comp');
  const looper = rosterEid('looper');
  const mock = new MockTransport('serial', 'mock-meters');
  // Meter replies for the output VU pid (16) and the comp monitor pid (25); looper pids 14/22.
  mock.reply = (req) => {
    if (req[5] !== 0x01 || req[6] !== 0x19) return [];
    const eid = (req[8]! | (req[9]! << 7));
    const pid = (req[10]! | (req[11]! << 7));
    if (eid === output) return [valueReply(0x19, eid, pid, 1.0)]; // RMS 1.0 → 0 dB
    if (eid === comp) return [valueReply(0x19, eid, pid, 0.5)]; // normalized 0.5
    if (eid === looper) return [valueReply(0x19, eid, pid, pid === 14 ? 0.25 : 0.75)];
    return [];
  };
  const driver = makeDriver(mock);

  const out = await driver.liveMonitors!(output);
  const outVu = out.find((m) => m.family === 'OUTPUT')!;
  assert(!!outVu, 'liveMonitors returns the output VU');
  assert(near(outVu.db!, 0), `output RMS 1.0 → 0 dB (got ${outVu.db})`);
  assert(near(outVu.norm, 40 / 46), 'output norm is the dB position in [−40, 6]');

  const compMeter = (await driver.liveMonitors!(comp)).find((m) => m.family === 'COMP')!;
  assert(!!compMeter, 'liveMonitors returns the comp monitor');
  assert(near(compMeter.norm, 0.5), 'block monitor reads a normalized 0..1 level');
  assert(near(compMeter.db!, -20), 'block monitor dB = minDb + norm·(maxDb−minDb)');

  // Looper waveform: fn 0x01 sub 0x23, raw 7-bit magnitudes from byte 12.
  const waveMock = new MockTransport('serial', 'mock-looper');
  const samples = Array.from({ length: 90 }, (_, i) => i % 128);
  waveMock.reply = (req) => {
    if (req[5] !== 0x01) return [];
    if (req[6] === 0x23) return [sysex(0x01, [0x23, 0x00, ...enc14(looper), 0, 0, ...samples])];
    if (req[6] === 0x19) {
      const eid = (req[8]! | (req[9]! << 7));
      const pid = (req[10]! | (req[11]! << 7));
      return eid === looper ? [valueReply(0x19, eid, pid, pid === 14 ? 0.25 : 0.75)] : [];
    }
    return [];
  };
  const looperDriver = makeDriver(waveMock);
  const telemetry = await looperDriver.looperTelemetry!(looper);
  assertEqual(telemetry.wave.length, 90, 'looper waveform decodes the raw magnitude run');
  assert(near(telemetry.wave[0]!, 0), 'waveform sample 0 = 0/127');
  assert(near(telemetry.wave[63]!, 63 / 127), 'waveform sample n = raw/127');
  assert(near(telemetry.position!, 0.25), 'looper position rides the sub-0x19 pid-14 monitor');
  assert(near(telemetry.level!, 0.75), 'looper level rides the sub-0x19 pid-22 monitor');

  // Non-looper blocks short-circuit with no device I/O at all.
  const quiet = new MockTransport('serial', 'mock-nonlooper');
  const nonLooper = await makeDriver(quiet).looperTelemetry!(rosterEid('amp'));
  assertEqual(nonLooper.wave.length, 0, 'non-looper telemetry is empty');
  assertEqual(quiet.sent.length, 0, 'non-looper telemetry performs no device I/O');

  // looperControl sends the captured sub-0x10 float 1.0/0.0 frame at the catalog control pid.
  const ctlMock = new MockTransport('serial', 'mock-looper-ctl');
  const ctlDriver = makeDriver(ctlMock);
  const ctl = await ctlDriver.looperControl!(looper, 'record', true);
  assertEqual(ctl.ok, true, 'looperControl acknowledges a known action');
  const recordPid = (FM3.params.LOOPER ?? []).find((p) => p.name === 'LOOPER_RECORD')!.paramId;
  assertEqual(compactHex(ctlMock.sent[0]!), compactHex(buildLooperControl(looper, recordPid, true, MODEL)), 'looperControl emits the FM3-Edit control frame');
}

// ── EditSync ──────────────────────────────────────────────────────────────

const FAMILY = 'DISTORT';
const STRIDE = 20;
const AMP = rosterEid('amp');
const PID = 4;

function editProfile(): DeviceProfile {
  const roster = [{ value: 0, name: 'Amp A', manufacturer: null, basedOn: null }];
  return {
    model: MODEL, key: 'fm3', name: 'FM3-editsync-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: { [FAMILY]: [{ paramId: PID, name: `${FAMILY}_GAIN`, unit: 'numeric' }] },
    ranges: { [FAMILY]: { [PID]: { kind: 'float', displayMin: 0, displayMax: 10, typecode: 0x00 } } },
    rangeSections: { [FAMILY]: { stride: STRIDE, recordCount: STRIDE } },
    rosterFor: () => roster,
    enumLabelsFor: () => undefined,
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

async function editSyncTests(): Promise<void> {
  assertEqual(SLUG_FAMILY['amp'], FAMILY, 'amp slug maps to the DISTORT family used by the synth profile');

  // decodeEditBurst: first sight of a block is a reload (no baseline); a subsequent moved param emits
  // exactly that param, normalized, and only for pids the profile has a real range for.
  const codec = createModernFractalCodec(MODEL);
  const values = new Array(STRIDE).fill(0);
  const decoder = makeDriver(new MockTransport(), editProfile());

  const first = decoder.decodeEditBurst!(blockBulkFrames(AMP, values));
  assertEqual(first.reload, true, 'first burst for an unknown block → reload (no baseline to diff)');
  assertEqual(first.events.length, 0, 'a reload burst emits no per-param events');

  values[PID] = 32767;
  const second = decoder.decodeEditBurst!(blockBulkFrames(AMP, values));
  const moved = second.events.find((e) => e.paramId === PID);
  assert(!!moved, 'a moved param diffs out of the burst');
  assert(near(moved!.norm, 32767 / 65534, 1e-4), 'the event carries the normalized moved value');
  assertEqual(second.reload, false, 'a diffable burst is not a reload');

  // readDeviceEditState: blockParams primes the watched block, then the poll re-reads it and emits the
  // moved param directly (returning changed:false). The first blockParams read must not itself emit.
  const pollValues = new Array(STRIDE).fill(0);
  const events: { type: string; [k: string]: unknown }[] = [];
  const pollMock = new MockTransport('serial', 'mock-editsync');
  pollMock.reply = (req) => {
    const h = compactHex(req);
    if (h === compactHex(codec.buildStatusDump())) return [statusFrame(AMP, 0)];
    if (h === compactHex(codec.buildBlockBulkReadPoll(AMP))) return blockBulkFrames(AMP, pollValues);
    return [];
  };
  const pollDriver = makeDriver(pollMock, editProfile(), events);
  await pollDriver.blockParams(AMP);
  events.length = 0;
  pollValues[PID] = 65534;
  const res = await pollDriver.readDeviceEditState!();
  assertEqual(res.changed, false, 'per-param events do not also signal a reload');
  const emitted = events.filter((e) => e.type === 'param');
  assertEqual(emitted.length, 1, 'the poll emits exactly the moved param');
  assertEqual(emitted[0]!.paramId, PID, 'the emitted event names the moved param');
  assert(near(emitted[0]!.norm as number, 1), 'the emitted event carries the normalized value');

  // A local write pauses the poll so our own edit never echoes back as a device-originated change.
  await pollDriver.setParam!(AMP, PID, 0.5, false);
  const sentAfterWrite = pollMock.sent.length;
  const paused = await pollDriver.readDeviceEditState!();
  assertEqual(paused.changed, false, 'the poll is quiet right after a local write');
  assertEqual(pollMock.sent.length, sentAfterWrite, 'a paused poll performs no device read');
}

// ── Gen3Host status coalescing ──────────────────────────────────────────────

async function statusCacheTests(): Promise<void> {
  const amp = rosterEid('amp');
  const statusDump = compactHex(createModernFractalCodec(MODEL).buildStatusDump());
  const mock = new MockTransport('serial', 'mock-status-cache');
  mock.reply = (req) => (compactHex(req) === statusDump ? [statusFrame(amp, 1)] : []);
  const driver = makeDriver(mock);
  const statusReads = () => mock.sent.filter((f) => compactHex(f) === statusDump).length;

  // Concurrent consumers on one load (placedBlocks/sceneState/activeChannels) share ONE fn-0x13 read.
  await Promise.all([driver.sceneState(), driver.getActiveChannels(), driver.sceneState()]);
  assertEqual(statusReads(), 1, 'concurrent status consumers coalesce onto one fn-0x13 round-trip');

  // The short TTL keeps the next consumer off the wire (no re-read inside the burst window).
  await driver.getActiveChannels();
  assertEqual(statusReads(), 1, 'a repeated status read inside the TTL is served from cache');

  // A bypass/channel write must bust the cache so the follow-up read reflects it.
  await driver.setBypass!(amp, true);
  await driver.getActiveChannels();
  assertEqual(statusReads(), 2, 'a bypass write busts the status cache');
}

// ── PresetDecoder dump memoization ──────────────────────────────────────────

/** Split a .syx byte stream into its F0..F7 frames (the shape dumpFrames returns). */
function splitSyx(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { frames.push(cur); cur = null; }
    }
  }
  return frames;
}

async function dumpMemoTests(): Promise<void> {
  const frames = splitSyx(Uint8Array.from(FM3_PRESET_5));
  const mock = new MockTransport('serial', 'mock-dump-memo');
  mock.reply = (req) => (req[5] === 0x03 ? frames : []); // fn 0x03 = request preset dump
  const driver = makeDriver(mock);
  const dumps = () => mock.sent.filter((f) => f[5] === 0x03).length;

  // One dump serves the full summary (with params), the params read, and the raw .syx read.
  const summary = await driver.presetSummary(5, true);
  assertEqual(dumps(), 1, 'first summary triggers exactly one dump');
  assert(summary.name.length > 0, 'summary decodes the preset name');
  const summaryParams = summary.params;
  assert(!!summaryParams && summaryParams.length > 0, 'full summary embeds decoded block params');

  const params = await driver.presetParams(5);
  assertEqual(dumps(), 1, 'presetParams reuses the memoized dump (no re-dump)');
  assertEqual(params.length, summaryParams.length, 'presetParams returns the same decode as the summary');

  const raw = await driver.dumpRaw(5);
  assertEqual(dumps(), 1, 'dumpRaw reuses the memoized dump (no re-dump)');
  assert(raw.bytes.length > 0, 'dumpRaw returns the .syx bytes');

  // A warm slot serves concurrent callers straight from cache — zero wire reads.
  mock.sent.length = 0;
  await Promise.all([driver.presetSummary(5), driver.presetParams(5), driver.dumpRaw(5)]);
  assertEqual(dumps(), 0, 'a warm slot serves concurrent callers without touching the wire');

  // Concurrent COLD callers for one slot coalesce onto a single dump (single-flight).
  const coldMock = new MockTransport('serial', 'mock-dump-memo-cold');
  coldMock.reply = (req) => (req[5] === 0x03 ? frames : []);
  const coldDriver = makeDriver(coldMock);
  await Promise.all([coldDriver.presetSummary(5), coldDriver.presetParams(5), coldDriver.dumpRaw(5)]);
  assertEqual(coldMock.sent.filter((f) => f[5] === 0x03).length, 1, 'concurrent cold callers share one dump');

  // Storing to the slot changes its content → the memo must be busted and re-read.
  await driver.store(5);
  await driver.presetSummary(5);
  assertEqual(dumps(), 1, 'a store write invalidates that slot\'s memo');
}

export async function runGen3CollaboratorTests(): Promise<void> {
  await fcReaderTests();
  console.log('  drivers/gen3-collaborators: FcReader GET/range/switch/state decodes locked');
  await metersTests();
  console.log('  drivers/gen3-collaborators: MetersService monitor/looper reads + control locked');
  await editSyncTests();
  console.log('  drivers/gen3-collaborators: EditSync burst diff + poll fallback locked');
  await statusCacheTests();
  console.log('  drivers/gen3-collaborators: Gen3Host status dump coalesced + busted on writes');
  await dumpMemoTests();
  console.log('  drivers/gen3-collaborators: PresetDecoder dumps memoized by slot + crc, busted on store');
}
