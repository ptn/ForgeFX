// FORGEFX-32 guarded live-walk probe — finds the EXACT query that wedges an FM3.
//
// Runs the PRODUCTION walk (codec liveWalk, production pacing/envelope) one block at a
// time with full TX/RX byte logging, and stops at the FIRST anomaly instead of pushing on:
//   • every query byte-logged (JSONL: ts, dir, rtt, hex, decoded view/block/param/sub)
//   • abort on the first reply timeout
//   • warn + aliveness-check on any RTT spike (> SPIKE_MS)
//   • aliveness check (fn 0x08 firmware query) after EVERY block — silence = device wedged
// After a freeze, the tail of the log IS the killing query.
//
// Run (FM3 connected, port free — no ForgeFX/Axis/browser session may hold it):
//   npm run probe:walk                 # blocks 0..127 (stops on first anomaly)
//   npx tsx src/probes/walk-probe.ts 0 10        # scope: blocks 0..10
//   npx tsx src/probes/walk-probe.ts 41 41       # a single block
import { appendFileSync } from 'node:fs';
import { liveWalk, type LiveTransport } from 'forgefx-midi/cache';
import { buildFirmwareVersionQuery, parseFirmwareVersionReply } from 'forgefx-midi/shared';
import { FractalSerial } from '../transport/serial.js';

const MODEL_FM3 = 0x11;
const SPIKE_MS = 400;
const QUERY_TIMEOUT_MS = 1000;
// Production envelope (must mirror services/deviceCache.ts — we probe what ships).
const PACE_MS = 3;
const BLOCK_PAUSE_MS = 150;
const MAX_PARAM_ID = 127;

const startBlock = Number(process.argv[2] ?? 0);
const endBlock = Number(process.argv[3] ?? 127);
const LOG = `${process.env.HOME}/walk-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const log = (o: Record<string, unknown>) => appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...o }) + '\n');

/** Decode the addressing of a fn-0x01 walk query for the human-readable log. */
function describeQuery(q: Uint8Array): Record<string, unknown> {
  return {
    view: q[6], block: q[8],
    param: (q[10] ?? 0) | ((q[11] ?? 0) << 7),
    sub: (q[12] ?? 0) | ((q[13] ?? 0) << 7),
    highSub: ((q[12] ?? 0) | ((q[13] ?? 0) << 7)) > 127
  };
}

async function main(): Promise<void> {
  const dev = new FractalSerial();
  console.log(`→ port ${dev.path}`);
  console.log(`→ byte log: ${LOG}`);
  console.log(`→ blocks ${startBlock}..${endBlock}, params 0..${MAX_PARAM_ID}, pace ${PACE_MS}ms, block pause ${BLOCK_PAUSE_MS}ms`);
  await dev.open();

  const controller = new AbortController();
  process.on('SIGINT', () => { console.log('\nSIGINT → abort'); controller.abort(); });

  let queries = 0;
  let lastQueries: string[] = [];

  /** fn 0x08 firmware read — the known-safe "are you alive?" ping. */
  async function alive(label: string): Promise<boolean> {
    const q = buildFirmwareVersionQuery(MODEL_FM3);
    const t0 = Date.now();
    try {
      const frames = await dev.request(q, { timeoutMs: 800, quietMs: 20, match: (fs) => fs.some((f) => f[5] === 0x08) });
      const hit = frames.find((f) => f[5] === 0x08);
      const fw = hit ? parseFirmwareVersionReply(hit) : null;
      const ok = !!fw;
      log({ kind: 'aliveness', label, ok, rtt: Date.now() - t0 });
      if (!ok) console.log(`  !! aliveness ${label}: NO valid fw reply (${Date.now() - t0}ms)`);
      return ok;
    } catch {
      log({ kind: 'aliveness', label, ok: false, rtt: Date.now() - t0, error: 'timeout' });
      console.log(`  !! aliveness ${label}: TIMEOUT — device likely wedged`);
      return false;
    }
  }

  /** Production-equivalent adapter (echo-matched like services/deviceCache.ts) + logging + tripwires. */
  const transport: LiveTransport = {
    async request(query: Uint8Array): Promise<Uint8Array | null> {
      const bytes = Array.from(query);
      const fn = bytes[5];
      const desc = describeQuery(query);
      const line = `#${queries} ${JSON.stringify(desc)} tx ${hex(bytes)}`;
      lastQueries = [...lastQueries.slice(-4), line];
      const t0 = Date.now();
      log({ kind: 'tx', n: queries, ...desc, bytes: hex(bytes) });
      queries += 1;
      const isEcho = (f: readonly number[]): boolean =>
        f.length > 10 && f[0] === 0xf0 && f[5] === fn && f[6] === bytes[6] && f[10] === bytes[10];
      try {
        const frames = await dev.request(bytes, { timeoutMs: QUERY_TIMEOUT_MS, quietMs: 20, match: (fs) => fs.some((f) => isEcho(f)) });
        const rtt = Date.now() - t0;
        const hit = frames.find((f) => isEcho(f));
        log({ kind: 'rx', n: queries - 1, rtt, hit: !!hit, bytes: hit ? hex(hit) : null });
        if (rtt > SPIKE_MS) {
          console.log(`  ! RTT spike ${rtt}ms on ${JSON.stringify(desc)}`);
          if (!(await alive('after-spike'))) { controller.abort(); return null; }
        }
        return hit ? Uint8Array.from(hit) : null;
      } catch {
        const rtt = Date.now() - t0;
        log({ kind: 'rx-timeout', n: queries - 1, rtt });
        console.log(`\n!! TIMEOUT after ${rtt}ms — STOPPING. Last queries:\n${lastQueries.join('\n')}`);
        controller.abort();
        return null;
      }
    }
  };

  if (!(await alive('pre-flight'))) {
    console.log('device not answering the safe fw query — aborting before any walk traffic');
    dev.close();
    return;
  }

  for (let block = startBlock; block <= endBlock && !controller.signal.aborted; block++) {
    const t0 = Date.now();
    const before = queries;
    try {
      const records = await liveWalk(transport, {
        model: MODEL_FM3,
        blocks: [block],
        maxParamId: MAX_PARAM_ID,
        interQueryMs: PACE_MS,
        blockPauseMs: BLOCK_PAUSE_MS,
        signal: controller.signal
      });
      const labels = records.reduce((n, r) => n + (r.kind === 'enum' ? r.values.length : 0), 0);
      console.log(`block ${String(block).padStart(3)}: ${records.length} records, ${labels} labels, ${queries - before} queries, ${Date.now() - t0}ms`);
      log({ kind: 'block-done', block, records: records.length, labels, queries: queries - before, ms: Date.now() - t0 });
    } catch (e) {
      if (controller.signal.aborted) break;
      console.log(`block ${block}: walk error ${(e as Error).message}`);
      log({ kind: 'block-error', block, error: (e as Error).message });
    }
    if (!(await alive(`post-block-${block}`))) {
      console.log(`\n!! device wedged after block ${block}. Last queries:\n${lastQueries.join('\n')}`);
      break;
    }
  }

  console.log(`\ndone. ${queries} queries total. Log: ${LOG}`);
  dev.close();
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
