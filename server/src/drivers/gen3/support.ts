// Gen-3 driver primitives shared by the driver's sections: catalog metadata, protocol constants,
// grid-mask/param-label helpers, and the numeric clamps. Split out of gen3.ts (C3); pure — no
// transport or driver state.
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { FN_PARAMETER_SETGET, SUB_ACTION_GRID_LAYOUT } from 'forgefx-midi/gen3/axe-fx-iii';
import type { NamedParam } from '../types.js';

// slug → { name, page=base effect id } from the authoritative codec base table (replaces the old
// defs.js pack lookup; block names + base ids are codec facts, not editor-cache definitions).
export const BLOCK_META: Record<string, { name: string; page: number }> = (() => {
  const out: Record<string, { name: string; page: number }> = {};
  for (const e of effectRoster()) out[e.slug] = { name: e.name, page: e.page };
  return out;
})();

export const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer

/** FM3 model byte. The live grid-layout decode (forgefx-midi gridLayout.ts) is byte-exact against
 *  real FM3 responses ONLY; the III/FM9 branch is community-beta, so they keep the dump path. */
export const FM3_MODEL = 0x11;
/** Gen-3 shunt effect ids are `GEN3_SHUNT_ID_BASE + (1-based index)`. This is the `shuntBase`
 *  threshold advertised to Axis (and the dump decoder's `effectId > 1000` shunt test): Axis allocates
 *  new routing shunts at or above it. The live wire can instead carry a small 1-based sequential index,
 *  so rebasing uses base − 1 and the display name is `Shunt ${id − (base − 1)}` — the dump convention. */
export const GEN3_SHUNT_ID_BASE = 1024;
export const SHUNT_INDEX_OFFSET = GEN3_SHUNT_ID_BASE - 1; // 1023
export const GEN3_SCENES = 8;

/** Incoming-cable bitmask → source rows of the previous column (bit r = row r), the dump decoder's
 *  `from_rows` convention. */
export function rowsFromMask(mask: number, rows: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < rows; r++) if (mask & (1 << r)) out.push(r);
  return out;
}

/** True for a live grid-layout (fn 0x01 / sub 0x2E) response frame. Matches the predicate the
 *  hardware calibration probe used (src/probes/grid-2e.ts). */
export function isGridLayoutResponse(f: readonly number[]): boolean {
  return f[5] === FN_PARAMETER_SETGET && f[6] === SUB_ACTION_GRID_LAYOUT;
}

export const CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// catalog unit code → display label (blank = show the bare number)
export const UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%',
  degrees: '°', semitones: 'st', cents: 'ct', pf: 'pF', ratio: ':1'
};
// units that mark a musician-facing knob. 'numeric' = a plain unitless knob (Drive, Tone, Level,
// cut freqs…) — primary controls in many families; only 'unverified'/'count'/'enum' are non-knobs.
export const KNOB_UNITS = new Set([
  'numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'cents', 'degrees'
]);

/** Friendly param label: the catalog displayLabel, else tidy the raw NAME (strip family prefix, _→space).
 *  Served UNCHANGED (Phase 1.3) — this used to be overwritten by `applyLayoutLabels` with the resolved
 *  layout's own control label, then `dedupeLabels` appended " 1"/" 2" to whatever repeated; that pipeline
 *  is deleted, which is the fix for served labels drifting from the official app. Duplicate names across
 *  a block's params (e.g. the cab's 4× "Low Cut") are therefore expected here now. */
export function paramLabel(p: { displayLabel?: string; name: string }): string {
  return p.displayLabel ?? p.name.replace(/^[A-Z0-9]+_/, '').replace(/_/g, ' ');
}

/** A catalog def paired with its resolved range (if any) and usability verdict — what the
 *  knob/enum classification pass in `blockParams` builds before it has live wire values to read. */
export interface ParamCandidate {
  p: { paramId: number; name: string; displayLabel?: string; unit?: string };
  range?: { kind: 'enum' | 'float'; displayMin: number; displayMax: number; step?: number; defaultRaw?: number; taper?: 'linear' | 'log' | 'flat' | 'custom'; taperPoints?: ReadonlyArray<readonly [number, number]> };
  unusable: NamedParam['unusable'];
}

export function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
export function round3(v: number) { return Math.round(v * 1000) / 1000; }
