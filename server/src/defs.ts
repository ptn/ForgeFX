// Loads ForgeFX's device-true definition packs (committed under /definitions):
//   fm3-<slug>.json   → { name, page (= base effect id), params:[{index,name,...}] }
//   names/<slug>.json → { block, count, models:[{value,name,manufacturer,basedOn}] }
// These are the catalog/rosters/param metadata; fractal-midi supplies the wire codec.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEF_DIR = process.env.FORGEFX_DEFINITIONS ?? resolve(HERE, '../../definitions');

export interface ParamDef {
  index: number;
  name: string;
  unit?: string;
  min?: number;
  max?: number;
  scale?: string;
  type?: string;
  options?: Record<string, string>;
}
export interface BlockPack {
  slug: string;
  name: string;
  page: number; // base effect id
  params: ParamDef[];
}
export interface TypeModel {
  value: number;
  name: string;
  manufacturer: string | null;
  basedOn: string | null;
}

const packs = new Map<string, BlockPack>(); // slug → pack
const rosters = new Map<string, TypeModel[]>(); // slug → models
const eidToSlug = new Map<number, string>(); // effect id (base..base+3) → slug

function load() {
  for (const f of readdirSync(DEF_DIR)) {
    if (!f.startsWith('fm3-') || !f.endsWith('.json')) continue;
    const slug = f.slice(4, -5); // fm3-<slug>.json
    if (slug === 'blocks' || slug === 'noise') continue;
    try {
      const j = JSON.parse(readFileSync(join(DEF_DIR, f), 'utf8'));
      if (typeof j.page !== 'number' || !Array.isArray(j.params)) continue;
      packs.set(slug, { slug, name: j.name ?? slug, page: j.page, params: j.params });
      for (let i = 0; i < 4; i++) eidToSlug.set(j.page + i, slug); // instances 1..4
    } catch {
      /* skip malformed */
    }
  }
  const namesDir = join(DEF_DIR, 'names');
  for (const f of readdirSync(namesDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(namesDir, f), 'utf8'));
      if (Array.isArray(j.models)) rosters.set(f.slice(0, -5), j.models);
    } catch {
      /* skip */
    }
  }
}
load();

export const allPacks = () => [...packs.values()];
export const packBySlug = (slug: string) => packs.get(slug.toLowerCase());
export const rosterBySlug = (slug: string) => rosters.get(slug.toLowerCase()) ?? [];
export const slugForEffectId = (eid: number) => eidToSlug.get(eid);
export const paramIndex = (slug: string, name: string) =>
  packBySlug(slug)?.params.find((p) => p.name.toLowerCase() === name.toLowerCase())?.index;
