// Preset templates — scan/read/write a caller-selected templates directory (the official editor's
// `~/Documents/Fractal Audio/<Editor>/presets/templates` folder). A template is a plain preset .syx
// (byte-identical to a device dump), so there is no bespoke format: this service only enumerates the
// directory and moves raw bytes. Node-only (node:fs) — imported by app.ts only, never the
// runtime/browser graph (see scripts/check-browser-safe.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_SIZE = 2 * 1024 * 1024; // skip .syx > 2 MB (firmware images, not presets)
const MAX_FILES = 1000;

export interface TemplateCandidate {
  path: string;
  name: string;
  size: number;
  mtime: string; // ISO
}

/** The fs surface discovery needs — injectable so tests fake the filesystem without touching disk. */
export interface TemplateFs {
  readdirSync(p: string): string[];
  statSync(p: string): { size: number; mtimeMs: number };
  readFileSync(p: string): Uint8Array;
}

const REAL_FS: TemplateFs = {
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; },
  readFileSync: (p) => readFileSync(p)
};

/** `.syx` files directly inside `templatesDir`, name-sorted. Missing/unreadable dir → []. */
export function discoverTemplateFiles(templatesDir: string, fs: TemplateFs = REAL_FS): TemplateCandidate[] {
  let entries: string[];
  try { entries = fs.readdirSync(templatesDir); } catch { return []; }
  const out: TemplateCandidate[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (!entry.toLowerCase().endsWith('.syx')) continue;
    const path = join(templatesDir, entry);
    let st: { size: number; mtimeMs: number };
    try { st = fs.statSync(path); } catch { continue; }
    if (!st.size || st.size > MAX_SIZE) continue;
    out.push({ path, name: entry.replace(/\.syx$/i, ''), size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    if (out.length >= MAX_FILES) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Raw bytes of one template, constrained to the discovered set (a path outside the dir reads nothing). */
export function readTemplateBytes(templatesDir: string, path: string, fs: TemplateFs = REAL_FS): Uint8Array | null {
  if (!discoverTemplateFiles(templatesDir, fs).some((c) => c.path === path)) return null;
  try { return fs.readFileSync(path); } catch { return null; }
}

/** Normalize a user-supplied template name into a safe filename fragment (no extension). */
export function sanitizeTemplateName(raw: string): string | null {
  const name = raw.trim().replace(/\.syx$/i, '').trim();
  if (!name) return null;
  if (/[^\x20-\x7e]/.test(name)) return null;
  if (/[\x00-\x1f/\\:*?"<>|]/.test(name)) return null;
  if (name === '.' || name === '..' || name.startsWith('.')) return null;
  return name.slice(0, 64);
}

export interface WriteTemplateResult {
  ok: true;
  path: string;
}

export interface WriteTemplateFailure {
  ok: false;
  code: number;
  error: string;
}

/** Write a template into the folder as `<name>.syx` (409 on an existing file unless overwrite). */
export function writeTemplateFile(
  templatesDir: string,
  name: string,
  bytes: Uint8Array,
  overwrite: boolean
): WriteTemplateResult | WriteTemplateFailure {
  const path = join(templatesDir, `${name}.syx`);
  if (!overwrite && existsSync(path)) return { ok: false, code: 409, error: 'template-exists' };
  try {
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(path, bytes);
  } catch (e) {
    return { ok: false, code: 500, error: (e as Error).message };
  }
  return { ok: true, path };
}
