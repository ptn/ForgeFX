// Sweep the sub=0x4b name-table SELECTOR (frame byte 13) against a live FM3 to
// map selector -> name table, specifically to find the cab IR bank selectors
// (FACTORY 1/2, USER, LEGACY, SCRATCHPAD). Reads index 0..2 of each selector so
// a bank is identifiable from its first few IR names.
// Run: npm run probe:cabirs   (FM3 connected, ForgeFX stopped — it owns the port)
import { FractalSerial } from '../transport/serial.js';

const MODEL = 0x11;
const FN = 0x01;
const SUB = 0x4b;

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

function checksum(frame: readonly number[]): number {
  let acc = 0;
  for (const b of frame) acc ^= b;
  return acc & 0x7f;
}

function buildRead(selector: number, index: number): number[] {
  const f = [
    0xf0, 0x00, 0x01, 0x74, MODEL, FN, SUB, 0x00, 0x00, 0x00, 0x00, 0x00,
    index & 0x7f, selector & 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  f.push(checksum(f), 0xf7);
  return f;
}

function unpackChunked(wire: readonly number[], rawLen: number): Uint8Array {
  const out = new Uint8Array(rawLen);
  let rawPos = 0;
  let wirePos = 0;
  while (rawPos < rawLen) {
    const remainingRaw = rawLen - rawPos;
    const thisChunkRaw = Math.min(7, remainingRaw);
    const thisChunkWire = thisChunkRaw === 7 ? 8 : thisChunkRaw + 1;
    const chunk = wire.slice(wirePos, wirePos + thisChunkWire);
    for (let i = 0; i < chunk.length; i++) {
      const k = i + 1;
      const b = chunk[i]! & 0x7f;
      if (i > 0 && i - 1 < thisChunkRaw) out[rawPos + i - 1]! |= ((~(0x7f >> k) & b) >> (8 - k)) & 0xff;
      if (i < thisChunkRaw) out[rawPos + i] = (b << k) & 0xff;
    }
    rawPos += thisChunkRaw;
    wirePos += thisChunkWire;
  }
  return out;
}

function nameOf(frame: readonly number[]): string {
  const tc = (frame[19]! & 0x7f) | ((frame[20]! & 0x7f) << 7);
  const rawLen = Math.min(tc > 0 ? tc : 32, 32);
  const raw = unpackChunked(frame.slice(21, frame.length - 2), rawLen);
  let s = '';
  for (const c of raw) {
    if (c === 0) break; // NUL-terminated; stop at the end of the actual name
    s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ' ';
  }
  return s.replace(/\s+$/, '');
}

async function main() {
  const dev = new FractalSerial();
  await dev.open();
  console.log(`→ ${dev.path} open; sweeping selector 0x20..0x4f (index 0,1,2) to find SCRATCHPAD/other tables`);
  for (let sel = 0x20; sel <= 0x4f; sel++) {
    const names: string[] = [];
    for (const idx of [0, 1, 2]) {
      try {
        const frames = await dev.request(buildRead(sel, idx), {
          timeoutMs: 900,
          quietMs: 40,
          match: (fs) => fs.some((f) => f[5] === FN && f[6] === SUB),
        });
        const resp = frames.find((f) => f[5] === FN && f[6] === SUB);
        names.push(resp ? nameOf(resp) : '(no reply)');
      } catch (e) {
        names.push(`ERR ${(e as Error).message}`);
      }
    }
    const uniq = [...new Set(names)];
    if (uniq.length !== 1 || uniq[0] !== '') {
      console.log(`sel=0x${sel.toString(16).padStart(2, '0')}  ->  ${uniq.join('  ||  ')}`);
    }
  }
  await dev.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
