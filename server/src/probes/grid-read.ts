// FM3 live grid-read probe (fn=0x01 sub=0x2E).
//
// fractal-midi's parseGen3GridLayout is FM9-validated but FM3-UNTESTED (FM3 has 4
// grid rows vs 6, so the bit-region offset may differ). This probe runs it against
// a real FM3 and prints both the decoded cells and the raw response so we can
// confirm it — or capture the bytes needed to fix the FM3 offset upstream.
//
// Run:  npm run probe:grid     (FM3 connected, bridge stopped, port free)
import {
  buildRequestGridLayout,
  parseGen3GridLayout,
  buildQueryPatchName,
  AXE_FX_III_MODEL_ID
} from 'forgefx-midi/gen3/axe-fx-iii';
import { FractalSerial } from '../transport/serial.js';

const MODEL_FM3 = 0x11;
void AXE_FX_III_MODEL_ID; // (0x10) — we target FM3 explicitly

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function main() {
  const dev = new FractalSerial();
  console.log(`→ opening ${dev.path}`);
  await dev.open();

  // 1) prove I/O with a patch-name query
  try {
    const nameFrames = await dev.request(buildQueryPatchName('current', MODEL_FM3), { timeoutMs: 1200 });
    console.log(`patch-name query: ${nameFrames.length} frame(s), first ${nameFrames[0]?.length ?? 0} bytes`);
  } catch (e) {
    console.log('patch-name query failed:', (e as Error).message);
  }

  // 2) the live grid read
  console.log('→ requesting grid layout (sub=0x2E)…');
  const frames = await dev.request(buildRequestGridLayout(MODEL_FM3), { timeoutMs: 2000 });
  const resp = frames.find((f) => f[5] === 0x01 && f[6] === 0x2e) ?? frames.sort((a, b) => b.length - a.length)[0];

  if (!resp) {
    console.log('✗ no response frame. Frames received:', frames.length);
    await dev.close();
    return;
  }
  console.log(`response: ${resp.length} bytes`);
  console.log('raw:', hex(resp));

  try {
    const cells = parseGen3GridLayout(resp, MODEL_FM3);
    console.log(`\n✓ parsed ${cells.length} occupied cell(s):`);
    for (const c of cells.sort((a, b) => a.col - b.col || a.row - b.row)) {
      const what = c.isShunt ? `shunt#${c.shuntIndex}` : `block eid=${c.effectId}`;
      const mask = c.cableInputMask ? ` ◄ inMask=0b${c.cableInputMask.toString(2).padStart(4, '0')}` : '';
      console.log(`  [r${c.row} c${c.col}] ${what}${mask}`);
    }
    console.log('\nCompare these against the FM3 front panel. If positions/eids are shifted,');
    console.log('the raw bytes above are what we send upstream to fix the FM3 region offset.');
  } catch (e) {
    console.log('\n✗ parseGen3GridLayout threw:', (e as Error).message);
    console.log('→ the raw frame above is the capture needed to calibrate FM3 (4-row) offsets.');
  }

  await dev.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
