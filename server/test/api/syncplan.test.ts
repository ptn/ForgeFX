// Free-tier sync planning (syncPlan.ts) — pure-function tests, no network. Covers: paid passthrough,
// newest-backup-group + newest-N-snapshot targeting, prune-guard on downgrade (nothing deleted unless
// new content of the same kind is pushed), blob-shared-across-prune survival, deduped cap pre-flight.
import { planVersionSync, type PlanVersion, type FreeLimits } from '../../src/syncPlan.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const SYNCPLAN_CASE_COUNT = 7;

const LIM: FreeLimits = { maxStoredBytes: 3145728, maxSnapshots: 5, maxBackups: 1 };
let seq = 0;
const v = (o: Partial<PlanVersion> & { id: string }): PlanVersion => ({
  capturedAt: ++seq, source: 'manual', backupId: null, stored: 4000,
  blobPath: `u/blobs/${o.id}.syx.br`, local: false, remote: false, ...o
});
const ids = (a: string[]) => [...a].sort().join(',');

export function runSyncPlanTests(): void {
  // 1 — paid: set-difference push, nothing pruned, no cap
  {
    const p = planVersionSync(true, LIM, [
      v({ id: 'a', local: true }), v({ id: 'b', local: true, remote: true }), v({ id: 'c', remote: true, stored: 99999999 })
    ]);
    assertEqual(ids(p.push), 'a', 'paid pushes local-only');
    assertEqual(p.pruneRemote.length, 0, 'paid prunes nothing');
    assertEqual(p.overCap, false, 'paid has no cap');
  }

  // 2 — free: newest 5 snapshots targeted; pushing a new one prunes the oldest remote
  {
    const vs = [1, 2, 3, 4, 5].map((i) => v({ id: `s${i}`, local: true, remote: true }));
    vs.push(v({ id: 's6', local: true })); // new local snapshot (newest capturedAt)
    const p = planVersionSync(false, LIM, vs);
    assertEqual(ids(p.push), 's6', 'new snapshot pushed');
    assertEqual(ids(p.pruneRemote), 's1', 'oldest remote snapshot pruned');
    assert(p.pruneBlobPaths.includes('u/blobs/s1.syx.br'), 'pruned blob scheduled for removal');
  }

  // 3 — prune-guard: 6 remote snapshots, nothing new to push → nothing pruned (downgrade safety)
  {
    const vs = [1, 2, 3, 4, 5, 6].map((i) => v({ id: `s${i}`, remote: true }));
    const p = planVersionSync(false, LIM, vs);
    assertEqual(p.push.length, 0, 'nothing to push');
    assertEqual(p.pruneRemote.length, 0, 'downgraded user loses nothing');
  }

  // 4 — new full backup replaces the old remote group
  {
    const vs = [
      v({ id: 'oldA', source: 'backup', backupId: 'bk-old', remote: true }),
      v({ id: 'oldB', source: 'backup', backupId: 'bk-old', remote: true }),
      v({ id: 'newA', source: 'backup', backupId: 'bk-new', local: true }),
      v({ id: 'newB', source: 'backup', backupId: 'bk-new', local: true })
    ];
    const p = planVersionSync(false, LIM, vs);
    assertEqual(ids(p.push), 'newA,newB', 'new group pushed');
    assertEqual(ids(p.pruneRemote), 'oldA,oldB', 'old group pruned');
  }

  // 5 — blob shared between a pruned backup row and a surviving snapshot must NOT be deleted
  {
    const vs = [
      v({ id: 'oldA', source: 'backup', backupId: 'bk-old', remote: true, blobPath: 'u/blobs/shared.syx.br' }),
      v({ id: 'snap', local: true, remote: true, blobPath: 'u/blobs/shared.syx.br' }),
      v({ id: 'newA', source: 'backup', backupId: 'bk-new', local: true })
    ];
    const p = planVersionSync(false, LIM, vs);
    assertEqual(ids(p.pruneRemote), 'oldA', 'old group row pruned');
    assertEqual(p.pruneBlobPaths.length, 0, 'shared blob survives the prune');
  }

  // 6 — cap pre-flight: post-sync state over the cap → overCap, deduped by blob
  {
    const half = Math.ceil(LIM.maxStoredBytes / 2);
    const over = planVersionSync(false, LIM, [
      v({ id: 'a', local: true, stored: half }), v({ id: 'b', local: true, stored: half + 10 })
    ]);
    assertEqual(over.overCap, true, 'two big blobs exceed the cap');
    const dedup = planVersionSync(false, LIM, [
      v({ id: 'a', local: true, stored: half, blobPath: 'u/blobs/same.syx.br' }),
      v({ id: 'b', local: true, stored: half, blobPath: 'u/blobs/same.syx.br' })
    ]);
    assertEqual(dedup.overCap, false, 'shared blob counted once');
    assertEqual(dedup.keptStoredBytes, half, 'deduped sum');
  }

  // 7 — free with NO limits row (server predates the migration) → unlimited passthrough
  {
    const p = planVersionSync(false, null, [v({ id: 'a', local: true, stored: 99999999 })]);
    assertEqual(ids(p.push), 'a', 'no limits → push');
    assertEqual(p.overCap, false, 'no limits → no cap');
  }
}
