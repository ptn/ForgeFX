// Gen-3 cab collaborator: the cab-IR catalog (bundled banks + the FM3 512-slot live USER scan) and
// the cab block's picker state (mode / bank / IR index / dyna type per slot). Split out of gen3.ts.
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY } from '../../devices.js';
import { FM3_MODEL, channelSlice } from './support.js';
import type { Gen3Host } from './host.js';
import type { ParamDisplay } from './paramDisplay.js';

export class CabService {
  #host: Gen3Host;
  #paramDisplay: ParamDisplay;
  #liveCabIrBanks: Record<string, string[]> | null = null;
  #liveCabIrRead: Promise<Record<string, string[]>> | null = null;

  constructor(host: Gen3Host, paramDisplay: ParamDisplay) {
    this.#host = host;
    this.#paramDisplay = paramDisplay;
  }

  /** Cab IR catalog. FM3 USER names are read once per connection and retained in their device slots. */
  async cabIrs(refresh = false): Promise<Record<string, string[]>> {
    const base = Object.fromEntries(Object.entries(this.#host.profile.cabIrs()).map(([k, v]) => [k, [...v]]));
    if (this.#host.profile.model !== FM3_MODEL) return base;
    if (!refresh && this.#liveCabIrBanks) return { ...base, ...this.#liveCabIrBanks };
    try {
      if (refresh || !this.#liveCabIrRead) {
        this.#liveCabIrRead = this.#liveCabIrs().then((live) => {
          this.#liveCabIrBanks = live;
          return live;
        }).finally(() => { this.#liveCabIrRead = null; });
      }
      const live = await this.#liveCabIrRead;
      return { ...base, ...live };
    } catch {
      return base;
    }
  }

  async #liveCabIrs(): Promise<Record<string, string[]>> {
    const dev = await this.#host.conn();
    const names = new Array<string>(512).fill('');
    for (let slot = 0; slot < names.length; slot++) {
      const flatIndex = 2048 + slot;
      const query = this.#host.codec.buildCabIrNameRead(flatIndex);
      // The 0x4B reply does not echo the requested flat index. Requests are serialized
      // on the one device transport, so its function/sub-action pair identifies this reply.
      const match = (f: number[]) => f[5] === 0x01 && f[6] === 0x4b;
      const frames = await dev.request(query, {
        timeoutMs: dev.slow ? 1500 : 600,
        quietMs: dev.slow ? 80 : 20,
        match: (fs) => fs.some(match),
      });
      const reply = frames.find(match);
      const name = reply ? this.#host.codec.parseCabIrNameResponse(reply) : null;
      if (name !== null) names[slot] = name;
    }
    return { USER: names };
  }

  /** Cab block state for the IR picker: current mode (Legacy / DynaCab), per-slot bank + IR index +
   * dyna type, plus the option lists. IR names come from fractal-midi (profile.cabIrs() / GET /cab/irs).
   * Writes are plain setParam calls through the device-true CABINET_* param ids. */
  async cabState(eid: number) {
    const prof = this.#host.profile;
    const slug = slugForEffectId(eid) ?? '';
    const family = SLUG_FAMILY[slug.toLowerCase()];
    if (family !== 'CABINET') return { error: 'not a cab block' };
    let values: number[] = [];
    let base = 0;
    try {
      const dev = await this.#host.conn();
      const frames = await dev.request(this.#host.codec.buildBlockBulkReadPoll(eid), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
      const bulk = this.#host.codec.assembleGen3BlockBulkRead(frames);
      values = bulk.values;
      const activeCh = (await this.#host.statusByEffectId()).get(eid)?.channel ?? 0;
      base = channelSlice(prof, family, bulk, activeCh).base;
    } catch {
      /* device unreachable — return option lists with zeroed current state */
    }
    // discrete params store the ordinal; if it looks 16-bit-scaled, unscale against the known max
    // (base = this channel's slice of the bulk read — cab mode/bank/IR/dyna are per-channel, like everything else on the block)
    const ord = (id: number, max: number) => { const raw = values[base + id] ?? 0; return max > 0 && raw > max ? Math.round((raw / 65534) * max) : raw; };
    const pid = (name: string) => this.#paramDisplay.paramId(family, name);
    const bankPids = [1, 2, 3, 4].map((n) => pid(`CABINET_BANK${n}`)).filter((x): x is number => x != null);
    const irPids = [1, 2, 3, 4].map((n) => pid(`CABINET_TYPE${n}`)).filter((x): x is number => x != null);
    const dynaPids = [1, 2, 3, 4].map((n) => pid(`CABINET_DYNACAB_TYPE${n}`)).filter((x): x is number => x != null);
    const modeParam = pid('CABINET_MODE') ?? 31;
    const bankOptionPid = bankPids[0] ?? 0;
    const dynaOptionPid = dynaPids[0] ?? 85;
    const bankOptions = this.#paramDisplay.enumOptions(family, bankOptionPid, 'Bank', 0, 4).map((o) => o.label);
    const dynaLabels = prof.enumLabelsFor(family, dynaOptionPid) ?? [];
    const dynaOptions = this.#paramDisplay.enumOptions(family, dynaOptionPid, 'DynaCab Type', 0, Math.max(0, dynaLabels.length - 1));
    const modeOptions = this.#paramDisplay.enumOptions(family, modeParam, 'Mode', 0, 1);
    // Cab state is read for the editor's compact slot summary. It must not start
    // the 512-slot USER catalog scan; that is reserved for an explicit /cab/irs
    // request, where Axis can persist the result in IndexedDB.
    const irBanks = this.#liveCabIrBanks ? { ...prof.cabIrs(), ...this.#liveCabIrBanks } : prof.cabIrs();
    const slots = bankPids.slice(0, 2).map((bankParam, s) => {
      const irParam = irPids[s] ?? 4 + s;
      const dynaParam = dynaPids[s] ?? 85 + s;
      const bankV = ord(bankParam, bankOptions.length - 1);
      const bankLabel = bankOptions[bankV] ?? String(bankV);
      const list = irBanks[bankLabel] ?? [];
      const irIndex = ord(irParam, Math.max(0, list.length - 1));
      const dynaV = ord(dynaParam, Math.max(0, dynaOptions.length - 1));
      return { slot: s + 1, bankParam, irParam, dynaParam, bank: { value: bankV, label: bankLabel }, irIndex, irName: list[irIndex] || `#${irIndex}`, dyna: { value: dynaV, label: dynaOptions[dynaV]?.label ?? String(dynaV) } };
    });
    const modeV = ord(modeParam, 1);
    return { modeParam, mode: { value: modeV, label: modeOptions[modeV]?.label ?? '' }, modeOptions, bankOptions, dynaOptions, slots };
  }
}
