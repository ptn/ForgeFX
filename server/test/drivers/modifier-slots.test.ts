// Modifier slot-selection pure logic — no device I/O.
//
// Locks the three required decisions: an existing LFO/anything-bound slot wins over slot 1; a brand-new
// target gets the FIRST genuinely unassigned slot (source + target eid + target param all zero); and a
// fully-occupied modifier bank yields an explicit noFreeSlot instead of a clobber.
import { selectModifierSlot, isSlotBoundTo, isSlotFree } from '../../src/drivers/modifierSlots.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const MODIFIER_SLOTS_CASE_COUNT = 6;

/** Build a 32-slot bank where every slot is free except the ones named in `assigned`. */
function bank(assigned: Record<number, { source: number; targetEffectId: number; targetParam: number }>): { source: number; targetEffectId: number; targetParam: number }[] {
  return Array.from({ length: 32 }, (_, i) => assigned[i + 1] ?? { source: 0, targetEffectId: 0, targetParam: 0 });
}

const bindings = (slots: { source: number; targetEffectId: number; targetParam: number }[]) =>
  (slot: number) => slots[slot - 1]!;

export async function runModifierSlotsTests(): Promise<void> {
  // 1 — the existing bound slot wins (slot 3 is LFO-bound to the target; slot 1 is free)
  {
    const slots = bank({ 1: { source: 10, targetEffectId: 58, targetParam: 4 }, 3: { source: 1, targetEffectId: 58, targetParam: 7 } });
    const r = await selectModifierSlot(32, 58, 7, bindings(slots));
    assert(r.kind === 'matched' && r.slot === 3, `existing LFO-bound slot must win over slot 1, got ${JSON.stringify(r)}`);
  }

  // 2 — no match → the FIRST unassigned slot, not slot 1 when slot 1 is already taken elsewhere
  {
    const slots = bank({ 1: { source: 11, targetEffectId: 12, targetParam: 2 }, 2: { source: 0, targetEffectId: 0, targetParam: 0 } });
    const r = await selectModifierSlot(32, 58, 7, bindings(slots));
    assert(r.kind === 'free' && r.slot === 2, `first free slot after an occupied slot 1 must be 2, got ${JSON.stringify(r)}`);
  }

  // 3 — all 32 slots assigned to other targets → explicit noFreeSlot
  {
    const slots = bank(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i + 1, { source: 1, targetEffectId: 10 + i, targetParam: 1 }])));
    const r = await selectModifierSlot(32, 58, 7, bindings(slots));
    assertEqual(r.kind, 'noFreeSlot', 'fully-occupied bank must resolve to noFreeSlot');
  }

  // 4 — a slot with a source but no target is NOT free (never overwrite a source-only modifier)
  {
    const slots = bank({ 1: { source: 10, targetEffectId: 0, targetParam: 0 }, 2: { source: 0, targetEffectId: 0, targetParam: 0 } });
    assertEqual(isSlotFree(slots[0]!), false, 'source-only slot must not read as free');
    const r = await selectModifierSlot(32, 58, 7, bindings(slots));
    assert(r.kind === 'free' && r.slot === 2, `source-only slot 1 must be skipped for slot 2, got ${JSON.stringify(r)}`);
  }

  // 5 — predicate helpers
  {
    assertEqual(isSlotBoundTo({ source: 1, targetEffectId: 58, targetParam: 7 }, 58, 7), true, 'bound-to match');
    assertEqual(isSlotBoundTo({ source: 1, targetEffectId: 58, targetParam: 8 }, 58, 7), false, 'bound-to mismatch');
    assertEqual(isSlotFree({ source: 0, targetEffectId: 0, targetParam: 0 }), true, 'empty slot is free');
  }

  // 6 — early termination: a match at slot 4 must not read beyond it
  {
    let reads = 0;
    const r = await selectModifierSlot(32, 58, 7, (slot) => {
      reads = Math.max(reads, slot);
      return slot === 4 ? { source: 1, targetEffectId: 58, targetParam: 7 } : { source: 0, targetEffectId: 0, targetParam: 0 };
    });
    assert(r.kind === 'matched' && r.slot === 4, 'matched slot must be 4');
    assertEqual(reads, 4, 'selection must short-circuit at the first match');
  }
}
