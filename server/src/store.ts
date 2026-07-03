// Axis persistent store — the single local backend for everything Axis saves: app config, library
// metadata, layouts, and versioned preset/device backups. Filesystem-backed (zero native deps → bundles
// in Electron/Docker/Pi unchanged) behind a small interface we can swap for SQLite later without callers
// caring. Every record carries a sync-ready envelope ({id, updatedAt, rev, deleted}) so the future
// Supabase sync is just a diff on `updatedAt`. Preset versions are immutable .syx snapshots → version
// control + restore. See the storage architecture notes.
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'node:zlib';

// Preset .syx is 7-bit-padded SysEx → compresses ~3-4x. Brotli at rest (small local footprint) AND so the
// blob is already compressed when synced to the cloud (storage = money). Quality 9 ≈ near-max, fast enough
// for ~25 KB blobs. Restore/download decompresses back to a valid .syx.
// Quality 11 (max) — ~8% smaller than q9 on preset dumps; slower to compress, but dedup means only
// changed presets are ever compressed, and decompress cost is identical. SIZE_HINT helps the encoder.
const packSyx = (b: Uint8Array) => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: b.length } });
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
  crc: number; // content fingerprint (device CRC16 — for sync-state comparison)
  hash: string; // sha256 of the raw .syx — the content-address key (identical presets share one blob)
  name: string;
  model: string;
  capturedAt: number;
  source: 'manual' | 'auto' | 'backup';
  backupId?: string; // set when captured as part of a full-device backup
  bytes: number; // raw .syx size
  stored: number; // compressed (brotli) size of the blob
}
/** Keep at most this many distinct versions per slot; older ones are pruned (and their blobs GC'd if
 *  unreferenced). Dedup means most slots stay well under this; the cap bounds a heavily-edited preset. */
const RETENTION_PER_SLOT = 30;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const vIndex = (): PresetVersion[] => readJSON(join(VERSIONS_DIR, 'index.json'), []);
const saveVIndex = (v: PresetVersion[]) => { ensure(VERSIONS_DIR); writeJSON(join(VERSIONS_DIR, 'index.json'), v); };
const BLOBS_DIR = join(VERSIONS_DIR, 'blobs');
/** Content-addressed blob path: identical preset content → identical hash → one stored blob, shared by
 *  every version (and every full-backup) that references it. This is what makes repeat backups ~free. */
const blobPathByHash = (hash: string) => join(BLOBS_DIR, `${hash}.syx.br`);

/** Prune `location`'s versions beyond the retention cap (newest kept) and delete any blob no other
 *  surviving version references. Mutates + returns the index array. */
function pruneLocation(all: PresetVersion[], location: number): PresetVersion[] {
  const forLoc = all.filter((v) => v.location === location).sort((a, b) => b.capturedAt - a.capturedAt);
  if (forLoc.length <= RETENTION_PER_SLOT) return all;
  const dropIds = new Set(forLoc.slice(RETENTION_PER_SLOT).map((v) => v.id));
  const kept = all.filter((v) => !dropIds.has(v.id));
  const liveHashes = new Set(kept.map((v) => v.hash));
  for (const v of all) if (dropIds.has(v.id) && !liveHashes.has(v.hash)) { try { unlinkSync(blobPathByHash(v.hash)); } catch { /* already gone */ } }
  return kept;
}

/** Snapshot a preset. Dedup by content: if the slot's newest version has identical content (same hash),
 *  reuse it — no new record, no new blob. Applies to full backups too, so backing up an unchanged device
 *  costs ~nothing. The blob is written once per unique content (content-addressed). */
export function addPresetVersion(meta: Omit<PresetVersion, 'id' | 'hash' | 'capturedAt' | 'bytes' | 'stored'>, syx: Uint8Array): PresetVersion | null {
  const hash = sha256(syx);
  let all = vIndex();
  const latest = all.filter((x) => x.location === meta.location).sort((a, b) => b.capturedAt - a.capturedAt)[0];
  if (latest && latest.hash === hash) return latest; // identical content → reuse
  const packed = packSyx(syx);
  const id = `${meta.location}-${(meta.crc >>> 0).toString(16)}-${Date.now().toString(36)}`;
  const v: PresetVersion = { id, hash, capturedAt: Date.now(), bytes: syx.length, stored: packed.length, ...meta };
  ensure(BLOBS_DIR);
  if (!existsSync(blobPathByHash(hash))) writeFileSync(blobPathByHash(hash), packed); // store unique content once
  all.push(v);
  all = pruneLocation(all, meta.location);
  saveVIndex(all);
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
  try { return unpackSyx(readFileSync(blobPathByHash(v.hash))); } catch { return null; }
}
/** Raw compressed (.syx.br) bytes for a version — for cloud upload (kept compressed in Storage). */
export function getPresetVersionPacked(id: string): Uint8Array | null {
  const v = vIndex().find((x) => x.id === id);
  if (!v) return null;
  try { return readFileSync(blobPathByHash(v.hash)); } catch { return null; }
}
export const hasPresetVersion = (id: string): boolean => vIndex().some((x) => x.id === id);
/** Write a version pulled from the cloud (compressed blob already known; hash carried on the record).
 *  Content-addressed: the blob is written once per unique hash. Skips if this version id is already local. */
export function addVersionRaw(v: PresetVersion, packed: Uint8Array): void {
  const all = vIndex();
  if (all.some((x) => x.id === v.id)) return;
  ensure(BLOBS_DIR);
  if (!existsSync(blobPathByHash(v.hash))) writeFileSync(blobPathByHash(v.hash), Buffer.from(packed));
  all.push(v);
  saveVIndex(all);
}

/** Import a version with raw .syx in hand (local Sync-folder restore). Content-addressed like
 *  addVersionRaw; re-packs the bytes (blob may not exist locally) and keeps the record's identity
 *  (id/capturedAt/hash) verbatim so re-sync recognizes it. Skips if the version id is already local. */
export function importVersion(v: PresetVersion, syx: Uint8Array): void {
  const all = vIndex();
  if (all.some((x) => x.id === v.id)) return;
  const packed = packSyx(syx);
  ensure(BLOBS_DIR);
  if (!existsSync(blobPathByHash(v.hash))) writeFileSync(blobPathByHash(v.hash), packed);
  all.push({ ...v, bytes: syx.length, stored: packed.length });
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
