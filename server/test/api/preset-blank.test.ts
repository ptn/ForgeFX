// GET /preset/blank/syx — the connected model's clean "blank" preset scaffold (the client's
// "start from zero" reset). FM3/FM9/Axe-Fx III carry a scaffold; AM4/VP4 do not (501).
import { buildTestApp } from '../helpers/api.js';
import { assertEqual } from '../helpers/mock.js';

export const PRESET_BLANK_CASE_COUNT = 3;

async function modelServesScaffold(modelId: number, label: string): Promise<void> {
  const { app } = await buildTestApp(modelId);
  try {
    const res = await app.inject({ method: 'GET', url: '/preset/blank/syx' });
    assertEqual(res.statusCode, 200, `${label} blank preset 200`);
    assertEqual(res.headers['content-type'], 'application/octet-stream', `${label} octet-stream body`);
    const bytes = res.rawPayload;
    assertEqual(bytes.length, 24680, `${label} scaffold is a full preset dump`);
    assertEqual(bytes[0], 0xf0, `${label} SysEx start`);
    assertEqual(bytes[4], modelId, `${label} model byte matches the connected unit`);
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
