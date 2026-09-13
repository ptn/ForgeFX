// Direct unit tests for runtime/localService.ts — the shared /local/* route logic (config lifecycle,
// Presets/ scan + file read, library write, Sync/ mirror + restore) over an in-memory adapter and
// store. Verifies status codes and bodies the Fastify + browser surfaces must serve identically.
import { createHash } from 'node:crypto';
import { createLocalService, type LocalServiceDeps } from '../../src/runtime/localService.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { createStore, type Store } from '../../src/runtime/store.js';
import type { StoreCodec } from '../../src/runtime/storeBackend.js';
import { MemFolderAdapter } from '../helpers/fakeFolder.js';
import { assertEqual } from '../helpers/mock.js';

export const LOCAL_SERVICE_CASE_COUNT = 15;

const codec: StoreCodec = {
  pack: (b) => b,
  unpack: (b) => b,
  sha256Hex: (b) => createHash('sha256').update(b).digest('hex'),
};

function harness(): { svc: ReturnType<typeof createLocalService>; adapters: Map<string, MemFolderAdapter>; store: Store } {
  const adapters = new Map<string, MemFolderAdapter>();
  const store = createStore(createMemStoreBackend(), codec);
  const resolveRoot = (r: string) => r.replace(/\/+$/, '') || '/';
  const deps: LocalServiceDeps = {
    // key by the canonical root, matching how the real Node adapterFor binds an absolute path
    adapterFor: (root) => { const k = resolveRoot(root); let a = adapters.get(k); if (!a) { a = new MemFolderAdapter(); adapters.set(k, a); } return a; },
    isAbsolute: (r) => r.startsWith('/'),
    resolveRoot,
    scanCache: { load: () => ({}), save: () => {} },
    sha256Hex: codec.sha256Hex,
    store,
    decode: async (b) => ({ name: `P${b[0]}` }),
  };
  return { svc: createLocalService(deps), adapters, store };
}

export async function runLocalServiceTests(): Promise<void> {
  // 1. unconfigured status.
  {
    const { svc } = harness();
    const r = await svc.config();
    assertEqual(r.code, 200, 'config 200');
    assertEqual((r.body as { configured: boolean }).configured, false, 'config not configured');
  }
  // 2. a relative root is rejected.
  {
    const { svc } = harness();
    const r = await svc.setConfig('relative/path');
    assertEqual(r.code, 400, 'relative root → 400');
  }
  // 3. an absolute root is accepted, creates Presets/ + Sync/, and probes writable.
  {
    const { svc, adapters } = harness();
    const r = await svc.setConfig('/data/fx/');
    assertEqual(r.code, 200, 'setConfig 200');
    const body = r.body as { configured: boolean; root: string; exists: boolean; writable: boolean };
    assertEqual(body.configured && body.exists && body.writable, true, 'configured + writable');
    assertEqual(body.root, '/data/fx', 'root canonicalized (trailing slash trimmed)');
    assertEqual(await adapters.get('/data/fx')!.exists('Presets'), true, 'Presets/ created');
    assertEqual(await adapters.get('/data/fx')!.exists('Sync'), true, 'Sync/ created');
  }
  // 4. setConfig(null) clears.
  {
    const { svc } = harness();
    await svc.setConfig('/data/fx');
    const r = await svc.setConfig(null);
    assertEqual((r.body as { configured: boolean }).configured, false, 'cleared config');
  }
  // 5. a non-writable root is rejected.
  {
    const { svc, adapters } = harness();
    await svc.setConfig('/ro');
    adapters.get('/ro')!.readOnly = true;
    const r = await svc.setConfig('/ro');
    assertEqual(r.code, 400, 'read-only root → 400');
    assertEqual((r.body as { error: string }).error, 'folder is not writable', 'read-only message');
  }
  // 6. routes gate on a configured+present root (409 when root vanished).
  {
    const { svc, adapters } = harness();
    const unconfigured = await svc.presets(false);
    assertEqual(unconfigured.code, 409, 'presets without root → 409');
    await svc.setConfig('/gone');
    adapters.get('/gone')!.dirs.delete(''); // simulate the root disappearing
    const missing = await svc.presetFile('a.syx');
    assertEqual(missing.code, 409, 'missing root → 409');
  }
  // 7. writePreset requires bytes, then writes a sanitized .syx into Presets/.
  {
    const { svc, adapters } = harness();
    await svc.setConfig('/lib');
    assertEqual((await svc.writePreset(undefined)).code, 400, 'no body → 400');
    assertEqual((await svc.writePreset({ bytes: [] })).code, 400, 'empty bytes → 400');
    const w = await svc.writePreset({ name: 'My Sound?', bytes: [1, 2, 3] });
    assertEqual(w.code, 200, 'writePreset 200');
    assertEqual((w.body as { path: string }).path, 'My Sound_.syx', 'name sanitized');
    assertEqual(await adapters.get('/lib')!.exists('Presets/My Sound_.syx'), true, 'file written');
    // 8. refusing to overwrite unless asked.
    assertEqual((await svc.writePreset({ name: 'My Sound?', bytes: [1] })).code, 409, 'existing → 409');
    assertEqual((await svc.writePreset({ name: 'My Sound?', bytes: [9], overwrite: true })).code, 200, 'overwrite ok');
    // 9. path mode writes to an exact relative path; traversal/non-syx is refused.
    assertEqual((await svc.writePreset({ path: '../evil.syx', bytes: [1] })).code, 400, 'traversal path → 400');
    assertEqual((await svc.writePreset({ path: 'x.txt', bytes: [1] })).code, 400, 'non-syx path → 400');
    const p = await svc.writePreset({ path: 'sub/deep.syx', bytes: [4, 5] });
    assertEqual((p.body as { path: string }).path, 'sub/deep.syx', 'exact path write');
  }
  // 10. presets() lists written library files; presetFile() serves raw bytes.
  {
    const { svc } = harness();
    await svc.setConfig('/lib');
    await svc.writePreset({ name: 'Alpha', bytes: [0xf0, 1, 0xf7] });
    const list = await svc.presets(false);
    assertEqual(list.code, 200, 'presets 200');
    const entries = (list.body as { entries: { path: string }[] }).entries;
    assertEqual(entries.length, 1, 'one library entry');
    assertEqual(entries[0]!.path, 'Alpha.syx', 'entry path');
    assertEqual((await svc.presetFile('Alpha.syx')).code, 200, 'presetFile 200');
    assertEqual((await svc.presetFile('missing.syx')).code, 404, 'presetFile missing → 404');
    assertEqual((await svc.presetFile('../x.syx')).code, 400, 'presetFile bad path → 400');
  }
  // 11-12. sync mirrors the store to Sync/, then restore re-imports into a fresh store.
  {
    const { svc, adapters, store } = harness();
    await svc.setConfig('/sync');
    store.addPresetVersion({ location: 1, crc: 5, name: 'V', model: 'FM3', source: 'manual' }, Uint8Array.from([0xf0, 1, 0xf7]));
    const s = await svc.sync();
    assertEqual(s.code, 200, 'sync 200');
    assertEqual((s.body as { written: number }).written, 1, 'sync wrote one version');
    assertEqual(await adapters.get('/sync')!.exists('Sync/index.json'), true, 'sync index written');
    // restore into a different service over the same adapter
    const h2 = harnessFor(adapters.get('/sync')!);
    await h2.svc.setConfig('/sync');
    const r = await h2.svc.restore();
    assertEqual(r.code, 200, 'restore 200');
    assertEqual((r.body as { imported: number }).imported, 1, 'restore imported one');
    const again = await h2.svc.restore();
    assertEqual((again.body as { skippedExisting: number }).skippedExisting, 1, 're-restore skips existing');
  }
  // 13. config() reports lastSync after a sync.
  {
    const { svc } = harness();
    await svc.setConfig('/s');
    await svc.sync();
    const c = (await svc.config()).body as { lastSync: number | null };
    assertEqual(typeof c.lastSync, 'number', 'lastSync recorded');
  }
}

/** A second service bound to one already-populated adapter (shares no store with the first). */
function harnessFor(adapter: MemFolderAdapter): { svc: ReturnType<typeof createLocalService> } {
  const store = createStore(createMemStoreBackend(), codec);
  const deps: LocalServiceDeps = {
    adapterFor: () => adapter,
    isAbsolute: () => true,
    resolveRoot: (r) => r,
    scanCache: { load: () => ({}), save: () => {} },
    sha256Hex: codec.sha256Hex,
    store,
    decode: async () => ({ name: 'x' }),
  };
  return { svc: createLocalService(deps) };
}
