// Local storage folder — a user-configured root directory managed by ForgeFX with two subfolders:
//   Presets/  browsable .syx library (users point Axis at the collections they already carry around)
//   Sync/     plain-syx mirror of the version store (human-readable, usable by FM3-Edit/Fractal-Bot,
//             unlimited — the local alternative/complement to cloud sync)
//
// All filesystem work lives HERE (ForgeFX runs in-process in Electron with full Node fs; the Axis
// renderer never touches fs). The root path is machine-local, so it persists in the `local` doc
// collection — which is intentionally NEVER cloud-synced or broadcast (only `config` is).
//
// Sync/ format: raw .syx files named `<loc 3-digit> - <name> - <timestamp>.syx` plus a pretty-printed
// index.json carrying the version metadata (id/hash/crc/...). Export is incremental (set-difference on
// version ids, like cloud.ts syncVersions) and NEVER deletes user files; restore re-imports missing
// versions into the version store, sha256-verified against the index.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve, sep, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as store from './store.js';
import { DATA_DIR } from './store.js';

/** Offline preset decode (model-byte dispatched; throws on non-preset bytes) — wired from app.ts. */
export type DecodeFn = (bytes: Uint8Array) => Promise<Record<string, unknown>>;

const PRESETS_SUB = 'Presets';
const SYNC_SUB = 'Sync';
const SCAN_CACHE_PATH = join(DATA_DIR, 'localScan.json');
const MAX_FILES = 10_000; // scan cap — beyond this we stop descending (reported via `truncated`)
const MAX_DEPTH = 8;
const MAX_SIZE = 2 * 1024 * 1024; // skip .syx > 2 MB (firmware images, not presets)

// ─────────────────────────── config (root path) ───────────────────────────
interface LocalCfg { root: string | null; lastSync: number | null }
const cfg = (): LocalCfg => {
  const d = store.getDoc('local', 'config')?.data as Partial<LocalCfg> | undefined;
  return { root: typeof d?.root === 'string' ? d.root : null, lastSync: typeof d?.lastSync === 'number' ? d.lastSync : null };
};
const saveCfg = (c: LocalCfg) => store.putDoc('local', 'config', c);

const writableProbe = (dir: string): boolean => {
  try {
    const p = join(dir, '.axis-write-test');
    writeFileSync(p, '');
    unlinkSync(p);
    return true;
  } catch { return false; }
};

const configState = () => {
  const c = cfg();
  const exists = !!c.root && existsSync(c.root);
  return {
    configured: !!c.root,
    root: c.root,
    exists,
    writable: exists ? writableProbe(c.root!) : false,
    lastSync: c.lastSync
  };
};

// ─────────────────────────── path safety ───────────────────────────
/** Resolve `rel` strictly under `base`; null on traversal/absolute/NUL. */
function resolveUnder(base: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || isAbsolute(rel)) return null;
  const b = resolve(base);
  const p = resolve(b, rel);
  return p === b || p.startsWith(b + sep) ? p : null;
}
/** Filesystem-safe filename fragment (Windows-safe, bounded). */
const sanitize = (s: string): string =>
  (s || 'preset').replace(/[^\w \-().]+/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'preset';

const isSyx = (name: string) => name.toLowerCase().endsWith('.syx');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const readJSON = <T>(p: string, fb: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fb; } };
/** Atomic JSON write (tmp + rename) — a crash mid-write must not corrupt the index. */
const writeJSONAtomic = (p: string, v: unknown) => { writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${p}.tmp`, p); };

// ─────────────────────────── Presets/ scan + decode cache ───────────────────────────
interface ScanRec { size: number; mtime: number; summary: Record<string, unknown> | null; error?: string }
type ScanCache = Record<string, ScanRec>; // keyed by ABSOLUTE path (root moves invalidate naturally)

export interface LocalPresetEntry { path: string; name: string; size: number; mtime: number; summary: Record<string, unknown> }

async function scanPresets(root: string, decode: DecodeFn, force: boolean): Promise<{ entries: LocalPresetEntry[]; skipped: number; truncated: boolean }> {
  const base = join(root, PRESETS_SUB);
  const cache: ScanCache = force ? {} : readJSON<ScanCache>(SCAN_CACHE_PATH, {});
  const next: ScanCache = {};
  const entries: LocalPresetEntry[] = [];
  let skipped = 0, seen = 0, truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; } // unreadable subdir → skip, not fail
    for (const n of names) {
      if (n.startsWith('.')) continue;
      if (seen >= MAX_FILES) { truncated = true; return; }
      const abs = join(dir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!isSyx(n) || st.size > MAX_SIZE || st.size === 0) continue;
      seen++;
      const hit = cache[abs];
      let rec: ScanRec;
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
        rec = hit; // mtime cache hit — no decode
      } else {
        try {
          const summary = { ...(await decode(new Uint8Array(readFileSync(abs)))) };
          delete summary.params; // full per-block params bloat the index; deep search over local entries is deferred
          rec = { size: st.size, mtime: st.mtimeMs, summary };
        } catch (e) {
          rec = { size: st.size, mtime: st.mtimeMs, summary: null, error: (e as Error).message }; // IR/cab/firmware .syx → negative-cached
        }
      }
      next[abs] = rec;
      if (!rec.summary) { skipped++; continue; }
      const rel = abs.slice(base.length + 1).split(sep).join('/');
      entries.push({
        path: rel,
        name: typeof rec.summary.name === 'string' && rec.summary.name ? (rec.summary.name as string) : n.replace(/\.syx$/i, ''),
        size: st.size,
        mtime: st.mtimeMs,
        summary: rec.summary
      });
    }
  };
  await walk(base, 0);
  try { writeJSONAtomic(SCAN_CACHE_PATH, next); } catch { /* cache is best-effort */ }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, skipped, truncated };
}

// ─────────────────────────── Sync/ mirror (plain .syx + index.json) ───────────────────────────
interface LocalIndexVersion {
  id: string; location: number; crc: number; hash: string; name: string; model: string;
  capturedAt: number; source: string; backupId: string | null; bytes: number; file: string;
}
interface LocalIndexBackup { id: string; label: string; model: string; createdAt: number; count: number; dir: string }
interface LocalIndex { v: 1; generatedAt: number; backups: LocalIndexBackup[]; versions: LocalIndexVersion[] }

const indexPath = (root: string) => join(root, SYNC_SUB, 'index.json');
const loadIndex = (root: string): LocalIndex => {
  const idx = readJSON<Partial<LocalIndex>>(indexPath(root), {});
  return { v: 1, generatedAt: idx.generatedAt ?? 0, backups: Array.isArray(idx.backups) ? idx.backups : [], versions: Array.isArray(idx.versions) ? idx.versions : [] };
};

const loc3 = (n: number) => (n >= 0 ? String(n).padStart(3, '0') : 'buf');
const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace(/:/g, '-'); // sortable, fs-safe
const dateOnly = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function syncToFolder(root: string): { ok: true; written: number; skippedExisting: number; total: number; backups: number } {
  const syncDir = join(root, SYNC_SUB);
  mkdirSync(syncDir, { recursive: true });
  const idx = loadIndex(root);
  const have = new Map(idx.versions.map((v) => [v.id, v]));
  const backups = store.listBackups();
  const bkById = new Map(backups.map((b) => [b.id, b]));

  // backup-group directories (created lazily; merged into the index)
  const bkDir = (bkId: string, model: string): string => {
    const known = idx.backups.find((b) => b.id === bkId);
    if (known) return known.dir;
    const meta = bkById.get(bkId);
    const dir = `${sanitize(model || meta?.model || 'device')}/backups/${sanitize(`${dateOnly(meta?.createdAt ?? Date.now())} ${meta?.label ?? 'Device backup'} (${bkId})`)}`;
    idx.backups.push({ id: bkId, label: meta?.label ?? '', model: meta?.model ?? model, createdAt: meta?.createdAt ?? 0, count: meta?.count ?? 0, dir });
    return dir;
  };

  let written = 0, skippedExisting = 0;
  for (const v of store.listPresetVersions()) {
    const known = have.get(v.id);
    if (known && existsSync(join(syncDir, ...known.file.split('/')))) { skippedExisting++; continue; }
    const bytes = store.getPresetVersionBytes(v.id);
    if (!bytes) continue; // blob missing locally (shouldn't happen) → skip, never fail the run
    const relDir = v.backupId ? bkDir(v.backupId, v.model) : `${sanitize(v.model || 'device')}/versions`;
    const base = v.backupId
      ? `${loc3(v.location)} - ${sanitize(v.name)}`
      : `${loc3(v.location)} - ${sanitize(v.name)} - ${stamp(v.capturedAt)}`;
    let rel = `${relDir}/${base}.syx`;
    let abs = join(syncDir, ...rel.split('/'));
    if (!known && existsSync(abs)) { rel = `${relDir}/${base} ~${sanitize(v.id)}.syx`; abs = join(syncDir, ...rel.split('/')); } // name collision → suffix, never overwrite
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    if (known) known.file = rel;
    else idx.versions.push({ id: v.id, location: v.location, crc: v.crc, hash: v.hash, name: v.name, model: v.model, capturedAt: v.capturedAt, source: v.source, backupId: v.backupId ?? null, bytes: v.bytes, file: rel });
    written++;
  }
  idx.generatedAt = Date.now();
  writeJSONAtomic(indexPath(root), idx);
  saveCfg({ root, lastSync: Date.now() });
  return { ok: true, written, skippedExisting, total: idx.versions.length, backups: idx.backups.length };
}

function restoreFromFolder(root: string): { ok: true; imported: number; skippedExisting: number; skippedBad: number } {
  const syncDir = join(root, SYNC_SUB);
  const idx = loadIndex(root);
  let imported = 0, skippedExisting = 0, skippedBad = 0;
  for (const v of idx.versions) {
    if (store.hasPresetVersion(v.id)) { skippedExisting++; continue; }
    const abs = resolveUnder(syncDir, v.file);
    if (!abs || !existsSync(abs)) { skippedBad++; continue; }
    let syx: Uint8Array;
    try { syx = new Uint8Array(readFileSync(abs)); } catch { skippedBad++; continue; }
    if (sha256(syx) !== v.hash) { console.warn(`[forgefx] local restore: hash mismatch for ${v.file} — skipped`); skippedBad++; continue; }
    store.importVersion(
      { id: v.id, location: v.location, crc: v.crc, hash: v.hash, name: v.name, model: v.model, capturedAt: v.capturedAt, source: (v.source as 'manual' | 'auto' | 'backup') ?? 'manual', ...(v.backupId ? { backupId: v.backupId } : {}), bytes: v.bytes, stored: 0 },
      syx
    );
    imported++;
  }
  return { ok: true, imported, skippedExisting, skippedBad };
}

// ─────────────────────────── routes ───────────────────────────
export function registerLocalRoutes(app: FastifyInstance, decode: DecodeFn): void {
  /** Common gate: answer 409 unless a root is configured and present; returns the root or null. */
  const needRoot = (reply: FastifyReply): string | null => {
    const c = cfg();
    if (!c.root) { reply.code(409); void reply.send({ error: 'not configured' }); return null; }
    if (!existsSync(c.root)) { reply.code(409); void reply.send({ error: 'root missing' }); return null; }
    return c.root;
  };
  let syncBusy = false;

  app.get('/local/config', () => configState());
  app.put<{ Body: { root?: string | null } }>('/local/config', (req, reply) => {
    const root = req.body?.root ?? null;
    if (root === null) { saveCfg({ root: null, lastSync: null }); return configState(); }
    if (typeof root !== 'string' || !isAbsolute(root)) { reply.code(400); return { error: 'absolute path required' }; }
    try {
      mkdirSync(join(root, PRESETS_SUB), { recursive: true });
      mkdirSync(join(root, SYNC_SUB), { recursive: true });
    } catch (e) { reply.code(400); return { error: `cannot create folders: ${(e as Error).message}` }; }
    if (!writableProbe(root)) { reply.code(400); return { error: 'folder is not writable' }; }
    saveCfg({ root: resolve(root), lastSync: cfg().lastSync });
    return configState();
  });

  // Browse the Presets/ library: recursive scan with an mtime-keyed decode cache (?refresh=1 re-decodes all)
  app.get<{ Querystring: { refresh?: string } }>('/local/presets', async (req, reply) => {
    const root = needRoot(reply);
    if (!root) return reply;
    const r = await scanPresets(root, decode, req.query.refresh === '1');
    return { root, ...r };
  });

  // Raw .syx bytes of one library file (audition/export path — bytes are fetched on demand, never cached client-side)
  app.get<{ Querystring: { path?: string } }>('/local/presets/file', (req, reply) => {
    const root = needRoot(reply);
    if (!root) return reply;
    const abs = req.query.path ? resolveUnder(join(root, PRESETS_SUB), req.query.path) : null;
    if (!abs || !isSyx(abs)) { reply.code(400); return { error: 'bad path' }; }
    if (!existsSync(abs)) { reply.code(404); return { error: 'not found' }; }
    void reply.header('content-type', 'application/octet-stream');
    return readFileSync(abs);
  });

  // Export a preset INTO the library folder. Two addressing modes:
  //   name (+ optional dir) — builds a sanitized `<name>.syx` (new exports);
  //   path                  — EXACT relative path, for writing back to the file a preset was
  //                           loaded from (save-to-disk), immune to name re-sanitizing.
  app.post<{ Body: { name?: string; dir?: string; path?: string; bytes?: number[]; overwrite?: boolean } }>('/local/presets', (req, reply) => {
    const root = needRoot(reply);
    if (!root) return reply;
    const { name, dir, path, bytes, overwrite } = req.body ?? {};
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] required' }; }
    const presetsDir = join(root, PRESETS_SUB);
    let file: string;
    if (path) {
      const abs = resolveUnder(presetsDir, path);
      if (!abs || !isSyx(abs)) { reply.code(400); return { error: 'bad path' }; }
      file = abs;
    } else {
      const relDir = dir ? resolveUnder(presetsDir, dir) : presetsDir;
      if (!relDir) { reply.code(400); return { error: 'bad dir' }; }
      file = join(relDir, `${sanitize(name ?? 'preset')}.syx`);
    }
    if (existsSync(file) && !overwrite) { reply.code(409); return { error: 'exists', path: file.slice(presetsDir.length + 1).split(sep).join('/') }; }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Uint8Array.from(bytes));
    } catch (e) { reply.code(500); return { error: (e as Error).message }; }
    return { ok: true, path: file.slice(presetsDir.length + 1).split(sep).join('/') };
  });

  // Mirror the version store → Sync/ (incremental; never deletes user files)
  app.post('/local/sync', (_req, reply) => {
    const root = needRoot(reply);
    if (!root) return reply;
    if (syncBusy) { reply.code(409); return { error: 'busy' }; }
    syncBusy = true;
    try { return syncToFolder(root); }
    catch (e) { reply.code(500); return { error: (e as Error).message }; }
    finally { syncBusy = false; }
  });

  // Re-import Sync/ versions into the version store (fresh machine / data loss), sha256-verified
  app.post('/local/restore', (_req, reply) => {
    const root = needRoot(reply);
    if (!root) return reply;
    if (syncBusy) { reply.code(409); return { error: 'busy' }; }
    syncBusy = true;
    try { return restoreFromFolder(root); }
    catch (e) { reply.code(500); return { error: (e as Error).message }; }
    finally { syncBusy = false; }
  });
}
