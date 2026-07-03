// Folder adapter contract for the local storage folder logic (runtime/localFolder.ts) — the seam that
// makes the Presets//Sync/ feature browser-portable (Axis Browser Direct). All paths are RELATIVE,
// POSIX-style ('/'-joined, '' = the root itself), inside the adapter's root; only the adapter knows
// where (or what) the root actually is: the Node implementation (runtime/fsFolderAdapter.ts) binds an
// absolute directory, the browser one will wrap a File System Access directory handle. Traversal
// safety is NOT the adapter's job — the shared logic guards every externally-supplied path with
// safeRel() before it reaches an adapter, so browsers get the same protection.
// NO node: imports in this module — it must load in a browser.

export interface FolderEntry { name: string; dir: boolean; size: number; mtimeMs: number }

export interface FolderAdapter {
  /** Stable identity of `rel` for cross-run cache keys. Node returns the ABSOLUTE path (so a moved
   *  root invalidates cached entries naturally); a browser adapter returns a root-scoped key. */
  key(rel: string): string;
  /** Entries of one directory (non-recursive), with size+mtime. Throws if unreadable/missing; entries
   *  whose stat fails are silently omitted (matching the old per-file statSync-and-skip behavior). */
  list(rel: string): Promise<FolderEntry[]>;
  exists(rel: string): Promise<boolean>;
  readFile(rel: string): Promise<Uint8Array>;
  /** ATOMIC write (tmp + rename semantics — a crash mid-write must not leave a torn file; the browser
   *  implementation emulates this). Parent directory must exist (mkdir first). */
  writeFile(rel: string, bytes: Uint8Array): Promise<void>;
  /** mkdir -p. */
  mkdir(rel: string): Promise<void>;
  remove(rel: string): Promise<void>;
}
