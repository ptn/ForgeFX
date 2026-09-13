// Shared deterministic FM3 fake for the API suites — a rich (but not full) optional-method surface
// so route-level behavior can be exercised without hardware or scripting the gen-3 wire protocol.
// `selfDescribe`/`cacheImport` are false so the device-cache routes stay on the 501-gated path.
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';

// deterministic gen-3-style .syx: frame[4] = 0x11 (FM3) → decode dispatches to the driver's decoder
export const presetSyx = (tag: number) => Uint8Array.from([0xf0, 0x00, 0x01, 0x74, 0x11, 0x77, tag, 0x01, 0xf7]);

const FAKE_FM3_CAPS: DriverCapabilities = {
  slotModel: 'grid',
  grid: { rows: 4, cols: 12 },
  gridEdit: true,
  scenes: 8,
  channels: true,
  presetDump: true,
  presetConvert: false,
  telemetry: { tuner: false, outputMeters: false, cpu: false }, // no polls in tests
  fcModel: true,
  fcLiveRead: false,
  modBind: true,
  cabIrs: true,
  editorLayouts: false,
  supportsSave: true,
  selfDescribe: false, // fake driver: keeps POST /device/cache/build on the 501 gated path
  cacheImport: false,
  fullCapture: false // no self-describe → no full-mode write-sweep
};

/** Deterministic fake FM3 driver — a rich (but not full) optional-method surface so the matrix hits
 *  both implemented routes AND the capability-gated 501 path (no scanPresets / validateFirmware). */
export function makeFakeFm3(): DeviceDriver {
  const summary = (n: number) =>
    ({ number: n, name: `P${n}`, model: 'FM3', crcValid: true, crc: 0x1234 + n, scenes: [], blocks: [], models: {}, amps: [] }) as never;
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: FAKE_FM3_CAPS,
    grid: async () => ({
      model: 'fm3', name: 'PARITY', crcValid: true, rows: 4, cols: 12, scenes: ['S1'],
      cells: [{ row: 0, col: 0, effectId: 58, name: 'Amp 1', isShunt: false, routeFlag: 0, fromRows: [] }],
      source: 'dump' as const
    }),
    placedBlocks: async () => [
      { slug: 'amp', name: 'Amp 1', effectId: 58, row: 1, col: 1, fromRows: [], bypassed: false, channel: 'A' }
    ],
    presetRef: async () => ({ number: 3, name: 'Current' }),
    blocksCatalog: () => [{ slug: 'amp', family: 'AMP', instance: 1, name: 'Amp 1', page: 0, paramCount: 2, typeCount: 1 }],
    blockTypes: () => [{ value: 1, name: 'USA Lead', manufacturer: null, basedOn: null }],
    blockParams: async () => ({
      block: 'Amp 1', slug: 'amp', page: 0,
      named: [{ id: 1, name: 'Gain', value: 5, norm: 0.5, min: 0, max: 10 }],
      enums: [], type: { value: 1, name: 'USA Lead' }
    }),
    setParam: async () => ({ ok: true }),
    setBypass: async () => ({ ok: true }),
    setChannel: async () => ({ ok: true }),
    setType: async () => ({ ok: true }),
    selectCell: async () => ({ ok: true }),
    getScene: async () => ({ index: 1 }),
    setScene: async () => ({ ok: true }),
    getTempo: async () => ({ bpm: 120 }),
    setTempo: async () => ({ ok: true }),
    tapTempo: async () => ({ ok: true }),
    selectPreset: async () => ({ ok: true }),
    store: async () => ({ ok: true }),
    setPresetName: async () => ({ ok: true }),
    modifierModel: () => ({ bindingSupported: true, slotCount: 16 }),
    resolveModifierSlot: async (targetEffectId: number, targetParam: number) =>
      targetEffectId === 99 && targetParam === 99
        ? { ok: false, error: 'no_free_slot', slotCount: 16 }
        : { ok: true, matched: targetEffectId === 58 && targetParam === 4, slot: 2, slotCount: 16 },
    dumpRaw: async (n: number) => ({ bytes: presetSyx(n), summary: summary(n) }),
    loadPresetBytes: async () => ({ ok: true }),
    decodePresetBytes: (bytes: Uint8Array) => {
      if (bytes[0] !== 0xf0 || bytes.length < 8) throw new Error('not a preset');
      return summary(bytes[6]!);
    }
  } as DeviceDriver;
}
