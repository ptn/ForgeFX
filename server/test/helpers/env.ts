// MUST be imported FIRST by test/run-all.ts (before any suite pulls in transport/connection.ts):
// connection.ts reads its override file (~/.forgefx-conn by default) at module-load time and the
// tests call setConnOverride/setProfileOverride, which PERSIST. Point the override file at a
// throwaway path so the tests never read or clobber the user's real connection override.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FORGEFX_PORT_FILE = join(tmpdir(), `forgefx-test-conn-${process.pid}.json`);
// The API suites build the full Fastify app (buildApp), which loads store.ts — point its data dir
// at a throwaway path so tests never read or write the user's real ~/.axis store.
process.env.FORGEFX_DATA_DIR = join(tmpdir(), `forgefx-test-data-${process.pid}`);
// Make sure an ambient device-profile override can't leak into the detection tests.
delete process.env.FORGEFX_DEVICE;
// Keep the app quiet + hermetic in tests: no cloud routes, no static SPA handler, terse logs.
delete process.env.AXIS_CLOUD;
delete process.env.FORGEFX_STATIC;
process.env.LOG_LEVEL ??= 'silent';
