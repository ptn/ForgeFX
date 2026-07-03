// ForgeFX block & parameter help endpoint.
//
// Serves the curated "what does this do" copy (block summaries + param
// blurbs) that fractal-midi ships in its gen-3 help catalog. The catalog is
// keyed by param-family symbol + the editor symbol name (`Param.name`); this
// module resolves the active device's overrides on top of the shared text
// and re-keys param blurbs by paramId so the Axis editor (which holds
// paramIds, not symbol names) can look them up directly.
//
// Registered additively from app.ts via `registerHelpRoutes(app, registry)`.
// The DTO builders are PURE over a DeviceProfile (no registry import) so the
// browser-facing runtime router serves the identical help from the same code.
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
import { SLUG_FAMILY, type DeviceProfile } from './devices.js';

// Per-device resolved catalogs (shared text + device-flagged deltas), built
// once. Keyed by DeviceProfile.key.
const RESOLVED: Record<string, HelpCatalog> = {
  axe3: resolveHelp(GEN3_HELP, AXE_FX_III_HELP_OVERRIDES),
  fm3: resolveHelp(GEN3_HELP, FM3_HELP_OVERRIDES),
  fm9: resolveHelp(GEN3_HELP, FM9_HELP_OVERRIDES),
};

function catalogForDevice(profile: DeviceProfile): HelpCatalog {
  return RESOLVED[profile.key] ?? GEN3_HELP;
}

/** A block's family symbol from a slug (e.g. 'reverb' → 'REVERB'), else null. */
function familyForSlug(slug: string): string | null {
  return SLUG_FAMILY[slug.toLowerCase()] ?? null;
}

export interface BlockHelpDTO {
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
 * Build the help DTO for one family on the given device: block copy plus
 * param blurbs re-keyed by paramId (resolved against this device's param
 * catalog) and by symbol name. The common mix/level/bypass tail is filled
 * in for any catalog param the family-specific help doesn't cover.
 */
function buildBlockHelp(profile: DeviceProfile, slug: string, family: string): BlockHelpDTO | null {
  const catalog = catalogForDevice(profile);
  const defs = profile.params[family] ?? [];
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
    device: profile.key,
    summary: entry.block.summary,
    detail: entry.block.detail,
    params,
    paramsByName: entry.params,
  };
}

/** Help DTO for one block by slug, resolved for the given device — null when unknown/uncurated. */
export function blockHelpBySlug(profile: DeviceProfile, slug: string): BlockHelpDTO | null {
  const family = familyForSlug(slug);
  return family ? buildBlockHelp(profile, slug, family) : null;
}

/** Full help map for a device: { slug → BlockHelpDTO } for every block family with curated help. */
export function helpIndex(profile: DeviceProfile): { device: string; blocks: Record<string, BlockHelpDTO> } {
  const out: Record<string, BlockHelpDTO> = {};
  for (const [slug, family] of Object.entries(SLUG_FAMILY)) {
    const dto = buildBlockHelp(profile, slug, family);
    if (dto) out[slug] = dto;
  }
  return { device: profile.key, blocks: out };
}

export function registerHelpRoutes(app: FastifyInstance, registry: { readonly profile: DeviceProfile }): void {
  // Help for one block by slug (e.g. /help/blocks/reverb). Returns the block
  // summary/detail and its param blurbs (keyed by paramId AND symbol name)
  // resolved for the currently-selected device.
  app.get<{ Params: { slug: string } }>('/help/blocks/:slug', (req, reply) => {
    const slug = req.params.slug;
    const dto = blockHelpBySlug(registry.profile, slug);
    if (!dto) {
      reply.code(404);
      return { error: `no help for block "${slug}"` };
    }
    return dto;
  });

  // Full help map for the active device: lets Axis preload once.
  app.get('/help', () => helpIndex(registry.profile));
}
