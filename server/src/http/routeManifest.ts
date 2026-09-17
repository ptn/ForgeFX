// C1 route manifest — the SINGLE source of truth for the shared HTTP routes (method, path, octet
// flag, handler). app.ts (Fastify adapter) and runtime/router.ts (browser adapter) both register
// every entry here and adapt their native request into a RouteCtx; surface-specific routes (the
// deprecated /am4/* aliases, SSE, static UI, local-folder, cloud/remote, help, firmware/color/block
// file IO) stay in their own adapters because their bodies genuinely differ.
//
// Browser-safe: handlers are type-only here and the manifests' handler bodies are thunks.
import type { createUnifiedHandlers } from '../runtime/handlers.js';
import type { createStoreHandlers } from '../runtime/storeHandlers.js';

/** The one reply capability route handlers need (matches handlers.ts's StatusSink). */
export interface ReplySink { code(statusCode: number): unknown }

/** Surface-neutral request view — app.ts builds one from FastifyRequest, router.ts from its Ctx. */
export interface RouteCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body ({} for empty/absent, like Fastify's tolerant parser). */
  body: unknown;
  /** Raw bytes for an octet route (null when the request carried JSON / no raw flag). */
  raw: Uint8Array | null;
  reply: ReplySink;
}

export type RouteHandler = (c: RouteCtx) => unknown | Promise<unknown>;

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Fastify-style path: literal segments + `:name` params. */
  path: string;
  /** Raw application/octet-stream body accepted on POST. */
  octet?: boolean;
  handler: RouteHandler;
}

type Handlers = ReturnType<typeof createUnifiedHandlers>;
type StoreHandlers = ReturnType<typeof createStoreHandlers>;

const num = (v: string | undefined): number => Number(v);

export function createRouteManifest(h: Handlers, sh: StoreHandlers): RouteDef[] {
  const routes: RouteDef[] = [];

  // ── system / connection ──
  routes.push(
    { method: 'GET', path: '/healthz', handler: () => h.healthH() },
    { method: 'GET', path: '/device', handler: () => h.deviceInfoH() },
    { method: 'GET', path: '/ports', handler: () => h.connectionsH() },
    { method: 'POST', path: '/ports/select', handler: (c) => h.portsSelectH(c.body as Record<string, never>) },
    { method: 'GET', path: '/device/detect', handler: () => h.detectH() },
  );

  // ── device cache (build/status/cancel/delete; sources+import stay surface-specific) ──
  routes.push(
    { method: 'GET', path: '/device/cache', handler: () => sh.cacheStatusH() },
    {
      method: 'POST',
      path: '/device/cache/build',
      handler: (c) => {
        const b = c.body as { force?: boolean; mode?: 'read-only' | 'full' } | undefined;
        return sh.cacheBuildH(c.reply, b?.force, b?.mode);
      },
    },
    { method: 'POST', path: '/device/cache/cancel', handler: () => sh.cacheCancelH() },
    { method: 'DELETE', path: '/device/cache', handler: () => sh.cacheDeleteH() },
  );

  // ── preset reads ──
  routes.push(
    { method: 'GET', path: '/preset', handler: (c) => h.presetH(c.reply) },
    { method: 'GET', path: '/presets/:n', handler: (c) => h.presetNameH(num(c.params.n)) },
    { method: 'GET', path: '/presets/:n/summary', handler: (c) => h.presetSummaryH(c.reply, num(c.params.n), c.query.get('full') === '1') },
    { method: 'GET', path: '/presets/:n/params', handler: (c) => h.presetParamsH(c.reply, num(c.params.n)) },
    { method: 'GET', path: '/preset/body', handler: (c) => h.presetBodyH(c.reply) },
    { method: 'POST', path: '/preset/name', handler: (c) => h.setPresetNameH(c.reply, (c.body as { name: string }).name) },
    { method: 'POST', path: '/preset/load', octet: true, handler: (c) => h.presetLoadH(c.reply, c.raw) },
    { method: 'GET', path: '/preset/blank/syx', handler: (c) => h.presetBlankH(c.reply) },
    { method: 'GET', path: '/preset/locations', handler: (c) => h.locationsH(c.reply) },
    { method: 'POST', path: '/preset/select', handler: (c) => h.presetSelectH(c.reply, (c.body as { number: number }).number) },
    { method: 'POST', path: '/preset/store', handler: (c) => h.presetStoreH(c.reply, (c.body as { number?: number } | undefined)?.number) },
    { method: 'POST', path: '/preset/backup', handler: (c) => h.backupH(c.reply, (c.body as { location?: number } | undefined)?.location) },
    { method: 'POST', path: '/preset/restore', handler: (c) => h.restoreH(c.reply, (c.body as { bytes?: number[] } | undefined)?.bytes) },
    { method: 'POST', path: '/preset/decode', octet: true, handler: (c) => decodeRoute(h, c) },
  );

  // ── grid / placed blocks / params ──
  routes.push(
    { method: 'GET', path: '/preset/grid', handler: (c) => h.gridH(c.reply) },
    { method: 'GET', path: '/presets/:n/grid', handler: (c) => h.gridH(c.reply) },
    { method: 'GET', path: '/preset/blocks', handler: (c) => h.blocksH(c.reply) },
    { method: 'GET', path: '/preset/scene-state', handler: (c) => h.sceneStateH(c.reply) },
    { method: 'GET', path: '/preset/scene-names', handler: (c) => h.sceneNamesH(c.reply) },
    { method: 'GET', path: '/preset/blocks/:eid/params', handler: (c) => h.blockParamsH(c.reply, num(c.params.eid), c.query.get('observe') !== '0') },
    {
      method: 'PUT',
      path: '/preset/blocks/:eid/params/:paramId',
      handler: (c) => {
        const b = c.body as { value: number; continuous?: boolean };
        return h.setParamH(c.reply, num(c.params.eid), num(c.params.paramId), b.value, b.continuous ?? true);
      },
    },
    { method: 'POST', path: '/preset/blocks/:eid/apply', handler: (c) => h.applySavedBlockH(c.reply, num(c.params.eid), c.body) },
    { method: 'POST', path: '/preset/blocks/:eid/bypass', handler: (c) => h.bypassH(c.reply, num(c.params.eid), (c.body as { bypassed: boolean }).bypassed) },
    { method: 'POST', path: '/preset/blocks/:eid/channel', handler: (c) => h.setChannelH(c.reply, num(c.params.eid), (c.body as { channel: string }).channel) },
    { method: 'POST', path: '/preset/blocks/:eid/type', handler: (c) => h.setTypeH(c.reply, num(c.params.eid), (c.body as { value: number }).value) },
    { method: 'GET', path: '/preset/blocks/:eid/raw', handler: (c) => h.rawBlockH(c.reply, num(c.params.eid)) },
    { method: 'POST', path: '/preset/blocks/:eid/read', handler: (c) => h.readParamsH(c.reply, num(c.params.eid), (c.body as { pids?: number[] } | undefined)?.pids ?? []) },
    { method: 'POST', path: '/preset/blocks/:eid/readrange', handler: (c) => h.readRangeH(c.reply, num(c.params.eid), (c.body as { pids?: number[] } | undefined)?.pids ?? []) },
    { method: 'GET', path: '/preset/blocks/:eid/cab', handler: (c) => h.cabStateH(c.reply, num(c.params.eid)) },
    { method: 'POST', path: '/preset/meters', handler: (c) => h.metersH(c.reply, (c.body as { wants?: Record<string, number[]> } | undefined)?.wants ?? {}) },
  );

  // ── catalog ──
  routes.push(
    { method: 'GET', path: '/blocks', handler: (c) => h.blocksCatalogH(c.reply) },
    { method: 'GET', path: '/blocks/:slug/types', handler: (c) => h.blockTypesH(c.reply, c.params.slug!) },
  );

  // ── grid editing (1-indexed row/col, matching FM-Edit) ──
  routes.push(
    {
      method: 'PUT',
      path: '/preset/grid/cell',
      handler: (c) => {
        const b = c.body as { row: number; col: number; blockId: number };
        return h.placeCellH(c.reply, b.row, b.col, b.blockId);
      },
    },
    {
      method: 'POST',
      path: '/preset/grid/cable',
      handler: (c) => {
        const b = c.body as { srcRow: number; srcCol: number; destRow: number; connect?: boolean };
        return h.cableH(c.reply, b.srcRow, b.srcCol, b.destRow, b.connect ?? true);
      },
    },
    {
      method: 'POST',
      path: '/preset/grid/select',
      handler: (c) => {
        const b = c.body as { row: number; col: number };
        return h.selectCellH(c.reply, b.row, b.col);
      },
    },
  );

  // ── telemetry cadence control · tuner · tempo · scene ──
  routes.push(
    { method: 'GET', path: '/telemetry/config', handler: () => h.telemetryConfigH() },
    { method: 'PUT', path: '/telemetry/config', handler: (c) => h.telemetrySetH(c.reply, (c.body as { mode?: string } | undefined)?.mode) },
    { method: 'POST', path: '/tuner', handler: (c) => h.setTunerH(!!(c.body as { on?: boolean } | undefined)?.on) },
    { method: 'GET', path: '/tempo', handler: (c) => h.getTempoH(c.reply) },
    { method: 'POST', path: '/tempo', handler: (c) => h.setTempoH(c.reply, (c.body as { bpm: number }).bpm) },
    { method: 'POST', path: '/tempo/tap', handler: (c) => h.tapTempoH(c.reply) },
    { method: 'GET', path: '/scene', handler: (c) => h.getSceneH(c.reply) },
    { method: 'POST', path: '/scene', handler: (c) => h.sceneSetH(c.reply, (c.body as { index: number }).index) },
    { method: 'POST', path: '/scene/name', handler: (c) => { const b = c.body as { index: number; name: string }; return h.setSceneNameH(c.reply, b.index, b.name); } },
  );

  // ── FC / modifier / monitors / looper ──
  routes.push(
    { method: 'GET', path: '/fc/model', handler: () => h.fcModelH() },
    { method: 'GET', path: '/mod/model', handler: () => h.modModelH() },
    { method: 'POST', path: '/mod/bind', handler: (c) => { const b = c.body as { slot?: number; targetEffectId?: number; targetParam?: number; source?: number } | undefined; return h.bindModifierH(c.reply, b?.slot, b?.targetEffectId, b?.targetParam, b?.source); } },
    { method: 'GET', path: '/mod/slot', handler: (c) => h.resolveModifierSlotH(c.reply, num(c.query.get('targetEffectId') ?? undefined), num(c.query.get('targetParam') ?? undefined)) },
    { method: 'GET', path: '/preset/monitors', handler: () => h.monitorParamsH() },
    { method: 'GET', path: '/preset/monitors/live', handler: (c) => { const q = c.query.get('eid'); const eid = q != null && q !== '' ? Number(q) : undefined; return h.liveMonitorsH(c.reply, Number.isFinite(eid as number) ? eid : undefined); } },
    { method: 'GET', path: '/preset/looper', handler: (c) => { const q = c.query.get('eid'); return h.looperH(c.reply, q != null && q !== '' ? Number(q) : NaN); } },
    { method: 'POST', path: '/preset/looper/control', handler: (c) => { const b = (c.body ?? {}) as { eid?: number; action?: string; on?: boolean }; return h.looperControlH(c.reply, b.eid as number, b.action as string, b.on !== false); } },
    { method: 'GET', path: '/fc/state', handler: (c) => h.fcStateH(c.reply, num(c.query.get('layout') ?? undefined) || 0, num(c.query.get('view') ?? undefined) || 0, num(c.query.get('switch') ?? undefined) || 0) },
    { method: 'GET', path: '/cab/irs', handler: (c) => h.cabIrsH(c.query.get('refresh') === '1') },
  );

  // ── misc device ops ──
  routes.push(
    { method: 'POST', path: '/firmware/validate', handler: (c) => h.fwValidateH(c.reply, (c.body as { bytes?: number[] } | undefined)?.bytes) },
    { method: 'PUT', path: '/device/param', handler: (c) => { const b = c.body as { key?: string; value?: number } | undefined; return h.deviceParamH(c.reply, b?.key, b?.value); } },
  );

  // ── persistent store: documents ──
  routes.push(
    { method: 'GET', path: '/store/:c', handler: (c) => sh.storeDocsH(c.params.c!) },
    { method: 'GET', path: '/store/:c/:id', handler: (c) => sh.storeDocH(c.reply, c.params.c!, c.params.id!) },
    { method: 'PUT', path: '/store/:c/:id', handler: (c) => { const b = c.body as { data?: unknown; origin?: string } | undefined; return sh.storePutH(c.params.c!, c.params.id!, b?.data, b?.origin); } },
    { method: 'DELETE', path: '/store/:c/:id', handler: (c) => sh.storeDelH(c.params.c!, c.params.id!) },
  );

  // ── backups + version control ──
  routes.push(
    { method: 'POST', path: '/backup/preset/:n', handler: (c) => sh.backupPresetH(c.reply, num(c.params.n)) },
    { method: 'POST', path: '/backup/device', handler: (c) => { const b = c.body as { label?: string; from?: number; to?: number } | undefined; return sh.backupDeviceH(c.reply, b?.label, b?.from, b?.to); } },
    { method: 'GET', path: '/backups', handler: () => sh.backupsH() },
    { method: 'POST', path: '/version/:id/load', handler: (c) => sh.versionLoadH(c.reply, c.params.id!) },
    { method: 'POST', path: '/version/:id/restore', handler: (c) => sh.versionRestoreH(c.reply, c.params.id!) },
    { method: 'GET', path: '/versions', handler: (c) => { const loc = c.query.get('location'); return sh.versionsH(loc != null ? Number(loc) : undefined); } },
    { method: 'GET', path: '/version/:id/syx', handler: (c) => sh.versionSyxH(c.reply, c.params.id!) },
    { method: 'POST', path: '/preset/move', handler: (c) => { const b = c.body as { writes?: unknown; slotCount?: number; activeSlot?: number } | undefined; return sh.presetMoveH(c.reply, b); } },
  );

  return routes;
}

/** `/preset/decode` accepts raw octet bytes OR JSON `{bytes:number[]}` (pre-/post-Phase-6 shapes). */
function decodeRoute(h: Handlers, c: RouteCtx): unknown {
  if (c.raw) {
    if (!c.raw.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
    return h.decodeH(c.reply, c.raw);
  }
  const b = c.body as { bytes?: number[] } | undefined;
  const bytes = b && Array.isArray(b.bytes) ? b.bytes : null;
  if (!bytes || !bytes.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
  return h.decodeH(c.reply, Uint8Array.from(bytes));
}
