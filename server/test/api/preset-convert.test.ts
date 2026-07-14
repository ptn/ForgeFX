// POST /preset/convert — cross-device preset converter endpoint (Phase P3). Mocked, NO hardware:
// the offline path decodes a bundled FM3 preset dump fixture through the codec engine; the connected
// path uses a seeded fake driver whose backupPreset returns that same fixture. Asserts route
// validation (400 unknown target / undecodable syx), 501 capability gating, offline + connected happy
// paths, event/summary consistency, and the presetConvert caps advertisement.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';
import type { DeviceDriver } from '../../src/drivers/types.js';

export const PRESET_CONVERT_CASE_COUNT = 8;

const FM3_FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)));
const FM3_SYX_B64 = FM3_FIXTURE.toString('base64');

interface ConvertBody {
  source: { device: string; name: string; decodeDepth: string };
  target: { sourceDevice: string; meta?: { convertedTo?: string } };
  events: { kind: string }[];
  summary: { total: number; info: number; warn: number; loss: number };
}

/** summary buckets must sum to total, and total must equal events.length. */
function checkSummary(b: ConvertBody, label: string): void {
  assertEqual(b.summary.total, b.events.length, `${label} summary.total == events.length`);
  assertEqual(b.summary.info + b.summary.warn + b.summary.loss, b.summary.total, `${label} summary buckets sum to total`);
}

// ── offline (source.syx) ──
async function offline(): Promise<void> {
  const { app } = await buildTestApp(0x11); // FM3 attached; offline path never touches it
  try {
    // unknown target → 400 with the supported list
    const bad = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'nonsense', source: { syx: FM3_SYX_B64 } } });
    assertEqual(bad.statusCode, 400, 'unknown target → 400');
    const badBody = bad.json() as { error: string; supported: string[] };
    assert(Array.isArray(badBody.supported) && badBody.supported.includes('fm9'), 'unknown target lists supported devices');

    // FM3 → AM4: lossy cross-device (family drops, scene/channel collapse) → events present
    const toAm4 = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'am4', source: { syx: FM3_SYX_B64 } } });
    assertEqual(toAm4.statusCode, 200, 'FM3→AM4 → 200');
    const am4 = toAm4.json() as ConvertBody;
    assertEqual(am4.source.device, 'fm3', 'FM3→AM4 source.device');
    assertEqual(am4.source.decodeDepth, 'full', 'FM3→AM4 source.decodeDepth (gen-3 full lift)');
    assert(am4.source.name.length > 0, 'FM3→AM4 source.name decoded');
    assertEqual(am4.target.sourceDevice, 'fm3', 'FM3→AM4 target keeps original sourceDevice (provenance)');
    assertEqual(am4.target.meta?.convertedTo, 'am4', 'FM3→AM4 meta.convertedTo');
    assert(am4.events.length > 0, 'FM3→AM4 emits conversion events');
    assert(am4.summary.loss > 0, 'FM3→AM4 has losses (family/scene/channel collapse)');
    checkSummary(am4, 'FM3→AM4');

    // FM3 → FM9: shared gen-3 roster → lossless, zero events
    const toFm9 = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'fm9', source: { syx: FM3_SYX_B64 } } });
    assertEqual(toFm9.statusCode, 200, 'FM3→FM9 → 200');
    const fm9 = toFm9.json() as ConvertBody;
    assertEqual(fm9.events.length, 0, 'FM3→FM9 lossless (shared roster) → no events');
    assertEqual(fm9.summary.total, 0, 'FM3→FM9 summary.total 0');
    assertEqual(fm9.target.meta?.convertedTo, 'fm9', 'FM3→FM9 meta.convertedTo');
    checkSummary(fm9, 'FM3→FM9');

    // undecodable / unsupported source family → 400
    const junkB64 = Buffer.from([0xf0, 0x00, 0x01, 0x74, 0x99, 0x00, 0xf7]).toString('base64');
    const junk = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'am4', source: { syx: junkB64 } } });
    assertEqual(junk.statusCode, 400, 'unsupported source family → 400');
  } finally {
    await app.close();
  }
}

// ── connected device (source omitted), happy path via a seeded fake driver ──
async function connected(): Promise<void> {
  const fake = {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: { presetConvert: true } as DeviceDriver['capabilities'],
    grid: async () => ({ model: 'fm3', name: '', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' as const }),
    backupPreset: async () => ({ location: 5, code: null, name: 'A-Class 15', bytes: [...FM3_FIXTURE] }),
  } as unknown as DeviceDriver;
  const { app } = await buildTestApp(0x11, fake);
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'am4' } });
    assertEqual(res.statusCode, 200, 'connected FM3→AM4 → 200');
    const b = res.json() as ConvertBody;
    assertEqual(b.source.device, 'fm3', 'connected source.device from dumped preset');
    assertEqual(b.target.meta?.convertedTo, 'am4', 'connected meta.convertedTo');
    assert(b.events.length > 0, 'connected path runs the engine (events present)');
    checkSummary(b, 'connected');
  } finally {
    await app.close();
  }
}

// ── 501 capability gate: a driver with presetConvert:false, no source ──
async function gate501(): Promise<void> {
  const { app } = await buildTestApp(0x07); // Axe-Fx II (gen-2) — presetConvert:false
  try {
    const res = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'fm3' } });
    assertEqual(res.statusCode, 501, 'gen-2 no-source → 501');
    const b = res.json() as { error: string; capability?: string };
    assertEqual(b.capability, 'presetConvert', '501 names the presetConvert capability');
  } finally {
    await app.close();
  }
}

// ── caps advertisement: GET /device carries presetConvert ──
async function caps(): Promise<void> {
  for (const [model, expected, label] of [[0x11, true, 'FM3'], [0x15, true, 'AM4'], [0x07, false, 'gen-2']] as const) {
    const { app } = await buildTestApp(model);
    try {
      const res = await app.inject({ method: 'GET', url: '/device' });
      const caps = (res.json() as { capabilities: { presetConvert?: boolean } }).capabilities;
      assertEqual(caps.presetConvert, expected, `${label} caps.presetConvert`);
    } finally {
      await app.close();
    }
  }
}

export async function runPresetConvertTests(): Promise<void> {
  await offline();
  await connected();
  await gate501();
  await caps();
}
