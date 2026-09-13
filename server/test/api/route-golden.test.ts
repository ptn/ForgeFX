// Golden HTTP surface — snapshots the app's JSON responses for a deterministic mocked FM3 so a
// refactor that silently changes an output (on BOTH surfaces) is caught even when app↔router parity
// still holds. Regenerate deliberately with `UPDATE_GOLDEN=1 npm test`; review the diff before commit.
//
// Volatile keys (timestamps, revs, uptime) are normalized so the snapshot is stable across runs.
// Store-backed routes (/versions, /backups, /store, /local, /device/cache) are intentionally excluded
// — they share the process-wide throwaway DATA_DIR and are covered by their own suites.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestApp } from '../helpers/api.js';
import { makeFakeFm3 } from '../helpers/fakeFm3.js';
import { assert } from '../helpers/mock.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'route-golden.json');

const ROUTES: string[] = [
  '/healthz',
  '/device',
  '/device/detect',
  '/ports',
  '/preset',
  '/preset/grid',
  '/presets/7/grid',
  '/preset/blocks',
  '/blocks',
  '/blocks/amp/types',
  '/blocks/drive/types',
  '/preset/blocks/58/params',
  '/preset/blocks/2/params?observe=0',
  '/scene',
  '/tempo',
  '/fc/model',
  '/mod/model',
  '/mod/slot?targetEffectId=58&targetParam=4',
  '/mod/slot?targetEffectId=99&targetParam=99',
  '/mod/slot',
  '/preset/monitors',
  '/cab/irs',
  '/help/blocks/reverb',
  '/telemetry/config',
  '/telemetry/status',
  '/cloud/status',
  '/remote/status',
  '/definitely/not/a/route'
];

export const ROUTE_GOLDEN_CASE_COUNT = ROUTES.length;

const VOLATILE_KEYS = new Set(['at', 'ts', 'timestamp', 'uptimeMs', 'updatedAt', 'capturedAt', 'since', 'rev']);
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = VOLATILE_KEYS.has(k) ? '<volatile>' : normalize(val);
    return out;
  }
  return v;
}

export async function runRouteGoldenTests(): Promise<void> {
  // keep the telemetry/cloud stub rows on the unconfigured path — hermetic
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'AXIS_TELEMETRY', 'AXIS_FARO_URL', 'AXIS_TELEMETRY_KEY']) delete process.env[k];

  const { app } = await buildTestApp(0x11, makeFakeFm3(), {
    // Deterministic port list so `/ports` is hermetic — the default dep hits the real OS serial list.
    listConnections: async () => [
      { transport: 'serial', id: '/dev/fake-fm3', label: '/dev/fake-fm3 · FM3', fractal: true, model: 'FM3' },
      { transport: 'midi', id: 'FM3 MIDI In', label: 'FM3 MIDI In', fractal: true, dir: 'input' },
      { transport: 'midi', id: 'Generic USB', label: 'Generic USB', fractal: false, dir: 'output' }
    ]
  });
  const actual: Record<string, { status: number; body: unknown }> = {};
  try {
    for (const url of ROUTES) {
      const res = await app.inject({ method: 'GET', url });
      actual[url] = { status: res.statusCode, body: res.payload.length ? normalize(JSON.parse(res.payload)) : null };
    }
  } finally {
    await app.close();
  }

  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
    console.log(`  api/route-golden: wrote ${ROUTES.length} golden responses`);
    return;
  }

  assert(existsSync(FIXTURE), 'route-golden fixture missing (run `UPDATE_GOLDEN=1 npm test`)');
  const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { status: number; body: unknown }>;
  for (const url of ROUTES) {
    assert(
      JSON.stringify(actual[url]) === JSON.stringify(expected[url]),
      `golden drift for ${url}\n  expected: ${JSON.stringify(expected[url])}\n  actual:   ${JSON.stringify(actual[url])}`
    );
  }
  console.log(`  api/route-golden: ${ROUTES.length} responses match the golden snapshot`);
}
