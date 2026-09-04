# Layouts & virtual effects

ForgeFX serves two things on top of the raw parameter list, so clients can render a
device-faithful editor without hardcoding a single label or screen:

1. **Editor layouts** — per-family, device-authentic pages/tabs (with control labels and
   positions) attached to a block's parameter response.
2. **Virtual effects** — the device's non-audio editor sections (Setup/global, controllers,
   modifiers, foot controller) read and written through the *same* block endpoints, addressed
   by a reserved effect id.

Both flow from data the device profile carries (per `DeviceProfile`), so the behaviour adapts
to whichever Fractal unit is attached. The layout data itself is **device-authentic editor
layout data derived from the device editor configuration** — pages, control labels, and column
positions as the device organizes them — surfaced as plain JSON.

## The layout shape

Each device supplies a per-family layout map (v2 schema — the block-type/firmware **variant**
already resolved to the one the editor would show for the block's *current* type value; see
`layoutFor(family, typeValue, selectors)` in [`server/src/devices.ts`](../server/src/devices.ts)).
A resolved layout is variant metadata plus that variant's pages → rows → controls, **passed
through verbatim** from the codec's `*_LAYOUTS` data — nothing here is Axis-invented arrangement:

```ts
type DeviceLayout = {
  editorName: string;                        // the block's editor display name (e.g. 'Amp')
  family: string;                            // catalog family symbol (e.g. 'DISTORT')
  variantName: string;                       // chosen variant's editor display name
  variantValue: string | null;               // that variant's block-type selector value(s), or null
  fw?: { gtet?: string; lt?: string };       // firmware gate on the chosen variant, when present
  pinned?: boolean;                          // true for the firmware-current pinned variant (Amp)
  pages: {
    name: string;                            // tab/page label
    pageNum?: number;
    value?: string;                          // selector value(s) that gate this page, when present
    selectorParamName?: string;              // the selector param this page's `value` gates on
    fw?: { gtet?: string; lt?: string };
    rows: {
      section: 'parameters' | 'mixer';       // which page section the row belongs to
      controls: {
        label: string;                       // editor caption, '' for decorative controls
        paramName: string | null;            // editor param symbol, null = decorative (spacer/graph)
        paramId: number | null;              // wire paramId (null = not addressable)
        widget: string;                      // normalized kind: knob/toggle/slider/dropdown/graph/…
        rawWidget: string;                   // verbatim editor widget token, e.g. 'knobCompact'
        placement?: { col?: number; offsetX?: number; offsetY?: number; positionExact?: string };
        crossBlock?: { effect: string; family: string | null; paramName: string | null; paramId: number | null };
        fw?: { gtet?: string; lt?: string };
      }[];
    }[];
  }[];
};
```

This is the same shape for every gen-3 device; only the data differs per unit. `resolveLayoutPages`
has already collapsed selector/firmware siblings and pruned firmware-hidden controls, so a client
renders exactly the pages/controls the editor would show for the block's current state — it should
not re-filter by `value`/`fw` itself.

## Layouts on the parameter response

`GET /preset/blocks/:eid/params` returns the block's live parameter values and now also carries
the family's editor layout:

```jsonc
{
  "block": "Amp",
  "slug": "amp",
  "page": 58,
  "named": [    // continuous params (kind 'float') — knobs
    {
      "id": 12, "name": "Drive", "value": 5.2, "norm": 0.52, "unit": "dB", "min": -20, "max": 20, "log": false,
      "paramName": "DISTORT_DRIVE", "family": "DISTORT",       // editor symbol + catalog family
      "step": 0.1, "default": 0,                               // device-true increment / default
      "taper": "linear",                                       // 'linear' | 'log' | 'flat' | 'custom'
      "unitCode": "db",                                        // catalog unit CODE (not the display label)
      "kind": "float",
      "help": { "blurb": "…", "tip": "…" }                      // curated copy, when this param has any
    }
  ],
  "enums": [ /* discrete selectors — same additive fields, plus "options" */ ],
  "type":  { "value": 3, "name": "…" },
  "layout": { /* editor-authentic pages for this family, shape above */ }
}
```

Every catalog def for the family ships in `named`/`enums` — none are dropped for being unusable
any more. A param that has no range row, a degenerate (0-width) range, or a paramId that collides
with an earlier def carries `"unusable": "no-range" | "degenerate-range" | "duplicate-id"` instead
of vanishing, because a layout control can still name that paramId and the renderer must be able to
resolve it. The two categories still excluded outright are real device semantics surfaced
elsewhere: the raw bypass flag, and the family TYPE selector (surfaced as the top-level `type`).

`layout` is **optional**: it is present when the active device profile has a layout for the
block's family, and omitted otherwise. The `named`/`enums` arrays remain the source of truth for
live values — `layout` only describes *how* a client should arrange and label them (a control's own
`label`, not the param's `name`, is what should be rendered — see below). A client that ignores
`layout` still gets a fully functional flat parameter list.

## Labels: `named[].name`/`enums[].name` vs `layout` control labels

`named`/`enums` carry the **catalog** label (`name`) — served unchanged, straight from the static
catalog's `displayLabel`. It is **not** deduplicated and **not** overridden by the layout: two
params that the editor shows as, say, four identical "Low Cut" mic knobs all carry the literal name
`"Low Cut"` here. This is deliberate — ForgeFX no longer rewrites labels server-side (an earlier
pipeline overwrote `name` with the resolved layout's own label, then appended "` 1`"/"` 2`" to
disambiguate repeats, which is why served labels used to drift from the official editor). A client
rendering by `layout` should use each **control's own** `label` (already unique per placement, and
already the editor's current text for that firmware) and treat `named`/`enums[].name` as the
catalog-only fallback for consumers that key off the flat param list directly (deep param search,
the contract test).

## Virtual effects

The device's non-audio editor sections sit on the same `(effectId, paramId)` parameter path as
audio blocks, so ForgeFX exposes them through the **same endpoints** — there is no separate API.
They are addressed by a reserved effect id:

| Effect id | Family | What it is |
|-----------|--------|------------|
| `1` | `GLOBAL` | Setup / device-global configuration |
| `2` | `CONTROLLERS` | Controllers |
| `3` | `MOD` | Modifier |
| `199` | `FC` | Foot Controller (FC) |

So **"Setup" is just the block editor pointed at effect id `1`.** `blockParams(eid)` resolves an
audio block's family via the codec, and a virtual effect's family via the profile's
`familyForEffectId(eid)` map, then attaches that family's layout the same way. Reads return the
GLOBAL/controllers/etc. params with live values plus the matching editor pages; writes go through
the ordinary param/`PUT` path.

> Confirmed live on the **FM3**: `GET /preset/blocks/1/params` returns the GLOBAL params and the
> Setup pages with real device values.

### Examples

```sh
# Read Setup (GLOBAL) — params + the Setup editor pages, with live values
curl localhost:5056/preset/blocks/1/params

# Read the controllers / modifier / foot-controller sections
curl localhost:5056/preset/blocks/2/params      # Controllers
curl localhost:5056/preset/blocks/3/params      # Modifier
curl localhost:5056/preset/blocks/199/params    # Foot Controller (FC)

# Set a GLOBAL parameter (param id 4 here) — same write endpoint as any audio block
curl -X PUT localhost:5056/preset/blocks/1/params/4 \
  -H 'content-type: application/json' \
  -d '{ "value": 0.5, "continuous": true }'
```

Discrete (enum) writes send the ordinal with `"continuous": false`, exactly as for audio blocks.

## Multi-device

Layouts and the virtual-effect map are per device, supplied by the `DeviceProfile`:

| Device | Layouts | Virtual effect ids |
|--------|---------|--------------------|
| FM3 | `FM3_LAYOUTS` | gen-3 shared (`1`/`2`/`3`/`199`) |
| FM9 | `FM9_LAYOUTS` | gen-3 shared (`1`/`2`/`3`/`199`) |
| Axe-Fx III | `AXE3_LAYOUTS` | gen-3 shared (`1`/`2`/`3`/`199`) |

ForgeFX auto-detects the attached unit and selects its profile, so the served layouts and the
virtual-effect resolution match the connected device with no client changes. The three gen-3
units share the virtual effect ids; each ships its own family layouts.

See also [Devices & families](devices.md) for how a device profile is selected.
