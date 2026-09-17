// Unit tests for services/presetMove.ts — the snapshot-first multi-slot permutation executor.
// In-memory fake device (slots are just name strings) + a stub store; no hardware, no transport.
import type { DeviceDriver, PresetSummary } from '../../src/drivers/types.js';
import type { Store } from '../../src/runtime/store.js';
import {
  movePresets,
  validatePresetMoveWrites,
  PRESET_MOVE_MAX_WRITES,
  type PresetMoveWrite
} from '../../src/services/presetMove.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const PRESET_MOVE_CASE_COUNT = 11;

const stubStore = { addPresetVersion: () => null } as unknown as Store;
const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const dec = (b: Uint8Array) => String.fromCharCode(...b);

function summary(n: number, name: string): PresetSummary {
  return { number: n, name, model: 'fm3', crcValid: true, crc: name.length, scenes: [], blocks: [], models: {}, amps: [] };
}

function makeDevice(initial: Record<number, string>) {
  const state = new Map<number, string>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const calls = { dump: [] as number[], load: [] as string[], store: [] as number[], select: [] as number[] };
  let buffer = '';
  let failStoreAt = -1;
  let failDump: number | null = null;

  const d: Partial<DeviceDriver> = {
    dumpRaw: async (n: number) => {
      calls.dump.push(n);
      if (failDump === n) throw new Error('link lost');
      const name = state.get(n) ?? '<EMPTY>';
      return { bytes: enc(name), summary: summary(n, name) };
    },
    loadPresetBytes: async (b: Uint8Array) => { buffer = dec(b); calls.load.push(buffer); return { ok: true }; },
    store: async (n: number) => {
      const at = calls.store.length;
      calls.store.push(n);
      if (failStoreAt === at) return { ok: false };
      state.set(n, buffer);
      return { ok: true, location: n };
    },
    selectPreset: async (n: number) => { calls.select.push(n); return { ok: true }; }
  };

  return {
    d: d as DeviceDriver,
    state,
    calls,
    setFailStore: (i: number) => { failStoreAt = i; },
    setFailDump: (n: number) => { failDump = n; }
  };
}

const snap = (state: Map<number, string>, slots: number[]) => slots.map((s) => state.get(s));

export async function runPresetMoveTests(): Promise<void> {
  // 1. A single swap exchanges both slots and re-selects the caller's slot.
  {
    const { d, state, calls } = makeDevice({ 1: 'A', 3: 'B' });
    const r = await movePresets(stubStore, d, [{ from: 3, to: 1 }, { from: 1, to: 3 }], 3);
    assert(r.ok, 'swap ok');
    assertEqual(state.get(1), 'B', 'slot 1 is B');
    assertEqual(state.get(3), 'A', 'slot 3 is A');
    assertEqual(calls.select.at(-1), 3, 're-selected the active slot');
  }

  // 2. Overlapping block move is a lossless permutation.
  {
    const { d, state } = makeDevice({ 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' });
    const writes: PresetMoveWrite[] = [{ from: 4, to: 1 }, { from: 5, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 5 }];
    const r = await movePresets(stubStore, d, writes);
    assert(r.ok, 'move ok');
    assertEqual(snap(state, [1, 2, 3, 4, 5]).join(''), 'DEABC', 'permuted exactly, nothing lost');
  }

  // 3. The inverse write list restores the original arrangement (client undo).
  {
    const { d, state } = makeDevice({ 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' });
    const writes: PresetMoveWrite[] = [{ from: 4, to: 1 }, { from: 5, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 5 }];
    await movePresets(stubStore, d, writes);
    await movePresets(stubStore, d, writes.map((w) => ({ from: w.to, to: w.from })));
    assertEqual(snap(state, [1, 2, 3, 4, 5]).join(''), 'ABCDE', 'inverse writes undo the move');
  }

  // 4. Every affected slot is snapshotted before the first write; a failed dump aborts cleanly.
  {
    const { d, calls, setFailDump } = makeDevice({ 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' });
    setFailDump(4);
    let threw = false;
    try {
      await movePresets(stubStore, d, [{ from: 4, to: 1 }, { from: 5, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 5 }]);
    } catch { threw = true; }
    assert(threw, 'snapshot failure propagates');
    assertEqual(calls.store.length, 0, 'nothing was written');
  }

  // 5. A mid-batch store failure rolls every affected slot back from the snapshots.
  {
    const { d, state, setFailStore } = makeDevice({ 1: 'A', 3: 'B' });
    setFailStore(1); // second write fails
    const r = await movePresets(stubStore, d, [{ from: 3, to: 1 }, { from: 1, to: 3 }], 3);
    assert(!r.ok, 'move reports failure');
    assertEqual(r.rolledBack, true, 'rollback succeeded');
    assertEqual(r.applied.length, 1, 'one write had been applied');
    assertEqual(state.get(1), 'A', 'slot 1 restored');
    assertEqual(state.get(3), 'B', 'slot 3 restored');
  }

  // 6. Rollback reports slots it could not restore.
  {
    const { d, setFailStore } = makeDevice({ 1: 'A', 3: 'B' });
    setFailStore(1);
    const r = await movePresets(stubStore, d, [{ from: 3, to: 1 }, { from: 1, to: 3 }]);
    assert(!r.ok && Array.isArray(r.rollbackErrors), 'rollback error list present');
  }

  // 7. Validation — happy path.
  {
    const v = validatePresetMoveWrites([{ from: 3, to: 1 }, { from: 1, to: 3 }], 512);
    assert(v.ok, 'valid swap accepted');
  }

  // 8. Validation — duplicate targets rejected.
  {
    const v = validatePresetMoveWrites([{ from: 3, to: 1 }, { from: 2, to: 1 }]);
    assert(!v.ok, 'duplicate target rejected');
  }

  // 9. Validation — from === to rejected.
  {
    const v = validatePresetMoveWrites([{ from: 2, to: 2 }]);
    assert(!v.ok, 'no-op rejected');
  }

  // 10. Validation — out of range rejected.
  {
    const v = validatePresetMoveWrites([{ from: 3, to: 700 }], 512);
    assert(!v.ok, 'out of range rejected');
  }

  // 11. Validation — batch bound.
  {
    const many = Array.from({ length: PRESET_MOVE_MAX_WRITES + 1 }, (_, i) => ({ from: i, to: i + 1 }));
    const v = validatePresetMoveWrites(many);
    assert(!v.ok, 'oversized batch rejected');
  }
}
