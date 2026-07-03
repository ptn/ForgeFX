// Axis persistent store — the BACKEND-AGNOSTIC logic layer for everything Axis saves: app config,
// library metadata, layouts, and versioned preset/device backups. Every persistence primitive goes
// through a StoreBackend and every byte transform (brotli, sha256) through a StoreCodec
// (storeBackend.ts), so the same store runs over fs (Node — fsStoreBackend, byte-identical to the
// classic FORGEFX_DATA_DIR/~/.axis layout) or IndexedDB (browser, later) without callers caring.
// Every record carries a sync-ready envelope ({id, updatedAt, rev, deleted}) so the Supabase sync is
// just a diff on `updatedAt`. Preset versions are immutable .syx snapshots → version control +
// restore. The Node default instance + module-level function API live in src/store.ts (kept there so
// existing consumers keep their imports); this module must stay loadable in a browser — NO node:
// imports in here or anything it pulls in.
import type { StoreBackend, StoreCodec, Doc, PresetVersion, Backup } from './storeBackend.js';

/** Keep at most this many distinct versions per slot; older ones are pruned (and their blobs GC'd if
 *  unreferenced). Dedup means most slots stay well under this; the cap bounds a heavily-edited preset. */
const RETENTION_PER_SLOT = 30;

/** The full store API — one instance per backend (createStore). */
export interface Store {
  // documents (config · metadata · layouts)
  getDoc(collection: string, id: string): Doc | null;
  listDocs(collection: string): Doc[];
  putDoc(collection: string, id: string, data: unknown): Doc;
  delDoc(collection: string, id: string): void;
  putDocRaw(collection: string, id: string, data: unknown, updatedAt: number, rev: number, deleted?: boolean): void;
  docsChangedSince(collection: string, since: number): Doc[];
  // preset versions (version control)
  addPresetVersion(meta: Omit<PresetVersion, 'id' | 'hash' | 'capturedAt' | 'bytes' | 'stored'>, syx: Uint8Array): PresetVersion | null;
  listPresetVersions(location?: number): PresetVersion[];
  getPresetVersion(id: string): PresetVersion | null;
  getPresetVersionBytes(id: string): Uint8Array | null;
  getPresetVersionPacked(id: string): Uint8Array | null;
  hasPresetVersion(id: string): boolean;
  addVersionRaw(v: PresetVersion, packed: Uint8Array): void;
  importVersion(v: PresetVersion, syx: Uint8Array): void;
  // full-device backups
  listBackups(): Backup[];
  createBackup(label: string, model: string): Backup;
  setBackupCount(id: string, count: number): void;
}

export function createStore(backend: StoreBackend, codec: StoreCodec): Store {
  // ─────────────────────────── documents (config · metadata · layouts) ───────────────────────────
  const getDoc = (collection: string, id: string): Doc | null => backend.getDoc(collection, id);
  const listDocs = (collection: string): Doc[] => backend.listDocs(collection).filter((d) => !d.deleted);
  const putDoc = (collection: string, id: string, data: unknown): Doc => {
    const doc: Doc = { id, collection, data, updatedAt: Date.now(), rev: (backend.getDoc(collection, id)?.rev ?? 0) + 1 };
    backend.putDoc(doc);
    return doc;
  };
  const delDoc = (collection: string, id: string): void => {
    const d = backend.getDoc(collection, id);
    if (d) backend.putDoc({ ...d, deleted: true, updatedAt: Date.now(), rev: d.rev + 1 });
  };
  /** Apply a doc verbatim (keeping the given updatedAt/rev) — for sync PULLs, where bumping the envelope
   *  would make a just-pulled record look locally-newer and bounce back on the next push. */
  const putDocRaw = (collection: string, id: string, data: unknown, updatedAt: number, rev: number, deleted = false): void => {
    backend.putDoc({ id, collection, data, updatedAt, rev, deleted });
  };
  /** Records changed since `since` (for sync push). Includes tombstones. */
  const docsChangedSince = (collection: string, since: number): Doc[] => backend.listDocs(collection).filter((d) => d.updatedAt > since);

  // ─────────────────────────── preset versions (version control) ───────────────────────────
  /** Prune `location`'s versions beyond the retention cap (newest kept) and delete any blob no other
   *  surviving version references. `all` is the full index including the just-added version. */
  const pruneLocation = (all: PresetVersion[], location: number): void => {
    const forLoc = all.filter((v) => v.location === location).sort((a, b) => b.capturedAt - a.capturedAt);
    if (forLoc.length <= RETENTION_PER_SLOT) return;
    const dropIds = new Set(forLoc.slice(RETENTION_PER_SLOT).map((v) => v.id));
    const liveHashes = new Set(all.filter((v) => !dropIds.has(v.id)).map((v) => v.hash));
    backend.deleteVersions([...dropIds]);
    for (const v of all) if (dropIds.has(v.id) && !liveHashes.has(v.hash)) backend.deleteBlob(v.hash);
  };

  /** Snapshot a preset. Dedup by content: if the slot's newest version has identical content (same hash),
   *  reuse it — no new record, no new blob. Applies to full backups too, so backing up an unchanged device
   *  costs ~nothing. The blob is written once per unique content (content-addressed). */
  const addPresetVersion = (meta: Omit<PresetVersion, 'id' | 'hash' | 'capturedAt' | 'bytes' | 'stored'>, syx: Uint8Array): PresetVersion | null => {
    const hash = codec.sha256Hex(syx);
    const all = backend.listVersions();
    const latest = all.filter((x) => x.location === meta.location).sort((a, b) => b.capturedAt - a.capturedAt)[0];
    if (latest && latest.hash === hash) return latest; // identical content → reuse
    const packed = codec.pack(syx);
    const id = `${meta.location}-${(meta.crc >>> 0).toString(16)}-${Date.now().toString(36)}`;
    const v: PresetVersion = { id, hash, capturedAt: Date.now(), bytes: syx.length, stored: packed.length, ...meta };
    if (!backend.hasBlob(hash)) backend.putBlob(hash, packed); // store unique content once
    backend.putVersion(v);
    pruneLocation([...all, v], meta.location);
    return v;
  };
  const listPresetVersions = (location?: number): PresetVersion[] => {
    const all = backend.listVersions().filter((v) => location == null || v.location === location);
    return all.sort((a, b) => b.capturedAt - a.capturedAt);
  };
  const getPresetVersion = (id: string): PresetVersion | null => backend.listVersions().find((x) => x.id === id) ?? null;
  const getPresetVersionBytes = (id: string): Uint8Array | null => {
    const v = backend.listVersions().find((x) => x.id === id);
    if (!v) return null;
    const packed = backend.getBlob(v.hash);
    if (!packed) return null;
    try { return codec.unpack(packed); } catch { return null; }
  };
  /** Raw compressed (.syx.br) bytes for a version — for cloud upload (kept compressed in Storage). */
  const getPresetVersionPacked = (id: string): Uint8Array | null => {
    const v = backend.listVersions().find((x) => x.id === id);
    return v ? backend.getBlob(v.hash) : null;
  };
  const hasPresetVersion = (id: string): boolean => backend.listVersions().some((x) => x.id === id);
  /** Write a version pulled from the cloud (compressed blob already known; hash carried on the record).
   *  Content-addressed: the blob is written once per unique hash. Skips if this version id is already local. */
  const addVersionRaw = (v: PresetVersion, packed: Uint8Array): void => {
    if (hasPresetVersion(v.id)) return;
    if (!backend.hasBlob(v.hash)) backend.putBlob(v.hash, packed);
    backend.putVersion(v);
  };
  /** Import a version with raw .syx in hand (local Sync-folder restore). Content-addressed like
   *  addVersionRaw; re-packs the bytes (blob may not exist locally) and keeps the record's identity
   *  (id/capturedAt/hash) verbatim so re-sync recognizes it. Skips if the version id is already local. */
  const importVersion = (v: PresetVersion, syx: Uint8Array): void => {
    if (hasPresetVersion(v.id)) return;
    const packed = codec.pack(syx);
    if (!backend.hasBlob(v.hash)) backend.putBlob(v.hash, packed);
    backend.putVersion({ ...v, bytes: syx.length, stored: packed.length });
  };

  // ─────────────────────────── full-device backups ───────────────────────────
  const listBackups = (): Backup[] => backend.getJSON<Backup[]>('backups', []);
  const createBackup = (label: string, model: string): Backup => {
    const all = listBackups();
    const b: Backup = { id: `bk-${Date.now().toString(36)}`, createdAt: Date.now(), label, model, count: 0 };
    all.push(b);
    backend.putJSON('backups', all);
    return b;
  };
  const setBackupCount = (id: string, count: number): void => {
    const all = listBackups();
    const b = all.find((x) => x.id === id);
    if (b) { b.count = count; backend.putJSON('backups', all); }
  };

  return {
    getDoc, listDocs, putDoc, delDoc, putDocRaw, docsChangedSince,
    addPresetVersion, listPresetVersions, getPresetVersion, getPresetVersionBytes, getPresetVersionPacked,
    hasPresetVersion, addVersionRaw, importVersion,
    listBackups, createBackup, setBackupCount
  };
}
