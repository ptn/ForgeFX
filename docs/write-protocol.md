# Write protocol (gen-3)

How ForgeFX writes to the device: parameter edits, bypass/channel, grid editing,
preset switch/store. Implemented in `Fm3Device` (pure body builders + send/verify) and
exposed by the server's write endpoints. Frames are the gen-3 family ops; the FM3 shapes
below are byte-confirmed against FM3-Edit captures (via the mcp-midi-control codec — see
`NOTICE`). Everything is little-endian 7-bit; the envelope is the usual
`F0 00 01 74 11 <fn> <body> <cksum> F7`.

## Ops

| Write | Wire | Body |
|-------|------|------|
| Set param (knob) | fn `0x01` sub `0x52 00` | `eid14 pid14 float32(normalized 0..1) 00 00 00 00` |
| Set param (model/type) | fn `0x01` sub `0x09 00` | `eid14 pid14 float32(ordinal) 00 00 00 00` |
| Bypass | fn `0x0A` | `eid14 dd` (dd: 1=bypassed) |
| Channel | fn `0x0B` | `eid14 ch` (0..3 = A..D) |
| Place/clear block | fn `0x01` sub `0x32` | `blockId14 00 00 gridPos14 …` · `gridPos=(col-1)*rows+(row-1)`, FM3 rows=4 · blockId 0 clears |
| Cable | fn `0x01` sub `0x35` | FM3 4-row: `b21=srcGp>>1`, `b22=((srcGp&1)<<6)\|srcCol`, `b23=(destRow-1)<<5` · `srcGp=(srcCol-1)*4+(srcRow-1)` |
| Switch preset | fn `0x01` sub `0x27` | `preset14 @ pos 6` |
| Store preset | fn `0x01` sub `0x26` | `preset14 @ pos 6` |

`eid` = effect id (the block's base id + instance-1). `pid` = parameter index. The value is a
5-septet float32 — for a knob it's the normalized 0..1 value; for a model/type select it's the
roster ordinal as a float.

## Accept / reject model

The device sends **nothing on accept**. On rejection it returns a `0x64` MULTIPURPOSE_RESPONSE
whose 2-byte body is `[echoedFn, resultCode]`. `Fm3Device.SendWrite` sends a frame and watches a
short window for a `0x64` rejection of the function it sent; no rejection ⇒ accepted. Result
codes (`DescribeResultCode`) include `0x05` invalid effect id, `0x06` invalid param id, `0x0b`
bad grid position, `0x0c` DSP overload, etc.

## Safety

- **`?dryRun=true`** on any write endpoint returns the exact frame hex **without sending** —
  use it to preview/verify before touching the device.
- **`--writes false`** starts the server read-only; every write endpoint then returns `403`.
- **Store is beta.** Save *persistence* is not hardware-verified on the FM3, so `POST
  /preset/store` is flagged beta and should be confirmed on the device. ForgeFX never
  auto-saves during navigation.

## Confidence

Set param (continuous + typed), bypass, switch-preset, and the FM3 4-row cable formula are
FM3-hardware-confirmed (per the source captures). Grid block placement (sub `0x32`) and store
(sub `0x26`) are spec/capture-derived but **not yet confirmed on this project's FM3** — treat
them as beta and verify with `dryRun` + a single live test first. Tracked in
[#4](https://github.com/sKuhLight/ForgeFX/issues/4).
