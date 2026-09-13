// Device registry — Node wiring over the transport-agnostic core (registryCore.ts). The class and
// all cross-device behavior live in the core; THIS module is the only place the real Node transports
// (serial/MIDI enumeration, connection open, the persisted overrides file) meet it, and it owns the
// process-wide singleton every route resolves through. Production code must only ever use the
// `registry` singleton below — never construct a DeviceRegistry itself.
import { autoDetectPath } from '../transport/serial.js';
import { listConnections, resolveConn, openConn, getConnOverride, setConnOverride, getProfileOverride, setProfileOverride } from '../transport/connection.js';
import { midiAvailable } from '../transport/midi.js';
import * as store from '../store.js';
import { createRegistry, type DeviceRegistry, type RegistryDeps } from './registryCore.js';
import type { BuiltCache } from 'forgefx-midi/cache';
import { CACHE_SCHEMA } from 'forgefx-midi/cache';

export type { DeviceRegistry, RegistryDeps, ConnInfo } from './registryCore.js';

/** The real Node deps: transport/connection.ts resolution + overrides, serial autodetect, MIDI probe. */
const nodeDeps: RegistryDeps = {
  resolveConn,
  openConn,
  listConnections,
  getConnOverride,
  setConnOverride,
  getProfileOverride,
  setProfileOverride,
  autoDetectPath,
  midiAvailable,
  // On-connect device-cache lookup: the registry swaps in the device-true runtime profile when a
  // build exists for the attached model+firmware. Reads the same fs store the /device/cache routes write.
  loadDeviceCache: (key) => { const d = store.getDoc('deviceCaches', key); return d && !d.deleted && (d.data as BuiltCache)?.meta?.schema === CACHE_SCHEMA ? (d.data as BuiltCache) : null; }
};

export const registry = createRegistry(nodeDeps);

/** Build an ISOLATED DeviceRegistry over the real Node deps, with any dep overridden — used by the
 *  mocked suites (which pass fake connection resolution/openers). The server always uses the `registry`
 *  singleton above; never construct a DeviceRegistry for production. */
export function createNodeRegistry(deps: Partial<RegistryDeps> = {}): DeviceRegistry {
  return createRegistry({ ...nodeDeps, ...deps });
}
