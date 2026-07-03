// Pure planning logic for free-tier preset-version sync (no I/O — unit-testable).
//
// The old sync was a set-difference push ("local not in remote → push"), which breaks under
// free-tier retention: pruned cloud rows would be re-pushed on the next sync because they still
// exist locally (local retention is 30/slot). Free-tier sync therefore RECONCILES the cloud to a
// target set:
//
//   target(free) = versions of the NEWEST full-backup group  ∪  the newest N non-backup snapshots
//   target(paid) = the whole union (yesterday's behavior, unchanged)
//
// Prune-guard (downgrade safety): remote rows outside the target are deleted ONLY when justified by
// new content of the same kind being pushed (a fresh backup replaces the old group; a new snapshot
// prunes beyond newest-N). A downgraded over-quota user who pushes nothing loses nothing.
export interface PlanVersion {
  id: string;
  capturedAt: number;
  source: string;          // 'manual' | 'auto' | 'backup'
  backupId: string | null;
  stored: number;          // compressed blob size
  blobPath: string;        // content-addressed → shared across versions; dedup all sums by this
  local: boolean;          // exists in the local version store
  remote: boolean;         // exists in the cloud table
}
export interface FreeLimits { maxStoredBytes: number; maxSnapshots: number; maxBackups: number }
export interface SyncPlan {
  push: string[];          // version ids to upload (blob + metadata)
  pruneRemote: string[];   // remote version ids to delete BEFORE pushing
  pruneBlobPaths: string[]; // blobs unreferenced by any surviving remote row after prune+push
  keptStoredBytes: number; // deduped post-sync usage (pre-flight against the cap)
  overCap: boolean;        // post-sync state would exceed the cap → caller must refuse before writing
}

const distinctSum = (vs: PlanVersion[]): number => {
  const seen = new Set<string>();
  let sum = 0;
  for (const v of vs) if (!seen.has(v.blobPath)) { seen.add(v.blobPath); sum += v.stored; }
  return sum;
};

export function planVersionSync(paid: boolean, limits: FreeLimits | null, versions: PlanVersion[]): SyncPlan {
  const finish = (push: PlanVersion[], prune: PlanVersion[], kept: PlanVersion[], cap: number | null): SyncPlan => {
    const keptStoredBytes = distinctSum(kept);
    const keptPaths = new Set(kept.map((v) => v.blobPath));
    const pruneBlobPaths = [...new Set(prune.map((v) => v.blobPath).filter((p) => !keptPaths.has(p)))];
    return { push: push.map((v) => v.id), pruneRemote: prune.map((v) => v.id), pruneBlobPaths, keptStoredBytes, overCap: cap != null && keptStoredBytes > cap };
  };

  if (paid || !limits) {
    // unlimited: push everything local-only, prune nothing
    return finish(versions.filter((v) => v.local && !v.remote), [], versions, null);
  }

  // ── free target set ──
  const backups = versions.filter((v) => v.source === 'backup' && v.backupId);
  const groupNewest = new Map<string, number>(); // backupId → max capturedAt
  for (const v of backups) groupNewest.set(v.backupId!, Math.max(groupNewest.get(v.backupId!) ?? 0, v.capturedAt));
  const newestGroup = [...groupNewest.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const snapshots = versions.filter((v) => v.source !== 'backup').sort((a, b) => b.capturedAt - a.capturedAt);
  const target = new Set<string>([
    ...backups.filter((v) => v.backupId === newestGroup).map((v) => v.id),
    ...snapshots.slice(0, limits.maxSnapshots).map((v) => v.id)
  ]);

  const push = versions.filter((v) => target.has(v.id) && v.local && !v.remote);
  // prune-guard: only prune the kinds we're actively pushing
  const pushingBackup = push.some((v) => v.source === 'backup');
  const pushingSnapshot = push.some((v) => v.source !== 'backup');
  const prune = versions.filter((v) =>
    v.remote && !target.has(v.id) &&
    (v.source === 'backup' ? pushingBackup : pushingSnapshot)
  );

  // post-sync remote state: (remote \ prune) ∪ push — the exact set the DB trigger will see
  const pruneIds = new Set(prune.map((v) => v.id));
  const kept = versions.filter((v) => (v.remote && !pruneIds.has(v.id)) || target.has(v.id) && v.local && !v.remote);
  return finish(push, prune, kept, limits.maxStoredBytes);
}
