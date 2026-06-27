# ForgeFX

[![ci](https://github.com/sKuhLight/ForgeFX/actions/workflows/ci.yml/badge.svg)](https://github.com/sKuhLight/ForgeFX/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-72a4f2?logo=ko-fi&logoColor=white)](https://ko-fi.com/R5R6223HMO)

An open, cross-platform development platform / SDK for **Fractal Audio** devices — starting
with the **FM3**. ForgeFX speaks the device's own protocol over USB and exposes it as a
clean, named **HTTP API** with an OpenAPI spec, so any client — a web editor, a Raspberry Pi
on stage, a Python script, a hardware controller — can read and edit the amp by name instead
of by raw wire bytes.

The headline feature: ForgeFX decodes the **full preset live from the device** — the real
routing grid, block placement, and cabling — not just a flat list of effects.

> **Status:** community-beta. The gen-3 preset/grid codec, device client, and HTTP API run on
> **.NET 10** and are unit-tested against real FM3 preset dumps. Hardware-verified on FM3
> firmware 12.0.

## What it does

- 🎛 **Live routing grid.** Pull the current preset straight off the device and decode the
  real 4×12 grid: every block's position, the cables between them, parallel branches, and
  merges. (See [how it works](docs/preset-grid-codec.md).)
- 🔤 **Named API.** Browse the block/parameter catalog and edit by name —
  `GET /blocks/amp/params`, `PUT /preset/blocks/amp/params/Drive` — never raw effect ids or
  addresses in the happy path.
- 📖 **OpenAPI + Scalar.** A generated OpenAPI 3.1 document (`/openapi/v1.json`) and an
  interactive API explorer at **`/scalar`**.
- 💾 **Backup / restore.** Download any preset as `.syx`, restore from file.
- 🥧 **Runs anywhere.** Windows, Linux, and a Raspberry Pi strapped to the unit for live use;
  publishes as a self-contained binary (no runtime install for end users).

## Quickstart

```sh
dotnet build
dotnet test                      # codec + framing vectors must pass

dotnet run --project src/ForgeFX.Server -- \
  --urls http://localhost:5056 \
  --device /dev/serial/by-id/usb-Fractal_Audio_Systems_FM3-if03 \
  --definitions $PWD/definitions
```

Then open **<http://localhost:5056/scalar>** to explore the API, or:

```sh
curl localhost:5056/device                 # model + firmware
curl localhost:5056/preset/grid            # the real routing grid, decoded live
curl localhost:5056/blocks/amp/params      # named parameter catalog for the Amp block
```

> The API **owns the serial port** — stop any FM3-Edit bridge / other editor first
> (`fuser -v /dev/ttyACM0` shows who holds it). Use the stable `/dev/serial/by-id/...` path so
> it survives the device hopping between `ttyACM0`/`ttyACM1`.

## Docker (recommended for deployment)

The easiest way to run ForgeFX on a Raspberry Pi (or any host), behind a reverse proxy:

```sh
docker compose up -d --build
docker compose logs -f
```

The image is multi-arch (amd64 + arm64), so it builds natively on a Pi. The FM3 is passed
through in [`docker-compose.yml`](./docker-compose.yml): the host's stable `by-id` symlink is
mapped to a fixed `/dev/fm3` inside the container, so the device name stays put across
`ttyACM0`/`ttyACM1` re-enumeration. Adjust the mapping for your unit, and uncomment the
`group_add`/`privileged` line if the container can't open the serial device.

The compose file also has commented **Traefik** labels for putting ForgeFX behind a reverse
proxy with TLS (or just proxy `http://forgefx:5056` from Caddy/nginx).

## The API

Resource-oriented and named. Full, always-current reference at `/scalar`; the shape:

| Area | Endpoint | Description |
|------|----------|-------------|
| System | `GET /device` | model + firmware |
| Catalog | `GET /blocks` | every block family with a definition pack |
| Catalog | `GET /blocks/{slug}/params` | a block's parameters (names, units, ranges) |
| Catalog | `GET /blocks/{slug}/types` | a block's model/type list (e.g. amp models) |
| Preset | `GET /preset` · `GET /presets/{n}` | preset number + name |
| Preset | `GET /preset/grid` · `GET /presets/{n}/grid` | **decoded routing grid** (placement + cabling) |
| Preset | `GET /preset/blocks` | placed blocks: position, routing, bypass, channel |
| Preset | `POST /preset/select` | switch preset by number |
| Parameters | `GET /preset/blocks/{slug}/params` | live, named parameter values |
| Parameters | `PUT /preset/blocks/{slug}/params/{param}` | set a parameter by name |
| Backup | `GET /presets/{n}/backup` · `POST /presets/restore` | `.syx` download / upload |
| Debug | `GET /debug/...` | raw frame tap + page dump (advanced / unstable) |

## Architecture

| Project | What |
|---------|------|
| `src/ForgeFX.Core` | The SDK: SysEx framing/checksum, value codecs, `Fm3Device` (serial client), and `Fm3PresetCodec` (the gen-3 preset → grid decoder). |
| `src/ForgeFX.Server` | ASP.NET Core minimal-API HTTP layer over the SDK, with OpenAPI + Scalar. |
| `tests/ForgeFX.Core.Tests` | xUnit tests pinning the framing codec to captured device vectors and the preset codec to real preset dumps. |
| `definitions/` | JSON definition packs (block families → parameters), loaded at runtime. |

A web frontend ("Axis") lives in a separate repo and consumes this API.

## Zero-install distribution

```sh
dotnet publish src/ForgeFX.Server -c Release -r win-x64     --self-contained -p:PublishSingleFile=true
dotnet publish src/ForgeFX.Server -c Release -r linux-arm64 --self-contained -p:PublishSingleFile=true   # Raspberry Pi
```

On Windows the FM3 is a COM port via Fractal's USB driver; on Linux it's native CDC
(`/dev/ttyACM0`), no driver needed.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for what's shipped and what's planned, or browse the
[issues](https://github.com/sKuhLight/ForgeFX/issues) (filter by the `epic` label).

## Documentation

- [Preset & routing-grid codec](docs/preset-grid-codec.md) — how a live preset is decoded.
- [Definition packs](docs/definitions.md) — the block/parameter catalog format.
- [ADR 0001 — transport](docs/api-design.md) — REST + WebSockets design decision.
- [Contributing](CONTRIBUTING.md).

## Credits & thanks

The gen-3 preset/grid format was a wall until these open projects lit the way — huge thanks:

- **[mcp-midi-control](https://github.com/TheAndrewStaker/mcp-midi-control)** (Apache-2.0) —
  its gen-3 codec showed the dump framing, the Huffman-compressed patch body, and the grid
  layout. ForgeFX's `Fm3PresetCodec` is an independent C# reimplementation of that format.
- **fractal-syx-codec** by Andrew Mercurio / BoodieTraps (Apache-2.0) — the published
  `FORMAT.md` those decoders are built from.
- **[Fractal Audio Wiki](https://wiki.fractalaudio.com)** — the real-world model-name data
  (which amp/pedal each Fractal model is based on), used as factual reference with attribution.

See [`NOTICE`](./NOTICE) for attribution details.

## Support

ForgeFX is free and open source. If it's useful to you, you can support development on Ko-fi:

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/R5R6223HMO)

## License

MIT — see [`LICENSE`](./LICENSE). ForgeFX is an independent project and is not affiliated
with or endorsed by Fractal Audio Systems. "Axe-Fx", "FM3", and "FM9" are trademarks of
Fractal Audio Systems.
