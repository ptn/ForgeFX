// USB-MIDI transport for Fractal units that present as a MIDI-class device (Axe-Fx III, and FM9 if
// it enumerates as MIDI). Uses @julusian/midi (RtMidi, N-API prebuilds → bundles like serialport).
// SysEx framing is trivial here: RtMidi delivers each F0..F7 message whole, so no byte reassembly.
import { Input, Output } from '@julusian/midi';
import { appendFileSync } from 'node:fs';
import type { Transport, RequestOpts } from './types.js';

const SYSEX_START = 0xf0;
// Fractal-looking MIDI port names (CoreMIDI/ALSA expose the unit by name).
const FRACTAL_RE = /fractal|axe[ -]?fx|fm[ -]?3|fm[ -]?9|ax8|vp4/i;

export interface MidiPortInfo {
  id: string; // the port name (used to reopen it)
  label: string;
  fractal: boolean;
  dir: 'input' | 'output';
}

/**
 * Pair the matching OUTPUT port for a given INPUT port name. USB-MIDI Fractal units expose two
 * endpoints named like "Axe-Fx III MIDI In" / "Axe-Fx III MIDI Out" — same stem, In/Out suffix.
 * Try an In→Out token swap (exact), else match by the suffix-stripped stem, else fall back to the
 * sole output (or the input name itself).
 */
export function pairMidiOutput(inputName: string, outputs: string[]): string | null {
  if (!outputs.length) return null;
  const swap = inputName
    .replace(/\bInput\b/gi, 'Output')
    .replace(/\bIn\b/gi, 'Out')
    .replace(/\bRX\b/gi, 'TX');
  if (swap !== inputName) {
    const exact = outputs.find((o) => o === swap);
    if (exact) return exact;
  }
  const stem = (s: string) => s.replace(/\b(midi|usb)\b/gi, '').replace(/\b(in|out|input|output|rx|tx)\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const inStem = stem(inputName);
  const byStem = outputs.find((o) => stem(o) === inStem);
  if (byStem) return byStem;
  return outputs.length === 1 ? outputs[0]! : null;
}

type PortLister = { getPortCount(): number; getPortName(i: number): string };
function findPort(p: PortLister, id: string): number {
  for (let i = 0; i < p.getPortCount(); i++) if (p.getPortName(i) === id) return i;
  for (let i = 0; i < p.getPortCount(); i++) {
    const n = p.getPortName(i);
    if (n.includes(id) || id.includes(n)) return i;
  }
  return -1;
}

/** All MIDI ports visible to the OS — inputs and outputs listed SEPARATELY (USB-MIDI devices like
 *  the Axe-Fx III / FM9 expose distinct In and Out endpoints), Fractal ones flagged. */
export function listMidiPorts(): MidiPortInfo[] {
  const out: MidiPortInfo[] = [];
  const collect = (p: PortLister, dir: 'input' | 'output') => {
    for (let i = 0; i < p.getPortCount(); i++) {
      const name = p.getPortName(i);
      if (name) out.push({ id: name, label: name, fractal: FRACTAL_RE.test(name), dir });
    }
  };
  const inp = new Input();
  const outp = new Output();
  try {
    collect(inp, 'input');
    collect(outp, 'output');
  } finally {
    inp.destroy();
    outp.destroy();
  }
  return out;
}

export class MidiTransport implements Transport {
  #in: Input | null = null;
  #out: Output | null = null;
  #handlers = new Set<(frame: number[]) => void>();
  readonly label: string;
  #inId: string;
  #outId: string;

  /** Open a USB-MIDI device by its (independent) input + output port names. */
  constructor(inId: string, outId: string) {
    this.#inId = inId;
    this.#outId = outId;
    this.label = inId === outId ? inId : `${inId} ⇄ ${outId}`;
  }

  async open(): Promise<void> {
    if (this.#in && this.#out) return;
    const inp = new Input();
    const out = new Output();
    const ii = findPort(inp, this.#inId);
    const oi = findPort(out, this.#outId);
    if (ii < 0 || oi < 0) {
      inp.destroy();
      out.destroy();
      throw new Error(`MIDI port not found: in="${this.#inId}" (${ii}) / out="${this.#outId}" (${oi})`);
    }
    inp.ignoreTypes(false, true, true); // RECEIVE SysEx (ignored by default)
    inp.on('message', (_dt, msg) => {
      if (msg[0] === SYSEX_START) {
        const frame = msg as number[];
        this.#logTap('RX', frame);
        for (const h of this.#handlers) h(frame);
      }
    });
    inp.openPort(ii);
    out.openPort(oi);
    this.#in = inp;
    this.#out = out;
  }

  async close(): Promise<void> {
    try {
      this.#in?.closePort();
      this.#in?.destroy();
    } catch {
      /* */
    }
    try {
      this.#out?.closePort();
      this.#out?.destroy();
    } catch {
      /* */
    }
    this.#in = null;
    this.#out = null;
  }

  get isOpen(): boolean {
    return !!(this.#in && this.#out);
  }

  send(bytes: readonly number[]): void {
    if (!this.#out) throw new Error('midi port not open');
    this.#logTap('TX', bytes);
    this.#out.send([...bytes]);
  }

  onFrame(handler: (frame: number[]) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  // requests run one at a time (shared MIDI stream), same contract as the serial transport
  #chain: Promise<unknown> = Promise.resolve();
  request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    const task = () => this.#once(bytes, opts);
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }
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
  #once(bytes: readonly number[], { timeoutMs = 1500, quietMs = 90, match }: RequestOpts = {}): Promise<number[][]> {
    return new Promise((resolve) => {
      const frames: number[][] = [];
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (quietTimer) clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        this.#handlers.delete(handler);
        resolve(frames);
      };
      const handler = (frame: number[]) => {
        frames.push(frame);
        if (match?.(frames)) return done();
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      };
      const hardTimer = setTimeout(done, timeoutMs);
      this.#handlers.add(handler);
      this.send(bytes);
    });
  }

  #tapPath: string | null = process.env.FORGEFX_TAP ? (process.env.FORGEFX_TAP === '1' ? 'tap.log' : process.env.FORGEFX_TAP) : null;
  #logTap(dir: 'RX' | 'TX', bytes: readonly number[]) {
    if (!this.#tapPath) return;
    try {
      appendFileSync(this.#tapPath, `${Date.now()} ${dir} ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);
    } catch {
      /* best-effort */
    }
  }
}
