// Transport-layer unit tests — serial framing/request semantics, USB-MIDI port pairing + delivery,
// and the connection resolver. No hardware: a fake serial port and a fake @julusian/midi binding are
// injected through the transports' seams. Covers chunked/partial reads, noise between frames, the
// quiet-gap vs match vs timeout terminations, paced sends, reconnect, and MIDI SysEx filtering.
import { FractalSerial, type SerialFactory, type SerialPortLike } from '../../src/transport/serial.js';
import { MidiTransport, listMidiPorts, pairMidiOutput, stripSeqId, type MidiMod } from '../../src/transport/midi.js';
import {
  listConnections,
  resolveConn,
  openConn,
  setConnOverride,
  getConnOverride,
  setProfileOverride,
  getProfileOverride,
} from '../../src/transport/connection.js';
import { assert, assertEqual, sleep, hex } from '../helpers/mock.js';

export const TRANSPORT_CASE_COUNT = 24;

// ── fake serial port ────────────────────────────────────────────────────────────
class FakeSerialPort {
  isOpen = false;
  readonly written: number[][] = [];
  #data = new Set<(buf: Buffer) => void>();
  #error = new Set<(err: Error) => void>();
  on(event: 'data' | 'error', cb: (arg: never) => void): void {
    if (event === 'data') this.#data.add(cb as unknown as (buf: Buffer) => void);
    else this.#error.add(cb as unknown as (err: Error) => void);
  }
  write(data: Uint8Array): unknown { this.written.push(Array.from(data)); return true; }
  close(cb: () => void): void { this.isOpen = false; cb(); }
  /** Deliver RX bytes to the transport's `data` handler(s). */
  push(bytes: number[]): void { const b = Buffer.from(bytes); for (const h of this.#data) h(b); }
  fail(err: Error): void { for (const h of this.#error) h(err); }
}

function serialHarness(): { port: FakeSerialPort; factory: SerialFactory } {
  const port = new FakeSerialPort();
  const factory: SerialFactory = (_opts, onOpen) => {
    port.isOpen = true;
    onOpen(null);
    return port as unknown as SerialPortLike;
  };
  return { port, factory };
}
async function openSerial(portFactory: SerialFactory): Promise<FractalSerial> {
  const s = new FractalSerial({ path: '/dev/fake-fm3', portFactory });
  await s.open();
  return s;
}

// ── fake @julusian/midi binding ─────────────────────────────────────────────────
class FakeMidiEndpoint {
  opened = -1;
  destroyed = false;
  closed = false;
  #message: ((dt: number, msg: number[]) => void) | null = null;
  constructor(readonly ports: string[]) {}
  getPortCount(): number { return this.ports.length; }
  getPortName(i: number): string { return this.ports[i]!; }
  ignoreTypes(): void { /* no-op */ }
  setBufferSize(): void { /* no-op */ }
  openPort(i: number): void { this.opened = i; }
  closePort(): void { this.closed = true; }
  destroy(): void { this.destroyed = true; }
  on(_event: string, cb: (dt: number, msg: number[]) => void): void { this.#message = cb; }
  emit(msg: number[]): void { this.#message?.(0, msg); }
}
class FakeMidiOutput extends FakeMidiEndpoint {
  readonly sent: number[][] = [];
  send(msg: number[]): void { this.sent.push(msg); }
}
function midiMod(input: FakeMidiEndpoint, output: FakeMidiEndpoint): MidiMod {
  return {
    Input: function () { return input; } as unknown as MidiMod['Input'],
    Output: function () { return output; } as unknown as MidiMod['Output'],
  };
}

export async function runTransportTests(): Promise<void> {
  // ── serial: framing + request semantics ─────────────────────────────────────
  // 1. a frame split across three data chunks is reassembled.
  {
    const { port, factory } = serialHarness();
    const s = await openSerial(factory);
    assertEqual(s.isOpen, true, 'serial isOpen after open');
    const p = s.request([0xf0, 0x01, 0xf7], { match: (f) => f.length >= 1, quietMs: 5, timeoutMs: 200 });
    await sleep(2);
    assertEqual(port.written.length, 1, 'serial sent the request');
    assertEqual(hex(port.written[0]!), 'f0 01 f7', 'serial TX frame');
    port.push([0xf0, 0x00]);
    port.push([0x74, 0x11]);
    port.push([0xf7]);
    const frames = await p;
    assertEqual(frames.length, 1, 'one frame from split chunks');
    assertEqual(hex(frames[0]!), 'f0 00 74 11 f7', 'reassembled frame');
    await s.close();
    assertEqual(s.isOpen, false, 'serial isOpen false after close');
  }

  // 2. leading/trailing noise is dropped; two frames in one chunk arrive as two.
  {
    const { port, factory } = serialHarness();
    const s = await openSerial(factory);
    const p = s.request([0x01], { match: (f) => f.length >= 2, quietMs: 5, timeoutMs: 200 });
    await sleep(2);
    port.push([0x12, 0x34, 0xf0, 0x01, 0xf7, 0x99, 0xf0, 0x02, 0xf7, 0x88]);
    const frames = await p;
    assertEqual(frames.length, 2, 'two frames split out of one chunk');
    assertEqual(hex(frames[0]!), 'f0 01 f7', 'first frame');
    assertEqual(hex(frames[1]!), 'f0 02 f7', 'second frame');
    await s.close();
  }

  // 3. without a match, the request resolves on the quiet gap after the last frame.
  {
    const { port, factory } = serialHarness();
    const s = await openSerial(factory);
    const p = s.request([0x01], { quietMs: 10, timeoutMs: 500 });
    await sleep(2);
    port.push([0xf0, 0x03, 0xf7]);
    const frames = await p;
    assertEqual(frames.length, 1, 'quiet-gap termination returns the frame');
    assertEqual(hex(frames[0]!), 'f0 03 f7', 'quiet-gap frame');
    await s.close();
  }

  // 4. a silent device returns no frames after the hard timeout.
  {
    const { factory } = serialHarness();
    const s = await openSerial(factory);
    const started = Date.now();
    const frames = await s.request([0x01], { timeoutMs: 20 });
    assertEqual(frames.length, 0, 'timeout yields no frames');
    assert(Date.now() - started >= 15, 'timeout actually waited');
    await s.close();
  }

  // 5. sendPaced chunks a large payload (64 B by default) and resolves.
  {
    const { port, factory } = serialHarness();
    const s = await openSerial(factory);
    const bytes = Array.from({ length: 200 }, (_, i) => i & 0x7f);
    await s.sendPaced(bytes, 64, 1);
    assertEqual(port.written.length, 4, 'paced send chunk count');
    assertEqual(port.written.map((w) => w.length).join(','), '64,64,64,8', 'chunk sizes');
    assertEqual(port.written.flat().join(','), bytes.join(','), 'paced bytes round-trip in order');
    await s.close();
  }

  // 6. send/sendQueued throw (or reject) while the port is closed.
  {
    const { factory } = serialHarness();
    const s = new FractalSerial({ path: '/dev/fake-fm3', portFactory: factory });
    let threw = false;
    try { s.send([0xf0, 0xf7]); } catch { threw = true; }
    assertEqual(threw, true, 'send before open throws');
  }

  // 7. close → reopen reconnects (the fake port comes back open).
  {
    const { factory } = serialHarness();
    const s = await openSerial(factory);
    await s.close();
    assertEqual(s.isOpen, false, 'closed before reconnect');
    await s.open();
    assertEqual(s.isOpen, true, 'reconnected');
    await s.close();
  }

  // 8. sendQueued serializes on the request chain and writes in order.
  {
    const { port, factory } = serialHarness();
    const s = await openSerial(factory);
    await Promise.all([s.sendQueued([0xf0, 0x0a, 0xf7], 1), s.sendQueued([0xf0, 0x0b, 0xf7], 1)]);
    assertEqual(port.written.length, 2, 'both queued sends written');
    assertEqual(hex(port.written[0]!), 'f0 0a f7', 'queued write order #1');
    assertEqual(hex(port.written[1]!), 'f0 0b f7', 'queued write order #2');
    await s.close();
  }

  // 9. onFrame fans out every inbound frame and unsubscribes cleanly.
  {
    const { port, factory } = serialHarness();
    const s = await openSerial(factory);
    const got: number[][] = [];
    const off = s.onFrame((f) => got.push(f));
    port.push([0xf0, 0x01, 0xf7, 0xf0, 0x02, 0xf7]);
    assertEqual(got.length, 2, 'onFrame delivered both frames');
    off();
    port.push([0xf0, 0x03, 0xf7]);
    assertEqual(got.length, 2, 'unsubscribed handler stops receiving');
    await s.close();
  }

  // ── MIDI: pure pairing helpers ──────────────────────────────────────────────
  // 10. In→Out token swap resolves an exact pair.
  assertEqual(pairMidiOutput('Axe-Fx III MIDI In', ['Axe-Fx III MIDI Out', 'Other']), 'Axe-Fx III MIDI Out', 'MIDI exact In→Out swap');
  // 11. stem match when the suffix differs.
  assertEqual(pairMidiOutput('FM3', ['FM3 OUT']), 'FM3 OUT', 'MIDI stem match');
  // 12. sole output is the fallback.
  assertEqual(pairMidiOutput('Some Input', ['Only Output']), 'Only Output', 'MIDI single-output fallback');
  // 13. no outputs → null.
  assertEqual(pairMidiOutput('Some Input', []), null, 'MIDI no outputs → null');
  // 14. ALSA sequence id is stripped for stable matching.
  assertEqual(stripSeqId('FM3 MIDI 1 28:0'), 'FM3 MIDI 1', 'MIDI strip seq id');

  // 15. listMidiPorts flags Fractal endpoints and lists each direction.
  {
    const inp = new FakeMidiEndpoint(['FM3 MIDI In']);
    const outp = new FakeMidiOutput(['Generic USB', 'Axe-Fx III MIDI Out']);
    const ports = listMidiPorts(midiMod(inp, outp));
    assertEqual(ports.length, 3, 'MIDI port count');
    assertEqual(ports[0]!.id, 'FM3 MIDI In', 'MIDI input id');
    assertEqual(ports[0]!.fractal, true, 'FM3 flagged fractal');
    assertEqual(ports[0]!.dir, 'input', 'input direction');
    assertEqual(ports[1]!.id, 'Generic USB', 'MIDI output id');
    assertEqual(ports[1]!.fractal, false, 'generic not fractal');
    assertEqual(ports[2]!.fractal, true, 'Axe-Fx flagged fractal');
    assertEqual(inp.destroyed && outp.destroyed, true, 'enumeration endpoints destroyed');
  }

  // 16. no binding → no ports (serial path stays usable).
  assertEqual(listMidiPorts(null).length, 0, 'MIDI unavailable → no ports');

  // 17. slow flag reflects a generic (DIN) vs Fractal (USB-MIDI) endpoint.
  assertEqual(new MidiTransport('Generic In', 'Generic Out').slow, true, 'generic MIDI is slow');
  assertEqual(new MidiTransport('FM3 MIDI In', 'FM3 MIDI Out').slow, false, 'Fractal MIDI is fast');

  // ── MIDI: open + request + filtering ────────────────────────────────────────
  // 18. open + request delivers a whole SysEx frame.
  {
    const inp = new FakeMidiEndpoint(['FM3 MIDI In']);
    const outp = new FakeMidiOutput(['FM3 MIDI Out']);
    const t = new MidiTransport('FM3 MIDI In', 'FM3 MIDI Out', { midi: midiMod(inp, outp) });
    await t.open();
    assertEqual(t.isOpen, true, 'MIDI open');
    assertEqual(inp.opened, 0, 'MIDI input opened');
    assertEqual(outp.opened, 0, 'MIDI output opened');
    const p = t.request([0xf0, 0x01, 0xf7], { match: (f) => f.length >= 1, quietMs: 5, timeoutMs: 200 });
    await sleep(2);
    assertEqual(hex(outp.sent[0]!), 'f0 01 f7', 'MIDI TX frame');
    inp.emit([0xf0, 0x00, 0x74, 0x11, 0xf7]);
    const frames = await p;
    assertEqual(frames.length, 1, 'MIDI request frame');
    assertEqual(hex(frames[0]!), 'f0 00 74 11 f7', 'MIDI RX frame');
    await t.close();
    assertEqual(t.isOpen, false, 'MIDI closed');
  }

  // 19. non-SysEx messages are filtered out of the frame stream.
  {
    const inp = new FakeMidiEndpoint(['FM3 MIDI In']);
    const outp = new FakeMidiOutput(['FM3 MIDI Out']);
    const t = new MidiTransport('FM3 MIDI In', 'FM3 MIDI Out', { midi: midiMod(inp, outp) });
    await t.open();
    const got: number[][] = [];
    t.onFrame((f) => got.push(f));
    inp.emit([0x90, 0x40, 0x7f]); // note-on, not SysEx
    assertEqual(got.length, 0, 'non-SysEx filtered');
    inp.emit([0xf0, 0x02, 0xf7]);
    assertEqual(got.length, 1, 'SysEx delivered');
    await t.close();
  }

  // 20. open throws when the requested port doesn't exist, and destroys the probes.
  {
    const inp = new FakeMidiEndpoint(['Other In']);
    const outp = new FakeMidiOutput(['Other Out']);
    const t = new MidiTransport('FM3 MIDI In', 'FM3 MIDI Out', { midi: midiMod(inp, outp) });
    let threw = false;
    try { await t.open(); } catch { threw = true; }
    assertEqual(threw, true, 'MIDI missing port throws');
    assertEqual(inp.destroyed && outp.destroyed, true, 'failed-open endpoints destroyed');
  }

  // 21. an explicitly unavailable binding makes open throw.
  {
    const t = new MidiTransport('FM3 MIDI In', 'FM3 MIDI Out', { midi: null });
    let threw = false;
    try { await t.open(); } catch { threw = true; }
    assertEqual(threw, true, 'MIDI unavailable throws');
  }

  // ── connection resolver ─────────────────────────────────────────────────────
  setConnOverride(null);
  setProfileOverride(null);

  // 22. listConnections merges serial + MIDI entries with model labels.
  {
    const list = await listConnections({
      listAllPorts: async () => [{ path: '/dev/cu.fm3', fractal: true, model: 'FM3' }],
      listMidiPorts: () => [{ id: 'Axe-Fx III MIDI In', label: 'Axe-Fx III MIDI In', fractal: true, dir: 'input' }],
    });
    assertEqual(list.length, 2, 'connection count');
    assertEqual(list[0]!.label, '/dev/cu.fm3 · FM3', 'serial label uses model');
    assertEqual(list[1]!.transport, 'midi', 'midi entry transport');
  }

  // 23. resolveConn: override > serial auto-detect > Fractal MIDI auto (with output pairing).
  {
    const noPorts = { listAllPorts: async () => [], listMidiPorts: () => [] };
    // serial auto-detect
    const viaSerial = await resolveConn({ ...noPorts, detectPath: async () => '/dev/fm3' });
    assertEqual(viaSerial?.transport, 'serial', 'auto serial transport');
    assertEqual(viaSerial?.id, '/dev/fm3', 'auto serial path');
    // MIDI auto with pairing (no serial)
    const viaMidi = await resolveConn({
      listAllPorts: async () => [],
      listMidiPorts: () => [
        { id: 'FM3 MIDI In', label: 'FM3 MIDI In', fractal: true, dir: 'input' },
        { id: 'FM3 MIDI Out', label: 'FM3 MIDI Out', fractal: true, dir: 'output' },
      ],
      detectPath: async () => null,
    });
    assertEqual(viaMidi?.transport, 'midi', 'auto MIDI transport');
    assertEqual(viaMidi?.outId, 'FM3 MIDI Out', 'auto MIDI output paired');
    // nothing present → null
    const none = await resolveConn({ ...noPorts, detectPath: async () => null });
    assertEqual(none, null, 'no connection → null');
    // manual serial override wins when still present
    setConnOverride({ transport: 'serial', id: '/dev/keep' });
    const kept = await resolveConn({ listAllPorts: async () => [{ path: '/dev/keep', fractal: true }], listMidiPorts: () => [], detectPath: async () => '/dev/other' });
    assertEqual(kept?.id, '/dev/keep', 'manual serial override honored');
    assertEqual(getConnOverride()?.id, '/dev/keep', 'override readable');
    setConnOverride(null);
  }

  // 24. profile override normalizes 'auto' → null; openConn builds the right transport kind.
  {
    setProfileOverride('fm3');
    assertEqual(getProfileOverride(), 'fm3', 'profile override set');
    setProfileOverride('auto');
    assertEqual(getProfileOverride(), null, 'profile override auto clears');
    assertEqual(openConn({ transport: 'serial', id: '/dev/x' }).kind, 'serial', 'openConn serial kind');
    const midi = openConn({ transport: 'midi', id: 'FM3 MIDI In', inId: 'FM3 MIDI In', outId: 'FM3 MIDI Out' });
    assertEqual(midi.kind, 'midi', 'openConn midi kind');
    if (midi.kind !== 'midi') throw new Error('unreachable');
    assertEqual(midi.label, 'FM3 MIDI In ⇄ FM3 MIDI Out', 'openConn midi label');
  }
}
