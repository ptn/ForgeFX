// AM4 device path (model 0x15) — a parallel module to the gen-3 Device. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the gen-3 Device owns (device.openTransport()), since only one device is ever connected at a time.
// Codec is fractal-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
  parseReadResponse,
  isReadResponse,
  BLOCK_SLOT_PID_LOW,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_NAMES_BY_VALUE,
  buildSetParam,
  buildSetBlockBypass,
  buildSwitchScene,
  buildSwitchPreset,
  buildGetPresetName,
  parseGetPresetNameResponse,
  isCommandAck,
  type ParamKey
} from 'fractal-midi/am4';
import { device } from './device.js';

export interface Am4Slot {
  slot: number; // 1..4 signal-chain position
  blockType: string; // canonical block name, 'none' if empty
  pidLow: number; // the block's pidLow (its type value)
}

class Am4Device {
  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  /** Read the 4 signal-chain slots → which block sits in each (the AM4 equivalent of the grid). */
  async slots(): Promise<Am4Slot[]> {
    const dev = await device.openTransport();
    const out: Am4Slot[] = [];
    for (let i = 1; i <= 4; i++) {
      const read = buildReadParam({ pidLow: BLOCK_SLOT_PID_LOW, pidHigh: BLOCK_SLOT_PID_HIGH_BASE + i });
      const frames = await dev.request(read, { timeoutMs: 800, quietMs: 60, match: (fs) => fs.some((f) => isReadResponse(read, f)) });
      const f = frames.find((fr) => isReadResponse(read, fr));
      if (!f) {
        out.push({ slot: i, blockType: 'none', pidLow: 0 });
        continue;
      }
      const pidLow = parseReadResponse(f).asUInt32LE();
      out.push({ slot: i, blockType: BLOCK_NAMES_BY_VALUE[pidLow] ?? (pidLow ? `0x${pidLow.toString(16)}` : 'none'), pidLow });
    }
    this.#log(`slots: ${out.map((s) => `${s.slot}:${s.blockType}`).join(' ')}`);
    return out;
  }

  /** Stored preset name at a location (0..103). */
  async presetName(location: number): Promise<{ location: number; name: string }> {
    const dev = await device.openTransport();
    const req = buildGetPresetName(location);
    const frames = await dev.request(req, { timeoutMs: 1000, quietMs: 80, match: (fs) => fs.length > 0 });
    for (const f of frames) {
      try {
        const r = parseGetPresetNameResponse(f, location);
        return { location, name: r.isEmpty ? '' : r.name };
      } catch {
        /* not the name frame */
      }
    }
    return { location, name: '' };
  }

  /** Set a parameter by its display value (e.g. 'amp.gain', 7.5). */
  async setParam(key: string, displayValue: number) {
    const dev = await device.openTransport();
    const frame = buildSetParam(key as ParamKey, displayValue);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 60, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Toggle/set a block's bypass by its pidLow. */
  async setBypass(blockPidLow: number, bypassed: boolean) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSetBlockBypass(blockPidLow, bypassed));
    return { ok: true };
  }

  /** Switch the active scene (0..3). */
  async switchScene(index: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSwitchScene(index));
    return { ok: true, scene: index };
  }

  /** Switch the active preset by location index (0..103, A01..Z04). */
  async switchPreset(location: number) {
    const dev = await device.openTransport();
    await dev.sendQueued(buildSwitchPreset(location));
    return { ok: true, location };
  }
}

export const am4 = new Am4Device();
