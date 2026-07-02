// FM3 sub=0x2E calibration probe. Captures, on the SAME loaded preset:
//   (1) the GROUND-TRUTH grid via the validated dump decoder, and
//   (2) the raw sub=0x2E live-grid response bytes.
// Aligning (2) against (1) pins the FM3 (4-row) region offset/field layout that
// fractal-midi's parseGen3GridLayout doesn't have yet.
//
// Run: npm run probe:grid2e   (FM3 connected, port free — stop the bridge/ForgeFX server first)
import { buildRequestGridLayout, parseGen3GridLayout, buildRequestPresetDump } from 'forgefx-midi/gen3/axe-fx-iii';
import { FractalSerial } from '../transport/serial.js';
import { decodePresetDump } from '../codec/fm3PresetGrid.js';

const MODEL_FM3 = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function main() {
  const dev = new FractalSerial();
  console.log(`→ ${dev.path}`);
  await dev.open();

  // (1) ground truth from the dump decoder
  const dumpFrames = await dev.request(buildRequestPresetDump(0x3fff, MODEL_FM3), {
    timeoutMs: 5000,
    quietMs: 180,
    match: (fs) => fs.some((f) => f[5] === 0x79)
  });
  const d = decodePresetDump(dumpFrames, MODEL_FM3);
  console.log(`\n=== GROUND TRUTH grid: "${d.name}" (${d.rows}x${d.cols}, crc=${d.crcValid}) ===`);
  for (const c of [...d.grid].sort((a, b) => a.col - b.col || a.row - b.row)) {
    console.log(`  c${c.col} r${c.row}: eid=${c.effectId} ${c.name}${c.isShunt ? ' [shunt]' : ''} fromRows=[${c.fromRows.join(',')}]`);
  }

  // (2) raw sub=0x2E response
  const g = await dev.request(buildRequestGridLayout(MODEL_FM3), { timeoutMs: 2000 });
  const resp = g.find((f) => f[5] === 0x01 && f[6] === 0x2e) ?? g.sort((a, b) => b.length - a.length)[0];
  console.log(`\n=== sub=0x2E response: ${resp?.length ?? 0} bytes ===`);
  if (resp) {
    console.log('RAW:', hex(resp));
    try {
      const cells = parseGen3GridLayout(resp, MODEL_FM3);
      console.log(`(fractal-midi parse: ${cells.length} cells — likely wrong offset on FM3)`);
    } catch (e) {
      console.log('(fractal-midi parse threw:', (e as Error).message, '— expected; that is what we calibrate)');
    }
  }

  await dev.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
