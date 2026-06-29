// A Fractal device transport — serial (FM3 CDC) or USB-MIDI (Axe-Fx III, and FM9-if-MIDI).
// Both carry the same gen-3 SysEx frames; the device layer is transport-agnostic.
export interface RequestOpts {
  timeoutMs?: number;
  quietMs?: number;
  match?: (frames: number[][]) => boolean;
}

export interface Transport {
  /** Human-readable identifier (serial path or MIDI port name) for display. */
  readonly label: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Fire-and-forget single SysEx frame. */
  send(bytes: readonly number[]): void;
  /** Serialized fire-and-forget (won't inject mid-read). */
  sendQueued(bytes: readonly number[], settleMs?: number): Promise<void>;
  /** Send a request and collect reply frames (serialized against other requests). */
  request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]>;
  /** Subscribe to every inbound SysEx frame; returns an unsubscribe fn. */
  onFrame(handler: (frame: number[]) => void): () => void;
}

export type ConnKind = 'serial' | 'midi';
/**
 * A selectable connection. Serial (FM3) is one bidirectional port (`id` = path). USB-MIDI devices
 * (Axe-Fx III / FM9) expose INPUT and OUTPUT as independent endpoints with possibly different names
 * — confirmed against FM9-Edit / Axe-Edit III, which select an Input Port and an Output Port
 * separately — so MIDI carries `inId` + `outId` (the input/output port names). `id` is a display key.
 */
export interface Conn {
  transport: ConnKind;
  id: string;
  /** MIDI input port name (USB-MIDI only). */
  inId?: string;
  /** MIDI output port name (USB-MIDI only). */
  outId?: string;
}
