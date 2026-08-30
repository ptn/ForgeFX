// `.blk` block-file decode — thin wire-shaping wrapper over forgefx-midi's container parser
// (devices/gen3/blockFile.ts), mirroring colorLabelsImport.ts's split: this module is browser-safe
// (no node:fs) so it can live in the runtime import graph; the Node-only disk discovery stays in
// editorCacheDiscovery.ts.
import { decodeGen3BlockFile, parseGen3BlockFile, type DecodedBlock } from 'forgefx-midi/devices/gen3';
import { DEVICE_MODELS } from 'forgefx-midi/shared';

export interface DecodedBlockFileResult {
  name: string;
  device: string;
  effectTypeId: number;
  slug: string;
  activeChannel: number;
  /** The burst head's blockId — the grid slot the block occupied (diagnostic). */
  blockId: number;
  /** Channel-blocked raw value count (itemCount) + the positional wire values themselves. */
  itemCount: number;
  values: number[];
  channels: DecodedBlock[];
}

/**
 * Decode a `.blk` file's bytes into the shape the Axis Block Library reads. Throws on a malformed
 * file OR a model this package hasn't calibrated (VP4) — the route maps either to 422, matching
 * `colorLabelsImport.parseColorAssignments`'s error-shape convention.
 */
export function decodeBlockFile(bytes: Uint8Array): DecodedBlockFileResult {
  const file = parseGen3BlockFile(bytes);
  const channels = decodeGen3BlockFile(bytes);
  const primary = channels[0];
  return {
    name: file.name,
    device: DEVICE_MODELS[file.modelId]?.name ?? `0x${file.modelId.toString(16)}`,
    effectTypeId: file.effectTypeId,
    slug: primary?.slug ?? '',
    activeChannel: file.activeChannel,
    blockId: file.blockId,
    itemCount: file.itemCount,
    values: file.values,
    channels,
  };
}
