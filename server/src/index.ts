// ForgeFX HTTP API — Node backend (fractal-midi codec). Mirrors the REST contract
// Axis consumes; drop-in replacement for the retired C# server.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { device } from './device.js';
import { am4 } from './am4Device.js';
import * as store from './store.js';
import { registerHelpRoutes } from './help.js';
import { telemetryStatus, uploadDebugReport, type DebugReport } from './telemetry.js';
import { fileURLToPath } from 'node:url';

// Load the server's .env (Supabase creds + AXIS_CLOUD/AXIS_TELEMETRY/AXIS_FARO_URL) — keeps secrets out
// of source so the public repo never ships a hosted instance's keys. Resolve it RELATIVE TO THIS MODULE
// (server/.env, one level above dist/ or src/) so it's found regardless of the process cwd — the packaged
// app imports us in-process from Electron, where cwd is not the server dir. Falls back to cwd, then to the
// ambient OS env. The release build writes server/.env from CI secrets; in dev it's the local .env.
try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')); }
catch { try { process.loadEnvFile(); } catch { /* rely on the ambient environment */ } }

// supabase-js builds a realtime client in createClient() that needs a global WebSocket. Electron's bundled
// Node (20) has none (WebSocket is global only in Node 22+), so createClient throws in PACKAGED builds and
// cloud/telemetry silently appear "disabled" — even though the env is loaded. Provide `ws` globally before
// any client is created. ForgeFX never opens a realtime channel; this only satisfies the constructor. In
// dev / Node 22+ a global WebSocket already exists, so this is a no-op there.
if (typeof globalThis.WebSocket === 'undefined') {
  try { (globalThis as { WebSocket?: unknown }).WebSocket = (await import('ws')).default; }
  catch { /* ws unavailable — cloud will surface a clear error instead of a silent disable */ }
}

const PORT = Number(process.env.PORT ?? 5056);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });
// tolerate an empty JSON body (no-body POSTs like /cloud/sync, /cloud/logout, /tempo/tap send
// content-type: application/json with no payload → Fastify would 400 by default).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const s = body as string;
  if (!s || !s.length) return done(null, {});
  try { done(null, JSON.parse(s)); } catch (e) { done(e as Error); }
});
// accept raw .syx bytes (preset files) on POST /preset/decode
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

// ── block & parameter help (curated tooltips; see help.ts) ──
registerHelpRoutes(app);

// ── debug probe (raw SysEx round-trip; for FC read-decode RE) ──
app.post<{ Body: { hex: string } }>('/debug/raw', async (req, reply) => {
  try { const bytes = (req.body.hex.match(/../g) ?? []).map((x) => parseInt(x, 16)); return { frames: await device.rawRequest(bytes) }; }
  catch (e) { reply.code(503); return { error: (e as Error).message }; }
});

// ── system ──
app.get('/healthz', () => device.health());
app.get('/diag', () => device.diagnostics()); // full connection diagnostic for the desktop debug log
app.get('/device', () => device.deviceInfo());
app.get('/ports', () => device.connections()); // serial + MIDI connections (Fractal flagged) + chosen + override
app.post<{ Body: { transport?: 'serial' | 'midi'; id?: string | null; inId?: string | null; outId?: string | null; model?: string | null } }>('/ports/select', (req) => {
  const b = req.body ?? {};
  const model = b.model; // undefined = leave the profile override as-is; 'auto'/'' = clear it; else force it
  // MIDI (Axe-Fx III / FM9, or an FM3 via a MIDI→USB adapter): separate input + output endpoints
  if (b?.transport === 'midi' && b.inId && b.outId) return device.selectConnection({ transport: 'midi', id: b.id || b.inId, inId: b.inId, outId: b.outId }, model);
  if (b?.id) return device.selectConnection({ transport: b.transport === 'midi' ? 'midi' : 'serial', id: b.id }, model);
  return device.selectConnection(null, model); // clear the port back to auto (a forced profile can remain via `model`)
}); // manual pick

// ── preset ──
app.get('/preset', () => device.presetRef());
app.get<{ Params: { n: string } }>('/presets/:n', (req) => ({ number: Number(req.params.n), name: '' }));
// Decode any preset by number (non-disruptive) → library summary: name, scenes, unique blocks.
app.get<{ Params: { n: string }; Querystring: { full?: string } }>('/presets/:n/summary', async (req, reply) => {
  try { return await device.presetSummary(Number(req.params.n), req.query.full === '1'); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// Full per-block decoded params for one preset (every family/param) — deep-search + browser detail.
app.get<{ Params: { n: string } }>('/presets/:n/params', async (req, reply) => {
  try { return { blocks: await device.presetParams(Number(req.params.n)) }; } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// ── persistent store: documents (Axis config · library metadata · layouts) ──
app.get<{ Params: { c: string } }>('/store/:c', (req) => ({ docs: store.listDocs(req.params.c) }));
app.get<{ Params: { c: string; id: string } }>('/store/:c/:id', (req, reply) => {
  const d = store.getDoc(req.params.c, req.params.id);
  if (!d) { reply.code(404); return { error: 'not found' }; }
  return d;
});
app.put<{ Params: { c: string; id: string }; Body: { data: unknown; origin?: string } }>('/store/:c/:id', (req) => {
  const doc = store.putDoc(req.params.c, req.params.id, req.body?.data);
  // Fan config writes out to every live UI (host SSE + remote relay) so shared layouts/quick-actions/arrange
  // sync both directions in real time. `origin` lets the writer ignore its own echo. The library index is
  // excluded — it's large and isn't a live-applied doc (remotes pull it once at connect).
  if (req.params.c === 'config' && req.params.id !== 'library') device.broadcastConfig(req.params.id, req.body?.data, req.body?.origin);
  return doc;
});
app.delete<{ Params: { c: string; id: string } }>('/store/:c/:id', (req) => { store.delDoc(req.params.c, req.params.id); return { ok: true }; });

// ── backups + version control ──
// snapshot one preset (version control); body optional { source }
app.post<{ Params: { n: string } }>('/backup/preset/:n', async (req, reply) => {
  try { const v = await device.backupPreset(Number(req.params.n)); return v ? { version: v } : (reply.code(422), { error: 'empty/invalid preset' }); }
  catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// full-device backup (long-running): body { label, from?, to? }
app.post<{ Body: { label?: string; from?: number; to?: number } }>('/backup/device', async (req, reply) => {
  try { return await device.backupDevice(req.body?.label ?? 'Device backup', req.body?.from ?? 0, req.body?.to ?? 511); }
  catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.get('/backups', () => ({ backups: store.listBackups() }));
// load a stored version into the EDIT BUFFER (play it without occupying a slot)
app.post<{ Params: { id: string } }>('/version/:id/load', async (req, reply) => {
  try { return await device.loadVersion(req.params.id); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// restore a snapshot to its origin slot (load + commit to that slot — destructive for the slot)
app.post<{ Params: { id: string } }>('/version/:id/restore', async (req, reply) => {
  try { return await device.restoreVersion(req.params.id); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// load arbitrary raw .syx bytes (e.g. a cloud/file preset) into the edit buffer
app.post('/preset/load', async (req, reply) => {
  const buf = req.body as Buffer | undefined;
  if (!buf || !buf.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
  try { return await device.loadPresetBytes(new Uint8Array(buf)); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// version history (all, or for one slot via ?location=)
app.get<{ Querystring: { location?: string } }>('/versions', (req) => ({ versions: store.listPresetVersions(req.query.location != null ? Number(req.query.location) : undefined) }));
// download a stored snapshot's raw .syx
app.get<{ Params: { id: string } }>('/version/:id/syx', (req, reply) => {
  const bytes = store.getPresetVersionBytes(req.params.id);
  if (!bytes) { reply.code(404); return { error: 'not found' }; }
  reply.header('content-type', 'application/octet-stream');
  return Buffer.from(bytes);
});

// Decode an uploaded preset .syx file (raw bytes, application/octet-stream) → library summary. Offline.
app.post('/preset/decode', (req, reply) => {
  const buf = req.body as Buffer | undefined;
  if (!buf || !buf.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
  try { return device.decodePresetBytes(new Uint8Array(buf)); } catch (e) { reply.code(422); return { error: (e as Error).message }; }
});
// Decode-path errors are surfaced to the client AND logged (console.error → the desktop debug log),
// so a failing grid/blocks decode (e.g. on Axe-Fx III presets) shows WHY in the user's log, not just 503.
const decodeFail = (reply: import('fastify').FastifyReply, where: string, e: unknown) => {
  const err = e as Error;
  console.error(`[forgefx] ${where} failed: ${err?.message ?? e}${err?.stack ? `\n${err.stack}` : ''}`);
  reply.code(503);
  return { error: err?.message ?? String(e) };
};
app.get('/preset/grid', async (_req, reply) => {
  try { return await device.grid(); } catch (e) { return decodeFail(reply, 'grid decode', e); }
});
app.get<{ Params: { n: string } }>('/presets/:n/grid', async (_req, reply) => {
  try { return await device.grid(); } catch (e) { return decodeFail(reply, 'grid decode', e); }
});
app.get('/preset/blocks', async (_req, reply) => {
  try { return await device.placedBlocks(); } catch (e) { return decodeFail(reply, 'blocks decode', e); }
});
app.post<{ Body: { number: number } }>('/preset/select', async (req) => {
  const r = await device.selectPreset(req.body.number);
  return { ok: r.ok, number: req.body.number };
});
app.post<{ Body: { number?: number } }>('/preset/store', async (req) => {
  const cur = req.body?.number ?? (await device.presetRef()).number;
  return device.store(cur);
});

// ── catalog ──
app.get('/blocks', () => device.blocksCatalog());
app.get<{ Params: { slug: string } }>('/blocks/:slug/types', (req) => device.blockTypes(req.params.slug));

// ── live block params (addressed by the placed block's effect id, so multiple instances work) ──
app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/params', async (req, reply) => {
  try { return await device.blockParams(Number(req.params.eid)); } catch (e) { reply.code(404); return { error: (e as Error).message }; }
});
app.put<{ Params: { eid: string; paramId: string }; Body: { value: number; continuous?: boolean } }>(
  '/preset/blocks/:eid/params/:paramId',
  (req) => device.setParam(Number(req.params.eid), Number(req.params.paramId), req.body.value, req.body.continuous ?? true)
);
app.post<{ Params: { eid: string }; Body: { bypassed: boolean } }>('/preset/blocks/:eid/bypass', (req) =>
  device.setBypass(Number(req.params.eid), req.body.bypassed)
);
app.post<{ Params: { eid: string }; Body: { channel: string } }>('/preset/blocks/:eid/channel', (req) =>
  device.setChannel(Number(req.params.eid), req.body.channel)
);
app.post<{ Params: { eid: string }; Body: { value: number } }>('/preset/blocks/:eid/type', (req) =>
  device.setType(Number(req.params.eid), req.body.value)
);

// ── grid editing (1-indexed row/col, matching FM-Edit) ──
app.put<{ Body: { row: number; col: number; blockId: number } }>('/preset/grid/cell', (req) =>
  device.placeCell(req.body.row, req.body.col, req.body.blockId)
);
app.post<{ Body: { srcRow: number; srcCol: number; destRow: number; connect?: boolean } }>('/preset/grid/cable', (req) =>
  device.cable(req.body.srcRow, req.body.srcCol, req.body.destRow, req.body.connect ?? true)
);
app.post<{ Body: { row: number; col: number } }>('/preset/grid/select', (req) => device.selectCell(req.body.row, req.body.col));

// ── telemetry: tuner · tempo · scene ──
app.post<{ Body: { on: boolean } }>('/tuner', (req) => device.setTuner(!!req.body?.on));
app.get('/tempo', () => device.getTempo());
app.post<{ Body: { bpm: number } }>('/tempo', (req) => device.setTempo(req.body.bpm));
app.post('/tempo/tap', () => device.tapTempo());
app.get('/scene', () => device.getScene());
app.post<{ Body: { index: number } }>('/scene', (req) => device.setScene(req.body.index));
// Rename a scene (0-based index) in the working buffer. Visible immediately; persist is a separate store.
app.post<{ Body: { index: number; name: string } }>('/scene/name', (req) => device.setSceneName(req.body.index, req.body.name));
// Rename the working-buffer preset. Visible immediately; persist is a separate store.
app.post<{ Body: { name: string } }>('/preset/name', (req) => device.setPresetName(req.body.name));

// auto-detect the connected Fractal unit (FM3/FM9/Axe-Fx/…) via the fn 0x00 handshake
app.get('/device/detect', () => device.detect());

// cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — for the cab IR picker
app.get('/cab/irs', () => device.profile.cabIrs());

// Foot Controller + Modifier address models (field bases + config formula + enums). FM3-decoded;
// null where the device's model isn't decoded yet. The client computes (eid,pid) from these and
// reads/writes via the normal raw-read + setParam path.
app.get('/fc/model', () => device.profile.fcModel ?? null);
app.get('/mod/model', () => device.profile.modModel ?? null);
// Per-block monitor (meter) param table: paramName → {family, pid, role, min/maxDb}. Read-only pids
// that ride the normal per-block read; Axis renders a meter per placed block from these. {} if none.
app.get('/preset/monitors', () => device.profile.monitorParams ?? {});
// Live per-block audio meters: reads each placed monitored block's level (normalized 0..1) + dB.
app.get('/preset/monitors/live', async (req, reply) => {
  const q = (req.query as { eid?: string }).eid;
  const eid = q != null && q !== '' ? Number(q) : undefined;
  try { return await device.liveMonitors(Number.isFinite(eid as number) ? eid : undefined); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// FC current switch state via the sub-0x01 structured config-selector read (the read FM3-Edit uses on
// FC-page entry). Returns the decoded current state (category/function/display/color + labels) for one
// (layout,view,switch), read via the sub-0x1b value channel that tracks param edits (Device.fcReadState).
app.get<{ Querystring: { layout?: string; view?: string; switch?: string } }>('/fc/state', async (req, reply) => {
  const layout = Number(req.query.layout ?? 0);
  const view = Number(req.query.view ?? 0);
  const sw = Number(req.query.switch ?? 0);
  try { return await device.fcReadState(layout, view, sw); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});

// ── AM4 (model 0x15) — flat 4-slot device, its own codec (fractal-midi/am4). Axis routes here when
//    /device/detect reports an AM4. Shares the one open connection with the gen-3 path. ──
// decompressed preset body (hex) — for per-block param-decode RE (offset diffs)
app.get('/preset/body', async (_req, reply) => {
  try { return await device.presetBodyHex(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.get('/am4/slots', async (_req, reply) => {
  try { return await am4.slots(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// AM4 4 slots as a 1×4 grid DTO → reuses the existing Signal Grid renderer in Axis
app.get('/am4/grid', async (_req, reply) => {
  try { return await am4.grid(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.get<{ Params: { n: string } }>('/am4/presets/:n/name', async (req, reply) => {
  try { return await am4.presetName(Number(req.params.n)); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// AM4 block parameters, addressed by the slot's pidLow (the effectId the grid reports). Returns the
// SAME DTO shape as the gen-3 /preset/blocks/:eid/params so Axis renders both with the same BlockEditor.
app.get<{ Params: { pidLow: string } }>('/am4/blocks/:pidLow/params', async (req, reply) => {
  try { return await am4.blockParams(Number(req.params.pidLow)); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// Write one AM4 param by wire address (pidLow=block, pidHigh=param): {norm} for a continuous knob
// (0..1, SET_NORM), or {value} for a discrete/enum ordinal.
app.put<{ Params: { pidLow: string; pidHigh: string }; Body: { norm?: number; value?: number } }>('/am4/blocks/:pidLow/params/:pidHigh', async (req, reply) => {
  const pl = Number(req.params.pidLow), ph = Number(req.params.pidHigh);
  try {
    if (req.body?.norm != null) return await am4.setParamNorm(pl, ph, req.body.norm);
    if (req.body?.value != null) return await am4.setParamValue(pl, ph, req.body.value);
    reply.code(400); return { error: 'norm or value required' };
  } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// AM4 preset library: scan stored locations → {location, code, name, isEmpty} for the browser.
app.get('/am4/presets', async (_req, reply) => {
  try { return await am4.scanPresets(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.put<{ Body: { key: string; value: number } }>('/am4/param', async (req, reply) => {
  if (!req.body?.key) { reply.code(400); return { error: 'key + value required' }; }
  try { return await am4.setParam(req.body.key, req.body.value); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.post<{ Body: { pidLow: number; bypassed: boolean } }>('/am4/bypass', async (req, reply) => {
  try { return await am4.setBypass(req.body.pidLow, req.body.bypassed); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.post<{ Body: { index: number } }>('/am4/scene', async (req, reply) => {
  try { return await am4.switchScene(req.body.index); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.post<{ Body: { location: number } }>('/am4/preset', async (req, reply) => {
  try { return await am4.switchPreset(req.body.location); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// Save the active edit buffer to a stored location (0..103). Wire action 0x1B, hardware-confirmed.
app.post<{ Body: { location: number } }>('/am4/preset/store', async (req, reply) => {
  if (req.body?.location == null) { reply.code(400); return { error: 'location (0..103) required' }; }
  try { return await am4.storePreset(req.body.location); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// Back up a preset off the device as a verbatim .syx dump (location omitted → active buffer).
app.post<{ Body: { location?: number } }>('/am4/preset/backup', async (req, reply) => {
  try { return await am4.backupPreset(req.body?.location); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// Restore a preset .syx (byte array of one 12,352-byte dump) — verbatim re-emit to its stored location.
app.post<{ Body: { bytes: number[] } }>('/am4/preset/restore', async (req, reply) => {
  if (!Array.isArray(req.body?.bytes) || !req.body.bytes.length) { reply.code(400); return { error: 'bytes[] of one AM4 preset dump required' }; }
  try { return await am4.restorePreset(req.body.bytes); } catch (e) { reply.code(400); return { error: (e as Error).message }; }
});
// Offline decode of an AM4 .syx (single dump or full bank) → each preset's location + name (library import).
app.post<{ Body: { bytes: number[] } }>('/am4/preset/decode', async (req, reply) => {
  if (!Array.isArray(req.body?.bytes) || !req.body.bytes.length) { reply.code(400); return { error: 'bytes[] of an AM4 .syx (dump or bank) required' }; }
  try { return am4.decodeSyx(req.body.bytes); } catch (e) { reply.code(400); return { error: (e as Error).message }; }
});
// AM4 modifier address model (16 slots) — field map + source/operation/channel enums (data-only).
app.get('/am4/mod/model', () => am4.modifierModel());
// Validate an AM4 firmware .syx (fn 0x7D/0x7E/0x7F envelope) — integrity check only, NOT a flasher.
app.post<{ Body: { bytes: number[] } }>('/am4/firmware/validate', (req, reply) => {
  if (!Array.isArray(req.body?.bytes) || !req.body.bytes.length) { reply.code(400); return { error: 'bytes[] of an AM4 firmware .syx required' }; }
  return am4.validateFirmware(req.body.bytes);
});
// bind a modifier slot to a target parameter (writes targetEffectId + targetParam + source on the slot eid)
app.post<{ Body: { slot: number; targetEffectId: number; targetParam: number; source: number } }>('/mod/bind', async (req, reply) => {
  const b = req.body;
  if (b?.slot == null || b.targetEffectId == null || b.targetParam == null || b.source == null) {
    reply.code(400);
    return { ok: false, error: 'slot, targetEffectId, targetParam, source required' };
  }
  try { return await device.bindModifier(b.slot, b.targetEffectId, b.targetParam, b.source); } catch (e) { reply.code(503); return { ok: false, error: (e as Error).message }; }
});
// raw param values for an effect (for FC eid 199 / Modifier eid 3, whose params have no display range)
app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/raw', async (req, reply) => {
  try { return await device.rawBlock(Number(req.params.eid)); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// read specific paramIds via per-pid fn 0x01 GET (FC current state — the 0x1F bulk path doesn't cover FC)
app.post<{ Params: { eid: string }; Body: { pids: number[] } }>('/preset/blocks/:eid/read', async (req, reply) => {
  try { return await device.readParams(Number(req.params.eid), req.body?.pids ?? []); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// FC read path: sub 0x1a range-read returning the normalized (0..1) value per pid
app.post<{ Params: { eid: string }; Body: { pids: number[] } }>('/preset/blocks/:eid/readrange', async (req, reply) => {
  try { return await device.readRange(Number(req.params.eid), req.body?.pids ?? []); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
// current state of a cab block (mode / per-slot bank + IR + dyna type) for the picker
app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/cab', (req) => device.cabState(Number(req.params.eid)));

// per-block meter + swipe-control values for the always-on grid level fill
app.post<{ Body: { wants?: Record<string, number[]> } }>('/preset/meters', async (req, reply) => {
  try { return await device.meters(req.body?.wants ?? {}); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});

// ── live event stream (SSE): tuner / tempo / scene / cpu pushes ──
app.get('/events', (req, reply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  });
  raw.write(': connected\n\n');
  const unsub = device.subscribe((e) => raw.write(`data: ${JSON.stringify(e)}\n\n`));
  const hb = setInterval(() => raw.write(': hb\n\n'), 15000);
  req.raw.on('close', () => {
    clearInterval(hb);
    unsub();
  });
});

// ── static UI (optional) ──
// When FORGEFX_STATIC points at a built SPA (Axis), serve it for any non-API GET, with SPA
// fallback to index.html. Registered as the not-found handler so it never shadows API routes.
// Used by the desktop app (loads http://localhost:PORT) and headless/Pi single-binary setups.
const STATIC = process.env.FORGEFX_STATIC;
if (STATIC) {
  const root = resolve(STATIC);
  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.wasm': 'application/wasm'
  };
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
    const urlPath = decodeURIComponent(req.url.split('?')[0] ?? '/');
    let file = join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!resolve(file).startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return reply.code(404).send({ error: 'not found' });
    return reply.type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(file));
  });
}

// ── cloud sync (GATED: only when AXIS_CLOUD=1; release builds never load supabase-js) ──
if (process.env.AXIS_CLOUD === '1') {
  const { cloud } = await import('./cloud.js');
  type Creds = { email: string; password: string };
  app.get('/cloud/status', async () => cloud.status());
  app.post<{ Body: Creds }>('/cloud/register', async (req, reply) => { try { return await cloud.register(req.body.email, req.body.password); } catch (e) { reply.code(400); return { error: (e as Error).message }; } });
  app.post<{ Body: Creds }>('/cloud/login', async (req, reply) => { try { return await cloud.login(req.body.email, req.body.password); } catch (e) { reply.code(401); return { error: (e as Error).message }; } });
  app.post('/cloud/logout', async () => cloud.logout());
  app.post('/cloud/delete-account', async (_req, reply) => { try { return await cloud.deleteAccount(); } catch (e) { reply.code(500); return { error: (e as Error).message }; } });
  app.post<{ Body: { scopes?: { config?: boolean; presets?: boolean } } }>('/cloud/sync', async (req, reply) => { try { return await cloud.sync(req.body?.scopes); } catch (e) { reply.code(503); return { error: (e as Error).message }; } });
  app.get('/cloud/index', async (_req, reply) => { try { return await cloud.cloudIndex(); } catch (e) { reply.code(503); return { error: (e as Error).message }; } });

  // ── Axis Cloud Remote — host agent (off by default; toggled by the Axis UI) ──
  const { RemoteHost } = await import('./remote.js');
  const remoteHost = new RemoteHost(app, () => cloud.remoteSession(), (fn) => device.subscribe(fn));
  app.get('/remote/status', async () => remoteHost.status());
  app.post<{ Body: { on?: boolean } }>('/remote/enable', async (req, reply) => {
    try { return await remoteHost.enable(!!req.body?.on); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
} else {
  app.get('/cloud/status', async () => ({ enabled: false, user: null })); // so Axis can gate its UI without erroring
  app.get('/remote/status', async () => ({ enabled: false, connected: false, userId: null }));
}

// ── telemetry / diagnostics ── status is always served (so Axis gates its UI without erroring). The
// on-demand "Upload Debug Log" report is INDEPENDENT of live telemetry — it works whenever Supabase is
// configured, as a per-incident explicit upload, even if the user declined live telemetry.
app.get('/telemetry/status', async () => telemetryStatus());
app.post<{ Body: DebugReport }>('/telemetry/report', async (req, reply) => {
  try { return await uploadDebugReport(req.body ?? {}); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});

// Auto port allocation: try PORT; if it's taken, let the OS assign a free one (port 0).
// The actual bound port is logged (and the desktop app picks a free port up front anyway).
async function listen(port: number, fellBack = false): Promise<void> {
  try {
    await app.listen({ port, host: '0.0.0.0' });
    const addr = app.server.address();
    const actual = addr && typeof addr === 'object' ? addr.port : port;
    app.log.info(`ForgeFX (node) on http://localhost:${actual}`);
    // one-shot startup diagnostic — lands in the desktop debug log even if the /diag fetch never fires
    device.diagnostics().then((d) => app.log.info({ diag: d }, 'forgefx startup diagnostics')).catch(() => {});
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' && !fellBack) {
      app.log.warn(`port ${port} in use — falling back to an OS-assigned free port`);
      return listen(0, true);
    }
    app.log.error(e);
    process.exit(1);
  }
}
listen(PORT);
