// Unified route handlers — the NON-TRIVIAL handler bodies shared verbatim by the Fastify app
// (app.ts, including its deprecated /am4/* aliases) and the browser-facing runtime router
// (runtime/router.ts). Each handler resolves the ACTIVE per-device driver from the registry and
// capability-gates optional driver methods: a device that can't do something answers
// `501 {error:'unsupported', capability}` instead of firing another model's frames at it. Handlers
// signal the HTTP status through the minimal StatusSink seam (FastifyReply satisfies it structurally;
// the router uses a tiny status recorder), so the exact same code produces the exact same
// status+body on both surfaces. NO node:/fastify imports — this module must load in a browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import { authorGen3PresetFromIRFull, defaultScaffoldSyx } from 'forgefx-midi/devices/gen3';

/** A genuinely BLANK gen-3 preset: the bundled scaffold is the synthesis TEMPLATE (a real factory
 *  preset), so it must be run through the synth pipeline with an empty IR — which empties the grid,
 *  the scene names and the block chain and writes the literal `<EMPTY>` name the official editor's
 *  "Clear Preset" uses. Returns the re-framed, CRC-valid `.syx` for the client's load path. */
function blankPresetSyx(modelId: number): Uint8Array {
  return authorGen3PresetFromIRFull(
    defaultScaffoldSyx(modelId),
    { name: '<EMPTY>', sceneNames: [], blocks: [], routing: { gridCells: [] } },
    modelId
  ).syx;
}

/** The one reply capability the shared handlers need: set the response status. FastifyReply's
 *  `code()` matches; the runtime router records the status into its RouterResponse. */
export interface StatusSink { code(statusCode: number): unknown }

/** The subset of `/fm3edit/blocks/decode` that is needed to apply a saved block. Axis passes the
 * decoder result through unchanged; `values` keep the device's original precision, channel-blocked
 * (`index = channel × stride + paramId`). */
interface SavedBlock {
  slug: string;
  activeChannel: number;
  itemCount: number;
  values: number[];
}

function savedBlock(value: unknown): SavedBlock | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Partial<SavedBlock>;
  if (typeof b.slug !== 'string') return null;
  if (!Number.isInteger(b.activeChannel) || (b.activeChannel as number) < 0 || (b.activeChannel as number) > 3) return null;
  if (!Number.isInteger(b.itemCount) || (b.itemCount as number) < 0) return null;
  if (!Array.isArray(b.values)) return null;
  if (b.values.length !== b.itemCount) return null;
  for (const v of b.values) {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 65534) return null;
  }
  return b as SavedBlock;
}

export function createUnifiedHandlers(registry: DeviceRegistry) {
  const driver = () => registry.driver();

  /** Capability-gate reply: the active driver doesn't implement this optional method. */
  const unsupported = (reply: StatusSink, capability: string) => {
    reply.code(501);
    return { error: 'unsupported', capability };
  };

  // Decode-path errors are surfaced to the client AND logged (console.error → the desktop debug log),
  // so a failing grid/blocks decode (e.g. on Axe-Fx III presets) shows WHY in the user's log, not just 503.
  const decodeFail = (reply: StatusSink, where: string, e: unknown) => {
    const err = e as Error;
    console.error(`[forgefx] ${where} failed: ${err?.message ?? e}${err?.stack ? `\n${err.stack}` : ''}`);
    reply.code(503);
    return { error: err?.message ?? String(e) };
  };

  // Device-operation failure: log, then map to the driver's own HTTP status when it set one (a client
  // error like placeCell's out-of-range instance is a 400) and 503 otherwise (link/timeout/decode).
  // Keeps writes consistent across the Fastify and runtime-router surfaces (previously they escaped to
  // Fastify's 500 / the router's 500 envelope, which mislabels a device outage as a server bug).
  const fail = (reply: StatusSink, where: string, e: unknown) => {
    const err = e as Error & { statusCode?: number };
    console.error(`[forgefx] ${where} failed: ${err?.message ?? e}${err?.stack ? `\n${err.stack}` : ''}`);
    const code = err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 503;
    reply.code(code);
    return { error: err?.message ?? String(e) };
  };

  const gridH = async (reply: StatusSink) => {
    try { return await (await driver()).grid(); } catch (e) { return decodeFail(reply, 'grid decode', e); }
  };
  const blocksH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.placedBlocks) return unsupported(reply, 'placedBlocks');
      return await d.placedBlocks();
    } catch (e) { return decodeFail(reply, 'blocks decode', e); }
  };
  const sceneNamesH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.sceneNames) return unsupported(reply, 'sceneNames');
      return { names: await d.sceneNames() };
    } catch (e) {
      return decodeFail(reply, 'scene names', e);
    }
  };
  // Lightweight per-block bypass+channel (no preset dump) — the UI applies this to its cached grid on a
  // scene change instead of re-dumping. 501 on drivers without it → the client falls back to a full load.
  const sceneStateH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.sceneState) return unsupported(reply, 'sceneState');
      return await d.sceneState();
    } catch (e) { return decodeFail(reply, 'scene-state', e); }
  };
  const blockParamsH = async (reply: StatusSink, addr: number, observe = true) => {
    try {
      const d = await driver();
      if (!d.blockParams) return unsupported(reply, 'blockParams');
      return await d.blockParams(addr, { observe });
    } catch (e) { return fail(reply, 'block params', e); }
  };
  // Unified param write: {value, continuous}. continuous:true → the driver's normalized write
  // (gen-3 continuous SET; AM4 SET_NORM with value as 0..1), continuous:false → discrete ordinal.
  const setParamH = async (reply: StatusSink, addr: number, paramId: number, value: number, continuous: boolean) => {
    const d = await driver();
    if (!d.setParam) return unsupported(reply, 'setParam');
    try { return await d.setParam(addr, paramId, value, continuous); }
    catch (e) { return fail(reply, 'set param', e); }
  };
  /** Apply a decoded FM3-Edit `.blk` save to a compatible placed block in ONE bulk burst. The device
   * has no transactional block write, so rejection is best-effort (the burst is fire-and-forget). */
  const applySavedBlockH = async (reply: StatusSink, addr: number, body: unknown) => {
    const saved = savedBlock(body);
    if (!saved) { reply.code(400); return { error: 'invalid-saved-block' }; }
    const d = await driver();
    if (!d.placedBlocks) return unsupported(reply, 'placedBlocks');
    const target = (await d.placedBlocks()).find((block) => block.effectId === addr);
    if (!target) { reply.code(404); return { error: 'block-not-found', effectId: addr }; }
    if (target.slug.toLowerCase() !== saved.slug.toLowerCase()) {
      reply.code(422);
      return { error: 'saved-block-family-mismatch', target: target.slug, saved: saved.slug };
    }
    if (!d.applyBlock) return unsupported(reply, 'applyBlock');

    try {
      await d.applyBlock(addr, { itemCount: saved.itemCount, values: saved.values }, saved.activeChannel);
      return { ok: true, params: saved.itemCount, activeChannel: saved.activeChannel };
    } catch (e) {
      reply.code(409);
      return { error: 'saved-block-apply-failed', message: (e as Error).message };
    }
  };
  const bypassH = async (reply: StatusSink, addr: number, bypassed: boolean) => {
    const d = await driver();
    if (!d.setBypass) return unsupported(reply, 'setBypass');
    try { return await d.setBypass(addr, bypassed); } catch (e) { return fail(reply, 'set bypass', e); }
  };
  const sceneSetH = async (reply: StatusSink, index: number) => {
    const d = await driver();
    if (!d.setScene) return unsupported(reply, 'scenes');
    try { return await d.setScene(index); } catch (e) { return fail(reply, 'set scene', e); }
  };
  const presetSelectH = async (reply: StatusSink, number: number) => {
    const d = await driver();
    if (!d.selectPreset) return unsupported(reply, 'selectPreset');
    try {
      const r = await d.selectPreset(number);
      // `code` is ADDITIVE: the AM4 reports its bank-letter location code (e.g. "C02"); gen-3 doesn't.
      return { ok: r.ok, number, ...(r.code != null ? { code: r.code } : {}) };
    } catch (e) { return fail(reply, 'select preset', e); }
  };
  const presetStoreH = async (reply: StatusSink, number?: number) => {
    const d = await driver();
    if (!d.store) return unsupported(reply, 'supportsSave');
    // number omitted → store to the CURRENT slot (needs a live preset-number query).
    const n = number ?? (d.presetRef ? (await d.presetRef()).number : undefined);
    if (n == null || !Number.isFinite(n) || n < 0) { reply.code(400); return { error: 'number required' }; }
    try { return await d.store(n); } // gen-3: {ok}; AM4 additionally carries {location, code}
    catch (e) { return fail(reply, 'store preset', e); }
  };
  // Stored preset name: driver-backed where supported (AM4 → {number, name, code}); the gen-3
  // drivers don't implement it, so they keep the pre-Phase-6 {number, name:''} stub byte-identically.
  const presetNameH = async (n: number) => {
    const d = await driver();
    if (d.storedPresetName) {
      try { return await d.storedPresetName(n); } catch { /* device unreachable → stub below */ }
    }
    return { number: n, name: '' };
  };
  const locationsH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.scanPresets) return unsupported(reply, 'presets.canScanNames');
    try {
      const r = await d.scanPresets();
      return { count: r.count, locations: r.presets };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const backupH = async (reply: StatusSink, location?: number) => {
    const d = await driver();
    if (!d.backupPreset) return unsupported(reply, 'backupDump');
    try { return await d.backupPreset(location); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const restoreH = async (reply: StatusSink, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of one preset dump required' }; }
    const d = await driver();
    if (!d.restorePreset) return unsupported(reply, 'restoreDump');
    try { return await d.restorePreset(bytes); } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  };
  const fwValidateH = async (reply: StatusSink, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of a firmware .syx required' }; }
    const d = await driver();
    if (!d.validateFirmware) return unsupported(reply, 'firmwareValidate');
    try { return d.validateFirmware(bytes); } catch (e) { return fail(reply, 'firmware validate', e); }
  };
  const deviceParamH = async (reply: StatusSink, key?: string, value?: number) => {
    if (!key || value == null) { reply.code(400); return { error: 'key + value required' }; }
    const d = await driver();
    if (!d.setParamByKey) return unsupported(reply, 'deviceParams');
    try { return await d.setParamByKey(key, value); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const modModelH = async () => {
    const d = await driver();
    return d.modifierModel ? d.modifierModel() : null;
  };
  // Telemetry cadence-mode control (registry-level, no driver needed). GET serves the current mode +
  // its resolved cadence + the mode list; PUT switches the mode (400 on an unknown value) and the
  // setter emits a `telemetryConfig` event so every live UI reflects it.
  const telemetryConfigH = () => registry.getTelemetryConfig();
  const telemetrySetH = (reply: StatusSink, mode?: string) => {
    if (mode == null || !registry.telemetryModes().includes(mode as never)) {
      reply.code(400);
      return { error: 'unknown mode', modes: registry.telemetryModes() };
    }
    return registry.setTelemetryMode(mode);
  };
  // Offline preset decode with model-byte dispatch: sniff frame[4] of the first F0 frame. 0x15 →
  // the AM4 offline decoder (works whatever unit is attached — decode touches no transport);
  // anything else → the active driver's gen-3 decode, byte-identical to the pre-Phase-6 behavior.
  const decodeH = async (reply: StatusSink, bytes: Uint8Array) => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) {
      const d = registry.driverForModel(0x15);
      if (!d?.decodePresetBank) return unsupported(reply, 'presetDump');
      try { return { model: 'am4', ...d.decodePresetBank([...bytes]) }; }
      catch (e) { reply.code(400); return { error: (e as Error).message }; }
    }
    const d = await driver();
    if (!d.decodePresetBytes) return unsupported(reply, 'presetDump');
    try { return d.decodePresetBytes(bytes); } catch (e) { reply.code(422); return { error: (e as Error).message }; }
  };
  // Same model-byte dispatch as decodeH, but THROWING instead of reply-coding — for callers that
  // decode many files in one request (the local Presets/ scan) and must not touch the route reply.
  const decodeBytes = async (bytes: Uint8Array): Promise<Record<string, unknown>> => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) {
      const d = registry.driverForModel(0x15);
      if (!d?.decodePresetBank) throw new Error('unsupported: presetDump');
      return { model: 'am4', ...d.decodePresetBank([...bytes]) } as Record<string, unknown>;
    }
    const d = await driver();
    if (!d.decodePresetBytes) throw new Error('unsupported: presetDump');
    return d.decodePresetBytes(bytes) as Record<string, unknown>;
  };

  // ─────────────────────────── shared request-shape glue ───────────────────────────
  // The handlers below were lifted verbatim out of app.ts + runtime/router.ts (C1): the two surfaces
  // had byte-identical bodies that differed ONLY in how they read params/query/body. They take plain
  // scalars here, so both surfaces keep just their thin extraction shim.

  // ── preset reads ──
  const presetH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.presetRef) return unsupported(reply, 'presetRef');
    return d.presetRef();
  };
  const presetSummaryH = async (reply: StatusSink, n: number, full: boolean) => {
    try {
      const d = await driver();
      if (!d.presetSummary) return unsupported(reply, 'presetDump');
      return await d.presetSummary(n, full);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const presetParamsH = async (reply: StatusSink, n: number) => {
    try {
      const d = await driver();
      if (!d.presetParams) return unsupported(reply, 'presetDump');
      return { blocks: await d.presetParams(n) };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const presetBodyH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.presetBodyHex) return unsupported(reply, 'presetDump');
      return await d.presetBodyHex();
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  /** Load raw .syx bytes into the edit buffer (empty/absent bytes → 400). */
  const presetLoadH = async (reply: StatusSink, bytes: Uint8Array | null) => {
    if (!bytes || !bytes.length) { reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(reply, 'loadPresetBytes');
      return await d.loadPresetBytes(bytes);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  /** The model's BLANK preset — the client's "start from zero" / "Clear preset" reset. Empty grid,
   *  empty scenes, `<EMPTY>` name; the client loads it through the normal /preset/load path so the
   *  edit-buffer replacement stays one code path. 501 on a model with no scaffold (AM4/VP4/gen-1/2). */
  const presetBlankH = async (reply: StatusSink): Promise<Uint8Array | Record<string, unknown>> => {
    try {
      const d = await driver();
      return blankPresetSyx(d.modelId);
    } catch (e) {
      reply.code(501);
      return { error: 'unsupported', capability: 'blankPreset', message: (e as Error).message };
    }
  };
  const setPresetNameH = async (reply: StatusSink, name: string) => {
    const d = await driver();
    if (!d.setPresetName) return unsupported(reply, 'setPresetName');
    return d.setPresetName(name);
  };
  // Cab IR names per bank. FM3 USER is cached from a live read; refresh replaces it.
  const cabIrsH = async (refresh: boolean) => {
    const d = await driver();
    if (d.cabIrs) return d.cabIrs(refresh);
    return registry.profile.cabIrs();
  };

  // ── catalog ──
  const blocksCatalogH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.blocksCatalog) return unsupported(reply, 'blocksCatalog');
    return d.blocksCatalog();
  };
  const blockTypesH = async (reply: StatusSink, slug: string) => {
    const d = await driver();
    if (!d.blockTypes) return unsupported(reply, 'blockTypes');
    return d.blockTypes(slug);
  };

  // ── live block params / edits (driver-gated) ──
  const setChannelH = async (reply: StatusSink, addr: number, channel: string) => {
    const d = await driver();
    if (!d.setChannel) return unsupported(reply, 'channels');
    return d.setChannel(addr, channel);
  };
  const setTypeH = async (reply: StatusSink, addr: number, value: number) => {
    const d = await driver();
    if (!d.setType) return unsupported(reply, 'setType');
    return d.setType(addr, value);
  };
  const rawBlockH = async (reply: StatusSink, addr: number) => {
    try {
      const d = await driver();
      if (!d.rawBlock) return unsupported(reply, 'rawBlock');
      return await d.rawBlock(addr);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const readParamsH = async (reply: StatusSink, addr: number, pids: number[]) => {
    try {
      const d = await driver();
      if (!d.readParams) return unsupported(reply, 'readParams');
      return await d.readParams(addr, pids);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const readRangeH = async (reply: StatusSink, addr: number, pids: number[]) => {
    try {
      const d = await driver();
      if (!d.readRange) return unsupported(reply, 'readRange');
      return await d.readRange(addr, pids);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const cabStateH = async (reply: StatusSink, addr: number) => {
    const d = await driver();
    if (!d.cabState) return unsupported(reply, 'cabState');
    return d.cabState(addr);
  };
  const metersH = async (reply: StatusSink, wants: Record<string, number[]>) => {
    try {
      const d = await driver();
      if (!d.meters) return unsupported(reply, 'meters');
      return await d.meters(wants);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };

  // ── grid editing (1-indexed row/col, matching FM-Edit) ──
  const placeCellH = async (reply: StatusSink, row: number, col: number, blockId: number) => {
    const d = await driver();
    if (!d.placeCell) return unsupported(reply, 'gridEdit');
    return d.placeCell(row, col, blockId);
  };
  const cableH = async (reply: StatusSink, srcRow: number, srcCol: number, destRow: number, connect: boolean) => {
    const d = await driver();
    if (!d.cable) return unsupported(reply, 'gridEdit');
    return d.cable(srcRow, srcCol, destRow, connect);
  };
  const selectCellH = async (reply: StatusSink, row: number, col: number) => {
    const d = await driver();
    if (!d.selectCell) return unsupported(reply, 'gridEdit');
    return d.selectCell(row, col);
  };

  // ── telemetry: tuner · tempo · scene ──
  const setTunerH = (on: boolean) => registry.setTuner(on);
  const getTempoH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.getTempo) return unsupported(reply, 'getTempo');
    return d.getTempo();
  };
  const setTempoH = async (reply: StatusSink, bpm: number) => {
    const d = await driver();
    if (!d.setTempo) return unsupported(reply, 'setTempo');
    return d.setTempo(bpm);
  };
  const tapTempoH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.tapTempo) return unsupported(reply, 'tapTempo');
    return d.tapTempo();
  };
  const getSceneH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.getScene) return unsupported(reply, 'scenes');
    return d.getScene();
  };
  const setSceneNameH = async (reply: StatusSink, index: number, name: string) => {
    const d = await driver();
    if (!d.setSceneName) return unsupported(reply, 'scenes');
    return d.setSceneName(index, name);
  };

  // ── FC / Modifier / monitors / looper ──
  const fcModelH = () => registry.profile.fcModel ?? null;
  const monitorParamsH = () => registry.profile.monitorParams ?? {};
  const liveMonitorsH = async (reply: StatusSink, eid?: number) => {
    try {
      const d = await driver();
      if (!d.liveMonitors) return unsupported(reply, 'liveMonitors');
      return await d.liveMonitors(eid);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const looperH = async (reply: StatusSink, eid: number) => {
    try {
      const d = await driver();
      if (!d.looperTelemetry) return unsupported(reply, 'looperTelemetry');
      if (!Number.isFinite(eid)) { reply.code(400); return { error: 'eid required' }; }
      return await d.looperTelemetry(eid);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const looperControlH = async (reply: StatusSink, eid: number, action: string, on: boolean) => {
    try {
      const d = await driver();
      if (!d.looperControl) return unsupported(reply, 'looperControl');
      if (!Number.isFinite(eid) || !action) { reply.code(400); return { error: 'eid + action required' }; }
      return await d.looperControl(eid, action, on);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const fcStateH = async (reply: StatusSink, layout: number, view: number, sw: number) => {
    try {
      const d = await driver();
      if (!d.fcReadState) return unsupported(reply, 'fcLiveRead');
      return await d.fcReadState(layout, view, sw);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const bindModifierH = async (reply: StatusSink, slot?: number, targetEffectId?: number, targetParam?: number, source?: number) => {
    if (slot == null || targetEffectId == null || targetParam == null || source == null) {
      reply.code(400);
      return { ok: false, error: 'slot, targetEffectId, targetParam, source required' };
    }
    try {
      const d = await driver();
      if (!d.bindModifier) return unsupported(reply, 'modifiers.bind');
      return await d.bindModifier(slot, targetEffectId, targetParam, source);
    } catch (e) { reply.code(503); return { ok: false, error: (e as Error).message }; }
  };
  const resolveModifierSlotH = async (reply: StatusSink, targetEffectId: number, targetParam: number) => {
    if (!Number.isFinite(targetEffectId) || !Number.isFinite(targetParam)) {
      reply.code(400);
      return { error: 'targetEffectId + targetParam required' };
    }
    try {
      const d = await driver();
      if (!d.resolveModifierSlot) return unsupported(reply, 'modifiers.bind');
      const r = await d.resolveModifierSlot(targetEffectId, targetParam);
      if (r.ok === false && r.error === 'no_free_slot') reply.code(409);
      return r;
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };

  // ── system ──
  const healthH = async () => {
    const h = await registry.health();
    return { ok: h.ok, api: { version: 2 }, device: h.device };
  };
  /** Full connection diagnostic. `aliasHits` is the Fastify app's deprecated-alias counters ({} on
   *  the runtime router, which has no aliases). */
  const diagH = async (aliasHits: Record<string, number>) => ({ ...(await registry.diagnostics()), deprecatedAliasHits: { ...aliasHits } });
  const deviceInfoH = () => registry.deviceInfo();
  const connectionsH = () => registry.connections();
  const detectH = () => registry.detect();
  const portsSelectH = (b: { transport?: 'serial' | 'midi'; id?: string | null; inId?: string | null; outId?: string | null; model?: string | null }) => {
    const model = b.model; // undefined = leave the profile override as-is; 'auto'/'' = clear it; else force it
    // MIDI (Axe-Fx III / FM9, or an FM3 via a MIDI→USB adapter): separate input + output endpoints
    if (b?.transport === 'midi' && b.inId && b.outId) return registry.selectConnection({ transport: 'midi', id: b.id || b.inId, inId: b.inId, outId: b.outId }, model);
    if (b?.id) return registry.selectConnection({ transport: b.transport === 'midi' ? 'midi' : 'serial', id: b.id }, model);
    return registry.selectConnection(null, model); // clear the port back to auto (a forced profile can remain via `model`)
  };

  return {
    driver, unsupported,
    gridH, blocksH, sceneNamesH, sceneStateH, blockParamsH, setParamH, applySavedBlockH, bypassH, sceneSetH,
    presetSelectH, presetStoreH, presetNameH, locationsH,
    backupH, restoreH, fwValidateH, deviceParamH, modModelH,
    telemetryConfigH, telemetrySetH,
    decodeH, decodeBytes,
    presetH, presetSummaryH, presetParamsH, presetBodyH, presetLoadH, presetBlankH, setPresetNameH, cabIrsH,
    blocksCatalogH, blockTypesH,
    setChannelH, setTypeH, rawBlockH, readParamsH, readRangeH, cabStateH, metersH,
    placeCellH, cableH, selectCellH,
    setTunerH, getTempoH, setTempoH, tapTempoH, getSceneH, setSceneNameH,
    fcModelH, monitorParamsH, liveMonitorsH, looperH, looperControlH, fcStateH,
    bindModifierH, resolveModifierSlotH,
    healthH, diagH, deviceInfoH, connectionsH, detectH, portsSelectH
  };
}
