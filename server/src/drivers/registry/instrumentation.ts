// Transport instrumentation: TX/RX traffic counters (FORGEFX-27), the fn-0x1F edit-push echo guard,
// and interactive-vs-supervisor in-flight tracking (FORGEFX-28). Split out of registryCore.ts (C3) —
// owns only these counters; the registry drives it.
import type { Transport } from '../../transport/types.js';

// Per-transport-instance idempotency flag (double-wrapping would double-count the fn-0x1F echo guard
// and silently break front-panel edit reflection).
const INSTRUMENTED = Symbol('forgefx.transport.instrumented');

export interface TrafficCounters { txMsgs: number; txBytes: number; rxMsgs: number; rxBytes: number; }

export class TransportInstrumentation {
  // Cumulative since instrumentation began; survive across reconnects (each new transport is
  // re-instrumented and keeps counting into the same totals).
  readonly traffic: TrafficCounters = { txMsgs: 0, txBytes: 0, rxMsgs: 0, rxBytes: 0 };
  readonly since = Date.now();
  // In-flight fn-0x1F bulk reads: the edit-push listener drops our own poll replies while > 0.
  #pendingBulkReads = 0;
  // ALL requests currently awaiting a reply (route-driven AND supervisor polls); #supervisorInFlight is
  // the subset the supervisor itself issued (wrapped in supervised()). interactive = the difference.
  #inFlightRequests = 0;
  #supervisorInFlight = 0;

  get pendingBulkReads(): number { return this.#pendingBulkReads; }

  /** Wrap a freshly-opened transport with (1) the edit-push ECHO GUARD (each in-flight fn-0x1F
   *  bulk-read bumps pendingBulkReads), (2) TX counting on every outgoing frame, (3) ONE persistent
   *  onFrame handler for RX counting, (4) an all-requests in-flight counter for interactive-yield.
   *  Idempotent per transport instance (Symbol flag) so a re-wrap is a no-op. */
  instrument(t: Transport): void {
    const inst = t as Transport & { [INSTRUMENTED]?: boolean };
    if (inst[INSTRUMENTED]) return; // already wrapped — never double-wrap (breaks the echo guard)
    inst[INSTRUMENTED] = true;

    const countTx = (bytes: readonly number[]) => { this.traffic.txMsgs++; this.traffic.txBytes += bytes.length; };

    const origRequest = t.request.bind(t);
    t.request = (bytes, opts) => {
      countTx(bytes);
      this.#inFlightRequests++;
      const bulk = bytes[5] === 0x1f; // only a bulk read can elicit a 0x74 burst → echo guard counts it
      if (bulk) this.#pendingBulkReads++;
      return origRequest(bytes, opts).finally(() => {
        this.#inFlightRequests = Math.max(0, this.#inFlightRequests - 1);
        if (bulk) this.#pendingBulkReads = Math.max(0, this.#pendingBulkReads - 1);
      });
    };
    const origSend = t.send.bind(t);
    t.send = (bytes) => { countTx(bytes); return origSend(bytes); };
    const origSendQueued = t.sendQueued.bind(t);
    t.sendQueued = (bytes, settleMs) => { countTx(bytes); return origSendQueued(bytes, settleMs); };
    if (t.sendPaced) {
      const origSendPaced = t.sendPaced.bind(t);
      t.sendPaced = (bytes, chunk, delayMs) => { countTx(bytes); return origSendPaced(bytes, chunk, delayMs); };
    }
    // RX: one persistent handler for the transport's life (additive — coexists with request() waiters
    // and the edit-push listener, which register their own onFrame handlers).
    t.onFrame((frame) => { this.traffic.rxMsgs++; this.traffic.rxBytes += frame.length; });
  }

  /** Run a supervisor-issued device call while marking it so it doesn't register as INTERACTIVE
   *  traffic (meters and edit-watch poll concurrently — without this, one loop's request would make
   *  the other yield). */
  async supervised<T>(fn: () => Promise<T>): Promise<T> {
    this.#supervisorInFlight++;
    try { return await fn(); }
    finally { this.#supervisorInFlight = Math.max(0, this.#supervisorInFlight - 1); }
  }

  /** Route-driven (non-supervisor) requests currently in flight — supervisors yield to these. */
  interactiveInFlight(): number { return Math.max(0, this.#inFlightRequests - this.#supervisorInFlight); }
}
