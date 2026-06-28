// ForgeFX HTTP API — Node backend (fractal-midi codec). Mirrors the REST contract
// Axis consumes; drop-in replacement for the retired C# server.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { device } from './device.js';
import { cabIrBanks } from './defs.js';

const PORT = Number(process.env.PORT ?? 5056);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });

// ── system ──
app.get('/healthz', () => device.health());
app.get('/device', () => device.deviceInfo());

// ── preset ──
app.get('/preset', () => device.presetRef());
app.get<{ Params: { n: string } }>('/presets/:n', (req) => ({ number: Number(req.params.n), name: '' }));
app.get('/preset/grid', async (_req, reply) => {
  try { return await device.grid(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.get<{ Params: { n: string } }>('/presets/:n/grid', async (_req, reply) => {
  try { return await device.grid(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.get('/preset/blocks', async (_req, reply) => {
  try { return await device.placedBlocks(); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
app.post<{ Body: { number: number } }>('/preset/select', async (req) => {
  const r = await device.selectPreset(req.body.number);
  return { ok: r.ok, number: req.body.number };
});
app.post<{ Body: { number?: number } }>('/preset/store', async (req) => {
  const cur = req.body?.number ?? (await device.presetRef()).number;
  return device.store(cur);
});

// ── catalog ──
app.get('/blocks', () => device.blocksCatalog());
app.get<{ Params: { slug: string } }>('/blocks/:slug/types', (req) => device.blockTypes(req.params.slug));

// ── live block params (addressed by the placed block's effect id, so multiple instances work) ──
app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/params', async (req, reply) => {
  try { return await device.blockParams(Number(req.params.eid)); } catch (e) { reply.code(404); return { error: (e as Error).message }; }
});
app.put<{ Params: { eid: string; paramId: string }; Body: { value: number; continuous?: boolean } }>(
  '/preset/blocks/:eid/params/:paramId',
  (req) => device.setParam(Number(req.params.eid), Number(req.params.paramId), req.body.value, req.body.continuous ?? true)
);
app.post<{ Params: { eid: string }; Body: { bypassed: boolean } }>('/preset/blocks/:eid/bypass', (req) =>
  device.setBypass(Number(req.params.eid), req.body.bypassed)
);
app.post<{ Params: { eid: string }; Body: { channel: string } }>('/preset/blocks/:eid/channel', (req) =>
  device.setChannel(Number(req.params.eid), req.body.channel)
);
app.post<{ Params: { eid: string }; Body: { value: number } }>('/preset/blocks/:eid/type', (req) =>
  device.setType(Number(req.params.eid), req.body.value)
);

// ── grid editing (1-indexed row/col, matching FM-Edit) ──
app.put<{ Body: { row: number; col: number; blockId: number } }>('/preset/grid/cell', (req) =>
  device.placeCell(req.body.row, req.body.col, req.body.blockId)
);
app.post<{ Body: { srcRow: number; srcCol: number; destRow: number; connect?: boolean } }>('/preset/grid/cable', (req) =>
  device.cable(req.body.srcRow, req.body.srcCol, req.body.destRow, req.body.connect ?? true)
);
app.post<{ Body: { row: number; col: number } }>('/preset/grid/select', (req) => device.selectCell(req.body.row, req.body.col));

// ── telemetry: tuner · tempo · scene ──
app.post<{ Body: { on: boolean } }>('/tuner', (req) => device.setTuner(!!req.body?.on));
app.get('/tempo', () => device.getTempo());
app.post<{ Body: { bpm: number } }>('/tempo', (req) => device.setTempo(req.body.bpm));
app.post('/tempo/tap', () => device.tapTempo());
app.get('/scene', () => device.getScene());
app.post<{ Body: { index: number } }>('/scene', (req) => device.setScene(req.body.index));

// auto-detect the connected Fractal unit (FM3/FM9/Axe-Fx/…) via the fn 0x00 handshake
app.get('/device/detect', () => device.detect());

// cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — for the cab IR picker
app.get('/cab/irs', () => cabIrBanks());
// current state of a cab block (mode / per-slot bank + IR + dyna type) for the picker
app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/cab', (req) => device.cabState(Number(req.params.eid)));

// per-block meter + swipe-control values for the always-on grid level fill
app.post<{ Body: { wants?: Record<string, number[]> } }>('/preset/meters', async (req, reply) => {
  try { return await device.meters(req.body?.wants ?? {}); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});

// ── live event stream (SSE): tuner / tempo / scene / cpu pushes ──
app.get('/events', (req, reply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  });
  raw.write(': connected\n\n');
  const unsub = device.subscribe((e) => raw.write(`data: ${JSON.stringify(e)}\n\n`));
  const hb = setInterval(() => raw.write(': hb\n\n'), 15000);
  req.raw.on('close', () => {
    clearInterval(hb);
    unsub();
  });
});

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`ForgeFX (node) on http://localhost:${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
