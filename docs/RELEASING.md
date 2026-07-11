# Releasing ForgeFX

ForgeFX is **stage 2** of the cross-repo release chain:

```
forgefx-midi  →  ForgeFX  →  Axis  →  axisapp.live
```

Release builds pin the sibling codec ref via `stack.lock.json`; CI keeps tracking the
codec's default-branch HEAD (latest-against-latest integration testing).

## Checklist

1. **Codec released & pinned?** The forgefx-midi change you depend on must be released
   (its tag build published). Then bump the pinned ref: set
   `stack.lock.json → forgefx-midi.ref` to the codec commit you want to ship against.
2. **Bump the server version:** in `server/`, `npm version X.Y.Z-beta --no-git-tag-version`.
3. Commit both changes.
4. **Tag:** `git tag vX.Y.Z-beta && git push origin main --tags`.
5. Pushing the tag runs `release.yml`:
   - `gate` — full test suite (codec build + server typecheck/test/build) against the
     **pinned** codec ref,
   - `docker` — multi-arch image staged from the pinned codec, pushed to GHCR,
   - `release` — a **draft** GitHub release stamped with the shipped stack (server version
     + pinned codec ref).
6. **Review the draft**, smoke-test the image, then publish it manually.

## Secrets

- `STACK_DISPATCH_TOKEN` — PAT with `repo` scope on `sKuhLight/Axis`; used by `ci.yml`'s
  `notify-axis` job (green main pushes redeploy axisapp.live) and by `release-published.yml`
  (a published release notifies Axis). Soft-gated: unset → skipped. A PAT also lets the
  auto-PRs (`codec-bump.yml`) trigger their own CI; with only `GITHUB_TOKEN` the PR is still
  opened but its CI must be kicked manually (close/reopen).
- GHCR push uses the built-in `GITHUB_TOKEN` (`packages: write`).

## Automation & ripple decision rule

- **version-guard** (`ci.yml`) rejects any non-docs PR whose `server/package.json` version
  isn't greater than the base branch's (docs-only PRs pass). Bump with
  `cd server && npm version X.Y.Z-beta --no-git-tag-version` (lockfile too).
- **Codec ripple in (`codec-bump.yml`).** A forgefx-midi release fires `codec-released`,
  which opens an auto-PR bumping `stack.lock.json → forgefx-midi.ref`. **Merge that PR
  instead of hand-editing the pin.** Then the **release-or-not decision:**
  - The codec change touches the **wire/API surface** ForgeFX exposes, or changes a
    **catalog** Axis users see → **cut a ForgeFX release** (bump server version, tag).
  - The change is **internal-only** → don't release; the new pin simply **rides along the
    next release**.
- **Release ripple out (`release-published.yml`).** Creating a draft does nothing downstream;
  **publishing** a ForgeFX release fires `server-released` at Axis, which opens *its own*
  bump PR pinning this server tag + the codec ref this release shipped against.
