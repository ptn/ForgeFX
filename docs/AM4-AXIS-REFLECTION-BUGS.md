# Device-initiated state changes that don't reflect into Axis

Read-only root-cause of two bugs where a change made **on the hardware** (footswitch /
front panel) is not mirrored in the Axis UI. For each bug: the full live-reflection
path, the exact break point (file:line), the device scope, a verdict (ForgeFX vs Axis),
and a concrete proposed fix.

Repos:
- ForgeFX server: `ForgeFX/server/src`
- Axis (frontend): `Axis/src`

## Live-reflection architecture (shared background)

```
device ──(detection)──▶ ForgeFX DeviceRegistry ──emit(DeviceEvent)──▶ SSE /events ──▶ Axis editor.applyDeviceEvent ──▶ store ──▶ components
```

ForgeFX detects device-initiated changes three different ways, all wired in
`ForgeFX/server/src/drivers/registryCore.ts` and gated by per-driver capabilities:

1. **Telemetry poll (`#pollMeters`)** — gen-3 only (`telemetry.outputMeters`). Also
   hosts the **front-panel scene-change watch** (registryCore.ts:654-664).
2. **Device-edit PUSH (`#startEditPush` / `#onInboundFrame` / `#finalizeBurst`)** —
   gen-3 units that broadcast an unsolicited `0x74/0x75/0x76` burst on a front-panel
   edit (`deviceEditPush` = FM9 / Axe-Fx III / VP4; NOT FM3). Decoded by the driver's
   `decodeEditBurst` (gen3.ts:1052).
3. **Device-edit WATCH poll (`#pollEditWatch`)** — devices that push nothing
   (`deviceEditWatch` = AM4 + FM3). Calls the driver's `readDeviceEditState()`
   (AM4: am4.ts:336; FM3: gen3.ts:1037).

Axis consumes every `DeviceEvent` in one place: `editor.applyDeviceEvent`
(`Axis/src/lib/editor.svelte.ts:988`). Its per-type behavior is the crux of both bugs:

- `case 'scene'` (editor.svelte.ts:991): sets `this.scene = e.index + 1` **only** — the
  scene number badge moves; nothing is re-read.
- `case 'changed'` (editor.svelte.ts:1012-1023): debounced full refresh —
  `await this.load()` (grid + blocks) **and** `await this.#loadParams()` (re-reads the
  open block, including `blockType`, the amp type name). This is the only path that
  re-reads block state.
- `case 'param'` (editor.svelte.ts:995): moves a single knob arc for the open block; does
  not touch type/channel/grid.

Note `#loadParams` (editor.svelte.ts:1266) sets `this.blockType = r.type`, and the
gen-3 `blockParams` reads the block's **active channel** server-side
(gen3.ts:507-539) — so a re-read yields the correct per-channel amp type. The problem in
both bugs is that the re-read is never triggered by the device-initiated change.

---

## Bug 1 — Scene change via the device footswitch does not reflect into Axis

**Symptom:** change scene on the hardware footswitch; Axis keeps showing the old scene
(and the old grid: per-scene bypass/channel/params are wrong).

### Path

device footswitch → scene changes on the unit →
- **gen-3 (FM3/FM9/III):** no unsolicited scene frame. Detected by the **scene-change
  watch** inside `#pollMeters` (registryCore.ts:658-663): every 8th meter tick it does
  `d.getScene()` (fn 0x0C) and, if the index moved, `emit({type:'scene', index})`.
- **AM4:** no scene watch at all (see scope below).

→ SSE `scene` event → Axis `applyDeviceEvent case 'scene'` (editor.svelte.ts:991).

### Break point

`Axis/src/lib/editor.svelte.ts:991`

```
case 'scene': this.scene = e.index + 1; break;
```

The detection + push side works for gen-3 (the watch fires and the event arrives), but
Axis treats `scene` as a pure badge update. A scene switch on a Fractal reselects
**per-scene block bypass, per-scene channel, and per-scene param values** — none of that
is re-read. So even the units where the event *does* arrive show a stale grid and stale
open-block params after a footswitch scene change. The scene NUMBER may update on gen-3;
the rest of the UI does not.

A secondary gen-3 gap: the scene watch lives inside `#pollMeters`, so it only runs on a
**fast link** (`!slow`, registryCore.ts:631) and only for devices with
`telemetry.outputMeters`. On a slow 5-pin-DIN adapter the scene watch is skipped
entirely along with the meters.

### Device scope

- **FM3 / FM9 / Axe-Fx III (gen-3):** scene event is emitted (watch works on a fast
  link) but Axis under-applies it → **grid/params stale** even though the badge follows.
- **AM4:** **no scene event at all.** The AM4 has no `outputMeters` telemetry, so
  `#pollMeters` (and its scene watch) never runs for it (registryCore.ts:605,
  `#activate` gates meters off for non-meter devices at line 514). The AM4 device-edit
  watch (`readDeviceEditState`, am4.ts:336) fingerprints only **placed-block param
  arrays (channel-A quarter)** and the "edited" bit — it does **not** read the active
  scene index (`s.scene` is available at am4.ts:295/779 but unused by the watch). A
  footswitch scene change on the AM4 is invisible to ForgeFX unless it happens to also
  change a hashed param value.
- **VP4 / Axe-Fx II (gen2):** gen-2 emits `scene` on its own setScene path; a
  footswitch scene watch is likewise only in `#pollMeters` — same Axis under-apply.

### Verdict: FIX IN BOTH (Axis primary; ForgeFX for AM4)

The dominant defect is in **Axis**: a `scene` event must trigger a grid + open-block
re-read, not just a badge update. That single fix makes footswitch scene changes reflect
on every gen-3 unit.

A second fix belongs in **ForgeFX** so the AM4 emits a scene event at all.

### Proposed fix

**Axis (primary)** — `editor.svelte.ts:991`. Make `scene` reload like `changed` does
(the state a scene switch changes is exactly the state `load()` + `#loadParams()`
re-read), while still updating the badge immediately:

```ts
case 'scene':
  this.scene = e.index + 1;
  if (this.#eventReload) clearTimeout(this.#eventReload);
  this.#eventReload = setTimeout(async () => {
    await this.load();
    if (this.selKey) await this.#loadParams();
  }, 250);
  break;
```

(Reuse the existing `#eventReload` debounce so a scene sweep coalesces into one refresh.)

**ForgeFX (AM4 coverage)** — give the AM4 a scene watch. Cheapest option: fold the
active scene index into the AM4 device-edit watch. In `am4.ts` `readDeviceEditState`
(am4.ts:336), read `s.scene` (already decoded at am4.ts:295) alongside the edited-bit +
hash and treat a scene delta as `changed` (it will flow through Axis's `changed` reload).
Alternatively add scene tracking to the registry's edit-watch poll for
`deviceEditWatch` devices and `emit({type:'scene'})` there. Note the AM4 exposes
`getScene()` (am4.ts:779), so the registry could poll it generically.

Optional gen-3 hardening: also run the scene watch when meters are throttled/off (slow
link) so a footswitch scene change reflects even without the meter poll — e.g. move the
scene GET onto the edit-watch cadence rather than only the meter cadence.

---

## Bug 2 — Channel change on the amp block does not reflect the amp TYPE NAME change

**Symptom:** switch the amp block's channel (A–D) on the device. Each channel can hold a
different amp model; the device screen shows the new amp name, but Axis keeps the previous
channel's amp type name (`BlockEditor` header `editor.blockType?.name`,
`BlockEditor.svelte:94`).

### Path

device panel/footswitch → amp block active channel changes on the unit →
- **FM9 / Axe-Fx III / VP4 (`deviceEditPush`):** unit broadcasts a `0x74` burst →
  registry `#onInboundFrame` → `#finalizeBurst` → `driver.decodeEditBurst`
  (gen3.ts:1052).
- **FM3 (`deviceEditWatch`):** registry `#pollEditWatch` → `driver.readDeviceEditState`
  (gen3.ts:1037) → re-reads the open block via fn-0x1F, runs the same
  `decodeEditBurst` diff.
- **AM4:** `readDeviceEditState` (am4.ts:336) edited-bit + param fingerprint. (AM4 has
  `channels: false`, am4.ts:185 — no A–D on the amp; N/A.)

→ (intended) `changed` / `param` event → Axis re-reads → new amp type name shown.

### Break point

`ForgeFX/server/src/drivers/gen3.ts:1052-1080` (`decodeEditBurst`), specifically the
active-channel slice at gen3.ts:1064-1065:

```ts
const ch = eid === this.#watchedEid ? Math.min(this.#watchedChannel, chCount - 1) : 0;
const cur = bulk.values.slice(ch * stride, ch * stride + stride);
```

`decodeEditBurst` diffs param **values on a fixed channel** — `#watchedChannel`, the
channel Axis last opened (set in `blockParams`, gen3.ts:511). It:

1. Never reads the block's **current** active channel (`#statusByEffectId()`,
   gen3.ts:386, decodes the active channel from the status byte at gen3.ts:399), so it
   cannot detect that the device switched channels.
2. Slices the **stale** `#watchedChannel`, so when the device moves A→B the burst is
   diffed against the wrong channel — either yielding spurious per-param `param` events
   or (if the values happen to match the old snapshot) nothing.
3. Emits only per-`param` events or a first-sight `reload`; it has no notion of "the
   TYPE selector / active channel changed", so it never emits `changed` and never causes
   Axis to re-read `blockType`.

Even when a `param` event is emitted, Axis's `case 'param'` (editor.svelte.ts:995) only
nudges a knob arc — it never re-reads the amp **type name**. Only a `changed` event
triggers `#loadParams` (editor.svelte.ts:1020), which is what refreshes `blockType`.

Additionally, `setChannel` on the app side emits `changed` (gen3.ts:1109), and Axis's own
`setChannel` calls `#loadParams` (editor.svelte.ts:1351) — so an **in-app** channel
switch works. The bug is strictly the **device-initiated** channel switch, which never
produces a `changed`.

### Device scope

- **FM9 / Axe-Fx III / VP4 (push):** a device-side channel switch is not surfaced as a
  channel/type change — `decodeEditBurst` has no channel-change detection.
- **FM3 (poll):** same `decodeEditBurst` logic → same gap; additionally the FM3 poll
  only watches the block Axis last opened (`#watchedEid`), so a channel change on a
  different block isn't seen at all.
- **AM4:** not applicable — the amp/drive blocks have no A–D channels
  (`channels: false`, am4.ts:185).
- Device-specific: this is a **gen-3-only** defect (FM3/FM9/III), rooted in the shared
  gen-3 driver.

### Verdict: FIX IN FORGEFX (with a small Axis assist)

The reflection chain breaks in ForgeFX's `decodeEditBurst`: it must detect a device-side
active-channel change and emit an event that makes Axis re-read the block (grid channel
pill + `blockType`). Axis already does the right thing on `changed`; it just never
receives one.

### Proposed fix

**ForgeFX (primary)** — teach the gen-3 edit path to detect an active-channel change and
emit `changed`:

1. In `decodeEditBurst` (gen3.ts:1052), before slicing, read the block's current active
   channel via `#statusByEffectId()` (gen3.ts:386). Track the last-seen active channel
   per eid (e.g. extend `#watchedChannel` into a per-eid map, or keep a
   `#lastChannel: Map<eid, ch>`). If the active channel differs from the last-seen value,
   emit a structural change instead of a per-param diff:
   - return `{ events: [], reload: true }` (the registry maps `reload` →
     `emit({type:'changed', scope:'grid'})`, gen3.ts's `readDeviceEditState` +
     registryCore.ts:778), **and**
   - update `#watchedChannel` / the per-eid channel so the next burst diffs the new
     channel cleanly.
   This makes Axis run `load()` + `#loadParams()`, which re-reads the per-channel amp
   type name and refreshes the channel pill.

   For the **push** path (`#finalizeBurst`, registryCore.ts:771), the same `reload` flag
   already routes to `emit({type:'changed', scope:'grid'})` — so returning `reload:true`
   from `decodeEditBurst` covers both push (FM9/III/VP4) and poll (FM3).

2. Because `#statusByEffectId()` is one extra round-trip per burst, gate it to the
   watched/burst block only (the eid already in `bulk.blockId`), not the whole grid.

**Axis (assist / hardening)** — optionally add a dedicated `channel` device event so the
channel pill can update without a full grid reload. Not required if ForgeFX emits
`changed` (the existing `changed` path already re-reads both grid and `blockType`). No
Axis change is strictly necessary for correctness; the `changed` handler already covers
it.

---

## Summary of verdicts

| Bug | Break point | Verdict | Core fix |
|---|---|---|---|
| 1 — footswitch scene change not reflected | `Axis/src/lib/editor.svelte.ts:991` (scene = badge only); AM4 has no scene watch (`registryCore.ts:605/514`, `am4.ts:336`) | **BOTH** — Axis primary, ForgeFX for AM4 | Axis: make `scene` event reload grid + open block (like `changed`). ForgeFX: track AM4 scene index in `readDeviceEditState` so AM4 emits a scene/changed event. |
| 2 — device channel switch doesn't update amp type name | `ForgeFX/server/src/drivers/gen3.ts:1064-1065` (`decodeEditBurst` slices stale `#watchedChannel`, never detects a device-side channel change, never emits `changed`) | **ForgeFX** (Axis already handles `changed`) | ForgeFX: in `decodeEditBurst`, read the block's current active channel via `#statusByEffectId()`; on a channel delta return `reload:true` → `emit({changed})`, so Axis re-reads per-channel `blockType`. Gen-3 only (AM4 amp has no channels). |
