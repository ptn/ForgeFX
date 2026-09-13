// AM4 single-block param read: find the placed slot, take the reader's decoded display values for the
// active channel, and join them to the catalog into the unified blockParams DTO. Split out of am4.ts.
import { resolveBlockTypeValue } from 'forgefx-midi/am4';
import type { DeviceLayout } from '../../devices.js';
import type { NamedParam, EnumParam } from '../types.js';
import { slotParamValues } from '../shared/params.js';
import { am4LayoutFor } from '../../devices.js';
import { am4JoinBlockParams } from './views.js';
import type { Am4Context } from './context.js';

const CHAN_LETTERS = ['A', 'B', 'C', 'D'] as const;

export interface Am4BlockParamsHost {
  log(s: string): void;
}

export class Am4BlockParams {
  #context: Am4Context;
  #host: Am4BlockParamsHost;

  constructor(context: Am4Context, host: Am4BlockParamsHost) {
    this.#context = context;
    this.#host = host;
  }

  /** Read every parameter of the block sitting at `pidLow` (its block-type value, e.g. 58=amp, 118=drive
   *  — the `effectId` the grid/slots report) in the SAME shape as the gen-3 blockParams. */
  async blockParams(pidLow: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    // instance-aware: pidLow may be an instance code (base+N, e.g. drive #2 = 0x77) — the catalog
    // is keyed by the BASE pidLow, the wire address stays the instance code (see encId/setParam)
    const resolved = resolveBlockTypeValue(pidLow);
    const blockName = resolved?.name;
    if (!blockName || blockName === 'none') {
      this.#host.log(`blockParams: unknown pidLow ${pidLow}`);
      return { block: blockName ?? `0x${pidLow.toString(16)}`, slug: blockName ?? '', page: -1, named: [], enums: [], type: null };
    }
    const basePidLow = resolved.base;
    const snap = await this.#context.readPreset();
    // Find the placed slot for THIS pidLow, then its DECODED param dict (flat, or the one active-channel
    // dict for channel-bearing blocks — getPreset nests exactly one channel per slot). Match by POSITION
    // via the structure (a preset can hold two instances of the same block type); fall back to name.
    const chainSlot = (await this.#context.readStructure())?.slots.find((sl) => sl.pidLow === pidLow)?.slot;
    const slot = (chainSlot !== undefined ? snap?.slots.find((s) => s.slot === chainSlot) : undefined)
      ?? snap?.slots.find((s) => s.block_type === blockName);
    const decoded = slotParamValues(slot, this.#context.activeChannel.get(pidLow), CHAN_LETTERS);
    const { named, enums, type } = am4JoinBlockParams(blockName, basePidLow, decoded, slot?.bypassed);
    const layout = am4LayoutFor(blockName, type?.value);
    this.#host.log(`blockParams ${blockName} (pidLow ${pidLow}): ${named.length} knobs, ${enums.length} enums${type ? ` type=${type.name}` : ''}`);
    return { block: blockName, slug: blockName, page: -1, named, enums, type, layout };
  }
}
