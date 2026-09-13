# ForgeFX Refactor — Handoff (switching to model v4.1)

Date: 2026-09-13
Repo: `/Users/pablo/code/Axis/ForgeFX` · branch: `mine`
Companion doc: `docs/refactor-plan.md` (the full plan; this doc is the *state*).

This document lets a fresh session (or a different model) resume exactly where we stopped.
**All work so far is uncommitted.** Nothing has been committed or pushed.

---

## 0. TL;DR status

| Phase | Scope | Status |
|---|---|---|
| A | Safety net (test typecheck, golden route suite, collapse fixtures) | ✅ done |
| B | Correctness & security B1–B13 | ✅ done, except **B3 deferred** (your call) and **B7 partial** |
| C | Modularization | 🟡 in progress — C2 partially done |
| D | Testing & tooling | ⬜ not started |
| E | Docs / NOTICE | ⬜ not started |

Verification at this checkpoint: `npm run typecheck`, `npm run typecheck:test`, `npm test` all green
(37 suites + browser-safety probe).

---

## 1. How to verify / resume

```bash
cd /Users/pablo/code/Axis/ForgeFX/server
npm run typecheck        # src only (tsconfig.json)
npm run typecheck:test   # src + test + scripts (tsconfig.test.json)  ← added in Phase A
npm test                 # 37 suites + check-browser-safe
```

Regenerate the golden snapshot deliberately (then review the diff):
```bash
UPDATE_GOLDEN=1 npx tsx test/run-all.ts
```

Node target is **20** (`engines >=20 <21`, `.nvmrc`, Dockerfile, and now CI/release all 20).

---

## 2. Phase A — safety net (DONE)

- **A1** Added `server/tsconfig.test.json` (extends base; `rootDir:"."`, `noEmit`; includes `src`, `test`,
  `scripts`) and script `typecheck:test`. Fixed **45** latent type errors in tests (non-null assertions,
  capability fields, a bad `app.inject` param type in `local.test.ts`, widened a `DeviceLayout` helper).
- **A2** Added a hermetic golden suite:
  - `test/helpers/fakeFm3.ts` — extracted the deterministic fake FM3 driver + caps + `presetSyx`
    (previously inlined in `router.test.ts`; now shared).
  - `test/api/route-golden.test.ts` — snapshots 28 deterministic app JSON responses to
    `test/fixtures/route-golden.json`, normalizing volatile keys (`at/ts/updatedAt/rev/…`). Supports
    `UPDATE_GOLDEN=1`. Excludes store-backed routes on purpose (shared process DATA_DIR).
  - Collapsed `test/fixtures/route-sweep/` from 6 phase dirs (5.4 MB) to a single `baseline/` (916 KB).
    Updated `scripts/sweep-routes.ts` header accordingly.
- **A3** Wired the golden suite into `test/run-all.ts` (now 37 suites).

---

## 3. Phase B — correctness & security (DONE, two exceptions)

| # | What changed | Files |
|---|---|---|
| B1 | Subscription read failure is now **unknown**, not free → sync won't prune a paid user's history; `status()` adds `unknown:true` additively | `runtime/cloud.ts` |
| B2 | Static path traversal fixed: separator-aware root check (`resolved === root \|\| startsWith(root+sep)`); malformed `decodeURIComponent` → 400 | `app.ts` (~830) |
| B4 | `withTimeout` clears its timer in `finally` | `runtime/cloud.ts` |
| B5 | Gen-3 grid reports the true model key (`this.#prof.key`) instead of hardcoded `'fm3'` (fixes FM9/Axe-Fx III) | `gen3.ts` (grid + `#dumpGrid`) |
| B6 | **Not a bug.** Kept behavior; unified the confusing constants: exported `GEN3_SHUNT_ID_BASE = 1024` from `gen3.ts`, derived `SHUNT_INDEX_OFFSET = 1023`; `registryCore` imports it | `gen3.ts`, `registryCore.ts` |
| B7 | **Partial.** `applyRuntimeCache` gate corrected to `(selfDescribe \|\| cacheImport) && applyRuntimeProfile`. AM4 has `cacheImport:true` but no `applyRuntimeProfile`, so real AM4 cache adoption is still a no-op — **deferred pending hardware semantics** | `registryCore.ts` |
| B8 | Handler error mapping: new `fail()` maps driver errors to `err.statusCode` if set else **503**; `blockParamsH` no longer returns 404 for device errors; router catch-all honors `statusCode` | `runtime/handlers.ts`, `runtime/router.ts` |
| B9 | Removed dead `blockParamDecode` capability (never serialized — confirmed absent from `#capabilitiesDto` and the golden). Removed unused `decodeFail` export. **Kept `telemetryControl`** (it IS serialized and intentionally advertised) | `types.ts`, all drivers, tests |
| B10 | Removed dead code: `Am4Driver.slots()`, `test/helpers/api.ts deepEqual`, `StoreBackend.deleteDoc` (+ both impls) | various |
| B11 | Cloud selects paginate via `.range()` (`selectAll` helper); `sync()` serializes concurrent calls via `#syncChain` | `runtime/cloud.ts` |
| B12 | Removed inert `allowScripts` field from `package.json` (not a real npm mechanism; npm runs scripts by default) | `package.json` |
| B13 | CI + release workflows pinned to Node **20** (was 22) | `.github/workflows/*` |
| **B3** | **DEFERRED by user** — remote allowlist deny-by-default. No Axis Cloud users yet | `remote.ts` |

### Decisions you should know
- **B6 was misdiagnosed in the review.** The 1023/1024 values serve different purposes (naming offset
  vs id threshold) and `gen3-livegrid.test.ts:120-143` pins the behavior. Do **not** "fix" by changing
  the value.
- **B7 real fix** needs an AM4 `applyRuntimeProfile` backed by the codec's cache consumption. The
  imported cache is currently persisted but never applied to the AM4 driver. Left as-is.
- Error-text change: AM4 descriptor timeouts now say `descriptor receiveSysEx timeout…` (was `AM4 …`)
  after B3/C2's `Am4Conn` removal. No test asserts it.

---

## 4. Phase C — modularization (IN PROGRESS)

### Done (C2 partial)
- **`Am4Conn` deleted**; AM4 now uses the shared `TransportConn`/`dispatchCtx` from
  `descriptorConn.ts` (removed ~45 lines). `#hashPlacedParams(conn)` retyped to `TransportConn`.
- **New `src/drivers/shared/params.ts`** with the duplicated helpers, migrated in **gen2.ts + am4.ts**:
  `dedupeById`, `enumOrdinal`, `normOf`, `paramLookup`, `slotParamValues`, `bypassEnum`.
  Removed the now-dead private copies from both drivers.

### Remaining C2
- Extract the **descriptor-reader base** (`#withReader` + reader-lock + TTL preset cache + `readPreset`)
  shared by am4/gen2/vp4. Recon details:
  - `#withReader` bodies are byte-identical: `am4.ts:~289`, `gen2.ts:~101`, `vp4.ts:~92`.
  - `readPreset`: am4 has dynamic TTL (`0.8×editWatchMs`, injectable clock) + extra
    `#readStructure()`/`#refreshActiveChannels()` work; gen2/vp4 fixed `500ms` TTL.
  - Suggest a small `ReaderCache` helper parameterized by `{ clock, ttlMs, getPresetOpts, onLoaded }`.
- Other duplicated helpers the recon found but not yet extracted: `paramLabel` (3 variants — do NOT
  merge blindly), normalized lookup (now done), `NOTE_NAMES` + `%12` (registryCore vs am4),
  gen3's 4× `enc14` / 2× `unpackF32` / checksummed frame builders (consider `forgefx-midi/shared`
  exports, but note local `enc14` silently truncates while the package throws).

### Remaining C phases (not started)
- **C1** — route manifest + unify `app.ts` and `runtime/router.ts` (~28 duplicated route bodies).
  Biggest payoff, biggest risk. Golden suite protects it.
- **C3** — split god-objects: `gen3.ts` (1728 LOC), `registryCore.ts` (~1122), `am4.ts` (~1116).
- **C4** — single `deviceCatalog` table; remove `registry.am4()` typed leak (`handlers.ts decodeH`).
- **C5** — one `ServiceResult` convention; extract `services/deviceCacheKey.ts`; split
  `convert.ts:exportConvertedSyx`; move `/fm3edit/blocks/save` out of `app.ts`; dedupe the
  `editorCacheDiscovery` fs-walk.
- **C6** — move `deviceCache` `JOBS` WeakMap into an owned builder; move `pauseTelemetry()` inside
  `try`; reduce `store.ts` delegating wrappers.
- **C7** — unify cache-TTL / write-ack-retry policy; shared error-code union.

### Remaining D / E
- **D1** ESLint + Prettier; **D2** transport tests (serial/midi/connection); **D3** move test-only
  backdoors out of prod exports; **D4** byte-exact golden frames replacing tautological frame tests;
  **D5** c8 coverage; **D6** test temp cleanup.
- **E** NOTICE attribution, README/api-design/frontend-stack/block-library docs, SSE-vs-WebSocket fix,
  "Gift of Tone" attribution.

---

## 5. Repo state (uncommitted)

Modified (32 tracked files) + new untracked files:
- `docs/refactor-plan.md` (new)
- `server/tsconfig.test.json` (new)
- `server/src/drivers/shared/params.ts` (new)
- `server/test/helpers/fakeFm3.ts` (new)
- `server/test/api/route-golden.test.ts` (new)
- `server/test/fixtures/route-golden.json` (new, generated)
- Fixtures: `route-sweep/phase0-baseline|phase3..7` collapsed to `route-sweep/baseline/`.

No commits have been made. Suggested first commit when resuming: Phase A + Phase B together (or split
as in `refactor-plan.md` §"Execution order & PR boundaries").

---

## 6. Recommended next step

1. `npm run typecheck && npm run typecheck:test && npm test` to confirm the checkpoint.
2. Continue **C2** (descriptor-reader base) or start **C4** (device catalog, low risk) while C1 is the
   large one. Re-read `docs/refactor-plan.md` for the full task list.
3. Do **not** revisit B3 unless Axis Cloud gets users; if so, source the allowlist from the C1 manifest.
