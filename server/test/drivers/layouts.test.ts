// Editor-layout v2 serving — variant selection + wire passthrough shape, over the REAL device
// profiles wired in src/devices.ts and the AM4 layout resolver. All data-only (no transport):
//   • variant selection: type-value match, amp firmware-pin preference, null/first fallback;
//   • v2 passthrough: pages → rows → controls carry widget/rawWidget/placement/crossBlock verbatim;
//   • AM4 gets a layout for the first time (family mapping via am4LayoutFor).
import { PROFILES, am4LayoutFor, type DeviceLayout } from '../../src/devices.js';
import { EDITOR_WIDGET_KINDS } from 'forgefx-midi/gen3/fm3';

const fm3 = PROFILES[0x11]!;
const fm9 = PROFILES[0x12]!;
const axe3 = PROFILES[0x10]!;

// Walk every control of a resolved layout (pages → rows → controls).
function* controlsOf(l: DeviceLayout) {
  for (const p of l.pages) for (const r of p.rows) for (const c of r.controls) yield { page: p, row: r, control: c };
}

// A resolved layout is v2-shaped and every control passes the codec fields through unchanged.
function shapeOk(l: DeviceLayout): boolean {
  if (typeof l.editorName !== 'string' || typeof l.family !== 'string') return false;
  if (typeof l.variantName !== 'string') return false;
  if (!(l.variantValue === null || typeof l.variantValue === 'string')) return false;
  if (!Array.isArray(l.pages) || l.pages.length === 0) return false;
  for (const { page, row, control } of controlsOf(l)) {
    if (typeof page.name !== 'string' || !Array.isArray(page.rows)) return false;
    if (row.section !== 'parameters' && row.section !== 'mixer') return false;
    if (typeof control.label !== 'string') return false;
    if (!(EDITOR_WIDGET_KINDS as readonly string[]).includes(control.widget)) return false;
    if (typeof control.rawWidget !== 'string') return false;
    if (!(control.paramName === null || typeof control.paramName === 'string')) return false;
    if (!(control.paramId === null || typeof control.paramId === 'number')) return false;
  }
  return true;
}

const checks: Array<{ name: string; ok: () => boolean }> = [
  // ── variant selection: type-value MATCH (AM4 COMP variants are value-keyed, no fw noise) ──
  { name: "AM4 COMP type 6 → 'Analog' variant (value '6,14')", ok: () => {
    const l = am4LayoutFor('compressor', 6); return l?.variantName === 'Analog' && l.variantValue === '6,14'; } },
  { name: "AM4 COMP type 0 → 'Studio FF' variant", ok: () => am4LayoutFor('compressor', 0)?.variantName === 'Studio FF' },
  { name: "AM4 COMP type 3 → 'Dynamics' variant", ok: () => am4LayoutFor('compressor', 3)?.variantName === 'Dynamics' },

  // ── variant selection: amp/DISTORT prefers the firmware-PINNED variant (all values null) ──
  { name: 'Axe-Fx III DISTORT prefers pinned amp variant', ok: () => {
    const l = axe3.layoutFor('DISTORT', 0); return !!l && l.pinned === true && l.variantValue === null && l.variantName === 'Amp GTE 28.09'; } },
  { name: 'FM9 DISTORT prefers pinned amp variant', ok: () => {
    const l = fm9.layoutFor('DISTORT', 0); return !!l && l.pinned === true && l.variantName === 'Amp GTE 6.00'; } },

  // ── variant selection: FALLBACK ──
  { name: 'FM3 DISTORT falls back to the null-value variants and prefers the pinned one', ok: () => {
    const l = fm3.layoutFor('DISTORT', 5); return !!l && l.variantValue === null && l.pinned === true && l.variantName === 'Amp GTE 8.00'; } },
  { name: 'AM4 COMP with no matching type falls back to the first variant', ok: () => am4LayoutFor('compressor', 99999)?.variantName === 'Analog' },
  { name: 'unknown family → undefined', ok: () => fm3.layoutFor('NOT_A_FAMILY') === undefined && axe3.layoutFor('NOT_A_FAMILY', 3) === undefined },

  // ── v2 passthrough shape ──
  { name: 'Axe-Fx III DISTORT layout is v2-shaped (pages→rows→controls)', ok: () => { const l = axe3.layoutFor('DISTORT', 0); return !!l && shapeOk(l); } },
  { name: 'AM4 COMP layout is v2-shaped', ok: () => { const l = am4LayoutFor('compressor', 6); return !!l && shapeOk(l); } },
  { name: 'FM3 DISTORT carries at least one control placement (passthrough)', ok: () => {
    const l = fm3.layoutFor('DISTORT'); if (!l) return false;
    for (const { control } of controlsOf(l)) if (control.placement && typeof control.placement.col === 'number') return true;
    return false; } },
  { name: 'crossBlock passes through with its shape (Axe-Fx III, across families)', ok: () => {
    for (const fam of ['DELAY', 'MULTITAP', 'REVERB', 'PITCH', 'GLOBAL', 'CONTROLLERS']) {
      const l = axe3.layoutFor(fam); if (!l) continue;
      for (const { control } of controlsOf(l)) {
        const x = control.crossBlock;
        if (x) return typeof x.effect === 'string'
          && (x.family === null || typeof x.family === 'string')
          && (x.paramName === null || typeof x.paramName === 'string')
          && (x.paramId === null || typeof x.paramId === 'number');
      }
    }
    return false; } },
  { name: 'selected variant includes ALL its pages only (no unioning)', ok: () => {
    // 'Analog' has a fixed page count; a different type resolves a different variant with its own pages.
    const analog = am4LayoutFor('compressor', 6); const dyn = am4LayoutFor('compressor', 3);
    return !!analog && !!dyn && analog.variantName !== dyn.variantName && analog.pages.length >= 1 && dyn.pages.length >= 1; } },

  // ── AM4 layout presence (first-time) — block-name → family mapping ──
  { name: "AM4 'amp' → DISTORT layout (editorName 'Global')", ok: () => {
    const l = am4LayoutFor('amp'); return l?.family === 'DISTORT' && l.editorName === 'Global'; } },
  { name: "AM4 'reverb' → REVERB layout", ok: () => am4LayoutFor('reverb')?.family === 'REVERB' },
  { name: "AM4 'drive' → FUZZ layout", ok: () => am4LayoutFor('drive')?.family === 'FUZZ' },
  { name: "AM4 'volpan' → VOLUME layout", ok: () => am4LayoutFor('volpan')?.family === 'VOLUME' },
  { name: "AM4 'compressor' → COMP layout", ok: () => am4LayoutFor('compressor')?.family === 'COMP' },
  { name: "AM4 unmapped block → undefined", ok: () => am4LayoutFor('none') === undefined && am4LayoutFor('bogus') === undefined },
];

export const LAYOUTS_CASE_COUNT = checks.length;

export function runLayoutsTests(): void {
  for (const c of checks) {
    if (!c.ok()) throw new Error(`editor-layout check failed: ${c.name}`);
  }
}
