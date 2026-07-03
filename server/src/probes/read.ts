// Quick read-path check against a live FM3: preset ref, grid, placed blocks.
// Run: npm run probe:read   (FM3 connected, port free)
import { registry } from '../drivers/registry.js';

const d = await registry.driver();
if (!d.presetRef || !d.placedBlocks) throw new Error('active driver has no gen-3 read surface');

const ref = await d.presetRef();
console.log('preset:', JSON.stringify(ref));

const g = await d.grid();
console.log(`grid: "${g.name}" crc=${g.crcValid} ${g.rows}x${g.cols} cells=${g.cells.length}`);
console.log('  blocks:', g.cells.filter((c) => !c.isShunt).map((c) => `c${c.col}r${c.row}:${c.name}`).join('  '));

const pb = await d.placedBlocks();
console.log('placedBlocks:', pb.length, pb.slice(0, 10).map((b) => `${b.slug}(${b.channel ?? '-'}${b.bypassed ? '/byp' : ''})`).join(' '));

process.exit(0);
