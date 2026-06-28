/** Fractal device model IDs — byte f[4] of the SysEx header, returned by the fn 0x00 handshake.
  Used for device auto-detection: a connected unit identifies itself, so clients know which device
  is attached and whether a live codec exists for it. Gen-3 (0x10 III / 0x11 FM3 / 0x12 FM9 / 0x14 VP4)
  share the preset/grid codec family. `codec` names the per-device profile that drives it. */
export interface DeviceModel {
  name: string;
  short: string;
  gen: number; // 1 = Axe-Fx Std/Ultra, 2 = Axe-Fx II family, 3 = III/FM3/FM9/VP4
  codec: "fm3" | "fm9" | null; // which live device profile drives it (null = recognized, not yet supported)
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
  0x10: { name: "Axe-Fx III", short: "Axe-Fx III", gen: 3, codec: null },
  0x11: { name: "FM3", short: "FM3", gen: 3, codec: "fm3" },
  0x12: { name: "FM9", short: "FM9", gen: 3, codec: "fm9" },
  0x14: { name: "VP4", short: "VP4", gen: 3, codec: null }
};

export const MODEL_BROADCAST = 0x7f; // address used to ask "who is there?" (fn 0x00)
