# Definition packs (parameter naming)

Parameter **labels** ("Low Cut", "Mid") aren't stored as text anywhere in FM3-Edit (they're
baked into the UI graphics — verified across the Windows and macOS builds). So ForgeFX keeps
them as **open data packs**, one JSON per block, mapping a parameter's **dump index** to its
name + how the wire value scales to engineering units.

## Pack format (`definitions/fm3-<block>.json`)
```json
{
  "name": "Cab",
  "page": 62,
  "params": [
    { "index": 62, "name": "Low Cut", "unit": "Hz", "min": 20, "max": 200, "scale": "Log" }
  ]
}
```
- `page` — the block's dump page (func 0x1f / 0x75).
- `index` — the value's position in the dump array == the SET address byte[3] (unified index).
- `scale` — `Linear` (`min + n·(max−min)`), `Log` (`min·(max/min)^n`), or `Raw` (integer/index).

## Reading named params
`Definitions.ReadNamed(blockDef, dump)` decodes the dump and applies the pack →
`[{name, value, unit, norm}]`. Served at `GET /block/{name}/params`.

## How a pack is built (the "learn" workflow — measure, don't guess)
The wire gives us each block's params in order with type/range; only the **name** is human.
To bind name↔index reliably:
1. Dump the block (`dump_page`) → baseline.
2. Change one control in FM3-Edit (it shows the name) **or** write a known index.
3. Dump again and diff (`tools/correlate.py`) → the changed **index** is that parameter.
4. Record `{index, name, unit, min, max, scale}` in the pack; verify against anchors.

Validated anchors so far: Cab **Low Cut** = index 62 (log 20–200 Hz); Amp **Mid** = index 9
(linear 0–10; 0.169 → 1.69). Packs grow by docs + this measured correlation, and are
**crowd-sourceable** for FM9/Axe-Fx via the Debug Dumper — no device required to contribute names.
