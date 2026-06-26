# ADR 0001 — Real-time transport: WebSockets + REST (not SignalR)

Status: accepted · 2026-06-26

## Context
ForgeFX is an **open** platform/SDK for Fractal devices. The frontend (and third-party
clients) need:
- one-off request/response (read firmware, list/load presets, bulk block dump),
- low-latency interactive editing (knob drags fire many updates/sec),
- server→client push (tuner, tempo, meters from the `0x64` stream; *external* changes when
  someone edits on the unit itself; preset-switched events).

## Decision
Use **raw WebSockets for the interactive/event channel and REST for stateless ops.** Do not
use SignalR.

| Channel | Use |
|---------|-----|
| **REST** `/firmware`, `/presets`, `/preset`, `/dump/{page}` | stateless, cacheable, curl-able |
| **WebSocket** `/ws` | live param get/set + server→client events |

### Why not SignalR
SignalR is great for .NET/JS clients (auto-reconnect, hubs, streaming) but speaks an
MS-specific hub protocol. ForgeFX is meant to be driven from *any* language (Python, Rust,
Go, hardware controllers, Max/MSP…); raw WebSockets is universal and the protocol becomes
part of the open spec. The main thing SignalR gives us for free — reconnect/heartbeat — is
~30 lines in a client wrapper, worth it to keep interop. (If ForgeFX ever becomes .NET/JS-only
and wants batteries-included, SignalR is a drop-in on the ASP.NET side.)

## Protocol sketch (documented JSON envelope)
```json
// client → server
{ "type": "setParam", "effect": 82, "addr": [0,62,0,62,0], "value": 0.699 }
{ "type": "subscribe", "streams": ["tuner","meters"] }

// server → client
{ "type": "paramChanged", "block": "Cab", "param": "Low Cut", "value": 100, "unit": "Hz" }
{ "type": "tuner", "note": "E", "cents": -3 }
{ "type": "presetChanged", "n": 430, "name": "DEBUG" }
```

## Client requirements
- reconnect with backoff + ping/pong heartbeat (important for a Pi on wifi during a gig),
- treat REST as the source of truth for snapshots, WS for deltas/streams.

## Implementation note
ASP.NET Core `app.UseWebSockets()` + a `/ws` endpoint. Build the `/ws` stub when the frontend
phase starts. Keep DTOs/JSON stable as the public contract.
