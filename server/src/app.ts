// ForgeFX HTTP API — the Fastify app factory (Phase 6: unified device-agnostic API).
//
// Routes resolve the ACTIVE per-device driver from the registry (`await registry.driver()` — lazy
// one-time detection) and capability-gate optional driver methods: a device that can't do something
// answers `501 {error:'unsupported', capability}` instead of firing another model's frames at it.
// Connection/system concerns (ports, detect, SSE bus, telemetry supervisor) live on the registry.
//
// The gen-3 routes ARE the unified surface: every pre-Phase-6 gen-3 route keeps its path and a
// byte-identical response for FM3 (additive fields only). The old /am4/* routes are thin DEPRECATED
// ALIASES of the unified routes — same handler functions with param/body shims, `Deprecation` +
// `Sunset` headers, and a per-path hit counter surfaced in GET /diag.
//
// `buildApp(registry)` exists so the API tests can `app.inject()` against an ISOLATED mocked
// registry without listening; the production entry (index.ts) builds the app over the singleton
// registry and listens — identical behavior to the pre-factory module.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import type { DeviceRegistry } from './drivers/registry.js';
import * as backups from './services/backups.js';
import * as store from './store.js';
import { registerHelpRoutes } from './help.js';
import { telemetryStatus, uploadDebugReport, type DebugReport } from './telemetry.js';

export async function buildApp(registry: DeviceRegistry): Promise<FastifyInstance> {
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

  const driver = () => registry.driver();

  /** Capability-gate reply: the active driver doesn't implement this optional method. */
  const unsupported = (reply: FastifyReply, capability: string) => {
    reply.code(501);
    return { error: 'unsupported', capability };
  };

  // ── deprecated-alias plumbing (the folded /am4/* routes) ──
  // Every alias hit gets `Deprecation: true` + a `Sunset` date (≈ one release after Axis migrates to
  // the unified routes), bumps a per-path counter surfaced in GET /diag, and console-warns at most
  // once a minute per path so a chatty old client can't flood the log.
  const ALIAS_SUNSET = 'Tue, 01 Dec 2026 00:00:00 GMT';
  const aliasHits: Record<string, number> = {};
  const aliasLastWarn = new Map<string, number>();
  const deprecated = (req: FastifyRequest, reply: FastifyReply): void => {
    const p = req.routeOptions?.url ?? (req.url.split('?')[0] || req.url);
    aliasHits[p] = (aliasHits[p] ?? 0) + 1;
    void reply.header('Deprecation', 'true').header('Sunset', ALIAS_SUNSET);
    const now = Date.now();
    if ((aliasLastWarn.get(p) ?? 0) + 60_000 <= now) {
      aliasLastWarn.set(p, now);
      console.warn(`[forgefx] DEPRECATED alias ${req.method} ${p} — use the unified route instead (sunset ${ALIAS_SUNSET})`);
    }
  };

  // ── block & parameter help (curated tooltips; see help.ts) ──
  registerHelpRoutes(app);

  // ── debug probe (raw SysEx round-trip; for FC read-decode RE) ──
  app.post<{ Body: { hex: string } }>('/debug/raw', async (req, reply) => {
    try { const bytes = (req.body.hex.match(/../g) ?? []).map((x) => parseInt(x, 16)); return { frames: await registry.rawRequest(bytes) }; }
    catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // ── system ──
  // /healthz carries the unified-API version handshake (mirrored as apiVersion on /device).
  app.get('/healthz', async () => {
    const h = await registry.health();
    return { ok: h.ok, api: { version: 2 }, device: h.device };
  });
  // full connection diagnostic for the desktop debug log, plus the deprecated-alias hit counters
  app.get('/diag', async () => ({ ...(await registry.diagnostics()), deprecatedAliasHits: { ...aliasHits } }));
  app.get('/device', () => registry.deviceInfo());
  app.get('/ports', () => registry.connections()); // serial + MIDI connections (Fractal flagged) + chosen + override
  app.post<{ Body: { transport?: 'serial' | 'midi'; id?: string | null; inId?: string | null; outId?: string | null; model?: string | null } }>('/ports/select', (req) => {
    const b = req.body ?? {};
    const model = b.model; // undefined = leave the profile override as-is; 'auto'/'' = clear it; else force it
    // MIDI (Axe-Fx III / FM9, or an FM3 via a MIDI→USB adapter): separate input + output endpoints
    if (b?.transport === 'midi' && b.inId && b.outId) return registry.selectConnection({ transport: 'midi', id: b.id || b.inId, inId: b.inId, outId: b.outId }, model);
    if (b?.id) return registry.selectConnection({ transport: b.transport === 'midi' ? 'midi' : 'serial', id: b.id }, model);
    return registry.selectConnection(null, model); // clear the port back to auto (a forced profile can remain via `model`)
  }); // manual pick

  // Decode-path errors are surfaced to the client AND logged (console.error → the desktop debug log),
  // so a failing grid/blocks decode (e.g. on Axe-Fx III presets) shows WHY in the user's log, not just 503.
  const decodeFail = (reply: FastifyReply, where: string, e: unknown) => {
    const err = e as Error;
    console.error(`[forgefx] ${where} failed: ${err?.message ?? e}${err?.stack ? `\n${err.stack}` : ''}`);
    reply.code(503);
    return { error: err?.message ?? String(e) };
  };

  // ── unified handlers ──────────────────────────────────────────────────────────────────────────
  // Each capability-gated handler that a /am4/* alias folds into is a named function: the unified
  // route AND its alias call the SAME function (aliases only shim params/body) — no fastify inject.
  const gridH = async (reply: FastifyReply) => {
    try { return await (await driver()).grid(); } catch (e) { return decodeFail(reply, 'grid decode', e); }
  };
  const blocksH = async (reply: FastifyReply) => {
    try {
      const d = await driver();
      if (!d.placedBlocks) return unsupported(reply, 'placedBlocks');
      return await d.placedBlocks();
    } catch (e) { return decodeFail(reply, 'blocks decode', e); }
  };
  const blockParamsH = async (reply: FastifyReply, addr: number) => {
    try {
      const d = await driver();
      if (!d.blockParams) return unsupported(reply, 'blockParams');
      return await d.blockParams(addr);
    } catch (e) { reply.code(404); return { error: (e as Error).message }; }
  };
  // Unified param write: {value, continuous}. continuous:true → the driver's normalized write
  // (gen-3 continuous SET; AM4 SET_NORM with value as 0..1), continuous:false → discrete ordinal.
  const setParamH = async (reply: FastifyReply, addr: number, paramId: number, value: number, continuous: boolean) => {
    const d = await driver();
    if (!d.setParam) return unsupported(reply, 'setParam');
    return d.setParam(addr, paramId, value, continuous);
  };
  const bypassH = async (reply: FastifyReply, addr: number, bypassed: boolean) => {
    const d = await driver();
    if (!d.setBypass) return unsupported(reply, 'setBypass');
    return d.setBypass(addr, bypassed);
  };
  const sceneSetH = async (reply: FastifyReply, index: number) => {
    const d = await driver();
    if (!d.setScene) return unsupported(reply, 'scenes');
    return d.setScene(index);
  };
  const presetSelectH = async (reply: FastifyReply, number: number) => {
    const d = await driver();
    if (!d.selectPreset) return unsupported(reply, 'selectPreset');
    const r = await d.selectPreset(number);
    // `code` is ADDITIVE: the AM4 reports its bank-letter location code (e.g. "C02"); gen-3 doesn't.
    return { ok: r.ok, number, ...(r.code != null ? { code: r.code } : {}) };
  };
  const presetStoreH = async (reply: FastifyReply, number?: number) => {
    const d = await driver();
    if (!d.store) return unsupported(reply, 'supportsSave');
    // number omitted → store to the CURRENT slot (needs a live preset-number query).
    const n = number ?? (d.presetRef ? (await d.presetRef()).number : undefined);
    if (n == null || !Number.isFinite(n) || n < 0) { reply.code(400); return { error: 'number required' }; }
    return d.store(n); // gen-3: {ok}; AM4 additionally carries {location, code}
  };
  // Stored preset name: driver-backed where supported (AM4 → {number, name, code}); the gen-3
  // drivers don't implement it, so they keep the pre-Phase-6 {number, name:''} stub byte-identically.
  const presetNameH = async (n: number) => {
    const d = await driver();
    if (d.storedPresetName) {
      try { return await d.storedPresetName(n); } catch { /* device unreachable → stub below */ }
    }
    return { number: n, name: '' };
  };
  const locationsH = async (reply: FastifyReply) => {
    const d = await driver();
    if (!d.scanPresets) return unsupported(reply, 'presets.canScanNames');
    try {
      const r = await d.scanPresets();
      return { count: r.count, locations: r.presets };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const backupH = async (reply: FastifyReply, location?: number) => {
    const d = await driver();
    if (!d.backupPreset) return unsupported(reply, 'backupDump');
    try { return await d.backupPreset(location); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const restoreH = async (reply: FastifyReply, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of one preset dump required' }; }
    const d = await driver();
    if (!d.restorePreset) return unsupported(reply, 'restoreDump');
    try { return await d.restorePreset(bytes); } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  };
  const fwValidateH = async (reply: FastifyReply, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of a firmware .syx required' }; }
    const d = await driver();
    if (!d.validateFirmware) return unsupported(reply, 'firmwareValidate');
    return d.validateFirmware(bytes);
  };
  const deviceParamH = async (reply: FastifyReply, key?: string, value?: number) => {
    if (!key || value == null) { reply.code(400); return { error: 'key + value required' }; }
    const d = await driver();
    if (!d.setParamByKey) return unsupported(reply, 'deviceParams');
    try { return await d.setParamByKey(key, value); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const modModelH = async () => {
    const d = await driver();
    return d.modifierModel ? d.modifierModel() : null;
  };
  // Offline preset decode with model-byte dispatch: sniff frame[4] of the first F0 frame. 0x15 →
  // the AM4 offline decoder (works whatever unit is attached — decode touches no transport);
  // anything else → the active driver's gen-3 decode, byte-identical to the pre-Phase-6 behavior.
  const decodeH = async (reply: FastifyReply, bytes: Uint8Array) => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) {
      try { return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) }; }
      catch (e) { reply.code(400); return { error: (e as Error).message }; }
    }
    const d = await driver();
    if (!d.decodePresetBytes) return unsupported(reply, 'presetDump');
    try { return d.decodePresetBytes(bytes); } catch (e) { reply.code(422); return { error: (e as Error).message }; }
  };

  // ── preset ──
  app.get('/preset', async (_req, reply) => {
    const d = await driver();
    if (!d.presetRef) return unsupported(reply, 'presetRef');
    return d.presetRef();
  });
  // Stored preset name (driver-backed since Phase 6; gen-3 keeps the {number, name:''} stub).
  app.get<{ Params: { n: string } }>('/presets/:n', (req) => presetNameH(Number(req.params.n)));
  // Decode any preset by number (non-disruptive) → library summary: name, scenes, unique blocks.
  app.get<{ Params: { n: string }; Querystring: { full?: string } }>('/presets/:n/summary', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.presetSummary) return unsupported(reply, 'presetDump');
      return await d.presetSummary(Number(req.params.n), req.query.full === '1');
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // Full per-block decoded params for one preset (every family/param) — deep-search + browser detail.
  app.get<{ Params: { n: string } }>('/presets/:n/params', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.presetParams) return unsupported(reply, 'presetDump');
      return { blocks: await d.presetParams(Number(req.params.n)) };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
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
    if (req.params.c === 'config' && req.params.id !== 'library') registry.broadcastConfig(req.params.id, req.body?.data, req.body?.origin);
    return doc;
  });
  app.delete<{ Params: { c: string; id: string } }>('/store/:c/:id', (req) => { store.delDoc(req.params.c, req.params.id); return { ok: true }; });

  // ── backups + version control ──
  // snapshot one preset (version control); body optional { source }
  app.post<{ Params: { n: string } }>('/backup/preset/:n', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(reply, 'presetDump');
      const v = await backups.backupPreset(d, Number(req.params.n));
      return v ? { version: v } : (reply.code(422), { error: 'empty/invalid preset' });
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // full-device backup (long-running): body { label, from?, to? }
  app.post<{ Body: { label?: string; from?: number; to?: number } }>('/backup/device', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(reply, 'presetDump');
      return await backups.backupDevice(d, req.body?.label ?? 'Device backup', req.body?.from ?? 0, req.body?.to ?? 511);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  app.get('/backups', () => ({ backups: store.listBackups() }));
  // load a stored version into the EDIT BUFFER (play it without occupying a slot)
  app.post<{ Params: { id: string } }>('/version/:id/load', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(reply, 'loadPresetBytes');
      return await backups.loadVersion(d, req.params.id);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // restore a snapshot to its origin slot (load + commit to that slot — destructive for the slot)
  app.post<{ Params: { id: string } }>('/version/:id/restore', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes || !d.store) return unsupported(reply, 'loadPresetBytes');
      return await backups.restoreVersion(d, req.params.id);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // load arbitrary raw .syx bytes (e.g. a cloud/file preset) into the edit buffer
  app.post('/preset/load', async (req, reply) => {
    const buf = req.body as Buffer | undefined;
    if (!buf || !buf.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(reply, 'loadPresetBytes');
      return await d.loadPresetBytes(new Uint8Array(buf));
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
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

  // Decode an uploaded preset .syx → library summary. Offline (decode touches no transport).
  // Bodies: raw bytes as application/octet-stream (pre-Phase-6, byte-identical for gen-3 dumps)
  // OR JSON {bytes:number[]} (Phase 6). Model-byte-dispatched — an AM4 dump decodes via the AM4
  // offline decoder (see decodeH).
  app.post<{ Body: Buffer | { bytes?: number[] } }>('/preset/decode', async (req, reply) => {
    const b = req.body;
    if (Buffer.isBuffer(b)) {
      if (!b.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
      return decodeH(reply, new Uint8Array(b));
    }
    const bytes = b && Array.isArray(b.bytes) ? b.bytes : null;
    if (!bytes || !bytes.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    return decodeH(reply, Uint8Array.from(bytes));
  });

  app.get('/preset/grid', async (_req, reply) => gridH(reply));
  app.get<{ Params: { n: string } }>('/presets/:n/grid', async (_req, reply) => gridH(reply));
  app.get('/preset/blocks', async (_req, reply) => blocksH(reply));
  app.post<{ Body: { number: number } }>('/preset/select', async (req, reply) => presetSelectH(reply, req.body.number));
  app.post<{ Body: { number?: number } }>('/preset/store', async (req, reply) => presetStoreH(reply, req.body?.number));
  // AM4 preset library scan → every stored location {location, code, name, isEmpty}. Capability
  // presets.canScanNames (gen-3 → 501 for now — a 512-slot name scan needs its own paced path).
  app.get('/preset/locations', async (_req, reply) => locationsH(reply));
  // Verbatim .syx dump of one preset (location omitted → active buffer). Capability backupDump.
  app.post<{ Body: { location?: number } }>('/preset/backup', async (req, reply) => backupH(reply, req.body?.location));
  // Verbatim re-emit of a preset dump to its stored location. Capability restoreDump.
  app.post<{ Body: { bytes?: number[] } }>('/preset/restore', async (req, reply) => restoreH(reply, req.body?.bytes));

  // ── catalog ──
  app.get('/blocks', async (_req, reply) => {
    const d = await driver();
    if (!d.blocksCatalog) return unsupported(reply, 'blocksCatalog');
    return d.blocksCatalog();
  });
  app.get<{ Params: { slug: string } }>('/blocks/:slug/types', async (req, reply) => {
    const d = await driver();
    if (!d.blockTypes) return unsupported(reply, 'blockTypes');
    return d.blockTypes(req.params.slug);
  });

  // ── live block params (addressed by the placed block's canonical address `addr`: gen-3 = the
  //    effect id, AM4 = the block's pidLow — exactly what each device's grid/blocks report) ──
  app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/params', async (req, reply) => blockParamsH(reply, Number(req.params.eid)));
  app.put<{ Params: { eid: string; paramId: string }; Body: { value: number; continuous?: boolean } }>(
    '/preset/blocks/:eid/params/:paramId',
    async (req, reply) => setParamH(reply, Number(req.params.eid), Number(req.params.paramId), req.body.value, req.body.continuous ?? true)
  );
  app.post<{ Params: { eid: string }; Body: { bypassed: boolean } }>('/preset/blocks/:eid/bypass', async (req, reply) => bypassH(reply, Number(req.params.eid), req.body.bypassed));
  app.post<{ Params: { eid: string }; Body: { channel: string } }>('/preset/blocks/:eid/channel', async (req, reply) => {
    const d = await driver();
    if (!d.setChannel) return unsupported(reply, 'channels');
    return d.setChannel(Number(req.params.eid), req.body.channel);
  });
  app.post<{ Params: { eid: string }; Body: { value: number } }>('/preset/blocks/:eid/type', async (req, reply) => {
    const d = await driver();
    if (!d.setType) return unsupported(reply, 'setType');
    return d.setType(Number(req.params.eid), req.body.value);
  });

  // ── grid editing (1-indexed row/col, matching FM-Edit) ──
  app.put<{ Body: { row: number; col: number; blockId: number } }>('/preset/grid/cell', async (req, reply) => {
    const d = await driver();
    if (!d.placeCell) return unsupported(reply, 'gridEdit');
    return d.placeCell(req.body.row, req.body.col, req.body.blockId);
  });
  app.post<{ Body: { srcRow: number; srcCol: number; destRow: number; connect?: boolean } }>('/preset/grid/cable', async (req, reply) => {
    const d = await driver();
    if (!d.cable) return unsupported(reply, 'gridEdit');
    return d.cable(req.body.srcRow, req.body.srcCol, req.body.destRow, req.body.connect ?? true);
  });
  app.post<{ Body: { row: number; col: number } }>('/preset/grid/select', async (req, reply) => {
    const d = await driver();
    if (!d.selectCell) return unsupported(reply, 'gridEdit');
    return d.selectCell(req.body.row, req.body.col);
  });

  // ── telemetry: tuner · tempo · scene ──
  app.post<{ Body: { on: boolean } }>('/tuner', (req) => registry.setTuner(!!req.body?.on));
  app.get('/tempo', async (_req, reply) => {
    const d = await driver();
    if (!d.getTempo) return unsupported(reply, 'getTempo');
    return d.getTempo();
  });
  app.post<{ Body: { bpm: number } }>('/tempo', async (req, reply) => {
    const d = await driver();
    if (!d.setTempo) return unsupported(reply, 'setTempo');
    return d.setTempo(req.body.bpm);
  });
  app.post('/tempo/tap', async (_req, reply) => {
    const d = await driver();
    if (!d.tapTempo) return unsupported(reply, 'tapTempo');
    return d.tapTempo();
  });
  app.get('/scene', async (_req, reply) => {
    const d = await driver();
    if (!d.getScene) return unsupported(reply, 'scenes');
    return d.getScene();
  });
  app.post<{ Body: { index: number } }>('/scene', async (req, reply) => sceneSetH(reply, req.body.index));
  // Rename a scene (0-based index) in the working buffer. Visible immediately; persist is a separate store.
  app.post<{ Body: { index: number; name: string } }>('/scene/name', async (req, reply) => {
    const d = await driver();
    if (!d.setSceneName) return unsupported(reply, 'scenes');
    return d.setSceneName(req.body.index, req.body.name);
  });
  // Rename the working-buffer preset. Visible immediately; persist is a separate store.
  app.post<{ Body: { name: string } }>('/preset/name', async (req, reply) => {
    const d = await driver();
    if (!d.setPresetName) return unsupported(reply, 'setPresetName');
    return d.setPresetName(req.body.name);
  });

  // auto-detect the connected Fractal unit (FM3/FM9/Axe-Fx/…) via the fn 0x00 handshake
  app.get('/device/detect', () => registry.detect());

  // cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — for the cab IR picker
  app.get('/cab/irs', () => registry.profile.cabIrs());

  // Foot Controller + Modifier address models (field bases + config formula + enums). FM3-decoded;
  // null where the device's model isn't decoded yet. The client computes (eid,pid) from these and
  // reads/writes via the normal raw-read + setParam path.
  app.get('/fc/model', () => registry.profile.fcModel ?? null);
  // Modifier address model — unified superset DTO (always carries `bindingSupported`: gen-3 true,
  // AM4 false). Driver-backed since Phase 6; offline it serves the provisional profile's model.
  app.get('/mod/model', async () => modModelH());
  // Per-block monitor (meter) param table: paramName → {family, pid, role, min/maxDb}. Read-only pids
  // that ride the normal per-block read; Axis renders a meter per placed block from these. {} if none.
  app.get('/preset/monitors', () => registry.profile.monitorParams ?? {});
  // Live per-block audio meters: reads each placed monitored block's level (normalized 0..1) + dB.
  app.get('/preset/monitors/live', async (req, reply) => {
    const q = (req.query as { eid?: string }).eid;
    const eid = q != null && q !== '' ? Number(q) : undefined;
    try {
      const d = await driver();
      if (!d.liveMonitors) return unsupported(reply, 'liveMonitors');
      return await d.liveMonitors(Number.isFinite(eid as number) ? eid : undefined);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // FC current switch state via the sub-0x01 structured config-selector read (the read FM3-Edit uses on
  // FC-page entry). Returns the decoded current state (category/function/display/color + labels) for one
  // (layout,view,switch), read via the sub-0x1b value channel that tracks param edits (fcReadState).
  app.get<{ Querystring: { layout?: string; view?: string; switch?: string } }>('/fc/state', async (req, reply) => {
    const layout = Number(req.query.layout ?? 0);
    const view = Number(req.query.view ?? 0);
    const sw = Number(req.query.switch ?? 0);
    try {
      const d = await driver();
      if (!d.fcReadState) return unsupported(reply, 'fcLiveRead');
      return await d.fcReadState(layout, view, sw);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // decompressed preset body (hex) — for per-block param-decode RE (offset diffs)
  app.get('/preset/body', async (_req, reply) => {
    try {
      const d = await driver();
      if (!d.presetBodyHex) return unsupported(reply, 'presetDump');
      return await d.presetBodyHex();
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // Validate a firmware .syx (integrity check only, NOT a flasher). Capability firmwareValidate.
  app.post<{ Body: { bytes?: number[] } }>('/firmware/validate', async (req, reply) => fwValidateH(reply, req.body?.bytes));
  // Device/global param write by catalog key (e.g. the AM4's 'amp.gain'). Capability deviceParams.
  app.put<{ Body: { key?: string; value?: number } }>('/device/param', async (req, reply) => deviceParamH(reply, req.body?.key, req.body?.value));

  // bind a modifier slot to a target parameter (writes targetEffectId + targetParam + source on the slot eid)
  app.post<{ Body: { slot: number; targetEffectId: number; targetParam: number; source: number } }>('/mod/bind', async (req, reply) => {
    const b = req.body;
    if (b?.slot == null || b.targetEffectId == null || b.targetParam == null || b.source == null) {
      reply.code(400);
      return { ok: false, error: 'slot, targetEffectId, targetParam, source required' };
    }
    try {
      const d = await driver();
      if (!d.bindModifier) return unsupported(reply, 'modifiers.bind');
      return await d.bindModifier(b.slot, b.targetEffectId, b.targetParam, b.source);
    } catch (e) { reply.code(503); return { ok: false, error: (e as Error).message }; }
  });
  // raw param values for an effect (for FC eid 199 / Modifier eid 3, whose params have no display range)
  app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/raw', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.rawBlock) return unsupported(reply, 'rawBlock');
      return await d.rawBlock(Number(req.params.eid));
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // read specific paramIds via per-pid fn 0x01 GET (FC current state — the 0x1F bulk path doesn't cover FC)
  app.post<{ Params: { eid: string }; Body: { pids: number[] } }>('/preset/blocks/:eid/read', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.readParams) return unsupported(reply, 'readParams');
      return await d.readParams(Number(req.params.eid), req.body?.pids ?? []);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // FC read path: sub 0x1a range-read returning the normalized (0..1) value per pid
  app.post<{ Params: { eid: string }; Body: { pids: number[] } }>('/preset/blocks/:eid/readrange', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.readRange) return unsupported(reply, 'readRange');
      return await d.readRange(Number(req.params.eid), req.body?.pids ?? []);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });
  // current state of a cab block (mode / per-slot bank + IR + dyna type) for the picker
  app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/cab', async (req, reply) => {
    const d = await driver();
    if (!d.cabState) return unsupported(reply, 'cabState');
    return d.cabState(Number(req.params.eid));
  });

  // per-block meter + swipe-control values for the always-on grid level fill
  app.post<{ Body: { wants?: Record<string, number[]> } }>('/preset/meters', async (req, reply) => {
    try {
      const d = await driver();
      if (!d.meters) return unsupported(reply, 'meters');
      return await d.meters(req.body?.wants ?? {});
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // ── DEPRECATED /am4/* aliases (Phase 6 route folding) ─────────────────────────────────────────
  // Each is the SAME unified handler with a param/body shim: `pidLow`→addr, `pidHigh`→paramId,
  // `norm`→{value, continuous:true}, `value`→{value, continuous:false}, `location`→number. They
  // answer with the unified response shape, send Deprecation/Sunset headers, and count into /diag.
  app.get('/am4/grid', async (req, reply) => { deprecated(req, reply); return gridH(reply); });
  app.get('/am4/slots', async (req, reply) => { deprecated(req, reply); return blocksH(reply); });
  app.get<{ Params: { n: string } }>('/am4/presets/:n/name', async (req, reply) => { deprecated(req, reply); return presetNameH(Number(req.params.n)); });
  app.get<{ Params: { pidLow: string } }>('/am4/blocks/:pidLow/params', async (req, reply) => { deprecated(req, reply); return blockParamsH(reply, Number(req.params.pidLow)); });
  app.put<{ Params: { pidLow: string; pidHigh: string }; Body: { norm?: number; value?: number } }>('/am4/blocks/:pidLow/params/:pidHigh', async (req, reply) => {
    deprecated(req, reply);
    const pl = Number(req.params.pidLow), ph = Number(req.params.pidHigh);
    if (req.body?.norm != null) return setParamH(reply, pl, ph, req.body.norm, true);
    if (req.body?.value != null) return setParamH(reply, pl, ph, req.body.value, false);
    reply.code(400); return { error: 'norm or value required' };
  });
  app.get('/am4/presets', async (req, reply) => { deprecated(req, reply); return locationsH(reply); });
  app.put<{ Body: { key?: string; value?: number } }>('/am4/param', async (req, reply) => { deprecated(req, reply); return deviceParamH(reply, req.body?.key, req.body?.value); });
  app.post<{ Body: { pidLow: number; bypassed: boolean } }>('/am4/bypass', async (req, reply) => { deprecated(req, reply); return bypassH(reply, req.body.pidLow, req.body.bypassed); });
  app.post<{ Body: { index: number } }>('/am4/scene', async (req, reply) => { deprecated(req, reply); return sceneSetH(reply, req.body.index); });
  app.post<{ Body: { location: number } }>('/am4/preset', async (req, reply) => { deprecated(req, reply); return presetSelectH(reply, req.body.location); });
  app.post<{ Body: { location?: number } }>('/am4/preset/store', async (req, reply) => {
    deprecated(req, reply);
    if (req.body?.location == null) { reply.code(400); return { error: 'location (0..103) required' }; }
    return presetStoreH(reply, req.body.location);
  });
  app.post<{ Body: { location?: number } }>('/am4/preset/backup', async (req, reply) => { deprecated(req, reply); return backupH(reply, req.body?.location); });
  app.post<{ Body: { bytes?: number[] } }>('/am4/preset/restore', async (req, reply) => { deprecated(req, reply); return restoreH(reply, req.body?.bytes); });
  app.post<{ Body: { bytes?: number[] } }>('/am4/preset/decode', async (req, reply) => {
    deprecated(req, reply);
    const bytes = Array.isArray(req.body?.bytes) ? req.body.bytes : null;
    if (!bytes || !bytes.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    return decodeH(reply, Uint8Array.from(bytes));
  });
  app.get('/am4/mod/model', async (req, reply) => { deprecated(req, reply); return modModelH(); });
  app.post<{ Body: { bytes?: number[] } }>('/am4/firmware/validate', async (req, reply) => { deprecated(req, reply); return fwValidateH(reply, req.body?.bytes); });

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
    const unsub = registry.subscribe((e) => raw.write(`data: ${JSON.stringify(e)}\n\n`));
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
    const remoteHost = new RemoteHost(app, () => cloud.remoteSession(), (fn) => registry.subscribe(fn));
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

  return app;
}
