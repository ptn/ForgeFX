// Gen-3 SysEx frame helpers (F0 00 01 74 <model> <fn> <sub> <sub2> …payload… cs F7). The read paths
// in gen3.ts each rebuilt this shape locally; one copy keeps the framing/checksum consistent.
//
// NOTE: `enc14` deliberately truncates to 14 bits. The forgefx-midi package's own helper throws on
// overflow, but the driver historically truncates here, so this must NOT be swapped for the package
// export without changing behavior.

/** Encode a number as two little-endian 7-bit bytes (14-bit, truncating). */
export function enc14(n: number): number[] { return [n & 0x7f, (n >> 7) & 0x7f]; }

/** Unpack a 5×7-bit little-endian packed float32 (the gen-3 read response value). */
export function unpackF32(b: number[]): number {
  const v = ((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0;
  return new Float32Array(new Uint32Array([v]).buffer)[0]!;
}

/** Build a gen-3 frame: 7-byte header + `sub2` + payload + XOR checksum of everything + F7. */
export function gen3Frame(model: number, fn: number, sub: number, sub2: number, payload: readonly number[]): number[] {
  const f = [0xf0, 0x00, 0x01, 0x74, model, fn, sub, sub2, ...payload];
  let cs = 0;
  for (const b of f) cs ^= b;
  f.push(cs & 0x7f, 0xf7);
  return f;
}
