/*
 * Clean sub=0x4b selector sweep — persistent per-direction buffers (frames
 * can split across libc read() calls), raw hex dump of every sub=0x4b TX/RX.
 * Run while the editor is IDLE on the grid view (no cab picker open) so the
 * only sub=0x4b traffic is our injected queries + their responses.
 */
'use strict';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const MODEL = 0x11;

let midiFd = null;
const rxBuf = [];
let lastSend = null; // { selector } of the most recent injected frame

function hex(bytes) {
  return Array.from(bytes, (b) => '0' + b.toString(16).slice(-2)).join(' ');
}

// ---- 8-to-7 chunked unpack (port of shared/packValue.ts) ----
function unpackValue(wire, rawLen) {
  const out = new Uint8Array(rawLen);
  for (let i = 0; i < wire.length; i++) {
    const k = i + 1;
    const b = wire[i] & 0x7f;
    if (i > 0 && i - 1 < rawLen) out[i - 1] |= ((~(0x7f >> k) & b) >> (8 - k)) & 0xff;
    if (i < rawLen) out[i] = (b << k) & 0xff;
  }
  return out;
}
function unpackValueChunked(wire, rawLen) {
  const out = new Uint8Array(rawLen);
  let rawPos = 0, wirePos = 0;
  while (rawPos < rawLen) {
    const remainingRaw = rawLen - rawPos;
    const thisChunkRaw = Math.min(7, remainingRaw);
    const thisChunkWire = thisChunkRaw === 7 ? 8 : thisChunkRaw + 1;
    const chunk = wire.slice(wirePos, wirePos + thisChunkWire);
    const unpacked = unpackValue(chunk, thisChunkRaw);
    out.set(unpacked, rawPos);
    rawPos += thisChunkRaw; wirePos += thisChunkWire;
  }
  return out;
}
function nameOf(wire, rawLen) {
  const raw = unpackValueChunked(wire, rawLen);
  let s = '';
  for (const c of raw) s += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : ' ';
  return s.replace(/\s+$/,'');
}

function checksumFor(frame) {
  let acc = 0;
  for (let i = 0; i < frame.length; i++) acc ^= frame[i];
  return acc & 0x7f;
}

function buildReadFrame(index, selector) {
  const f = [
    SYSEX_START, 0x00, 0x01, 0x74, MODEL, 0x01, 0x4b, 0x00,
    0x00, 0x00, 0x00, 0x00,
    index & 0x7f, selector & 0x7f, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  f.push(checksumFor(f), SYSEX_END);
  return f;
}

function emitRx(frame) {
  const sub = frame[6];
  if (sub === 0x4b) {
    const tc = (frame[19] & 0x7f) | ((frame[20] & 0x7f) << 7);
    const name = tc >= 1 && frame.length >= 21 + 8 ? nameOf(frame.slice(21, frame.length - 2), Math.min(tc, 32)) : '';
    console.log(`RX4B lastSend=${lastSend ? '0x' + lastSend.selector.toString(16) : '-'} len=${frame.length} v=[${hex(frame.slice(12,17))}] tc=${tc} name="${name}"`);
    console.log(`  raw: ${hex(frame)}`);
  }
}

function hookRead() {
  const sym = Module.getGlobalExportByName('read');
  if (!sym) { console.log('!! read() not found'); return; }
  Interceptor.attach(sym, {
    onEnter(args) { this.buf = args[1]; },
    onLeave(ret) {
      const n = ret.toInt32();
      if (n <= 0) return;
      const bytes = new Uint8Array(this.buf.readByteArray(n));
      for (const b of bytes) {
        if (b === SYSEX_START) { rxBuf.length = 0; rxBuf.push(b); }
        else if (rxBuf.length) {
          rxBuf.push(b);
          if (b === SYSEX_END) { emitRx(rxBuf.slice()); rxBuf.length = 0; }
        }
      }
    }
  });
}

function hookWrite() {
  const sym = Module.getGlobalExportByName('write');
  if (!sym) { console.log('!! write() not found'); return; }
  Interceptor.attach(sym, {
    onEnter(args) {
      const fd = args[0].toInt32();
      const n = args[2].toInt32();
      if (n <= 0) return;
      const bytes = new Uint8Array(args[1].readByteArray(n));
      let hasSysex = false;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === SYSEX_START) { hasSysex = true; break; }
      if (hasSysex && midiFd === null) {
        midiFd = fd;
        console.log(`[sweep] captured midi fd=${fd}`);
        setTimeout(runSweep, 8000);
      }
    }
  });
}

function runSweep() {
  console.log('[sweep] starting byte[12] sweep 0x00..0x7f (byte13=0)');
  const writeSym = Module.getGlobalExportByName('write');
  const realWrite = new NativeFunction(writeSym, 'ssize_t', ['int', 'pointer', 'size_t']);
  let s = 0;
  const step = () => {
    if (s > 0x7f) { console.log('[sweep] DONE'); return; }
    const frame = buildReadFrame(s, 0);
    lastSend = { selector: s };
    const buf = Memory.alloc(frame.length);
    buf.writeByteArray(frame);
    realWrite(midiFd, buf, frame.length);
    console.log(`TX4B b12=0x${s.toString(16)} ${hex(frame)}`);
    s++;
    setTimeout(step, 250);
  };
  step();
}

hookRead();
hookWrite();
console.log('[sweep] armed — waiting for midi fd...');
