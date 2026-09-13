// ForgeFX HTTP API — the Fastify app factory (Phase 6: unified device-agnostic API).
//
// Routes resolve the ACTIVE per-device driver from the registry (`await registry.driver()` — lazy
// one-time detection) and capability-gate optional driver methods: a device that can't do something
// answers `501 {error:'unsupported', capability}` instead of firing another model's frames at it.
// Connection/system concerns (ports, detect, SSE bus, telemetry supervisor) live on the registry.
//
// C1: the shared route table (method/path/octet + handler) is src/http/routeManifest.ts — the browser
// twin (runtime/router.ts) registers the SAME manifest, so method/path drift is impossible. This
// module keeps only the Fastify adapter, the deprecated /am4/* alias shims, SSE, static UI and the
// Node-gated file/cloud/remote/telemetry surface.
//
// The old /am4/* routes are thin DEPRECATED ALIASES of the unified routes — same handler functions
// with param/body shims, `Deprecation` + `Sunset` headers, and a per-path hit counter in GET /diag.
//
// `buildApp(registry)` exists so the API tests can `app.inject()` against an ISOLATED mocked
// registry without listening; the production entry (index.ts) builds the app over the singleton
// registry and listens — identical behavior to the pre-factory module.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import type { DeviceRegistry } from './drivers/registry.js';
import * as convert from './services/convert.js';
import type { ConverterPreset } from 'forgefx-midi/convert';
import * as editorCacheImport from './services/editorCacheImport.js';
import * as colorLabelsImport from './services/colorLabelsImport.js';
import * as blockLibraryImport from './services/blockLibraryImport.js';
import * as blockLibrarySave from './services/blockLibrarySave.js';
import * as editorCacheDiscovery from './services/editorCacheDiscovery.js';
import * as cloudProfiles from './services/cloudProfiles.js';
import * as store from './store.js';
import { createUnifiedHandlers } from './runtime/handlers.js';
import { createStoreHandlers } from './runtime/storeHandlers.js';
import { createRouteManifest, type RouteCtx } from './http/routeManifest.js';
import { registerLocalRoutes } from './localStore.js';
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
  // accept raw .syx bytes (preset files) on the octet routes
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // The unified handler bodies + capability gate — shared with the runtime router (see handlers.ts).
  const h = createUnifiedHandlers(registry);
  const { driver, unsupported } = h;
  const sh = createStoreHandlers(store.defaultStore, registry);

  // ── shared routes (C1 single source) ─────────────────────────────────────────────────────────
  // One Fastify adapter turns each native request into a surface-neutral RouteCtx, then sends the
  // handler's return (Uint8Array → octet-stream, everything else → JSON) with the recorded status.
  for (const r of createRouteManifest(h, sh)) {
    app.route({
      method: r.method,
      url: r.path,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
          if (Array.isArray(v)) for (const x of v) query.append(k, String(x));
          else if (v != null) query.set(k, String(v));
        }
        const body = req.body as unknown;
        const ctx: RouteCtx = {
          params: (req.params ?? {}) as Record<string, string>,
          query,
          body: body ?? {},
          raw: null,
          reply: { code: (n) => reply.code(n) },
        };
        if (r.octet && Buffer.isBuffer(body)) { ctx.raw = new Uint8Array(body); ctx.body = {}; }
        const out = await r.handler(ctx);
        if (out instanceof Uint8Array) { reply.type('application/octet-stream'); reply.send(Buffer.from(out)); return; }
        reply.send(out);
      },
    });
  }

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
  registerHelpRoutes(app, registry);

  // ── debug probe (raw SysEx round-trip; for FC read-decode RE) ──
  app.post<{ Body: { hex: string } }>('/debug/raw', async (req, reply) => {
    try { const bytes = (req.body.hex.match(/../g) ?? []).map((x) => parseInt(x, 16)); return { frames: await registry.rawRequest(bytes) }; }
    catch (e) { reply.code(503); return { error: (e as Error).message }; }
  });

  // ── system: full connection diagnostic for the desktop debug log + deprecated-alias hit counters ──
  app.get('/diag', async () => h.diagH(aliasHits));

  // ── editor-cache import (SECOND cache source: an official-editor effectDefinitions_*.cache file;
  //    capability cacheImport). See services/editorCacheImport.ts + editorCacheDiscovery.ts. ──
  // Sources: is a cache already persisted for the attached device + which on-disk editor caches exist.
  app.get('/device/cache/sources', async () => {
    const persisted = await editorCacheImport.isPersisted(store.defaultStore, registry);
    return { persisted, candidates: editorCacheDiscovery.discoverEditorCaches() };
  });
  // Import: raw octet-stream of the .cache file + ?name=<filename> (& ?force=1), OR JSON { path } to
  // read a discovered candidate off disk. 501 no cacheImport, 409 model/firmware mismatch (force skips fw).
  app.post<{ Body: Buffer | { path?: string }; Querystring: { name?: string; force?: string } }>('/device/cache/import', async (req, reply) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    const b = req.body;
    let bytes: Uint8Array;
    let name: string;
    if (b && !Buffer.isBuffer(b) && typeof b.path === 'string' && b.path) {
      try { const read = editorCacheDiscovery.readCandidateFile(b.path); bytes = read.bytes; name = read.name; }
      catch (e) { reply.code(400); return { error: 'cannot read path', message: (e as Error).message }; }
    } else if (Buffer.isBuffer(b)) {
      const nm = req.query.name;
      if (!nm) { reply.code(400); return { error: 'missing ?name=<filename> for the uploaded .cache bytes' }; }
      bytes = new Uint8Array(b); name = nm;
    } else {
      reply.code(400); return { error: 'POST the .cache bytes as application/octet-stream with ?name=<filename>, or JSON { path }' };
    }
    const r = await editorCacheImport.importEditorCache(registry, store.defaultStore, bytes, { name, force });
    reply.code(r.code);
    return r.body;
  });

  // ── FM3-Edit preset-color import (color-assignments*.dat → tag names + colors; NOT device-coupled —
  //    a preset-color file isn't tied to a connected device, so no persisted-cache/model/firmware
  //    handling like the block above). See services/colorLabelsImport.ts + editorCacheDiscovery.ts. ──
  app.get('/fm3edit/color-labels/sources', () => ({ candidates: editorCacheDiscovery.discoverColorAssignments() }));
  // Import: raw octet-stream of the .dat file, OR JSON { path } to read a discovered candidate off disk.
  // 422 on parse failure (mirrors editor-cache-import's cache-parse-failed handling).
  app.post<{ Body: Buffer | { path?: string } }>('/fm3edit/color-labels/import', async (req, reply) => {
    const b = req.body;
    let bytes: Uint8Array;
    if (b && !Buffer.isBuffer(b) && typeof b.path === 'string' && b.path) {
      try { const read = editorCacheDiscovery.readCandidateFile(b.path); bytes = read.bytes; }
      catch (e) { reply.code(400); return { error: 'cannot read path', message: (e as Error).message }; }
    } else if (Buffer.isBuffer(b)) {
      bytes = new Uint8Array(b);
    } else {
      reply.code(400); return { error: 'POST the .dat bytes as application/octet-stream, or JSON { path }' };
    }
    try {
      const result = colorLabelsImport.parseColorAssignments(bytes);
      return result;
    } catch (e) {
      reply.code(422);
      return { error: 'color-labels-parse-failed', message: (e as Error).message };
    }
  });

  // ── FM3-Edit/Axe-Edit III/FM9-Edit saved-block library (.blk single-block saves; cheeky-brewing-
  //    finch plan) — read-only, offline, model-dispatched (like /preset/decode), NOT device-coupled
  //    (a saved block isn't tied to a connected device). See blockLibraryImport.ts +
  //    editorCacheDiscovery.ts#discoverBlockFiles. ──
  // Sources: metadata only (no decode — 230 files must list fast). The caller supplies the
  // directory rather than ForgeFX inspecting another application's settings file.
  app.get<{ Querystring: { libraryPath?: string } }>('/fm3edit/blocks/sources', (req, reply) => {
    const { libraryPath } = req.query;
    if (!libraryPath) {
      reply.code(400);
      return { error: 'libraryPath query parameter is required' };
    }
    return {
      candidates: editorCacheDiscovery
        .discoverBlockFiles(editorCacheDiscovery.expandHomePath(libraryPath))
        .map((c) => ({ ...c, slug: blockLibrarySave.slugForFolder(c.category) })),
    };
  });
  // Decode: raw octet-stream of the .blk file, OR JSON { path, libraryPath }. File-based decode is
  // constrained to the library directory the caller explicitly selected. 422 on parse failure.
  app.post<{ Body: Buffer | { path?: string; libraryPath?: string } }>('/fm3edit/blocks/decode', async (req, reply) => {
    const b = req.body;
    let bytes: Uint8Array;
    if (b && !Buffer.isBuffer(b) && typeof b.path === 'string' && b.path) {
      if (typeof b.libraryPath !== 'string' || !b.libraryPath) {
        reply.code(400);
        return { error: 'libraryPath is required when decoding a file path' };
      }
      const candidates = editorCacheDiscovery.discoverBlockFiles(editorCacheDiscovery.expandHomePath(b.libraryPath));
      if (!candidates.some((c) => c.path === b.path)) {
        reply.code(400);
        return { error: 'path is not in the supplied block library' };
      }
      try { const read = editorCacheDiscovery.readCandidateFile(b.path); bytes = read.bytes; }
      catch (e) { reply.code(400); return { error: 'cannot read path', message: (e as Error).message }; }
    } else if (Buffer.isBuffer(b)) {
      bytes = new Uint8Array(b);
    } else {
      reply.code(400); return { error: 'POST the .blk bytes as application/octet-stream, or JSON { path, libraryPath }' };
    }
    try {
      return blockLibraryImport.decodeBlockFile(bytes);
    } catch (e) {
      reply.code(422);
      return { error: 'block-file-parse-failed', message: (e as Error).message };
    }
  });
  // Save a placed block back to a caller-selected `.blk` library (the write twin of the decode route
  // above). Device-coupled: the payload is the block's live bulk-read burst and the firmware bytes
  // come from the connected unit (never a previewed block). Orchestration lives in
  // services/blockLibrarySave.ts#saveBlockToLibrary.
  app.post<{ Body: blockLibrarySave.SaveBlockRequest }>(
    '/fm3edit/blocks/save',
    async (req, reply) => {
      const outcome = await blockLibrarySave.saveBlockToLibrary(
        await driver(),
        registry.firmwareInfo(),
        editorCacheDiscovery.expandHomePath,
        req.body ?? {},
      );
      reply.code(outcome.code);
      return outcome.body;
    },
  );

  // ── local storage folder (Presets/ library + Sync/ plain-syx mirror; see localStore.ts) ──
  registerLocalRoutes(app, h.decodeBytes);

  // Cross-device preset conversion. `source.syx` (base64) → OFFLINE decode of the uploaded dump
  // (gen-3 + AM4, model-byte dispatched; touches no device). `source` omitted → the CONNECTED device's
  // current preset, capability-gated (501 when the active driver's `presetConvert` is false). 400 for
  // an unknown target or an undecodable dump; the codec engine's per-decision events + severity summary
  // ride the 200 body. All codec calls live in services/convert.ts.
  app.post<{ Body: { targetDevice?: string; source?: { syx?: string } } }>('/preset/convert', async (req, reply) => {
    const targetDevice = req.body?.targetDevice;
    if (!convert.isConverterDeviceId(targetDevice)) {
      reply.code(400);
      return { error: 'unknown targetDevice', targetDevice: targetDevice ?? null, supported: convert.SUPPORTED_TARGETS };
    }
    const syxB64 = req.body?.source?.syx;
    try {
      if (typeof syxB64 === 'string' && syxB64.length > 0) {
        return convert.convertFromSyx(new Uint8Array(Buffer.from(syxB64, 'base64')), targetDevice);
      }
      const d = await driver();
      if (!d.capabilities.presetConvert) return unsupported(reply, 'presetConvert');
      return await convert.convertFromDriver(d, targetDevice);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      reply.code(err.statusCode ?? 503);
      return { error: err.message ?? 'conversion failed' };
    }
  });

  // Author a target-device preset `.syx` from a converted preset by FULL-BODY SYNTHESIS onto the codec's
  // bundled default FM3 scaffold. `source.syx` (base64) → OFFLINE source; omit `source` → the CONNECTED
  // device's current preset (capability-gated). `base.syx` (base64) is OPTIONAL — when supplied it must be a
  // valid FM3 dump and is used as the scaffold override (400 otherwise); when omitted the bundled scaffold is
  // used so NO base is needed. FM3 targets only (501 otherwise). NOTE: the returned bytes are FILE-level
  // valid only — a hardware load test on a real FM3 is still required.
  app.post<{ Body: { targetDevice?: string; preset?: ConverterPreset; source?: { syx?: string }; base?: { syx?: string }; name?: string; slot?: number } }>(
    '/preset/convert/export',
    async (req, reply) => {
      const targetDevice = req.body?.targetDevice;
      if (!convert.isConverterDeviceId(targetDevice)) {
        reply.code(400);
        return { error: 'unknown targetDevice', targetDevice: targetDevice ?? null, supported: convert.SUPPORTED_TARGETS };
      }
      const baseB64 = req.body?.base?.syx;
      const base =
        typeof baseB64 === 'string' && baseB64.length > 0
          ? new Uint8Array(Buffer.from(baseB64, 'base64'))
          : undefined;
      const editedPreset = req.body?.preset;
      const syxB64 = req.body?.source?.syx;
      try {
        // PREFERRED: an edited converter IR from the UI — author it DIRECTLY so the user's grid
        // routing/cables + block/param edits are carried verbatim (no re-convert from source).
        if (editedPreset && Array.isArray(editedPreset.blocks)) {
          return await convert.exportConvertedSyx({
            targetDevice,
            preset: editedPreset,
            base,
            name: req.body?.name,
            slot: req.body?.slot,
          });
        }
        if (typeof syxB64 === 'string' && syxB64.length > 0) {
          return await convert.exportConvertedSyx({
            targetDevice,
            sourceSyx: new Uint8Array(Buffer.from(syxB64, 'base64')),
            base,
            name: req.body?.name,
            slot: req.body?.slot,
          });
        }
        const d = await driver();
        if (!d.capabilities.presetConvert) return unsupported(reply, 'presetConvert');
        return await convert.exportConvertedSyx({ targetDevice, driver: d, base, name: req.body?.name, slot: req.body?.slot });
      } catch (e) {
        const err = e as { statusCode?: number; message?: string };
        reply.code(err.statusCode ?? 503);
        return { error: err.message ?? 'export failed' };
      }
    },
  );

  // ── DEPRECATED /am4/* aliases (Phase 6 route folding) ─────────────────────────────────────────
  // Each is the SAME unified handler with a param/body shim: `pidLow`→addr, `pidHigh`→paramId,
  // `norm`→{value, continuous:true}, `value`→{value, continuous:false}, `location`→number. They
  // answer with the unified response shape, send Deprecation/Sunset headers, and count into /diag.
  app.get('/am4/grid', async (req, reply) => { deprecated(req, reply); return h.gridH(reply); });
  app.get('/am4/slots', async (req, reply) => { deprecated(req, reply); return h.blocksH(reply); });
  app.get<{ Params: { n: string } }>('/am4/presets/:n/name', async (req, reply) => { deprecated(req, reply); return h.presetNameH(Number(req.params.n)); });
  app.get<{ Params: { pidLow: string } }>('/am4/blocks/:pidLow/params', async (req, reply) => { deprecated(req, reply); return h.blockParamsH(reply, Number(req.params.pidLow)); });
  app.put<{ Params: { pidLow: string; pidHigh: string }; Body: { norm?: number; value?: number } }>('/am4/blocks/:pidLow/params/:pidHigh', async (req, reply) => {
    deprecated(req, reply);
    const pl = Number(req.params.pidLow), ph = Number(req.params.pidHigh);
    if (req.body?.norm != null) return h.setParamH(reply, pl, ph, req.body.norm, true);
    if (req.body?.value != null) return h.setParamH(reply, pl, ph, req.body.value, false);
    reply.code(400); return { error: 'norm or value required' };
  });
  app.get('/am4/presets', async (req, reply) => { deprecated(req, reply); return h.locationsH(reply); });
  app.put<{ Body: { key?: string; value?: number } }>('/am4/param', async (req, reply) => { deprecated(req, reply); return h.deviceParamH(reply, req.body?.key, req.body?.value); });
  app.post<{ Body: { pidLow: number; bypassed: boolean } }>('/am4/bypass', async (req, reply) => { deprecated(req, reply); return h.bypassH(reply, req.body.pidLow, req.body.bypassed); });
  app.post<{ Body: { index: number } }>('/am4/scene', async (req, reply) => { deprecated(req, reply); return h.sceneSetH(reply, req.body.index); });
  app.post<{ Body: { location: number } }>('/am4/preset', async (req, reply) => { deprecated(req, reply); return h.presetSelectH(reply, req.body.location); });
  app.post<{ Body: { location?: number } }>('/am4/preset/store', async (req, reply) => {
    deprecated(req, reply);
    if (req.body?.location == null) { reply.code(400); return { error: 'location (0..103) required' }; }
    return h.presetStoreH(reply, req.body.location);
  });
  app.post<{ Body: { location?: number } }>('/am4/preset/backup', async (req, reply) => { deprecated(req, reply); return h.backupH(reply, req.body?.location); });
  app.post<{ Body: { bytes?: number[] } }>('/am4/preset/restore', async (req, reply) => { deprecated(req, reply); return h.restoreH(reply, req.body?.bytes); });
  app.post<{ Body: { bytes?: number[] } }>('/am4/preset/decode', async (req, reply) => {
    deprecated(req, reply);
    const bytes = Array.isArray(req.body?.bytes) ? req.body.bytes : null;
    if (!bytes || !bytes.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    return h.decodeH(reply, Uint8Array.from(bytes));
  });
  app.get('/am4/mod/model', async (req, reply) => { deprecated(req, reply); return h.modModelH(); });
  app.post<{ Body: { bytes?: number[] } }>('/am4/firmware/validate', async (req, reply) => { deprecated(req, reply); return h.fwValidateH(reply, req.body?.bytes); });

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
    const unsub = registry.subscribe((_e, json) => raw.write(`data: ${json}\n\n`));
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
      let urlPath: string;
      try { urlPath = decodeURIComponent(req.url.split('?')[0] ?? '/'); }
      catch { return reply.code(400).send({ error: 'bad path' }); }
      // Resolve against the root and require the result to be the root itself or a true descendant
      // (separator-aware, so `/srv/app-evil` can't masquerade as inside `/srv/app`).
      const resolved = resolve(root, urlPath === '/' ? 'index.html' : urlPath);
      const withinRoot = resolved === root || resolved.startsWith(root + sep);
      const file = withinRoot && existsSync(resolved) && !statSync(resolved).isDirectory() ? resolved : join(root, 'index.html');
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

    // ── shared device-definition profiles (THIRD cache source; services/cloudProfiles.ts) ──
    app.get('/device/cache/cloud', async () => cloudProfiles.cloudCacheCheck(cloud, store.defaultStore, registry));
    app.post('/device/cache/cloud/pull', async (_req, reply) => { const r = await cloudProfiles.cloudCachePull(cloud, store.defaultStore, registry); reply.code(r.code); return r.body; });
    app.post('/device/cache/cloud/publish', async (_req, reply) => { const r = await cloudProfiles.cloudCachePublish(cloud, store.defaultStore, registry); reply.code(r.code); return r.body; });

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
    app.get('/device/cache/cloud', async () => ({ enabled: false, available: false })); // same non-erroring gate for the defs prompt
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
