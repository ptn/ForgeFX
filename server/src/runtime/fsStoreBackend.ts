// Node filesystem StoreBackend — the default backend, byte-identical to the pre-split store.ts fs
// code (same paths, same JSON formatting, same compression), so existing user data under
// FORGEFX_DATA_DIR (default ~/.axis) keeps working unchanged:
//   <dataDir>/store/<collection>.json   one JSON map per doc collection
//   <dataDir>/versions/index.json       flat PresetVersion array
//   <dataDir>/versions/blobs/<hash>.syx.br  content-addressed brotli blobs
//   <dataDir>/<key>.json                keyed sidecar records (backups.json, localScan.json)
// Filesystem-backed (zero native deps → bundles in Electron/Docker/Pi unchanged). Stateless — every
// call re-reads disk, so external cleanup (e.g. tests wiping versions/) is picked up immediately.
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'node:zlib';
import type { StoreBackend, StoreCodec, Doc, PresetVersion, JsonWriteOpts } from './storeBackend.js';

export const DATA_DIR = process.env.FORGEFX_DATA_DIR ?? join(homedir(), '.axis');

// Preset .syx is 7-bit-padded SysEx → compresses ~3-4x. Brotli at rest (small local footprint) AND so the
// blob is already compressed when synced to the cloud (storage = money). Restore/download decompresses
// back to a valid .syx. Quality 11 (max) — ~8% smaller than q9 on preset dumps; slower to compress, but
// dedup means only changed presets are ever compressed, and decompress cost is identical. SIZE_HINT
// helps the encoder.
export const nodeCodec: StoreCodec = {
  pack: (b) => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: b.length } }),
  unpack: (b) => new Uint8Array(brotliDecompressSync(b)),
  sha256Hex: (b) => createHash('sha256').update(b).digest('hex')
};

export function createFsStoreBackend(dataDir: string): StoreBackend {
  const storeDir = join(dataDir, 'store'); // documents: one JSON map per collection
  const versionsDir = join(dataDir, 'versions'); // preset .syx snapshots + index
  const blobsDir = join(versionsDir, 'blobs');
  const ensure = (d: string) => mkdirSync(d, { recursive: true });
  const readJSON = <T>(p: string, fb: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fb; } };

  const collPath = (c: string) => join(storeDir, `${c.replace(/[^\w.-]/g, '_')}.json`);
  const loadColl = (c: string): Record<string, Doc> => readJSON(collPath(c), {});
  const saveColl = (c: string, m: Record<string, Doc>) => { ensure(storeDir); writeFileSync(collPath(c), JSON.stringify(m)); };

  const indexPath = join(versionsDir, 'index.json');
  const loadIndex = (): PresetVersion[] => readJSON(indexPath, []);
  const saveIndex = (v: PresetVersion[]) => { ensure(versionsDir); writeFileSync(indexPath, JSON.stringify(v)); };

  /** Content-addressed blob path: identical preset content → identical hash → one stored blob, shared by
   *  every version (and every full-backup) that references it. This is what makes repeat backups ~free. */
  const blobPath = (key: string) => join(blobsDir, `${key}.syx.br`);

  return {
    getDoc: (c, id) => loadColl(c)[id] ?? null,
    listDocs: (c) => Object.values(loadColl(c)),
    putDoc: (doc) => { const m = loadColl(doc.collection); m[doc.id] = doc; saveColl(doc.collection, m); },
    deleteDoc: (c, id) => { const m = loadColl(c); if (id in m) { delete m[id]; saveColl(c, m); } },

    listVersions: () => loadIndex(),
    putVersion: (v) => { const all = loadIndex(); const i = all.findIndex((x) => x.id === v.id); if (i >= 0) all[i] = v; else all.push(v); saveIndex(all); },
    deleteVersions: (ids) => { const drop = new Set(ids); const all = loadIndex(); const kept = all.filter((v) => !drop.has(v.id)); if (kept.length !== all.length) saveIndex(kept); },

    hasBlob: (key) => existsSync(blobPath(key)),
    getBlob: (key) => { try { return readFileSync(blobPath(key)); } catch { return null; } },
    putBlob: (key, bytes) => { ensure(blobsDir); writeFileSync(blobPath(key), bytes); },
    deleteBlob: (key) => { try { unlinkSync(blobPath(key)); } catch { /* already gone */ } },

    getJSON: <T>(key: string, fallback: T): T => readJSON(join(dataDir, `${key}.json`), fallback),
    putJSON: (key: string, value: unknown, opts?: JsonWriteOpts) => {
      ensure(dataDir);
      const p = join(dataDir, `${key}.json`);
      const s = opts?.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
      if (opts?.atomic) { writeFileSync(`${p}.tmp`, s); renameSync(`${p}.tmp`, p); } else writeFileSync(p, s);
    }
  };
}
