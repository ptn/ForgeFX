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
  `notify-axis` job (green main pushes redeploy axisapp.live). Soft-gated: unset → skipped.
- GHCR push uses the built-in `GITHUB_TOKEN` (`packages: write`).
