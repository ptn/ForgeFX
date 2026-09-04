// Regenerate Axis's blockParams contract fixtures (amp/cab/reverb) from the REAL production driver
// over a mocked transport — the same no-hardware idiom as the ForgeFX unit tests. Writes the frozen
// GET /preset/blocks/:eid/params responses to Axis/src/lib/fixtures/blockParams/*.json.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createGen3Driver } from '../src/drivers/gen3.js';
import { cadenceFor } from '../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport } from '../test/helpers/mock.js';

const MODEL = 0x11;
const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const sysex = (fn: number, payload: readonly number[]): number[] => {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0; for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
};
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
const blockBulkFrames = (eid: number, values: readonly number[]): number[][] => {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
};

const eidFor = (slug: string): number => {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page;
};

// Default output: the sibling Axis checkout's fixture dir (this repo lives next to Axis in the work tree).
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? resolve(HERE, '../../../Axis/src/lib/fixtures/blockParams');

async function dump(slug: string, file: string): Promise<void> {
  const prof = PROFILES[MODEL]!;
  const eid = eidFor(slug);
  const codec = createModernFractalCodec(MODEL);
  const family = prof.familyForEffectId(eid) ?? 'DISTORT';
  const stride = prof.rangeSections[family]?.stride ?? 200;
  const values = new Array(stride * 4).fill(30000); // same raw value for every param (README)
  const status = sysex(0x13, [...enc14(eid), (1 << 1) | (4 << 4)]);
  const bulk = blockBulkFrames(eid, values);
  const mock = new MockTransport('serial', `mock-fixture-${slug}`);
  mock.isOpen = true;
  mock.reply = (req) => {
    if (compactHex(req) === compactHex(codec.buildStatusDump())) return [status];
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid))) return bulk;
    return [];
  };
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const r = await driver.blockParams(eid);
  writeFileSync(`${OUT}/${file}`, JSON.stringify(r, null, 2));
  console.log(`wrote ${file}: named=${r.named.length} enums=${r.enums.length} pages=${r.layout?.pages.length ?? 0}`);
}

async function main() {
  await dump('amp', 'amp.json');
  await dump('cab', 'cab.json');
  await dump('reverb', 'reverb.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
