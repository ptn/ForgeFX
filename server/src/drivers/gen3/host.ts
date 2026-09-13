// Shared gen-3 driver plumbing: the profile / codec / transport every collaborator reads through.
// Owns the device-profile reference (so applyRuntimeProfile swaps it for every collaborator at once),
// the serialized send/write helpers, and the two low-level reads several services share (fn 0x13
// status dump, fn 0x0D current-preset query). Split out of gen3.ts so the driver is orchestration only.
import type { ModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import type { DeviceProfile } from '../../devices.js';
import type { Transport } from '../../transport/types.js';
import type { DeviceEvent, DriverCtx } from '../types.js';

export class Gen3Host {
  #profile: DeviceProfile;

  constructor(
    readonly codec: ModernFractalCodec,
    readonly ctx: DriverCtx,
    profile: DeviceProfile,
  ) {
    this.#profile = profile;
  }

  get profile(): DeviceProfile { return this.#profile; }
  setProfile(profile: DeviceProfile): void { this.#profile = profile; }

  conn(): Promise<Transport> { return this.ctx.transport(); }
  emit(e: DeviceEvent): void { this.ctx.emit(e); }

  /** Fire-and-forget write, serialized on the request chain (so it never injects mid-read). */
  async send(bytes: number[]): Promise<{ ok: boolean }> {
    await (await this.conn()).sendQueued(bytes);
    return { ok: true };
  }

  /** Write + watch a short window for a 0x64 rejection. For structural ops where a reject matters. */
  async write(bytes: number[]): Promise<{ ok: boolean }> {
    const dev = await this.conn();
    const frames = await dev.request(bytes, { timeoutMs: 120, quietMs: 60, match: (fs) => fs.some((f) => f[5] === 0x64) });
    return { ok: !frames.some((f) => f[5] === 0x64) };
  }

  /** Current preset number + name (one query). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const dev = await this.conn();
    const frames = await dev.request(this.codec.buildQueryPatchName('current'), {
      timeoutMs: dev.slow ? 4000 : 1200, // slow link: give the reply time to arrive (match returns early)
      match: (fs) => fs.some((f) => this.codec.isQueryPatchNameResponse(f))
    });
    const f = frames.find((x) => this.codec.isQueryPatchNameResponse(x));
    if (!f) return { number: -1, name: '' };
    const r = this.codec.parseQueryPatchNameResponse(f);
    return { number: r.presetNumber, name: r.name };
  }

  /** Live active-channel + bypass per placed block (fn 0x13 status dump). */
  async statusByEffectId(): Promise<Map<number, { bypassed: boolean; channel: number }>> {
    const dev = await this.conn();
    const map = new Map<number, { bypassed: boolean; channel: number }>();
    try {
      // fractal-midi's isStatusDumpResponse is locked to model 0x10 (III), so match the
      // 0x13 frame ourselves (any model) and parse the id-id-dd triples inline.
      const frames = await dev.request(this.codec.buildStatusDump(), { timeoutMs: 1500, match: (fs) => fs.some((f) => f[5] === 0x13) });
      const f = frames.find((x) => x[5] === 0x13);
      if (f) {
        const payload = f.slice(6, f.length - 2);
        for (let i = 0; i + 2 < payload.length; i += 3) {
          const effectId = (payload[i]! & 0x7f) | ((payload[i + 1]! & 0x7f) << 7);
          const dd = payload[i + 2]! & 0x7f;
          map.set(effectId, { bypassed: (dd & 0x01) !== 0, channel: (dd >> 1) & 0x07 });
        }
      }
    } catch {
      /* status optional */
    }
    return map;
  }
}
