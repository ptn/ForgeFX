# ForgeFX server (Node)

Open HTTP API for Fractal devices. Wire protocol via the bundled `forgefx-midi` package
(Apache-2.0); catalog/rosters/params from the repo's `definitions/`. The REST contract is
consumed by [Axis](https://github.com/sKuhLight/Axis) and the server's own browser runtime.

## Run

Use Node 20 (`.nvmrc` / `engines.node` pin it) — newer majors have been observed to make
serial-heavy flows like the preset cache rebuild an order of magnitude slower for reasons
unrelated to this server's code. This also matches the Node version Electron bundles in
the packaged Axis app, which hosts this server in-process.

```bash
cd server
npm install          # native serialport + @julusian/midi; forgefx-midi linked as a workspace package
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

- **Grid read** uses the hardware-validated dump→Huffman→grid decoder in the `forgefx-midi`
  package (`src/core/**`, `src/gen3/**`), verified against the `.syx` fixtures. The lighter live
  `sub=0x2E` read is a future optimization (`src/probes/grid-read.ts` — FM3 format still being
  calibrated for an upstream contribution).
- **Writes** go through `forgefx-midi` builders and watch for a `0x64` rejection.
- Param read scaling is best-effort (norm ≈ raw/65535) pending per-param ranges.

## Credits

Codec and device descriptors: the `forgefx-midi` package (Apache-2.0, Stephen Staker), itself
derived from the Apache-2.0 references in mcp-midi-control and fractal-syx-codec. See `../NOTICE`.
