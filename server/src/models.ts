/** Fractal device model IDs — byte f[4] of the SysEx header, returned by the fn 0x00 handshake.
  Used for device auto-detection: a connected unit identifies itself, so clients know which device
  is attached and whether a live codec exists for it. Gen-3 (0x10 III / 0x11 FM3 / 0x12 FM9 / 0x14 VP4)
  share the preset/grid codec family. `codec` names the per-device profile that drives it. */
export interface DeviceModel {
  name: string;
  short: string;
  gen: number; // 1 = Axe-Fx Std/Ultra, 2 = Axe-Fx II family, 3 = III/FM3/FM9/VP4, 4 = AM4
  codec: "fm3" | "fm9" | "axe3" | null; // live device profile (null = recognized, editor not yet wired)
}

export const DEVICE_MODELS: Record<number, DeviceModel> = {
  0x00: { name: "Axe-Fx Standard", short: "Axe-Fx", gen: 1, codec: null },
  0x01: { name: "Axe-Fx Ultra", short: "Ultra", gen: 1, codec: null },
  0x03: { name: "Axe-Fx II", short: "Axe-Fx II", gen: 2, codec: null },
  0x05: { name: "FX8", short: "FX8", gen: 2, codec: null },
  0x06: { name: "Axe-Fx II XL", short: "II XL", gen: 2, codec: null },
  0x07: { name: "Axe-Fx II XL+", short: "II XL+", gen: 2, codec: null },
  0x08: { name: "AX8", short: "AX8", gen: 2, codec: null },
  0x0a: { name: "FX8 Mk II", short: "FX8 II", gen: 2, codec: null },
  0x10: { name: "Axe-Fx III", short: "Axe-Fx III", gen: 3, codec: "axe3" },
  0x11: { name: "FM3", short: "FM3", gen: 3, codec: "fm3" },
  0x12: { name: "FM9", short: "FM9", gen: 3, codec: "fm9" },
  0x14: { name: "VP4", short: "VP4", gen: 3, codec: null }, // own value codec, no grid → separate path
  0x15: { name: "AM4", short: "AM4", gen: 4, codec: null } // 4-slot, own codec → separate path
};

export const MODEL_BROADCAST = 0x7f; // address used to ask "who is there?" (fn 0x00)

/** Best-effort model byte from a MIDI/serial port name (e.g. "Axe-Fx III MIDI In" → 0x10). Used as a
 *  fallback when the fn-0x00 broadcast handshake is silent (USB-MIDI on Windows, where the III has no
 *  serial node). Only devices with a live codec are matched, longest name first so "Axe-Fx III" wins
 *  over the substring "Axe-Fx II". */
export function modelFromPortName(portName: string): number | null {
  const n = portName.toLowerCase();
  const byLongestName = Object.entries(DEVICE_MODELS)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => b[1].name.length - a[1].name.length);
  for (const [model, info] of byLongestName) {
    if (info.codec && n.includes(info.name.toLowerCase())) return model;
  }
  return null;
}
