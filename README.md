# ForgeFX

An open development platform / SDK for **Fractal Audio** devices — starting with the **FM3**.

ForgeFX is a clean, cross-platform implementation of the Fractal device protocol (reverse-
engineered in the companion [`fm3-protocol`](https://github.com/sKuhLight/) project) plus an
HTTP/WebSocket API to drive the device. It runs on Windows, Linux, and a Raspberry Pi
strapped to the unit for live use — and ships as a self-contained binary, so end users don't
need to install a runtime.

> Status: early. Codec + device client + HTTP API scaffolded on **.NET 10**. The protocol
> codec is unit-tested against byte vectors captured from a real FM3 (firmware 12.0).

## Layout

| Project | What |
|---------|------|
| `src/ForgeFX.Core` | The SDK: SysEx framing/checksum, value codecs, and `Fm3Device` (serial client — firmware, set parameter, select preset, bulk block dump). |
| `src/ForgeFX.Server` | ASP.NET Core HTTP API over the SDK (`/firmware`, `/preset`, `/param`, `/dump/{page}`). |
| `tests/ForgeFX.Core.Tests` | xUnit tests pinning the codec to captured device vectors. |

The web frontend lives in a separate repo and talks to the Server API.

## Protocol, in one paragraph
Frame: `F0 00 01 74 <model=0x11> <func> <body> <checksum> F7`. Parameter writes use
`func 0x01` with the value as a 7-bit-packed **float32** (engineering units or 0..1). Bulk
reads use `func 0x1f <page>` → `0x74`(header)+`0x75`(payload)+`0x76`(end), where each value
is a 7-bit-packed **16-bit int normalized ÷65536**. Preset select is MIDI Bank Select +
Program Change. Full notes: the `fm3-protocol` repo `docs/`.

## Build & test
```sh
dotnet build
dotnet test          # codec vectors must pass
```

## Run the API
Requires the ASP.NET Core 10 runtime (e.g. CachyOS/Arch: `sudo pacman -S aspnet-runtime-10.0`),
or publish self-contained (below).
```sh
dotnet run --project src/ForgeFX.Server -- --urls http://0.0.0.0:8770 --device /dev/ttyACM0
# GET /healthz | GET /firmware | POST /preset {"n":430}
# POST /param {"effect":82,"addr":[0,62,0,62,0],"value":0.699} | GET /dump/62
```
NOTE: the API owns the serial port — stop any FM3-Edit bridge first.

## Zero-install distribution (the goal)
```sh
dotnet publish src/ForgeFX.Server -c Release -r win-x64   --self-contained -p:PublishSingleFile=true
dotnet publish src/ForgeFX.Server -c Release -r linux-arm64 --self-contained -p:PublishSingleFile=true   # Raspberry Pi
```

## Windows note
On Windows the FM3 appears as a COM port via Fractal's USB driver (most FM3-Edit users have
it). On Linux it's native CDC (`/dev/ttyACM0`), no driver needed.

## License
MIT.
