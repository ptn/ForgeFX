// Shared store/cache/backup route handlers — the second C1 extraction. These bodies were duplicated
// between app.ts (Node, store.defaultStore) and runtime/router.ts (browser, deps.store) and differ
// ONLY in the Store instance, so they take it as a factory arg. Browser-safe: every service import
// below is browser-safe, and `Store` is type-only (check-browser-safe.ts enforces it).
import * as backups from '../services/backups.js';
import * as deviceCache from '../services/deviceCache.js';
import type { DeviceRegistry } from '../drivers/registryCore.js';
import { putStoreDoc } from './services.js';
import type { Store } from './store.js';
import type { StatusSink } from './handlers.js';

export function createStoreHandlers(store: Store, registry: DeviceRegistry) {
  const driver = () => registry.driver();

  // ── device cache (on-connect self-describe build; capability selfDescribe) ──
  const cacheStatusH = () => deviceCache.cacheStatus(store, registry);
  const cacheBuildH = async (reply: StatusSink, force?: boolean, mode?: 'read-only' | 'full') => {
    const r = await deviceCache.startCacheBuild(store, registry, { force, mode });
    reply.code(r.code);
    return r.body;
  };
  const cacheCancelH = () => deviceCache.cancelCacheBuild(registry);
  const cacheDeleteH = () => deviceCache.deleteCache(store, registry);

  // ── persistent store: documents (Axis config · library metadata · layouts) ──
  const storeDocsH = (collection: string) => ({ docs: store.listDocs(collection) });
  const storeDocH = (reply: StatusSink, collection: string, id: string) => {
    const d = store.getDoc(collection, id);
    if (!d) { reply.code(404); return { error: 'not found' }; }
    return d;
  };
  const storeDelH = (collection: string, id: string) => { store.delDoc(collection, id); return { ok: true }; };
  /** Config writes fan out to every live UI (host SSE + router subscribers) — shared putStoreDoc. */
  const storePutH = (collection: string, id: string, data: unknown, origin?: string) =>
    putStoreDoc(store, registry, collection, id, data, origin);

  // ── backups + version control ──
  const backupsH = () => ({ backups: store.listBackups() });
  const backupPresetH = async (reply: StatusSink, n: number) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) { reply.code(501); return { error: 'unsupported', capability: 'presetDump' }; }
      const v = await backups.backupPreset(store, d, n);
      return v ? { version: v } : (reply.code(422), { error: 'empty/invalid preset' });
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const backupDeviceH = async (reply: StatusSink, label?: string, from?: number, to?: number) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) { reply.code(501); return { error: 'unsupported', capability: 'presetDump' }; }
      return await backups.backupDevice(store, d, label ?? 'Device backup', from ?? 0, to ?? 511);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const versionLoadH = async (reply: StatusSink, id: string) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes) { reply.code(501); return { error: 'unsupported', capability: 'loadPresetBytes' }; }
      return await backups.loadVersion(store, d, id);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const versionRestoreH = async (reply: StatusSink, id: string) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes || !d.store) { reply.code(501); return { error: 'unsupported', capability: 'loadPresetBytes' }; }
      return await backups.restoreVersion(store, d, id);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const versionsH = (location?: number) => ({ versions: store.listPresetVersions(location) });
  const versionSyxH = (reply: StatusSink, id: string) => {
    const bytes = store.getPresetVersionBytes(id);
    if (!bytes) { reply.code(404); return { error: 'not found' }; }
    return bytes;
  };

  return {
    cacheStatusH, cacheBuildH, cacheCancelH, cacheDeleteH,
    storeDocsH, storeDocH, storePutH, storeDelH,
    backupsH, backupPresetH, backupDeviceH, versionLoadH, versionRestoreH, versionsH, versionSyxH
  };
}
