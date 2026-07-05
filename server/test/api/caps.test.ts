// Phase-6 capabilities DTO — for mocked FM3 / FM9 / Axe-Fx III / AM4 detections, GET /device must
// serve the expected capability matrix (spot-checks on the load-bearing flags Axis will gate on),
// plus the v2 API handshake on /healthz and /device and the capabilities mirror on /device/detect.
// Uses the REAL drivers (the caps DTO derives from DriverCapabilities + the optional-method surface;
// nothing here touches the transport beyond the mocked handshake).
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const CAPS_CASE_COUNT = 4;

type Caps = {
  slotModel: string;
  presets: { count: number; addressing: string; canRename: boolean; canScanNames: boolean; canDeepScan: boolean; liveQuery: boolean };
  gridRouting: boolean;
  gridCursorSelect: boolean;
  shuntBase: number | null;
  paramsWithoutPack: boolean;
  tempo: boolean;
  tuner: boolean;
  meters: { blockMeters: boolean; liveMonitors: boolean; outputLevels: boolean; cpu: boolean };
  sceneNamesWritable: boolean;
  fc: { model: boolean; liveState: boolean };
  modifiers: { model: boolean; bind: boolean };
  cabIrs: boolean;
  firmwareValidate: boolean;
  backupDump: boolean;
  restoreDump: boolean;
  versionStore: boolean;
  deviceParams: boolean;
  virtualEffects: { eid: number; slug: string; name: string }[];
  supportsSave: boolean;
};

async function fetchCaps(modelId: number): Promise<{ device: Record<string, unknown>; caps: Caps; app: Awaited<ReturnType<typeof buildTestApp>>['app'] }> {
  const { app } = await buildTestApp(modelId);
  const res = await app.inject({ method: 'GET', url: '/device' });
  assertEqual(res.statusCode, 200, `GET /device (0x${modelId.toString(16)})`);
  const device = res.json() as Record<string, unknown>;
  return { device, caps: device.capabilities as Caps, app };
}

function checkGen3Common(caps: Caps, label: string): void {
  assertEqual(caps.presets.count, 512, `${label} presets.count`);
  assertEqual(caps.presets.addressing, 'numeric', `${label} presets.addressing`);
  assertEqual(caps.presets.canRename, true, `${label} presets.canRename`);
  assertEqual(caps.presets.canScanNames, false, `${label} presets.canScanNames (501 for now)`);
  assertEqual(caps.presets.canDeepScan, true, `${label} presets.canDeepScan`);
  assertEqual(caps.presets.liveQuery, true, `${label} presets.liveQuery`);
  assertEqual(caps.gridRouting, true, `${label} gridRouting`);
  assertEqual(caps.gridCursorSelect, true, `${label} gridCursorSelect`);
  assertEqual(caps.shuntBase, 1024, `${label} shuntBase`);
  assertEqual(caps.paramsWithoutPack, true, `${label} paramsWithoutPack`);
  assertEqual(caps.tempo, true, `${label} tempo`);
  assertEqual(caps.tuner, true, `${label} tuner`);
  assertEqual(caps.meters.blockMeters, true, `${label} meters.blockMeters`);
  assertEqual(caps.meters.liveMonitors, true, `${label} meters.liveMonitors`);
  assertEqual(caps.meters.outputLevels, true, `${label} meters.outputLevels`);
  assertEqual(caps.meters.cpu, true, `${label} meters.cpu`);
  assertEqual(caps.sceneNamesWritable, true, `${label} sceneNamesWritable`);
  assertEqual(caps.fc.model, true, `${label} fc.model`);
  assertEqual(caps.modifiers.model, true, `${label} modifiers.model`);
  assertEqual(caps.modifiers.bind, true, `${label} modifiers.bind`);
  assertEqual(caps.firmwareValidate, false, `${label} firmwareValidate`);
  // gen-3 dumps raw .syx by slot (library export-to-disk + audition); restore stays the
  // version-store flow (loadPresetBytes + store), so restoreDump remains false.
  assertEqual(caps.backupDump, true, `${label} backupDump`);
  assertEqual(caps.restoreDump, false, `${label} restoreDump`);
  assertEqual(caps.versionStore, true, `${label} versionStore`);
  assertEqual(caps.deviceParams, false, `${label} deviceParams`);
  assertEqual(caps.virtualEffects.length, 4, `${label} virtualEffects (Setup/Controllers/Modifier/FC)`);
  assertEqual(caps.virtualEffects.map((v) => v.eid).join(','), '1,2,3,199', `${label} virtualEffects eids`);
}

async function fm3(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x11);
  try {
    assertEqual(device.apiVersion, 2, 'FM3 /device apiVersion');
    checkGen3Common(caps, 'FM3');
    assertEqual(caps.fc.liveState, true, 'FM3 fc.liveState (FM3 only)');
    assertEqual(caps.cabIrs, true, 'FM3 cabIrs (bundled IR names)');

    // v2 handshake on /healthz (still ok:true, device:'FM3')
    const hz = await app.inject({ method: 'GET', url: '/healthz' });
    const h = hz.json() as { ok: boolean; api?: { version: number }; device: string };
    assertEqual(h.ok, true, 'healthz ok');
    assertEqual(h.api?.version, 2, 'healthz api.version');
    assertEqual(h.device, 'FM3', 'healthz device');

    // /device/detect mirrors the capabilities object
    const det = await app.inject({ method: 'GET', url: '/device/detect' });
    const d = det.json() as { modelId: number; capabilities?: { fc?: { liveState?: boolean } } };
    assertEqual(d.modelId, 0x11, 'detect modelId');
    assertEqual(d.capabilities?.fc?.liveState, true, 'detect carries capabilities');
  } finally {
    await app.close();
  }
}

async function fm9(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x12);
  try {
    assertEqual(device.apiVersion, 2, 'FM9 /device apiVersion');
    checkGen3Common(caps, 'FM9');
    assertEqual(caps.fc.liveState, false, 'FM9 fc.liveState false (address model only)');
    assertEqual(caps.cabIrs, false, 'FM9 cabIrs (not bundled)');
  } finally {
    await app.close();
  }
}

async function axe3(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x10);
  try {
    assertEqual(device.apiVersion, 2, 'III /device apiVersion');
    checkGen3Common(caps, 'III');
    assertEqual(caps.fc.liveState, false, 'III fc.liveState false');
    assertEqual(caps.cabIrs, false, 'III cabIrs (read live, not bundled)');
  } finally {
    await app.close();
  }
}

async function am4(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x15);
  try {
    assertEqual(device.apiVersion, 2, 'AM4 /device apiVersion');
    assertEqual(device.modelId, 0x15, 'AM4 modelId');
    assertEqual(caps.slotModel, 'linear', 'AM4 slotModel (curated key intact)');
    assertEqual(caps.presets.count, 104, 'AM4 presets.count');
    assertEqual(caps.presets.addressing, 'bankLetter', 'AM4 presets.addressing');
    assertEqual(caps.presets.canRename, true, 'AM4 presets.canRename (buildSetPresetName wired)');
    assertEqual(caps.presets.canScanNames, true, 'AM4 presets.canScanNames');
    assertEqual(caps.presets.canDeepScan, false, 'AM4 presets.canDeepScan');
    // presetRef() decodes the current location from the fn-0x1F structure (int32 @0x00) → the
    // unified GET /preset works on the AM4 and Axis shows the preset in the top bar.
    assertEqual(caps.presets.liveQuery, true, 'AM4 presets.liveQuery');
    assertEqual(caps.gridRouting, false, 'AM4 gridRouting');
    assertEqual(caps.gridCursorSelect, false, 'AM4 gridCursorSelect');
    assertEqual(caps.shuntBase, null, 'AM4 shuntBase');
    assertEqual(caps.paramsWithoutPack, true, 'AM4 paramsWithoutPack (KNOWN_PARAMS is server-side)');
    assertEqual(caps.tempo, false, 'AM4 tempo');
    assertEqual(caps.tuner, false, 'AM4 tuner');
    assertEqual(caps.meters.blockMeters, false, 'AM4 meters.blockMeters');
    assertEqual(caps.meters.liveMonitors, false, 'AM4 meters.liveMonitors');
    assertEqual(caps.meters.outputLevels, false, 'AM4 meters.outputLevels');
    assertEqual(caps.meters.cpu, false, 'AM4 meters.cpu');
    assertEqual(caps.sceneNamesWritable, true, 'AM4 sceneNamesWritable (buildSetSceneName wired)');
    assertEqual(caps.fc.model, false, 'AM4 fc.model');
    assertEqual(caps.fc.liveState, false, 'AM4 fc.liveState');
    assertEqual(caps.modifiers.model, true, 'AM4 modifiers.model (data-only model exists)');
    assertEqual(caps.modifiers.bind, false, 'AM4 modifiers.bind');
    assertEqual(caps.cabIrs, false, 'AM4 cabIrs');
    assertEqual(caps.firmwareValidate, true, 'AM4 firmwareValidate');
    assertEqual(caps.backupDump, true, 'AM4 backupDump');
    assertEqual(caps.restoreDump, true, 'AM4 restoreDump');
    assertEqual(caps.versionStore, false, 'AM4 versionStore');
    assertEqual(caps.deviceParams, true, 'AM4 deviceParams');
    assert(Array.isArray(caps.virtualEffects) && caps.virtualEffects.length === 0, 'AM4 virtualEffects empty');
    assertEqual(caps.supportsSave, true, 'AM4 supportsSave (curated key intact)');
  } finally {
    await app.close();
  }
}

export async function runCapsTests(): Promise<void> {
  await fm3();
  await fm9();
  await axe3();
  await am4();
}
