// Unified route handlers — the NON-TRIVIAL handler bodies shared verbatim by the Fastify app
// (app.ts, including its deprecated /am4/* aliases) and the browser-facing runtime router
// (runtime/router.ts). Each handler resolves the ACTIVE per-device driver from the registry and
// capability-gates optional driver methods: a device that can't do something answers
// `501 {error:'unsupported', capability}` instead of firing another model's frames at it. Handlers
// signal the HTTP status through the minimal StatusSink seam (FastifyReply satisfies it structurally;
// the router uses a tiny status recorder), so the exact same code produces the exact same
// status+body on both surfaces. NO node:/fastify imports — this module must load in a browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';

/** The one reply capability the shared handlers need: set the response status. FastifyReply's
 *  `code()` matches; the runtime router records the status into its RouterResponse. */
export interface StatusSink { code(statusCode: number): unknown }

/** The subset of `/fm3edit/blocks/decode` that is needed to apply a saved block. Axis passes the
 * decoder result through unchanged; raw values keep the device's original precision. */
interface SavedBlock {
  device: string;
  slug: string;
  activeChannel: number;
  channels: { channel: number; params: { paramId: number; kind: string; raw: number }[] }[];
}

function savedBlock(value: unknown): SavedBlock | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Partial<SavedBlock>;
  if (typeof b.device !== 'string' || typeof b.slug !== 'string' || !Number.isInteger(b.activeChannel) || !Array.isArray(b.channels) || !b.channels.length) return null;
  const activeChannel = b.activeChannel as number;
  const channels = b.channels as SavedBlock['channels'];
  const seenChannels = new Set<number>();
  for (const channel of channels) {
    if (!channel || !Number.isInteger(channel.channel) || channel.channel < 0 || channel.channel > 3 || seenChannels.has(channel.channel) || !Array.isArray(channel.params)) return null;
    seenChannels.add(channel.channel);
    const seenParams = new Set<number>();
    for (const param of channel.params) {
      if (!param || !Number.isInteger(param.paramId) || param.paramId < 0 || seenParams.has(param.paramId) || (param.kind !== 'enum' && param.kind !== 'float') || !Number.isFinite(param.raw) || param.raw < 0 || param.raw > 65534) return null;
      seenParams.add(param.paramId);
    }
    // The decoder always puts the family type selector at parameter zero. It must be applied
    // before the remaining values because a model can change the available parameter layout.
    if (!channel.params.some((param) => param.paramId === 0 && param.kind === 'enum')) return null;
  }
  return seenChannels.has(activeChannel) ? b as SavedBlock : null;
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
  // Lightweight per-block bypass+channel (no preset dump) — the UI applies this to its cached grid on a
  // scene change instead of re-dumping. 501 on drivers without it → the client falls back to a full load.
  const sceneStateH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.sceneState) return unsupported(reply, 'sceneState');
      return await d.sceneState();
    } catch (e) { return decodeFail(reply, 'scene-state', e); }
  };
  const blockParamsH = async (reply: StatusSink, addr: number) => {
    try {
      const d = await driver();
      if (!d.blockParams) return unsupported(reply, 'blockParams');
      return await d.blockParams(addr);
    } catch (e) { reply.code(404); return { error: (e as Error).message }; }
  };
  // Unified param write: {value, continuous}. continuous:true → the driver's normalized write
  // (gen-3 continuous SET; AM4 SET_NORM with value as 0..1), continuous:false → discrete ordinal.
  const setParamH = async (reply: StatusSink, addr: number, paramId: number, value: number, continuous: boolean) => {
    const d = await driver();
    if (!d.setParam) return unsupported(reply, 'setParam');
    return d.setParam(addr, paramId, value, continuous);
  };
  /** Apply every channel in a decoded FM3-Edit `.blk` save to a compatible placed block. The device
   * has no transactional block write, so writes stay ordered and a rejection reports its exact point. */
  const applySavedBlockH = async (reply: StatusSink, addr: number, body: unknown) => {
    const saved = savedBlock(body);
    if (!saved) { reply.code(400); return { error: 'invalid-saved-block' }; }
    const d = await driver();
    if (d.name !== saved.device) { reply.code(422); return { error: 'saved-block-device-mismatch', expected: d.name, received: saved.device }; }
    if (!d.placedBlocks) return unsupported(reply, 'placedBlocks');
    if (!d.setParam) return unsupported(reply, 'setParam');
    if (!d.setType) return unsupported(reply, 'setType');
    if (!d.setChannel) return unsupported(reply, 'channels');
    const target = (await d.placedBlocks()).find((block) => block.effectId === addr);
    if (!target) { reply.code(404); return { error: 'block-not-found', effectId: addr }; }
    if (target.slug.toLowerCase() !== saved.slug.toLowerCase()) {
      reply.code(422);
      return { error: 'saved-block-family-mismatch', target: target.slug, saved: saved.slug };
    }

    let applied = 0;
    let channel = -1;
    let paramId: number | null = null;
    try {
      for (const source of [...saved.channels].sort((a, b) => a.channel - b.channel)) {
        channel = source.channel;
        const channelResult = await d.setChannel(addr, String.fromCharCode(65 + channel));
        if (!channelResult.ok) throw new Error('channel write rejected');
        const type = source.params.find((param) => param.paramId === 0)!;
        paramId = type.paramId;
        const typeResult = await d.setType(addr, type.raw);
        if (!typeResult.ok) throw new Error('type write rejected');
        applied++;
        for (const param of source.params) {
          if (param.paramId === 0) continue;
          paramId = param.paramId;
          const result = await d.setParam(addr, param.paramId, param.kind === 'float' ? param.raw / 65534 : param.raw, param.kind === 'float');
          if (!result.ok) throw new Error('parameter write rejected');
          applied++;
        }
      }
      // Restore the library block's selected channel after applying all its channel slices.
      channel = saved.activeChannel;
      const activeResult = await d.setChannel(addr, String.fromCharCode(65 + channel));
      if (!activeResult.ok) throw new Error('active channel write rejected');
      return { ok: true, channels: saved.channels.length, params: applied, activeChannel: saved.activeChannel };
    } catch (e) {
      reply.code(409);
      return { error: 'saved-block-apply-failed', message: (e as Error).message, applied, channel, paramId };
    }
  };
  const bypassH = async (reply: StatusSink, addr: number, bypassed: boolean) => {
    const d = await driver();
    if (!d.setBypass) return unsupported(reply, 'setBypass');
    return d.setBypass(addr, bypassed);
  };
  const sceneSetH = async (reply: StatusSink, index: number) => {
    const d = await driver();
    if (!d.setScene) return unsupported(reply, 'scenes');
    return d.setScene(index);
  };
  const presetSelectH = async (reply: StatusSink, number: number) => {
    const d = await driver();
    if (!d.selectPreset) return unsupported(reply, 'selectPreset');
    const r = await d.selectPreset(number);
    // `code` is ADDITIVE: the AM4 reports its bank-letter location code (e.g. "C02"); gen-3 doesn't.
    return { ok: r.ok, number, ...(r.code != null ? { code: r.code } : {}) };
  };
  const presetStoreH = async (reply: StatusSink, number?: number) => {
    const d = await driver();
    if (!d.store) return unsupported(reply, 'supportsSave');
    // number omitted → store to the CURRENT slot (needs a live preset-number query).
    const n = number ?? (d.presetRef ? (await d.presetRef()).number : undefined);
    if (n == null || !Number.isFinite(n) || n < 0) { reply.code(400); return { error: 'number required' }; }
    return d.store(n); // gen-3: {ok}; AM4 additionally carries {location, code}
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
    return d.validateFirmware(bytes);
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
      try { return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) }; }
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
    if (model === 0x15) return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) } as Record<string, unknown>;
    const d = await driver();
    if (!d.decodePresetBytes) throw new Error('unsupported: presetDump');
    return d.decodePresetBytes(bytes) as Record<string, unknown>;
  };

  return {
    driver, unsupported, decodeFail,
    gridH, blocksH, sceneStateH, blockParamsH, setParamH, applySavedBlockH, bypassH, sceneSetH,
    presetSelectH, presetStoreH, presetNameH, locationsH,
    backupH, restoreH, fwValidateH, deviceParamH, modModelH,
    telemetryConfigH, telemetrySetH,
    decodeH, decodeBytes
  };
}
