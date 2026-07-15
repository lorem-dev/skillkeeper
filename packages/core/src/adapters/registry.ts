import type { AgentAdapter } from './adapter.js';
import type { AgentKind } from './model.js';

/**
 * Registry of agent adapters keyed by {@link AgentKind}. This is the only place
 * that enumerates concrete agents; new agents register themselves here.
 */
export class AdapterRegistry {
  readonly #adapters = new Map<AgentKind, AgentAdapter>();

  /**
   * Register an adapter.
   *
   * @throws Error when an adapter for the same kind is already registered.
   */
  register(adapter: AgentAdapter): void {
    if (this.#adapters.has(adapter.kind)) {
      throw new Error(`Adapter for "${adapter.kind}" is already registered`);
    }
    this.#adapters.set(adapter.kind, adapter);
  }

  /**
   * Retrieve a registered adapter.
   *
   * @throws Error when no adapter for the kind is registered.
   */
  get(kind: AgentKind): AgentAdapter {
    const adapter = this.#adapters.get(kind);
    if (adapter === undefined) {
      throw new Error(`No adapter registered for "${kind}"`);
    }
    return adapter;
  }

  /** True when an adapter for the kind is registered. */
  has(kind: AgentKind): boolean {
    return this.#adapters.has(kind);
  }

  /** All registered adapters, in registration order. */
  list(): AgentAdapter[] {
    return [...this.#adapters.values()];
  }
}
