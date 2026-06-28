// Per-device profile: everything that differs between gen-3 units (model byte, grid size, param
// catalog, ranges, rosters, enum labels). The gen-3 effect codec itself is shared — only the data
// changes — so the device client picks a profile by the detected model and is otherwise generic.
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES } from 'fractal-midi/gen3/fm9';
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

export const PROFILES: Record<number, DeviceProfile> = {
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
