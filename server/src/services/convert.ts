// Cross-device preset converter service (POST /preset/convert). Turns a preset — either an uploaded
// .syx dump or the CONNECTED device's current preset — into a target-device preset, best-effort,
// with a per-decision event log the UI renders. ALL codec calls live here; the route in app.ts is a
// thin validation + error-mapping shim.
//
// SERVER-ONLY: this pulls the codec's `forgefx-midi/convert` engine + the gen-3/AM4 dump decoders,
// which are Node-safe but heavy. Keep it under services/ (never in runtime/*, which is browser-shared
// and probed by check-browser-safe.ts).
import {
  decodeGen3PresetDump,
  authorGen3PresetFromIR,
  MODEL_FM3,
  type IrAuthorPreset,
  type AuthoredBlockRecord,
  type AuthoredSkip,
} from 'forgefx-midi/devices/gen3';
import { decodeAm4PresetDumpBytes } from 'forgefx-midi/devices/am4';
import {
  liftGen3Preset,
  liftAm4Preset,
  liftVp4Preset,
  convertPreset,
  severityOf,
  CONVERTER_DEVICE_IDS,
  type ConverterDeviceId,
  type Gen3DeviceId,
  type ConverterPreset,
  type ConversionEvent,
} from 'forgefx-midi/convert';
import type { DeviceDriver } from '../drivers/types.js';

/** The response DTO both the offline (`convertFromSyx`) and connected (`convertFromDriver`) paths
 *  return — exactly the wire contract POST /preset/convert serves on 200. */
export interface ConvertResponse {
  source: { device: string; name: string; decodeDepth: string };
  /** The fully-decoded SOURCE preset IR (blocks + routing.gridCells for grid-shaped sources). Lets the
   *  UI render the source device grid alongside the converted target — Axis has no protocol decoder, so
   *  the decoded source must ride along (the engine already decoded it as `ir`; it is not re-decoded). */
  sourcePreset: ConverterPreset;
  target: ConverterPreset;
  events: ConversionEvent[];
  summary: { total: number; info: number; warn: number; loss: number };
}

/** A service error carrying the HTTP status the route should map it to (400 undecodable/bad target,
 *  501 no source capability, 503 device unreachable). */
export class ConvertError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ConvertError';
    this.statusCode = statusCode;
  }
}

/** Every device the converter can target (for validation + the 400 error payload). */
export const SUPPORTED_TARGETS = CONVERTER_DEVICE_IDS;

/** SysEx envelope model byte → gen-3 device id (Axe-Fx III / FM3 / FM9 share the gen-3 codec). */
const GEN3_DEVICE_BY_MODEL: Readonly<Record<number, Gen3DeviceId>> = {
  0x10: 'axe-fx-iii',
  0x11: 'fm3',
  0x12: 'fm9',
};
const AM4_MODEL_BYTE = 0x15;
const VP4_MODEL_BYTE = 0x14;

/** True when `x` is a converter device id (route validation of `targetDevice`). */
export function isConverterDeviceId(x: unknown): x is ConverterDeviceId {
  return typeof x === 'string' && (CONVERTER_DEVICE_IDS as readonly string[]).includes(x);
}

/** The Fractal envelope model byte from a raw .syx stream (F0 00 01 74 <model> …), or undefined. */
function sniffModelByte(bytes: Uint8Array): number | undefined {
  const f0 = bytes.indexOf(0xf0);
  return f0 >= 0 ? bytes[f0 + 4] : undefined;
}

/**
 * Decode + lift a raw .syx preset dump into the converter IR, dispatched on the envelope model byte.
 * Supports gen-3 preset dumps (Axe-Fx III / FM3 / FM9) and AM4 single-preset frames — the families
 * whose offline decode is validated. Anything else → `ConvertError(400)`.
 */
function liftFromSyx(bytes: Uint8Array): ConverterPreset {
  const model = sniffModelByte(bytes);
  if (model === undefined) throw new ConvertError(400, 'not a SysEx preset dump (no F0 frame found)');
  const gen3 = GEN3_DEVICE_BY_MODEL[model];
  if (gen3) {
    try {
      return liftGen3Preset(decodeGen3PresetDump(bytes, model), gen3);
    } catch (e) {
      throw new ConvertError(400, `could not decode gen-3 preset dump: ${(e as Error).message}`);
    }
  }
  if (model === AM4_MODEL_BYTE) {
    try {
      return liftAm4Preset(decodeAm4PresetDumpBytes(bytes));
    } catch (e) {
      throw new ConvertError(400, `could not decode AM4 preset dump: ${(e as Error).message}`);
    }
  }
  throw new ConvertError(
    400,
    `unsupported source preset family (model byte 0x${model.toString(16)}); offline conversion supports ` +
      'gen-3 (Axe-Fx III / FM3 / FM9) and AM4 preset dumps',
  );
}

/** Run the codec engine + fold the event severities into the summary the UI reads. */
function buildResponse(ir: ConverterPreset, targetDevice: ConverterDeviceId): ConvertResponse {
  const { target, events } = convertPreset(ir, targetDevice);
  const summary = { total: events.length, info: 0, warn: 0, loss: 0 };
  for (const e of events) summary[severityOf(e)] += 1;
  return {
    source: { device: ir.sourceDevice, name: ir.name, decodeDepth: ir.decodeDepth },
    sourcePreset: ir,
    target,
    events,
    summary,
  };
}

/** Convert an uploaded preset .syx to `targetDevice` — offline, touches no device/transport. */
export function convertFromSyx(syx: Uint8Array, targetDevice: ConverterDeviceId): ConvertResponse {
  return buildResponse(liftFromSyx(syx), targetDevice);
}

/**
 * Convert the CONNECTED device's current preset to `targetDevice`. Reads the current preset through
 * the driver — VP4 via its structure blob (its only decode surface), every other liftable family via
 * its verbatim dump (`backupPreset`) fed back through the same model-byte dispatch — then converts.
 * Callers MUST gate on `driver.capabilities.presetConvert` first (the route answers 501 otherwise).
 */
export async function convertFromDriver(
  driver: DeviceDriver,
  targetDevice: ConverterDeviceId,
): Promise<ConvertResponse> {
  return buildResponse(await liftCurrentPreset(driver), targetDevice);
}

async function liftCurrentPreset(driver: DeviceDriver): Promise<ConverterPreset> {
  // VP4: the whole-preset structure blob is the only decode surface — no verbatim .syx dump path.
  if (driver.modelId === VP4_MODEL_BYTE) {
    const readStructure = (driver as { readStructure?: () => Promise<unknown> }).readStructure;
    if (typeof readStructure !== 'function') {
      throw new ConvertError(501, 'the VP4 driver cannot read the current preset structure');
    }
    const blob = await readStructure.call(driver);
    if (!blob) throw new ConvertError(503, 'no VP4 structure blob returned (device not responding)');
    return liftVp4Preset(blob as Parameters<typeof liftVp4Preset>[0]);
  }
  // Everything else liftable: dump the current preset verbatim, then decode + lift by model byte.
  if (!driver.backupPreset) {
    throw new ConvertError(501, 'the connected device cannot dump its current preset');
  }
  const dump = await driver.backupPreset();
  return liftFromSyx(Uint8Array.from(dump.bytes));
}

// ── offline .syx EXPORT (author a target preset from a converted IR) ───────────────────────────────

/** The response DTO POST /preset/convert/export serves on 200. `syx` is a FILE-level-valid FM3 preset
 *  dump (valid CRC, decodes back to the written values) — this is NOT a proof of DEVICE acceptance; a
 *  hardware load test on a real FM3 is still required before trusting an authored preset. */
export interface ExportConvertedSyxResult {
  /** The authored FM3 preset `.syx` bytes (a plain number[] so it serializes cleanly over JSON). */
  syx: number[];
  /** Blocks (and their params/type) that landed in the output. */
  written: AuthoredBlockRecord[];
  /** IR blocks/params that had no base match and were skipped (never synthesized). */
  skipped: AuthoredSkip[];
  /** The preset name written into the header. */
  name: string;
}

/** The FM3 SysEx model byte — the ONLY target authoring supports today. */
const FM3_MODEL_BYTE = 0x11;

/**
 * Map a (converted) `ConverterPreset` onto the codec's permissive `IrAuthorPreset` shape.
 *
 * Fidelity: the converted target IR's `paramId` is now ALWAYS the TARGET (FM3) device's address — the
 * conversion engine re-resolves each param's id to the target device via its concept key (gen-3 paramIds
 * are device-specific, so the same param name maps to a different id on FM3 vs FM9 vs III). That makes the
 * carried `paramId` a valid FM3 address for EVERY source, not just FM3-originated presets, so we forward it
 * for all sources and the FM3 author writes the param VALUE directly by id — the high-fidelity path. A param
 * the engine could not map to an FM3 concept carries NO id (its concept has no FM3 equivalent); we still pass
 * its `nativeName` as a last resort, but the concept-registry stripped form does not resolve in the author's
 * catalog lookup, so those params are reported skipped — never guessed onto a wrong address. Value source
 * priority in the author is `normalized` → range-inverted `value` → raw `value`, so both are carried;
 * `normalized = raw/65534` reproduces the exact stored raw.
 */
function converterToAuthorIr(preset: ConverterPreset, name?: string): IrAuthorPreset {
  return {
    name: name ?? preset.name,
    blocks: preset.blocks.map((b) => ({
      family: b.family,
      typeValue: b.typeValue,
      // Amp per-channel target: the converted block's scene-0 active channel, when the source exposed one.
      channel: b.channels?.perScene?.[0],
      params: b.params.map((p) => ({
        ...(Number.isInteger(p.paramId) ? { paramId: p.paramId } : {}),
        nativeName: p.nativeName,
        normalized: p.normalized,
        value: p.value,
        min: p.min,
        max: p.max,
        log: p.log,
      })),
    })),
  };
}

/**
 * Author a target-device `.syx` from a converted preset, by EDIT-IN-PLACE on a caller-supplied BASE dump.
 * Lifts the source (offline `sourceSyx` OR the connected `driver`'s current preset) → converts to
 * `targetDevice` → maps the converted `ConverterPreset` to the codec's `IrAuthorPreset` → authors onto the
 * base dump via the FM3-calibrated `authorGen3PresetFromIR`.
 *
 * SCOPE: FM3 (model 0x11) targets ONLY — every other target throws `ConvertError(501)`. The base template
 * MUST itself be an FM3 preset dump (else `ConvertError(400)`). See `authorGen3PresetFromIR`'s header for
 * the full safety model: file-level validity does NOT prove device acceptance (hardware load test still
 * required). `slot` is accepted for forward-compatibility but not yet applied — the authored dump keeps the
 * base template's preset location.
 */
export async function exportConvertedSyx(opts: {
  targetDevice: string;
  /** OFFLINE source: a raw uploaded preset `.syx` (gen-3 / AM4). Omit to use the connected device. */
  sourceSyx?: Uint8Array;
  /** CONNECTED source: the active driver whose current preset is dumped + lifted (used when no `sourceSyx`). */
  driver?: DeviceDriver;
  /** The FM3 base template `.syx` the converted preset is authored ONTO (edit-in-place). Required. */
  baseSyx: Uint8Array;
  name?: string;
  slot?: number;
}): Promise<ExportConvertedSyxResult> {
  const { targetDevice, sourceSyx, driver, baseSyx, name } = opts;

  // Target guard — FM3 only for now (FM9 / III / AM4 / VP4 authoring is uncalibrated; refused upstream).
  if (targetDevice !== 'fm3') {
    throw new ConvertError(501, 'offline .syx export is only available for FM3 targets right now');
  }
  // Base guard — the template must be an FM3 preset dump (model byte 0x11), or the FM3-calibrated write
  // model would land plausible-but-wrong bytes on a foreign body.
  if (sniffModelByte(baseSyx) !== FM3_MODEL_BYTE) {
    throw new ConvertError(400, 'the base template must be an FM3 preset');
  }

  // Resolve + lift the SOURCE (any liftable family): offline upload or the connected device's preset.
  let source: ConverterPreset;
  if (sourceSyx && sourceSyx.length > 0) {
    source = liftFromSyx(sourceSyx);
  } else {
    if (!driver) throw new ConvertError(400, 'no source: supply source.syx or connect a device');
    source = await liftCurrentPreset(driver);
  }

  // Convert into the FM3 target IR, then author onto the base dump.
  const { target } = convertPreset(source, 'fm3');
  const ir = converterToAuthorIr(target, name);
  const result = authorGen3PresetFromIR(baseSyx, ir, MODEL_FM3);

  return {
    syx: Array.from(result.syx),
    written: result.written,
    skipped: result.skipped,
    name: result.nameWritten ?? ir.name ?? '',
  };
}
