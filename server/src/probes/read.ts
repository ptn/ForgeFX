// Quick read-path check against a live FM3: preset ref, grid, placed blocks.
// Run: npm run probe:read   (FM3 connected, port free)
import { device } from '../device.js';

const ref = await device.presetRef();
console.log('preset:', JSON.stringify(ref));

const g = await device.grid();
console.log(`grid: "${g.name}" crc=${g.crcValid} ${g.rows}x${g.cols} cells=${g.cells.length}`);
console.log('  blocks:', g.cells.filter((c) => !c.isShunt).map((c) => `c${c.col}r${c.row}:${c.name}`).join('  '));

const pb = await device.placedBlocks();
console.log('placedBlocks:', pb.length, pb.slice(0, 10).map((b) => `${b.slug}(${b.channel ?? '-'}${b.bypassed ? '/byp' : ''})`).join(' '));

process.exit(0);
