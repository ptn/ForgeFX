// Axis Cloud sync client (Supabase) — GATED. Only active when AXIS_CLOUD=1; otherwise ForgeFX never
// imports this module (index.ts dynamic-imports it behind the flag), so release builds ship it dark.
// ForgeFX is the sync client: the local store (store.ts) stays the source of truth, this pushes/pulls
// changed `config` documents (last-write-wins by updatedAt) to/from Supabase. Per-user isolation is
// enforced by RLS, so the public anon/publishable key is safe here. Preset-blob sync = a later step.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as store from './store.js';

const URL = process.env.SUPABASE_URL ?? 'https://zvhnpuafgytyapaqatcg.supabase.co';
const KEY = process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_jpDgqVy8gEpvL4ATrcD1Lg_Okvsc_aJ';
export const cloudEnabled = () => process.env.AXIS_CLOUD === '1';

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
}

export const cloud = new Cloud();
