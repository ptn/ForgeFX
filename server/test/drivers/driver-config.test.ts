// Driver config injection tests: the drivers take their runtime knobs (FM3 edit-sync poll, AM4 struct
// hex-dump, gen-3 raw GET dump) through DriverCtx.config — NEVER process.env — so the browser runtime
// has no build-time env-substitution dependency and tests can drive each flag directly. A ctx-supplied
// flag wins even when the matching env var says otherwise, which is the regression guard for the fix.
import '../helpers/env.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { createAm4Driver } from '../../src/drivers/am4.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import type { DriverConfig, DriverCtx, DeviceEvent } from '../../src/drivers/types.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

export const DRIVER_CONFIG_CASE_COUNT = 7;

const MODEL_FM3 = 0x11;
const MODEL_FM9 = 0x12;
const GET_EID = 5;
const GET_PID = 4;

const ctxFor = (mock: MockTransport, config: DriverConfig, emit: (e: DeviceEvent) => void = () => {}): DriverCtx => ({
  transport: async () => mock,
  emit,
  getCadence: () => cadenceFor(null, 'balanced'),
  config,
});

const CONFIG = (over: Partial<DriverConfig> = {}): DriverConfig => ({
  fm3EditSync: true,
  am4Debug: true,
  getDump: false,
  ...over,
});

/** Run `fn` with console.log captured, returning the emitted lines (drivers log their dumps there). */
async function captured(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
/** F0 00 01 74 <model> <fn> <payload> <cksum> F7. */
function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn 0x01 sub-0x01 value reply a gen-3 readParams matches on (payload decodes to zero, irrelevant here). */
const getReply = (): number[] =>
  sysex(MODEL_FM3, 0x01, [0x01, 0x00, ...enc14(GET_EID), ...enc14(GET_PID), 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Minimal fn-0x1F AM4 structure response (isStructResponse): 12-byte header + 220 septets + cs F7. */
function am4StructReply(): number[] {
  return [0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, 0, 0, 0, 0, 0x1f, 0x00, ...new Array(220).fill(0), 0x00, 0xf7];
}

function fm3EditSyncTests(): void {
  const prev = process.env.FORGEFX_FM3_EDITSYNC;
  process.env.FORGEFX_FM3_EDITSYNC = '0'; // prove config, not the env var, decides
  try {
    const off = createGen3Driver(PROFILES[MODEL_FM3]!, ctxFor(new MockTransport(), CONFIG({ fm3EditSync: false })));
    assertEqual(off.capabilities.deviceEditWatch, false, 'fm3EditSync:false turns the FM3 edit-watch poll off');
    const on = createGen3Driver(PROFILES[MODEL_FM3]!, ctxFor(new MockTransport(), CONFIG({ fm3EditSync: true })));
    assertEqual(
      on.capabilities.deviceEditWatch,
      true,
      'fm3EditSync:true keeps the poll on despite env=0 (config wins over env)',
    );
  } finally {
    if (prev === undefined) delete process.env.FORGEFX_FM3_EDITSYNC;
    else process.env.FORGEFX_FM3_EDITSYNC = prev;
  }
  const fm9 = createGen3Driver(PROFILES[MODEL_FM9]!, ctxFor(new MockTransport(), CONFIG({ fm3EditSync: true })));
  assertEqual(fm9.capabilities.deviceEditWatch, false, 'only the FM3 polls; the FM9 pushes so it never watches');
}

async function getDumpTests(): Promise<void> {
  const mock = new MockTransport('serial', 'mock-getdump');
  mock.reply = () => [getReply()];
  const loud = await captured(() =>
    createGen3Driver(PROFILES[MODEL_FM3]!, ctxFor(mock, CONFIG({ getDump: true }))).readParams(GET_EID, [GET_PID]),
  );
  assert(
    loud.some((l) => l.startsWith('GETDUMP')),
    'getDump:true dumps the raw GET frame',
  );

  const quietMock = new MockTransport('serial', 'mock-getdump-quiet');
  quietMock.reply = () => [getReply()];
  const quiet = await captured(() =>
    createGen3Driver(PROFILES[MODEL_FM3]!, ctxFor(quietMock, CONFIG({ getDump: false }))).readParams(GET_EID, [
      GET_PID,
    ]),
  );
  assert(!quiet.some((l) => l.startsWith('GETDUMP')), 'getDump:false stays silent');
}

async function am4DebugTests(): Promise<void> {
  const loudMock = new MockTransport('serial', 'mock-am4-debug');
  loudMock.reply = () => [am4StructReply()];
  const loud = await captured(() => createAm4Driver(ctxFor(loudMock, CONFIG({ am4Debug: true }))).presetRef());
  assert(
    loud.some((l) => l.includes('struct[192]')),
    'am4Debug:true dumps the unpacked structure',
  );

  const quietMock = new MockTransport('serial', 'mock-am4-quiet');
  quietMock.reply = () => [am4StructReply()];
  const quiet = await captured(() => createAm4Driver(ctxFor(quietMock, CONFIG({ am4Debug: false }))).presetRef());
  assert(!quiet.some((l) => l.includes('struct[192]')), 'am4Debug:false silences the struct dump');
}

export async function runDriverConfigTests(): Promise<void> {
  fm3EditSyncTests();
  console.log('  drivers/driver-config: FM3 edit-watch gate follows DriverCtx.config, not process.env');
  await getDumpTests();
  console.log('  drivers/driver-config: gen-3 raw GET dump follows DriverCtx.config.getDump');
  await am4DebugTests();
  console.log('  drivers/driver-config: AM4 struct dump follows DriverCtx.config.am4Debug');
}
