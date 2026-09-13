# ForgeFX — Full Remediation & Modularization Plan

Status: approved, not started. Source: staff-level code review of `server/` (2026-09-13).
This file is the durable handoff for the work; it is self-contained (includes the review
findings) so it survives context compaction.

## Global constraints

- **Contract is sacred.** HTTP status/body, SSE event shapes, driver DTOs, and store formats are
  the external contract. Bug fixes intentionally change specific outputs; modularization changes
  none. Every phase runs `npm test` (35 suites) + `npm run typecheck` + `npm run check:browser`.
- **One workstream = one reviewable PR.** No mixed bug-fix + refactor commits.
- **Subagents:** only `explore` (read-only) is available, so delegate reconnaissance/verification
  (call-site sweeps, behavior diffing, fixture validation) to parallel explore agents; apply edits
  in the main session.
- Public entry points to keep stable: `forgefx-server/runtime`, `src/index.ts`, `src/app.ts`,
  `DeviceDriver`, `Transport`, `Store`, `createGen3Driver`/`createAm4Driver` factories.

---

## Phase A — Safety net (prerequisite)

- **A1.** Add `server/tsconfig.test.json` (`include: test/**/*.ts, scripts/**/*.ts`, same
  strictness) + a `typecheck:test` script. Fix latent type errors in test doubles. (§4.1)
- **A2.** Capture one golden API baseline; add `test/api/route-golden.test.ts` that injects the app
  + router and diffs every route response. Collapse `test/fixtures/route-sweep/` from 6 phases
  (5.4 MB; `phase0-baseline == phase3` byte-for-byte) to one baseline + the generator. (§4.4)
- **A3.** Wire the baseline suite into `test/run-all.ts`.

Acceptance: baseline green pre-change; goes red on unintended drift; updated deliberately when
Phase B changes behavior.

---

## Phase B — Correctness & security (§1)

| # | Fix | Files | Notes |
|---|-----|-------|-------|
| B1 | Subscription-read failure must not downgrade to free / prune remote history | `runtime/cloud.ts:101-108,337-343` | Return `unknown`; skip prune when unknown |
| B2 | Static path traversal (separator-aware root check) | `app.ts:830-837` | Reuse `safeRel` semantics (`runtime/localFolder.ts:43`) |
| B3 | ~~Remote allowlist deny-by-default, derived from one route manifest~~ **DEFERRED** (no Axis Cloud users yet; revisit later) | `remote.ts:26-53` | Skip for now |
| B4 | `withTimeout` timer leak | `runtime/cloud.ts:30-35` | Clear timer in `finally` |
| B5 | Gen-3 reports true device key, not `'fm3'` | `gen3.ts:402,467` | Update `gen3-livegrid` test + fixtures |
| B6 | Unify shunt base | `gen3.ts:56-58,415,421` ↔ `registryCore.ts:87` | Single exported `GEN3_SHUNT_BASE = 1024`; comparison becomes `>=`; verify wire semantics with a focused test |
| B7 | AM4 `cacheImport`/`selfDescribe` misalignment | `am4.ts:235-236`, `registryCore.ts:673-685` | Gate runtime swap on `(selfDescribe \|\| cacheImport) && applyRuntimeProfile`; add AM4 `applyRuntimeProfile`; test |
| B8 | Handler error-mapping consistency | `runtime/handlers.ts:94-146,85-91` | Writes → 503 on device failure; `blockParamsH` 404 only for not-found; update tests |
| B9 | Remove dead contract surface | `types.ts:165,181`; all drivers; `handlers.ts:228`; tests | Drop `blockParamDecode`, unused `telemetryControl` field, unused `decodeFail` export |
| B10 | Dead code removal | `am4.ts:566` `slots()`, `test/helpers/api.ts:33` `deepEqual`, `storeBackend.deleteDoc` | Verify no callers first |
| B11 | Cloud sync pagination + mutex | `runtime/cloud.ts:224,318,332` | `.range()` paging; in-flight guard |
| B12 | `allowScripts` → real mechanism | `package.json:49-52` | Move to `pnpm.onlyBuiltDependencies`/lavamoat, or drop with a comment |
| B13 | Node version alignment | `ci.yml:36`, `release.yml:55` | CI/release → Node 20 to match `engines`/Docker/.nvmrc |

Decisions taken (change observable behavior): **B6** canonicalizes the shunt base to `1024`
(comparison `>=`); **B7** makes AM4 imported caches actually apply. Confirm before merging.

---

## Phase C — Modularization (§2–§3), behavior-preserving

**C1 — Route manifest + unified HTTP surface (§2.1, biggest payoff)**
- One route manifest (method, path, handler, surface flags, remote policy) as single source of truth.
- Move all remaining inline bodies from `app.ts` and `runtime/router.ts` into
  `src/http/handlers/` (system, preset, catalog, params, telemetry, fcMod, store, backup, cloud, local).
- `app.ts` → Fastify adapter + `aliases.ts` + `static.ts` + `sse.ts` + cloud/remote/telemetry wiring.
  `router.ts` → thin adapter.
- Preserve current per-surface divergences via manifest surface flags (documented list).

**C2 — Driver seams (§2.2, §2.3, §3.4)**
- `drivers/shared/descriptorBase.ts` (reader lock, 500 ms preset cache, `readPreset`) for am4/gen2/vp4.
- Delete `Am4Conn` (`am4.ts:153-197`); use `descriptorConn.ts`.
- `drivers/shared/numeric.ts`: `normOf`, `enumOrdinal`, `dedupe`, `slotParamValues`, `paramLabel`,
  `unpackF32`, `enc14`, checksum-frame builder.

**C3 — Split god-objects (§2.2)**
- `gen3.ts` (1,725 LOC) → `gen3/{index,dump,grid,params,fc,cab,meters,looper,modifier,writes,editBurst}.ts`;
  factory signature unchanged.
- `registryCore.ts` (1,122 LOC) → `registry/{core,detect,capabilities,telemetrySupervisor,transportInstrumentation,eventBus}.ts`;
  `DeviceRegistry` becomes a facade, public methods unchanged.
- `am4.ts` (1,181 LOC) split along its existing sections.

**C4 — Device metadata single source (§2.4, §2.5)**
- One `deviceCatalog` (model byte → descriptor, driver factory, forced-key aliases, profile,
  capability extras) consumed by `DESCRIPTOR_BY_MODEL`, `#driverFor`, `#forcedModelId`,
  `telemetryProfiles`. Preserve current values (512/104 etc.); centralize only.
- Replace `registry.am4(): Am4Driver` leak with a generic `decodeByModel`/capability path.

**C5 — Services cohesion (§3.1, §3.7, §3.6, §3.5)**
- One `ServiceResult` convention; migrate `{code,body}` / `{status,body}` / thrown errors; adapters
  map at the edge.
- Extract `services/deviceCacheKey.ts` shared by `deviceCache`, `editorCacheImport`, `cloudProfiles`.
- Split `convert.ts:exportConvertedSyx` into `validate`/`resolveScaffold`/`resolveSource`/`synthesize`/`fidelity`.
- Move `/fm3edit/blocks/save` body (`app.ts:231-308`) into `blockLibrarySave`.
- Extract duplicated fs-walk in `editorCacheDiscovery`; make the read path injectable.

**C6 — Runtime state ownership (§3.5)**
- Move `deviceCache` `JOBS` WeakMap into an owned builder object; move `pauseTelemetry()` inside
  `try` (`deviceCache.ts:124-126`); keep `cacheBuildPromise` behavior.
- Reduce `store.ts` delegating wrappers to a bound object (module-level function exports preserved).

**C7 — Consistency sweep (§3.2, §3.4, §3.6)**
- Unify cache-TTL and write/ack/retry policy behind shared driver helpers; stringly-typed error
  codes → a shared union.

---

## Phase D — Testing & tooling (§4)

- **D1.** ESLint + Prettier (flat config) + `lint`/`format` scripts + CI lint step. (§4.5)
- **D2.** Transport tests for `serial.ts`, `midi.ts`, `connection.ts` (fake port/native-MIDI
  binding; chunking, partial reads, reconnect). (§4.3)
- **D3.** Move test-only backdoors out of production exports (`__createRegistryForTest`,
  `__setDriverForTest`; remove `walkImpl` from public `startCacheBuild`). (§4.6)
- **D4.** Replace tautological frame tests (`gen2.test.ts:53-97`, `vp4.test.ts:75-98`) with
  byte-exact golden frames. (§4.11)
- **D5.** Add c8 coverage; cover `localFolder`, `localService`, `fsStoreBackend`, `memStoreBackend`,
  `telemetry`. (§4.12)
- **D6.** Clean test temp litter (`helpers/env.ts`) and delete dead helpers. (§4.15, §4.13)

---

## Phase E — Documentation (§5)

- Rewrite `NOTICE` attribution for the `forgefx-midi`-based codec (remove C# refs).
- Update `docs/preset-grid-codec.md:6`, `server/README.md:3,16,36,41`, `docs/api-design.md` (SSE not
  WebSocket), `docs/frontend-stack.md`, `docs/block-library-apply-plan.md` paths,
  `docs/cab-ir-live-read.md:174`.
- Add attribution for bundled "Gift of Tone" fixtures. (§4.16)

---

## Execution order & PR boundaries

1. **A** (safety net) → merge.
2. **B**, one PR per cluster (B1-B4 infra, B5-B7 device semantics, B8-B13 hygiene) → merge.
3. **C1** → merge. **C2+C3** (~4 commits) → merge. Then **C4**, **C5**, **C6**, **C7**.
4. **D**, then **E**.

## Risk & rollback

- Highest risk: C1 and C3 (route + driver splits) — mitigated by A1/A2 golden suite + per-commit tests.
- B5/B6/B7 intentionally change device-reported values — update golden fixtures in the same commit.
- Every phase independently revertable; no schema/store migrations.

## Definition of done

- `npm run typecheck` (src **and** tests), `npm test`, `npm run check:browser`, and lint pass on
  Node 20 in CI.
- No duplicated route bodies between `app.ts` and `router.ts`; `gen3`/`registryCore`/`am4` split with
  unchanged public factories.
- Every §1 finding fixed with a regression test; §2–§5 addressed as above.
