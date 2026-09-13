// Gen-3 parameter presentation: raw wire value → device-true display (value/norm/unit/min/max/log),
// the enum-option tables, the catalog "type" selector lookup, and the unit index. Pure over the
// profile — no transport. Split out of gen3.ts so blockParams/cabState/meters share one display path.
import { wireToDisplay } from 'forgefx-midi/shared';
import { resolveEnumValues } from 'forgefx-midi/gen3/axe-fx-iii';
import { MODEL_SELECTOR_OVERRIDES, type DeviceProfile } from '../../devices.js';
import { UNIT_LABEL, clamp01, round3, type ParamCandidate } from './support.js';

export class ParamDisplay {
  /** family → (paramId → catalog unit code). Built once per family and dropped whenever the profile
   *  swaps, so display resolves a param's unit in O(1) instead of scanning the family's param list. */
  #unitIndex = new Map<string, Map<number, string | undefined>>();
  #profile: () => DeviceProfile;

  constructor(profile: () => DeviceProfile) { this.#profile = profile; }

  /** Drop the memoized unit index after a runtime-profile swap. */
  invalidateUnitIndex(): void { this.#unitIndex.clear(); }

  #units(family: string): Map<number, string | undefined> {
    let m = this.#unitIndex.get(family);
    if (!m) {
      m = new Map();
      for (const p of this.#profile().params[family] ?? []) m.set(p.paramId, p.unit);
      this.#unitIndex.set(family, m);
    }
    return m;
  }

  /** Map a raw 0..65534 wire value to {value, norm, unit, min, max, log} via the device-true range.
   * Taper: a device-true explicit `range.taper` ('log'→log10; 'linear'|'flat'|'custom'→linear) wins;
   * absent it falls back to the typecode heuristic (middle nibble 4/5 = log10, e.g. freq cuts, else linear). */
  display(family: string | undefined, paramId: number, raw: number): { value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean } {
    const prof = this.#profile();
    const norm = clamp01(raw / 65534);
    const range = family ? prof.ranges[family]?.[paramId] : undefined;
    if (range && range.kind === 'float' && Number.isFinite(range.displayMin) && Number.isFinite(range.displayMax) && range.displayMin !== range.displayMax) {
      try {
        // Taper (log vs linear). A device-true explicit taper from the capture catalog WINS over the
        // typecode-nibble heuristic: 'log' → log sweep; 'linear' | 'flat' | 'custom' → linear. A
        // 'custom' taper's `taperPoints` are NOT applied on the wire yet, so custom is served linear
        // for now (the Axis side documents the same). A log sweep still requires a positive range —
        // wireToDisplay throws on log10 with displayMin<=0 — the same guard the nibble heuristic uses.
        let log: boolean;
        if (range.taper) {
          log = range.taper === 'log' && range.displayMin > 0;
        } else {
          const taperNib = (range.typecode >> 4) & 0xf;
          log = (taperNib === 4 || taperNib === 5) && range.displayMin > 0;
        }
        const v = wireToDisplay(raw, { displayMin: range.displayMin, displayMax: range.displayMax, displayScale: log ? 'log10' : 'linear' });
        // Prefer the DEVICE-TRUE unit captured by the live-walk (RangeDef.unit, view 0x00)
        // over the AM4-name-overlay catalog code; fall back to the overlay when absent.
        const unitCode = family ? this.#units(family).get(paramId) : undefined;
        return { value: round3(v), norm, unit: range.unit ?? ((unitCode && UNIT_LABEL[unitCode]) || undefined), min: range.displayMin, max: range.displayMax, log: log || undefined };
      } catch {
        /* fall through to 0..10 position */
      }
    }
    return { value: Math.round(norm * 1000) / 100, norm }; // 0..10 fallback
  }

  /** Device-true default: decoded to display units via `display` for a float param, or served as the
   *  raw ordinal for an enum (RangeDef.defaultRaw already stores the enum's default ordinal). */
  defaultDisplay(family: string | undefined, paramId: number, range: ParamCandidate['range']): number | undefined {
    if (!range || range.defaultRaw == null) return undefined;
    return range.kind === 'enum' ? range.defaultRaw : this.display(family, paramId, range.defaultRaw).value;
  }

  /** Build dropdown options for an enum param. Labels come from fractal-midi's enum overlay
   * (matched by device param name) where known; otherwise the bare ordinal. */
  enumOptions(family: string, paramId: number, name: string, min: number, max: number): { value: number; label: string }[] {
    const cache = this.#profile().enumLabelsFor(family, paramId); // device-true labels from the editor cache
    const ov = resolveEnumValues(name); // III overlay fallback
    const out: { value: number; label: string }[] = [];
    for (let v = min; v <= max && out.length < 128; v++) {
      const labelIndex = v - min;
      out.push({ value: v, label: cache?.[labelIndex] ?? ov?.values?.[labelIndex] ?? String(v) });
    }
    return out;
  }

  /** Resolve a param name (display label) → device-true paramId. 'Type' → the model-selector,
   *  in strict preference order: `<FAM>_MODEL`, the EXACT `<FAM>_TYPE`, then an explicit per-family
   *  override (MULTITAP/PLEX: the sub-model lives on `<FAM>_BASETYPE`). The unsafe `/TYPE$/` suffix
   *  fallback is deliberately absent (see the CABINET PID-43 bug). */
  paramId(family: string, name: string): number | undefined {
    const defs = this.#profile().params[family] ?? [];
    if (name.toLowerCase() === 'type') {
      return (defs.find((p) => p.name === `${family}_MODEL`)
        ?? defs.find((p) => p.name === `${family}_TYPE`)
        ?? (MODEL_SELECTOR_OVERRIDES[family] ? defs.find((p) => p.name === MODEL_SELECTOR_OVERRIDES[family]) : undefined))?.paramId;
    }
    return defs.find((p) => p.displayLabel === name || p.name === name)?.paramId;
  }
}
