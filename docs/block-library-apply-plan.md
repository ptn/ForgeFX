# Plan: fast "apply saved block" (bulk EFFECT_DUMP write)

## Goal

Replace the ~10s per-param apply (one `setChannel`/`setType`/`setParam` round-trip
per param, each discrete write waiting a 120ms reject window) with a single
`0x74/0x75/0x76` EFFECT_DUMP burst — the same burst FM3-Edit emits to apply a
saved `.blk` block, and the same burst the `.blk` file already stores.

## Branch bases (locked)

- **forgefx-midi**: branch off `feature/blk-file-decode` (read side `blockFile.ts` lives only there).
- **ForgeFX/server**: work on `feature/block-library` (no new branch).
- **Axis**: branch off `all`, apply `stash@{0}` (`wire up block library`) first.

ForgeFX consumes forgefx-midi via `file:../../forgefx-midi`, so the
forgefx-midi branch's built `dist/` is what the server loads at runtime.

## Wire format (key finding — ground-truth from two `.blk` fixtures)

The `0x75` DATA frame's bytes 6–7 are **not** `sectionId`+`flag` — they are a
**14-bit value-count** for that section (`encode14(pageLen)`), paged every 256
values. Proven:

- FM3 Drive RAT `.blk` (itemCount 160, one section): `…75 20 01 21…` → `encode14(160) = [0x20,0x01]` ✓
- Axe-Fx III Delay DD2 `.blk` (itemCount 336): sec0 `…75 00 02…` (256) + sec1 `…75 50 00…` (80) → `encode14(256)=[0x00,0x02]`, `encode14(80)=[0x50,0x00]` ✓

Canonical write burst (same envelope `F0 00 01 74 <model> <fn> <payload> <cs> F7`,
XOR-0x7F checksum):

```
head = F0 00 01 74 <model> 74 encode14(blockId) encode14(itemCount) cs F7     (12 B, NO flag byte)
body = F0 00 01 74 <model> 75 encode14(pageLen) [pageLen × packValue16(3B)] cs F7   (pageLen ≤ 256)
end  = F0 00 01 74 <model> 76 cs F7
```

Values are channel-blocked (`index = channel × stride + paramId`);
`packValue16`/`encode14` come from `shared/septet16.ts` (already re-exported in
`setParam.ts`). `assembleGen3BlockBulkRead` is the exact inverse (it concatenates
`0x75` bodies and ignores bytes 6–7, which is why the read path already works).
`simResponders.ts#buildBroadcastBurst` uses `[0x00,0x00]` for that field (latent,
harmless for reads — the codec ignores it); the new builder must emit
`encode14(pageLen)`.

## Step 1 — forgefx-midi: write builder

`src/gen3/axe-fx-iii/setParam.ts` (next to `assembleGen3BlockBulkRead`, ~line 846):

- Add `FN_BROADCAST_HEAD = 0x74`, `FN_BROADCAST_BODY = 0x75`, `FN_BROADCAST_END = 0x76`.
- Add type `Gen3BlockBulkWrite { blockId: number; itemCount: number; values: number[] }`.
- Add `buildGen3BlockBulkWrite(modelByte, spec): number[][]` — validate
  `values.length === itemCount`; emit head + paged bodies (256/frame,
  `encode14(pageLen)`) + end.
- Add `buildGen3BlockBulkWrite` to the `ModernFractalCodec` interface (near line
  2364) and bind it in `createModernFractalCodec` (~line 2436):
  `buildGen3BlockBulkWrite: (s) => buildGen3BlockBulkWrite(s, modelByte)`.

`src/gen3/axe-fx-iii/index.ts`: export `buildGen3BlockBulkWrite` +
`Gen3BlockBulkWrite` type.

Tests (`test/gen3/`):

- Round-trip: `assembleGen3BlockBulkRead(buildGen3BlockBulkWrite(m, spec)).values`
  deep-equals `spec.values`.
- Byte-golden vs fixtures: rebuild the FM3 Drive RAT (single section) and
  Axe-Fx III Delay DD2 (multi-section paging) bursts and diff byte-for-byte
  against the frames in `test/gen3/fm3/fixtures/blockfile/*.blk` and
  `test/gen3/modern-family/fixtures/blockfile-axe3-delay-dd2.blk`. This pins
  `encode14(pageLen)` + paging.

## Step 2 — ForgeFX server

`src/drivers/gen3.ts`:

- Add `applyBlock(eid, block: { itemCount: number; values: number[] }, activeChannel: number)`:
  - `const burst = this.#codec.buildGen3BlockBulkWrite(this.#prof.model, { blockId: eid, itemCount, values })`
  - flatten frames to one byte array; send
    `dev.sendPaced ? await dev.sendPaced(bytes) : await dev.sendQueued(bytes)`
    (mirror `loadPresetBytes`, ~line 1370).
  - `await this.setChannel(eid, String.fromCharCode(65 + activeChannel))` to restore the saved active channel.
  - clear `#gridCache`, set `#lastLocalEditAt = Date.now()`, emit
    `changed{scope:'grid'}`, return `{ ok: true }`.

`src/drivers/types.ts`: add
`applyBlock?(eid: number, block: { itemCount: number; values: number[] }, activeChannel: number): Promise<{ ok: boolean }>`
to `DeviceDriver` (near `loadPresetBytes`, ~line 263).

`src/runtime/handlers.ts` (`applySavedBlockH`, ~line 99):

- Replace the `SavedBlock` interface with
  `{ device: string; slug: string; activeChannel: number; itemCount: number; values: number[] }`;
  validate device/slug/activeChannel (`0..3`) + `Array.isArray(values)` &&
  `values.length === itemCount` && every value `Number.isInteger` in `0..65534`.
- Keep `d.name !== saved.device` → 422, slug/family mismatch → 422, target
  lookup via `placedBlocks` → 404.
- Gate `d.applyBlock` → 501 `unsupported`; call it and return
  `{ ok: true, channels: <derive or omit>, params: itemCount, activeChannel }`.

`src/services/blockLibraryImport.ts`: `decodeBlockFile` also returns `blockId`,
`itemCount`, `values` from `parseGen3BlockFile` (already available — no
blockFile.ts change needed).

## Step 3 — Axis (from `stash@{0}`)

`src/lib/types.ts`: extend `DecodedBlockFile` with
`blockId: number; itemCount: number; values: number[]`.

`src/lib/blockLibraryApply.ts`: `blockLibraryApplyPayload(block)` returns
`{ device, slug, activeChannel, itemCount, values }` (drop the per-channel
`params` mapping).

## Step 4 — Tests

`ForgeFX/server/test/api/block-apply.test.ts`: rewrite for the new contract —
mock driver records `applyBlock(eid, block, activeChannel)`; keep 422
device-mismatch + family-mismatch (no writes), keep 404 block-not-found;
replace the per-param partial-failure case with `applyBlock` throwing → 409.
Update `BLOCK_APPLY_CASE_COUNT`.

## Step 5 — Docs

- `forgefx-midi/src/gen3/axe-fx-iii/setParam.ts` header — flip the "read-only…
  emits nothing" note to document `buildGen3BlockBulkWrite`.
- `ForgeFX/docs/write-protocol.md` — add a "Apply saved block (bulk)" row
  (`0x74/0x75/0x76`, head `blockId=target eid`, `encode14(pageLen)` bodies,
  paged 256/frame).

mcp-midi-control is out of scope.

## Locked decisions

- Replace the per-param loop entirely (no fallback); non-gen3 → 501.
- Same-instance apply; slug (family) is the only compatibility check; burst
  head `blockId` = target `eid`; no value remap.
- Rejection detection best-effort (burst fire-and-forget, mirroring
  `loadPresetBytes`).
