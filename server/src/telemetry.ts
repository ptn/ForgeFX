// Telemetry / diagnostics — GATED, ships dark. The live RUM path (Faro/OTel) is wired in a later phase
// and only ever activates when AXIS_TELEMETRY=1 AND the user consents in the renderer. This module owns
// two things that work today: the status probe (so Axis can gate its UI), and the on-demand
// "Upload Debug Log" report — an anonymous, per-incident upload that is INDEPENDENT of live telemetry
// (a user who declined telemetry can still choose to send one report). No endpoint/key is hardcoded.
import { brotliCompressSync, constants as zc } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js'; // type-only: erased at compile, no runtime load

// Read env LAZILY (inside functions), not at module top: this module is statically imported, so its
// top-level runs before index.ts's process.loadEnvFile() (ES import hoisting). cloud.ts sidesteps this by
// being dynamically imported after loadEnvFile; we just defer the reads instead.
const url = () => process.env.SUPABASE_URL ?? '';
const key = () => process.env.SUPABASE_ANON_KEY ?? '';

/** Master operator gate (env-only, default off) — mirrors AXIS_CLOUD. */
export const telemetryEnabled = () => process.env.AXIS_TELEMETRY === '1';

/** What Axis reads on boot to decide whether to load the (dynamic-imported) telemetry bundle and show
 *  the diagnostics UI. `uploadEnabled` is independent: the debug-report upload only needs Supabase. */
export function telemetryStatus() {
  return {
    enabled: telemetryEnabled(),
    faroUrl: process.env.AXIS_FARO_URL ?? '',
    key: process.env.AXIS_TELEMETRY_KEY ?? '',
    uploadEnabled: !!url() && !!key()
  };
}

// A login-less Supabase client for the insert-only debug-reports bucket (no user session — the report is
// keyed by the anonymous instance id, not an account). Separate from cloud.ts's per-user authed client.
let anon: SupabaseClient | null = null;
async function anonClient(): Promise<SupabaseClient | null> {
  if (!url() || !key()) return null;
  if (!anon) {
    const { createClient } = await import('@supabase/supabase-js'); // lazy: keeps supabase-js out of dark builds
    anon = createClient(url(), key(), { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return anon;
}

export interface DebugReport {
  instanceId?: string;
  [k: string]: unknown;
}

/** Compress a debug-report bundle as hard as possible (brotli q11 + size hint — the bundle is mostly the
 *  text debug log, which brotli crushes) and upload to debug-reports/<instanceId>/<ts>.json.br. The bucket
 *  policy is insert-only, so a client can push but not browse. Returns the stored path + sizes. */
export async function uploadDebugReport(report: DebugReport): Promise<{ path: string; bytes: number; stored: number }> {
  const c = await anonClient();
  if (!c) throw new Error('cloud storage not configured (SUPABASE_URL / SUPABASE_ANON_KEY unset)');
  const instanceId = String(report.instanceId ?? 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'anon';
  const json = Buffer.from(JSON.stringify(report), 'utf8');
  const packed = brotliCompressSync(json, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: json.length } });
  const path = `${instanceId}/${Date.now().toString(36)}.json.br`;
  const { error } = await c.storage.from('debug-reports').upload(path, packed, { contentType: 'application/x-brotli', upsert: false });
  if (error) throw new Error(`debug-report upload failed: ${error.message}`);
  return { path, bytes: json.length, stored: packed.length };
}
