// AM4 DTO builders: pure mapping from decoded device data (structure slots / reader snapshot /
// KNOWN_PARAMS catalog) into the unified DTOs Axis consumes. Split out of am4.ts (C3); these take
// explicit inputs so the driver class stays a thin I/O orchestrator. No transport access here.
import {
  BLOCK_TYPE_VALUES,
  KNOWN_PARAMS,
  resolveBlockTypeValue,
  AM4_PRESET_FRAME_SIZE,
  parseAm4PresetBank,
  parseAm4PresetDump,
  am4DumpLocation,
  decodeAm4PresetNameFromFrame,
  type Param,
} from 'forgefx-midi/am4';
import type { PresetSnapshot } from 'forgefx-midi/core';
import type {
  Am4Slot,
  EnumParam,
  NamedParam,
  OfflinePresetBank,
  PresetBlockDTO,
  PresetGridDTO,
} from '../types.js';
import type { TypeModel } from '../../devices.js';
import { bypassEnum, dedupeById, enumOrdinal, normOf, paramLookup } from '../shared/params.js';
import { AM4_UNIT_LABEL, am4BlockLabel, am4DecodeEnrichment, am4NoneSelector, am4ParamLabel } from './support.js';

/** The AM4's 1×4 linear chain as a PresetGridDTO. EMPTY slots are OMITTED (no cell), matching gen-3
 *  semantics; a gen-3 shunt is a REMOVABLE routing cell and Axis incorrectly treated AM4 shunts as
 *  occupied (dropping the "add a block" path). */
export function am4Grid(slots: Am4Slot[], name: string): PresetGridDTO {
  const cells = slots
    .filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none')
    .map((sl) => {
      const resolved = resolveBlockTypeValue(sl.pidLow);
      return {
        row: 0,
        col: sl.slot - 1,
        effectId: sl.pidLow,
        name: sl.blockType,
        isShunt: false,
        routeFlag: 0,
        fromRows: sl.slot - 1 > 0 ? [0] : [], // linear: each slot feeds from the previous
        // ADDITIVE (Phase 6): the AM4 block dictionary is already slug-shaped ('amp', 'drive', …) —
        // surface it so Axis can key params/help/icons without its `!c.pack` gates.
        ...(resolved ? { slug: resolved.name } : {}),
      };
    });
  return { model: 'am4', name, crcValid: true, rows: 1, cols: 4, scenes: [], cells, source: 'dump' };
}

/** Placed blocks in the unified PresetBlockDTO shape: the 4-slot chain as row 1 / col 1..4. Bypass +
 *  channel ride the TTL-cached atomic reader dump; channel prefers the tracked device-truth index and
 *  falls back to the dump's first channel key. */
export function am4PlacedBlocks(
  slots: Am4Slot[],
  snap: PresetSnapshot | null,
  activeChannel: Map<number, number>,
  chanLetters: readonly string[],
): PresetBlockDTO[] {
  return slots.map((sl) => {
    const slug = resolveBlockTypeValue(sl.pidLow)?.name ?? sl.blockType;
    // match the reader slot by POSITION, not block name — a preset can hold two instances of the
    // same block type (drive 0x76 + drive 0x77), and a name match would return the wrong one
    const matched = snap?.slots.find((x) => x.slot === sl.slot) ?? snap?.slots.find((x) => x.block_type === slug);
    const trackedIdx = activeChannel.get(sl.pidLow);
    const channel = trackedIdx !== undefined
      ? (chanLetters[trackedIdx] ?? null)
      : (matched?.params_by_channel ? Object.keys(matched.params_by_channel)[0] ?? null : null);
    return { slug, name: sl.blockType, effectId: sl.pidLow, row: 1, col: sl.slot, fromRows: [], bypassed: matched?.bypassed ?? null, channel };
  });
}

/** Join a block's decoded display values against KNOWN_PARAMS into the named-knob / enum DTO split.
 *  `basePidLow` is the catalog base; foreign sub-block params (e.g. the amp page's integrated cab)
 *  get a composite id `(pidLow<<16)|pidHigh` so they stay unique AND addressable on write. */
export function am4JoinBlockParams(
  blockName: string,
  basePidLow: number,
  decoded: Record<string, number | string>,
  bypassed: boolean | undefined,
): { named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null } {
  // The reader's decoded keys should match KNOWN_PARAMS names verbatim, but casing/space/underscore
  // drift would silently drop every param; index by a normalized key so a cosmetic mismatch still
  // resolves to the right value.
  const lookup = paramLookup(decoded);
  const params = (Object.values(KNOWN_PARAMS) as Param[]).filter((p) => p.block === blockName);
  const named: NamedParam[] = [];
  const enums: EnumParam[] = [];
  let type: { value: number; name: string } | null = null;
  // A block's page can aggregate more than one hardware sub-block under one name — the amp block
  // carries its integrated cab (pidLow 0x3e) alongside the amp itself (pidLow 0x3a). Both sub-blocks
  // number their params from pidHigh 0, so pidHigh ALONE is not a unique id across the page and is
  // ALSO the wrong write address for the foreign sub-block. Encode foreign params as the FULL address
  // — (pidLow<<16)|pidHigh — and keep the bare pidHigh for the block's own params. pidLow ≤ 0xce and
  // pidHigh ≤ 0x7d2, so a bare pidHigh is always < 0x10000, a composite ≥ 0x3a0000: never overlap.
  const encId = (p: Param) => (p.pidLow === basePidLow ? p.pidHigh : (p.pidLow << 16) | p.pidHigh);
  for (const p of params) {
    const display = lookup(p.name);
    if (display === undefined) continue; // param not in the dump (channel-gated / not placed)
    if (p.unit === 'enum') {
      const options = Object.entries(p.enumValues ?? {}).map(([v, label]) => ({ value: Number(v), label }));
      const value = enumOrdinal(p, display);
      // the block's own type selector is surfaced separately (like gen-3's `type`), not as a plain enum
      if (p.name === 'type') { type = { value, name: p.enumValues?.[value] ?? String(display) }; continue; }
      // channel rides the block header's dedicated A/B/C/D selector, not a generic dropdown — skip it.
      if (p.name === 'channel') continue;
      enums.push({ id: encId(p), name: am4ParamLabel(p), value, options });
    } else {
      // A raw-int `_cc` register reads back the string 'None' when unassigned — surface it as a
      // labeled selector, not a knob coerced to a broken 0 (see am4NoneSelector).
      const none = am4NoneSelector(encId(p), am4ParamLabel(p), display);
      if (none) { enums.push(none); continue; }
      const value = typeof display === 'number' ? display : Number(display) || 0;
      named.push({
        id: encId(p),
        name: am4ParamLabel(p),
        value,
        norm: normOf(p, value),
        unit: AM4_UNIT_LABEL[p.unit] ?? undefined,
        min: p.displayMin,
        max: p.displayMax,
        log: p.scaling === 'log10' || undefined,
      });
    }
  }
  // Defensive: never ship two params with the same id — Axis keys its widget {#each} on it, and a
  // duplicate key hard-crashes the Svelte editor. First occurrence wins.
  const namedOut = dedupeById(named);
  const enumsOut = dedupeById(enums);
  // bypass state — the reader already read it into slot.bypassed as part of the same atomic dump.
  if (bypassed !== undefined) enumsOut.unshift(bypassEnum(bypassed));
  return { named: namedOut, enums: enumsOut, type };
}

/** Placeable-block catalog (GET /blocks) — powers the "add a block" palette. The AM4 roster is fixed
 *  (one instance per type): family == slug, instance 1, page = the block's own type code. */
export function am4BlocksCatalog(): { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[] {
  const catalog = Object.values(KNOWN_PARAMS) as Param[];
  return (Object.entries(BLOCK_TYPE_VALUES) as [string, number][])
    .filter(([slug]) => slug !== 'none')
    .map(([slug, page]) => {
      const params = catalog.filter((p) => p.block === slug);
      const typeParam = params.find((p) => p.name === 'type');
      return {
        slug,
        family: slug,
        instance: 1,
        name: am4BlockLabel(slug),
        page,
        paramCount: params.length,
        typeCount: typeParam ? Object.keys(typeParam.enumValues ?? {}).length : 0,
      };
    });
}

/** Block "type" roster (GET /blocks/:slug/types) — the amp/drive/… model list the type picker shows.
 *  manufacturer/basedOn are gen-3-only catalog fields the AM4 tables don't carry, hence null. */
export function am4BlockTypes(slug: string): TypeModel[] {
  const typeParam = (Object.values(KNOWN_PARAMS) as Param[]).find((p) => p.block === slug && p.name === 'type');
  if (!typeParam?.enumValues) return [];
  return Object.entries(typeParam.enumValues)
    .map(([v, name]) => ({ value: Number(v), name, manufacturer: null, basedOn: null }))
    .sort((a, b) => a.value - b.value);
}

/** Offline decode of an AM4 .syx (a single dump or a whole bank, e.g. the 104-preset factory file):
 *  each preset's location + name, plus the ADDITIVE opt-in enrichment (crcValid + scene names). */
export function am4BankFromBytes(bytes: number[]): OfflinePresetBank {
  const raw = Uint8Array.from(bytes);
  const dumps = raw.length > AM4_PRESET_FRAME_SIZE && raw.length % AM4_PRESET_FRAME_SIZE === 0
    ? parseAm4PresetBank(raw)
    : [parseAm4PresetDump(raw)];
  const presets = dumps.map((d, index) => {
    const l = am4DumpLocation(d);
    const enrich = am4DecodeEnrichment(d.raw); // null on a corrupt dump → omit the extra fields
    return {
      index,
      location: l.active ? null : (l.index ?? null),
      code: l.code ?? null,
      name: decodeAm4PresetNameFromFrame(d.raw),
      ...(enrich ? { sceneNames: enrich.sceneNames, crcValid: enrich.crcValid } : {}),
    };
  });
  return { count: presets.length, presets };
}
