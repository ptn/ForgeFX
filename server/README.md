# ForgeFX server (Node)

Open HTTP API for Fractal devices. Wire protocol via [`fractal-midi`](https://www.npmjs.com/package/fractal-midi);
catalog/rosters/params from the repo's `definitions/`. Replaces the retired C# server,
keeping the same REST contract so [Axis](https://github.com/sKuhLight/Axis) is unchanged.

## Run

Use Node 20 (`.nvmrc` / `engines.node` pin it) — newer majors have been observed to make
serial-heavy flows like the preset cache rebuild an order of magnitude slower for reasons
unrelated to this server's code. This also matches the Node version Electron bundles in
the packaged Axis app, which hosts this server in-process.

```bash
cd server
npm install          # native serialport + fractal-midi
npm run dev          # tsx watch, http://localhost:5056
# or: npm run build && npm start
```

Stop the MIDI bridge / any other client first — ForgeFX owns the FM3 serial
(`/dev/serial/by-id/...FM3-if03`, auto-detected; override with the device path).
Axis's Vite proxy already points `/api` → `:5056`, so no Axis change is needed.

## Endpoints

`GET /healthz · /device · /preset · /preset/grid · /preset/blocks · /blocks · /blocks/:slug/types`
`GET/PUT /preset/blocks/:slug/params[/:param] · POST .../bypass|channel`
`PUT /preset/grid/cell · POST /preset/grid/cable · /preset/select · /preset/store`

## Notes

- **Grid read** uses the hardware-validated dump→Huffman→grid decoder (`src/codec/fm3PresetGrid.ts`,
  verified against the `.syx` fixtures). The lighter live `sub=0x2E` read is a future optimization
  (`src/probes/grid-read.ts` — FM3 format still being calibrated for an upstream contribution).
- **Writes** go through fractal-midi builders and watch for a `0x64` rejection.
- Param read scaling is best-effort (norm ≈ raw/65535) pending per-param ranges.

## Credits

Codec: `fractal-midi` (Apache-2.0, Stephen Staker). Grid decoder ported from ForgeFX's own
validated implementation, itself from the Apache-2.0 reference in mcp-midi-control. See `../NOTICE`.
