// Phase-6 alias parity — every deprecated /am4/* alias and its unified twin must produce a
// deep-equal {status, body} AND make the identical driver call(s) (proving the param/body shims:
// pidLow→addr, pidHigh→paramId, norm→{value,continuous:true}, value→{value,continuous:false},
// location→number). Runs the real buildApp over an isolated registry with a HAND-BUILT fake AM4
// driver activated via a mocked fn 0x00 handshake (0x15) — driving the real AM4 reader protocol
// through MockTransport would mean scripting its whole wire dialogue, so the fake stubs at the
// driver seam instead (see __setDriverForTest).
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

// a minimal AM4 .syx head — decodeH sniffs frame[4] (0x15) and dispatches to the AM4 offline decoder
const AM4_SYX = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x77, 0x00, 0x01, 0xf7];

const AM4_CAPS: DriverCapabilities = {
  slotModel: 'linear',
  slotCount: 4,
  gridEdit: false,
  scenes: 4,
  channels: false,
  presetDump: false,
  blockParamDecode: false,
  telemetry: { tuner: false, outputMeters: false, cpu: false },
  fcModel: false,
  fcLiveRead: false,
  modBind: false,
  cabIrs: false,
  supportsSave: true
};

type FakeAm4 = DeviceDriver & {
  calls: unknown[][];
  decodeSyx(bytes: number[]): { count: number; presets: { index: number; location: number | null; code: string | null; name: string }[] };
};

/** Deterministic fake AM4 driver: every method records its call and returns a fixed DTO. */
function makeFakeAm4(): FakeAm4 {
  const calls: unknown[][] = [];
  const rec = (name: string, ...args: unknown[]) => calls.push([name, ...args]);
  return {
    calls,
    modelId: 0x15,
    key: 'am4',
    name: 'AM4',
    capabilities: AM4_CAPS,
    grid: async () => {
      rec('grid');
      return {
        model: 'am4', name: 'PARITY', crcValid: true, rows: 1, cols: 4, scenes: [],
        cells: [
          { row: 0, col: 0, effectId: 0x3a, name: 'amp', isShunt: false, routeFlag: 0, fromRows: [], slug: 'amp' },
          { row: 0, col: 1, effectId: 0, name: '', isShunt: true, routeFlag: 0, fromRows: [0] },
          { row: 0, col: 2, effectId: 0x46, name: 'delay', isShunt: false, routeFlag: 0, fromRows: [0], slug: 'delay' },
          { row: 0, col: 3, effectId: 0, name: '', isShunt: true, routeFlag: 0, fromRows: [0] }
        ],
        source: 'dump' as const
      };
    },
    placedBlocks: async () => {
      rec('placedBlocks');
      return [
        { slug: 'amp', name: 'amp', effectId: 0x3a, row: 1, col: 1, fromRows: [], bypassed: false, channel: null },
        { slug: 'delay', name: 'delay', effectId: 0x46, row: 1, col: 3, fromRows: [], bypassed: true, channel: null }
      ];
    },
    blockParams: async (addr: number) => {
      rec('blockParams', addr);
      return {
        block: 'amp', slug: 'amp', page: -1,
        named: [{ id: 1, name: 'Gain', value: 5, norm: 0.5, min: 0, max: 10 }],
        enums: [{ id: 3, name: 'Bypass', value: 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] }],
        type: { value: 2, name: 'USA Lead' }
      };
    },
    setParam: async (addr: number, pid: number, value: number, continuous: boolean) => {
      rec('setParam', addr, pid, value, continuous);
      return { ok: true };
    },
    setBypass: async (addr: number, bypassed: boolean) => {
      rec('setBypass', addr, bypassed);
      return { ok: true };
    },
    getScene: async () => ({ index: 1 }),
    setScene: async (index: number) => {
      rec('setScene', index);
      return { ok: true, scene: index } as { ok: boolean };
    },
    selectPreset: async (n: number) => {
      rec('selectPreset', n);
      return { ok: true, code: 'C02' };
    },
    store: async (n: number) => {
      rec('store', n);
      return { ok: true, location: n, code: 'B02' };
    },
    storedPresetName: async (n: number) => {
      rec('storedPresetName', n);
      return { number: n, name: 'Stored Name', code: 'C02' };
    },
    scanPresets: async () => {
      rec('scanPresets');
      return {
        count: 2,
        presets: [
          { location: 0, code: 'A01', name: 'One', isEmpty: false },
          { location: 1, code: 'A02', name: '', isEmpty: true }
        ]
      };
    },
    backupPreset: async (location?: number) => {
      rec('backupPreset', location ?? null);
      return { location: location ?? null, code: location != null ? 'A02' : null, name: 'Backed Up', bytes: [0xf0, 0x15, 0xf7] };
    },
    restorePreset: async (bytes: number[]) => {
      rec('restorePreset', bytes.length);
      return { ok: true, location: 3, code: 'A04' };
    },
    validateFirmware: (bytes: number[]) => {
      rec('validateFirmware', bytes.length);
      return { valid: true, messages: 6, blocks: 4, headerTag: [1, 2], finalizeTag: [3, 4] };
    },
    setParamByKey: async (key: string, value: number) => {
      rec('setParamByKey', key, value);
      return { ok: true };
    },
    modifierModel: () => {
      rec('modifierModel');
      return { bindingSupported: false, effectOrdinal: 2, slotCount: 16, fields: {}, sources: [], operations: [], channels: [] };
    },
    decodeSyx: (bytes: number[]) => {
      rec('decodeSyx', bytes.length);
      return { count: 1, presets: [{ index: 0, location: 2, code: 'A03', name: 'Decoded' }] };
    }
  };
}

interface Req { method: 'GET' | 'PUT' | 'POST'; url: string; body?: unknown; }
interface Row { name: string; alias: Req; unified: Req; }

const ROWS: Row[] = [
  { name: 'grid', alias: { method: 'GET', url: '/am4/grid' }, unified: { method: 'GET', url: '/preset/grid' } },
  { name: 'slots→blocks', alias: { method: 'GET', url: '/am4/slots' }, unified: { method: 'GET', url: '/preset/blocks' } },
  { name: 'block params', alias: { method: 'GET', url: '/am4/blocks/58/params' }, unified: { method: 'GET', url: '/preset/blocks/58/params' } },
  {
    name: 'param write (norm)',
    alias: { method: 'PUT', url: '/am4/blocks/58/params/7', body: { norm: 0.55 } },
    unified: { method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 0.55, continuous: true } }
  },
  {
    name: 'param write (discrete)',
    alias: { method: 'PUT', url: '/am4/blocks/58/params/7', body: { value: 3 } },
    unified: { method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 3, continuous: false } }
  },
  {
    name: 'bypass',
    alias: { method: 'POST', url: '/am4/bypass', body: { pidLow: 58, bypassed: true } },
    unified: { method: 'POST', url: '/preset/blocks/58/bypass', body: { bypassed: true } }
  },
  { name: 'scene', alias: { method: 'POST', url: '/am4/scene', body: { index: 2 } }, unified: { method: 'POST', url: '/scene', body: { index: 2 } } },
  {
    name: 'preset select',
    alias: { method: 'POST', url: '/am4/preset', body: { location: 33 } },
    unified: { method: 'POST', url: '/preset/select', body: { number: 33 } }
  },
  {
    name: 'preset store',
    alias: { method: 'POST', url: '/am4/preset/store', body: { location: 5 } },
    unified: { method: 'POST', url: '/preset/store', body: { number: 5 } }
  },
  { name: 'stored name', alias: { method: 'GET', url: '/am4/presets/9/name' }, unified: { method: 'GET', url: '/presets/9' } },
  { name: 'locations scan', alias: { method: 'GET', url: '/am4/presets' }, unified: { method: 'GET', url: '/preset/locations' } },
  {
    name: 'backup',
    alias: { method: 'POST', url: '/am4/preset/backup', body: { location: 1 } },
    unified: { method: 'POST', url: '/preset/backup', body: { location: 1 } }
  },
  {
    name: 'restore',
    alias: { method: 'POST', url: '/am4/preset/restore', body: { bytes: AM4_SYX } },
    unified: { method: 'POST', url: '/preset/restore', body: { bytes: AM4_SYX } }
  },
  {
    name: 'decode',
    alias: { method: 'POST', url: '/am4/preset/decode', body: { bytes: AM4_SYX } },
    unified: { method: 'POST', url: '/preset/decode', body: { bytes: AM4_SYX } }
  },
  { name: 'mod model', alias: { method: 'GET', url: '/am4/mod/model' }, unified: { method: 'GET', url: '/mod/model' } },
  {
    name: 'firmware validate',
    alias: { method: 'POST', url: '/am4/firmware/validate', body: { bytes: [1, 2, 3] } },
    unified: { method: 'POST', url: '/firmware/validate', body: { bytes: [1, 2, 3] } }
  },
  {
    name: 'device param',
    alias: { method: 'PUT', url: '/am4/param', body: { key: 'amp.gain', value: 7.5 } },
    unified: { method: 'PUT', url: '/device/param', body: { key: 'amp.gain', value: 7.5 } }
  }
];

export const ALIAS_PARITY_CASE_COUNT = ROWS.length;

export async function runAliasParityTests(): Promise<void> {
  const fake = makeFakeAm4();
  const { app } = await buildTestApp(0x15, fake);
  try {
    for (const row of ROWS) {
      const inject = (r: Req) =>
        app.inject({ method: r.method, url: r.url, ...(r.body !== undefined ? { payload: r.body as Record<string, unknown> } : {}) });

      const before = fake.calls.length;
      const a = await inject(row.alias);
      const aliasCalls = fake.calls.slice(before);
      const mid = fake.calls.length;
      const u = await inject(row.unified);
      const unifiedCalls = fake.calls.slice(mid);

      // 1. deep-equal {status, body}
      assertEqual(a.statusCode, u.statusCode, `${row.name}: status parity`);
      assertEqual(a.payload, u.payload, `${row.name}: body parity`);
      assert(a.statusCode < 400, `${row.name}: alias must succeed (got ${a.statusCode} ${a.payload})`);
      // 2. the shim produced the IDENTICAL driver call(s)
      assertEqual(JSON.stringify(aliasCalls), JSON.stringify(unifiedCalls), `${row.name}: driver-call parity`);
      // 3. deprecation headers on the alias only
      assertEqual(a.headers['deprecation'], 'true', `${row.name}: alias Deprecation header`);
      assert(typeof a.headers['sunset'] === 'string' && a.headers['sunset'].length > 0, `${row.name}: alias Sunset header`);
      assertEqual(u.headers['deprecation'], undefined, `${row.name}: unified must NOT be deprecated`);
    }

    // decode row really decoded through the AM4 offline path (model-byte sniff → {model:'am4', …})
    const dec = await app.inject({ method: 'POST', url: '/preset/decode', payload: { bytes: AM4_SYX } });
    const decBody = dec.json() as { model?: string; count?: number };
    assertEqual(decBody.model, 'am4', 'decode dispatches on the sniffed 0x15 model byte');
    assertEqual(decBody.count, 1, 'decode count');

    // per-path alias hit counters surface in /diag
    const diag = await app.inject({ method: 'GET', url: '/diag' });
    const hits = (diag.json() as { deprecatedAliasHits?: Record<string, number> }).deprecatedAliasHits ?? {};
    for (const row of ROWS) {
      const path = row.alias.url.replace(/\/58\//, '/:pidLow/').replace(/\/7$/, '/:pidHigh').replace('/am4/presets/9/name', '/am4/presets/:n/name');
      assert((hits[path] ?? 0) >= 1, `diag counts alias hits for ${path} (have: ${Object.keys(hits).join(', ')})`);
    }
  } finally {
    await app.close();
  }
}
