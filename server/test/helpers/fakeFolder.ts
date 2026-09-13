// In-memory FolderAdapter for the runtime-folder unit tests (no disk). Mirrors fsFolderAdapter's
// relative-POSIX semantics: paths are '/'-joined with no leading slash, '' is the root.
import type { FolderAdapter, FolderEntry } from '../../src/runtime/folderAdapter.js';

export class MemFolderAdapter implements FolderAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['']);
  /** When set, every writeFile throws — for testing the not-writable path. */
  readOnly = false;

  private parent(rel: string): string {
    const segs = rel.split('/');
    segs.pop();
    return segs.join('/');
  }

  key(rel: string): string { return rel; }

  async list(rel: string): Promise<FolderEntry[]> {
    if (!this.dirs.has(rel)) throw new Error(`ENOENT: ${rel}`);
    const prefix = rel ? `${rel}/` : '';
    const seen = new Set<string>();
    const out: FolderEntry[] = [];
    for (const [p, bytes] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(slash < 0
        ? { name, dir: false, size: bytes.length, mtimeMs: 0 }
        : { name, dir: true, size: 0, mtimeMs: 0 });
    }
    for (const d of this.dirs) {
      if (d === rel || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.includes('/') || seen.has(rest)) continue;
      seen.add(rest);
      out.push({ name: rest, dir: true, size: 0, mtimeMs: 0 });
    }
    return out;
  }

  async exists(rel: string): Promise<boolean> { return this.files.has(rel) || this.dirs.has(rel); }

  async readFile(rel: string): Promise<Uint8Array> {
    const b = this.files.get(rel);
    if (!b) throw new Error(`ENOENT: ${rel}`);
    return b.slice();
  }

  async writeFile(rel: string, bytes: Uint8Array): Promise<void> {
    if (this.readOnly) throw new Error('read-only');
    this.dirs.add(this.parent(rel));
    this.files.set(rel, bytes.slice());
  }

  async mkdir(rel: string): Promise<void> {
    this.dirs.add('');
    let cur = '';
    for (const s of rel.split('/')) { cur = cur ? `${cur}/${s}` : s; this.dirs.add(cur); }
  }

  async remove(rel: string): Promise<void> {
    if (!this.files.delete(rel) && !this.dirs.delete(rel)) throw new Error(`ENOENT: ${rel}`);
  }
}
