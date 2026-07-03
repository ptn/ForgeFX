// Axis persistent store — the Node face of the backend-agnostic store logic (runtime/store.ts).
// Since the browser-runtime split all POLICY (sync envelopes, content addressing, dedup, retention)
// lives in runtime/store.ts's createStore(backend, codec); THIS module binds the default fs backend
// (byte-identical to the classic FORGEFX_DATA_DIR/~/.axis layout) and keeps the module-level function
// API delegating to it, so existing consumers keep their `import * as store` unchanged. See the
// storage architecture notes.
import type { StoreBackend, Doc, PresetVersion, Backup } from './runtime/storeBackend.js';
import { DATA_DIR, createFsStoreBackend, nodeCodec } from './runtime/fsStoreBackend.js';
import { createStore, type Store } from './runtime/store.js';

export type { StoreBackend, StoreCodec, Doc, PresetVersion, Backup } from './runtime/storeBackend.js';
export { DATA_DIR } from './runtime/fsStoreBackend.js';
export { createStore, type Store } from './runtime/store.js';

// ─────────────────────────── default instance (fs over FORGEFX_DATA_DIR) ───────────────────────────
/** The process-default backend — Node glue also routes sidecar records through it (local scan cache). */
export const defaultBackend: StoreBackend = createFsStoreBackend(DATA_DIR);
export const defaultStore: Store = createStore(defaultBackend, nodeCodec);

// Module-level API delegating to the default instance — consumers keep `import * as store` unchanged.
export function getDoc(collection: string, id: string): Doc | null { return defaultStore.getDoc(collection, id); }
export function listDocs(collection: string): Doc[] { return defaultStore.listDocs(collection); }
export function putDoc(collection: string, id: string, data: unknown): Doc { return defaultStore.putDoc(collection, id, data); }
export function delDoc(collection: string, id: string): void { defaultStore.delDoc(collection, id); }
export function putDocRaw(collection: string, id: string, data: unknown, updatedAt: number, rev: number, deleted = false): void { defaultStore.putDocRaw(collection, id, data, updatedAt, rev, deleted); }
export function docsChangedSince(collection: string, since: number): Doc[] { return defaultStore.docsChangedSince(collection, since); }
export function addPresetVersion(meta: Omit<PresetVersion, 'id' | 'hash' | 'capturedAt' | 'bytes' | 'stored'>, syx: Uint8Array): PresetVersion | null { return defaultStore.addPresetVersion(meta, syx); }
export function listPresetVersions(location?: number): PresetVersion[] { return defaultStore.listPresetVersions(location); }
export function getPresetVersion(id: string): PresetVersion | null { return defaultStore.getPresetVersion(id); }
export function getPresetVersionBytes(id: string): Uint8Array | null { return defaultStore.getPresetVersionBytes(id); }
export function getPresetVersionPacked(id: string): Uint8Array | null { return defaultStore.getPresetVersionPacked(id); }
export const hasPresetVersion = (id: string): boolean => defaultStore.hasPresetVersion(id);
export function addVersionRaw(v: PresetVersion, packed: Uint8Array): void { defaultStore.addVersionRaw(v, packed); }
export function importVersion(v: PresetVersion, syx: Uint8Array): void { defaultStore.importVersion(v, syx); }
export const listBackups = (): Backup[] => defaultStore.listBackups();
export function createBackup(label: string, model: string): Backup { return defaultStore.createBackup(label, model); }
export function setBackupCount(id: string, count: number): void { defaultStore.setBackupCount(id, count); }
