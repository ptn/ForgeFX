// DynaCab variant selection regression (FORGEFX: the cab block must serve its DynaCab layout when the
// block's MODE is DYNA-CAB).
//
// CABINET has no model selector, so its two layout variants ("0" legacy IR / "1" DynaCab) key on
// CABINET_MODE (pid 31). The layout generator folds that single page selector up into the variant's
// `value` and records it on `selectorParamName`; the driver must resolve the variant by that selector's
// CURRENT value, not the (absent) block type. Before this, `selectVariant` only matched the block type,
// so a DynaCab cab always served the legacy variant and Axis never drew its `dynaCabControl` cone.
//
// Mocked transport, no hardware — same idiom as cab-prettype.test.ts.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const MODE_PID = 31; // CABINET_MODE
const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');

export const CAB_DYNACAB_CASE_COUNT = 4;

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

async function cabWithMode(mode: number) {
  const prof = PROFILES[MODEL]!;
  const cab = effectRoster().find((x) => x.slug === 'cab')!.page;
  const codec = createModernFractalCodec(MODEL);
  const stride = prof.rangeSections.CABINET?.stride ?? 106;
  const values = new Array(stride * 4).fill(0);
  // Set MODE on every channel: the fn-0x1F body is channel-blocked and the driver slices the ACTIVE
  // channel, so writing one channel only would depend on which channel the status frame reports.
  for (let c = 0; c < 4; c++) values[c * stride + MODE_PID] = mode === 1 ? 65534 : 0;
  const status = sysex(0x13, [...enc14(cab), (1 << 1) | (4 << 4)]);
  const bulk = blockBulkFrames(cab, values);
  const mock = new MockTransport('serial', `mock-fm3-cab-mode-${mode}`);
  mock.isOpen = true;
  mock.reply = (req) => {
    if (compactHex(req) === compactHex(codec.buildStatusDump())) return [status];
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(cab))) return bulk;
    return [];
  };
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return driver.blockParams(cab);
}

export async function runCabDynacabTests(): Promise<void> {
  const controlsOf = (l: { pages: { rows: { controls: { rawWidget: string }[] }[] }[] }) =>
    l.pages.flatMap((p) => p.rows).flatMap((row) => row.controls);

  // 1. MODE=1 (DynaCab) → the DynaCab variant is served and it carries a dynaCabControl cone.
  const dyna = await cabWithMode(1);
  assertEqual(dyna.layout?.variantValue, '1', 'DynaCab cab serves the "1" variant');
  assertEqual(dyna.layout?.variantSelectorParamName, 'CABINET_MODE', 'variant records its selector param');
  assert(
    controlsOf(dyna.layout!).some((c) => c.rawWidget === 'dynaCabControl'),
    'DynaCab variant carries a dynaCabControl cone'
  );

  // 2. MODE=0 (legacy IR) → the legacy variant, no cone.
  const legacy = await cabWithMode(0);
  assertEqual(legacy.layout?.variantValue, '0', 'legacy cab serves the "0" variant');
  assert(
    !controlsOf(legacy.layout!).some((c) => c.rawWidget === 'dynaCabControl'),
    'legacy variant carries no dynaCabControl cone'
  );

  // 3. The DynaCab cone binds to the DynaCab position symbol (CABINET_DYNACAB_R1), not a legacy param.
  const cone = controlsOf(dyna.layout!).find((c) => c.rawWidget === 'dynaCabControl');
  assertEqual(cone!.paramName, 'CABINET_DYNACAB_R1', 'cone is anchored to CABINET_DYNACAB_R1');

  // 4. The DynaCab-only distance param is authored into the DynaCab variant (CABINET_DYNACAB_Z1).
  assert(
    controlsOf(dyna.layout!).some((c) => c.paramName === 'CABINET_DYNACAB_Z1'),
    'DynaCab variant authors CABINET_DYNACAB_Z1'
  );
}
