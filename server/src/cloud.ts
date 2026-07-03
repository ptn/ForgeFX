// Axis Cloud sync client (Supabase) — the server's env-bound singleton over the store-agnostic core
// in runtime/cloud.ts. GATED: only active when AXIS_CLOUD=1; otherwise ForgeFX never imports this
// module (app.ts dynamic-imports it behind the flag), so release builds ship it dark — and because
// the dynamic import runs after index.ts's process.loadEnvFile(), the env reads below see server/.env.
//
// Env-only — no hardcoded instance. The hosted Axis build injects these at build/run time; self-hosters
// set them (e.g. in ForgeFX/server/.env). Publishable key only; never a secret.
import { createCloud } from './runtime/cloud.js';
import { defaultStore } from './store.js';

export type { CloudConfig, CloudService } from './runtime/cloud.js';
export { createCloud } from './runtime/cloud.js';

const URL = process.env.SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_ANON_KEY ?? '';
export const cloudEnabled = () => process.env.AXIS_CLOUD === '1' && !!URL && !!KEY;

export const cloud = createCloud({ url: URL, anonKey: KEY, enabled: () => process.env.AXIS_CLOUD === '1' }, defaultStore);
