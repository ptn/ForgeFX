// Universal FM3 preset-body param decoder.
//
// The decompressed preset body stores each PLACED block's parameters as a flat array of u16 LE
// values, in paramId order, at stride 2, starting at `block header + PARAM_ARRAY_BASE`. Values use
// the device's 0..65534 model (continuous params are normalized to that range; enum/type params hold
// a raw ordinal). This single layout — verified at 100% enum-fit across 15 block instances in real
// FM3 presets (Input/Output/Comp/PEQ/Amp/Cab/Reverb/Wah/Pitch/Synth/Gate/RingMod/Filter…) — replaces
// the per-family device-diffed model offsets: every param of every family decodes from the catalog
// tables in `fractal-midi` (no per-param hardware calibration).
//
//   value(block, P) = u16LE at (header + 0x2e + 2*P)          // amp repeats per channel at +0x120 x4
//   header          = effectId u16 LE + >=8 zero bytes, scanned from the param-region floor (0x1202)
//   names/ranges    = FM3_PARAMS (paramId -> name/label/unit), FM3_RANGES (kind + display range),
//                     FM3_ENUM_OVERRIDES (ordinal -> label), FM3_ROSTERS (clean model names, 8 families)
//
// All offsets/tables are DATA derived from the device's own editor configuration; the RE method that
// produced them stays out of this repo (facts, not expression).

import {
  FM3_PARAMS_BY_FAMILY,
  FM3_RANGES,
  FM3_ENUM_OVERRIDES,
  FM3_ROSTERS,
  FM3_FAMILY_BY_EFFECT_ID
} from 'forgefx-midi/gen3/fm3';

/** u16 array base, relative to a block's header. Universal across families (enum-fit confirmed). */
const PARAM_ARRAY_BASE = 0x2e;
const PARAM_REGION_FLOOR = 0x1202; // the always-present amp header; below it is the setup/global prelude
const INSTANCE_SPAN = 4; // a family reserves eid..eid+3 (instances 1..4) in the grid id space
const AMP_EID = 58;
const AMP_CHANNEL_STRIDE = 0x120; // the amp repeats its whole param array per channel (A-D)
const AMP_CHANNELS = 4;
const VALUE_MODEL_MAX = 65534;

// FM3 catalog family symbol -> our roster/UI slug. Families with a clean model roster map to it;
// everything else lower-cases the symbol (the slug only drives grouping + roster lookup).
const FAMILY_TO_SLUG: Record<string, string> = {
  DISTORT: 'amp',
  CABINET: 'cab',
  COMP: 'comp',
  DELAY: 'delay',
  FUZZ: 'drive',
  GEQ: 'geq',
  REVERB: 'reverb',
  WAH: 'wah'
};
const slugFor = (family: string): string => FAMILY_TO_SLUG[family] ?? family.toLowerCase();

// The single TYPE/model selector paramId per family, from the device's own param catalog
// (the `<FAMILY>_TYPE` entry). Confirmed against the device-diffed model offsets on 6/8 rostered
// families. Families whose type is multi-slot (CABINET = 4 IR slots, SYNTH = 3 voices) have no single
// type param → null (their "model" is reported per slot elsewhere / not a single name).
const TYPE_PARAM_BY_FAMILY: Record<string, number | null> = (() => {
  const out: Record<string, number | null> = {};
  for (const [family, params] of Object.entries(FM3_PARAMS_BY_FAMILY)) {
    const exact = params.find((p) => p.name === `${family}_TYPE`);
    out[family] = exact ? exact.paramId : null;
  }
  return out;
})();

export interface DecodedParam {
  paramId: number;
  /** Catalog symbol, e.g. DISTORT_TYPE. */
  name: string;
  /** Human label, e.g. "Type", "Drive". */
  label: string;
  /** 'enum' | 'float' | … from FM3_RANGES (undefined if the param has no range row). */
  kind?: string;
  /** Raw stored u16 (0..65534 model). */
  raw: number;
  /** Display value for numeric params (display units); null for enums / un-ranged params. */
  value: number | null;
  unit?: string;
  /** Resolved label for enum params (type/model/mode names). */
  enumLabel?: string;
}
export interface DecodedBlock {
  effectId: number;
  family: string;
  slug: string;
  /** 1-based instance (a family can place up to 4). */
  instance: number;
  /** Amp only: channel index 0-3 (A-D). Undefined for single-channel blocks. */
  channel?: number;
  /** The block's type/model name, when it has a single type selector. */
  typeName: string | null;
  params: DecodedParam[];
}

const u16 = (body: Uint8Array, o: number): number => (o + 1 < body.length ? body[o]! | (body[o + 1]! << 8) : 0);

/** Locate a block's header in the param region: effectId u16 LE + >=8 zero bytes, at/after the floor. */
function findHeader(body: Uint8Array, eid: number): number | null {
  for (let i = PARAM_REGION_FLOOR; i + 10 < body.length; i++) {
    if ((body[i]! | (body[i + 1]! << 8)) !== eid) continue;
    let zeros = true;
    for (let k = 2; k < 10; k++) if (body[i + k] !== 0) { zeros = false; break; }
    if (zeros) return i;
  }
  return null;
}

/** Resolve an enum ordinal to a label: device enum overrides first, then a clean model roster
 *  (for the type param of rostered families), else a `#ordinal` fallback. */
function enumLabel(family: string, slug: string, paramId: number, isType: boolean, ord: number): string {
  const ov = (FM3_ENUM_OVERRIDES as Record<string, Record<string, string[]>>)[family];
  const fromOverride = ov?.[String(paramId)]?.[ord];
  if (fromOverride) return fromOverride;
  if (isType) {
    const roster = FM3_ROSTERS[slug as keyof typeof FM3_ROSTERS];
    const hit = roster?.find((r) => r.value === ord);
    if (hit) return hit.name;
  }
  return `#${ord}`;
}

/** Decode every named param of one placed block instance at a given header (+ optional channel offset). */
function decodeOne(body: Uint8Array, eid: number, family: string, header: number, instance: number, channel?: number): DecodedBlock {
  const slug = slugFor(family);
  const typePid = TYPE_PARAM_BY_FAMILY[family] ?? null;
  const chOff = channel == null ? 0 : channel * AMP_CHANNEL_STRIDE;
  const ranges = FM3_RANGES[family as keyof typeof FM3_RANGES] ?? {};
  const catalog = FM3_PARAMS_BY_FAMILY[family] ?? [];

  const params: DecodedParam[] = [];
  let typeName: string | null = null;
  for (const { paramId, name, displayLabel, unit } of catalog) {
    const r = ranges[paramId];
    const raw = u16(body, header + PARAM_ARRAY_BASE + 2 * paramId + chOff);
    const isType = typePid != null && paramId === typePid;
    let value: number | null = null;
    let eLabel: string | undefined;
    if (r?.kind === 'enum') {
      eLabel = enumLabel(family, slug, paramId, isType, raw);
    } else if (r && (r.displayMax !== r.displayMin)) {
      value = r.displayMin + (raw / VALUE_MODEL_MAX) * (r.displayMax - r.displayMin);
    } else {
      value = raw; // un-ranged / scale-0 param: surface the raw value
    }
    if (isType && eLabel) typeName = eLabel;
    params.push({ paramId, name, label: displayLabel ?? name, kind: r?.kind, raw, value, unit, enumLabel: eLabel });
  }
  return { effectId: eid, family, slug, instance, channel, typeName, params };
}

/** Decode all placed blocks' full params from a decompressed preset body.
 *  `placedEids` (the grid's placed effectIds) gates which instances are read — required to avoid
 *  phantom headers (a small effectId can match the zero-byte signature inside another block's data). */
export function readBlockParamsFull(body: Uint8Array, placedEids: ReadonlySet<number>): DecodedBlock[] {
  const out: DecodedBlock[] = [];
  const byEffect = FM3_FAMILY_BY_EFFECT_ID as Record<string, string>;
  // group placed eids by family base so instance numbers are stable
  for (const eid of [...placedEids].sort((a, b) => a - b)) {
    const family = byEffect[String(eid)];
    if (!family || !FM3_PARAMS_BY_FAMILY[family as keyof typeof FM3_PARAMS_BY_FAMILY]) continue;
    const header = findHeader(body, eid);
    if (header == null) continue;
    // instance number = 1 + count of same-family eids below this one that are also placed
    // (a family occupies the contiguous range eid_base..eid_base+3 in the grid id space).
    let instance = 1;
    for (let k = 1; k <= INSTANCE_SPAN; k++) if (placedEids.has(eid - k) && byEffect[String(eid - k)] === family) instance++;
    if (family === 'DISTORT') {
      for (let ch = 0; ch < AMP_CHANNELS; ch++) out.push(decodeOne(body, eid, family, header, instance, ch));
    } else {
      out.push(decodeOne(body, eid, family, header, instance));
    }
  }
  return out;
}

/** Compact, search-oriented projection: per family slug, the distinct TYPE/model names in use.
 *  Back-compat with the old `models` field consumed by the library. */
export function modelsFromBlocks(blocks: readonly DecodedBlock[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const b of blocks) {
    if (!b.typeName || b.typeName.startsWith('#')) continue;
    (out[b.slug] ??= new Set()).add(b.typeName);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}
