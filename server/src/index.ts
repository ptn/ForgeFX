// ForgeFX HTTP API — Node backend (fractal-midi codec). Mirrors the REST contract
// Axis consumes; drop-in replacement for the retired C# server.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { device } from './device.js';

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

// ── live block params ──
app.get<{ Params: { slug: string } }>('/preset/blocks/:slug/params', async (req, reply) => {
  try { return await device.blockParams(req.params.slug); } catch (e) { reply.code(404); return { error: (e as Error).message }; }
});
app.put<{ Params: { slug: string; param: string }; Body: { value: number; continuous?: boolean } }>(
  '/preset/blocks/:slug/params/:param',
  (req) => device.setParam(req.params.slug, decodeURIComponent(req.params.param), req.body.value, req.body.continuous ?? true)
);
app.post<{ Params: { slug: string }; Body: { bypassed: boolean } }>('/preset/blocks/:slug/bypass', (req) =>
  device.setBypass(req.params.slug, req.body.bypassed)
);
app.post<{ Params: { slug: string }; Body: { channel: string } }>('/preset/blocks/:slug/channel', (req) =>
  device.setChannel(req.params.slug, req.body.channel)
);

// ── grid editing (1-indexed row/col, matching FM-Edit) ──
app.put<{ Body: { row: number; col: number; blockId: number } }>('/preset/grid/cell', (req) =>
  device.placeCell(req.body.row, req.body.col, req.body.blockId)
);
app.post<{ Body: { srcRow: number; srcCol: number; destRow: number; connect?: boolean } }>('/preset/grid/cable', (req) =>
  device.cable(req.body.srcRow, req.body.srcCol, req.body.destRow, req.body.connect ?? true)
);
app.post<{ Body: { row: number; col: number } }>('/preset/grid/select', (req) => device.selectCell(req.body.row, req.body.col));

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`ForgeFX (node) on http://localhost:${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
