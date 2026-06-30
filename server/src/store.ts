// Axis persistent store — the single local backend for everything Axis saves: app config, library
// metadata, layouts, and versioned preset/device backups. Filesystem-backed (zero native deps → bundles
// in Electron/Docker/Pi unchanged) behind a small interface we can swap for SQLite later without callers
// caring. Every record carries a sync-ready envelope ({id, updatedAt, rev, deleted}) so the future
// Supabase sync is just a diff on `updatedAt`. Preset versions are immutable .syx snapshots → version
// control + restore. See the storage architecture notes.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'node:zlib';

// Preset .syx is 7-bit-padded SysEx → compresses ~3-4x. Brotli at rest (small local footprint) AND so the
// blob is already compressed when synced to the cloud (storage = money). Quality 9 ≈ near-max, fast enough
// for ~25 KB blobs. Restore/download decompresses back to a valid .syx.
const packSyx = (b: Uint8Array) => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } });
const unpackSyx = (b: Buffer) => new Uint8Array(brotliDecompressSync(b));

export const DATA_DIR = process.env.FORGEFX_DATA_DIR ?? join(homedir(), '.axis');
const STORE_DIR = join(DATA_DIR, 'store'); // documents: one JSON map per collection
const VERSIONS_DIR = join(DATA_DIR, 'versions'); // preset .syx snapshots + index
const ensure = (d: string) => mkdirSync(d, { recursive: true });
const readJSON = <T>(p: string, fb: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fb; } };
const writeJSON = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));

// ─────────────────────────── documents (config · metadata · layouts) ───────────────────────────
export interface Doc<T = unknown> { id: string; collection: string; data: T; updatedAt: number; rev: number; deleted?: boolean }
const collPath = (c: string) => join(STORE_DIR, `${c.replace(/[^\w.-]/g, '_')}.json`);
const loadColl = (c: string): Record<string, Doc> => readJSON(collPath(c), {});
const saveColl = (c: string, m: Record<string, Doc>) => { ensure(STORE_DIR); writeJSON(collPath(c), m); };

export function getDoc(collection: string, id: string): Doc | null { return loadColl(collection)[id] ?? null; }
export function listDocs(collection: string): Doc[] { return Object.values(loadColl(collection)).filter((d) => !d.deleted); }
export function putDoc(collection: string, id: string, data: unknown): Doc {
  const m = loadColl(collection);
  const doc: Doc = { id, collection, data, updatedAt: Date.now(), rev: (m[id]?.rev ?? 0) + 1 };
  m[id] = doc; saveColl(collection, m);
  return doc;
}
export function delDoc(collection: string, id: string): void {
  const m = loadColl(collection);
  if (m[id]) { m[id] = { ...m[id], deleted: true, updatedAt: Date.now(), rev: m[id]!.rev + 1 }; saveColl(collection, m); }
}
/** Apply a doc verbatim (keeping the given updatedAt/rev) — for sync PULLs, where bumping the envelope
 *  would make a just-pulled record look locally-newer and bounce back on the next push. */
export function putDocRaw(collection: string, id: string, data: unknown, updatedAt: number, rev: number, deleted = false): void {
  const m = loadColl(collection);
  m[id] = { id, collection, data, updatedAt, rev, deleted };
  saveColl(collection, m);
}
/** Records changed since `since` (for sync push). Includes tombstones. */
export function docsChangedSince(collection: string, since: number): Doc[] { return Object.values(loadColl(collection)).filter((d) => d.updatedAt > since); }

// ─────────────────────────── preset versions (version control) ───────────────────────────
export interface PresetVersion {
  id: string;
  location: number; // preset slot (-1 = edit buffer)
  crc: number; // content fingerprint
  name: string;
  model: string;
  capturedAt: number;
  source: 'manual' | 'auto' | 'backup';
  backupId?: string; // set when captured as part of a full-device backup
  bytes: number; // raw .syx size
  stored: number; // compressed (brotli) size on disk / synced
}
const vIndex = (): PresetVersion[] => readJSON(join(VERSIONS_DIR, 'index.json'), []);
const saveVIndex = (v: PresetVersion[]) => { ensure(VERSIONS_DIR); writeJSON(join(VERSIONS_DIR, 'index.json'), v); };
const blobPath = (v: PresetVersion) => join(VERSIONS_DIR, String(v.location), `${v.id}.syx.br`); // brotli

/** Snapshot a preset. Skips if the latest snapshot for this slot has the same CRC (no churn) — unless
 *  it's part of a full backup, where we always record the slot. */
export function addPresetVersion(meta: Omit<PresetVersion, 'id' | 'capturedAt' | 'bytes' | 'stored'>, syx: Uint8Array): PresetVersion | null {
  const all = vIndex();
  if (!meta.backupId) {
    const latest = all.filter((x) => x.location === meta.location).sort((a, b) => b.capturedAt - a.capturedAt)[0];
    if (latest && latest.crc === meta.crc) return latest; // unchanged → reuse
  }
  const id = `${meta.location}-${(meta.crc >>> 0).toString(16)}-${Date.now().toString(36)}`;
  const packed = packSyx(syx);
  const v: PresetVersion = { id, capturedAt: Date.now(), bytes: syx.length, stored: packed.length, ...meta };
  ensure(join(VERSIONS_DIR, String(meta.location)));
  writeFileSync(blobPath(v), packed);
  all.push(v); saveVIndex(all);
  return v;
}
export function listPresetVersions(location?: number): PresetVersion[] {
  const all = vIndex().filter((v) => location == null || v.location === location);
  return all.sort((a, b) => b.capturedAt - a.capturedAt);
}
export function getPresetVersion(id: string): PresetVersion | null {
  return vIndex().find((x) => x.id === id) ?? null;
}
export function getPresetVersionBytes(id: string): Uint8Array | null {
  const v = vIndex().find((x) => x.id === id);
  if (!v) return null;
  try { return unpackSyx(readFileSync(blobPath(v))); } catch { return null; }
}
/** Raw compressed (.syx.br) bytes for a version — for cloud upload (kept compressed in Storage). */
export function getPresetVersionPacked(id: string): Uint8Array | null {
  const v = vIndex().find((x) => x.id === id);
  if (!v) return null;
  try { return readFileSync(blobPath(v)); } catch { return null; }
}
export const hasPresetVersion = (id: string): boolean => vIndex().some((x) => x.id === id);
/** Write a version pulled from the cloud verbatim (id + compressed blob already known). Skips if present. */
export function addVersionRaw(v: PresetVersion, packed: Uint8Array): void {
  const all = vIndex();
  if (all.some((x) => x.id === v.id)) return;
  ensure(join(VERSIONS_DIR, String(v.location)));
  writeFileSync(blobPath(v), Buffer.from(packed));
  all.push(v);
  saveVIndex(all);
}

// ─────────────────────────── full-device backups ───────────────────────────
export interface Backup { id: string; createdAt: number; label: string; model: string; count: number }
const bkPath = () => join(DATA_DIR, 'backups.json');
export const listBackups = (): Backup[] => readJSON(bkPath(), []);
export function createBackup(label: string, model: string): Backup {
  const all = listBackups();
  const b: Backup = { id: `bk-${Date.now().toString(36)}`, createdAt: Date.now(), label, model, count: 0 };
  all.push(b); ensure(DATA_DIR); writeJSON(bkPath(), all);
  return b;
}
export function setBackupCount(id: string, count: number): void {
  const all = listBackups(); const b = all.find((x) => x.id === id);
  if (b) { b.count = count; writeJSON(bkPath(), all); }
}

void readdirSync; void existsSync; // reserved for upcoming list/prune helpers
