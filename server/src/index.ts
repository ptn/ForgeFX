// ForgeFX HTTP API — Node backend (fractal-midi codec). Keeps the REST contract
// Axis already consumes; swap-in replacement for the retired C# server.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { device } from './device.js';

const PORT = Number(process.env.PORT ?? 5056);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(cors, { origin: true });

app.get('/healthz', async () => device.health());

app.get('/preset', async () => {
  const name = await device.presetName();
  return { name: name ?? '—' };
});

// BETA: live routing grid via sub=0x2E (FM3 calibration pending — see probes/grid-read.ts)
app.get('/preset/grid', async (_req, reply) => {
  try {
    return await device.grid();
  } catch (e) {
    reply.code(503);
    return { error: (e as Error).message };
  }
});

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`ForgeFX (node) on http://localhost:${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
