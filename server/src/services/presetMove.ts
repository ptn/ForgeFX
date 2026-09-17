// Preset MOVE / permutation executor — device-independent policy composing a driver's
// dump/load/store primitives into a safe multi-slot rearrangement. Browser-safe: the Store import is
// type-only and the only service dependency is the browser-safe backups module.
//
// The write list is computed by the CLIENT (Axis' pure `resolveAxisPbMove` planner) and executed here.
// Safety, not scheduling, is the server's job:
//   1. Snapshot every affected slot (read-only, by slot number) BEFORE the first write. A failed /
//      unreachable dump aborts the whole move with nothing written.
//   2. Apply load→store per write. Because every source byte is in hand first, write order cannot
//      clobber a value still needed — overlapping ranges need no special case.
//   3. On any write failure, roll every affected slot back from its snapshot so a partial permutation
//      never survives.
// The plan is a bijection, so its inverse is the same list with from/to swapped — the client's undo.
import type { Store } from '../runtime/store.js';
import type { DeviceDriver } from '../drivers/types.js';
import { backupPreset } from './backups.js';

export interface PresetMoveWrite {
  from: number;
  to: number;
}

export type PresetMoveResult =
  | { ok: true; writes: PresetMoveWrite[]; slots: number }
  | { ok: false; error: string; applied: PresetMoveWrite[]; rolledBack: boolean; rollbackErrors: number[] };

/** Bound a single batch so a malformed request can't drive an unbounded destructive loop. */
export const PRESET_MOVE_MAX_WRITES = 64;

export type PresetMoveWriteValidation = { ok: true; writes: PresetMoveWrite[] } | { ok: false; error: string };

/** Shape/permutation checks. A move must not write two sources to one target, and must not write a
 *  slot to itself (the planner already drops no-ops; this guards direct/other callers). */
export function validatePresetMoveWrites(writes: unknown, slotCount?: number): PresetMoveWriteValidation {
  if (!Array.isArray(writes) || !writes.length) return { ok: false, error: 'writes[] required' };
  if (writes.length > PRESET_MOVE_MAX_WRITES) return { ok: false, error: `too many writes (max ${PRESET_MOVE_MAX_WRITES})` };
  const targets = new Set<number>();
  for (const raw of writes) {
    const w = raw as Partial<PresetMoveWrite>;
    if (!Number.isInteger(w?.from) || !Number.isInteger(w?.to)) return { ok: false, error: 'each write needs integer from/to' };
    const { from, to } = w as PresetMoveWrite;
    if (from < 0 || to < 0) return { ok: false, error: 'from/to must be >= 0' };
    if (slotCount != null && (from >= slotCount || to >= slotCount)) return { ok: false, error: 'from/to out of range' };
    if (from === to) return { ok: false, error: 'from === to is a no-op and must be omitted' };
    if (targets.has(to)) return { ok: false, error: `duplicate target slot ${to}` };
    targets.add(to);
  }
  return { ok: true, writes: writes as PresetMoveWrite[] };
}

/**
 * Apply a permutation of device slots. See the module header for the snapshot-first / rollback rules.
 * `activeSlot` is re-selected at the end so the edit buffer lands where the caller expects; a failed
 * re-select is not fatal (the move itself already succeeded).
 */
export async function movePresets(
  store: Store,
  d: DeviceDriver,
  writes: PresetMoveWrite[],
  activeSlot?: number
): Promise<PresetMoveResult> {
  if (!d.dumpRaw || !d.loadPresetBytes || !d.store) throw new Error('device does not support preset move');

  const affected = [...new Set(writes.flatMap((w) => [w.from, w.to]))].sort((a, b) => a - b);

  // 1. Snapshot EVERY affected slot first (read-only; does not switch the active preset). An error
  //    here propagates before any write, so the move aborts cleanly.
  const snapshots = new Map<number, Uint8Array>();
  for (const slot of affected) snapshots.set(slot, (await d.dumpRaw(slot)).bytes);

  // Best-effort user-visible undo entries in the version store (empty/invalid slots are skipped).
  for (const slot of affected) { try { await backupPreset(store, d, slot, 'auto'); } catch { /* skip */ } }

  // 2. Apply. Any failure rolls the whole affected set back from the snapshots.
  const applied: PresetMoveWrite[] = [];
  try {
    for (const w of writes) {
      const bytes = snapshots.get(w.from);
      if (!bytes) throw new Error(`no snapshot for slot ${w.from}`);
      await d.loadPresetBytes(bytes);
      const r = await d.store(w.to);
      if (r && r.ok === false) throw new Error(`store ${w.to} rejected by device`);
      applied.push(w);
    }
  } catch (e) {
    const rollbackErrors: number[] = [];
    for (const [slot, bytes] of snapshots) {
      try { await d.loadPresetBytes(bytes); await d.store(slot); } catch { rollbackErrors.push(slot); }
    }
    return { ok: false, error: (e as Error).message, applied, rolledBack: rollbackErrors.length === 0, rollbackErrors };
  }

  // 3. Restore the view: the buffer should show whatever is now in the caller's slot.
  if (activeSlot != null && d.selectPreset) {
    try { await d.selectPreset(activeSlot); } catch { /* non-fatal */ }
  }
  return { ok: true, writes, slots: affected.length };
}
