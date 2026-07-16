// POST /preset/convert/export — author a target-device preset .syx from a converted preset by FULL-BODY
// SYNTHESIS onto the codec's bundled default FM3 scaffold (NO caller base required). Mocked, NO hardware.
// Converts FM3/FM9/Axe-Fx III sources → FM3, synthesizes the whole body from the IR, then decodes the
// returned bytes back through the codec to prove file-level round-trip validity (CRC + written name +
// read-after-write raws). Full synthesis reproduces the ENTIRE templated block chain (not the ~4 the old
// edit-in-place landed, bounded by a base's blocks). Also asserts: base is OPTIONAL (no base → 200 full
// synth); an FM3 base OVERRIDE is accepted; a non-FM3 / corrupt base override is refused (400); the FM3-only
// target guard (501); and the output-validation gate (422 refuses an incoherent authored preset, never
// returned).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeGen3PresetDump, readBlockParamsForModel } from 'forgefx-midi/devices/gen3';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const PRESET_CONVERT_EXPORT_CASE_COUNT = 8;

const FM3_FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)));
const FM3_SYX_B64 = FM3_FIXTURE.toString('base64');
// Cross-generation SOURCES (a real FM9 and an Axe-Fx III preset). Their paramIds AND grid effect ids are
// DEVICE-SPECIFIC; the engine re-addresses each param to the FM3's own id, and the synthesizer assigns each
// block an FM3 grid eid from its family — so the whole templated chain synthesizes (was bounded to ~4 by the
// old edit-in-place base).
const FM9_SYX_B64 = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm9-devs-gift-of-tone.syx', import.meta.url))).toString('base64');
const AXE3_SYX_B64 = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/axe3-devs-gift-of-tone.syx', import.meta.url))).toString('base64');
const EXPORT_NAME = 'Export RT';

interface LandedParam {
  paramId: number;
  channel: number;
  raw: number;
}
interface LandedBlockRecord {
  blockKey: string;
  family: string;
  displayName: string;
  instance: number;
  eid: number;
  typeWritten?: number;
  params: LandedParam[];
}
interface ExportBody {
  syx: number[];
  written: LandedBlockRecord[];
  skipped: Array<{ blockKey?: string; family?: string; reason: string }>;
  name: string;
  validation: { ok: boolean; issues: string[] };
  fidelity: { sourceBlocks: number; landedBlocks: number; droppedNoTemplate: number };
}

/** Decode an FM3 `.syx` and index the generic per-block param raws by grid effect id → paramId → raw
 *  (channel A / channel 0 for amp), so the authored dump can be compared value-for-value against what the
 *  `written[]` report says was written. */
function blockRawsByEid(syx: Uint8Array): Map<number, Map<number, number>> {
  const decoded = decodeGen3PresetDump(syx, 0x11);
  const placed = new Set<number>(
    (decoded.grid ?? []).filter((c) => !c.is_shunt && c.effect_id > 0).map((c) => c.effect_id),
  );
  const out = new Map<number, Map<number, number>>();
  for (const blk of readBlockParamsForModel(decoded.decompressed_body, placed, 0x11)) {
    if (blk.channel != null && blk.channel !== 0) continue;
    const m = out.get(blk.effectId) ?? new Map<number, number>();
    for (const p of blk.params) m.set(p.paramId, p.raw);
    out.set(blk.effectId, m);
  }
  return out;
}

function assertFidelityConsistent(b: ExportBody): void {
  assert(b.fidelity.landedBlocks > 0, 'fidelity: blocks landed');
  assertEqual(b.fidelity.landedBlocks, b.written.length, 'fidelity.landedBlocks == written[].length');
  assert(b.fidelity.sourceBlocks >= b.fidelity.landedBlocks, 'fidelity: sourceBlocks >= landedBlocks');
  assert(b.fidelity.droppedNoTemplate >= 0, 'fidelity: droppedNoTemplate is non-negative');
  assert(
    b.fidelity.landedBlocks + b.fidelity.droppedNoTemplate <= b.fidelity.sourceBlocks,
    'fidelity: landed + droppedNoTemplate never exceeds sourceBlocks',
  );
}

// ── FM3 → FM3 offline export with NO BASE (bundled default scaffold), decode back through the codec ──
async function happyPathNoBase(): Promise<void> {
  const { app } = await buildTestApp(0x11); // FM3 attached; offline path never touches it
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, name: EXPORT_NAME }, // NO base
    });
    assertEqual(res.statusCode, 200, 'FM3→FM3 export with no base → 200 (bundled scaffold)');
    const b = res.json() as ExportBody;
    assert(Array.isArray(b.syx) && b.syx.length > 0, 'export returns non-empty syx bytes');
    assertEqual(b.name, EXPORT_NAME, 'export echoes the written name');
    assertEqual(b.validation.ok, true, `authored output validated ok (issues: ${b.validation.issues.join('; ')})`);
    assertEqual(b.validation.issues.length, 0, 'validated output carries no issues');
    assertFidelityConsistent(b);

    // FULL SYNTHESIS lands the WHOLE templated block chain — not the ~4 the old edit-in-place managed. This
    // FM3 fixture carries a rich chain; assert the full set lands (>= 9, actually 12).
    assert(b.fidelity.landedBlocks >= 9, `FM3→FM3 full synth lands the full chain (got ${b.fidelity.landedBlocks}, expected >= 9)`);

    // Round-trip: the authored bytes decode back with a valid CRC + the name we wrote.
    const decoded = decodeGen3PresetDump(Uint8Array.from(b.syx), 0x11);
    assertEqual(decoded.crc_valid, true, 'authored .syx has a valid CRC');
    assertEqual(decoded.preset_name, EXPORT_NAME, 'authored .syx decodes back to the written name');

    // Params are WRITTEN across the amp AND many non-amp blocks (device paramIds carried by the converted IR).
    const blocksWithParams = b.written.filter((w) => w.params.length > 0);
    const ampRec = b.written.find((w) => w.family === 'amp');
    assert(ampRec !== undefined && ampRec.params.length > 0, 'amp params were WRITTEN');
    const nonAmpWithParams = blocksWithParams.filter((w) => w.family !== 'amp');
    assert(nonAmpWithParams.length >= 3, `>=3 non-amp blocks wrote params (got ${nonAmpWithParams.length})`);
    const totalWritten = b.written.reduce((n, w) => n + w.params.length, 0);
    assert(totalWritten >= 300, `FM3→FM3 synth writes a substantial param set (got ${totalWritten}, expected >= 300)`);

    // Value fidelity: every written channel-A param reads back EXACTLY as reported (raw survives re-encode).
    const authoredRaws = blockRawsByEid(Uint8Array.from(b.syx));
    let verifiedBlocks = 0;
    let verifiedParams = 0;
    for (const rec of blocksWithParams) {
      const got = authoredRaws.get(rec.eid);
      if (!got) continue;
      let checked = 0;
      for (const p of rec.params) {
        if (p.channel !== 0) continue;
        assertEqual(got.get(p.paramId), p.raw, `eid ${rec.eid} paramId ${p.paramId} reads back its authored raw`);
        checked += 1;
      }
      if (checked > 0) {
        verifiedBlocks += 1;
        verifiedParams += checked;
      }
    }
    assert(verifiedBlocks >= 4, `value round-trip verified across >=4 blocks (got ${verifiedBlocks})`);
    assert(verifiedParams >= 50, `value round-trip verified across >=50 params (got ${verifiedParams})`);
  } finally {
    await app.close();
  }
}

// ── FM3 base OVERRIDE (optional) is accepted and still full-synthesizes ──
async function baseOverride(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, base: { syx: FM3_SYX_B64 }, name: EXPORT_NAME },
    });
    assertEqual(res.statusCode, 200, 'FM3→FM3 export with an FM3 base override → 200');
    const b = res.json() as ExportBody;
    assertEqual(b.validation.ok, true, 'base-override output validated ok');
    assert(b.fidelity.landedBlocks >= 9, `base override still full-synthesizes (got ${b.fidelity.landedBlocks})`);
    const decoded = decodeGen3PresetDump(Uint8Array.from(b.syx), 0x11);
    assertEqual(decoded.crc_valid, true, 'base-override authored .syx has a valid CRC');
  } finally {
    await app.close();
  }
}

// ── cross-generation SOURCE → FM3 with NO base: the FULL templated chain synthesizes (was ~4) ──
async function crossSourceToFm3(sourceB64: string, label: string): Promise<void> {
  const { app } = await buildTestApp(0x11); // FM3 attached; offline path never touches it
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: sourceB64 }, name: EXPORT_NAME }, // NO base
    });
    assertEqual(res.statusCode, 200, `${label}→FM3 export (no base) → 200`);
    const b = res.json() as ExportBody;
    assert(Array.isArray(b.syx) && b.syx.length > 0, `${label}→FM3: returns non-empty syx bytes`);
    assertEqual(b.validation.ok, true, `${label}→FM3: authored output validated ok (${b.validation.issues.join('; ')})`);
    assertFidelityConsistent(b);

    // The whole templated chain lands — WELL past the old edit-in-place ~4 (bounded by a base's blocks).
    // Families with no harvested FM3 template (e.g. Vol/Pan, PEQ) are the only drops.
    assert(b.fidelity.landedBlocks >= 6, `${label}→FM3: full synth lands the templated chain (got ${b.fidelity.landedBlocks}, expected >= 6, up from ~4)`);

    // Authored bytes decode back with a valid CRC + the written name.
    const decoded = decodeGen3PresetDump(Uint8Array.from(b.syx), 0x11);
    assertEqual(decoded.crc_valid, true, `${label}→FM3: authored .syx has a valid CRC`);
    assertEqual(decoded.preset_name, EXPORT_NAME, `${label}→FM3: authored .syx decodes back to the written name`);

    // Params are WRITTEN across the amp AND several families (device-specific paramIds re-addressed to FM3).
    const blocksWithParams = b.written.filter((w) => w.params.length > 0);
    const ampRec = b.written.find((w) => w.family === 'amp');
    assert(ampRec !== undefined && ampRec.params.length > 0, `${label}→FM3: amp params were WRITTEN`);
    const familiesWithParams = new Set(blocksWithParams.map((w) => w.family));
    assert(familiesWithParams.size >= 3, `${label}→FM3: >=3 families wrote params (got ${familiesWithParams.size}: ${[...familiesWithParams].join(',')})`);
    const totalWritten = b.written.reduce((n, w) => n + w.params.length, 0);
    assert(totalWritten > 150, `${label}→FM3: cross-source param count written (got ${totalWritten}, expected > 150, up from ~38)`);

    // Value fidelity: every written channel-A param reads back EXACTLY its authored raw.
    const authoredRaws = blockRawsByEid(Uint8Array.from(b.syx));
    let verifiedParams = 0;
    for (const rec of blocksWithParams) {
      const got = authoredRaws.get(rec.eid);
      if (!got) continue;
      for (const p of rec.params) {
        if (p.channel !== 0) continue;
        assertEqual(got.get(p.paramId), p.raw, `${label}→FM3: eid ${rec.eid} paramId ${p.paramId} reads back its authored raw`);
        verifiedParams += 1;
      }
    }
    assert(verifiedParams > 150, `${label}→FM3: value round-trip verified across >150 continuous params (got ${verifiedParams})`);
  } finally {
    await app.close();
  }
}

// ── target guard: gen-3 (FM3/FM9/Axe-Fx III) synthesize; AM4/VP4 stay 501 ──
async function targetGuard(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    // FM9 IS a supported gen-3 target now: FM3 source → FM9 target authors a valid preset (200).
    const ok = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm9', source: { syx: FM3_SYX_B64 }, name: EXPORT_NAME },
    });
    assertEqual(ok.statusCode, 200, 'FM9 gen-3 target authors → 200');

    // AM4 has no harvested synthesis templates → still refused with 501.
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'am4', source: { syx: FM3_SYX_B64 } },
    });
    assertEqual(res.statusCode, 501, 'AM4 target → 501 (no synthesis templates)');
    const b = res.json() as { error: string };
    assert(/am4|FM3\/FM9\/Axe-Fx III/.test(b.error), '501 error names the supported gen-3 targets');
  } finally {
    await app.close();
  }
}

// ── base-override guard: a supplied base override that is NOT an FM3 preset dump → 400 ──
async function nonFm3BaseOverride(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    // A well-framed SysEx with a non-FM3 model byte (0x99) → base sniff fails.
    const junkBaseB64 = Buffer.from([0xf0, 0x00, 0x01, 0x74, 0x99, 0x00, 0xf7]).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, base: { syx: junkBaseB64 } },
    });
    assertEqual(res.statusCode, 400, 'non-FM3 base override → 400');
    const b = res.json() as { error: string };
    assert(/base override must be a(n)? FM3 preset/.test(b.error), '400 error names the FM3-base-override requirement');
  } finally {
    await app.close();
  }
}

// ── base-override validation gate: a base override that sniffs as FM3 (0x11) but is CORRUPT → 400 ──
async function corruptBaseOverride(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    const corrupt = Buffer.from(FM3_FIXTURE);
    const mid = Math.floor(corrupt.length / 2);
    for (let i = 0; i < 64; i++) corrupt[mid + i] = 0x00;
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, base: { syx: corrupt.toString('base64') } },
    });
    assertEqual(res.statusCode, 400, 'corrupt (but 0x11-sniffing) base override → 400 from the validation gate');
    const b = res.json() as { error: string };
    assert(/base override is not a valid FM3 preset/.test(b.error), '400 error explains the base override is not valid');
  } finally {
    await app.close();
  }
}

/** EDITED-IR path: an edited converter preset (POST body `preset`) is authored DIRECTLY — its grid
 *  routing/cables are carried verbatim, NOT re-converted from a source. Draws a distinctive [0,2] cable
 *  on the converted FM9→FM3 IR's placed cells and asserts it round-trips into the exported .syx grid. */
async function editedPresetCarriesRouting(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    // 1. Convert FM9→FM3 to get the target IR (its grid cells now carry series route flags).
    const conv = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'fm3', source: { syx: FM9_SYX_B64 } } });
    assertEqual(conv.statusCode, 200, 'edited-IR: convert 200');
    const target = conv.json().target as { routing: { gridCells: Array<{ col: number; row: number; blockKey?: string; routeFlag?: number; fromRows?: number[] }> } };
    const editable = target.routing.gridCells.filter((c) => c.col > 0 && c.blockKey);
    assert(editable.length > 0, 'edited-IR: target has mid-chain cells to wire');
    // 2. Draw a distinctive cable on every mid-chain cell: fed from rows 0 AND 2 (route_flag 0b101).
    for (const c of editable) { c.routeFlag = 0b101; c.fromRows = [0, 2]; }

    // 3. Export from the EDITED preset (no source re-convert).
    const res = await app.inject({ method: 'POST', url: '/preset/convert/export', payload: { targetDevice: 'fm3', preset: target, name: 'Routed' } });
    assertEqual(res.statusCode, 200, 'edited-IR: export 200');
    const body = res.json() as ExportBody;
    assert(body.validation.ok, 'edited-IR: authored preset valid');
    assertEqual(body.name, 'Routed', 'edited-IR: name carried');

    // 4. Decode the output and confirm the drawn [0,2] cable round-tripped into the grid.
    const decoded = decodeGen3PresetDump(new Uint8Array(body.syx), 0x11);
    const cells = decoded.grid ?? [];
    const nonZero = cells.filter((c) => (c.from_rows?.length ?? 0) > 0);
    assert(nonZero.length > 0, 'edited-IR: exported grid carries route flags (not a bare chain)');
    const hasDrawn = cells.some((c) => JSON.stringify([...(c.from_rows ?? [])].sort((a, b) => a - b)) === JSON.stringify([0, 2]));
    assert(hasDrawn, 'edited-IR: the drawn [0,2] cable round-tripped into the export');
  } finally {
    await app.close();
  }
}

export async function runPresetConvertExportTests(): Promise<void> {
  await happyPathNoBase();
  await baseOverride();
  await crossSourceToFm3(FM9_SYX_B64, 'FM9');
  await crossSourceToFm3(AXE3_SYX_B64, 'Axe-Fx III');
  await targetGuard();
  await nonFm3BaseOverride();
  await corruptBaseOverride();
  await editedPresetCarriesRouting();
}
