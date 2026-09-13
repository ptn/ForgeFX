// Direct unit tests for src/telemetry.ts — the dark-shipped status probe and the debug-report upload's
// configuration gate. No network: the upload path is only asserted to refuse when unconfigured.
import { telemetryEnabled, telemetryStatus, uploadDebugReport } from '../../src/telemetry.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const TELEMETRY_MODULE_CASE_COUNT = 4;

const KEYS = ['AXIS_TELEMETRY', 'AXIS_FARO_URL', 'AXIS_TELEMETRY_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const;

async function withEnv(env: Partial<Record<(typeof KEYS)[number], string | undefined>>, fn: () => Promise<void> | void): Promise<void> {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try { await fn(); } finally {
    for (const k of KEYS) { const v = saved[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

export async function runTelemetryModuleTests(): Promise<void> {
  // 1. master gate is off unless AXIS_TELEMETRY=1.
  await withEnv({}, () => { assertEqual(telemetryEnabled(), false, 'telemetry dark by default'); });
  await withEnv({ AXIS_TELEMETRY: '1' }, () => { assertEqual(telemetryEnabled(), true, 'AXIS_TELEMETRY=1 enables'); });
  // 2. status reflects the env wiring.
  await withEnv({ AXIS_TELEMETRY: '1', AXIS_FARO_URL: 'https://faro.example', AXIS_TELEMETRY_KEY: 'k' }, () => {
    const s = telemetryStatus();
    assertEqual(s.enabled, true, 'status enabled');
    assertEqual(s.faroUrl, 'https://faro.example', 'status faroUrl');
    assertEqual(s.key, 'k', 'status key');
    assertEqual(s.uploadEnabled, false, 'upload disabled without supabase creds');
  });
  // 3. uploadEnabled is independent of the live-telemetry gate — it only needs supabase creds, so a
  //    user who declined live telemetry can still send a debug report.
  await withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' }, () => {
    const s = telemetryStatus();
    assertEqual(s.enabled, false, 'live telemetry still dark');
    assertEqual(s.uploadEnabled, true, 'upload enabled by supabase creds alone');
  });
  // 4. uploadDebugReport refuses when cloud storage is not configured.
  await withEnv({}, async () => {
    let threw = false;
    try { await uploadDebugReport({ instanceId: 'abc' }); } catch { threw = true; }
    assert(threw, 'upload without config throws');
  });
}
