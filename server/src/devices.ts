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
  FM3_FC_EFFECT_ID,
  FM3_FC_SWITCHES,
  FM3_FC_VIEWS,
  FM3_FC_LAYOUTS as FM3_FC_LAYOUT_COUNT,
  FM3_FC_CONFIGS_PER_LAYOUT,
  FM3_FC_LABEL_LEN,
  FM3_FC_PARAMS_WIDTH,
  FM3_FC_FIELDS,
  FM3_FC_CATEGORIES,
  FM3_FC_COLORS,
  FM3_FC_LABEL_MODES,
  FM3_FC_FUNCTIONS,
  FM3_FC_CHANNELS,
  FM3_MOD_EFFECT_ID,
  FM3_MOD_SLOT_COUNT,
  FM3_MOD_SOURCES,
  FM3_MOD_FIELDS,
  FM3_MONITOR_PARAMS,
} from 'forgefx-midi/gen3/fm3';
import {
  FM9_RANGES, FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES, FM9_FAMILY_BY_EFFECT_ID, FM9_LAYOUTS,
  FM9_MONITOR_PARAMS,
  FM9_FC_EFFECT_ID, FM9_FC_CONFIGS, FM9_FC_PARAMS_WIDTH, FM9_FC_FIELDS, FM9_FC_CATEGORIES, FM9_FC_LABEL_MODES,
  FM9_FC_LAYOUTS, FM9_FC_CONFIGS_PER_LAYOUT, FM9_FC_SWITCH_SLOTS_PER_LAYOUT,
  FM9_MOD_EFFECT_ID, FM9_MOD_SLOT_COUNT, FM9_MOD_FIELDS,
  FM9_CAB_IRS,
} from 'forgefx-midi/gen3/fm9';
import {
  PARAMS_BY_FAMILY as AXE3_PARAMS, resolveEnumValues as axe3Enum, GEN3_READ_ROSTERS, AXE3_LAYOUTS,
  AXE3_ENUM_OVERRIDES, AXE3_RANGES as AXE3_DEVICE_RANGES, AXE3_CAB_IRS,
  AXE3_MONITOR_PARAMS,
  AXE3_FC_EFFECT_ID, AXE3_FC_CONFIGS, AXE3_FC_PARAMS_WIDTH, AXE3_FC_FIELDS,
  AXE3_MOD_EFFECT_ID, AXE3_MOD_SLOT_COUNT, AXE3_MOD_FIELDS, AXE3_MOD_SOURCES_STATUS,
} from 'forgefx-midi/gen3/axe-fx-iii';

// Editor-authentic UI layout (pages → controls), per family, from fractal-midi (*_LAYOUTS).
export type LayoutControl = { label: string; paramName: string; paramId: number | null; col?: number };
export type DeviceLayout = { editorName?: string; pages: { name: string; controls: LayoutControl[] }[] };
type LayoutMap = Record<string, DeviceLayout>;
// gen-3 shared virtual-effect effectIds (capture-confirmed on FM3; III reuses them since its package
// ships layouts but no effectId table). Audio-block eids resolve via the codec (slugForEffectId).
const VIRTUAL_EID_FAMILY: Record<number, string> = { 1: 'GLOBAL', 2: 'CONTROLLERS', 3: 'MOD', 190: 'MIDIBLOCK', 199: 'FC' };
const eidFamily = (map?: Record<number, string>) => (eid: number): string | undefined => map?.[eid] ?? VIRTUAL_EID_FAMILY[eid];
const layoutOf = (layouts: LayoutMap) => (family: string): DeviceLayout | undefined => layouts[family];

// FC + Modifier address models (FM3-decoded; other devices not decoded yet). Lets the client compute
// (eid,pid) for any footswitch field / modifier field without hard-coding paramIds.
// One FC param-base field: gen-3 FC params are addressed as `base + config*stride (+ index)`.
// FM3 fields carry base/width/stride; FM9 the same; the III's carry base/width (stride = width).
export type FcFieldDef = { base?: number; width?: number; stride?: number; pid?: number; paramName?: string };
export type FcModel = {
  effectId: number;
  paramsWidth: number;
  /** Total addressable FC configs (FM3: layouts×configsPerLayout; FM9/III: 108). */
  configs: number;
  fields: Readonly<Record<string, FcFieldDef>>;
  categories?: Readonly<Record<number, string>>;
  labelModes?: Readonly<Record<number, string>>;
  /** True when the device supports the live per-switch state read (`fcReadState`). FM3 only —
   *  FM9/III expose the address model here but their (layout,view,switch) decomposition and
   *  label/LED-colour bases are not statically recovered, so live reads stay gated. */
  liveState: boolean;
  // ── FM3-only live-read geometry + display metadata (present when liveState) ──
  switches?: number;
  views?: number;
  layouts?: number;
  configsPerLayout?: number;
  labelLen?: number;
  colors?: Readonly<Record<number, { name: string; hex: string }>>;
  functions?: typeof FM3_FC_FUNCTIONS;
  channels?: readonly string[];
};
export type ModSource = { name: string; ordinal: number };
export type ModModel = {
  /** effectId of modifier slot 1; slot N (1-based) = effectId + (N-1). */
  effectId: number;
  slotCount: number;
  /** field → { pid }. Binding uses source(0)/targetEffectId(8)/targetParam(9). */
  fields: Readonly<Record<string, { pid: number }>>;
  /** Known modulation sources (name → MOD_CTRLID ordinal). Empty when the device's source
   *  enum is runtime-built and not yet captured (FM9/III) — binding still works. */
  sources: readonly ModSource[];
  /** Note on why `sources` may be empty (device-specific, capture-pending). */
  sourcesNote?: string;
};
const FM3_FC_MODEL: FcModel = {
  effectId: FM3_FC_EFFECT_ID,
  paramsWidth: FM3_FC_PARAMS_WIDTH,
  configs: FM3_FC_LAYOUT_COUNT * FM3_FC_CONFIGS_PER_LAYOUT,
  fields: FM3_FC_FIELDS,
  categories: FM3_FC_CATEGORIES,
  labelModes: FM3_FC_LABEL_MODES,
  liveState: true,
  switches: FM3_FC_SWITCHES,
  views: FM3_FC_VIEWS,
  layouts: FM3_FC_LAYOUT_COUNT,
  configsPerLayout: FM3_FC_CONFIGS_PER_LAYOUT,
  labelLen: FM3_FC_LABEL_LEN,
  colors: FM3_FC_COLORS,
  functions: FM3_FC_FUNCTIONS,
  channels: FM3_FC_CHANNELS,
};
const FM3_MOD_MODEL: ModModel = {
  effectId: FM3_MOD_EFFECT_ID,
  slotCount: FM3_MOD_SLOT_COUNT,
  fields: FM3_MOD_FIELDS,
  sources: FM3_MOD_SOURCES.map((s) => ({ name: s.name, ordinal: s.ordinal }))
};

// FM9 + Axe-Fx III FC address models (binary-confirmed bases; live per-switch read NOT supported —
// their config decomposition + label/colour bases are capture-only). Exposed via /fc/model so Axis
// can compute + read/write FC params through the generic (eid 199, pid) path.
const FM9_FC_MODEL: FcModel = {
  effectId: FM9_FC_EFFECT_ID,
  paramsWidth: FM9_FC_PARAMS_WIDTH,
  configs: FM9_FC_CONFIGS,
  fields: FM9_FC_FIELDS,
  categories: FM9_FC_CATEGORIES,
  labelModes: FM9_FC_LABEL_MODES,
  liveState: false,
  // Device-true geometry (binary-mined): 9 layouts (index 8 = Master) x 12 switch slots; config =
  // layout * configsPerLayout + switchSlot. NO `views` — that paging is an FM3-only UI concept.
  layouts: FM9_FC_LAYOUTS,
  configsPerLayout: FM9_FC_CONFIGS_PER_LAYOUT,
  switches: FM9_FC_SWITCH_SLOTS_PER_LAYOUT,
};
const AXE3_FC_MODEL: FcModel = {
  effectId: AXE3_FC_EFFECT_ID,
  paramsWidth: AXE3_FC_PARAMS_WIDTH,
  configs: AXE3_FC_CONFIGS,
  fields: AXE3_FC_FIELDS,
  liveState: false,
};
// FM9 + III modifier models: field map is binary-confirmed (source 0 / targetEffectId 8 /
// targetParam 9) so /mod/bind works; the source enum is runtime-built and not yet captured.
const FM9_MOD_MODEL: ModModel = {
  effectId: FM9_MOD_EFFECT_ID,
  slotCount: FM9_MOD_SLOT_COUNT,
  fields: FM9_MOD_FIELDS,
  sources: [],
  sourcesNote: 'FM9 modulation-source enum is runtime-built (device-specific) and not yet captured; do not reuse FM3 ordinals.'
};
const AXE3_MOD_MODEL: ModModel = {
  effectId: AXE3_MOD_EFFECT_ID,
  slotCount: AXE3_MOD_SLOT_COUNT,
  fields: AXE3_MOD_FIELDS,
  sources: [],
  sourcesNote: `Axe-Fx III modulation-source enum: ${AXE3_MOD_SOURCES_STATUS} — capture-pending; do not reuse FM3 ordinals.`
};

// Per-block monitor (meter) parameter tables — read-only pids + dB ranges, by parameterName.
// Surfaced via /preset/monitors so Axis can render meters from the standard per-block reads.
export type MonitorParams = Readonly<Record<string, { family: string; pid: number; role: string; minDb?: number; maxDb?: number; widgetConfirmed: boolean }>>;
const MONITOR_PARAMS_BY_MODEL: Record<number, MonitorParams> = {
  0x10: AXE3_MONITOR_PARAMS,
  0x11: FM3_MONITOR_PARAMS,
  0x12: FM9_MONITOR_PARAMS,
};

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
  /** Foot Controller address model. FM3 supports live state read; FM9/III expose the address model only. */
  fcModel?: FcModel;
  /** Modifier address model. Field map (bind) confirmed on FM3/FM9/III; source enum FM3-only for now. */
  modModel?: ModModel;
  /** Per-block monitor (meter) param table (paramName → {pid, role, dB range}); undefined if none. */
  monitorParams?: MonitorParams;
}

// Every gen-3 device now ships its enum vocabulary FAMILY-shaped in forgefx-midi
// (family → paramId → labels[], mined complete from each editor's own
// effectDefinitions cache) — FM9/III are uniform with FM3. Shared helpers:
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
/** The family's user-facing model selector: `<FAM>_MODEL` where it exists
 *  (DELAY — `DELAY_TYPE` is the 8-value MONO/STEREO routing enum, the real
 *  model list lives on `DELAY_MODEL`; cache-confirmed FM3/FM9/III), else the
 *  `<FAM>_TYPE` param. */
const modelSelectorPid = (params: ParamsByFamily, fam: string): number | undefined => {
  const defs = params[fam] ?? [];
  return (defs.find((p) => p.name === `${fam}_MODEL`) ?? defs.find((p) => p.name === `${fam}_TYPE`))?.paramId;
};
/** FM3-style roster/labels over a family-shaped enum-override table. */
const familyShapedRosterFor = (params: ParamsByFamily, enums: Record<string, Record<string, string[]>>) =>
  (slug: string): TypeModel[] => {
    const fam = SLUG_FAMILY[slug.toLowerCase()];
    if (!fam) return [];
    const pid = modelSelectorPid(params, fam);
    const labels = pid != null ? enums[fam]?.[String(pid)] : undefined;
    return labels ? labels.map((name, value) => ({ value, name, manufacturer: null, basedOn: null })) : [];
  };
const familyShapedEnumLabels = (enums: Record<string, Record<string, string[]>>) =>
  (family: string, paramId: number): string[] | undefined => enums[family]?.[String(paramId)];

const fm9Params = FM9_PARAMS_BY_FAMILY as unknown as ParamsByFamily;
const fm9Enums = FM9_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const fm9RosterFor = familyShapedRosterFor(fm9Params, fm9Enums);
const fm9EnumLabels = familyShapedEnumLabels(fm9Enums);

// FM3 ships its device-true data IN fractal-midi (uniform with FM9/III): FM3_ROSTERS = slug → model
// list (already the {value,name,manufacturer,basedOn} shape, so no synthesis), FM3_ENUM_OVERRIDES =
// family → paramId → labels[], FM3_CAB_IRS = bank → IR names. ForgeFX is now a thin consumer.
const fm3Rosters = FM3_ROSTERS as unknown as Record<string, Fm3TypeModel[]>;
const fm3Enums = FM3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const fm3CabIrs = FM3_CAB_IRS as unknown as Record<string, string[]>;
const fm3Params = FM3_PARAMS_BY_FAMILY as unknown as ParamsByFamily;
const fm3EnumRosterFor = familyShapedRosterFor(fm3Params, fm3Enums);
function fm3RosterFor(slug: string): TypeModel[] {
  const explicit = fm3Rosters[slug.toLowerCase()] as TypeModel[] | undefined;
  if (explicit?.length) return explicit;
  // Fallback (mirrors fm9RosterFor/axe3RosterFor): families without a pre-baked roster still ship their
  // sub-model list as the enum-override on the model-selector param (<FAM>_MODEL where it exists, else
  // <FAM>_TYPE) — chorus/phaser/tremolo/filter/flanger…
  return fm3EnumRosterFor(slug);
}
function fm3EnumLabels(family: string, paramId: number): string[] | undefined {
  return fm3Enums[family]?.[String(paramId)];
}

// Axe-Fx III ranges: device-true AXE3_RANGES (mined from the III editor cache, fw 32.6 era) merged
// over the param table's inline displayMin/Max. Cache placeholder rows (all-zero float rows kept 1:1
// for wire-stride math) carry no display info — inline bounds win there; informative cache rows win
// everywhere else (they're the newer authority).
const CONT_UNITS = new Set(['numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees']);
const axe3Params = AXE3_PARAMS as unknown as Record<string, (ParamDef & { displayMin?: number; displayMax?: number })[]>;
const axe3DeviceRanges = AXE3_DEVICE_RANGES as unknown as Ranges;
const AXE3_RANGES: Ranges = (() => {
  const out: Ranges = {};
  for (const [fam, list] of Object.entries(axe3Params)) {
    out[fam] = {};
    for (const p of list) {
      if (p.displayMin == null || p.displayMax == null) continue;
      out[fam][p.paramId] = { kind: CONT_UNITS.has(p.unit ?? '') ? 'float' : 'enum', displayMin: p.displayMin, displayMax: p.displayMax, typecode: 0 };
    }
  }
  for (const [fam, rows] of Object.entries(axe3DeviceRanges)) {
    out[fam] ??= {};
    for (const [pid, r] of Object.entries(rows)) {
      if (r.kind === 'float' && r.displayMin === r.displayMax) continue; // placeholder row
      out[fam][Number(pid)] = r;
    }
  }
  return out;
})();
// III type ROSTERS + enum labels. Device-true AXE3_ENUM_OVERRIDES first (complete, fw-current, incl.
// the 10 families GEN3_READ_ROSTERS never had and the DELAY_MODEL list); then the legacy read rosters
// (`Record<number,string>`, normalize via recToRoster — never `.map`); then the effect-type overlay.
// Some (e.g. CABINET) have none anywhere — those degrade to [] (III IR/cab names are read live).
const axe3Enums = AXE3_ENUM_OVERRIDES as unknown as Record<string, Record<string, string[]>>;
const axe3ReadRosters = GEN3_READ_ROSTERS as unknown as Record<string, Record<number, string>>;
const axe3DeviceRosterFor = familyShapedRosterFor(axe3Params as unknown as ParamsByFamily, axe3Enums);
const axe3DeviceEnumLabels = familyShapedEnumLabels(axe3Enums);
function axe3RosterFor(slug: string): TypeModel[] {
  const device = axe3DeviceRosterFor(slug);
  if (device.length) return device;
  const fam = SLUG_FAMILY[slug.toLowerCase()];
  if (!fam) return [];
  const read = axe3ReadRosters[`${fam}_TYPE`];
  if (read) return recToRoster(read);
  const ov = axe3Enum(`${fam}_TYPE`)?.values as Record<number, string> | undefined;
  return ov ? recToRoster(ov) : [];
}
function axe3EnumLabels(family: string, paramId: number): string[] | undefined {
  const device = axe3DeviceEnumLabels(family, paramId);
  if (device) return device;
  const p = axe3Params[family]?.find((x) => x.paramId === paramId);
  const ov = p ? (axe3Enum(p.name)?.values as Record<number, string> | undefined) : undefined;
  if (!ov) return undefined;
  const labels = recToLabels(ov);
  return labels.length ? labels : undefined;
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
    cabIrs: () => AXE3_CAB_IRS as unknown as Record<string, string[]>, // factory banks bundled (III editor cache, fw 32.6 era); USER banks read live
    familyForEffectId: eidFamily(), // III ships no effectId table → shared gen-3 virtual eids only
    layoutFor: layoutOf(AXE3_LAYOUTS as unknown as LayoutMap),
    fcModel: AXE3_FC_MODEL,
    modModel: AXE3_MOD_MODEL,
    monitorParams: AXE3_MONITOR_PARAMS
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
    layoutFor: layoutOf(FM3_LAYOUTS as unknown as LayoutMap),
    fcModel: FM3_FC_MODEL,
    modModel: FM3_MOD_MODEL,
    monitorParams: FM3_MONITOR_PARAMS
  },
  0x12: {
    model: 0x12, key: 'fm9', name: 'FM9', rows: 6, cols: 14,
    defaultInstances: 1,
    instanceLimits: { amp: 2, cab: 2, drive: 3, comp: 2, multicomp: 2, geq: 4, peq: 4, filter: 4, volume: 4, gate: 4, mixer: 4, multiplexer: 2, input: 4, output: 3, chorus: 2, flanger: 2, phaser: 2, rotary: 2, tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, reverb: 2, delay: 2, multitap: 2, megatap: 2, tentap: 2, send: 2, return: 2 },
    params: fm9Params,
    ranges: FM9_RANGES as unknown as Ranges,
    rosterFor: fm9RosterFor,
    enumLabelsFor: fm9EnumLabels,
    cabIrs: () => FM9_CAB_IRS as unknown as Record<string, string[]>, // factory banks bundled (FM9-Edit cache 76p0); USER banks read live
    familyForEffectId: eidFamily(FM9_FAMILY_BY_EFFECT_ID as Record<number, string>),
    layoutFor: layoutOf(FM9_LAYOUTS as unknown as LayoutMap),
    fcModel: FM9_FC_MODEL,
    modModel: FM9_MOD_MODEL,
    monitorParams: FM9_MONITOR_PARAMS
  }
};

export const DEFAULT_PROFILE: DeviceProfile = PROFILES[0x11]!;
export const profileForModel = (model: number): DeviceProfile => PROFILES[model] ?? DEFAULT_PROFILE;
export const profileForKey = (key: string): DeviceProfile | undefined => Object.values(PROFILES).find((p) => p.key === key);
