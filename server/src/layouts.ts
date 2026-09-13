// Editor-authentic UI layout resolution — pure, data-driven, no transport or device state. Given a
// family's codec `*_LAYOUTS` table (and an optional AM4 block-name map), these helpers pick the
// block-type / firmware variant that matches the block's CURRENT type, filter its pages/controls to
// the current selector + firmware state, and attach the device-authored renderer geometry.
import type {
  DeviceEditorLayouts, EditorBlockLayout, EditorLayoutVariant, EditorLayoutPage,
  EditorLayoutRow, EditorFwRange, EditorRendererProfile,
} from 'forgefx-midi/gen3/fm3';
import { AM4_LAYOUTS } from 'forgefx-midi/am4';

// Editor-authentic UI layout (v2 schema — see forgefx-midi src/editorLayouts.ts). The wire `layout`
// on /preset/blocks/:eid/params carries ONE resolved block-type/firmware variant of a block's editor
// layout: the block's editorName + family, plus which variant was chosen, plus ALL of that variant's
// pages (tabs → rows → controls) passed through VERBATIM from the codec's *_LAYOUTS (widget / rawWidget /
// placement / crossBlock / per-control fw preserved). No unioning across variants; the client renders
// exactly the pages the editor would show for the current block type.
export type DeviceLayout = {
  editorName: string;
  family: string;
  /** Chosen variant display name (e.g. 'Analog', '10 Band', 'Amp GTE 28.09'). */
  variantName: string;
  /** Chosen variant's block-type selector value(s), comma-joined as in the editor XML, or null for an
   *  unconditional / firmware-only-versioned variant (e.g. the Amp block). */
  variantValue: string | null;
  /** The selector param whose current value keyed `variantValue`, when the variant was folded up from
   *  page selectors (a family with no model selector — CABINET's `CABINET_MODE`). */
  variantSelectorParamName?: string;
  /** Firmware gate of the chosen variant, when present. */
  fw?: EditorLayoutVariant['fw'];
  /** True when the chosen variant is the firmware-current pinned one (amp DISTORT block). */
  pinned?: boolean;
  /** All pages of the chosen variant ONLY (editor display order); rows → controls verbatim from the codec. */
  pages: EditorLayoutPage[];
};

// Parse a variant/page selector `value` ("10,11,12") into the numeric block-type values it activates.
// Blank segments are dropped, so an EMPTY value ("") parses to NO values rather than to [0]: the editor
// writes a blank value on a group's catch-all page (the default for every type its explicit siblings
// don't name), and `Number('')` is 0 — without the blank filter that default reads as "type 0 only",
// which both hides it from every other type and duplicates the type-0 page (see filterPagesBySelector).
const parseSelectorValues = (value: string | null | undefined): number[] =>
  value == null
    ? []
    : value.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number).filter((n) => Number.isFinite(n));

// Pick the block-type / firmware variant that matches the block's CURRENT type value. The bundled
// layouts target the newest supported firmware, so variants gated `lt` are legacy and never eligible:
//   1. variants whose selector `value` list contains typeValue win (the normal per-type case);
//   2. else the unconditional (value === null) variants — the firmware-only-versioned Amp block, whose
//      variants all carry value:null but differ by `fw`;
//   3. else every variant (degenerate: nothing declared).
// Within the winning set, prefer the firmware-pinned variant (amp DISTORT ships every historical fw
// layout with exactly one pinned:true), else the first in editor order.
// A variant whose pages are ALL `lt`-gated is legacy too, even when the variant itself carries no `fw`:
// the editor moved those block types onto a newer variant's pages (TREMOLO types 0/2/4 fold into the
// value:null default at fw >= 8,00). Selecting it would resolve to zero pages and leave the block with
// no layout at all, so it is excluded here and the type falls through to the variant that succeeded it.
const selectVariant = (block: EditorBlockLayout, typeValue?: number, selectors?: SelectorValues): EditorLayoutVariant | undefined => {
  const variants = block.variants.filter((v) => v.fw?.lt == null && v.pages.some((p) => p.fw?.lt == null));
  if (!variants.length) return undefined;
  // A variant folded up from page-level selectors (a family with exactly one selector parameter —
  // CABINET's `CABINET_MODE`) carries that parameter on `selectorParamName`, so its `value` keys on
  // the selector's CURRENT value, not the block type. CABINET has no model selector, so a type-value
  // match could never select its DynaCab variant.
  const selectorName = variants.find((v) => v.selectorParamName)?.selectorParamName;
  if (selectorName) {
    const cur = selectors?.(selectorName);
    let cands = cur == null ? [] : variants.filter((v) => parseSelectorValues(v.value).includes(cur));
    if (!cands.length) cands = variants.filter((v) => v.value == null);
    if (!cands.length) cands = variants;
    return cands.find((v) => v.pinned) ?? cands[0];
  }
  let cands = typeValue == null ? [] : variants.filter((v) => parseSelectorValues(v.value).includes(typeValue));
  if (!cands.length) cands = variants.filter((v) => v.value == null);
  if (!cands.length) cands = variants;
  return cands.find((v) => v.pinned) ?? cands[0];
};

// Lookup from an editor selector parameter symbol (e.g. 'DISTORT_EQTYPE', 'DISTORT_TYPE') to the block's
// CURRENT numeric value of that param, or undefined when unknown. The driver builds this from the block's
// live read: the family type selector answers with the type already decoded in blockParams, other
// selectors (EQ type / drive type / …) with the block's named/enum param values.
export type SelectorValues = (selectorParamName: string) => number | undefined;

// Parse an editor firmware bound ("maj,min", e.g. "6,03" / "12,00") into a comparable integer. Absent → 0.
const fwBound = (v?: string): number => {
  if (!v) return 0;
  const [maj = 0, min = 0] = v.split(',').map((s) => Number(s.trim()) || 0);
  return maj * 1000 + min;
};

// Among same-named siblings (pages, or controls) that differ only by firmware gate, keep the one(s) that
// apply to the NEWEST firmware — deterministic, no live firmware version needed:
//   • a `gtet` (>=) sibling supersedes everything → keep the single highest `gtet`;
//   • else null-gated (always-applicable) siblings supersede `lt`-only ones → keep the null-gated ones;
//   • `lt`-only pages have already been removed: they apply only to older firmware.
// With no firmware gates in the set the siblings are genuinely distinct → all kept.
const preferNewestFw = <T extends { fw?: EditorFwRange }>(items: T[]): T[] => {
  if (items.length <= 1) return items;
  if (!items.some((i) => i.fw && (i.fw.gtet || i.fw.lt))) return items;
  const gtet = items.filter((i) => i.fw?.gtet);
  if (gtet.length) return [gtet.reduce((a, b) => (fwBound(b.fw!.gtet) > fwBound(a.fw!.gtet) ? b : a))];
  const nullGated = items.filter((i) => !i.fw?.gtet && !i.fw?.lt);
  if (nullGated.length) return nullGated;
  return [];
};

// Selector filter for one group of same-named pages: a page with no selector value is always kept; a
// selector-gated page is kept iff the block's CURRENT selector value is in its value list. A gated page
// with an EMPTY value list is the group's DEFAULT — the editor's catch-all, applying to every selector
// value its explicit siblings don't name (the Amp block ends each of its Ideal/Authentic groups with
// one; without it, the ~2/3 of amp models with no explicit Ideal page get no Ideal tab at all). It is
// used only when nothing explicit matches. When the current value is unknown (selector not resolvable)
// we never include the whole set — prefer the page whose list contains the block's type value, else the
// group's default, else the first explicitly-gated page in editor order.
const filterPagesBySelector = (
  group: EditorLayoutPage[],
  typeValue: number | undefined,
  selectors?: SelectorValues,
): EditorLayoutPage[] => {
  const isGated = (p: EditorLayoutPage) => p.selectorParamName != null && p.value != null;
  const gated = group.filter((p) => isGated(p) && parseSelectorValues(p.value).length > 0);
  const dflt = group.filter((p) => isGated(p) && parseSelectorValues(p.value).length === 0);
  if (!gated.length && !dflt.length) return group; // nothing selector-gated → all pages always apply
  const ungated = group.filter((p) => !isGated(p));
  const cur = selectors?.((gated[0] ?? dflt[0])!.selectorParamName!);
  if (cur != null) {
    // known current value → strict membership, falling back to the group's default page
    const hit = gated.filter((p) => parseSelectorValues(p.value).includes(cur));
    return [...ungated, ...(hit.length ? hit : dflt)];
  }
  const byType = typeValue != null ? gated.filter((p) => parseSelectorValues(p.value).includes(typeValue)) : [];
  const fallback = dflt.length ? dflt : gated.length ? [gated[0]!] : [];
  return [...ungated, ...(byType.length ? byType : fallback)];
};

// Drop controls that the newest firmware would hide: a control gated with an `lt` (only firmware < X)
// bound never applies to the newest firmware (whether it also carries a `gtet` — a closed range — or not).
// Controls with a `gtet`-only gate or no gate always apply and pass through untouched.
const pruneControlsByFw = (page: EditorLayoutPage): EditorLayoutPage => {
  let touched = false;
  const rows: EditorLayoutRow[] = page.rows.map((row) => {
    const controls = row.controls.filter((c) => {
      const drop = c.fw?.lt != null;
      if (drop) touched = true;
      return !drop;
    });
    return controls.length === row.controls.length ? row : { ...row, controls };
  });
  return touched ? { ...page, rows } : page;
};

// Filter a variant's pages down to what the editor actually shows for the block's current state: pages
// discard legacy `lt` pages, then group by display name (same-named pages are selector/firmware siblings).
// Each group collapses to the selector-matching page(s), firmware siblings collapse to the newest-firmware
// one, and per-control firmware gates prune controls hidden on the newest firmware. Order preserved.
export const resolveLayoutPages = (
  pages: EditorLayoutPage[],
  typeValue?: number,
  selectors?: SelectorValues,
): EditorLayoutPage[] => {
  const order: string[] = [];
  const groups = new Map<string, EditorLayoutPage[]>();
  for (const p of pages) {
    if (p.fw?.lt != null) continue;
    if (!groups.has(p.name)) { groups.set(p.name, []); order.push(p.name); }
    groups.get(p.name)!.push(p);
  }
  const out: EditorLayoutPage[] = [];
  for (const name of order) {
    const kept = preferNewestFw(filterPagesBySelector(groups.get(name)!, typeValue, selectors));
    for (const p of kept) out.push(pruneControlsByFw(p));
  }
  return out;
};

// Resolve a family's editor layout to the wire DeviceLayout for the block's CURRENT type value, with the
// selected variant's pages filtered to the current selector/firmware state (see resolveLayoutPages).
// When a renderer profile is supplied, each page's `layout` name resolves to its PageLayout `geometry`
// and each control's `rawWidget` to its outer `bounds` (both attached directly, so the client renders
// the device-authored geometry without reproducing any PageLayout/component constants).
export const layoutFrom = (layouts: DeviceEditorLayouts, renderer?: EditorRendererProfile) =>
  (family: string, typeValue?: number, selectors?: SelectorValues): DeviceLayout | undefined => {
    const block = layouts[family];
    if (!block) return undefined;
    const variant = selectVariant(block, typeValue, selectors);
    if (!variant) return undefined;
    const pages = resolveLayoutPages(variant.pages, typeValue, selectors);
    const servedPages: EditorLayoutPage[] = renderer
      ? pages.map((p) => ({
          ...p,
          ...(p.layout && renderer.pageLayouts[p.layout] ? { geometry: renderer.pageLayouts[p.layout] } : {}),
          rows: p.rows.map((r) => ({
            ...r,
            controls: r.controls.map((c) => ({
              ...c,
              ...(renderer.widgetBounds[c.rawWidget] ? { bounds: renderer.widgetBounds[c.rawWidget] } : {}),
            })),
          })),
        }))
      : pages;
    return {
      editorName: block.editorName,
      family: block.family,
      variantName: variant.name,
      variantValue: variant.value,
      ...(variant.selectorParamName ? { variantSelectorParamName: variant.selectorParamName } : {}),
      ...(variant.fw ? { fw: variant.fw } : {}),
      ...(variant.pinned ? { pinned: true } : {}),
      pages: servedPages,
    };
  };

// AM4 block-name → catalog family symbol (the AM4_LAYOUTS key). Most AM4 blocks match SLUG_FAMILY, but
// the AM4 catalog names its compressor `compressor` (not `comp`) and its volume/pan block `volpan`
// (not `volume`), so this map is explicit rather than piggy-backing the gen-3 SLUG_FAMILY table.
const AM4_FAMILY_BY_BLOCK: Record<string, string> = {
  amp: 'DISTORT', compressor: 'COMP', geq: 'GEQ', peq: 'PEQ', reverb: 'REVERB', delay: 'DELAY',
  chorus: 'CHORUS', flanger: 'FLANGER', rotary: 'ROTARY', phaser: 'PHASER', wah: 'WAH', volpan: 'VOLUME',
  tremolo: 'TREMOLO', filter: 'FILTER', drive: 'FUZZ', enhancer: 'ENHANCER', gate: 'GATE',
};
const am4LayoutOf = layoutFrom(AM4_LAYOUTS);
/** Editor-authentic layout for an AM4 block (by its lowercase block name, e.g. 'amp'/'drive'), for the
 *  block's current type value. Controls join to the AM4 catalog by cacheId in the codec; unresolved
 *  paramIds ride through as null (display-only). Undefined for a block with no AM4 layout. */
export const am4LayoutFor = (block: string, typeValue?: number, selectors?: SelectorValues): DeviceLayout | undefined => {
  const family = AM4_FAMILY_BY_BLOCK[block.toLowerCase()];
  return family ? am4LayoutOf(family, typeValue, selectors) : undefined;
};
