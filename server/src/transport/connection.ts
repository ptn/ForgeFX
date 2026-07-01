// Unified connection layer over both transports. Lists serial + MIDI ports for the picker, resolves
// the active connection (manual override → serial auto-detect → MIDI auto-detect), opens the right
// Transport, and persists the user's manual pick.
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { detectPath, listAllPorts, FractalSerial } from './serial.js';
import { listMidiPorts, MidiTransport, pairMidiOutput } from './midi.js';
import type { Transport, Conn, ConnKind } from './types.js';

export interface ConnInfo {
  transport: ConnKind;
  id: string;
  label: string;
  fractal: boolean;
  model?: string;
  /** MIDI only: which endpoint this entry is (the picker offers In + Out separately). */
  dir?: 'input' | 'output';
}

const OVERRIDE_FILE = process.env.FORGEFX_PORT_FILE ?? `${homedir()}/.forgefx-conn`;
// Two independent, co-persisted overrides in ~/.forgefx-conn: the connection (transport + ports) and an
// optional device-PROFILE key (fm3/fm9/axe3/am4) forced from the Axis "Connection & Device" page. Either
// can be set alone (e.g. force FM3 but auto-pick the port, or a manual port with auto-detected profile).
let override: Conn | null = null;
let profileOverride: string | null = null;
(function loadOverrideFile() {
  try {
    const raw = readFileSync(OVERRIDE_FILE, 'utf8').trim();
    if (!raw) return;
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      if (typeof j?.model === 'string' && j.model) profileOverride = j.model;
      if (j?.transport === 'midi') {
        const inId = j.inId ?? j.id;
        const outId = j.outId ?? j.id;
        if (inId && outId) override = { transport: 'midi', id: j.id ?? inId, inId: String(inId), outId: String(outId) };
      } else if (j?.id) {
        override = { transport: 'serial', id: String(j.id) };
      }
    } else {
      override = { transport: 'serial', id: raw }; // legacy plain-path file
    }
  } catch {
    /* no/invalid override file */
  }
})();
// Serialize both overrides into the one file (or delete it when both are cleared). Best-effort.
function persistOverride(): void {
  try {
    if (!override && !profileOverride) {
      if (existsSync(OVERRIDE_FILE)) unlinkSync(OVERRIDE_FILE);
      return;
    }
    const obj: Record<string, unknown> = override ? { ...override } : {};
    if (profileOverride) obj.model = profileOverride;
    writeFileSync(OVERRIDE_FILE, JSON.stringify(obj));
  } catch {
    /* persistence is best-effort */
  }
}
export const getConnOverride = (): Conn | null => override;
export function setConnOverride(c: Conn | null): void {
  if (c && c.transport === 'midi' && c.inId && c.outId) override = { transport: 'midi', id: c.id || c.inId, inId: c.inId, outId: c.outId };
  else if (c && c.id) override = { transport: 'serial', id: c.id };
  else override = null;
  persistOverride();
}
export const getProfileOverride = (): string | null => profileOverride;
export function setProfileOverride(key: string | null): void {
  profileOverride = key && key !== 'auto' ? key : null;
  persistOverride();
}

/** Every selectable connection (serial + MIDI), Fractal ones flagged — for the manual picker.
 *  Serial and MIDI are listed independently so a failure in one (e.g. the native MIDI binding) never
 *  hides the other — the FM3 serial path must survive a broken MIDI module. */
export async function listConnections(): Promise<ConnInfo[]> {
  let serial: ConnInfo[] = [];
  try {
    serial = (await listAllPorts()).map(
      (p): ConnInfo => ({ transport: 'serial', id: p.path, label: p.model ? `${p.path} · ${p.model}` : p.friendlyName ? `${p.path} · ${p.friendlyName}` : p.path, fractal: p.fractal, model: p.model })
    );
  } catch (e) {
    console.warn(`[forgefx] serial port listing failed: ${(e as Error).message}`);
  }
  let midi: ConnInfo[] = [];
  try {
    midi = listMidiPorts().map((p): ConnInfo => ({ transport: 'midi', id: p.id, label: p.label, fractal: p.fractal, dir: p.dir }));
  } catch (e) {
    console.warn(`[forgefx] MIDI port listing failed: ${(e as Error).message}`);
  }
  return [...serial, ...midi];
}

/** Resolve the active connection: a present manual override → Fractal serial auto → Fractal MIDI auto
 *  (auto-pairs the Fractal MIDI Input with its matching Output, e.g. "Axe-Fx III MIDI In/Out"). */
export async function resolveConn(): Promise<Conn | null> {
  // resilient: a failure listing MIDI/serial ports must NOT block the FM3 serial auto-detect below.
  let list: ConnInfo[] = [];
  try {
    list = await listConnections();
  } catch (e) {
    console.warn(`[forgefx] listConnections failed: ${(e as Error).message}`);
  }
  const midiOutNames = list.filter((c) => c.transport === 'midi' && c.dir === 'output').map((c) => c.id);
  // present manual override still valid?
  if (override) {
    if (override.transport === 'midi') {
      const okIn = list.some((c) => c.transport === 'midi' && c.dir === 'input' && c.id === override!.inId);
      const okOut = list.some((c) => c.transport === 'midi' && c.dir === 'output' && c.id === override!.outId);
      if (okIn && okOut) return override;
    } else if (list.some((c) => c.transport === 'serial' && c.id === override!.id)) {
      return override;
    }
  }
  const serialPath = await detectPath().catch(() => null); // env + Fractal serial auto-detect (CDC: FM3, FM9-if-serial)
  if (serialPath) return { transport: 'serial', id: serialPath };
  // MIDI auto: pick the Fractal input, pair its output (Axe-Fx III / FM9 expose In + Out separately).
  const midiIn = list.find((c) => c.transport === 'midi' && c.dir === 'input' && c.fractal);
  if (midiIn) {
    const outId = pairMidiOutput(midiIn.id, midiOutNames) ?? midiIn.id;
    return { transport: 'midi', id: midiIn.id, inId: midiIn.id, outId };
  }
  return null;
}

export function openConn(conn: Conn): Transport {
  if (conn.transport === 'midi') return new MidiTransport(conn.inId ?? conn.id, conn.outId ?? conn.id);
  return new FractalSerial({ path: conn.id });
}
