// ForgeFX server test runner — mocked-transport unit tests, NO hardware required.
// Same style as forgefx-midi's test/run-all.ts: each suite exports a run*Tests() that throws on
// failure; the runner prints PASS/FAIL per suite and exits non-zero when anything failed.
//
// Run: npm test   (tsx test/run-all.ts)
import './helpers/env.js'; // MUST stay the first import: isolates ~/.forgefx-conn before transport/connection.ts loads
import { runDetectionTests, DETECTION_CASE_COUNT } from './drivers/detection.test.js';
import { runModelByteTests, MODELBYTE_CASE_COUNT } from './drivers/modelbyte.test.js';
import { runTablesTests, TABLES_CASE_COUNT } from './drivers/tables.test.js';
import { runAliasParityTests, ALIAS_PARITY_CASE_COUNT } from './api/alias-parity.test.js';
import { runCapsTests, CAPS_CASE_COUNT } from './api/caps.test.js';
import { runRemoteTests, REMOTE_CASE_COUNT } from './api/remote.test.js';
import { runLocalTests, LOCAL_CASE_COUNT } from './api/local.test.js';
import { runSyncPlanTests, SYNCPLAN_CASE_COUNT } from './api/syncplan.test.js';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  { name: `drivers/detection (${DETECTION_CASE_COUNT} cases, mocked Conn/Transport)`, run: runDetectionTests },
  { name: `drivers/modelbyte (${MODELBYTE_CASE_COUNT} cases, wrong-model-byte guard)`, run: runModelByteTests },
  { name: `drivers/tables (${TABLES_CASE_COUNT} identity checks, paramId cross-contamination guard)`, run: runTablesTests },
  { name: `api/alias-parity (${ALIAS_PARITY_CASE_COUNT} alias↔unified twins, mocked AM4)`, run: runAliasParityTests },
  { name: `api/caps (${CAPS_CASE_COUNT} device capability matrices)`, run: runCapsTests },
  { name: `api/remote (${REMOTE_CASE_COUNT} whitelist decisions)`, run: runRemoteTests },
  { name: `api/local (${LOCAL_CASE_COUNT} local-folder cases, temp root)`, run: runLocalTests },
  { name: `api/syncplan (${SYNCPLAN_CASE_COUNT} free-tier reconcile plans, pure)`, run: runSyncPlanTests }
];

let failures = 0;

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test suite(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test suite(s) passed.`);
process.exit(0); // detection tests may leave a just-cleared timer microtask behind — exit explicitly
