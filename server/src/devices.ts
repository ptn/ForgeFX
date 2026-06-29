// Per-device profile: everything that differs between gen-3 units (model byte, grid size, param
// catalog, ranges, rosters, enum labels). The gen-3 effect codec itself is shared — only the data
// changes — so the device client picks a profile by the detected model and is otherwise generic.
import {
  FM3_RANGES,
  FM3_PARAMS_BY_FAMILY,
  FM3_ROSTERS,
  FM3_ENUM_OVERRIDES,
  FM3_CAB_IRS,
  FM3_FAMILY_BY_EFFECT_ID,
  FM3_LAYOUTS,
  type Fm3TypeModel,
} from 'fractal-midi/gen3/fm3';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES, FM9_FAMILY_BY_EFFECT_ID, FM9_LAYOUTS } from 'fractal-midi/gen3/fm9';
import { PARAMS_BY_FAMILY as AXE3_PARAMS, resolveEnumValues as axe3Enum, AXE3_LAYOUTS } from 'fractal-midi/gen3/axe-fx-iii';

// Editor-authentic UI layout (pages → controls), per family, from fractal-midi (*_LAYOUTS).
export type LayoutControl = { label: string; paramName: string; paramId: number | null; col?: number };
export type DeviceLayout = { editorName?: string; pages: { name: string; controls: LayoutControl[] }[] };
type LayoutMap = Record<string, DeviceLayout>;
// gen-3 shared virtual-effect effectIds (capture-confirmed on FM3; III reuses them since its package
// ships layouts but no effectId table). Audio-block eids resolve via the codec (slugForEffectId).
const VIRTUAL_EID_FAMILY: Record<number, string> = { 1: 'GLOBAL', 2: 'CONTROLLERS', 3: 'MOD', 190: 'MIDIBLOCK', 199: 'FC' };
const eidFamily = (map?: Record<number, string>) => (eid: number): string | undefined => map?.[eid] ?? VIRTUAL_EID_FAMILY[eid];
const layoutOf = (layouts: LayoutMap) => (family: string): DeviceLayout | undefined => layouts[family];

// The model-roster entry shape ForgeFX surfaces to the UI (value + name + lineage). FM3's
// fractal-midi rosters already carry this exact shape (Fm3TypeModel); FM9/III synthesize it.
export type TypeModel = { value: number; name: string; manufacturer: string | null; basedOn: string | null };

// pack slug → gen-3 catalog family (shared across FM3/FM9 — family names are the same)
export const SLUG_FAMILY: Record<string, string> = {
  amp: 'DISTORT', cab: 'CABINET', drive: 'FUZZ', comp: 'COMP', multicomp: 'MULTICOMP',
  peq: 'PEQ', geq: 'GEQ', reverb: 'REVERB', delay: 'DELAY', multitap: 'MULTITAP',
  chorus: 'CHORUS', flanger: 'FLANGER', phaser: 'PHASER', rotary: 'ROTARY', tremolo: 'TREMOLO',
  pitch: 'PITCH', wah: 'WAH', filter: 'FILTER', formant: 'FORMANT', enhancer: 'ENHANCER',
  mixer: 'MIXER', volume: 'VOLUME', input: 'INPUT', output: 'OUTPUT', gate: 'GATE',
  synth: 'SYNTH', ringmod: 'RINGMOD', looper: 'LOOPER', resonator: 'RESONATOR',
  megatap: 'MEGATAP', tentap: 'TENTAP', plex: 'PLEX', send: 'FDBKSEND', return: 'FDBKRET',
  multiplexer: 'MULTIPLEXER'
};

type ParamDef = { paramId: number; name: string; displayLabel?: string; unit?: string };
type RangeDef = { kind: string; displayMin: number; displayMax: number; typecode: number; scale?: number; step?: number };
type ParamsByFamily = Record<string, ParamDef[]>;
type Ranges = Record<string, Record<number, RangeDef>>;

export interface DeviceProfile {
  model: number; // SysEx model byte (f[4])
  key: string; // 'fm3' | 'fm9'
  name: string;
  rows: number; // routing-grid dimensions
  cols: number;
  // How many of each block FAMILY this specific unit can actually run. The gen-3 protocol reserves
  // an ID range per family (Amp = eid 58..61) but a given unit allows far fewer — the FM3 has ONE
  // amp, not four. These device-true counts aren't in fractal-midi or the editor cache (they're
  // baked into the editor binary), so they live here, transcribed from Fractal's "Product BLOCKS
  // Comparison" (Blocks Guide) + the wiki "Current hardware" table. Unlisted families fall back to
  // `defaultInstances` (1) — i.e. only families listed with ≥2 get multiple palette instances.
  defaultInstances: number;
  instanceLimits: Record<string, number>; // slug → device-true instance count (≥2 only; rest = 1)
  params: ParamsByFamily;
  ranges: Ranges;
  rosterFor(slug: string): TypeModel[];
  enumLabelsFor(family: string, paramId: number): string[] | undefined;
  /** Cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — for the cab IR picker. {} if the device has none. */
  cabIrs(): Record<string, string[]>;
  /** effectId → catalog family, incl. virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199). */
  familyForEffectId(eid: number): string | undefined;
  /** Editor-authentic UI layout (pages → controls) for a family, or undefined. */
  layoutFor(family: string): DeviceLayout | undefined;
}

// FM9 enum data ships as FM9_ENUM_OVERRIDES, keyed by the param's NAME → { ordinal: label }.
const fm9Over = FM9_ENUM_OVERRIDES as unknown as Record<string, Record<number, string>>;
const fm9Params = FM9_PARAMS_BY_FAMILY as unknown as ParamsByFamily;
const recToRoster = (r: Record<number, string>): TypeModel[] => {
  const out: TypeModel[] = [];
  for (const [k, name] of Object.entries(r)) out[Number(k)] = { value: Number(k), name, manufacturer: null, basedOn: null };
  return out;
};
const recToLabels = (r: Record<number, string>): string[] => {
  const out: string[] = [];
  for (const [k, name] of Object.entries(r)) out[Number(k)] = name;
  return out;
};
function fm9RosterFor(slug: string): TypeModel[] {
  const fam = SLUG_FAMILY[slug.toLowerCase()];
  const r = fam && fm9Over[`${fam}_TYPE`];
  return r ? recToRoster(r) : [];
}
function fm9EnumLabels(family: string, paramId: number): string[] | undefined {
  const p = fm9Params[family]?.find((x) => x.paramId === paramId);
  const r = p && fm9Over[p.name];
  return r ? recToLabels(r) : undefined;
}

// FM3 ships its device-true data IN fractal-midi (uniform with FM9/III): FM3_ROSTERS = slug → model
// list (already the {value,name,manufacturer,basedOn} shape, so no synthesis), FM3_ENUM_OVERRIDES =
// family → paramId → labels[], FM3_CAB_IRS = bank → IR names. ForgeFX is now a thin consumer.
const fm3Rosters = FM3_ROSTERS as unknown as Record<string, Fm3TypeModel[]>;
const fm3Enums = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const fm3CabIrs = FM3_CAB_IRS as unknown as Record<string, string[]>;
function fm3RosterFor(slug: string): TypeModel[] {
  return (fm3Rosters[slug.toLowerCase()] as TypeModel[] | undefined) ?? [];
}
function fm3EnumLabels(family: string, paramId: number): string[] | undefined {
  return fm3Enums[family]?.[String(paramId)];
}

// Axe-Fx III carries ranges inline on its params (no separate *_RANGES); synthesize a ranges table.
// (no typecode → linear taper; a few freq cuts that should be log will read linearly — minor.)
const CONT_UNITS = new Set(['numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees']);
const axe3Params = AXE3_PARAMS as unknown as Record<string, (ParamDef & { displayMin?: number; displayMax?: number })[]>;
const AXE3_RANGES: Ranges = (() => {
  const out: Ranges = {};
  for (const [fam, list] of Object.entries(axe3Params)) {
    out[fam] = {};
    for (const p of list) {
      if (p.displayMin == null || p.displayMax == null) continue;
      out[fam][p.paramId] = { kind: CONT_UNITS.has(p.unit ?? '') ? 'float' : 'enum', displayMin: p.displayMin, displayMax: p.displayMax, typecode: 0 };
    }
  }
  return out;
})();
// III enum labels via its overlay; model-type ROSTERS (250+ amps/cabs) are read live from the unit
// (GEN3_READ_ROSTERS) on the III, not bundled — so type NAMES are a follow-up; degrades to ordinals.
function axe3RosterFor(slug: string): TypeModel[] {
  const fam = SLUG_FAMILY[slug.toLowerCase()];
  const vals = fam ? (axe3Enum(`${fam}_TYPE`)?.values as string[] | undefined) : undefined;
  return vals ? vals.map((name, i) => ({ value: i, name, manufacturer: null, basedOn: null })) : [];
}
function axe3EnumLabels(family: string, paramId: number): string[] | undefined {
  const p = axe3Params[family]?.find((x) => x.paramId === paramId);
  const vals = p ? (axe3Enum(p.name)?.values as string[] | undefined) : undefined;
  return vals && vals.length ? vals : undefined;
}

export const PROFILES: Record<number, DeviceProfile> = {
  0x10: {
    model: 0x10, key: 'axe3', name: 'Axe-Fx III', rows: 6, cols: 14,
    defaultInstances: 1,
    instanceLimits: { amp: 2, cab: 2, drive: 4, comp: 4, multicomp: 2, geq: 4, peq: 4, filter: 4, volume: 4, gate: 4, mixer: 4, multiplexer: 2, input: 5, output: 4, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, reverb: 2, delay: 4, multitap: 2, megatap: 2, tentap: 2, plex: 2, pitch: 2, synth: 2, send: 2, return: 2 },
    params: axe3Params as unknown as ParamsByFamily,
    ranges: AXE3_RANGES,
    rosterFor: axe3RosterFor,
    enumLabelsFor: axe3EnumLabels,
    cabIrs: () => ({}), // III IR names are read live from the unit, not bundled
    familyForEffectId: eidFamily(), // III ships no effectId table → shared gen-3 virtual eids only
    layoutFor: layoutOf(AXE3_LAYOUTS as unknown as LayoutMap)
  },
  0x11: {
    model: 0x11, key: 'fm3', name: 'FM3', rows: 4, cols: 12,
    // FM3 = ONE amp / ONE cab / ONE reverb / ONE delay-family-pitch etc. (its DSP is ~1/5 the III).
    defaultInstances: 1,
    instanceLimits: { input: 2, output: 2, drive: 2, comp: 2, geq: 2, peq: 2, filter: 4, volume: 2, gate: 2, mixer: 4, multiplexer: 2, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, delay: 2, multitap: 2, send: 2, return: 2 },
    params: FM3_PARAMS_BY_FAMILY as unknown as ParamsByFamily,
    ranges: FM3_RANGES as unknown as Ranges,
    rosterFor: fm3RosterFor, // device-true names + manufacturer + basedOn (from fractal-midi FM3_ROSTERS)
    enumLabelsFor: fm3EnumLabels,
    cabIrs: () => fm3CabIrs, // device-true IR names per bank (fractal-midi FM3_CAB_IRS)
    familyForEffectId: eidFamily(FM3_FAMILY_BY_EFFECT_ID as Record<number, string>),
    layoutFor: layoutOf(FM3_LAYOUTS as unknown as LayoutMap)
  },
  0x12: {
    model: 0x12, key: 'fm9', name: 'FM9', rows: 6, cols: 14,
    defaultInstances: 1,
    instanceLimits: { amp: 2, cab: 2, drive: 3, comp: 2, multicomp: 2, geq: 4, peq: 4, filter: 4, volume: 4, gate: 4, mixer: 4, multiplexer: 2, input: 4, output: 3, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, reverb: 2, delay: 2, multitap: 2, megatap: 2, tentap: 2, send: 2, return: 2 },
    params: fm9Params,
    ranges: FM9_RANGES as unknown as Ranges,
    rosterFor: fm9RosterFor,
    enumLabelsFor: fm9EnumLabels,
    cabIrs: () => ({}), // FM9 IR names not yet bundled
    familyForEffectId: eidFamily(FM9_FAMILY_BY_EFFECT_ID as Record<number, string>),
    layoutFor: layoutOf(FM9_LAYOUTS as unknown as LayoutMap)
  }
};

export const DEFAULT_PROFILE: DeviceProfile = PROFILES[0x11]!;
export const profileForModel = (model: number): DeviceProfile => PROFILES[model] ?? DEFAULT_PROFILE;
export const profileForKey = (key: string): DeviceProfile | undefined => Object.values(PROFILES).find((p) => p.key === key);
