// Direct unit tests for runtime/localFolder.ts (browser-safe local-storage folder logic) — no disk,
// no device. Exercises the traversal guard, the Presets/ scan (decode cache, skips, truncation) and
// the Sync/ mirror + restore round-trip over an in-memory FolderAdapter.
import { createHash } from 'node:crypto';
import {
  safeRel, sanitize, isSyx, writableProbe, scanPresets, syncToFolder, restoreFromFolder,
  PRESETS_SUB, SYNC_SUB, type ScanCache, type ScanCachePersistence, type DecodeFn,
} from '../../src/runtime/localFolder.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { createStore } from '../../src/runtime/store.js';
import type { StoreCodec } from '../../src/runtime/storeBackend.js';
import { MemFolderAdapter } from '../helpers/fakeFolder.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const LOCAL_FOLDER_CASE_COUNT = 16;

const codec: StoreCodec = {
  pack: (b) => b,
  unpack: (b) => b,
  sha256Hex: (b) => createHash('sha256').update(b).digest('hex'),
};
const newStore = () => createStore(createMemStoreBackend(), codec);
const bytes = (...xs: number[]) => Uint8Array.from(xs);

function memCache(): ScanCachePersistence & { value: ScanCache; saves: number } {
  const box = {
    value: {} as ScanCache,
    saves: 0,
    load(): ScanCache { return this.value; },
    save(c: ScanCache): void { this.value = c; this.saves++; },
  };
  return box;
}

const decodeOk: DecodeFn = async (b) => ({ name: `P${b[0]}`, params: { big: 'x' }, size: b.length });

export async function runLocalFolderTests(): Promise<void> {
  // 1. safeRel accepts in-root relatives and collapses '.' segments.
  assertEqual(safeRel('a/./b'), 'a/b', 'safeRel collapses dot');
  assertEqual(safeRel('a\\b'), 'a/b', 'safeRel normalizes backslashes');
  // 2. safeRel rejects absolute paths, NUL, and traversal past the root.
  assertEqual(safeRel('/etc/passwd'), null, 'safeRel rejects absolute');
  assertEqual(safeRel('C:\\win'), null, 'safeRel rejects drive letters');
  assertEqual(safeRel('a/../../b'), null, 'safeRel rejects escape');
  assertEqual(safeRel('a\0b'), null, 'safeRel rejects NUL');
  // 3. internal '..' is allowed and pops a prior segment.
  assertEqual(safeRel('a/b/../c'), 'a/c', 'safeRel allows internal dotdot');
  // 4. sanitize strips fs-illegal chars, trailing dots/spaces, bounds length, and falls back.
  assertEqual(sanitize('a/b:c*?'), 'a_b_c_', 'sanitize replaces illegal');
  assertEqual(sanitize('name... '), 'name', 'sanitize trims trailing dots/spaces');
  assertEqual(sanitize(''), 'preset', 'sanitize empty fallback');
  assertEqual(sanitize('x'.repeat(200)).length, 80, 'sanitize bounded');
  // 5. isSyx is case-insensitive.
  assertEqual(isSyx('A.SYX') && isSyx('a.syx') && !isSyx('a.txt'), true, 'isSyx case-insensitive');
  // 6. writableProbe true on a writable adapter, false on a read-only one.
  {
    const ad = new MemFolderAdapter();
    assertEqual(await writableProbe(ad), true, 'writableProbe true');
    ad.readOnly = true;
    assertEqual(await writableProbe(ad), false, 'writableProbe false (read-only)');
  }
  // 7. scanPresets decodes .syx, strips params, derives names, and skips non-presets.
  {
    const ad = new MemFolderAdapter();
    await ad.mkdir(PRESETS_SUB);
    await ad.writeFile(`${PRESETS_SUB}/a.syx`, bytes(1));
    await ad.mkdir(`${PRESETS_SUB}/sub`);
    await ad.writeFile(`${PRESETS_SUB}/sub/b.syx`, bytes(2));
    await ad.writeFile(`${PRESETS_SUB}/.hidden.syx`, bytes(3)); // hidden
    await ad.writeFile(`${PRESETS_SUB}/notes.txt`, bytes(4));    // non-syx
    await ad.writeFile(`${PRESETS_SUB}/empty.syx`, bytes());      // zero-size
    const cache = memCache();
    const r = await scanPresets(ad, decodeOk, false, cache);
    assertEqual(r.entries.length, 2, 'scan decoded two presets');
    assertEqual(r.entries[0]!.path, 'a.syx', 'scan path is Presets/-relative');
    assertEqual(r.entries[0]!.name, 'P1', 'scan uses decoded name');
    assertEqual('params' in r.entries[0]!.summary, false, 'scan strips params from summary');
    assertEqual(r.entries[1]!.path, 'sub/b.syx', 'scan recurses');
    assertEqual(cache.saves, 1, 'scan persisted the cache');
  }
  // 8. a decode failure is skipped and negative-cached.
  {
    const ad = new MemFolderAdapter();
    await ad.mkdir(PRESETS_SUB);
    await ad.writeFile(`${PRESETS_SUB}/bad.syx`, bytes(9));
    const fail: DecodeFn = async () => { throw new Error('not a preset'); };
    const r = await scanPresets(ad, fail, false, memCache());
    assertEqual(r.entries.length, 0, 'failed decode yields no entry');
    assertEqual(r.skipped, 1, 'failed decode is skipped');
  }
  // 9. mtime cache suppresses re-decode; refresh/force re-decodes.
  {
    const ad = new MemFolderAdapter();
    await ad.mkdir(PRESETS_SUB);
    await ad.writeFile(`${PRESETS_SUB}/a.syx`, bytes(1));
    let decodes = 0;
    const decode: DecodeFn = async () => { decodes++; return { name: 'n' }; };
    const cache = memCache();
    await scanPresets(ad, decode, false, cache);
    await scanPresets(ad, decode, false, cache);
    assertEqual(decodes, 1, 'second scan hits the mtime cache');
    await scanPresets(ad, decode, true, cache);
    assertEqual(decodes, 2, 'force re-decodes');
  }
  // 10. syncToFolder mirrors versions to Sync/ (index + raw .syx), then skips on a second run.
  {
    const ad = new MemFolderAdapter();
    await ad.mkdir(SYNC_SUB);
    const store = newStore();
    const v1 = store.addPresetVersion({ location: 1, crc: 10, name: 'Alpha', model: 'FM3', source: 'manual' }, bytes(0xf0, 1, 0xf7))!;
    const bk = store.createBackup('Full backup', 'FM3');
    const v2 = store.addPresetVersion({ location: 2, crc: 20, name: 'Beta', model: 'FM3', source: 'backup', backupId: bk.id }, bytes(0xf0, 2, 0xf7))!;
    const first = await syncToFolder(ad, store);
    assertEqual(first.written, 2, 'sync wrote both versions');
    assertEqual(first.backups, 1, 'sync recorded the backup dir');
    assertEqual(await ad.exists(`${SYNC_SUB}/index.json`), true, 'sync wrote the index');
    assert(first.total === 2, 'sync index has two versions');
    // both raw .syx files landed somewhere under Sync/
    const files = [...ad.files.keys()].filter((k) => k.endsWith('.syx'));
    assertEqual(files.length, 2, 'sync wrote two .syx files');
    const second = await syncToFolder(ad, store);
    assertEqual(second.written, 0, 'second sync writes nothing');
    assertEqual(second.skippedExisting, 2, 'second sync skips existing');
    // 11. restore re-imports missing versions, then skips existing ones.
    const store2 = newStore();
    const restored = await restoreFromFolder(ad, store2, codec.sha256Hex);
    assertEqual(restored.imported, 2, 'restore imported both');
    assertEqual(store2.hasPresetVersion(v1.id) && store2.hasPresetVersion(v2.id), true, 'restored ids present');
    const again = await restoreFromFolder(ad, store2, codec.sha256Hex);
    assertEqual(again.skippedExisting, 2, 're-restore skips existing');
  }
  // 12. restore skips a version whose stored file fails the sha256 check, and a missing file.
  {
    const ad = new MemFolderAdapter();
    await ad.mkdir(SYNC_SUB);
    const store = newStore();
    store.addPresetVersion({ location: 0, crc: 1, name: 'X', model: 'FM3', source: 'manual' }, bytes(0xf0, 7, 0xf7));
    await syncToFolder(ad, store);
    const idx = JSON.parse(new TextDecoder().decode(await ad.readFile(`${SYNC_SUB}/index.json`))) as { versions: { id: string; hash: string; file: string }[] };
    idx.versions[0]!.hash = 'deadbeef'; // force a mismatch
    await ad.writeFile(`${SYNC_SUB}/index.json`, new TextEncoder().encode(JSON.stringify(idx)));
    const r = await restoreFromFolder(ad, newStore(), codec.sha256Hex);
    assertEqual(r.skippedBad, 1, 'hash mismatch → skippedBad');
    // missing file path
    idx.versions[0]!.hash = 'deadbeef';
    idx.versions[0]!.file = 'does/not/exist.syx';
    await ad.writeFile(`${SYNC_SUB}/index.json`, new TextEncoder().encode(JSON.stringify(idx)));
    const r2 = await restoreFromFolder(ad, newStore(), codec.sha256Hex);
    assertEqual(r2.skippedBad, 1, 'missing file → skippedBad');
  }
}
