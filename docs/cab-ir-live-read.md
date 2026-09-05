# FM3 Cab IR Live Read — Reverse-Engineering Handoff

Status: **FM3 USER protocol implemented from live captures (model 0x11).**

---

## TL;DR

The cab picker can't show the user's real **USER** cabs and shows **512 phantom
SCRATCHPAD** entries because ForgeFX only serves *bundled static* IR-name tables,
and those static tables are wrong for the per-device banks. The missing piece —
reading USER/SCRATCHPAD names from the device — is a single SysEx frame that has
now been reverse-engineered and verified. Implementing it is a small codec +
driver change; all the HTTP/UI plumbing already exists.

---

## Problem

1. Axis's cab picker shows **250 of 512** entries under SCRATCHPAD (capped by
   `CAP = 250` in `CabPicker.svelte`), but the FM3's scratchpad is **16 slots**.
2. Axis shows **no USER cabs** at all, even though the device has them.
3. The static data wrongly makes it look like III-sized content is on an FM3.

## Root cause

Factory cab names are **bundled static tables** (`forgefx-midi` generated files),
not read from the device:

- `FM3_CAB_IRS["SCRATCHPAD"]` ships **512 entries** (mined from the FM3 editor's
  own `effectDefinitions_*.cache`, whose `0xfff3` table record is III-sized).
- `FM3_CAB_IRS` has **no `USER` key** — USER is per-device and was never shipped.
- The gen3 driver's live-read hook `#liveCabIrs()` returns `{}` (stub), so the
  device's real USER/SCRATCHPAD names are never fetched.

The cab/IR name tables (`id 0xfff0..0xfffe`) are **not param-addressable** via
the self-describe walk (`liveWalk.ts` excludes them; their `wireIds` are the
unmapped sentinel `255`). So there was no existing frame to read them — which is
why `#liveCabIrs()` was stubbed.

## Data flow (existing)

```
forgefx-midi (FM3_CAB_IRS / FM9_CAB_IRS / AXE3_CAB_IRS  — generated, static)
   └─ ForgeFX devices.ts  DeviceProfile.cabIrs()            (598/615/632)
         └─ runtimeProfileFrom() overlays built.cabIrs     (717-719)
               └─ gen3.ts  cabIrs(refresh) → #liveCabIrs() (1002-1015, stub)
                     └─ GET /cab/irs (?refresh=1)          (app.ts:610, router.ts:172)
                           └─ Axis forgefx.ts:492 cabIrs()
                                 └─ cabIrsCache.ts  (IndexedDB, cab.irs.v1:<model>)
                                       └─ CabPicker.svelte  (renders irs[bank])
```

The only thing missing is the body of `#liveCabIrs()`.

---

## Reverse-engineered protocol (verified on live FM3)

### Read frame — `fn=0x01 sub=0x4b`

Byte layout (23 bytes):

| bytes | meaning |
|---|---|
| 0–3 | `F0 00 01 74` |
| 4 | `model` (`0x11` = FM3) |
| 5 | `01` (fn) |
| 6 | `4B` (sub) |
| 7 | `00` |
| 8–11 | `00 00 00 00` |
| 12 | **`index`** = low 7 bits of the flat IR index |
| 13 | **`selector`** = high 7 bits of the flat IR index |
| 14–20 | `00` × 7 |
| 21 | checksum = XOR of bytes `[0..20]`, `& 0x7f` |
| 22 | `F7` |

**flat index = `(selector << 7) | index`** (14-bit space).

Verified example — reading block-name table index 0 (selector 0x20), from a real
FM3-Edit capture:

```
f0 00 01 74 11 01 4b 00 00 00 00 00 00 20 00 00 00 00 00 00 00 7e f7
```

(`0x7e` = XOR of the preceding 21 bytes `& 0x7f` — matches.)

### Reply frame

Byte layout (a full-name reply is 60 bytes):

| bytes | meaning |
|---|---|
| 0–4 | `F0 00 01 74` + `model` |
| 5 | `01` (fn) |
| 6 | `4B` (sub) |
| 7 | `00` |
| 8–11 | `00 00 00 00` (eid/pid) |
| 12–16 | value (5 bytes, `01 00 00 00 00`) |
| 17–18 | `00 00` |
| **19–20** | **`tc`** = name byte length: `(b[19]&0x7f) \| ((b[20]&0x7f)<<7)` (32 for a full name) |
| **21 .. n-2** | **name** — 8-to-7 packed, NUL-terminated |
| n-2 | checksum |
| n-1 | `F7` |

- The 32-byte name buffer is **not cleared** between reads — stale bytes follow
  the NUL, so **truncate at the first `0x00`**.

### Name packing/decoding (proven)

The probe used `unpackValueChunked` (below). The codec's `decodeSeptetStream`
in `liveWalk.ts` is the canonical MSB-first 8→7 decoder and should be used in
the implementation. Equivalent for ASCII names; reconcile once during impl.

```ts
function unpackChunked(wire: readonly number[], rawLen: number): Uint8Array {
  const out = new Uint8Array(rawLen); let rawPos = 0, wirePos = 0;
  while (rawPos < rawLen) {
    const remainingRaw = rawLen - rawPos;
    const thisChunkRaw = Math.min(7, remainingRaw);
    const thisChunkWire = thisChunkRaw === 7 ? 8 : thisChunkRaw + 1;
    const chunk = wire.slice(wirePos, wirePos + thisChunkWire);
    for (let i = 0; i < chunk.length; i++) {
      const k = i + 1, b = chunk[i] & 0x7f;
      if (i > 0 && i - 1 < thisChunkRaw) out[rawPos + i - 1] |= ((~(0x7f >> k) & b) >> (8 - k)) & 0xff;
      if (i < thisChunkRaw) out[rawPos + i] = (b << k) & 0xff;
    }
    rawPos += thisChunkRaw; wirePos += thisChunkWire;
  }
  return out;
}
// then: build string, stop at first 0x00, filter 0x20..0x7e.
```

---

## FM3 bank layout (confirmed against a live device)

The flat 14-bit index space, by sweeping `sub=0x4b`:

| Bank | flat offset | size | selector range | source for fix |
|---|---|---|---|---|
| FACTORY 1 | 0 | 1024 | 0x00–0x07 | **static** (correct) |
| FACTORY 2 | 1024 | 1024 | 0x08–0x0f | **static** (correct) |
| USER | **2048** | **512** | **0x10–0x13** | **live read** |
| LEGACY | 3072 | 189 | 0x18 (idx 0–60) + 0x19 (idx 0–60) | **static** (correct) |
| SCRATCHPAD | **3261** | **16** | 0x19 idx 61–76 | **live read** |

Notes:

- `selector 0x20` = the **block name table** (grid slot names: "Cabinet",
  "Volume 1", …). Not IR names.
- `selector 0x40+` = binary/non-name data — do not read as names.
- The connected FM3's USER bank reads: `2048="TDR Vox mix"`, `2049="Morgan AC20
  crisp"`, `2050="Morgan AC20 1x12 brighter"`, and per the owner, slots 1–8
  (flat 2048–2055) are all populated. SCRATCHPAD is empty on this unit.
- Confirmed anchors: FACTORY 1 idx 0 = "1x4 Pig 57"; FACTORY 2 idx 0 =
  "2x12 Double Verb 906 Cone" (flat 1024); LEGACY idx 0 = "1x6 OVAL" (flat
  3072); LEGACY last = "4x12 G12M CREAMBACK MIX (CEL)" (flat 3260).

---

## Evidence & tooling

Repos live in the workspace: `Axis/` (UI), `ForgeFX/` (Fastify :5056), `forgefx-midi/` (protocol).

### New/uncommitted artifacts

- `ForgeFX/server/src/probes/cab-ir-selector-sweep.ts` — the live sweep probe
  (opens `FractalSerial` directly; `buildRead()` + `nameOf()` proven working).
- `ForgeFX/server/scripts/capture-fm3-edit-all.js` — frida hook of FM3-Edit
  `write()`/`read()`, dumps all SysEx both directions.
- `ForgeFX/server/scripts/capture-fm3-edit.js` — frida, write-class frames only.
- `ForgeFX/server/scripts/sweep-cab-ir-selector.js` — frida, injects `sub=0x4b`
  via FM3-Edit's own midi fd (older, pre-probe approach).

### Running the probe

```
cd ForgeFX/server
# ForgeFX must be STOPPED (it owns the port):
#   pkill -f "tsx watch src/index.ts"
FORGEFX_SERIAL=/dev/cu.usbmodem14304 npx tsx src/probes/cab-ir-selector-sweep.ts
```

Device node (macOS): `/dev/cu.usbmodem14304` (auto-detect doesn't find it; the
constructor's `autoDetectPath()` only checks `/dev/serial/by-id` + `/dev/ttyACM0`).

### Capturing FM3-Edit (for future RE)

1. FM3-Edit has **Hardened Runtime** (`flags=0x10000(runtime)`), so frida can't
   attach to `/Applications/FM3-Edit.app` without root. A **re-signed debug copy**
   already exists at `/tmp/FM3-Edit-debug.app` (entitlements in
   `/tmp/fm3edit-entitlements.plist`: `get-task-allow`, `disable-library-validation`,
   `allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`).
2. Launch that copy; attach: `frida -l server/scripts/capture-fm3-edit-all.js -n "FM3-Edit"`.

### Environment facts

- FM3 = model `0x11`, serial `/dev/cu.usbmodem14304`.
- ForgeFX dev: `npm run dev` in `ForgeFX/server` (tsx watch) on `:5056`.
- Axis → ForgeFX via `/api`; `VITE_FORGEFX_BASE` default.
- frida `17.17.0` at `~/.local/bin/frida`.

---

## Open questions

1. **Bulk dump?** FM3-Edit reads the USER bank as 512 single-name `sub=0x4b` requests. gen2 had
   `CAB_BANK_DUMP (0x44)`; gen3's "large value dump" view (`0x2e`, used for the
   whole grid in one frame) was **not** tested against cab name tables. If a
   bulk path exists, it replaces the 1024-serial-read worst case.
2. **SCRATCHPAD offset** — not directly
   confirmed (empty on this unit, indistinguishable from empty space). 16-slot
   size from the FM3 spec/owner.
3. **FM9 / Axe-Fx III layouts** — NOT probed. Their USER/SCRATCHPAD offsets and
   sizes differ (III has 4 user banks + 512-slot scratchpad). Same `sub=0x4b`
   frame should work; offsets must be derived per model.
4. **Name packing** — the proven chunked 8→7 codec is now used; keep it covered by
   the captured-name regression fixture.

---

## Fix plan

### 1. `forgefx-midi` — codec (gen3)

Add to the shared gen3 codec (FM3/FM9/III share it):

- `buildCabIrNameRead(model: number, flatIndex: number): number[]` — encodes the
  `sub=0x4b` frame (`selector = flatIndex >> 7`, `index = flatIndex & 0x7f`,
  XOR checksum).
- `parseCabIrNameResponse(frame): string | null` — reads `tc` at 19..20,
  decodes the NUL-terminated name at 21.. via `decodeSeptetStream`.

### 2. `ForgeFX` — driver

- `gen3.ts` `#liveCabIrs()`: read **USER** (flat 2048, size per-model) +
  **SCRATCHPAD** (flat 3261, 16) via the codec, **early-terminate** on a run of
  empty names (sparse banks finish in ~40 reads), merge over the static
  FACTORY 1/2/LEGACY. Return `{ USER: [...], SCRATCHPAD: [...] }`.
- Per-model bank offsets (USER start, USER size, SCRATCHPAD start, size) belong
  in `devices.ts` profiles (or a small per-model table), NOT hardcoded in the
  driver.

### 3. `ForgeFX` — static data fix

- Remove/trim the FM3 `SCRATCHPAD` table so the phantom 512 entries stop being
  served. Regenerate `FM3_CAB_IRS` without `0xfff3` (generator is external), or
  drop it at load. Same class of fix FM9/III already ship (they have
  `SCRATCHPAD: 0`).

### 4. Already wired (no change)

- `GET /cab/irs?refresh=1` → `driver.cabIrs(true)` → `#liveCabIrs()`.
- Axis `refreshCabIrsCache()` (called on preset import when `caps.cabIrs`) and
  `loadCabIrsCachedFirst()` (cached-first on picker open) just start returning
  real data once the driver does.

### Where it should run

The user's strong steer (and the right call): read USER/SCRATCHPAD **once at
device connect** (alongside the existing self-describe cache build in
`deviceCache.ts`), cache it, and only re-read on explicit refresh — not on every
picker open. The current `#liveCabIrs()` stub is called via `?refresh=1`; the
implementation should be cachable so the connect-time build can prime it.

---

## File map (key locations)

| Concern | File |
|---|---|
| Static FM3 cab IR table | `forgefx-midi/src/gen3/fm3/cabIrs.generated.ts` |
| Static FM9 / III tables | `forgefx-midi/src/gen3/{fm9,axe-fx-iii}/cabIrs.generated.ts` |
| Cache table grammar (`tableTail` 0xfff0..0xfffe) | `forgefx-midi/src/cache/records.ts` |
| Cache build, excludes USER/SCRATCHPAD | `forgefx-midi/src/cache/assign.ts` (`CAB_BANK_IDS` at 128) |
| Self-describe walk (excludes 0xff00+) | `forgefx-midi/src/cache/liveWalk.ts` |
| Self-describe reply decode / `decodeSeptetStream` | `forgefx-midi/src/cache/liveWalk.ts` |
| Driver profile `cabIrs()` per model | `ForgeFX/server/src/devices.ts` (598 / 615 / 632) |
| Runtime profile overlay | `ForgeFX/server/src/devices.ts` (717-719) |
| **Driver `#liveCabIrs()` stub → implement here** | `ForgeFX/server/src/drivers/gen3.ts` (1002-1015) |
| `GET /cab/irs` | `ForgeFX/server/src/app.ts` (610) / `runtime/router.ts` (172) |
| On-connect cache build (prime point) | `ForgeFX/server/src/services/deviceCache.ts` |
| Axis HTTP client | `Axis/src/lib/forgefx.ts` (492) |
| Axis cab IR cache | `Axis/src/lib/cabIrsCache.ts` |
| Picker UI (`CAP=250`, `irs[bank]`) | `Axis/src/lib/CabPicker.svelte` |
| Refresh trigger | `Axis/src/lib/library.svelte.ts` (287) |

---

## Prior art worth keeping in mind

- gen2 (Axe-Fx II) opcode table has `CAB_BANK_DUMP (0x44)`, `SET_CAB_NAME
  (0x2d)`, `DELETE_CABIR (0x41)` — a likely analogue for any gen3 bulk-dump hunt.
- `registryCore.ts:798` references `fm3-scratchpad findings/live-capture-2026-07.md`
  which does not exist in the repo — this doc is the natural replacement for it.
