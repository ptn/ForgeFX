// Test-support seams for the device registry. Kept OUT of the production module (registry.ts) and out
// of the package entry points, so the mocked suites can build isolated registries / inject fake drivers
// without those backdoors appearing in the server's public surface.
import { createNodeRegistry } from './registry.js';
import type { DeviceRegistry, RegistryDeps } from './registryCore.js';
import type { DeviceDriver } from './types.js';

export type { DeviceRegistry, RegistryDeps } from './registryCore.js';

/** Build an isolated DeviceRegistry over mocked connection resolution/opening (any dep not given keeps
 *  its real Node implementation). Never call this on the production `registry` singleton. */
export function __createRegistryForTest(deps: Partial<RegistryDeps>): DeviceRegistry {
  return createNodeRegistry(deps);
}

/** Pre-seed the driver instance for a model byte, so the API suites can inject a hand-built fake driver
 *  (detect() then activates it via the normal handshake path). */
export function __setDriverForTest(reg: DeviceRegistry, modelId: number, d: DeviceDriver): void {
  reg.__seedDriver(modelId, d);
}

/** Force the running-firmware snapshot (the fn 0x08 query is not scripted by the mock transport, so the
 *  save route's firmware stamp would otherwise be null). */
export function __setFirmwareForTest(reg: DeviceRegistry, fw: { major: number; minor: number; version: string; build: string }): void {
  reg.__setFirmwareForTest(fw);
}
