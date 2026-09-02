// Gen-3 LIVE grid path (fn 0x01 / sub 0x2E) — mocked transport, no hardware.
//
// The whole-preset dump takes ~1.2s on a slow MIDI link, which is the audible gap after a preset
// change. FM3 reads the routing grid live instead. These cases lock the branch: FM3 takes the live
// path and never dumps, every other gen-3 model still dumps, and ANY live-path failure falls back
// to the dump rather than surfacing an error or a wrong grid.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const FM3 = 0x11;
const FM9 = 0x12;

const FN_QUERY_PATCH_NAME = 0x0d;
const FN_QUERY_SCENE_NAME = 0x0e;
const FM3_REGION_OFFSET = 366;
const FM3_BASE_BIT = 6;
const FM3_COL_STRIDE = 128;
const FM3_ROW_STRIDE = 32;

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0x7f);

/** fn 0x0D current-preset reply: 14-bit preset number (LE 7-bit pair) + name. */
function patchNameReply(model: number, number: number, name: string): number[] {
  return sysex(model, FN_QUERY_PATCH_NAME, [number & 0x7f, (number >> 7) & 0x7f, ...ascii(name), 0x00]);
}
/** fn 0x0E scene-name reply: scene index + name. */
function sceneNameReply(model: number, scene: number, name: string): number[] {
  return sysex(model, FN_QUERY_SCENE_NAME, [scene & 0x07, ...ascii(name), 0x00]);
}

/** MSB-first bit writer into a 7-bit-packed stream (inverse of gridLayout.ts's reader). */
function writeBitsMsb(region: number[], bit: number, value: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    region[Math.floor(b / 7)] = (region[Math.floor(b / 7)] ?? 0) | (((value >> (n - 1 - i)) & 1) << (6 - (b % 7)));
  }
}

/** A sub-0x2E FM3 grid reply carrying the given cells (32-bit BE per cell, column-major 12x4). */
function gridLayoutReply(cells: { col: number; row: number; id: number; type: number; cable: number }[]): number[] {
  const region = new Array(230).fill(0);
  for (const c of cells) {
    const base = FM3_BASE_BIT + c.col * FM3_COL_STRIDE + c.row * FM3_ROW_STRIDE;
    writeBitsMsb(region, base + 0, c.id, 12);
    writeBitsMsb(region, base + 16, c.type, 8);
    writeBitsMsb(region, base + 24, c.cable << 4, 8);
  }
  // fn 0x01 / sub 0x2E, then the region at mido offset 366 (= frame index 367, so the payload —
  // which starts at frame index 6 — carries 361 bytes ahead of it).
  const head = [0x2e, ...new Array(FM3_REGION_OFFSET - 6).fill(0)];
  return sysex(FM3, 0x01, [...head, ...region]);
}

/** An Amp at c0r0, a shunt at c1r0 fed from row 0, a Comp at c2r1 fed from row 0. */
const SAMPLE_CELLS = [
  { col: 0, row: 0, id: 58, type: 0x00, cable: 0b0000 },
  { col: 1, row: 0, id: 1024, type: 0x40, cable: 0b0001 },
  { col: 2, row: 1, id: 46, type: 0x00, cable: 0b0001 },
];

const isDumpRequest = (f: readonly number[]) => f[5] === 0x03; // FN_REQUEST_PRESET_DUMP
const isGridLayoutRequest = (f: readonly number[]) => f[5] === 0x01 && f[6] === 0x2e;

function driverFor(model: number, mock: MockTransport) {
  return createGen3Driver(PROFILES[model]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(null, 'balanced')
  });
}

/** Mock that answers the live path: current preset, 8 scene names, and the grid frame. */
function liveMock(opts: { grid?: boolean } = {}): MockTransport {
  const mock = new MockTransport('serial', 'mock-fm3');
  mock.isOpen = true;
  mock.reply = (bytes) => {
    if (bytes[5] === FN_QUERY_PATCH_NAME) return [patchNameReply(FM3, 7, 'Live Test')];
    if (bytes[5] === FN_QUERY_SCENE_NAME) return [sceneNameReply(FM3, bytes[6]!, `Scene ${bytes[6]! + 1}`)];
    if (isGridLayoutRequest(bytes)) return opts.grid === false ? [] : [gridLayoutReply(SAMPLE_CELLS)];
    return [];
  };
  return mock;
}

const cases: Array<() => Promise<void>> = [];

// 1. FM3 reads the grid live — decoded cells, preset name, scene names, and NO preset dump.
cases.push(async () => {
  const mock = liveMock();
  const g = await driverFor(FM3, mock).grid();

  assertEqual(g.source, 'live', 'FM3 grid source');
  assertEqual(g.name, 'Live Test', 'preset name comes from the current-preset query');
  assertEqual(g.crcValid, false, 'the live read has no CRC over the grid');
  assertEqual(g.rows, 4, 'FM3 grid rows');
  assertEqual(g.cols, 12, 'FM3 grid cols');
  assertEqual(g.scenes.length, 8, 'all 8 scene names are read');
  assertEqual(g.scenes[0], 'Scene 1', 'first scene name');
  assert(!mock.sent.some(isDumpRequest), 'the live path must NOT request a preset dump');
  assert(mock.sent.some(isGridLayoutRequest), 'the live path requests the sub-0x2E layout');

  assertEqual(g.cells.length, 3, 'decoded cell count');
  const amp = g.cells.find((c) => c.col === 0 && c.row === 0)!;
  assertEqual(amp.effectId, 58, 'c0r0 effect id');
  assertEqual(amp.name, 'Amp 1', 'c0r0 name uses the dump decoder naming convention');
  assertEqual(amp.isShunt, false, 'c0r0 is a real block');

  const shunt = g.cells.find((c) => c.col === 1 && c.row === 0)!;
  assertEqual(shunt.isShunt, true, 'c1r0 is a shunt');
  assert(shunt.effectId >= 1024, `shunt id must sit in the shunt range (got ${shunt.effectId})`);
  assertEqual(shunt.name, 'Shunt 1', 'shunt name matches the dump convention');
  assertEqual(JSON.stringify(shunt.fromRows), '[0]', 'shunt cable decodes to source row 0');

  const comp = g.cells.find((c) => c.col === 2 && c.row === 1)!;
  assertEqual(comp.effectId, 46, 'c2r1 effect id');
  assertEqual(JSON.stringify(comp.fromRows), '[0]', 'comp cable decodes to source row 0');
});

// 2. A shunt stored as a SMALL sequential index is rebased into the shunt id range, so the ids the
//    live path reports are interchangeable with the dump's (Axis allocates new shunts off them).
cases.push(async () => {
  const mock = liveMock();
  mock.reply = (bytes) => {
    if (bytes[5] === FN_QUERY_PATCH_NAME) return [patchNameReply(FM3, 7, 'Live Test')];
    if (bytes[5] === FN_QUERY_SCENE_NAME) return [sceneNameReply(FM3, bytes[6]!, '')];
    if (isGridLayoutRequest(bytes)) return [gridLayoutReply([{ col: 0, row: 0, id: 2, type: 0x40, cable: 0 }])];
    return [];
  };
  const g = await driverFor(FM3, mock).grid();
  const shunt = g.cells[0]!;
  assertEqual(shunt.isShunt, true, 'the cell is a shunt');
  assertEqual(shunt.effectId, 1025, 'a small shunt index is rebased onto the shunt base');
  assertEqual(shunt.name, 'Shunt 2', 'rebased shunt keeps the dump naming');
});

// 3. No sub-0x2E reply → fall back to the dump rather than erroring or showing a stale grid.
cases.push(async () => {
  const mock = liveMock({ grid: false });
  let threw = false;
  try {
    await driverFor(FM3, mock).grid();
  } catch {
    threw = true; // the mock answers no dump either — the dump decode is what fails, not the branch
  }
  assert(mock.sent.some(isGridLayoutRequest), 'the live read is attempted first');
  assert(mock.sent.some(isDumpRequest), 'a failed live read falls back to the preset dump');
  assert(threw, 'with neither read answered, the dump path surfaces its own decode error');
});

// 4. No current-preset reply → no way to key scene names to THIS preset → dump.
cases.push(async () => {
  const mock = new MockTransport('serial', 'mock-fm3');
  mock.isOpen = true;
  mock.reply = (bytes) => (isGridLayoutRequest(bytes) ? [gridLayoutReply(SAMPLE_CELLS)] : []);
  try {
    await driverFor(FM3, mock).grid();
  } catch {
    /* dump unanswered */
  }
  assert(mock.sent.some(isDumpRequest), 'an unresolvable current preset falls back to the preset dump');
});

// 5. Non-FM3 gen-3 models keep the dump — their sub-0x2E decode is community-beta, not device-confirmed.
cases.push(async () => {
  const mock = new MockTransport('serial', 'mock-fm9');
  mock.isOpen = true;
  try {
    await driverFor(FM9, mock).grid();
  } catch {
    /* silent mock → dump decode throws, which is the point: it went down the dump path */
  }
  assert(!mock.sent.some(isGridLayoutRequest), 'FM9 must not issue the live grid query');
  assert(mock.sent.some(isDumpRequest), 'FM9 still dumps the preset');
});

// 6. Scene names are cached per preset — a second grid read (after the grid TTL is busted by an
//    edit-buffer change) re-reads the layout but NOT the 8 scene names.
cases.push(async () => {
  const mock = liveMock();
  const driver = driverFor(FM3, mock);
  await driver.grid();
  const sceneReadsAfterFirst = mock.sent.filter((f) => f[5] === FN_QUERY_SCENE_NAME).length;
  assertEqual(sceneReadsAfterFirst, 8, 'the first live grid reads all 8 scene names');

  await driver.loadPresetBytes(Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x77, 0x00, 0x00, 0xf7]));
  mock.sent.length = 0;
  await driver.grid();
  assertEqual(mock.sent.filter((f) => f[5] === FN_QUERY_SCENE_NAME).length, 8, 'an edit-buffer replacement re-reads scene names');

  mock.sent.length = 0;
  await driver.cable(1, 1, 2, true); // busts the grid cache, not the scene cache (rows/cols are 1-indexed here)
  await driver.grid();
  assertEqual(mock.sent.filter((f) => f[5] === FN_QUERY_SCENE_NAME).length, 0, 'scene names are served from cache on the same preset');
  assert(mock.sent.some(isGridLayoutRequest), 'the layout itself is re-read');
});

export const GEN3_LIVEGRID_CASE_COUNT = cases.length;
export async function runGen3LiveGridTests(): Promise<void> {
  for (const c of cases) await c();
}
