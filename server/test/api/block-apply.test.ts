// Saved-block apply: Axis sends the decoded /fm3edit/blocks/decode JSON once; ForgeFX validates the
// target and writes every saved channel in device order.
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { buildTestApp } from '../helpers/api.js';
import { assertEqual } from '../helpers/mock.js';

export const BLOCK_APPLY_CASE_COUNT = 3;

const savedBlock = {
  name: 'Saved Drive',
  device: 'FM3',
  effectTypeId: 1,
  slug: 'drive',
  activeChannel: 1,
  channels: [
    { channel: 0, params: [{ paramId: 0, kind: 'enum', raw: 7 }, { paramId: 1, kind: 'float', raw: 32767 }] },
    { channel: 1, params: [{ paramId: 0, kind: 'enum', raw: 8 }, { paramId: 1, kind: 'float', raw: 65534 }] },
  ],
};

function makeDriver(writes: string[], rejectParam = false): DeviceDriver {
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: {} as DriverCapabilities,
    grid: async () => ({ model: 'fm3', name: '', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' }),
    placedBlocks: async () => [{ slug: 'drive', name: 'Drive 1', effectId: 118, row: 1, col: 1, fromRows: [], bypassed: false, channel: 'A' }],
    setChannel: async (_eid, channel) => { writes.push(`channel:${channel}`); return { ok: true }; },
    setType: async (_eid, value) => { writes.push(`type:${value}`); return { ok: true }; },
    setParam: async (_eid, paramId, value, continuous) => {
      writes.push(`param:${paramId}:${value}:${continuous}`);
      return { ok: !(rejectParam && paramId === 1 && value === 1) };
    },
  };
}

async function appliesAllChannels(): Promise<void> {
  const writes: string[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(writes));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: savedBlock });
    assertEqual(res.statusCode, 200, 'apply succeeds');
    assertEqual(res.payload, JSON.stringify({ ok: true, channels: 2, params: 4, activeChannel: 1 }), 'apply result reports all written params');
    assertEqual(writes.join(','), 'channel:A,type:7,param:1:0.5:true,channel:B,type:8,param:1:1:true,channel:B', 'writes channels, types, then normalized floats and restores active channel');
  } finally {
    await app.close();
  }
}

async function rejectsWrongFamilyBeforeWrites(): Promise<void> {
  const writes: string[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(writes));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: { ...savedBlock, slug: 'amp' } });
    assertEqual(res.statusCode, 422, 'mismatched saved-block family is rejected');
    assertEqual(res.payload, JSON.stringify({ error: 'saved-block-family-mismatch', target: 'drive', saved: 'amp' }), 'family rejection identifies both families');
    assertEqual(writes.length, 0, 'family rejection sends no writes');
  } finally {
    await app.close();
  }
}

async function reportsPartialWriteFailure(): Promise<void> {
  const writes: string[] = [];
  const { app } = await buildTestApp(0x11, makeDriver(writes, true));
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/blocks/118/apply', payload: savedBlock });
    assertEqual(res.statusCode, 409, 'a rejected write reports the non-atomic apply failure');
    assertEqual(res.payload, JSON.stringify({ error: 'saved-block-apply-failed', message: 'parameter write rejected', applied: 3, channel: 1, paramId: 1 }), 'failure identifies the exact partial-write position');
  } finally {
    await app.close();
  }
}

export async function runBlockApplyTests(): Promise<void> {
  await appliesAllChannels();
  await rejectsWrongFamilyBeforeWrites();
  await reportsPartialWriteFailure();
}
