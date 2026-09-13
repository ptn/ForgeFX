// Shared param-display helpers for the descriptor-based drivers (AM4 / gen-2). The bodies were
// duplicated verbatim across the drivers; keeping one copy means a calibration fix lands everywhere.
import type { PresetSnapshot } from 'forgefx-midi/core';
import type { EnumParam } from '../types.js';

/** First-wins dedupe by numeric id (two catalog defs can share a wire paramId). */
export function dedupeById<T extends { id: number }>(list: T[]): T[] {
  const seen = new Set<number>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** Reverse a decoded enum DISPLAY value to its wire ordinal: the matching label if present, else the
 *  raw ordinal (the reader's raw-int fallback path). */
export function enumOrdinal(p: { enumValues?: Record<number, string> }, display: number | string): number {
  if (typeof display === 'number') return display;
  for (const [ord, label] of Object.entries(p.enumValues ?? {})) if (label === display) return Number(ord);
  return Number(display) || 0;
}

/** Slider position (0..1) of a display value within [displayMin, displayMax] — the inverse of the
 *  package's decode(): linear by default, log10 for log-scaled params (`displayScale` on gen-2,
 *  `scaling` on the AM4). Purely presentational; clamped to [0,1], 0 on a degenerate/absent range. */
export function normOf(
  p: { displayMin?: number; displayMax?: number; displayScale?: string; scaling?: string },
  value: number
): number {
  const lo = p.displayMin, hi = p.displayMax;
  if (lo === undefined || hi === undefined) return 0;
  const log = p.displayScale === 'log10' || p.scaling === 'log10';
  let n: number;
  if (log && lo > 0 && hi > 0 && hi !== lo) n = Math.log(value / lo) / Math.log(hi / lo);
  else if (hi !== lo) n = (value - lo) / (hi - lo);
  else n = 0;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Case/space/underscore-insensitive lookup of a decoded param value by catalog name. */
export function paramLookup(decoded: Record<string, number | string>): (name: string) => number | string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '');
  const decByNorm = new Map(Object.entries(decoded).map(([k, v]) => [norm(k), v]));
  return (name: string) => (name in decoded ? decoded[name] : decByNorm.get(norm(name)));
}

/** Decoded param dict for a slot: flat `params`, else the preferred active channel (by letter), else
 *  the first channel present. */
export function slotParamValues(
  slot: PresetSnapshot['slots'][number] | undefined,
  preferredIdx?: number,
  chanLetters?: readonly string[]
): Record<string, number | string> {
  if (!slot) return {};
  if (slot.params) return slot.params as Record<string, number | string>;
  const byCh = slot.params_by_channel;
  if (byCh) {
    if (preferredIdx !== undefined && chanLetters) {
      const letter = chanLetters[preferredIdx];
      const pref = letter ? byCh[letter] : undefined;
      if (pref) return pref as Record<string, number | string>;
    }
    const first = Object.values(byCh)[0];
    if (first) return first as Record<string, number | string>;
  }
  return {};
}

/** The leading virtual Bypass enum (id 0xffff) shared by gen-2 / AM4 blockParams — its own route
 *  (/preset/blocks/:eid/bypass); never setParam. */
export function bypassEnum(bypassed: boolean): EnumParam {
  return { id: 0xffff, name: 'Bypass', value: bypassed ? 1 : 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] };
}
