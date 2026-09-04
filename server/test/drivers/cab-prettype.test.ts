// Cab PID-43 regression (the unsafe `/TYPE$/` model-selector fallback) + renderer geometry passthrough.
//
//   • CABINET has no `<CABINET>_MODEL`/`<CABINET>_TYPE`, so the old `/TYPE$/` fallback resolved the
//     block's model selector to `CABINET_PRETYPE` (pid 43) — which then dropped the real "Preamp Type"
//     dropdown from `enums` and served a dead "Preamp Type" readout. The fallback is removed; this
//     asserts `CABINET_PRETYPE` STAYS in enums, that CABINET has NO `type`, and that variant selection
//     still resolves (the cab has one unconditional-ish variant).
//   • The renderer profile (page `geometry` from PageLayout + control `bounds` from widget bounds)
//     passes through on the served layout, so Axis renders device-authored geometry.
// Mocked transport, no hardware — same idiom as modelbyte.test.ts.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, MODEL_SELECTOR_OVERRIDES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');

export const CAB_PRETTYPE_CASE_COUNT = 6;

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
function enc14(v: number): [number, number] { return [v & 0x7f, (v >> 7) & 0x7f]; }
function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(0x75, body),
    sysex(0x76, []),
  ];
}
function eidFor(slug: string): number {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page;
}

export async function runCabPrettypeTests(): Promise<void> {
  const prof = PROFILES[MODEL]!;
  const cab = eidFor('cab');
  const codec = createModernFractalCodec(MODEL);
  const stride = prof.rangeSections.CABINET?.stride ?? 106;
  const values = new Array(stride * 4).fill(0);
  const status = sysex(0x13, [...enc14(cab), (1 << 1) | (4 << 4)]); // active channel A
  const bulk = blockBulkFrames(cab, values);
  const mock = new MockTransport('serial', 'mock-fm3-cab');
  mock.isOpen = true;
  mock.reply = (req) => {
    if (compactHex(req) === compactHex(codec.buildStatusDump())) return [status];
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(cab))) return bulk;
    return [];
  };
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });

  // 1. CABINET has no model selector (no `<FAM>_MODEL`/`<FAM>_TYPE` and no explicit override).
  assert(!MODEL_SELECTOR_OVERRIDES['CABINET'], 'CABINET must not have a model-selector override');
  const profCab = prof.params['CABINET'] ?? [];
  assert(!profCab.some((p) => p.name === 'CABINET_MODEL' || p.name === 'CABINET_TYPE'), 'CABINET must have neither CABINET_MODEL nor CABINET_TYPE');

  const r = await driver.blockParams(cab);

  // 2. CABINET_PRETYPE (pid 43) remains in enums — the "Preamp Type" dropdown survives.
  const pretype = r.enums.find((e) => e.id === 43);
  assert(pretype != null, 'CABINET_PRETYPE (pid 43) must be served in enums');
  assertEqual(pretype.name, 'Preamp Type', 'CABINET_PRETYPE display name');

  // 3. CABINET's `type` is null (the cab model is the IR, not an enum selector).
  assertEqual(r.type, null, 'CABINET has no type selector');

  // 4. The cab layout still resolves (single variant), and its pages carry geometry.
  assert(r.layout != null, 'CABINET layout must resolve');
  assert(r.layout!.pages.length > 0, 'CABINET layout has pages');
  const geomPages = r.layout!.pages.filter((p) => p.geometry != null);
  assert(geomPages.length > 0, 'CABINET pages must carry resolved PageLayout geometry');
  const mixer2 = r.layout!.pages.find((p) => p.layout === 'LAYOUT_MIXER2');
  assert(mixer2?.geometry?.parametersX === 305, 'LAYOUT_MIXER2.parametersX resolves to 305');

  // 5. Controls carry their outer bounds from the renderer profile.
  let boundControls = 0;
  for (const p of r.layout!.pages) for (const row of p.rows) for (const c of row.controls) if (c.bounds) boundControls++;
  assert(boundControls > 0, 'CABINET controls must carry resolved widget bounds');

  // 6. The Preamp Type dropdown control carries bounds (dropdown1p5 = 124×136) and its render meta.
  const pretypeCtl = r.layout!.pages.flatMap((p) => p.rows).flatMap((row) => row.controls)
    .find((c) => c.paramName === 'CABINET_PRETYPE');
  assert(pretypeCtl != null, 'CABINET_PRETYPE layout control present');
  assertEqual(pretypeCtl!.bounds?.w, 124, 'CABINET_PRETYPE dropdown1p5 width 124');
  assertEqual(pretypeCtl!.bounds?.h, 136, 'CABINET_PRETYPE dropdown1p5 height 136');
}
