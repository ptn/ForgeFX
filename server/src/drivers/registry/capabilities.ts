// Registry capability DTO builders: the extended (Phase-6) capability matrix and the merged
// descriptor + extended object served by /device and /device/detect. Split out of registryCore.ts
// (C3) — pure given the resolved driver; no registry/transport state.
import { profileForModel } from '../../devices.js';
import { DESCRIPTOR_BY_MODEL } from '../deviceCatalog.js';
import { GEN3_SHUNT_ID_BASE } from '../gen3/support.js';
import type { DeviceDriver } from '../types.js';

// Gen-3 virtual effects Axis exposes as rail screens (ToolRail's VIRTUAL map + the Modifier flyout's
// effectId 3) — surfaced in the capabilities DTO so the client stops hardcoding them per model.
const GEN3_VIRTUAL_EFFECTS: readonly { eid: number; slug: string; name: string }[] = [
  { eid: 1, slug: 'global', name: 'Setup' },
  { eid: 2, slug: 'controllers', name: 'Controllers' },
  { eid: 3, slug: 'modifier', name: 'Modifier' },
  { eid: 199, slug: 'fc', name: 'Footswitches' }
];

/** The Phase-6 extended capability matrix for a model, derived from its driver's DriverCapabilities
 *  + which optional methods it implements (capability-, never model-gated), so the DTO can't drift
 *  from what the routes answer. Null when no driver exists for the model (e.g. VP4). */
export function extendedCaps(d: DeviceDriver | null, mid: number): Record<string, unknown> | null {
  if (!d) return null;
  const c = d.capabilities;
  const grid = c.slotModel === 'grid';
  const prof = grid ? profileForModel(mid) : null;
  return {
    presets: {
      count: grid ? 512 : 104, // 512 slots on every gen-3 unit; 104 (A01..Z04) on the AM4
      addressing: grid ? 'numeric' : 'bankLetter',
      canRename: !!d.setPresetName,
      canScanNames: !!d.scanPresets,
      canDeepScan: c.presetDump,
      liveQuery: !!d.presetRef
    },
    // Routing = rewiring the signal path with CABLES, which is a real driver method (d.cable) — NOT the
    // same as being able to place/clear blocks. The AM4 edits its chain (d.placeCell) but has a fixed
    // linear route with no cables, so gridRouting is false there while block placement still works.
    gridRouting: !!d.cable,
    gridCursorSelect: !!d.selectCell,
    shuntBase: grid ? GEN3_SHUNT_ID_BASE : null,
    // both codecs serve full param catalogs server-side (gen-3 tables + AM4 KNOWN_PARAMS) — Axis
    // can drop its client-side `!c.pack` gates on either device.
    paramsWithoutPack: true,
    tempo: !!d.getTempo,
    tuner: c.telemetry.tuner,
    meters: {
      blockMeters: !!d.meters,
      liveMonitors: !!d.liveMonitors && !!prof?.monitorParams,
      outputLevels: c.telemetry.outputMeters,
      cpu: c.telemetry.cpu
    },
    sceneNamesWritable: !!d.setSceneName,
    fc: { model: c.fcModel, liveState: c.fcLiveRead },
    modifiers: { model: (d.modifierModel?.() ?? null) != null, bind: c.modBind },
    cabIrs: c.cabIrs,
    // On-connect device-cache self-describe build (POST /device/cache/build). Gen-3 grid units only.
    selfDescribe: c.selfDescribe,
    // Official-editor .cache import (POST /device/cache/import). Tracks selfDescribe (gen-3 grid units).
    cacheImport: c.cacheImport,
    // FULL-mode self-describe write-sweep (POST /device/cache/build with mode:'full'). True only for the
    // CaptureRig-proven gen-3 trio (III/FM3/FM9); false on VP4/AM4/gen-1/gen-2. Inserted after
    // cacheImport (additive-only ordering — see capabilitiesDto).
    fullCapture: c.fullCapture,
    editorLayouts: c.editorLayouts,
    firmwareValidate: !!d.validateFirmware,
    // Cross-device preset conversion (POST /preset/convert with no source): the current preset can be
    // dumped + lifted into the converter IR. Derived from DriverCapabilities so the DTO can't drift.
    presetConvert: c.presetConvert,
    backupDump: !!d.backupPreset,
    restoreDump: !!d.restorePreset,
    versionStore: !!d.dumpRaw && !!d.loadPresetBytes,
    deviceParams: !!d.setParamByKey,
    virtualEffects: grid ? GEN3_VIRTUAL_EFFECTS : []
  };
}

/** The capabilities object /device and /device/detect serve: the curated descriptor subset
 *  (unchanged keys, byte-compatible) with the extended matrix merged in BEFORE `supportsSave`, so a
 *  pretty-printed JSON diff against the pre-Phase-6 sweep stays additive-only (appending after the
 *  last key would rewrite its comma line). */
export function capabilitiesDto(d: DeviceDriver | null, mid: number): Record<string, unknown> | null {
  const c = DESCRIPTOR_BY_MODEL[mid]?.capabilities as Record<string, unknown> | undefined;
  if (!c) return null;
  // curated subset (drop the RegExp preset_location_format — not JSON-clean, not needed by the UI)
  return {
    slotModel: c.slot_model, slotCount: c.slot_count, grid: c.grid,
    hasScenes: !!c.has_scenes, sceneCount: c.scene_count ?? 0,
    hasChannels: !!c.has_channels, channelNames: c.channel_names ?? [], channelBlocks: c.channel_blocks ?? [],
    ...(extendedCaps(d, mid) ?? {}),
    // Registry-level cadence-mode control (GET/PUT /telemetry/config) — advertised on every device so
    // Axis can surface the control unconditionally. Placed before supportsSave so the pretty-printed
    // caps diff stays additive-only (see the ordering contract).
    telemetryControl: true,
    supportsSave: !!c.supports_save
  };
}
