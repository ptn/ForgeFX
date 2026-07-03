// Small shared route services — logic used identically by the Fastify app (app.ts) and the
// browser-facing runtime router (runtime/router.ts). NO node:/fastify imports here.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import type { Store } from './store.js';
import type { Doc } from './storeBackend.js';

/** Persist a store document and, for `config` docs, fan the write out to every live UI (host SSE /
 *  router subscribers + remote relay) so shared layouts/quick-actions/arrange sync both directions in
 *  real time. `origin` lets the writer ignore its own echo. The library index is excluded — it's
 *  large and isn't a live-applied doc (remotes pull it once at connect). */
export function putStoreDoc(store: Store, registry: DeviceRegistry, collection: string, id: string, data: unknown, origin?: string): Doc {
  const doc = store.putDoc(collection, id, data);
  if (collection === 'config' && id !== 'library') registry.broadcastConfig(id, data, origin);
  return doc;
}
