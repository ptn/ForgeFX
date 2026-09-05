/*
 * Dump EVERY complete SysEx frame (F0 .. F7) FM3-Edit exchanges with the FM3,
 * in BOTH directions, raw hex plus a best-effort decode annotation.
 *
 * Unlike capture-fm3-edit.js (which filters to write-class frames), this one
 * prints everything so a capture can be saved and analyzed later.
 *
 * Run:
 *   frida -l capture-fm3-edit-all.js -p <pid>        # pid via: pgrep -x FM3-Edit
 *
 * Redirect to a file and paste the contents for analysis:
 *   frida -l capture-fm3-edit-all.js -p $(pgrep -x FM3-Edit) > /tmp/fm3edit-dump.txt
 */

'use strict';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

function hex(bytes) {
  return Array.from(bytes, (b) => '0' + b.toString(16).slice(-2)).join(' ');
}

// 5-septet little-endian float32 (the gen-3 value field at frame offsets 12..16).
function decode5SeptetFloat32(s0, s1, s2, s3, s4) {
  let u = 0;
  u |= (s0 & 0x7f);
  u |= (s1 & 0x7f) << 7;
  u |= (s2 & 0x7f) << 14;
  u |= (s3 & 0x7f) << 21;
  u |= (s4 & 0x7f) << 28;
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, u >>> 0, true);
  const f = dv.getFloat32(0, true);
  return Number.isFinite(f) ? f : NaN;
}

const FN_NAMES = {
  0x00: 'ping', 0x01: 'param', 0x08: 'identify', 0x09: 'preset-name', 0x0a: 'bypass',
  0x0b: 'channel', 0x0c: 'scene', 0x0d: 'query-patch', 0x0e: 'query-scene',
  0x0f: 'looper', 0x10: 'tempo-tap', 0x11: 'tuner', 0x12: 'page',
  0x13: 'status-dump', 0x14: 'tempo', 0x1f: 'bulk-read', 0x46: 'query',
  0x47: 'init', 0x74: 'dump-head', 0x75: 'dump-body', 0x76: 'dump-end'
};

// Known per-block monitor pids (FM3). eid depends on grid placement; pid is the
// stable key. Any other pid prints as `pid=?` — that's what we're hunting for.
const PID_NAMES = {
  8: 'INPUT_GAINMONITOR', 13: 'GATE_GAINMONITOR', 16: 'OUTPUT_VUL', 17: 'OUTPUT_VUR',
  25: 'COMP_GAINMONITOR', 28: 'MULTICOMP_GAINMON1', 29: 'MULTICOMP_GAINMON2',
  30: 'MULTICOMP_GAINMON3'
};

function decode(f) {
  if (f.length < 7) return '';
  const fn = f[5];
  const sub = f[6];
  const fnName = FN_NAMES[fn] || ('fn' + fn.toString(16));
  let out = `${fnName} sub=${sub}`;
  if (fn === 0x01 && sub === 0x19 && f.length >= 12) {
    const eid = (f[8] ?? 0) | ((f[9] ?? 0) << 7);
    const pid = (f[10] ?? 0) | ((f[11] ?? 0) << 7);
    const pidName = PID_NAMES[pid] || ('pid=' + pid);
    out += ` eid=${eid} ${pidName}`;
    if (f.length === 23) {
      const v = decode5SeptetFloat32(f[12] ?? 0, f[13] ?? 0, f[14] ?? 0, f[15] ?? 0, f[16] ?? 0);
      const norm = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : NaN;
      out += ` val=${Number.isFinite(v) ? v.toFixed(4) : 'NaN'} norm=${Number.isFinite(norm) ? norm.toFixed(4) : 'NaN'}`;
    }
  }
  return out;
}

// Buffer partial frames per direction; a read/write call may split a frame.
const streams = { TX: [], RX: [] };

function ingest(dir, bytes) {
  let pending = streams[dir];
  for (const b of bytes) {
    if (b === SYSEX_START) pending = [b];
    else if (pending.length) {
      pending.push(b);
      if (b === SYSEX_END) {
        emit(dir, pending);
        pending = [];
      }
    }
  }
  streams[dir] = pending;
}

function emit(dir, f) {
  const d = decode(f);
  console.log(`${Date.now()} ${dir} ${hex(f)}${d ? '   # ' + d : ''}`);
}

function hook(name, dir) {
  const sym = Module.getGlobalExportByName(name);
  if (sym === null) {
    console.log(`[capture-fm3-edit-all] WARN: could not resolve libc \`${name}\` — ${dir} may use IOKit directly.`);
    return;
  }
  Interceptor.attach(sym, name === 'read' ? {
    onEnter(args) { this.buf = args[1]; },
    onLeave(ret) {
      const n = ret.toInt32();
      if (n > 0) {
        const bytes = new Uint8Array(this.buf.readByteArray(n));
        ingest(dir, bytes);
      }
    }
  } : {
    onEnter(args) {
      const n = args[2].toInt32();
      if (n > 0) {
        const bytes = new Uint8Array(args[1].readByteArray(n));
        ingest(dir, bytes);
      }
    }
  });
}

hook('write', 'TX');
hook('read', 'RX');

// Heartbeat + flush any trailing partial frame (a frame split across calls).
setInterval(() => {
  for (const dir of ['TX', 'RX']) {
    if (streams[dir].length) {
      console.log(`${Date.now()} ${dir}(partial) ${hex(streams[dir])}`);
      streams[dir] = [];
    }
  }
}, 2000);

console.log('[capture-fm3-edit-all] hooked write() + read() — dump everything now.');
