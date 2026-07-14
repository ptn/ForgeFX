// Cross-device preset converter service (POST /preset/convert). Turns a preset — either an uploaded
// .syx dump or the CONNECTED device's current preset — into a target-device preset, best-effort,
// with a per-decision event log the UI renders. ALL codec calls live here; the route in app.ts is a
// thin validation + error-mapping shim.
//
// SERVER-ONLY: this pulls the codec's `forgefx-midi/convert` engine + the gen-3/AM4 dump decoders,
// which are Node-safe but heavy. Keep it under services/ (never in runtime/*, which is browser-shared
// and probed by check-browser-safe.ts).
import { decodeGen3PresetDump } from 'forgefx-midi/devices/gen3';
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
