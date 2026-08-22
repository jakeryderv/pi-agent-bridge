import type { BridgeConfig } from "../config.js";
import type { ExternalAgent, ExternalAgentProvider } from "./types.js";

export type ExternalAgentFactory = (provider: ExternalAgentProvider, config: BridgeConfig) => ExternalAgent;

export class ExternalAgentPool {
  readonly #adapters = new Map<string, ExternalAgent>();
  readonly #factory: ExternalAgentFactory;
  #closing?: Promise<void>;

  constructor(factory: ExternalAgentFactory) {
    this.#factory = factory;
  }

  get(provider: ExternalAgentProvider, config: BridgeConfig): ExternalAgent {
    const runtimeConfig = config[provider];
    const key = JSON.stringify({ provider, runtimeConfig });
    const existing = this.#adapters.get(key);
    if (existing) return existing;

    const adapter = this.#factory(provider, config);
    this.#adapters.set(key, adapter);
    return adapter;
  }

  closeAll(): Promise<void> {
    if (this.#closing) return this.#closing;

    this.#closing = Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close())).then(
      (results) => {
        this.#adapters.clear();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
    );
    return this.#closing;
  }
}
