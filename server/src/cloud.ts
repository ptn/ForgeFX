// Axis Cloud sync client (Supabase) — GATED. Only active when AXIS_CLOUD=1; otherwise ForgeFX never
// imports this module (index.ts dynamic-imports it behind the flag), so release builds ship it dark.
// ForgeFX is the sync client: the local store (store.ts) stays the source of truth, this pushes/pulls
// changed `config` documents (last-write-wins by updatedAt) and preset versions/blobs to/from Supabase.
// Per-user isolation is enforced by RLS, so the public anon/publishable key is safe here. Free-tier
// preset sync is quota-limited (reconcile-to-target — see syncPlan.ts); paid = unlimited.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as store from './store.js';
import { planVersionSync, type FreeLimits, type PlanVersion } from './syncPlan.js';

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
  /** Free-tier quota readout via the preset_quota() RPC (deployed with the quota migration). Null when
   *  signed out or the server predates the migration — callers treat null as "no quota UI, no limits". */
  async quota(): Promise<{ paid: boolean; usedBytes: number; snapshots: number; backups: number; limits: FreeLimits | null } | null> {
    try {
      const { data, error } = await this.#c().rpc('preset_quota');
      if (error || !data) return null;
      const q = data as { paid: boolean; usedBytes: number; snapshots: number; backups: number; limits: { max_stored_bytes: number; max_snapshots: number; max_backups: number } | null };
      return {
        paid: !!q.paid, usedBytes: q.usedBytes ?? 0, snapshots: q.snapshots ?? 0, backups: q.backups ?? 0,
        limits: q.limits ? { maxStoredBytes: q.limits.max_stored_bytes, maxSnapshots: q.limits.max_snapshots, maxBackups: q.limits.max_backups } : null
      };
    } catch { return null; }
  }
  async status() {
    if (!cloudEnabled()) return { enabled: false, user: null };
    const { data } = await this.#c().auth.getUser();
    const user = data.user ? { id: data.user.id, email: data.user.email } : null;
    const subscription = user ? await this.#subscription(user.id) : { active: false, plan: null };
    const quota = user ? await this.quota() : null;
    return { enabled: true, url: URL, user, subscription, quota };
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

  /** Sync preset version snapshots: reconcile the cloud to a TARGET SET (see syncPlan.ts) — paid =
   *  the whole local∪remote union (set-difference push, unchanged behavior); free = the newest
   *  full-backup group + the newest N snapshots, pruning replaced remote rows first (the DB trigger
   *  rejects a second backup group until the old one is gone). Versions are immutable
   *  (id = location+crc+ts), so no LWW is needed. Pull is unlimited for everyone — quota is push-only. */
  async syncVersions(paid: boolean) {
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) throw new Error('not logged in');
    const bucket = c.storage.from('preset-blobs');
    const blobPath = (hash: string) => `${user.id}/blobs/${hash}.syx.br`;

    console.log('[cloud] syncVersions: listing remote…');
    const { data: remoteRows, error: rerr } = await c.from('preset_versions').select('*');
    if (rerr) throw new Error(`versions pull-list: ${rerr.message}`);
    const local = store.listPresetVersions();
    console.log(`[cloud] syncVersions: ${remoteRows?.length ?? 0} remote, ${local.length} local`);

    // Union view for the planner (dedup all size accounting by blob_path — content-addressed blobs
    // are shared across versions). RPC failure (server predates the quota migration) → no limits.
    const limits = paid ? null : ((await this.quota())?.limits ?? null);
    const byId = new Map<string, PlanVersion>();
    for (const v of local) byId.set(v.id, { id: v.id, capturedAt: v.capturedAt, source: v.source, backupId: v.backupId ?? null, stored: v.stored, blobPath: blobPath(v.hash), local: true, remote: false });
    for (const r of remoteRows ?? []) {
      const prev = byId.get(r.id as string);
      if (prev) prev.remote = true;
      else byId.set(r.id as string, { id: r.id, capturedAt: r.captured_at, source: r.source, backupId: r.backup_id ?? null, stored: r.stored, blobPath: r.blob_path, local: false, remote: true });
    }
    const plan = planVersionSync(paid || !limits, limits, [...byId.values()]);
    if (plan.overCap) {
      const mb = (limits!.maxStoredBytes / 1048576).toFixed(0);
      throw new Error(`Cloud storage full — the free plan includes ${mb} MB of preset storage. Delete old snapshots or upgrade.`);
    }

    // 1 — prune replaced remote rows FIRST (the quota trigger admits a new backup group only after
    // the old group's rows are gone), then their now-unreferenced blobs. RLS scopes deletes to us.
    if (plan.pruneRemote.length) {
      console.log(`[cloud] syncVersions: pruning ${plan.pruneRemote.length} replaced remote version(s)`);
      for (let i = 0; i < plan.pruneRemote.length; i += 200) {
        const { error } = await c.from('preset_versions').delete().eq('user_id', user.id).in('id', plan.pruneRemote.slice(i, i + 200));
        if (error) throw new Error(`prune: ${error.message}`);
      }
      for (let i = 0; i < plan.pruneBlobPaths.length; i += 100) {
        const { error } = await withTimeout(bucket.remove(plan.pruneBlobPaths.slice(i, i + 100)), 20000, 'blob prune');
        if (error) console.warn(`[cloud] blob prune: ${error.message}`); // orphans are swept by gc-blobs
      }
    }

    // 2 — push. A full-device backup creates 100+ versions; content-addressed blobs mean unchanged
    // presets share one blob (upload each unique hash once), and concurrent batches keep it fast.
    const localById = new Map(local.map((v) => [v.id, v]));
    const toPush = plan.push.map((id) => localById.get(id)!).filter(Boolean);
    console.log(`[cloud] syncVersions: pushing ${toPush.length} new version record(s)`);
    let pushed = 0;
    const uploaded = new Set<string>(); // hashes already uploaded this run → skip duplicate blob writes
    const CONCURRENCY = 6;
    const friendlyQuota = (msg: string): string =>
      msg.includes('quota:storage') ? 'Cloud storage full — free plan limit reached. Delete old snapshots or upgrade.'
      : msg.includes('quota:backups') ? 'The free plan keeps one full backup — another device may be syncing right now; try again in a moment.'
      : msg.includes('quota:snapshots') ? 'Snapshot limit reached on the free plan. Delete old snapshots or upgrade.'
      : msg;
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
        if (mErr) throw new Error(friendlyQuota(mErr.message)); // quota:* = the DB backstop (pre-flight normally prevents this)
        pushed++;
      }));
      console.log(`[cloud] syncVersions: pushed ${pushed}/${toPush.length}`);
    }

    // 3 — pull cloud-only versions (skipping the ones we just pruned). Unlimited for every tier.
    const prunedIds = new Set(plan.pruneRemote);
    let pulled = 0;
    for (const r of remoteRows ?? []) {
      if (prunedIds.has(r.id as string) || store.hasPresetVersion(r.id)) continue;
      // blob_path is `<uid>/blobs/<hash>.syx.br` — recover the content hash from it.
      const hash = String(r.blob_path).split('/').pop()?.replace(/\.syx\.br$/, '') ?? '';
      const { data: blob, error: dErr } = await withTimeout(bucket.download(r.blob_path), 20000, `blob download ${r.id}`);
      if (dErr || !blob) continue;
      const packed = new Uint8Array(await blob.arrayBuffer());
      store.addVersionRaw({ id: r.id, location: r.location, crc: r.crc, hash, name: r.name, model: r.model, capturedAt: r.captured_at, source: r.source, backupId: r.backup_id ?? undefined, bytes: r.bytes, stored: r.stored }, packed);
      pulled++;
    }
    return { pushed, pulled, pruned: plan.pruneRemote.length };
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
    // Preset sync is open to every tier since 0.7.1 — the free tier is quota-limited (3 MB / 1 full
    // backup / N snapshots), enforced by syncVersions' reconcile-to-target plan client-side and the
    // preset_quota DB trigger as the server backstop. Paid = unlimited (yesterday's behavior).
    const user = (await this.#c().auth.getUser()).data.user;
    const sub = user ? await this.#subscription(user.id) : { active: false, plan: null };
    const doPresets = scopes?.presets ?? true;
    console.log(`[cloud] sync: start (config=${doConfig} presets=${doPresets} plan=${sub.plan ?? 'free'} paid=${sub.active})`);
    const config = doConfig ? await this.syncConfig() : { pushed: 0, pulled: 0 };
    console.log('[cloud] sync: config done, versions…');
    const versions = doPresets ? await this.syncVersions(sub.active) : { pushed: 0, pulled: 0, pruned: 0 };
    console.log('[cloud] sync: done');
    return { config, versions };
  }
}

export const cloud = new Cloud();
