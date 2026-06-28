// FM3 (gen-3 Fractal) serial transport. The device exposes a USB CDC serial
// endpoint (interface if03) that carries raw SysEx frames — the same path the
// retired C# ForgeFX used. fractal-midi builds/parses the SysEx; this layer just
// does framed serial I/O with request/response correlation.
import { SerialPort } from 'serialport';
import { existsSync, readdirSync, appendFileSync } from 'node:fs';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const BY_ID_DIR = '/dev/serial/by-id';

export interface TransportOpts {
  /** explicit device path; otherwise auto-detected */
  path?: string;
  baudRate?: number;
}

/** Resolve the device path. An explicit FORGEFX_SERIAL wins (e.g. /dev/fm3 in Docker); otherwise
 * prefer the stable by-id Fractal if03 node (survives ttyACM renumbering), then fall back to ttyACM0. */
export function autoDetectPath(): string | null {
  const env = process.env.FORGEFX_SERIAL;
  if (env && existsSync(env)) return env;
  try {
    if (existsSync(BY_ID_DIR)) {
      const hit = readdirSync(BY_ID_DIR).find((n) => /Fractal/i.test(n) && /if03/i.test(n));
      if (hit) return `${BY_ID_DIR}/${hit}`;
    }
  } catch {
    /* fall through */
  }
  return existsSync('/dev/ttyACM0') ? '/dev/ttyACM0' : null;
}

export class FractalSerial {
  #port: SerialPort | null = null;
  #rx: number[] = [];
  #frameHandlers = new Set<(frame: number[]) => void>();
  readonly path: string;

  constructor(opts: TransportOpts = {}) {
    const path = opts.path ?? autoDetectPath();
    if (!path) throw new Error('No FM3 serial port found (looked for by-id Fractal if03, then /dev/ttyACM0)');
    this.path = path;
    this.#baud = opts.baudRate ?? 115200;
  }
  #baud: number;

  // ── capture tap (FORGEFX_TAP=1 → ./tap.log, or FORGEFX_TAP=/path) ──
  // Timestamps every RX/TX SysEx frame so we can diff FM3-Edit traffic (CPU + tuner discovery).
  #tapPath: string | null = process.env.FORGEFX_TAP ? (process.env.FORGEFX_TAP === '1' ? 'tap.log' : process.env.FORGEFX_TAP) : null;
  #logTap(dir: 'RX' | 'TX', bytes: readonly number[]) {
    if (!this.#tapPath) return;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
    try {
      appendFileSync(this.#tapPath, `${Date.now()} ${dir} ${hex}\n`);
    } catch {
      /* tap is best-effort */
    }
  }

  async open(): Promise<void> {
    if (this.#port?.isOpen) return;
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: this.#baud }, (err) => (err ? reject(err) : resolve()));
      port.on('data', (buf: Buffer) => this.#ingest(buf));
      port.on('error', () => {});
      this.#port = port;
    });
  }

  async close(): Promise<void> {
    const p = this.#port;
    this.#port = null;
    if (p?.isOpen) await new Promise<void>((r) => p.close(() => r()));
  }

  get isOpen() {
    return !!this.#port?.isOpen;
  }

  // ── framing ──
  #ingest(buf: Buffer) {
    for (const b of buf) {
      if (b === SYSEX_START) this.#rx = [b];
      else if (this.#rx.length) {
        this.#rx.push(b);
        if (b === SYSEX_END) {
          const frame = this.#rx;
          this.#rx = [];
          this.#logTap('RX', frame);
          for (const h of this.#frameHandlers) h(frame);
        }
      }
    }
  }

  /** Fire-and-forget send of one SysEx frame. */
  send(bytes: readonly number[]): void {
    if (!this.#port?.isOpen) throw new Error('port not open');
    this.#logTap('TX', bytes);
    this.#port.write(Buffer.from(bytes));
  }

  // serial is a single shared stream — requests MUST run one at a time, or reply
  // frames from concurrent requests interleave and corrupt each other.
  #chain: Promise<unknown> = Promise.resolve();

  /**
   * Send a request and collect reply frames. Serialized against all other requests.
   * Resolves once a quiet gap (`quietMs`) passes after the last frame, or `match` is
   * satisfied, or `timeoutMs` elapses. Handles single-frame replies and multi-frame dumps.
   */
  request(
    bytes: readonly number[],
    opts: { timeoutMs?: number; quietMs?: number; match?: (frames: number[][]) => boolean } = {}
  ): Promise<number[][]> {
    const task = () => this.#once(bytes, opts);
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  /**
   * Fire-and-forget write, but SERIALIZED on the request chain so it never injects
   * bytes mid-read (which would corrupt a concurrent dump/bulk-read). Resolves after
   * a short settle so any echo is drained before the next request collects.
   */
  sendQueued(bytes: readonly number[], settleMs = 20): Promise<void> {
    const task = () =>
      new Promise<void>((resolve) => {
        this.send(bytes);
        setTimeout(resolve, settleMs);
      });
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  #once(
    bytes: readonly number[],
    { timeoutMs = 1500, quietMs = 90, match }: { timeoutMs?: number; quietMs?: number; match?: (frames: number[][]) => boolean } = {}
  ): Promise<number[][]> {
    this.#rx = []; // drop any stale partial frame before a fresh exchange
    return new Promise((resolve) => {
      const frames: number[][] = [];
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (quietTimer) clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        this.#frameHandlers.delete(handler);
        resolve(frames);
      };
      const handler = (frame: number[]) => {
        frames.push(frame);
        if (match?.(frames)) return done();
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      };
      const hardTimer = setTimeout(done, timeoutMs);
      this.#frameHandlers.add(handler);
      this.send(bytes);
    });
  }

  onFrame(handler: (frame: number[]) => void): () => void {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }
}
