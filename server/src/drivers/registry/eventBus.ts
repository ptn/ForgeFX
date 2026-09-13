// SSE event bus: the subscriber set + serialized fan-out that every live UI hangs off. Split out of
// registryCore.ts (C3) so the registry facade and the telemetry supervisor share ONE bus without
// reaching into each other's state. The second callback arg is the event pre-serialized once per emit
// (lazily, on first use) so N SSE clients don't each re-run JSON.stringify over the same
// high-frequency telemetry payload.
import type { DeviceEvent } from '../types.js';

export type Subscriber = (e: DeviceEvent, json: string) => void;

export interface EventBusHooks {
  /** A subscriber was added. Called on EVERY subscribe (matching the old inline behavior) — the
   *  supervisor's start methods are idempotent, so re-entrant starts are no-ops. */
  onSubscribe?(): void;
  /** The last subscriber left — stop everything the subscribe started. */
  onUnsubscribe?(): void;
  /** Synchronously before fan-out, regardless of subscriber count: the supervisor keeps its
   *  scene/channel watch baselines in sync here. */
  onEmit?(e: DeviceEvent): void;
}

export class EventBus {
  #subscribers = new Set<Subscriber>();
  #hooks: EventBusHooks;

  constructor(hooks: EventBusHooks = {}) { this.#hooks = hooks; }

  get size(): number { return this.#subscribers.size; }

  subscribe(fn: Subscriber): () => void {
    this.#subscribers.add(fn);
    this.#hooks.onSubscribe?.();
    return () => {
      this.#subscribers.delete(fn);
      if (this.#subscribers.size === 0) this.#hooks.onUnsubscribe?.();
    };
  }

  emit(e: DeviceEvent): void {
    this.#hooks.onEmit?.(e);
    let json: string | undefined;
    for (const fn of this.#subscribers) {
      try {
        if (json === undefined) json = JSON.stringify(e);
        fn(e, json);
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
  }

  /** Broadcast a shared-config change to every live UI (SSE + remote relay). Pure fan-out. */
  broadcastConfig(id: string, data: unknown, origin?: string): void {
    this.emit({ type: 'config', id, data, origin });
  }
}
