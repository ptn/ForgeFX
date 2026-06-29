// Unified connection layer over both transports. Lists serial + MIDI ports for the picker, resolves
// the active connection (manual override → serial auto-detect → MIDI auto-detect), opens the right
// Transport, and persists the user's manual pick.
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { detectPath, listAllPorts, FractalSerial } from './serial.js';
import { listMidiPorts, MidiTransport } from './midi.js';
import type { Transport, Conn, ConnKind } from './types.js';

export interface ConnInfo {
  transport: ConnKind;
  id: string;
  label: string;
  fractal: boolean;
  model?: string;
}

const OVERRIDE_FILE = process.env.FORGEFX_PORT_FILE ?? `${homedir()}/.forgefx-conn`;
let override: Conn | null = (() => {
  try {
    const raw = readFileSync(OVERRIDE_FILE, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      return j?.id ? { transport: j.transport === 'midi' ? 'midi' : 'serial', id: String(j.id) } : null;
    }
    return { transport: 'serial', id: raw }; // legacy plain-path file
  } catch {
    return null;
  }
})();
export const getConnOverride = (): Conn | null => override;
export function setConnOverride(c: Conn | null): void {
  override = c && c.id ? { transport: c.transport, id: c.id } : null;
  try {
    if (override) writeFileSync(OVERRIDE_FILE, JSON.stringify(override));
    else if (existsSync(OVERRIDE_FILE)) unlinkSync(OVERRIDE_FILE);
  } catch {
    /* persistence is best-effort */
  }
}

/** Every selectable connection (serial + MIDI), Fractal ones flagged — for the manual picker. */
export async function listConnections(): Promise<ConnInfo[]> {
  const serial = (await listAllPorts()).map(
    (p): ConnInfo => ({ transport: 'serial', id: p.path, label: p.model ? `${p.path} · ${p.model}` : p.friendlyName ? `${p.path} · ${p.friendlyName}` : p.path, fractal: p.fractal, model: p.model })
  );
  const midi = listMidiPorts().map((p): ConnInfo => ({ transport: 'midi', id: p.id, label: p.label, fractal: p.fractal }));
  return [...serial, ...midi];
}

/** Resolve the active connection: a present manual override → Fractal serial auto → Fractal MIDI auto. */
export async function resolveConn(): Promise<Conn | null> {
  const list = await listConnections();
  if (override && list.some((c) => c.transport === override!.transport && c.id === override!.id)) return override;
  const serialPath = await detectPath(); // env + Fractal serial auto-detect (CDC: FM3, FM9-if-serial)
  if (serialPath) return { transport: 'serial', id: serialPath };
  const midiFractal = list.find((c) => c.transport === 'midi' && c.fractal); // Axe-Fx III / FM9-if-MIDI
  if (midiFractal) return { transport: 'midi', id: midiFractal.id };
  return null;
}

export function openConn(conn: Conn): Transport {
  return conn.transport === 'midi' ? new MidiTransport(conn.id) : new FractalSerial({ path: conn.id });
}
