// Storage backend contract for the Axis persistent store (store.ts) — the seam that makes the store
// logic browser-portable (Axis Browser Direct). store.ts keeps all POLICY (sync envelopes, content
// addressing, dedup, retention); a StoreBackend supplies only primitive persistence: doc maps per
// collection, the flat version index, opaque content-addressed blobs, and small keyed sidecar JSON
// records (backups list, local scan cache). Implementations: runtime/fsStoreBackend.ts (Node —
// byte-identical to the classic ~/.axis on-disk layout) and runtime/memStoreBackend.ts (trivial Maps —
// tests / browser fallback); an IndexedDB backend is the planned browser implementation.
//
// The contract is SYNCHRONOUS on purpose: the HTTP surface and its tests consume the store
// synchronously (putDoc(...).rev, hasPresetVersion(...) in expressions). The store's working set is
// small (JSON docs + a version index; blobs are ~10 KB compressed), so an inherently-async browser
// backend fronts this with an in-memory mirror hydrated once at startup and flushed write-behind —
// the mem backend provides the mirror mechanics.
//
// NO node: imports in this module — it must load in a browser.

// ─────────────────────────── record shapes ───────────────────────────
/** Sync-ready document envelope — every saved record carries {id, updatedAt, rev, deleted} so cloud
 *  sync is just a diff on `updatedAt`. */
export interface Doc<T = unknown> { id: string; collection: string; data: T; updatedAt: number; rev: number; deleted?: boolean }

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

export interface Backup { id: string; createdAt: number; label: string; model: string; count: number }

// ─────────────────────────── backend primitives ───────────────────────────
/** Write hints for keyed sidecar JSON: `atomic` = tmp+rename semantics (a crash mid-write must not
 *  corrupt the record), `pretty` = 2-space indented (human-readable on disk). */
export interface JsonWriteOpts { atomic?: boolean; pretty?: boolean }

export interface StoreBackend {
  // documents (per-collection maps; tombstoned docs are returned too — filtering is store policy)
  getDoc(collection: string, id: string): Doc | null;
  listDocs(collection: string): Doc[];
  putDoc(doc: Doc): void;
  deleteDoc(collection: string, id: string): void; // hard delete (store policy only ever tombstones)

  // preset-version index entries (insertion-ordered — the store sorts by capturedAt where it matters)
  listVersions(): PresetVersion[];
  putVersion(v: PresetVersion): void; // replace by id, else append
  deleteVersions(ids: readonly string[]): void;

  // content-addressed blobs (opaque bytes; the store keys them by content hash)
  hasBlob(key: string): boolean;
  getBlob(key: string): Uint8Array | null;
  putBlob(key: string, bytes: Uint8Array): void;
  deleteBlob(key: string): void; // missing key is a no-op

  // small keyed sidecar JSON records (backups list, the local Presets/ scan cache)
  getJSON<T>(key: string, fallback: T): T;
  putJSON(key: string, value: unknown, opts?: JsonWriteOpts): void;
}

/** Byte transforms the store needs, kept out of the shared logic so node:zlib/node:crypto stay in the
 *  Node backend. Browser: brotli via WASM (CompressionStream has no brotli), sha256 via a sync JS impl
 *  (crypto.subtle is async-only). */
export interface StoreCodec {
  pack(bytes: Uint8Array): Uint8Array; // brotli compress (see fsStoreBackend for the quality rationale)
  unpack(packed: Uint8Array): Uint8Array;
  sha256Hex(bytes: Uint8Array): string;
}
