# ADR 0002 — Frontend stack: SvelteKit + TypeScript

Status: accepted · 2026-06-26

## Context
ForgeFX needs a web UI: an editor (grid, block params, knobs) and a live controller
(scenes, tuner, meters), served off a Raspberry Pi for stage use and on a PC for daily use.
The UI is a real-time control surface — many widgets updating at 10–30 Hz from the WebSocket
(ADR 0001).

## Decision
Use **SvelteKit (with `adapter-static`) + TypeScript**.

### Why Svelte over React
- **Fine-grained compiled reactivity** (Svelte 5 runes) updates the exact DOM node — ideal
  for many high-frequency widgets (meters, knobs, tuner) without virtual-DOM re-render churn.
- **Tiny bundles** — matters when served off a Pi and loaded on a phone backstage.
- **Reactive stores** map cleanly onto the WS event stream (`paramChanged`, `tuner`, …) → UI
  updates fall out automatically.
- Less boilerplate; native two-way `bind:` fits knob ↔ value.

### Trade-off (honest)
React has a larger ecosystem and contributor pool. If ForgeFX attracts a React-heavy crowd,
that's the cost. We judge product quality + the real-time use-case to outweigh it.

## Deployment
Separate repo (`ForgeFX-Web`). `adapter-static` builds plain static files that
`ForgeFX.Server` can host directly → one self-contained binary serves API + UI. No SSR
(it's a client to a local device API). Talks to the server over REST + `/ws`.
