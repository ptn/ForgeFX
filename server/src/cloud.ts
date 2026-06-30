// Axis Cloud sync client (Supabase) — GATED. Only active when AXIS_CLOUD=1; otherwise ForgeFX never
// imports this module (index.ts dynamic-imports it behind the flag), so release builds ship it dark.
// ForgeFX is the sync client: the local store (store.ts) stays the source of truth, this pushes/pulls
// changed `config` documents (last-write-wins by updatedAt) to/from Supabase. Per-user isolation is
// enforced by RLS, so the public anon/publishable key is safe here. Preset-blob sync = a later step.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as store from './store.js';

// Env-only — no hardcoded instance. The hosted Axis build injects these at build/run time; self-hosters
// set them (e.g. in ForgeFX/server/.env, loaded by index.ts). Publishable key only; never a secret.
const URL = process.env.SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_ANON_KEY ?? '';
export const cloudEnabled = () => process.env.AXIS_CLOUD === '1' && !!URL && !!KEY;

// supabase-js persists the auth session via a Web Storage-like API; Node has none, so back it with the
// local store (one doc under the `cloud` collection). Sync get/set/remove is fine for our use.
const sessionStorage = {
  getItem: (k: string): string | null => (store.getDoc('cloud', k)?.data as string) ?? null,
  setItem: (k: string, v: string): void => { store.putDoc('cloud', k, v); },
  removeItem: (k: string): void => { store.delDoc('cloud', k); }
};

class Cloud {
  #client: SupabaseClient | null = null;
  #c(): SupabaseClient {
    if (!this.#client) this.#client = createClient(URL, KEY, {
      auth: { storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    return this.#client;
  }
  async register(email: string, password: string) {
    const { data, error } = await this.#c().auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    return { user: data.user ? { id: data.user.id, email: data.user.email } : null, needsConfirmation: !data.session };
  }
  async login(email: string, password: string) {
    const { data, error } = await this.#c().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return { user: { id: data.user.id, email: data.user.email } };
  }
  async logout() { await this.#c().auth.signOut(); return { ok: true }; }
  async status() {
    if (!cloudEnabled()) return { enabled: false, user: null };
    const { data } = await this.#c().auth.getUser();
    return { enabled: true, url: URL, user: data.user ? { id: data.user.id, email: data.user.email } : null };
  }

  /** Two-way last-write-wins sync of the `config` collection (tags/collections/favorites/savedFilters/
   *  layouts/swipe). Reconciles per doc by `updatedAt`: push the ones where local is newer/new, pull the
   *  ones where remote is newer/new. Tombstones (deleted) sync both ways. */
  async syncConfig() {
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) throw new Error('not logged in');

    const { data: remoteRows, error: rerr } = await c.from('documents').select('id,data,updated_at,rev,deleted').eq('collection', 'config');
    if (rerr) throw new Error(`pull: ${rerr.message}`);
    const remote = new Map((remoteRows ?? []).map((r) => [r.id as string, r]));
    const localAll = store.docsChangedSince('config', 0); // all local config docs, including tombstones

    // push: local newer than (or missing from) remote
    const toPush = localAll
      .filter((d) => { const r = remote.get(d.id); return !r || d.updatedAt > r.updated_at; })
      .map((d) => ({ user_id: user.id, collection: 'config', id: d.id, data: d.data, updated_at: d.updatedAt, rev: d.rev, deleted: !!d.deleted }));
    if (toPush.length) {
      const { error } = await c.from('documents').upsert(toPush, { onConflict: 'user_id,collection,id' });
      if (error) throw new Error(`push: ${error.message}`);
    }

    // pull: remote newer than (or missing from) local
    let pulled = 0;
    for (const r of remoteRows ?? []) {
      const localDoc = store.getDoc('config', r.id);
      if (!localDoc || r.updated_at > localDoc.updatedAt) { store.putDocRaw('config', r.id, r.data, r.updated_at, r.rev, !!r.deleted); pulled++; }
    }
    return { pushed: toPush.length, pulled };
  }

  /** Sync preset version snapshots: push local-only ones (blob → Storage, metadata → preset_versions),
   *  pull cloud-only ones (download blob → local store). Versions are immutable (id = location+crc+ts),
   *  so this is a simple set-difference, no LWW. This is what enables cloud-only presets + cross-device. */
  async syncVersions() {
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) throw new Error('not logged in');
    const bucket = c.storage.from('preset-blobs');

    const { data: remoteRows, error: rerr } = await c.from('preset_versions').select('*');
    if (rerr) throw new Error(`versions pull-list: ${rerr.message}`);
    const remoteIds = new Set((remoteRows ?? []).map((r) => r.id as string));

    let pushed = 0;
    for (const v of store.listPresetVersions()) {
      if (remoteIds.has(v.id)) continue; // immutable → already synced
      const packed = store.getPresetVersionPacked(v.id);
      if (!packed) continue;
      const path = `${user.id}/${v.location}/${v.id}.syx.br`;
      const { error: upErr } = await bucket.upload(path, packed, { upsert: true, contentType: 'application/octet-stream' });
      if (upErr) throw new Error(`blob upload: ${upErr.message}`);
      const { error: mErr } = await c.from('preset_versions').upsert({
        user_id: user.id, id: v.id, location: v.location, crc: v.crc, name: v.name, model: v.model,
        captured_at: v.capturedAt, source: v.source, backup_id: v.backupId ?? null, bytes: v.bytes, stored: v.stored, blob_path: path
      });
      if (mErr) throw new Error(`version meta: ${mErr.message}`);
      pushed++;
    }

    let pulled = 0;
    for (const r of remoteRows ?? []) {
      if (store.hasPresetVersion(r.id)) continue;
      const { data: blob, error: dErr } = await bucket.download(r.blob_path);
      if (dErr || !blob) continue;
      const packed = new Uint8Array(await blob.arrayBuffer());
      store.addVersionRaw({ id: r.id, location: r.location, crc: r.crc, name: r.name, model: r.model, capturedAt: r.captured_at, source: r.source, backupId: r.backup_id ?? undefined, bytes: r.bytes, stored: r.stored }, packed);
      pulled++;
    }
    return { pushed, pulled };
  }

  /** The cloud's view of every preset version this user has — metadata only (no blobs). Lets Axis
   *  compute each preset's sync state (synced / local-edit / cloud-newer / cloud-only) by cross-referencing
   *  device CRCs + local versions against what's actually backed up. Version ids are deterministic
   *  (location+crc+ts), so a local version is "in cloud" iff its id appears here. */
  async cloudIndex() {
    if (!cloudEnabled()) return { versions: [] };
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) return { versions: [] };
    const { data, error } = await c.from('preset_versions').select('id,location,crc,name,model,captured_at,source,bytes,stored');
    if (error) throw new Error(`cloud index: ${error.message}`);
    return {
      versions: (data ?? []).map((r) => ({
        id: r.id as string, location: r.location as number, crc: r.crc as number, name: r.name as string,
        model: r.model as string, capturedAt: r.captured_at as number, source: r.source as string,
        bytes: r.bytes as number, stored: r.stored as number
      }))
    };
  }

  /** Full sync: config + preset versions/blobs. `scopes` gates which halves run (per the account
   *  panel's sync toggles); omitted = both. `config` covers tags/collections/favorites/filters/layouts;
   *  `presets` covers version snapshots + blobs. */
  async sync(scopes?: { config?: boolean; presets?: boolean }) {
    const doConfig = scopes?.config ?? true;
    const doPresets = scopes?.presets ?? true;
    const config = doConfig ? await this.syncConfig() : { pushed: 0, pulled: 0 };
    const versions = doPresets ? await this.syncVersions() : { pushed: 0, pulled: 0 };
    return { config, versions };
  }
}

export const cloud = new Cloud();
