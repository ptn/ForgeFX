// AM4 preset backup / restore / offline bank + firmware validation. Split out of am4.ts — the
// verbatim .syx I/O and offline decoders, none of which touch the live reader caches.
import {
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  parseAm4PresetDump,
  am4DumpLocation,
  decodeAm4PresetNameFromFrame,
  parseAm4Firmware,
} from 'forgefx-midi/am4';
import type { OfflinePresetBank } from '../types.js';
import type { Transport } from '../../transport/types.js';
import { am4DecodeEnrichment, splitSysex } from './support.js';
import { am4BankFromBytes } from './views.js';

export interface Am4PresetBankHost {
  openTransport(): Promise<Transport>;
  invalidate(): void;
  log(s: string): void;
}

export class Am4PresetBank {
  #host: Am4PresetBankHost;

  constructor(host: Am4PresetBankHost) { this.#host = host; }

  /** Back up a preset off the device as a verbatim .syx dump (the 6-message 0x77/0x78/0x79 stream).
   *  `location` omitted → the active edit buffer. Returns the raw bytes (byte-identical, replayable)
   *  plus the decoded location + name, with ADDITIVE opt-in enrichment (crcValid + scene names). */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[]; sceneNames?: string[]; crcValid?: boolean }> {
    const dev = await this.#host.openTransport();
    const req = location == null ? buildRequestActiveBufferDump() : buildRequestStoredPresetDump(location);
    const frames = await dev.request(req, { timeoutMs: 5000, quietMs: 200, match: (fs) => fs.some((f) => f[4] === 0x15 && f[5] === 0x79) });
    const dumpMsgs = frames.filter((f) => f[4] === 0x15 && (f[5] === 0x77 || f[5] === 0x78 || f[5] === 0x79));
    const raw = Uint8Array.from(dumpMsgs.flat());
    const dump = parseAm4PresetDump(raw); // validates every envelope + checksum; throws on malformed
    const loc = am4DumpLocation(dump);
    const enrich = am4DecodeEnrichment(dump.raw);
    this.#host.log(`backup ${loc.code ?? '(active)'} "${decodeAm4PresetNameFromFrame(dump.raw)}" ${dump.raw.length}B${enrich ? ` crc=${enrich.crcValid ? 'ok' : 'BAD'}` : ''}`);
    return {
      location: loc.active ? null : (loc.index ?? null),
      code: loc.code ?? null,
      name: decodeAm4PresetNameFromFrame(dump.raw),
      bytes: [...dump.raw],
      ...(enrich ? { sceneNames: enrich.sceneNames, crcValid: enrich.crcValid } : {})
    };
  }

  /** Restore a preset .syx (single 12,352-byte dump) to the device by verbatim re-emit (goes back to
   *  the location encoded in the dump's 0x77 header). Validates the dump before sending. */
  async restorePreset(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }> {
    const dump = parseAm4PresetDump(Uint8Array.from(bytes)); // validate first — throws on bad envelope/checksum
    const loc = am4DumpLocation(dump);
    const dev = await this.#host.openTransport();
    for (const msg of splitSysex([...dump.raw])) await dev.sendQueued(msg);
    this.#host.invalidate();
    this.#host.log(`restore -> ${loc.code ?? '(active)'} (${dump.raw.length}B, 6 msgs)`);
    return { ok: true, location: loc.active ? null : (loc.index ?? null), code: loc.code ?? null };
  }

  /** Offline decode of an AM4 .syx (a single dump or a whole bank, e.g. the 104-preset factory file):
   *  returns each preset's location + name. No device needed — for library import / browsing. */
  decodePresetBank(bytes: number[]): OfflinePresetBank {
    return am4BankFromBytes(bytes);
  }

  /** Validate an AM4 firmware .syx (fn 0x7D/0x7E/0x7F envelope) — integrity check only, NOT a flasher.
   *  Reports message/block counts + the header/finalize tags. */
  validateFirmware(bytes: number[]) {
    try {
      const fw = parseAm4Firmware(Uint8Array.from(bytes));
      return {
        valid: true,
        messages: fw.messageCount,
        blocks: fw.blockPayloads.length,
        headerTag: [...fw.headerPayload],
        finalizeTag: [...fw.finalizePayload]
      };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }
}
