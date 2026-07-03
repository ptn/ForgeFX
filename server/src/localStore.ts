// Local storage folder — Fastify glue over the SHARED route service in runtime/localService.ts
// (which composes the pure folder logic in runtime/localFolder.ts). All the Node-only concerns are
// bound HERE: the per-root fs adapter, absolute-root validation (node:path), the scan-cache sidecar
// (DATA_DIR/localScan.json via the default store backend) and the sha256 codec. The runtime router
// binds the same service to browser-supplied deps, so both surfaces serve identical statuses/shapes.
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as store from './store.js';
import { createFsFolderAdapter } from './runtime/fsFolderAdapter.js';
import { nodeCodec } from './runtime/fsStoreBackend.js';
import { createLocalService, type LocalResult } from './runtime/localService.js';
import type { DecodeFn, ScanCache, ScanCachePersistence } from './runtime/localFolder.js';

export type { DecodeFn, LocalPresetEntry } from './runtime/localFolder.js';

/** Decode-summary cache persistence — the classic DATA_DIR/localScan.json, atomic + pretty. */
const scanCache: ScanCachePersistence = {
  load: () => store.defaultBackend.getJSON<ScanCache>('localScan', {}),
  save: (c) => store.defaultBackend.putJSON('localScan', c, { atomic: true, pretty: true })
};

// ─────────────────────────── routes ───────────────────────────
export function registerLocalRoutes(app: FastifyInstance, decode: DecodeFn): void {
  const svc = createLocalService({
    adapterFor: (root) => createFsFolderAdapter(root),
    isAbsolute,
    resolveRoot: (root) => resolve(root),
    scanCache,
    sha256Hex: nodeCodec.sha256Hex,
    store: store.defaultStore,
    decode
  });

  /** Map a service result onto the Fastify reply (raw bytes → application/octet-stream Buffer). */
  const send = (reply: { code(n: number): unknown; header(k: string, v: string): unknown }, r: LocalResult): unknown => {
    reply.code(r.status);
    if (r.body instanceof Uint8Array) {
      void reply.header('content-type', 'application/octet-stream');
      return Buffer.from(r.body);
    }
    return r.body;
  };

  app.get('/local/config', async (_req, reply) => send(reply, await svc.config()));
  app.put<{ Body: { root?: string | null } }>('/local/config', async (req, reply) => send(reply, await svc.setConfig(req.body?.root)));
  app.get<{ Querystring: { refresh?: string } }>('/local/presets', async (req, reply) => send(reply, await svc.presets(req.query.refresh === '1')));
  app.get<{ Querystring: { path?: string } }>('/local/presets/file', async (req, reply) => send(reply, await svc.presetFile(req.query.path)));
  app.post<{ Body: { name?: string; dir?: string; path?: string; bytes?: number[]; overwrite?: boolean } }>('/local/presets', async (req, reply) => send(reply, await svc.writePreset(req.body)));
  app.post('/local/sync', async (_req, reply) => send(reply, await svc.sync()));
  app.post('/local/restore', async (_req, reply) => send(reply, await svc.restore()));
}
