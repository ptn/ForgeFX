// Runtime request router — the browser-facing twin of the Fastify app (app.ts). Axis Browser Direct
// installs `handle()` as its transport: same paths, same JSON shapes, same status codes, same
// capability-gating (501 unsupported), because the NON-TRIVIAL handler bodies are the shared
// runtime/handlers.ts + runtime/localService.ts + services/backups.ts code both surfaces call — only
// thin request-shape glue lives here (mirrored 1:1 from app.ts; the parity suite
// test/api/router.test.ts proves status+body equality over a shared fake registry + store).
//
// Differences by design:
//   • no /events SSE — `subscribe()` replaces it (a browser runtime consumes DeviceEvents directly);
//     PUT /store/config/:id still fans the config event out via the shared putStoreDoc().
//   • no deprecated /am4/* aliases (v2 clients don't call them) → they 404 naturally.
//   • services absent from deps answer their server "disabled" shapes: no `local` → the
//     unconfigured-root responses; no `cloud` → the AXIS_CLOUD=off /cloud/status + /remote/status
//     stubs (the other /cloud/* routes don't exist then — 404, exactly like app.ts); no `telemetry`
//     → the unconfigured telemetryStatus shape and the 503 upload error.
// NO fastify/node:/transport imports here or in anything this pulls in — must bundle for the browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import type { DeviceEvent } from '../drivers/types.js';
import * as editorCacheImport from '../services/editorCacheImport.js';
import * as cloudProfiles from '../services/cloudProfiles.js';
import { blockHelpBySlug, helpIndex } from '../help.js';
import { createUnifiedHandlers } from './handlers.js';
import { createStoreHandlers } from './storeHandlers.js';
import { createRouteManifest } from '../http/routeManifest.js';
import { createLocalService } from './localService.js';
import type { FolderAdapter } from './folderAdapter.js';
import type { ScanCachePersistence } from './localFolder.js';
import type { Store } from './store.js';
import type { CloudService } from './cloud.js';

export interface RouterResponse {
  status: number;
  contentType: string;
  body: string | Uint8Array;
}

/** The /local/* bindings a runtime supplies (see runtime/localService.ts for each hook's contract).
 *  Node would pass createFsFolderAdapter + node:path checks; a browser passes its directory-handle
 *  adapter (root strings are opaque labels there) and a JS sha256. */
export interface RouterLocalDeps {
  adapterFor(root: string): FolderAdapter;
  isAbsolute(root: string): boolean;
  resolveRoot(root: string): string;
  scanCache: ScanCachePersistence;
  sha256Hex(bytes: Uint8Array): string;
}

/** Diagnostics upload surface (src/telemetry.ts shape). Absent → the "not configured" responses. */
export interface TelemetryService {
  status(): { enabled: boolean; faroUrl: string; key: string; uploadEnabled: boolean };
  report(body: Record<string, unknown>): Promise<{ path: string; bytes: number; stored: number }>;
}

export interface RuntimeDeps {
  registry: DeviceRegistry;
  store: Store;
  local?: RouterLocalDeps;
  cloud?: CloudService;
  telemetry?: TelemetryService;
}

// ── request plumbing ──
/** Per-request status recorder — the StatusSink the shared handlers code() into. */
class Reply {
  statusCode = 200;
  code(n: number): this { this.statusCode = n; return this; }
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body ({} for empty, like app.ts's tolerant parser). */
  body: unknown;
  /** Raw bytes for the octet-stream routes (body arrived as Uint8Array). */
  raw: Uint8Array | null;
  reply: Reply;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; segs: string[]; octet: boolean; handler: Handler }

const JSON_TYPE = 'application/json; charset=utf-8';
const OCTET_TYPE = 'application/octet-stream';

export function createRouter(deps: RuntimeDeps): {
  handle(method: string, path: string, body?: string | Uint8Array): Promise<RouterResponse>;
  subscribe(fn: (e: DeviceEvent) => void): () => void;
} {
  const { registry, store } = deps;
  const h = createUnifiedHandlers(registry);
  const sh = createStoreHandlers(store, registry);

  // /local/* — the shared route service over the runtime's folder bindings. Without `local` deps the
  // config/gate methods still answer, backed by a stub adapter whose root never exists — exactly the
  // server's unconfigured-root behavior (configured:false, 409 gates), and PUT with a path fails its
  // absolute-root check.
  const local = createLocalService({
    adapterFor: deps.local?.adapterFor ?? (() => UNAVAILABLE_ADAPTER),
    isAbsolute: deps.local?.isAbsolute ?? (() => false),
    resolveRoot: deps.local?.resolveRoot ?? ((r) => r),
    scanCache: deps.local?.scanCache ?? { load: () => ({}), save: () => {} },
    sha256Hex: deps.local?.sha256Hex ?? (() => ''),
    store,
    decode: h.decodeBytes
  });

  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler, opts?: { octet?: boolean }) =>
    routes.push({ method, segs: path.split('/').filter(Boolean), octet: !!opts?.octet, handler });

  // ── shared routes — single source: src/http/routeManifest.ts (C1) ──
  for (const r of createRouteManifest(h, sh)) {
    on(r.method, r.path, (c) => r.handler(c), { octet: r.octet });
  }

  // ── system (surface-specific) ──
  // full connection diagnostic; the router has no deprecated aliases, so the hit counters stay empty
  on('GET', '/diag', () => h.diagH({}));

  // ── editor-cache import (SECOND cache source; capability cacheImport). Disk discovery is Node-only,
  //    so the browser twin returns an empty candidate list (discovery:'unavailable') + octet-only import. ──
  on('GET', '/device/cache/sources', async () => {
    const persisted = await editorCacheImport.isPersisted(store, registry);
    return { persisted, candidates: [], discovery: 'unavailable' };
  });
  on('POST', '/device/cache/import', async (c) => {
    if (!c.raw || !c.raw.length) { c.reply.code(400); return { error: 'POST the .cache bytes as application/octet-stream with ?name=<filename>' }; }
    const name = c.query.get('name');
    if (!name) { c.reply.code(400); return { error: 'missing ?name=<filename>' }; }
    const force = c.query.get('force') === '1' || c.query.get('force') === 'true';
    const r = await editorCacheImport.importEditorCache(registry, store, c.raw, { name, force });
    c.reply.code(r.code);
    return r.body;
  }, { octet: true });
  // ── shared device-definition profiles (THIRD cache source; services/cloudProfiles.ts). deps.cloud is
  //    optional — absent (no cloud in this runtime) degrades to the same non-erroring disabled shape. ──
  on('GET', '/device/cache/cloud', () => cloudProfiles.cloudCacheCheck(deps.cloud ?? null, store, registry));
  on('POST', '/device/cache/cloud/pull', async (c) => {
    const r = await cloudProfiles.cloudCachePull(deps.cloud ?? null, store, registry);
    c.reply.code(r.code);
    return r.body;
  });
  on('POST', '/device/cache/cloud/publish', async (c) => {
    const r = await cloudProfiles.cloudCachePublish(deps.cloud ?? null, store, registry);
    c.reply.code(r.code);
    return r.body;
  });

  // ── block & parameter help (curated tooltips; see help.ts) ──
  on('GET', '/help', () => helpIndex(registry.profile));
  on('GET', '/help/blocks/:slug', (c) => {
    const dto = blockHelpBySlug(registry.profile, c.params.slug!);
    if (!dto) { c.reply.code(404); return { error: `no help for block "${c.params.slug}"` }; }
    return dto;
  });

  // ── local storage folder (Presets/ library + Sync/ mirror; shared service — see localService.ts) ──
  on('GET', '/local/config', async (c) => send(c, await local.config()));
  on('PUT', '/local/config', async (c) => send(c, await local.setConfig((c.body as { root?: string | null } | undefined)?.root)));
  on('GET', '/local/presets', async (c) => send(c, await local.presets(c.query.get('refresh') === '1')));
  on('GET', '/local/presets/file', async (c) => send(c, await local.presetFile(c.query.get('path') ?? undefined)));
  on('POST', '/local/presets', async (c) => send(c, await local.writePreset(c.body as Parameters<typeof local.writePreset>[0])));
  on('POST', '/local/sync', async (c) => send(c, await local.sync()));
  on('POST', '/local/restore', async (c) => send(c, await local.restore()));

  // ── cloud sync + remote + telemetry ── absent services answer the server's "disabled" stubs; the
  // gated /cloud/* routes only exist when a cloud service is supplied (parity with AXIS_CLOUD=1).
  if (deps.cloud) {
    const cloud = deps.cloud;
    type Creds = { email: string; password: string };
    on('GET', '/cloud/status', () => cloud.status());
    on('POST', '/cloud/register', async (c) => { const b = c.body as Creds; try { return await cloud.register(b.email, b.password); } catch (e) { c.reply.code(400); return { error: (e as Error).message }; } });
    on('POST', '/cloud/login', async (c) => { const b = c.body as Creds; try { return await cloud.login(b.email, b.password); } catch (e) { c.reply.code(401); return { error: (e as Error).message }; } });
    on('POST', '/cloud/logout', () => cloud.logout());
    on('POST', '/cloud/delete-account', async (c) => { try { return await cloud.deleteAccount(); } catch (e) { c.reply.code(500); return { error: (e as Error).message }; } });
    on('POST', '/cloud/sync', async (c) => { try { return await cloud.sync((c.body as { scopes?: { config?: boolean; presets?: boolean } } | undefined)?.scopes); } catch (e) { c.reply.code(503); return { error: (e as Error).message }; } });
    on('GET', '/cloud/index', async (c) => { try { return await cloud.cloudIndex(); } catch (e) { c.reply.code(503); return { error: (e as Error).message }; } });
    // The Realtime remote HOST agent is a Node/Fastify concern (remote.ts) — a browser runtime IS the
    // UI, so it never hosts. Status mirrors the host's "off" answer; enabling is not available.
    on('GET', '/remote/status', () => ({ enabled: false, connected: false, userId: null }));
    on('POST', '/remote/enable', (c) => { c.reply.code(503); return { error: 'remote host not available in this runtime' }; });
  } else {
    on('GET', '/cloud/status', () => ({ enabled: false, user: null })); // so Axis can gate its UI without erroring
    on('GET', '/remote/status', () => ({ enabled: false, connected: false, userId: null }));
  }

  // status is always served (so Axis gates its UI without erroring); the report upload works whenever
  // a telemetry service is supplied — absent, it fails with the server's "not configured" 503.
  on('GET', '/telemetry/status', () => deps.telemetry?.status() ?? { enabled: false, faroUrl: '', key: '', uploadEnabled: false });
  on('POST', '/telemetry/report', async (c) => {
    try {
      if (!deps.telemetry) throw new Error('cloud storage not configured (SUPABASE_URL / SUPABASE_ANON_KEY unset)');
      return await deps.telemetry.report((c.body ?? {}) as Record<string, unknown>);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });

  // ── dispatch ──
  const match = (route: Route, segs: string[]): Record<string, string> | null => {
    if (route.segs.length !== segs.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < segs.length; i++) {
      const pat = route.segs[i]!;
      if (pat.startsWith(':')) params[pat.slice(1)] = decodeURIComponent(segs[i]!);
      else if (pat !== segs[i]) return null;
    }
    return params;
  };

  const respond = (status: number, body: unknown): RouterResponse =>
    body instanceof Uint8Array
      ? { status, contentType: OCTET_TYPE, body }
      : { status, contentType: JSON_TYPE, body: JSON.stringify(body) };

  const handle = async (method: string, path: string, body?: string | Uint8Array): Promise<RouterResponse> => {
    const m = method.toUpperCase();
    const qi = path.indexOf('?');
    const pathname = qi >= 0 ? path.slice(0, qi) : path;
    const query = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
    const segs = pathname.split('/').filter(Boolean);

    for (const route of routes) {
      if (route.method !== m) continue;
      const params = match(route, segs);
      if (!params) continue;

      // Body decode mirrors app.ts's parsers: Uint8Array = application/octet-stream on the raw-bytes
      // routes; everything else is JSON (empty/absent → {}, like the tolerant empty-JSON parser).
      let raw: Uint8Array | null = null;
      let json: unknown = {};
      if (body instanceof Uint8Array && route.octet) raw = body;
      else if (body != null) {
        const s = typeof body === 'string' ? body : new TextDecoder().decode(body);
        if (s.length) {
          try { json = JSON.parse(s); }
          catch { return respond(400, { statusCode: 400, error: 'Bad Request', message: 'Body is not valid JSON' }); }
        }
      }

      const ctx: Ctx = { params, query, body: json, raw, reply: new Reply() };
      try {
        const out = await route.handler(ctx);
        return respond(ctx.reply.statusCode, out);
      } catch (e) {
        // Uncaught handler error → mirror Fastify's default error envelope, honouring a driver-set
        // statusCode (e.g. placeCell's out-of-range instance is a 400, not a 500).
        const err = e as Error & { statusCode?: number };
        const code = err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
        if (code === 500) return respond(500, { statusCode: 500, error: 'Internal Server Error', message: err?.message });
        const text: Record<number, string> = { 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 503: 'Service Unavailable' };
        return respond(code, { statusCode: code, error: text[code] ?? 'Error', message: err?.message });
      }
    }
    // Fastify's default not-found body, verbatim
    return respond(404, { message: `Route ${m}:${pathname} not found`, error: 'Not Found', statusCode: 404 });
  };

  return { handle, subscribe: (fn) => registry.subscribe(fn) };
}

/** Local-folder responses map onto the reply exactly like localStore.ts's `send` (bytes stay bytes). */
function send(c: Ctx, r: { code: number; body: unknown }): unknown {
  c.reply.code(r.code);
  return r.body;
}

/** Stub adapter behind the no-`local`-deps case: nothing exists, nothing is writable — every gated
 *  route answers exactly like the server with no root configured. */
const UNAVAILABLE_ADAPTER: FolderAdapter = {
  key: (rel) => rel,
  list: async () => { throw new Error('local folder unavailable'); },
  exists: async () => false,
  readFile: async () => { throw new Error('local folder unavailable'); },
  writeFile: async () => { throw new Error('local folder unavailable'); },
  mkdir: async () => { throw new Error('local folder unavailable'); },
  remove: async () => { throw new Error('local folder unavailable'); }
};
