// Shared bridge that lets a ForgeFX DeviceDriver drive a forgefx-midi DeviceDescriptor's
// reader/writer over the ONE registry-owned Transport. The descriptor readers/writers talk to a
// `MidiConnection` (register a receiveSysExMatching waiter, then send, on the RAW transport — NOT
// the serialized dev.request chain). Two reader calls racing on the shared transport would
// interleave their waiters + sends, so the descriptor-based drivers (gen2 / vp4) serialize every
// reader call behind a per-instance promise-chain mutex (see #withReader in each driver).
//
// This is the same adapter the AM4 driver defines inline as `Am4Conn` (am4.ts) — extracted here so
// gen2.ts and vp4.ts share it. `close()` is a no-op: the registry owns the transport lifecycle.
import type { MidiConnection } from 'forgefx-midi/core/midi';
import type { DispatchCtx } from 'forgefx-midi/core';
import type { Transport } from '../transport/types.js';

/** A `MidiConnection` backed by ForgeFX's shared `Transport`. */
export class TransportConn implements MidiConnection {
  hasInput = true;
  lastSendError: Error | undefined = undefined;
  #t: Transport;
  constructor(t: Transport) { this.#t = t; }

  send(bytes: number[]): void {
    try {
      this.#t.send(bytes);
      this.lastSendError = undefined;
    } catch (e) {
      this.lastSendError = e instanceof Error ? e : new Error(String(e));
    }
  }

  onMessage(handler: (bytes: number[]) => void): () => void {
    return this.#t.onFrame(handler);
  }

  /** Resolve on the next complete inbound SysEx frame; reject on timeout. */
  receiveSysEx(timeoutMs = 1000): Promise<number[]> {
    return this.#waitFor(() => true, timeoutMs);
  }

  /** Resolve on the first inbound SysEx frame satisfying `pred`; reject on timeout. */
  receiveSysExMatching(pred: (bytes: number[]) => boolean, timeoutMs = 1000): Promise<number[]> {
    return this.#waitFor(pred, timeoutMs);
  }

  #waitFor(pred: (bytes: number[]) => boolean, timeoutMs: number): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const timer = setTimeout(() => { unsub?.(); reject(new Error(`descriptor receiveSysEx timeout after ${timeoutMs}ms`)); }, timeoutMs);
      unsub = this.#t.onFrame((frame) => {
        if (!pred(frame)) return;
        clearTimeout(timer);
        unsub?.();
        resolve(frame);
      });
    });
  }

  close(): void { /* no-op: the registry owns the transport lifecycle */ }
}

/** Build the DispatchCtx the reader/writer expect. They only touch `ctx.conn`; the `descriptor`
 *  field is required by the type but unused on the read/write paths, so we hand it the descriptor. */
export function dispatchCtx(descriptor: unknown, transport: Transport): DispatchCtx {
  return { conn: new TransportConn(transport), descriptor: descriptor as never } as DispatchCtx;
}
