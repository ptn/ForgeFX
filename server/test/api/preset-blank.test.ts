// GET /preset/blank/syx — the connected model's clean "blank" preset (the client's "start from
// zero" / "Clear preset" reset). FM3/FM9/Axe-Fx III carry a scaffold; AM4/VP4 do not (501).
import { decodeGen3Body, decodeRawPatch, parsePresetDump } from 'forgefx-midi/devices/gen3';
import { buildTestApp } from '../helpers/api.js';
import { assertEqual } from '../helpers/mock.js';

export const PRESET_BLANK_CASE_COUNT = 3;

/** The raw_patch header name at 0x08..0x28 (NUL-stop), same source the server's decoder reads. */
function presetName(rawPatch: Uint8Array): string {
  let name = '';
  for (let i = 0x08; i < 0x28; i++) {
    const b = rawPatch[i] ?? 0;
    if (b === 0) break;
    name += String.fromCharCode(b);
  }
  return name.trim();
}

async function modelServesScaffold(modelId: number, label: string): Promise<void> {
  const { app } = await buildTestApp(modelId);
  try {
    const res = await app.inject({ method: 'GET', url: '/preset/blank/syx' });
    assertEqual(res.statusCode, 200, `${label} blank preset 200`);
    assertEqual(res.headers['content-type'], 'application/octet-stream', `${label} octet-stream body`);
    const bytes = res.rawPayload;
    assertEqual(bytes.length, 24680, `${label} blank preset is a full preset dump`);
    assertEqual(bytes[0], 0xf0, `${label} SysEx start`);
    assertEqual(bytes[4], modelId, `${label} model byte matches the connected unit`);

    // It must be BLANK: the `<EMPTY>` name, no scene names, no grid cells, and a valid CRC — the
    // raw scaffold is the synthesis template (a real factory preset), so returning it verbatim was
    // the bug this guards.
    const parsed = parsePresetDump(bytes, 0, modelId);
    const raw = decodeRawPatch(parsed.chunkPayloads);
    assertEqual(raw.crcValid, true, `${label} blank preset CRC valid`);
    assertEqual(presetName(raw.rawPatch), '<EMPTY>', `${label} blank preset name is <EMPTY>`);
    const body = decodeGen3Body(raw.body, modelId);
    assertEqual((body.grid ?? []).length, 0, `${label} blank preset grid is empty`);
    assertEqual((body.scene_names ?? []).every((s) => s === ''), true, `${label} blank preset scene names are empty`);
  } finally {
    await app.close();
  }
}

async function unsupportedModelRefuses(): Promise<void> {
  const { app } = await buildTestApp(0x15); // AM4 — no harvested synth scaffold
  try {
    const res = await app.inject({ method: 'GET', url: '/preset/blank/syx' });
    assertEqual(res.statusCode, 501, 'AM4 has no scaffold → 501');
    assertEqual((res.json() as { capability?: string }).capability, 'blankPreset', 'capability is reported');
  } finally {
    await app.close();
  }
}

export async function runPresetBlankTests(): Promise<void> {
  await modelServesScaffold(0x11, 'FM3');
  await modelServesScaffold(0x12, 'FM9');
  await unsupportedModelRefuses();
}
