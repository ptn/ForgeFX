// ForgeFX block & parameter help endpoint.
//
// Serves the curated "what does this do" copy (block summaries + param
// blurbs) that fractal-midi ships in its gen-3 help catalog. The catalog is
// keyed by param-family symbol + the editor symbol name (`Param.name`); this
// module resolves the active device's overrides on top of the shared text
// and re-keys param blurbs by paramId so the Axis editor (which holds
// paramIds, not symbol names) can look them up directly.
//
// Registered additively from index.ts via `registerHelpRoutes(app)`.
import type { FastifyInstance } from 'fastify';
import {
  GEN3_HELP,
  resolveHelp,
  blockHelpFor,
  FM3_HELP_OVERRIDES,
  type HelpCatalog,
  type ParamHelp,
} from 'forgefx-midi/gen3/fm3';
import { FM9_HELP_OVERRIDES } from 'forgefx-midi/gen3/fm9';
import { AXE_FX_III_HELP_OVERRIDES } from 'forgefx-midi/gen3/axe-fx-iii';
import { registry } from './drivers/registry.js';
import { SLUG_FAMILY } from './devices.js';

// Per-device resolved catalogs (shared text + device-flagged deltas), built
// once. Keyed by DeviceProfile.key.
const RESOLVED: Record<string, HelpCatalog> = {
  axe3: resolveHelp(GEN3_HELP, AXE_FX_III_HELP_OVERRIDES),
  fm3: resolveHelp(GEN3_HELP, FM3_HELP_OVERRIDES),
  fm9: resolveHelp(GEN3_HELP, FM9_HELP_OVERRIDES),
};

function catalogForActiveDevice(): HelpCatalog {
  return RESOLVED[registry.profile.key] ?? GEN3_HELP;
}

/** A block's family symbol from a slug (e.g. 'reverb' → 'REVERB'), else null. */
function familyForSlug(slug: string): string | null {
  return SLUG_FAMILY[slug.toLowerCase()] ?? null;
}

interface BlockHelpDTO {
  /** family symbol, e.g. 'REVERB' */
  family: string;
  /** slug as requested, e.g. 'reverb' */
  slug: string;
  /** active device key the help was resolved for */
  device: string;
  summary: string;
  detail?: string;
  /** param help keyed by paramId (number→blurb), for the Axis editor */
  params: Record<number, ParamHelp>;
  /** param help also keyed by the editor symbol name (e.g. 'REVERB_TIME') */
  paramsByName: Record<string, ParamHelp>;
}

/**
 * Build the help DTO for one family on the active device: block copy plus
 * param blurbs re-keyed by paramId (resolved against this device's param
 * catalog) and by symbol name. The common mix/level/bypass tail is filled
 * in for any catalog param the family-specific help doesn't cover.
 */
function buildBlockHelp(slug: string, family: string): BlockHelpDTO | null {
  const catalog = catalogForActiveDevice();
  const defs = registry.profile.params[family] ?? [];
  const entry = blockHelpFor(catalog, family, defs.map((d) => d.name));
  if (!entry) return null;
  const params: Record<number, ParamHelp> = {};
  for (const d of defs) {
    const h = entry.params[d.name];
    if (h) params[d.paramId] = h;
  }
  return {
    family,
    slug,
    device: registry.profile.key,
    summary: entry.block.summary,
    detail: entry.block.detail,
    params,
    paramsByName: entry.params,
  };
}

export function registerHelpRoutes(app: FastifyInstance): void {
  // Help for one block by slug (e.g. /help/blocks/reverb). Returns the block
  // summary/detail and its param blurbs (keyed by paramId AND symbol name)
  // resolved for the currently-selected device.
  app.get<{ Params: { slug: string } }>('/help/blocks/:slug', (req, reply) => {
    const slug = req.params.slug;
    const family = familyForSlug(slug);
    if (!family) {
      reply.code(404);
      return { error: `no help for block "${slug}"` };
    }
    const dto = buildBlockHelp(slug, family);
    if (!dto) {
      reply.code(404);
      return { error: `no help for block "${slug}"` };
    }
    return dto;
  });

  // Full help map for the active device: { slug → BlockHelpDTO } for every
  // block family that has curated help. Lets Axis preload once.
  app.get('/help', () => {
    const out: Record<string, BlockHelpDTO> = {};
    for (const [slug, family] of Object.entries(SLUG_FAMILY)) {
      const dto = buildBlockHelp(slug, family);
      if (dto) out[slug] = dto;
    }
    return { device: registry.profile.key, blocks: out };
  });
}
