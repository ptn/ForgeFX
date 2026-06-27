# Devices & families

ForgeFX is **not FM3-only.** FM3 is the current development target; the design supports the
wider Fractal range. How a new device is added depends on its protocol *family*.

## Shared, portable core

Every Fractal unit uses the same SysEx envelope and a 7-bit packing scheme:

```
F0 00 01 74 <model> <fn> <body…> <checksum> F7      checksum = XOR(F0…body) & 0x7F
```

That layer (`FractalSysex`) is device-agnostic. What differs per device: the **model byte**,
**value encoding**, **grid**, **channels/scenes**, and the **parameter IDs** (paramIds are *not*
reusable across model bytes).

## gen-3 family — a profile, not new code

**Axe-Fx III (`0x10`), FM3 (`0x11`), FM9 (`0x12`)** share one codec — the Huffman preset/grid
decode (`Fm3PresetCodec`) and the write ops (`Fm3Device`) already implemented. They differ only
in a `DeviceProfile` (`FractalDevices`):

| Device | Model | Grid | Channels | Scenes |
|--------|-------|------|----------|--------|
| FM3 | `0x11` | 4×12 | A–D | 8 |
| FM9 | `0x12` | 6×14 | A–D | 8 |
| Axe-Fx III | `0x10` | 6×14 | A–D | 8 |

Select one with `--model fm9` (defaults to `fm3`); the decoder also auto-detects the model from
each preset dump. Adding another gen-3 sibling = one row in the registry.

> Cosmetic follow-up: the `Fm3Device` / `Fm3PresetCodec` names will become family-generic
> (`FractalDevice` / `Gen3PresetCodec`) — tracked in [#18](https://github.com/sKuhLight/ForgeFX/issues/18).

## Other families — separate codecs

These share the envelope but have their own preset format + write opcodes, so they'll be added as
their own codecs (+ profiles) rather than config:

- **Axe-Fx II** (`0x07`, gen-2): grid, X/Y channels, `fn=0x02` writes, Q8.02 values.
- **AM4 / gen-1** (`0x15`): linear 4 slots, no grid, Q16 values.

The portable core + the device-profile pattern carry over; the preset/write codec is per family.
