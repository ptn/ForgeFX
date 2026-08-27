// Editor-cache DISCOVERY (FORGEFX-31 / META-22) — the Node-only half of the import feature: scans the
// OS-conventional Fractal-editor config dirs for `effectDefinitions_*.cache` files and reads a chosen
// candidate off disk. NODE-ONLY (node:fs/path/os) — it must stay OUT of the runtime/browser import
// graph (the browser twin returns an empty candidate list), so ONLY app.ts imports it, never
// runtime/router.ts. check-browser-safe.ts stays green because router.ts pulls editorCacheImport.ts
// (browser-safe) and never this module.
//
// Editors write into `Fractal Audio/<Editor>/effectDefinitions_*.cache` under a per-OS base dir:
//   Windows  %APPDATA%/Fractal Audio/                                     (env APPDATA)
//   macOS    ~/Library/Application Support/Fractal Audio/
//   Linux    ~/.wine/drive_c/users/*/AppData/Roaming/Fractal Audio/       (editors run under Wine)
// The `<Editor>` dir name varies (FM3-Edit, FM9-Edit, Axe-Edit III, AM4-Edit) so it is NEVER
// hardcoded — every immediate subdir of a `Fractal Audio` base is scanned.
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseEditorCacheFilename } from './editorCacheImport.js';

/** One discovered `.cache` file on disk, with its parsed identity + fs stat. */
export interface EditorCacheCandidate {
  path: string;
  file: string;
  model: number;
  fwMajor: number;
  fwMinor: number;
  size: number;
  mtime: string; // ISO
}

/** The fs surface discovery needs — injectable so tests fake the filesystem without touching disk. */
export interface DiscoveryFs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  statSync(p: string): { size: number; mtimeMs: number };
}

export interface DiscoverOpts {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fs?: DiscoveryFs;
}

const REAL_FS: DiscoveryFs = {
  existsSync: (p) => existsSync(p),
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; },
};

/** The per-OS `Fractal Audio` base dirs to scan (each holds one subdir per installed editor). */
function baseDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, fs: DiscoveryFs): string[] {
  if (platform === 'win32') {
    const appdata = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join(appdata, 'Fractal Audio')];
  }
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Fractal Audio')];
  }
  // Linux / other: the editors are Windows apps run under Wine — one prefix per user under drive_c.
  const wineUsers = join(home, '.wine', 'drive_c', 'users');
  if (!fs.existsSync(wineUsers)) return [];
  let users: string[];
  try { users = fs.readdirSync(wineUsers); } catch { return []; }
  return users.map((u) => join(wineUsers, u, 'AppData', 'Roaming', 'Fractal Audio'));
}

/** Scan the OS-conventional editor dirs for `effectDefinitions_*.cache` files. Pure fs walking (no
 *  byte parsing) — silently skips missing/unreadable dirs and unparseable filenames. */
export function discoverEditorCaches(opts: DiscoverOpts = {}): EditorCacheCandidate[] {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? REAL_FS;

  const out: EditorCacheCandidate[] = [];
  for (const base of baseDirs(platform, home, env, fs)) {
    if (!fs.existsSync(base)) continue;
    let editors: string[];
    try { editors = fs.readdirSync(base); } catch { continue; }
    for (const editor of editors) {
      const dir = join(base, editor);
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { continue; } // not a dir / unreadable
      for (const file of files) {
        if (!file.startsWith('effectDefinitions_') || !file.endsWith('.cache')) continue;
        const info = parseEditorCacheFilename(file);
        if (!info) continue;
        const path = join(dir, file);
        let st: { size: number; mtimeMs: number };
        try { st = fs.statSync(path); } catch { continue; }
        out.push({ path, file, model: info.model, fwMajor: info.fwMajor, fwMinor: info.fwMinor, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      }
    }
  }
  return out;
}

/** Read a discovered candidate off disk (for the `{ path }` import body). Returns the basename +
 *  raw bytes; throws if the file is missing/unreadable. Node-only (real fs). */
export function readCandidateFile(path: string): { name: string; bytes: Uint8Array } {
  const buf = readFileSync(path);
  return { name: basename(path), bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

// ── `.blk` block-file library discovery ───────────────────────────────────
// The caller explicitly selects the library directory. Do not read another application's settings
// file to infer it: that crosses an application boundary without user approval.

/** One discovered `.blk` saved-block file. */
export interface BlockFileCandidate {
  path: string;
  blocksDir: string;
  /** The one-level-deep per-effect folder name (e.g. "Drive"), or null for a root-level file. */
  category: string | null;
  /** Derived from the filename (strips the `_YYYYMMDD_HHMMSS` timestamp suffix every real file
   *  carries), NOT from the decoded header — discovery must stay decode-free so 230 files list fast. */
  name: string;
  size: number;
  mtime: string; // ISO
}

function deriveBlockName(filename: string): string {
  const m = /^(.*)_\d{8}_\d{6}\.blk$/i.exec(filename);
  return m ? m[1]! : filename.replace(/\.blk$/i, '');
}

function pushBlockCandidate(
  fs: DiscoveryFs,
  path: string,
  blocksDir: string,
  category: string | null,
  filename: string,
  out: BlockFileCandidate[],
): void {
  let st: { size: number; mtimeMs: number };
  try { st = fs.statSync(path); } catch { return; }
  out.push({ path, blocksDir, category, name: deriveBlockName(filename), size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
}

/** Scan one editor's blocks dir: `.blk` files at the root (category null) plus one level of
 *  per-effect category folders — the layout every one of 230 real files follows. A root entry that
 *  isn't itself a `.blk` file is probed as a category folder via `readdirSync`; an unreadable/
 *  non-directory entry is silently skipped (the same "try readdirSync, catch = not a dir" idiom
 *  `discoverEditorCaches` already uses — `DiscoveryFs` has no separate `isDirectory` probe). */
function scanBlocksDir(fs: DiscoveryFs, blocksDir: string, out: BlockFileCandidate[]): void {
  let entries: string[];
  try { entries = fs.readdirSync(blocksDir); } catch { return; }
  for (const entry of entries) {
    const entryPath = join(blocksDir, entry);
    if (entry.toLowerCase().endsWith('.blk')) {
      pushBlockCandidate(fs, entryPath, blocksDir, null, entry, out);
      continue;
    }
    let sub: string[];
    try { sub = fs.readdirSync(entryPath); } catch { continue; }
    for (const subEntry of sub) {
      if (!subEntry.toLowerCase().endsWith('.blk')) continue;
      pushBlockCandidate(fs, join(entryPath, subEntry), blocksDir, entry, subEntry, out);
    }
  }
}

/**
 * Discover `.blk` files in the caller-selected library directory. Files at the root and one category
 * directory deep are included; missing or unreadable directories return no candidates.
 */
export function discoverBlockFiles(blocksDir: string, fs: DiscoveryFs = REAL_FS): BlockFileCandidate[] {
  const candidates: BlockFileCandidate[] = [];
  scanBlocksDir(fs, blocksDir, candidates);
  return candidates;
}
