// In-memory StoreBackend — trivial Maps. For tests, and as the in-memory mirror an async browser
// backend (IndexedDB) fronts the synchronous StoreBackend contract with (hydrate once, flush
// write-behind). Values are JSON-round-tripped on put/get so callers can't alias internal state —
// the fs backend gets the same isolation for free by re-parsing files.
// NO node: imports here — this module must load in a browser.
import type { StoreBackend, Doc, PresetVersion } from './storeBackend.js';

export function createMemStoreBackend(): StoreBackend {
  const colls = new Map<string, Map<string, Doc>>();
  let versions: PresetVersion[] = [];
  const blobs = new Map<string, Uint8Array>();
  const json = new Map<string, string>();
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const coll = (c: string): Map<string, Doc> => { let m = colls.get(c); if (!m) { m = new Map(); colls.set(c, m); } return m; };

  return {
    getDoc: (c, id) => { const d = coll(c).get(id); return d ? clone(d) : null; },
    listDocs: (c) => [...coll(c).values()].map(clone),
    putDoc: (doc) => { coll(doc.collection).set(doc.id, clone(doc)); },
    deleteDoc: (c, id) => { coll(c).delete(id); },

    listVersions: () => versions.map(clone),
    putVersion: (v) => { const i = versions.findIndex((x) => x.id === v.id); if (i >= 0) versions[i] = clone(v); else versions.push(clone(v)); },
    deleteVersions: (ids) => { const drop = new Set(ids); versions = versions.filter((v) => !drop.has(v.id)); },

    hasBlob: (key) => blobs.has(key),
    getBlob: (key) => blobs.get(key)?.slice() ?? null,
    putBlob: (key, bytes) => { blobs.set(key, bytes.slice()); },
    deleteBlob: (key) => { blobs.delete(key); },

    getJSON: <T>(key: string, fallback: T): T => { const s = json.get(key); if (s == null) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } },
    putJSON: (key, value) => { json.set(key, JSON.stringify(value)); } // atomic/pretty hints are moot in memory
  };
}
