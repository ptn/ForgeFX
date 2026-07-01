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

/** Reject if a promise doesn't settle in time. storage-js runs its own fetch (no client timeout), so a
 *  stalled blob upload/download would otherwise hang the whole sync forever. */
function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

class Cloud {
  #client: SupabaseClient | null = null;
  #c(): SupabaseClient {
    if (!this.#client) this.#client = createClient(URL, KEY, {
      auth: {
        storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
        // supabase-js's default auth lock (navigatorLock/process lock) can DEADLOCK in a long-lived
        // Node process: a stalled token refresh holds the lock and every later getUser()/query waits
        // on it forever — surfacing as "signal timed out" with no recovery until restart. We're
        // single-process, so a passthrough lock is safe and removes the deadlock entirely.
        lock: <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>) => fn()
      },
      global: {
        // supabase-js has no fetch timeout — a stalled REST/Storage call would hang the request
        // forever. Cap each call so it fails fast + loud instead.
        fetch: (input: Parameters<typeof fetch>[0], init: RequestInit = {}) =>
          fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(15000) })
      }
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
  /** GDPR erasure (Art. 17): invoke the `delete-account` edge function (runs as service role, verifies
   *  the caller's JWT so a user can only delete themselves) to wipe the account + all its data, then
   *  sign out locally. */
  async deleteAccount() {
    const c = this.#c();
    const { data, error } = await c.functions.invoke('delete-account', { method: 'POST' });
    if (error) throw new Error(error.message ?? 'account deletion failed');
    await c.auth.signOut();
    return { ok: true, ...(data ?? {}) };
  }
  /** Read a user's subscription (RLS: they can only read their own; only the service role can write it, so
   *  the flag can't be spoofed client-side). `active` also honours an expiry if `current_period_end` is set.
   *  No row / no subscription → free tier. */
  async #subscription(userId: string): Promise<{ active: boolean; plan: string | null }> {
    try {
      const { data } = await this.#c().from('subscriptions').select('active,plan,current_period_end').eq('user_id', userId).maybeSingle();
      if (!data) return { active: false, plan: null };
      const notExpired = !data.current_period_end || new Date(data.current_period_end as string).getTime() > Date.now();
      return { active: !!data.active && notExpired, plan: (data.plan as string) ?? null };
    } catch { return { active: false, plan: null }; }
  }
  async status() {
    if (!cloudEnabled()) return { enabled: false, user: null };
    const { data } = await this.#c().auth.getUser();
    const user = data.user ? { id: data.user.id, email: data.user.email } : null;
    const subscription = user ? await this.#subscription(user.id) : { active: false, plan: null };
    return { enabled: true, url: URL, user, subscription };
  }

  /** For Axis Cloud Remote: the authed Supabase client + current user id (for the Realtime host channel),
   *  or null when cloud is off / signed out. The client carries the user's session, so its Realtime
   *  connection is authorized for that user's private channel. */
  async remoteSession(): Promise<{ client: SupabaseClient; userId: string } | null> {
    if (!cloudEnabled()) return null;
    const c = this.#c();
    const { data } = await c.auth.getUser();
    if (!data.user) return null;
    // Private Realtime channels authorize via RLS against the JWT — the socket must carry the user's
    // access token, or the authz check runs as anon and the channel errors. setAuth it explicitly (a
    // session loaded from storage doesn't fire the sign-in event that would set it automatically).
    const { data: s } = await c.auth.getSession();
    if (s.session?.access_token) { try { await c.realtime.setAuth(s.session.access_token); } catch { /* */ } }
    return { client: c, userId: data.user.id };
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

    console.log('[cloud] syncVersions: listing remote…');
    const { data: remoteRows, error: rerr } = await c.from('preset_versions').select('*');
    if (rerr) throw new Error(`versions pull-list: ${rerr.message}`);
    const remoteIds = new Set((remoteRows ?? []).map((r) => r.id as string));
    const local = store.listPresetVersions();
    console.log(`[cloud] syncVersions: ${remoteIds.size} remote, ${local.length} local`);

    // A full-device backup creates 100+ versions; the first sync must push them all. Do it in
    // concurrent batches (instead of one-at-a-time) so a fresh backup syncs in seconds, not minutes.
    // A full-device backup creates many version records, but content-addressed blobs mean unchanged
    // presets share one blob — upload each unique hash once. Concurrent batches keep it fast.
    const toPush = local.filter((v) => !remoteIds.has(v.id));
    console.log(`[cloud] syncVersions: pushing ${toPush.length} new version record(s)`);
    let pushed = 0;
    const uploaded = new Set<string>(); // hashes already uploaded this run → skip duplicate blob writes
    const blobPath = (hash: string) => `${user.id}/blobs/${hash}.syx.br`;
    const CONCURRENCY = 6;
    for (let i = 0; i < toPush.length; i += CONCURRENCY) {
      await Promise.all(toPush.slice(i, i + CONCURRENCY).map(async (v) => {
        const path = blobPath(v.hash);
        if (!uploaded.has(v.hash)) {
          uploaded.add(v.hash);
          const packed = store.getPresetVersionPacked(v.id);
          if (packed) {
            const { error: upErr } = await withTimeout(bucket.upload(path, packed, { upsert: true, contentType: 'application/octet-stream' }), 20000, `blob upload ${v.hash}`);
            if (upErr) throw new Error(`blob upload: ${upErr.message}`);
          }
        }
        const { error: mErr } = await c.from('preset_versions').upsert({
          user_id: user.id, id: v.id, location: v.location, crc: v.crc, name: v.name, model: v.model,
          captured_at: v.capturedAt, source: v.source, backup_id: v.backupId ?? null, bytes: v.bytes, stored: v.stored, blob_path: path
        });
        if (mErr) throw new Error(`version meta: ${mErr.message}`);
        pushed++;
      }));
      console.log(`[cloud] syncVersions: pushed ${pushed}/${toPush.length}`);
    }

    let pulled = 0;
    for (const r of remoteRows ?? []) {
      if (store.hasPresetVersion(r.id)) continue;
      // blob_path is `<uid>/blobs/<hash>.syx.br` — recover the content hash from it.
      const hash = String(r.blob_path).split('/').pop()?.replace(/\.syx\.br$/, '') ?? '';
      const { data: blob, error: dErr } = await withTimeout(bucket.download(r.blob_path), 20000, `blob download ${r.id}`);
      if (dErr || !blob) continue;
      const packed = new Uint8Array(await blob.arrayBuffer());
      store.addVersionRaw({ id: r.id, location: r.location, crc: r.crc, hash, name: r.name, model: r.model, capturedAt: r.captured_at, source: r.source, backupId: r.backup_id ?? undefined, bytes: r.bytes, stored: r.stored }, packed);
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
    // Preset-blob sync is a paid-tier feature. Enforce it here (not just in the UI): even if the client
    // asks for presets, only run it for an active subscriber. Free tier = config only.
    const user = (await this.#c().auth.getUser()).data.user;
    const sub = user ? await this.#subscription(user.id) : { active: false, plan: null };
    const doPresets = (scopes?.presets ?? true) && sub.active;
    console.log(`[cloud] sync: start (config=${doConfig} presets=${doPresets} plan=${sub.plan ?? 'free'})`);
    const config = doConfig ? await this.syncConfig() : { pushed: 0, pulled: 0 };
    console.log('[cloud] sync: config done, versions…');
    const versions = doPresets ? await this.syncVersions() : { pushed: 0, pulled: 0 };
    console.log('[cloud] sync: done');
    return { config, versions };
  }
}

export const cloud = new Cloud();
