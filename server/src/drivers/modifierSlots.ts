// Modifier-slot target resolution — pure selection logic, no device I/O.
//
// A modifier attaches a source to a target parameter. The link lives ON the modifier slot itself as
// two of its own params (targetEffectId pid 8 / targetParam pid 9); the source is pid 0. Given the
// model's slot count and a per-slot reader, resolve which slot to open for a (targetEffectId,
// targetParam) pair:
//
//   • `matched` — the slot already bound to this target (edit it, never a different slot).
//   • `free`    — the first genuinely unassigned slot (source AND target both empty), for a new bind.
//   • `noFreeSlot` — every slot is taken; the caller must NOT overwrite an unrelated assignment.
//
// `readBinding` is injected so the selection is unit-testable without a device and so a caller can
// short-circuit: the loop stops on the first `matched` slot and otherwise must see every slot to know
// the first free one and to prove `noFreeSlot`.

export interface ModSlotBinding {
  /** pid 0 (source ordinal); 0 = no source assigned. */
  source: number;
  /** pid 8 (target block effectId); 0 = unassigned. */
  targetEffectId: number;
  /** pid 9 (target paramId); 0 = unassigned. */
  targetParam: number;
}

export type ModSlotResolution =
  | { kind: 'matched'; slot: number }
  | { kind: 'free'; slot: number }
  | { kind: 'noFreeSlot' };

/** True when a slot is bound to the requested target (pid 8/9 equality). */
export function isSlotBoundTo(b: ModSlotBinding, targetEffectId: number, targetParam: number): boolean {
  return b.targetEffectId === targetEffectId && b.targetParam === targetParam;
}

/** True when a slot carries no assignment at all (source, target eid and target param all empty). */
export function isSlotFree(b: ModSlotBinding): boolean {
  return b.source === 0 && b.targetEffectId === 0 && b.targetParam === 0;
}

export async function selectModifierSlot(
  slotCount: number,
  targetEffectId: number,
  targetParam: number,
  readBinding: (slot1Based: number) => ModSlotBinding | Promise<ModSlotBinding>
): Promise<ModSlotResolution> {
  let firstFree: number | null = null;
  for (let slot = 1; slot <= slotCount; slot++) {
    const b = await readBinding(slot);
    if (isSlotBoundTo(b, targetEffectId, targetParam)) return { kind: 'matched', slot };
    if (firstFree === null && isSlotFree(b)) firstFree = slot;
  }
  return firstFree !== null ? { kind: 'free', slot: firstFree } : { kind: 'noFreeSlot' };
}
