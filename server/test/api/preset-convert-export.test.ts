// POST /preset/convert/export — author a target-device preset .syx from a converted preset, edit-in-place
// on a caller-supplied FM3 BASE template. Mocked, NO hardware. Uses the bundled FM3 preset dump fixture as
// BOTH the convert source AND the base template, authors an FM3→FM3 export, then decodes the returned bytes
// back through the codec to prove file-level round-trip validity (CRC + written name). Also asserts the
// FM3-only target guard (501), the FM3-base guard (400), and the missing-base guard (400).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeGen3PresetDump, readBlockParamsForModel } from 'forgefx-midi/devices/gen3';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const PRESET_CONVERT_EXPORT_CASE_COUNT = 11;

const FM3_FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)));
const FM3_SYX_B64 = FM3_FIXTURE.toString('base64');
// Cross-generation SOURCES (a real FM9 and an Axe-Fx III preset), authored onto an FM3 BASE. Their
// paramIds are DEVICE-SPECIFIC, so before the fix they were withheld and every param skipped; now the
// engine re-addresses each param to the FM3's own id via its concept key, so values are WRITTEN.
const FM9_SYX_B64 = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm9-devs-gift-of-tone.syx', import.meta.url))).toString('base64');
const AXE3_SYX_B64 = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/axe3-devs-gift-of-tone.syx', import.meta.url))).toString('base64');
const EXPORT_NAME = 'Export RT';

interface AuthoredParamRecord {
  blockKey: string;
  family: string;
  paramId: number;
  channel: number;
  raw: number;
}
interface AuthoredBlockRecord {
  family: string;
  eid: number;
  instance: number;
  params: AuthoredParamRecord[];
}
interface ExportBody {
  syx: number[];
  written: AuthoredBlockRecord[];
  skipped: Array<{ reason: string }>;
  name: string;
  validation: { ok: boolean; issues: string[] };
  fidelity: { sourceBlocks: number; landedBlocks: number; droppedForNoBaseBlock: number };
}

/** Decode an FM3 `.syx` and index the generic per-block param raws by grid effect id → paramId → raw
 *  (channel A / channel 0 for amp), so a source and an authored dump can be compared value-for-value.
 *  Keyed by eid because the authored `written[]` report and the decoder agree on the grid effect id
 *  (they disagree on family label: report = converter family "amp", decoder = catalog symbol "DISTORT"). */
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

// ── FM3 → FM3 offline export, decode the authored .syx back through the codec ──
async function happyPath(): Promise<void> {
  const { app } = await buildTestApp(0x11); // FM3 attached; offline path never touches it
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, base: { syx: FM3_SYX_B64 }, name: EXPORT_NAME },
    });
    assertEqual(res.statusCode, 200, 'FM3→FM3 export → 200');
    const b = res.json() as ExportBody;
    assert(Array.isArray(b.syx) && b.syx.length > 0, 'export returns non-empty syx bytes');
    assertEqual(b.name, EXPORT_NAME, 'export echoes the written name');
    assert(Array.isArray(b.written), 'export returns a written[] report');

    // ── END-TO-END VALIDATION GATE: the authored output passed our own decoder ──────────────────
    assertEqual(b.validation.ok, true, `authored output validated ok (issues: ${b.validation.issues.join('; ')})`);
    assertEqual(b.validation.issues.length, 0, 'validated output carries no issues');
    // ── FIDELITY report is present and internally consistent ────────────────────────────────────
    assert(b.fidelity.landedBlocks > 0, 'fidelity: blocks landed');
    assert(b.fidelity.sourceBlocks >= b.fidelity.landedBlocks, 'fidelity: sourceBlocks >= landedBlocks');
    assert(b.fidelity.droppedForNoBaseBlock >= 0, 'fidelity: droppedForNoBaseBlock is non-negative');
    assert(
      b.fidelity.landedBlocks + b.fidelity.droppedForNoBaseBlock <= b.fidelity.sourceBlocks,
      'fidelity: landed + dropped-for-no-base never exceeds sourceBlocks',
    );

    // Round-trip: the authored bytes must decode back with a valid CRC and the name we wrote.
    const decoded = decodeGen3PresetDump(Uint8Array.from(b.syx), 0x11);
    assertEqual(decoded.crc_valid, true, 'authored .syx has a valid CRC (device would not reject on CRC)');
    assertEqual(decoded.preset_name, EXPORT_NAME, 'authored .syx decodes back to the written name');

    // ── PARAM VALUES ARE NOW WRITTEN (not skipped) ──────────────────────────────────────────────
    // Before this fix the export carried block structure + types + name only: every param skipped with
    // "no resolvable paramId". Now the same-generation (FM3→FM3) path carries each param's device
    // `paramId`, so the author writes the VALUES. Assert a substantial number of params landed, across
    // the amp AND several non-amp blocks, and that NONE skipped for the old unresolvable-paramId reason.
    const blocksWithParams = b.written.filter((w) => w.params.length > 0);
    const ampRec = b.written.find((w) => w.family === 'amp');
    assert(ampRec !== undefined && ampRec.params.length > 0, 'amp params were WRITTEN (not skipped)');
    const nonAmpWithParams = blocksWithParams.filter((w) => w.family !== 'amp');
    assert(nonAmpWithParams.length >= 3, `>=3 non-amp blocks wrote params (got ${nonAmpWithParams.length})`);
    const totalWritten = b.written.reduce((n, w) => n + w.params.length, 0);
    // FM3→FM3 writes the FULL decoded param set (575 on this fixture). The codec's
    // name-join widening is a NO-OP here (source==target short-circuits the paramId
    // re-addressing pass), so this count is a byte-identity regression LOCK: it must
    // stay exactly 575, proving same-device conversion is untouched by the change.
    assertEqual(totalWritten, 575, `FM3→FM3 writes the full param set (regression lock, got ${totalWritten})`);
    assert(
      !b.skipped.some((s) => /no resolvable paramId/.test(s.reason)),
      'no param skipped for the old "no resolvable paramId" reason',
    );

    // ── Value fidelity: the authored dump decodes back to the SOURCE param values ────────────────
    // (source == base here). Compare generic per-block param raws for the amp + several non-amp blocks;
    // every written param must round-trip byte-exact (normalized = raw/65534 reproduces the raw).
    const sourceRaws = blockRawsByEid(FM3_FIXTURE);
    const authoredRaws = blockRawsByEid(Uint8Array.from(b.syx));
    let verifiedBlocks = 0;
    let verifiedParams = 0;
    for (const rec of blocksWithParams) {
      const src = sourceRaws.get(rec.eid);
      const got = authoredRaws.get(rec.eid);
      if (!src || !got) continue;
      let checked = 0;
      for (const p of rec.params) {
        // amp records may target a non-A channel; only value-verify channel-A writes (channel 0).
        if (p.channel !== 0) continue;
        assertEqual(got.get(p.paramId), src.get(p.paramId), `eid ${rec.eid} paramId ${p.paramId} round-trips to source value`);
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

// ── cross-generation SOURCE → FM3: params are now WRITTEN with FM3 paramIds ──
// A non-FM3 gen-3 source (FM9 / Axe-Fx III) used to export block structure + types + name only — every
// param skipped because its foreign paramId was withheld. Now the engine re-addresses each concept-mapped
// param to the FM3's OWN id, so the author writes the VALUES. Authors onto the FM3 base template, then
// decodes the returned bytes back to prove file-level round-trip validity (CRC + read-after-write raws).
async function crossSourceToFm3(sourceB64: string, label: string): Promise<void> {
  const { app } = await buildTestApp(0x11); // FM3 attached; offline path never touches it
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: sourceB64 }, base: { syx: FM3_SYX_B64 }, name: EXPORT_NAME },
    });
    assertEqual(res.statusCode, 200, `${label}→FM3 export → 200`);
    const b = res.json() as ExportBody;
    assert(Array.isArray(b.syx) && b.syx.length > 0, `${label}→FM3: returns non-empty syx bytes`);

    // Authored bytes decode back with a valid CRC and the written name (file-level round-trip).
    const decoded = decodeGen3PresetDump(Uint8Array.from(b.syx), 0x11);
    assertEqual(decoded.crc_valid, true, `${label}→FM3: authored .syx has a valid CRC`);
    assertEqual(decoded.preset_name, EXPORT_NAME, `${label}→FM3: authored .syx decodes back to the written name`);

    // Params are WRITTEN now (was ~38 concept-only): a SUBSTANTIAL count, across the amp AND several
    // other families. The codec's CONTINUOUS name-join fallback re-addresses every shared-symbol param
    // (EQ bands, PEQ, delay times/depths, cabinet cuts, …) to the FM3's own id — not just the curated
    // concept knobs — so hundreds of values now land (was 38). enum/type/roster selectors still carry no
    // id and are skipped, never written as a foreign ordinal.
    const blocksWithParams = b.written.filter((w) => w.params.length > 0);
    const ampRec = b.written.find((w) => w.family === 'amp');
    assert(ampRec !== undefined && ampRec.params.length > 0, `${label}→FM3: amp params were WRITTEN (not all skipped)`);
    const familiesWithParams = new Set(blocksWithParams.map((w) => w.family));
    assert(familiesWithParams.size >= 3, `${label}→FM3: >=3 families wrote params (got ${familiesWithParams.size}: ${[...familiesWithParams].join(',')})`);
    const totalWritten = b.written.reduce((n, w) => n + w.params.length, 0);
    assert(totalWritten > 200, `${label}→FM3: cross-source param count written (got ${totalWritten}, expected > 200, up from ~38)`);

    // Value fidelity (file-level, within tolerance 0): every written param's authored raw reads back
    // EXACTLY as the author reported writing it — the continuous values (`normalized = raw/65534`)
    // survive re-encode byte-for-byte. This is NOT a proof of device acceptance (hardware load still req).
    const authoredRaws = blockRawsByEid(Uint8Array.from(b.syx));
    let verifiedParams = 0;
    for (const rec of blocksWithParams) {
      const got = authoredRaws.get(rec.eid);
      if (!got) continue;
      for (const p of rec.params) {
        if (p.channel !== 0) continue; // amp may target a non-A channel; value-verify channel-A writes only
        assertEqual(got.get(p.paramId), p.raw, `${label}→FM3: eid ${rec.eid} paramId ${p.paramId} reads back its authored raw`);
        verifiedParams += 1;
      }
    }
    assert(verifiedParams > 200, `${label}→FM3: value round-trip verified across >200 continuous params (got ${verifiedParams})`);
  } finally {
    await app.close();
  }
}

// ── target guard: only FM3 is supported → 501 for any other target ──
async function nonFm3Target(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm9', source: { syx: FM3_SYX_B64 }, base: { syx: FM3_SYX_B64 } },
    });
    assertEqual(res.statusCode, 501, 'non-FM3 target → 501');
    const b = res.json() as { error: string };
    assert(/FM3/.test(b.error), '501 error mentions FM3-only');
  } finally {
    await app.close();
  }
}

// ── base guard: the base template must be an FM3 preset dump → 400 ──
async function nonFm3Base(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    // A well-framed SysEx with a non-FM3 model byte (0x99) → base sniff fails.
    const junkBaseB64 = Buffer.from([0xf0, 0x00, 0x01, 0x74, 0x99, 0x00, 0xf7]).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, base: { syx: junkBaseB64 } },
    });
    assertEqual(res.statusCode, 400, 'non-FM3 base → 400');
    const b = res.json() as { error: string };
    assert(/base template must be an FM3 preset/.test(b.error), '400 error names the FM3-base requirement');
  } finally {
    await app.close();
  }
}

// ── validation gate: a BASE that sniffs as FM3 (0x11) but is CORRUPT is refused → 400 ──
// This is the real-world failure: the caller's base template is a bad device backup. The model-byte sniff
// passes (still 0x11), but our own decoder finds the body incoherent, so we refuse BEFORE authoring garbage.
async function corruptBase(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    // Keep the F0…model-byte header intact (sniff still sees 0x11), corrupt the compressed body mid-dump.
    const corrupt = Buffer.from(FM3_FIXTURE);
    const mid = Math.floor(corrupt.length / 2);
    for (let i = 0; i < 64; i++) corrupt[mid + i] = 0x00;
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 }, base: { syx: corrupt.toString('base64') } },
    });
    assertEqual(res.statusCode, 400, 'corrupt (but 0x11-sniffing) base → 400 from the validation gate');
    const b = res.json() as { error: string };
    assert(/base template is not a valid FM3 preset/.test(b.error), '400 error explains the base is not valid');
    assert(/corrupt/.test(b.error), '400 error hints the device backup may be corrupt');
  } finally {
    await app.close();
  }
}

// ── missing base → 400 (base is required) ──
async function missingBase(): Promise<void> {
  const { app } = await buildTestApp(0x11);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/preset/convert/export',
      payload: { targetDevice: 'fm3', source: { syx: FM3_SYX_B64 } },
    });
    assertEqual(res.statusCode, 400, 'missing base → 400');
  } finally {
    await app.close();
  }
}

export async function runPresetConvertExportTests(): Promise<void> {
  await happyPath();
  await crossSourceToFm3(FM9_SYX_B64, 'FM9');
  await crossSourceToFm3(AXE3_SYX_B64, 'Axe-Fx III');
  await nonFm3Target();
  await nonFm3Base();
  await corruptBase();
  await missingBase();
}
