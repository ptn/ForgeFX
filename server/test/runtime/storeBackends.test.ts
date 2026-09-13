// Direct unit tests for the StoreBackend implementations: memStoreBackend (Maps) and fsStoreBackend
// (Node fs under a temp dir), plus the node Codec (brotli + sha256). Verifies the clone/alias
// isolation and the on-disk sidecar behavior the store logic relies on.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { createFsStoreBackend, nodeCodec, DATA_DIR } from '../../src/runtime/fsStoreBackend.js';
import type { Doc, PresetVersion, StoreBackend } from '../../src/runtime/storeBackend.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const STORE_BACKENDS_CASE_COUNT = 11;

const doc = (id: string, data: unknown): Doc => ({ id, collection: 'things', data, updatedAt: 1, rev: 1 });
const version = (id: string): PresetVersion => ({ id, location: 0, crc: 1, hash: `h-${id}`, name: id, model: 'FM3', capturedAt: 1, source: 'manual', bytes: 3, stored: 3 });

/** The backend-agnostic contract assertions (run against both implementations). */
async function exercise(name: string, backend: StoreBackend): Promise<void> {
  assertEqual(backend.getDoc('things', 'a'), null, `${name}: missing doc → null`);
  backend.putDoc(doc('a', { n: 1 }));
  assertEqual((backend.getDoc('things', 'a')!.data as { n: number }).n, 1, `${name}: put/get doc`);
  // returned doc is a copy — mutating it must not corrupt the store
  const got = backend.getDoc('things', 'a')!;
  (got.data as { n: number }).n = 99;
  assertEqual((backend.getDoc('things', 'a')!.data as { n: number }).n, 1, `${name}: getDoc isolates`);
  assertEqual(backend.listDocs('things').length, 1, `${name}: listDocs`);

  backend.putVersion(version('v1'));
  backend.putVersion(version('v2'));
  assertEqual(backend.listVersions().length, 2, `${name}: putVersion appends`);
  backend.putVersion({ ...version('v1'), name: 'updated' });
  assertEqual(backend.listVersions().find((v) => v.id === 'v1')!.name, 'updated', `${name}: putVersion replaces`);
  backend.deleteVersions(['v1']);
  assertEqual(backend.listVersions().length, 1, `${name}: deleteVersions`);

  assertEqual(backend.hasBlob('b'), false, `${name}: missing blob`);
  backend.putBlob('b', Uint8Array.from([1, 2, 3]));
  assertEqual(backend.hasBlob('b'), true, `${name}: put/has blob`);
  const blob = backend.getBlob('b')!;
  blob[0] = 9;
  assertEqual(backend.getBlob('b')![0], 1, `${name}: getBlob isolates`);
  backend.deleteBlob('b');
  backend.deleteBlob('missing'); // no-op
  assertEqual(backend.getBlob('b'), null, `${name}: deleteBlob`);

  assertEqual(backend.getJSON('sidecar', { x: 1 }).x, 1, `${name}: JSON fallback`);
  backend.putJSON('sidecar', { x: 2 });
  assertEqual(backend.getJSON('sidecar', { x: 1 }).x, 2, `${name}: JSON round-trip`);
}

export async function runStoreBackendTests(): Promise<void> {
  // 1. in-memory backend satisfies the full contract.
  await exercise('mem', createMemStoreBackend());

  // 2-7. filesystem backend satisfies the same contract, persisting under a temp data dir.
  const dir = mkdtempSync(join(tmpdir(), 'forgefx-fsbackend-'));
  try {
    const fs = createFsStoreBackend(dir);
    await exercise('fs', fs);
    assertEqual(existsSync(join(dir, 'store', 'things.json')), true, 'fs persists the doc collection');
    assertEqual(existsSync(join(dir, 'versions', 'index.json')), true, 'fs persists the version index');
    // 8. sidecar JSON: pretty + atomic write reads back, and a corrupt file falls back.
    fs.putJSON('pretty', { a: 1 }, { pretty: true, atomic: true });
    assertEqual(fs.getJSON('pretty', { a: 0 }).a, 1, 'fs pretty/atomic JSON round-trip');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'broken.json'), '{not json');
    assertEqual(fs.getJSON('broken', { ok: true }).ok, true, 'fs corrupt JSON → fallback');
    // 9. a fresh backend over the same dir sees the persisted state (stateless re-read).
    const fs2 = createFsStoreBackend(dir);
    assertEqual((fs2.getDoc('things', 'a')!.data as { n: number }).n, 1, 'fs re-reads persisted docs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 10. nodeCodec round-trips bytes and produces a stable, content-sensitive sha256.
  {
    const raw = Uint8Array.from({ length: 256 }, (_, i) => i & 0x7f);
    const packed = nodeCodec.pack(raw);
    assert(packed.length < raw.length, 'brotli shrinks 7-bit data');
    assertEqual(Buffer.from(nodeCodec.unpack(packed)).equals(Buffer.from(raw)), true, 'codec round-trip');
    const h1 = nodeCodec.sha256Hex(raw);
    assertEqual(h1, nodeCodec.sha256Hex(raw), 'sha256 stable');
    assert(h1 !== nodeCodec.sha256Hex(Uint8Array.from([...raw, 1])), 'sha256 content-sensitive');
  }
  // 11. DATA_DIR resolves to a path (env override or ~/.axis).
  assert(typeof DATA_DIR === 'string' && DATA_DIR.length > 0, 'DATA_DIR resolved');
}
