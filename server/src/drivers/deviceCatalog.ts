// Single source of truth for per-model metadata: the package descriptor, the driver factory, the
// gen-3 profile (where one exists), and the Axis profile-override keys that force the model. The
// registry consumes this for its descriptor/capabilities lookup, its per-model driver cache, and
// forced-key resolution, so adding or retiring a device is one table row.
//
// Browser-safe: descriptors + driver factories only (no node:/transport imports), matching the rest
// of the driver layer.
import { FM3_DESCRIPTOR, FM9_DESCRIPTOR, AXEFX3_DESCRIPTOR, VP4_DESCRIPTOR } from 'forgefx-midi/devices/gen3';
import { AM4_DESCRIPTOR } from 'forgefx-midi/devices/am4';
import { AXEFX2_DESCRIPTOR } from 'forgefx-midi/devices/gen2';
import { AXEFXGEN1_DESCRIPTOR } from 'forgefx-midi/devices/gen1';
import { PROFILES, type DeviceProfile } from '../devices.js';
import { createGen3Driver } from './gen3.js';
import { createAm4Driver } from './am4.js';
import { createGen2Driver } from './gen2.js';
import { createGen1Driver } from './gen1.js';
import { createVp4Driver } from './vp4.js';
import type { DeviceDriver, DriverCtx } from './types.js';

export interface DeviceCatalogEntry {
  /** SysEx model byte. */
  modelId: number;
  /** Package descriptor whose curated `capabilities` feed the /device DTO. */
  descriptor: { capabilities: Record<string, unknown> };
  /** Profile-override keys (Axis "Connection & Device") that force this model. */
  forcedKeys: readonly string[];
  /** The gen-3 DeviceProfile when the model uses the shared grid codec. */
  profile?: DeviceProfile;
  /** Build the driver over the shared transport. */
  create(ctx: DriverCtx): DeviceDriver;
}

export const DEVICE_CATALOG: ReadonlyMap<number, DeviceCatalogEntry> = new Map<number, DeviceCatalogEntry>([
  [0x01, { modelId: 0x01, descriptor: AXEFXGEN1_DESCRIPTOR as never, forcedKeys: ['gen1'], create: (ctx) => createGen1Driver(ctx) }],
  [0x07, { modelId: 0x07, descriptor: AXEFX2_DESCRIPTOR as never, forcedKeys: ['axe2'], create: (ctx) => createGen2Driver(ctx) }],
  [0x10, { modelId: 0x10, descriptor: AXEFX3_DESCRIPTOR as never, forcedKeys: ['axe3'], profile: PROFILES[0x10]!, create: (ctx) => createGen3Driver(PROFILES[0x10]!, ctx) }],
  [0x11, { modelId: 0x11, descriptor: FM3_DESCRIPTOR as never, forcedKeys: ['fm3'], profile: PROFILES[0x11]!, create: (ctx) => createGen3Driver(PROFILES[0x11]!, ctx) }],
  [0x12, { modelId: 0x12, descriptor: FM9_DESCRIPTOR as never, forcedKeys: ['fm9'], profile: PROFILES[0x12]!, create: (ctx) => createGen3Driver(PROFILES[0x12]!, ctx) }],
  [0x14, { modelId: 0x14, descriptor: VP4_DESCRIPTOR as never, forcedKeys: ['vp4'], create: (ctx) => createVp4Driver(ctx) }],
  [0x15, { modelId: 0x15, descriptor: AM4_DESCRIPTOR as never, forcedKeys: ['am4'], create: (ctx) => createAm4Driver(ctx) }],
]);

/** Curated descriptor per model byte (the /device capabilities source). */
export const DESCRIPTOR_BY_MODEL: Record<number, { capabilities: Record<string, unknown> }> =
  Object.fromEntries([...DEVICE_CATALOG].map(([mid, e]) => [mid, e.descriptor]));

/** Model byte for a manual profile-override key, or -1 when unknown. Gen-3 keys match the entry's
 *  profile key; descriptor-only devices list their own alias. */
export function modelIdForForcedKey(key: string): number {
  for (const e of DEVICE_CATALOG.values()) if (e.profile?.key === key || e.forcedKeys.includes(key)) return e.modelId;
  return -1;
}
