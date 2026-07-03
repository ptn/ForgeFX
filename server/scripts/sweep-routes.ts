/**
 * Route-sweep snapshot (migration Phase 0/3/4/6 verification).
 *
 * Hits every safe GET route on a running server with a live device and writes
 * the JSON responses under test/fixtures/route-sweep/<label>/. Diff two sweeps
 * to prove a refactor changed nothing (Phase 3/4: byte-identical; Phase 6:
 * additive-only).
 *
 * Usage: tsx scripts/sweep-routes.ts <label> [--base http://localhost:5056]
 *   e.g. tsx scripts/sweep-routes.ts phase0-baseline
 * Diff:  diff -ru test/fixtures/route-sweep/phase0-baseline test/fixtures/route-sweep/phase3
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = process.argv[2];
if (!label || label.startsWith('--')) {
  console.error('usage: tsx scripts/sweep-routes.ts <label> [--base URL]');
  process.exit(1);
}
const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]!
  : 'http://localhost:5056';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'route-sweep', label);
mkdirSync(OUT, { recursive: true });

/** Keys whose values legitimately differ between runs (timing, live audio, envs). */
const VOLATILE_KEYS = new Set(['at', 'ts', 'timestamp', 'uptimeMs', 'freq', 'cents', 'note', 'octave', 'percent', 'db', 'rms', 'updatedAt', 'capturedAt']);
function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = VOLATILE_KEYS.has(k) ? '<volatile>' : stripVolatile(val);
    return out;
  }
  return v;
}

async function main() {
  const get = async (path: string) => {
    const r = await fetch(BASE + path);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const save = (name: string, data: unknown) =>
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(stripVolatile(data), null, 2) + '\n');

  // static + device-level routes
  const routes: [string, string][] = [
    ['healthz', '/healthz'],
    ['device', '/device'],
    ['device-detect', '/device/detect'],
    ['ports', '/ports'],
    ['preset', '/preset'],
    ['preset-grid', '/preset/grid'],
    ['preset-blocks', '/preset/blocks'],
    ['blocks', '/blocks'],
    ['blocks-amp-types', '/blocks/amp/types'],
    ['blocks-drive-types', '/blocks/drive/types'],
    ['fc-model', '/fc/model'],
    ['mod-model', '/mod/model'],
    ['cab-irs', '/cab/irs'],
    ['preset-monitors', '/preset/monitors'],
    ['scene', '/scene'],
    ['tempo', '/tempo'],
    ['presets-5-summary', '/presets/5/summary?full=1'],
    ['presets-5-params', '/presets/5/params'],
  ];
  for (const [name, path] of routes) {
    const res = await get(path);
    save(name, res);
    console.log(`${res.status} ${path}`);
  }

  // per-block params for two placed blocks (addressed by effectId; prefer amp + delay for coverage)
  const blocks = (await get('/preset/blocks')).body as { slug: string; effectId: number }[] | null;
  const list = Array.isArray(blocks) ? blocks : [];
  const picks = [list.find((b) => b.slug === 'amp') ?? list[0], list.find((b) => b.slug === 'delay') ?? list[1]]
    .filter((b): b is NonNullable<typeof b> => !!b);
  for (const b of picks) {
    const res = await get(`/preset/blocks/${b.effectId}/params`);
    save(`block-${b.effectId}-params`, res);
    console.log(`${res.status} /preset/blocks/${b.effectId}/params (${b.slug})`);
  }

  console.log(`\nwrote sweep '${label}' to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
