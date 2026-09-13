# ADR 0001 — Real-time transport: SSE + REST (not WebSocket)

Status: accepted · 2026-06-26 · revised 2026-09-13

## Context
ForgeFX is an **open** platform/SDK for Fractal devices. The frontend (and third-party
clients) need:
- one-off request/response (read firmware, list/load presets, bulk block dump),
- low-latency interactive editing (knob drags fire many updates/sec),
- server→client push (tuner, tempo, meters from the `0x64` stream; *external* changes when
  someone edits on the unit itself; preset-switched events).

## Decision
Use **REST for all request/response ops and Server-Sent Events (SSE) for the server→client
event channel.** No WebSocket, no SignalR.

| Channel | Use |
|---------|-----|
| **REST** `/firmware`, `/presets`, `/preset`, `/dump/{page}`, … | stateless, cacheable, curl-able — including all writes |
| **SSE** `/events` | server→client events only (tuner, tempo, scene, cpu, meters, config, cache) |

### Why SSE over WebSocket
Events here flow in one direction only (device → server → UI); interactive editing rides the
existing REST calls, so there is no need for a bidirectional socket. SSE is plain HTTP: it
works through proxies, needs no framing/handshake library, reconnects natively via
`EventSource`, and keeps the whole contract inspectable with `curl`. Event payloads are the
same JSON envelopes the REST responses use (`DeviceEvent`), so a client only learns one shape.
The one thing SSE lacks — client→server messages — is exactly what REST already covers.

### Why not SignalR
SignalR is great for .NET/JS clients (auto-reconnect, hubs, streaming) but speaks an
MS-specific hub protocol. ForgeFX is meant to be driven from *any* language (Python, Rust,
Go, hardware controllers, Max/MSP…); plain HTTP + SSE is universal and keeps the protocol part
of the open spec.

## Protocol sketch (documented JSON envelope)
```json
// REST (client → server): reads and writes are ordinary HTTP requests
GET  /preset/blocks/58/params
PUT  /preset/blocks/58/params/level   { "norm": 0.699 }

// SSE (server → client): one event per `data:` frame on /events
data: { "type": "paramChanged", "block": "Cab", "param": "Low Cut", "value": 100, "unit": "Hz" }
data: { "type": "tuner", "note": "E", "cents": -3 }
data: { "type": "scene", "index": 3 }
```

## Client requirements
- treat REST as the source of truth for snapshots, SSE for deltas/streams,
- let `EventSource` handle reconnect (with an application-level backoff for a Pi on wifi
  during a gig); the server sends a `: hb` comment every 15 s so an idle stream stays open.

## Implementation note
Fastify `GET /events` writes `text/event-stream` and fans out `registry.subscribe(...)`
(see `src/app.ts`). The browser runtime exposes the same route over its own router. Keep
DTOs/JSON stable as the public contract.
