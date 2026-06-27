# vendor/

Offline backups of third-party dependencies we rely on, so the project can never
be stranded if an upstream registry or repo disappears.

## fractal-midi-0.5.1.tgz

The exact published npm artifact of [`fractal-midi`](https://www.npmjs.com/package/fractal-midi)
v0.5.1 (Apache-2.0, by Stephen Staker) — a pure-TypeScript codec + parameter
dictionaries for Fractal devices (AM4, Axe-Fx II/III, FM3, FM9, VP4, gen1).
ForgeFX uses it as its codec engine.

Contains the compiled `dist/` (JS + `.d.ts`) and `catalog/*.json`, which is
everything needed to consume the library. To install from this backup if npm is
unavailable:

```
npm install ./vendor/fractal-midi-0.5.1.tgz
```

Refresh with `npm pack fractal-midi` from the repo root.
