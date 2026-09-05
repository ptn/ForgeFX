// paramId cross-contamination guard — asserts each gen-3 profile in src/devices.ts wires the
// EXACT catalog table objects (object identity, ===) from its own forgefx-midi device module,
// and NOT another device's. A paste/import slip that pointed the FM9 profile at FM3 tables
// (the paramId cross-contamination bug class) fails here immediately.
//
// Grounded in what src/devices.ts actually wires:
//   0x11 (FM3):  params/ranges/monitorParams/fc fields/mod fields/rosters/enum labels
//                come straight from forgefx-midi/gen3/fm3; its phantom scratchpad table is excluded.
//   0x12 (FM9):  params/ranges/monitorParams/fc fields/mod fields from forgefx-midi/gen3/fm9
//                (rosters + enum labels are synthesized from FM9_ENUM_OVERRIDES — no identity).
//   0x10 (III):  params/monitorParams/fc fields/mod fields from forgefx-midi/gen3/axe-fx-iii
//                (its ranges table is synthesized in devices.ts — asserted distinct from FM3/FM9).
import { PROFILES } from '../../src/devices.js';
import {
  FM3_PARAMS_BY_FAMILY, FM3_RANGES_CLASSIFIED, FM3_MONITOR_PARAMS, FM3_FC_FIELDS, FM3_MOD_FIELDS,
  FM3_ROSTERS, FM3_ENUM_OVERRIDES, FM3_CAB_IRS
} from 'forgefx-midi/gen3/fm3';
import {
  FM9_PARAMS_BY_FAMILY, FM9_RANGES_CLASSIFIED, FM9_MONITOR_PARAMS, FM9_FC_FIELDS, FM9_MOD_FIELDS
} from 'forgefx-midi/gen3/fm9';
import {
  PARAMS_BY_FAMILY as AXE3_PARAMS_BY_FAMILY, AXE3_MONITOR_PARAMS, AXE3_FC_FIELDS, AXE3_MOD_FIELDS
} from 'forgefx-midi/gen3/axe-fx-iii';

const fm3 = PROFILES[0x11]!;
const fm9 = PROFILES[0x12]!;
const axe3 = PROFILES[0x10]!;

const same = (a: unknown, b: unknown) => a === b;

const checks: Array<{ name: string; ok: () => boolean }> = [
  // ── FM3 profile ↔ forgefx-midi/gen3/fm3 (identity) ──
  { name: 'fm3.params === FM3_PARAMS_BY_FAMILY', ok: () => same(fm3.params, FM3_PARAMS_BY_FAMILY) },
  // fm3.ranges is FM3_RANGES with the discrete-overlay correction applied (see gen3/discreteOverlay.ts) —
  // FM3_RANGES_CLASSIFIED is the singleton devices.ts actually wires, computed once at module load.
  { name: 'fm3.ranges === FM3_RANGES_CLASSIFIED', ok: () => same(fm3.ranges, FM3_RANGES_CLASSIFIED) },
  { name: 'fm3.monitorParams === FM3_MONITOR_PARAMS', ok: () => same(fm3.monitorParams, FM3_MONITOR_PARAMS) },
  { name: 'fm3.fcModel.fields === FM3_FC_FIELDS', ok: () => same(fm3.fcModel?.fields, FM3_FC_FIELDS) },
  { name: 'fm3.modModel.fields === FM3_MOD_FIELDS', ok: () => same(fm3.modModel?.fields, FM3_MOD_FIELDS) },
  { name: "fm3.rosterFor('amp') === FM3_ROSTERS.amp", ok: () => same(fm3.rosterFor('amp'), (FM3_ROSTERS as Record<string, unknown>).amp) },
  {
    name: 'fm3.cabIrs preserves static banks but omits phantom scratchpad',
    ok: () => {
      const irs = fm3.cabIrs();
      return irs['FACTORY 1'] === FM3_CAB_IRS['FACTORY 1']
        && irs['FACTORY 2'] === FM3_CAB_IRS['FACTORY 2']
        && irs.LEGACY === FM3_CAB_IRS.LEGACY
        && !('SCRATCHPAD' in irs);
    },
  },
  {
    name: 'fm3.enumLabelsFor serves FM3_ENUM_OVERRIDES arrays by identity',
    ok: () => {
      const overrides = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
      const family = Object.keys(overrides).find((f) => Object.keys(overrides[f]!).length > 0);
      if (!family) return false;
      const pid = Object.keys(overrides[family]!)[0]!;
      return same(fm3.enumLabelsFor(family, Number(pid)), overrides[family]![pid]);
    }
  },

  // ── FM9 profile ↔ forgefx-midi/gen3/fm9 (identity) ──
  { name: 'fm9.params === FM9_PARAMS_BY_FAMILY', ok: () => same(fm9.params, FM9_PARAMS_BY_FAMILY) },
  // fm9.ranges is FM9_RANGES with the discrete-overlay correction applied — see the fm3.ranges note above.
  { name: 'fm9.ranges === FM9_RANGES_CLASSIFIED', ok: () => same(fm9.ranges, FM9_RANGES_CLASSIFIED) },
  { name: 'fm9.monitorParams === FM9_MONITOR_PARAMS', ok: () => same(fm9.monitorParams, FM9_MONITOR_PARAMS) },
  { name: 'fm9.fcModel.fields === FM9_FC_FIELDS', ok: () => same(fm9.fcModel?.fields, FM9_FC_FIELDS) },
  { name: 'fm9.modModel.fields === FM9_MOD_FIELDS', ok: () => same(fm9.modModel?.fields, FM9_MOD_FIELDS) },

  // ── Axe-Fx III profile ↔ forgefx-midi/gen3/axe-fx-iii (identity where the package ships a table) ──
  { name: 'axe3.params === PARAMS_BY_FAMILY (axe-fx-iii)', ok: () => same(axe3.params, AXE3_PARAMS_BY_FAMILY) },
  { name: 'axe3.monitorParams === AXE3_MONITOR_PARAMS', ok: () => same(axe3.monitorParams, AXE3_MONITOR_PARAMS) },
  { name: 'axe3.fcModel.fields === AXE3_FC_FIELDS', ok: () => same(axe3.fcModel?.fields, AXE3_FC_FIELDS) },
  { name: 'axe3.modModel.fields === AXE3_MOD_FIELDS', ok: () => same(axe3.modModel?.fields, AXE3_MOD_FIELDS) },
  // III ranges are synthesized in devices.ts — must never alias another device's table
  { name: 'axe3.ranges !== FM3_RANGES_CLASSIFIED', ok: () => !same(axe3.ranges, FM3_RANGES_CLASSIFIED) },
  { name: 'axe3.ranges !== FM9_RANGES_CLASSIFIED', ok: () => !same(axe3.ranges, FM9_RANGES_CLASSIFIED) },

  // ── cross-contamination negatives (the actual bug class) ──
  { name: 'fm9.params !== FM3_PARAMS_BY_FAMILY', ok: () => !same(fm9.params, FM3_PARAMS_BY_FAMILY) },
  { name: 'fm9.ranges !== FM3_RANGES_CLASSIFIED', ok: () => !same(fm9.ranges, FM3_RANGES_CLASSIFIED) },
  { name: 'fm9.monitorParams !== FM3_MONITOR_PARAMS', ok: () => !same(fm9.monitorParams, FM3_MONITOR_PARAMS) },
  { name: 'fm3.params !== FM9_PARAMS_BY_FAMILY', ok: () => !same(fm3.params, FM9_PARAMS_BY_FAMILY) },
  { name: 'fm3.ranges !== FM9_RANGES_CLASSIFIED', ok: () => !same(fm3.ranges, FM9_RANGES_CLASSIFIED) },
  { name: 'axe3.params !== FM3_PARAMS_BY_FAMILY', ok: () => !same(axe3.params, FM3_PARAMS_BY_FAMILY) },
  { name: 'axe3.params !== FM9_PARAMS_BY_FAMILY', ok: () => !same(axe3.params, FM9_PARAMS_BY_FAMILY) },
  { name: 'fm3/fm9/axe3 fc field maps are three distinct objects', ok: () => !same(FM3_FC_FIELDS, FM9_FC_FIELDS) && !same(FM9_FC_FIELDS, AXE3_FC_FIELDS) && !same(FM3_FC_FIELDS, AXE3_FC_FIELDS) }
];

export const TABLES_CASE_COUNT = checks.length;

export function runTablesTests(): void {
  for (const c of checks) {
    if (!c.ok()) throw new Error(`table identity check failed: ${c.name}`);
  }
}
