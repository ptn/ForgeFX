# POST /preset/convert — cross-device preset converter

Converts a Fractal preset onto a different Fractal device, **best-effort**, and returns the
target preset plus a per-decision event log. The heavy lifting (decode → lift → engine) lives
in the `forgefx-midi/convert` codec module; ForgeFX decodes the source, runs the engine, and
serves this DTO (`server/src/services/convert.ts`).

## Request

```jsonc
POST /preset/convert
{
  "targetDevice": "am4",            // required — one of the ConverterDeviceId values below
  "source": { "syx": "<base64>" }   // optional
}
```

- **`source.syx` present** → OFFLINE conversion of the uploaded dump. No device needed. The
  source family is detected from the SysEx envelope model byte. Supported offline:
  **gen-3 preset dumps** (Axe-Fx III `0x10` / FM3 `0x11` / FM9 `0x12`) and **AM4 single-preset
  frames** (`0x15`). Any other family → `400`.
- **`source` omitted** → convert the CONNECTED device's CURRENT preset. Capability-gated: the
  active driver must advertise `presetConvert` (see below), else `501`.

`targetDevice` (`ConverterDeviceId`): `axe-fx-iii` · `fm9` · `fm3` · `vp4` · `am4` ·
`axe-fx-ii` · `axe-fx-gen1`.

## Response `200`

```jsonc
{
  "source": { "device": "fm3", "name": "A-Class 15", "decodeDepth": "full" },
  "target": { /* ConverterPreset JSON (sourceDevice kept for provenance; meta.convertedTo set) */ },
  "events": [ /* ConversionEvent[] — one per lossy/best-effort decision */ ],
  "summary": { "total": 17, "info": 6, "warn": 4, "loss": 7 }
}
```

`summary` folds each event through the codec's `severityOf()`; buckets sum to `total`, which
equals `events.length`. A lossless conversion (e.g. FM3→FM9, shared gen-3 roster) returns
`events: []` and an all-zero summary.

## Errors

| status | when |
|---|---|
| `400` | unknown/unsupported `targetDevice`, or the source `syx` is undecodable / an unsupported family |
| `501` | `source` omitted and the active driver's `presetConvert` capability is false |
| `503` | the connected device did not respond while reading the current preset |

## `presetConvert` capability (advertised in `GET /device` → `capabilities.presetConvert`)

| device | presetConvert | lift depth |
|---|---|---|
| Axe-Fx III / FM3 / FM9 (gen-3) | `true` | full (grid + per-scene block state + amp knobs) |
| VP4 | `true` | skeleton (name + scenes + 4-slot chain identity, via the structure blob) |
| AM4 | `true` | partial (name + scenes + amp block per-channel params) |
| Axe-Fx II (gen-2) | `false` | preset-parse decoder not reachable through the codec's public exports; lift is name-only |
| Axe-Fx gen-1 | `false` | no lift adapter (gen-1 is a converter TARGET only) |
