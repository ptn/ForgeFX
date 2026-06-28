// Per-device profile: everything that differs between gen-3 units (model byte, grid size, param
// catalog, ranges, rosters, enum labels). The gen-3 effect codec itself is shared — only the data
// changes — so the device client picks a profile by the detected model and is otherwise generic.
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES } from 'fractal-midi/gen3/fm9';
import { PARAMS_BY_FAMILY as AXE3_PARAMS, resolveEnumValues as axe3Enum } from 'fractal-midi/gen3/axe-fx-iii';
import { rosterBySlug, enumLabelsFor as fm3EnumLabels, type TypeModel } from './defs.js';

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
  params: ParamsByFamily;
  ranges: Ranges;
  rosterFor(slug: string): TypeModel[];
  enumLabelsFor(family: string, paramId: number): string[] | undefined;
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
    params: axe3Params as unknown as ParamsByFamily,
    ranges: AXE3_RANGES,
    rosterFor: axe3RosterFor,
    enumLabelsFor: axe3EnumLabels
  },
  0x11: {
    model: 0x11, key: 'fm3', name: 'FM3', rows: 4, cols: 12,
    params: FM3_PARAMS_BY_FAMILY as unknown as ParamsByFamily,
    ranges: FM3_RANGES as unknown as Ranges,
    rosterFor: rosterBySlug, // device-true names + basedOn (from the editor-cache definitions)
    enumLabelsFor: fm3EnumLabels
  },
  0x12: {
    model: 0x12, key: 'fm9', name: 'FM9', rows: 6, cols: 14,
    params: fm9Params,
    ranges: FM9_RANGES as unknown as Ranges,
    rosterFor: fm9RosterFor,
    enumLabelsFor: fm9EnumLabels
  }
};

export const DEFAULT_PROFILE: DeviceProfile = PROFILES[0x11]!;
export const profileForModel = (model: number): DeviceProfile => PROFILES[model] ?? DEFAULT_PROFILE;
export const profileForKey = (key: string): DeviceProfile | undefined => Object.values(PROFILES).find((p) => p.key === key);
