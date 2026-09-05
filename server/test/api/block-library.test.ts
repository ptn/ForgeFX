// Saved-block libraries are selected explicitly by the caller; ForgeFX must not inspect editor settings.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../helpers/env.js';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { discoverBlockFiles, expandHomePath, type DiscoveryFs } from '../../src/services/editorCacheDiscovery.js';
import { decodeBlockFile } from '../../src/services/blockLibraryImport.js';
import { slugForFolder } from '../../src/services/blockLibrarySave.js';
import { assert, assertEqual } from '../helpers/mock.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'block-library');

export const BLOCK_LIBRARY_CASE_COUNT = 6;

function fakeFs(tree: Record<string, string[]>, statOf: Record<string, { size: number; mtimeMs: number }>): DiscoveryFs {
  return {
    existsSync: (p) => p in tree,
    readdirSync: (p) => { const entries = tree[p]; if (!entries) throw new Error('ENOENT'); return entries; },
    statSync: (p) => { const stat = statOf[p]; if (!stat) throw new Error('ENOENT'); return stat; },
  };
}

function discoveryUsesSuppliedLibrary(): void {
  const library = '/chosen/library';
  const fs = fakeFs({
    [library]: ['Drive', 'root-level.blk'],
    [join(library, 'Drive')]: ['RAT_20240906_111259.blk', 'notes.txt'],
  }, {
    [join(library, 'root-level.blk')]: { size: 564, mtimeMs: 1_700_000_000_000 },
    [join(library, 'Drive', 'RAT_20240906_111259.blk')]: { size: 564, mtimeMs: 1_700_000_000_000 },
  });

  const candidates = discoverBlockFiles(library, fs);
  assertEqual(candidates.length, 2, 'root file and category file found in the supplied library');
  assert(candidates.every((candidate) => candidate.blocksDir === library), 'every candidate identifies the supplied library');
  assert(candidates.some((candidate) => candidate.category === null && candidate.name === 'root-level'), 'root file is included');
  assert(candidates.some((candidate) => candidate.category === 'Drive' && candidate.name === 'RAT'), 'category name and timestamp stripping work');
}

function discoveryIgnoresMissingLibrary(): void {
  assertEqual(discoverBlockFiles('/missing', fakeFs({}, {})).length, 0, 'missing selected library yields no candidates');
}

function folderSlugMatching(): void {
  assertEqual(slugForFolder('Parametric EQ'), 'peq', 'folder name maps to the peq pack slug');
  assertEqual(slugForFolder('Wahwah'), 'wah', 'folder name maps to the wah pack slug');
  assertEqual(slugForFolder('Multi Delay'), 'multitap', 'folder name maps to the multitap pack slug');
  assertEqual(slugForFolder('Drive'), 'drive', 'verbatim folder names map through');
  assertEqual(slugForFolder(null), null, 'a root-level file has no slug');
  assertEqual(slugForFolder('Nope'), null, 'an unmapped folder resolves to null');
}

function expandsHomeLibraryPath(): void {
  assertEqual(expandHomePath('~/Documents/Fractal Audio/FM3-Edit/blocks', '/Users/axis'), '/Users/axis/Documents/Fractal Audio/FM3-Edit/blocks', 'expands the user-facing home shorthand');
  assertEqual(expandHomePath('/chosen/library', '/Users/axis'), '/chosen/library', 'leaves absolute paths untouched');
}

async function decodeFixtureEndpoint(): Promise<void> {
  const registry = __createRegistryForTest({ resolveConn: async () => null, openConn: () => { throw new Error('no conn'); } });
  const app = await buildApp(registry);
  try {
    const bytes = readFileSync(join(FIXTURES, 'rat.blk'));
    const res = await app.inject({
      method: 'POST', url: '/fm3edit/blocks/decode', headers: { 'content-type': 'application/octet-stream' }, payload: bytes,
    });
    assertEqual(res.statusCode, 200, 'decode accepts a raw .blk body');
    const body = res.json() as { name: string; device: string; slug: string; activeChannel: number; channels: unknown[] };
    assertEqual(body.name, 'RAT', 'decoded name');
    assertEqual(body.device, 'FM3', 'decoded device label');
    assertEqual(body.activeChannel, 3, 'decoded active channel');
    assertEqual(body.channels.length, 4, 'four channels decoded');
    assertEqual(decodeBlockFile(new Uint8Array(bytes)).slug, 'drive', 'module-level decode works');
  } finally {
    await app.close();
  }
}

async function sourcesRequireLibraryPath(): Promise<void> {
  const registry = __createRegistryForTest({ resolveConn: async () => null, openConn: () => { throw new Error('no conn'); } });
  const app = await buildApp(registry);
  try {
    const missing = await app.inject({ method: 'GET', url: '/fm3edit/blocks/sources' });
    assertEqual(missing.statusCode, 400, 'sources requires an explicit library path');

    const sources = await app.inject({ method: 'GET', url: '/fm3edit/blocks/sources', query: { libraryPath: FIXTURES } });
    assertEqual(sources.statusCode, 200, 'sources scans the supplied library path');
    const body = sources.json() as { candidates: Array<{ path: string }> };
    assertEqual(body.candidates.length, 1, 'fixture library has one block');
    assertEqual(body.candidates[0]!.path, join(FIXTURES, 'rat.blk'), 'listed file belongs to the supplied library');
  } finally {
    await app.close();
  }
}

async function decodeRejections(): Promise<void> {
  const registry = __createRegistryForTest({ resolveConn: async () => null, openConn: () => { throw new Error('no conn'); } });
  const app = await buildApp(registry);
  try {
    const bad = await app.inject({ method: 'POST', url: '/fm3edit/blocks/decode', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from([1, 2, 3]) });
    assertEqual(bad.statusCode, 422, 'malformed bytes return 422');

    const noLibrary = await app.inject({ method: 'POST', url: '/fm3edit/blocks/decode', payload: { path: join(FIXTURES, 'rat.blk') } });
    assertEqual(noLibrary.statusCode, 400, 'file decode requires the selected library path');

    const outsideLibrary = await app.inject({ method: 'POST', url: '/fm3edit/blocks/decode', payload: { path: '/etc/passwd', libraryPath: FIXTURES } });
    assertEqual(outsideLibrary.statusCode, 400, 'file outside the selected library is never read');
  } finally {
    await app.close();
  }
}

export async function runBlockLibraryTests(): Promise<void> {
  discoveryUsesSuppliedLibrary();
  discoveryIgnoresMissingLibrary();
  folderSlugMatching();
  expandsHomeLibraryPath();
  await decodeFixtureEndpoint();
  await sourcesRequireLibraryPath();
  await decodeRejections();
}
