// ForgeFX HTTP API — Node backend (fractal-midi codec). Mirrors the REST contract
// Axis consumes; drop-in replacement for the retired C# server.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { device } from './device.js';

const PORT = Number(process.env.PORT ?? 5056);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });

// ── system ──
app.get('/healthz', () => device.health());
app.get('/device', () => device.deviceInfo());
app.get('/ports', () => device.connections()); // serial + MIDI connections (Fractal flagged) + chosen + override
app.post<{ Body: { transport?: 'serial' | 'midi'; id?: string | null } }>('/ports/select', (req) =>
  device.selectConnection(req.body?.id ? { transport: req.body.transport === 'midi' ? 'midi' : 'serial', id: req.body.id } : null)
); // manual pick (null id clears back to auto)

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
app.get('/cab/irs', () => device.profile.cabIrs());

// Foot Controller + Modifier address models (field bases + config formula + enums). FM3-decoded;
// null where the device's model isn't decoded yet. The client computes (eid,pid) from these and
// reads/writes via the normal raw-read + setParam path.
app.get('/fc/model', () => device.profile.fcModel ?? null);
app.get('/mod/model', () => device.profile.modModel ?? null);
// raw param values for an effect (for FC eid 199 / Modifier eid 3, whose params have no display range)
app.get<{ Params: { eid: string } }>('/preset/blocks/:eid/raw', async (req, reply) => {
  try { return await device.rawBlock(Number(req.params.eid)); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
});
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

// ── static UI (optional) ──
// When FORGEFX_STATIC points at a built SPA (Axis), serve it for any non-API GET, with SPA
// fallback to index.html. Registered as the not-found handler so it never shadows API routes.
// Used by the desktop app (loads http://localhost:PORT) and headless/Pi single-binary setups.
const STATIC = process.env.FORGEFX_STATIC;
if (STATIC) {
  const root = resolve(STATIC);
  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.wasm': 'application/wasm'
  };
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
    const urlPath = decodeURIComponent(req.url.split('?')[0] ?? '/');
    let file = join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!resolve(file).startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return reply.code(404).send({ error: 'not found' });
    return reply.type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(file));
  });
}

// Auto port allocation: try PORT; if it's taken, let the OS assign a free one (port 0).
// The actual bound port is logged (and the desktop app picks a free port up front anyway).
async function listen(port: number, fellBack = false): Promise<void> {
  try {
    await app.listen({ port, host: '0.0.0.0' });
    const addr = app.server.address();
    const actual = addr && typeof addr === 'object' ? addr.port : port;
    app.log.info(`ForgeFX (node) on http://localhost:${actual}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' && !fellBack) {
      app.log.warn(`port ${port} in use — falling back to an OS-assigned free port`);
      return listen(0, true);
    }
    app.log.error(e);
    process.exit(1);
  }
}
listen(PORT);
