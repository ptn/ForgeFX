// Node filesystem FolderAdapter — binds an absolute root directory (the user-configured local storage
// folder) and maps the logic layer's relative POSIX paths onto it. Dumb by design: no traversal
// guarding here (that lives in localFolder.ts's safeRel, shared with the browser), just faithful fs
// primitives with the same failure semantics the old inline localStore.ts code had.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { FolderAdapter, FolderEntry } from './folderAdapter.js';

export function createFsFolderAdapter(root: string): FolderAdapter {
  const abs = (rel: string) => (rel ? join(root, ...rel.split('/')) : root);
  return {
    key: (rel) => abs(rel),
    list: async (rel) => {
      const dir = abs(rel);
      const out: FolderEntry[] = [];
      for (const name of readdirSync(dir)) {
        let st;
        try { st = statSync(join(dir, name)); } catch { continue; } // vanished/unstatable → omit
        out.push({ name, dir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs });
      }
      return out;
    },
    exists: async (rel) => existsSync(abs(rel)),
    readFile: async (rel) => new Uint8Array(readFileSync(abs(rel))),
    writeFile: async (rel, bytes) => { const p = abs(rel); writeFileSync(`${p}.tmp`, bytes); renameSync(`${p}.tmp`, p); },
    mkdir: async (rel) => { mkdirSync(abs(rel), { recursive: true }); },
    remove: async (rel) => { unlinkSync(abs(rel)); }
  };
}
