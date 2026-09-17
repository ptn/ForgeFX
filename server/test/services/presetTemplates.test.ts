// Unit tests for services/presetTemplates.ts — the caller-selected templates directory scan/read/write.
// Pure fake fs for discovery; a real temp dir for the write path. No hardware, no transport.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverTemplateFiles,
  readTemplateBytes,
  sanitizeTemplateName,
  writeTemplateFile,
  type TemplateFs
} from '../../src/services/presetTemplates.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const PRESET_TEMPLATES_CASE_COUNT = 5;

function fakeFs(tree: Record<string, string[]>, statOf: Record<string, { size: number; mtimeMs: number }>, bytes: Record<string, number[]> = {}): TemplateFs {
  return {
    readdirSync: (p) => { const entries = tree[p]; if (!entries) throw new Error('ENOENT'); return entries; },
    statSync: (p) => { const stat = statOf[p]; if (!stat) throw new Error('ENOENT'); return stat; },
    readFileSync: (p) => { const b = bytes[p]; if (!b) throw new Error('ENOENT'); return Uint8Array.from(b); }
  };
}

function discoveryFiltersAndSorts(): void {
  const dir = '/templates';
  const fs = fakeFs(
    { [dir]: ['.hidden.syx', 'zeta.syx', 'Alpha.syx', 'notes.txt', 'big.syx', 'empty.syx'] },
    {
      [join(dir, 'zeta.syx')]: { size: 100, mtimeMs: 1_700_000_000_000 },
      [join(dir, 'Alpha.syx')]: { size: 200, mtimeMs: 1_700_000_100_000 },
      [join(dir, 'big.syx')]: { size: 3 * 1024 * 1024, mtimeMs: 1 },
      [join(dir, 'empty.syx')]: { size: 0, mtimeMs: 1 }
    }
  );
  const out = discoverTemplateFiles(dir, fs);
  assertEqual(out.length, 2, 'hidden/non-syx/oversized/empty files are skipped');
  assertEqual(out[0]!.name, 'Alpha', 'candidates are name-sorted');
  assertEqual(out[1]!.name, 'zeta', 'the second candidate follows');
  assert(out.every((c) => c.path.startsWith(dir)), 'paths stay inside the supplied directory');
}

function discoveryOfMissingDirIsEmpty(): void {
  assertEqual(discoverTemplateFiles('/missing', fakeFs({}, {})).length, 0, 'a missing directory yields no candidates');
}

function readIsConstrainedToDiscoveredSet(): void {
  const dir = '/templates';
  const fs = fakeFs(
    { [dir]: ['ok.syx'] },
    { [join(dir, 'ok.syx')]: { size: 10, mtimeMs: 1 } },
    { [join(dir, 'ok.syx')]: [1, 2, 3] }
  );
  assertEqual(readTemplateBytes(dir, join(dir, 'ok.syx'), fs)?.length, 3, 'a discovered file reads');
  assertEqual(readTemplateBytes(dir, '/etc/passwd', fs), null, 'a path outside the set reads nothing');
  assertEqual(readTemplateBytes('/missing', join('/missing', 'x.syx'), fs), null, 'a missing dir reads nothing');
}

function nameSanitization(): void {
  assertEqual(sanitizeTemplateName('  MATEUS  '), 'MATEUS', 'trims');
  assertEqual(sanitizeTemplateName('Clean Amp.syx'), 'Clean Amp', 'strips a trailing .syx');
  assertEqual(sanitizeTemplateName(''), null, 'empty is rejected');
  assertEqual(sanitizeTemplateName('   '), null, 'whitespace-only is rejected');
  assertEqual(sanitizeTemplateName('a/b'), null, 'path separators are rejected');
  assertEqual(sanitizeTemplateName('..'), null, 'dot-dot is rejected');
  assertEqual(sanitizeTemplateName('.hidden'), null, 'a leading dot is rejected');
  assertEqual(sanitizeTemplateName('x'.repeat(100))?.length, 64, 'long names are truncated to 64');
}

function writeCreatesAndRefusesOverwrite(): void {
  const dir = mkdtempSync(join(tmpdir(), 'forgefx-templates-'));
  try {
    const first = writeTemplateFile(dir, 'MATEUS', Uint8Array.from([9, 8, 7]), false);
    assert(first.ok, 'a fresh write succeeds');
    if (first.ok) assertEqual(first.path, join(dir, 'MATEUS.syx'), 'writes <name>.syx');
    assertEqual([...readFileSync(join(dir, 'MATEUS.syx'))].join(','), '9,8,7', 'bytes land on disk');
    const again = writeTemplateFile(dir, 'MATEUS', Uint8Array.from([1]), false);
    assert(!again.ok && again.code === 409, 'an existing file is refused without overwrite');
    const forced = writeTemplateFile(dir, 'MATEUS', Uint8Array.from([1, 2]), true);
    assert(forced.ok, 'overwrite replaces the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runPresetTemplatesTests(): Promise<void> {
  discoveryFiltersAndSorts();
  discoveryOfMissingDirIsEmpty();
  readIsConstrainedToDiscoveredSet();
  nameSanitization();
  writeCreatesAndRefusesOverwrite();
}
