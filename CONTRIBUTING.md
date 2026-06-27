# Contributing to ForgeFX

Thanks for your interest! ForgeFX is an open SDK + HTTP API for Fractal devices. Contributions
— new device support, parameter/enum data, bug fixes, docs — are welcome.

## Prerequisites

- **.NET 10 SDK**.
- For live testing: a Fractal FM3 on USB. Most logic (codec, catalog, OpenAPI) needs no
  hardware — only the `/preset/*`, `/device`, and `/debug/*` endpoints touch the serial port.

## Build, test, run

```sh
dotnet build
dotnet test                                   # must stay green

dotnet run --project src/ForgeFX.Server -- \
  --urls http://localhost:5056 \
  --device /dev/serial/by-id/usb-Fractal_Audio_Systems_FM3-if03 \
  --definitions $PWD/definitions
# explore at http://localhost:5056/scalar
```

The server **owns the serial port** — close FM3-Edit / any bridge first. On Linux the device
may enumerate as `ttyACM0` or `ttyACM1`; the `/dev/serial/by-id/...` path is stable.

## Project layout

| Path | What |
|------|------|
| `src/ForgeFX.Core` | SDK: framing/checksum (`FractalSysex`), device client (`Fm3Device`), preset/grid decoder (`Fm3PresetCodec`), catalog (`Definitions`). |
| `src/ForgeFX.Server` | HTTP API (minimal APIs) + OpenAPI/Scalar. Each endpoint is named and tagged. |
| `tests/ForgeFX.Core.Tests` | xUnit. Codec changes must keep the fixture tests passing. |
| `definitions/` | JSON definition packs (one per block family). |

## Guidelines

- **Keep the API named.** Prefer `slug`/parameter-name routing over raw ids/addresses in
  public endpoints; raw access stays under `/debug`.
- **Tag + summarize endpoints** (`.WithTags(...)`, `.WithSummary(...)`) so the OpenAPI doc and
  `/scalar` stay useful.
- **Pin wire behaviour with tests.** Anything decoded from the device should have a vector or
  fixture test so we don't regress against firmware quirks.
- **Cite hardware claims.** When you mark something device-verified, say on which model +
  firmware.
- **Respect third-party licenses.** Reused format knowledge is credited in `NOTICE` and the
  relevant docs.

## Refreshing real-world model names

`definitions/names/<slug>.json` maps Fractal model names to the real amps/pedals they're based
on (served at `GET /blocks/{slug}/types`). The data comes from the Fractal wiki, which is
Cloudflare-gated — so it is **not** fetched automatically. To refresh:

1. Open a models page in a browser (it passes Cloudflare), e.g. **Amp models → Edit source**
   (or `?action=raw`), and save the wikitext as `amp_models` / `drive_models` / `chorus_models`.
2. Run the parser:
   ```sh
   dotnet run --project tools/ForgeFX.NameSync -- <folder-with-saved-files> definitions/names
   ```
3. Commit the regenerated JSON. Attribution lives in `NOTICE`.

## Adding parameter / enum data

The definition packs (`definitions/fm3-*.json`) map a block's parameters to names, and
(optionally) units, ranges, and a `Type` param's model list (`options`) that surfaces at
`GET /blocks/{slug}/types`. PRs that fill these in — verified against the device — are
especially valuable.
