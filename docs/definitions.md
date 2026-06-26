# Definition packs (parameter naming)

The device wire protocol exposes each parameter by a numeric `paramId` (== dump-array index
== SET address index), but not a human label. ForgeFX therefore ships **open data packs** —
one JSON per block — mapping each block's `paramId` to a name (and, where known, the unit,
range, and how the wire value scales to engineering units).

## Pack format (`definitions/fm3-<block>.json`)
```json
{
  "name": "Cab",
  "page": 62,
  "params": [
    { "index": 8,  "name": "Level 1" },
    { "index": 62, "name": "LowCut 1", "unit": "Hz", "min": 20, "max": 200, "scale": "Log" }
  ]
}
```
- `page` — the block's dump page (func 0x1f / 0x75), which equals the block id.
- `index` — the parameter's `paramId` (dump-array index == SET address index, unified).
- `scale` — `Linear` (`min + n·(max−min)`), `Log` (`min·(max/min)^n`), or `Raw` (integer/index).
- `unit`/`min`/`max`/`scale` are optional; when absent the raw normalized value is used.

## Reading named params
`Definitions.ReadNamed(blockDef, dump)` decodes the dump and applies the pack →
`[{name, value, unit, norm}]`. Served at `GET /block/{name}/params`.

## Validation
Packs are validated against the device by dumping a block and confirming known anchors —
e.g. Cab `Level 1`=8, `Pan 1`=12, `Proximity 1`=20, `LowCut 1`=62, `HiCut 1`=66,
`Low Slope 1`=74 all match hardware dumps. Packs are open data and crowd-sourceable.
