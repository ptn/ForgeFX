// Gen-3 modifier slot resolution (driver-level) — mocked transport, no hardware.
//
// Locks that resolveModifierSlot is a READ-ONLY lookup: it bulk-reads each slot's source/target
// binding pids and returns the matched slot, the first free slot, or an explicit no-free-slot error —
// and it never emits a SET/structural frame (so a lookup can never overwrite an assignment).
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3

const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** A bulk-read reply for `eid` carrying `values` (indexed by pid; non-zero survive the sparse map). */
function bulkFrames(eid: number, values: readonly number[]): number[][] {
  const body = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

const SLOT_COUNT = 32;
const BASE_EID = 3;

/** FM3 modifier field pids: source 0 / targetEffectId 8 / targetParam 9. */
const SRC = 0, TE = 8, TP = 9;

const free = { source: 0, targetEffectId: 0, targetParam: 0 };

function driverFor(slots: Record<number, { source: number; targetEffectId: number; targetParam: number }>): { driver: ReturnType<typeof createGen3Driver>; mock: MockTransport } {
  const codec = createModernFractalCodec(MODEL);
  const mock = new MockTransport('serial', 'mock-modifier-slot');
  mock.isOpen = true;
  const pollHex = new Map<number, string>();
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const eid = BASE_EID + (slot - 1);
    pollHex.set(eid, codec.buildBlockBulkReadPoll(eid).map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
  mock.reply = (req) => {
    const h = req.map((b) => b.toString(16).padStart(2, '0')).join('');
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      const eid = BASE_EID + (slot - 1);
      if (pollHex.get(eid) === h) {
        const b = slots[slot] ?? free;
        const values = new Array<number>(TP + 1).fill(0);
        values[SRC] = b.source;
        values[TE] = b.targetEffectId;
        values[TP] = b.targetParam;
        return bulkFrames(eid, values);
      }
    }
    return [];
  };
  const driver = createGen3Driver(PROFILES[MODEL]!, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return { driver, mock };
}

export const GEN3_MODIFIER_SLOT_CASE_COUNT = 3;

export async function runGen3ModifierSlotTests(): Promise<void> {
  // 1 — the LFO-bound slot wins (slot 5, not slot 1), and the lookup short-circuits read-only
  {
    const { driver, mock } = driverFor({ 1: { source: 10, targetEffectId: 12, targetParam: 2 }, 5: { source: 1, targetEffectId: 58, targetParam: 7 } });
    const r = await driver.resolveModifierSlot!(58, 7);
    assert(r.ok === true && r.matched === true && r.slot === 5, `expected matched slot 5, got ${JSON.stringify(r)}`);
    assertEqual(mock.sent.length, 5, 'lookup must short-circuit at the matched slot');
    // every outgoing frame is a bulk-read poll for slots 1..5 (eids 3..7) — no SET/structural writes
    const codec = createModernFractalCodec(MODEL);
    for (let i = 0; i < 5; i++) {
      const expected = codec.buildBlockBulkReadPoll(BASE_EID + i);
      assertEqual(mock.sent[i]!.join(','), expected.join(','), `frame ${i} must be a bulk-read poll (no writes)`);
    }
  }

  // 2 — no match → the first free slot after an occupied slot 1
  {
    const { driver } = driverFor({ 1: { source: 11, targetEffectId: 12, targetParam: 2 } });
    const r = await driver.resolveModifierSlot!(58, 7);
    assert(r.ok === true && r.matched === false && r.slot === 2, `expected free slot 2, got ${JSON.stringify(r)}`);
  }

  // 3 — fully-occupied bank → explicit no_free_slot error (no clobber)
  {
    const slots: Record<number, { source: number; targetEffectId: number; targetParam: number }> = {};
    for (let slot = 1; slot <= SLOT_COUNT; slot++) slots[slot] = { source: 1, targetEffectId: 10 + slot, targetParam: 1 };
    const { driver } = driverFor(slots);
    const r = await driver.resolveModifierSlot!(58, 7);
    assertEqual(r.ok, false, 'fully-occupied bank must not resolve');
    assertEqual(r.error, 'no_free_slot', 'must surface the explicit no-free-slot error');
  }
}
