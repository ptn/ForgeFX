// Saved-block library write: POST /fm3edit/blocks/save captures the placed block's live burst,
// authors a `.blk` (effectTypeId + firmware from the connected unit) and writes it under the
// caller-selected library dir's per-category folder.
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../helpers/env.js';
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { __setFirmwareForTest } from '../../src/drivers/registry.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';
import { parseGen3BlockFile } from 'forgefx-midi/devices/gen3';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'block-library');

export const BLOCK_LIBRARY_SAVE_CASE_COUNT = 6;

// A real FM3 Drive burst (the RAT fixture's payload) — the fake driver's captured burst.
const RAT_PAYLOAD = parseGen3BlockFile(new Uint8Array(readFileSync(join(FIXTURES, 'rat.blk')))).payload;

interface RecordedCapture { eid: number; scope: 'current' | 'all'; }

function makeDriver(records: RecordedCapture[], slug = 'drive'): DeviceDriver {
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: {} as DriverCapabilities,
    grid: async () => ({ model: 'fm3', name: '', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' }),
    captureBlockForSave: async (eid, scope) => {
      records.push({ eid, scope });
      return {
        blockId: 118,
        itemCount: RAT_PAYLOAD.length,
        values: [],
        activeChannel: 1,
        slug,
        payload: RAT_PAYLOAD,
      };
    },
  };
}

function tempLibrary(): string {
  return mkdtempSync(join(tmpdir(), 'block-lib-save-'));
}

async function savesBlockToLibrary(): Promise<void> {
  const records: RecordedCapture[] = [];
  const { app, registry } = await buildTestApp(0x11, makeDriver(records));
  __setFirmwareForTest(registry, { major: 11, minor: 0, version: '11.00', build: '0' });
  const lib = tempLibrary();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/fm3edit/blocks/save',
      payload: { libraryPath: lib, name: 'Test Drive', effectId: 118 },
    });
    assertEqual(res.statusCode, 200, 'save succeeds');
    const body = res.json() as { ok: boolean; path: string; category: string; name: string };
    assert(body.ok, 'save reports ok');
    assertEqual(body.category, 'Drive', 'block lands in the Drive category folder');
    assertEqual(body.name, 'Test Drive', 'echoes the requested name');
    assert(existsSync(body.path), 'file exists at the reported path');
    assert(body.path.startsWith(join(lib, 'Drive', 'Test Drive_')), 'path is <lib>/Drive/<name>_<timestamp>.blk');

    const dirFiles = readdirSync(join(lib, 'Drive'));
    assertEqual(dirFiles.length, 1, 'exactly one file written');
    const written = parseGen3BlockFile(new Uint8Array(readFileSync(body.path)));
    assertEqual(written.name, 'Test Drive', 'written file carries the requested name');
    assertEqual(written.effectTypeId, 25, 'written file carries the Drive effect-type id');
    assertEqual(written.activeChannel, 1, 'written file records the active channel');
    assertEqual(written.firmware.major, 11, 'written file carries the device firmware major');
    assertEqual(written.headerModelId, 0x11, 'written file carries the device model byte');
  } finally {
    await app.close();
    rmSync(lib, { recursive: true, force: true });
  }
}

async function modeDefaultsToCurrent(): Promise<void> {
  const records: RecordedCapture[] = [];
  const { app, registry } = await buildTestApp(0x11, makeDriver(records));
  __setFirmwareForTest(registry, { major: 11, minor: 0, version: '11.00', build: '0' });
  const lib = tempLibrary();
  try {
    await app.inject({ method: 'POST', url: '/fm3edit/blocks/save', payload: { libraryPath: lib, name: 'A', effectId: 118 } });
    assertEqual(records[0]!.scope, 'current', 'omitted mode defaults to current');

    await app.inject({ method: 'POST', url: '/fm3edit/blocks/save', payload: { libraryPath: lib, name: 'B', effectId: 118, mode: 'all' } });
    assertEqual(records[1]!.scope, 'all', 'explicit all mode forwards');
  } finally {
    await app.close();
    rmSync(lib, { recursive: true, force: true });
  }
}

async function rejectsMissingLibraryPath(): Promise<void> {
  const { app } = await buildTestApp(0x11, makeDriver([]));
  try {
    const res = await app.inject({ method: 'POST', url: '/fm3edit/blocks/save', payload: { name: 'X', effectId: 118 } });
    assertEqual(res.statusCode, 400, 'missing libraryPath is rejected');
  } finally {
    await app.close();
  }
}

async function rejectsUnsafeName(): Promise<void> {
  const { app, registry } = await buildTestApp(0x11, makeDriver([]));
  __setFirmwareForTest(registry, { major: 11, minor: 0, version: '11.00', build: '0' });
  try {
    const res = await app.inject({ method: 'POST', url: '/fm3edit/blocks/save', payload: { libraryPath: '/tmp/x', name: '../evil', effectId: 118 } });
    assertEqual(res.statusCode, 400, 'path-traversing name is rejected');
  } finally {
    await app.close();
  }
}

async function rejectsUnknownFamily(): Promise<void> {
  const { app, registry } = await buildTestApp(0x11, makeDriver([], 'send'));
  __setFirmwareForTest(registry, { major: 11, minor: 0, version: '11.00', build: '0' });
  try {
    const res = await app.inject({ method: 'POST', url: '/fm3edit/blocks/save', payload: { libraryPath: '/tmp/x', name: 'Send', effectId: 118 } });
    assertEqual(res.statusCode, 422, 'family with no confirmed effect-type id is rejected');
  } finally {
    await app.close();
  }
}

async function rejectsMissingFirmware(): Promise<void> {
  const { app } = await buildTestApp(0x11, makeDriver([]));
  try {
    const res = await app.inject({ method: 'POST', url: '/fm3edit/blocks/save', payload: { libraryPath: '/tmp/x', name: 'X', effectId: 118 } });
    assertEqual(res.statusCode, 400, 'save without a device-reported firmware is refused');
  } finally {
    await app.close();
  }
}

export async function runBlockLibrarySaveTests(): Promise<void> {
  await savesBlockToLibrary();
  await modeDefaultsToCurrent();
  await rejectsMissingLibraryPath();
  await rejectsUnsafeName();
  await rejectsUnknownFamily();
  await rejectsMissingFirmware();
}
