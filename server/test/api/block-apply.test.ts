// Saved-block apply: Axis sends the decoded /fm3edit/blocks/decode JSON once; ForgeFX validates the
// target and applies the whole block in ONE bulk burst (the gen-3 0x74/0x75/0x76 EFFECT_DUMP write).
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { buildTestApp } from '../helpers/api.js';
import { assertEqual } from '../helpers/mock.js';

export const BLOCK_APPLY_CASE_COUNT = 5;

const savedBlock = {
  device: 'FM3',
  slug: 'drive',
  activeChannel: 1,
  itemCount: 4,
  values: [7, 32767, 8, 65534],
};

type RecordedApply = { eid: number; block: { itemCount: number; values: number[] }; activeChannel: number };

function makeDriver(records: RecordedApply[], failApply = false): DeviceDriver {
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: {} as DriverCapabilities,
    grid: async () => ({ model: 'fm3', name: '', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' }),
    placedBlocks: async () => [{ slug: 'drive', name: 'Drive 1', effectId: 118, row: 1, col: 1, fromRows: [], bypassed: false, channel: 'A' }],
    applyBlock: async (eid, block, activeChannel) => {
      records.push({ eid, block, activeChannel });
      if (failApply) throw new Error('bulk write rejected');
      return { ok: true };
    },
  };
}

async function appliesBulkBlock(): Promise<void> {
  const records: RecordedApply[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(records));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: savedBlock });
    assertEqual(res.statusCode, 200, 'apply succeeds');
    assertEqual(res.payload, JSON.stringify({ ok: true, params: 4, activeChannel: 1 }), 'apply result reports the item count + active channel');
    assertEqual(records.length, 1, 'exactly one applyBlock call');
    assertEqual(records[0]!.eid, 118, 'applyBlock targets the placed block eid');
    assertEqual(records[0]!.activeChannel, 1, 'applyBlock restores the saved active channel');
    assertEqual(JSON.stringify(records[0]!.block), JSON.stringify({ itemCount: 4, values: [7, 32767, 8, 65534] }), 'applyBlock forwards the raw positional values');
  } finally {
    await app.close();
  }
}

async function appliesCrossDeviceBlock(): Promise<void> {
  const records: RecordedApply[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(records));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: { ...savedBlock, device: 'FM9' } });
    assertEqual(res.statusCode, 200, 'a block saved for a different device still applies');
    assertEqual(res.payload, JSON.stringify({ ok: true, params: 4, activeChannel: 1 }), 'cross-device apply result matches the same-device result');
    assertEqual(records.length, 1, 'exactly one applyBlock call for a cross-device block');
  } finally {
    await app.close();
  }
}

async function rejectsWrongFamilyBeforeWrites(): Promise<void> {
  const records: RecordedApply[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(records));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: { ...savedBlock, slug: 'amp' } });
    assertEqual(res.statusCode, 422, 'mismatched saved-block family is rejected');
    assertEqual(res.payload, JSON.stringify({ error: 'saved-block-family-mismatch', target: 'drive', saved: 'amp' }), 'family rejection identifies both families');
    assertEqual(records.length, 0, 'family rejection sends no writes');
  } finally {
    await app.close();
  }
}

async function rejectsBlockNotFound(): Promise<void> {
  const records: RecordedApply[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(records));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/120/apply', payload: savedBlock });
    assertEqual(res.statusCode, 404, 'applying to a non-placed block is not found');
    assertEqual(res.payload, JSON.stringify({ error: 'block-not-found', effectId: 120 }), 'not-found names the effect id');
    assertEqual(records.length, 0, 'not-found sends no writes');
  } finally {
    await app.close();
  }
}

async function reportsApplyFailure(): Promise<void> {
  const records: RecordedApply[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(records, true));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: savedBlock });
    assertEqual(res.statusCode, 409, 'a throwing applyBlock reports the apply failure');
    assertEqual(res.payload, JSON.stringify({ error: 'saved-block-apply-failed', message: 'bulk write rejected' }), 'failure reports the driver error');
    assertEqual(records.length, 1, 'applyBlock was attempted once');
  } finally {
    await app.close();
  }
}

export async function runBlockApplyTests(): Promise<void> {
  await appliesBulkBlock();
  await appliesCrossDeviceBlock();
  await rejectsWrongFamilyBeforeWrites();
  await rejectsBlockNotFound();
  await reportsApplyFailure();
}
