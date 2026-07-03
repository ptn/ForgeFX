# Device test checklist (driver-migration builds)

This build migrates ForgeFX to a per-device driver architecture on the `forgefx-midi`
codec package and a unified, capabilities-driven HTTP API (v2). The FM3 path was
regression-verified against live hardware at every step; **AM4, FM9, and Axe-Fx III
need hands-on verification** of the flows below. Everything listed is expected to
work — anything that doesn't is a bug in the migration, please report it.

## How to report

- Note the device, firmware version, and the exact step that failed.
- `GET http://localhost:5056/diag` returns a connection diagnostic **plus the
  deprecated-alias hit counter** — include it in reports. A non-zero `/am4/*` alias
  count with this UI build is itself a bug (the UI should only use unified routes).
- The in-app debug report (telemetry upload) bundles the server log + diag.

## Every device — connection & identity

- [ ] Auto-detect finds the unit (USB): correct model name shows in the connection bar.
- [ ] `Connection & Device` manual override works, and clearing it returns to auto.
- [ ] Reconnect after unplugging/replugging the USB cable recovers without a restart.
- [ ] (Windows, Axe-Fx III/FM9) detection works over USB-MIDI — this was the
      long-standing "device offline" bug; it is fixed and regression-tested, verify once.

## FM3 (regression baseline — spot-check only)

- [ ] Grid loads and matches the front panel; place/move/clear a block; draw/remove a cable.
- [ ] Open amp block: knob drag is audible, values match FM3-Edit; bypass/channel/type switch.
- [ ] Scenes: switch, rename; preset: select, rename, save to slot.
- [ ] Tuner streams; tempo set/tap; output meters + CPU move.
- [ ] FC editor (Footswitches): live per-switch view still works (tap/hold, labels, colors).
- [ ] Backup preset → version history → load (audition) → restore to slot.
- [ ] Library deep scan + search still works.

## FM9

- [ ] All of: grid load/edit, block params read/write, bypass/channel/type, scenes,
      preset select/save, tempo/tap, tuner, meters/CPU (same expectations as FM3).
- [ ] **NEW — FC editor**: opens with a Layout (1–8 + Master) × 12-switch grid.
      *No* live read-back (writes are "blind"): set a **tap category** on a spare
      layout's switch, then confirm on the unit's own FC setup screen that it landed
      on the right switch. Please test at least: category, function number, display
      mode, and one params value. If the category names in the dropdown don't match
      what the unit shows, report the mismatch pairs — the ordinal vocabulary is
      FM3-verified and assumed shared; FM9 confirmation is exactly what we need.
- [ ] Modifier flyout on a knob: model loads, bind works, curve edits apply.

## Axe-Fx III

- [ ] Same core flows as FM9 (grid, params, scenes, presets, tempo, tuner, meters).
- [ ] **NEW — FC editor (flat mode)**: a config number picker (0–107) instead of a
      layout grid (the III's layout decomposition isn't decoded yet). Pick a config,
      write a tap category ordinal, and check which physical switch/layout it lands
      on — please note the mapping you observe (config № → layout/switch), that data
      lets us build the full grid UI later.
- [ ] Larger grid (6×14) renders and edits correctly; 280+ amp models list in the type picker.

## AM4

Everything now runs through the same unified routes as the other devices (the old
AM4-only paths remain as a fallback but should be untouched by this build).

- [ ] 4-slot chain renders; block tiles show correct names/types.
- [ ] Knob drag writes params (continuous + stepped); bypass toggles.
- [ ] Scene switch (1–4); preset load + save shows **bank codes (A01…Z04)** in the
      save dialog and toasts.
- [ ] Library: preset name scan builds the list (104 locations, no deep scan).
- [ ] **Device Tools** (toolbar): backup preset → downloads a `.syx`; restore a `.syx`;
      offline decode of a `.syx` (single dump and full bank); firmware file validation;
      modifier model view (read-only — binding is not wired for AM4 yet, by design).
- [ ] Confirm NO meters/tuner/tempo UI appears (the device doesn't support them —
      their absence is correct, their presence is a bug).

## Cross-checks (nice to have)

- [ ] Remote control (Axis Cloud): live param edits + scene/preset changes relay;
      saving to a slot is (correctly) refused remotely.
- [ ] Two windows on one host stay in sync (SSE) for scene/tempo/grid changes.
