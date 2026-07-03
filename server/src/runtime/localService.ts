// Local storage folder — the SHARED /local/* route logic (config lifecycle, Presets/ scan, library
// write/read, Sync/ mirror + restore) over the pure folder logic in localFolder.ts. Both HTTP faces
// call THIS service: the Fastify glue (localStore.ts) binds the Node pieces (fs adapter, node:path
// checks, the DATA_DIR scan-cache sidecar), the runtime router (router.ts) binds whatever the browser
// supplies (directory-handle adapter, opaque root labels). Every method answers `{status, body}` so
// the two surfaces serve identical statuses and shapes. The root path is machine-local, so it
// persists in the `local` doc collection — which is intentionally NEVER cloud-synced or broadcast
// (only `config` is). NO node: imports — this module must load in a browser.
import type { FolderAdapter } from './folderAdapter.js';
import type { Store } from './store.js';
import {
  PRESETS_SUB, SYNC_SUB, isSyx, safeRel, sanitize, writableProbe,
  scanPresets, syncToFolder, restoreFromFolder,
  type DecodeFn, type ScanCachePersistence
} from './localFolder.js';

/** One route result: HTTP status + JSON body (Uint8Array for the raw .syx file read). */
export interface LocalResult { status: number; body: unknown }

export interface LocalServiceDeps {
  /** Bind a configured root to a FolderAdapter. Node: createFsFolderAdapter(root); a browser returns
   *  its picked directory-handle adapter (the root string is an opaque label there). */
  adapterFor(root: string): FolderAdapter;
  /** Root validation for PUT /local/config (Node: node:path isAbsolute; browser: accept its labels). */
  isAbsolute(root: string): boolean;
  /** Canonicalize the root before persisting it (Node: path resolve; browser: identity). */
  resolveRoot(root: string): string;
  /** Decode-summary cache persistence (Node: the classic DATA_DIR/localScan.json sidecar). */
  scanCache: ScanCachePersistence;
  /** sha256 for the Sync/ restore verification (Node: nodeCodec.sha256Hex). */
  sha256Hex(bytes: Uint8Array): string;
  /** Config persistence (`local` collection) + the version store the Sync/ mirror reads/writes. */
  store: Store;
  /** Offline preset decode (model-byte dispatched; throws on non-preset bytes) — handlers.decodeBytes. */
  decode: DecodeFn;
}

// ─────────────────────────── config (root path) ───────────────────────────
interface LocalCfg { root: string | null; lastSync: number | null }

export function createLocalService(deps: LocalServiceDeps) {
  const { adapterFor, store } = deps;
  const cfg = (): LocalCfg => {
    const d = store.getDoc('local', 'config')?.data as Partial<LocalCfg> | undefined;
    return { root: typeof d?.root === 'string' ? d.root : null, lastSync: typeof d?.lastSync === 'number' ? d.lastSync : null };
  };
  const saveCfg = (c: LocalCfg) => store.putDoc('local', 'config', c);

  const configState = async () => {
    const c = cfg();
    const ad = c.root ? adapterFor(c.root) : null;
    const exists = !!ad && (await ad.exists(''));
    return {
      configured: !!c.root,
      root: c.root,
      exists,
      writable: exists ? await writableProbe(ad!) : false,
      lastSync: c.lastSync
    };
  };

  /** Common gate: 409 unless a root is configured and present; returns the root or the error result. */
  const needRoot = async (): Promise<string | LocalResult> => {
    const c = cfg();
    if (!c.root) return { status: 409, body: { error: 'not configured' } };
    if (!(await adapterFor(c.root).exists(''))) return { status: 409, body: { error: 'root missing' } };
    return c.root;
  };
  let syncBusy = false;

  return {
    async config(): Promise<LocalResult> {
      return { status: 200, body: await configState() };
    },

    async setConfig(root: string | null | undefined): Promise<LocalResult> {
      const r = root ?? null;
      if (r === null) { saveCfg({ root: null, lastSync: null }); return { status: 200, body: await configState() }; }
      if (typeof r !== 'string' || !deps.isAbsolute(r)) return { status: 400, body: { error: 'absolute path required' } };
      const ad = adapterFor(r);
      try {
        await ad.mkdir(PRESETS_SUB);
        await ad.mkdir(SYNC_SUB);
      } catch (e) { return { status: 400, body: { error: `cannot create folders: ${(e as Error).message}` } }; }
      if (!(await writableProbe(ad))) return { status: 400, body: { error: 'folder is not writable' } };
      saveCfg({ root: deps.resolveRoot(r), lastSync: cfg().lastSync });
      return { status: 200, body: await configState() };
    },

    // Browse the Presets/ library: recursive scan with an mtime-keyed decode cache (refresh re-decodes all)
    async presets(refresh: boolean): Promise<LocalResult> {
      const root = await needRoot();
      if (typeof root !== 'string') return root;
      const r = await scanPresets(adapterFor(root), deps.decode, refresh, deps.scanCache);
      return { status: 200, body: { root, ...r } };
    },

    // Raw .syx bytes of one library file (audition/export path — fetched on demand, never cached client-side)
    async presetFile(path: string | undefined): Promise<LocalResult> {
      const root = await needRoot();
      if (typeof root !== 'string') return root;
      const rel = path ? safeRel(path) : null;
      if (rel == null || !isSyx(rel)) return { status: 400, body: { error: 'bad path' } };
      const ad = adapterFor(root);
      if (!(await ad.exists(`${PRESETS_SUB}/${rel}`))) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: await ad.readFile(`${PRESETS_SUB}/${rel}`) };
    },

    // Export a preset INTO the library folder. Two addressing modes:
    //   name (+ optional dir) — builds a sanitized `<name>.syx` (new exports);
    //   path                  — EXACT relative path, for writing back to the file a preset was
    //                           loaded from (save-to-disk), immune to name re-sanitizing.
    async writePreset(body: { name?: string; dir?: string; path?: string; bytes?: number[]; overwrite?: boolean } | undefined): Promise<LocalResult> {
      const root = await needRoot();
      if (typeof root !== 'string') return root;
      const { name, dir, path, bytes, overwrite } = body ?? {};
      if (!Array.isArray(bytes) || !bytes.length) return { status: 400, body: { error: 'bytes[] required' } };
      let rel: string;
      if (path) {
        const r = safeRel(path);
        if (r == null || !isSyx(r)) return { status: 400, body: { error: 'bad path' } };
        rel = r;
      } else {
        const relDir = dir ? safeRel(dir) : '';
        if (relDir == null) return { status: 400, body: { error: 'bad dir' } };
        rel = `${relDir ? `${relDir}/` : ''}${sanitize(name ?? 'preset')}.syx`;
      }
      const ad = adapterFor(root);
      const file = `${PRESETS_SUB}/${rel}`;
      if ((await ad.exists(file)) && !overwrite) return { status: 409, body: { error: 'exists', path: rel } };
      try {
        await ad.mkdir(file.split('/').slice(0, -1).join('/'));
        await ad.writeFile(file, Uint8Array.from(bytes));
      } catch (e) { return { status: 500, body: { error: (e as Error).message } }; }
      return { status: 200, body: { ok: true, path: rel } };
    },

    // Mirror the version store → Sync/ (incremental; never deletes user files)
    async sync(): Promise<LocalResult> {
      const root = await needRoot();
      if (typeof root !== 'string') return root;
      if (syncBusy) return { status: 409, body: { error: 'busy' } };
      syncBusy = true;
      try {
        const r = await syncToFolder(adapterFor(root), store);
        saveCfg({ root, lastSync: Date.now() });
        return { status: 200, body: r };
      }
      catch (e) { return { status: 500, body: { error: (e as Error).message } }; }
      finally { syncBusy = false; }
    },

    // Re-import Sync/ versions into the version store (fresh machine / data loss), sha256-verified
    async restore(): Promise<LocalResult> {
      const root = await needRoot();
      if (typeof root !== 'string') return root;
      if (syncBusy) return { status: 409, body: { error: 'busy' } };
      syncBusy = true;
      try { return { status: 200, body: await restoreFromFolder(adapterFor(root), store, deps.sha256Hex) }; }
      catch (e) { return { status: 500, body: { error: (e as Error).message } }; }
      finally { syncBusy = false; }
    }
  };
}

export type LocalService = ReturnType<typeof createLocalService>;
