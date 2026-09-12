import type { ProviderUsageAdapterV1, ProviderUsageBusV1, ProviderUsageEventV1 } from "./types.js";

const PROVIDER_USAGE_BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;

export function getUsageBusV1(): ProviderUsageBusV1 {
  const existing = globalRegistry[PROVIDER_USAGE_BUS_SYMBOL];
  if (existing !== undefined) {
    if (typeof existing !== "object" || existing === null) {
      throw new Error("Incompatible provider usage bus version undefined; expected version 1.");
    }
    const version = Reflect.get(existing, "version");
    if (version !== 1) {
      throw new Error(`Incompatible provider usage bus version ${String(version)}; expected version 1.`);
    }
    for (const method of ["register", "adapters", "subscribe", "publish"] as const) {
      if (typeof Reflect.get(existing, method) !== "function") {
        throw new Error(`Incompatible provider usage bus version 1: ${method} must be a function.`);
      }
    }
    return existing as ProviderUsageBusV1;
  }

  const bus = createUsageBusV1();
  globalRegistry[PROVIDER_USAGE_BUS_SYMBOL] = bus;
  return bus;
}

function createUsageBusV1(): ProviderUsageBusV1 {
  const adaptersById = new Map<string, { adapter: ProviderUsageAdapterV1; registration: symbol }>();
  const listeners = new Set<(event: ProviderUsageEventV1) => void>();

  return {
    version: 1,
    register(adapter) {
      const registration = Symbol(adapter.id);
      adaptersById.set(adapter.id, { adapter, registration });
      return () => {
        if (adaptersById.get(adapter.id)?.registration === registration) {
          adaptersById.delete(adapter.id);
        }
      };
    },
    adapters() {
      return [...adaptersById.values()].map(({ adapter }) => adapter);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      let invoked = 0;
      for (const listener of [...listeners]) {
        invoked += 1;
        try {
          listener(event);
        } catch {
          // Listener failures are isolated so every snapshot subscriber is attempted.
        }
      }
      return invoked;
    },
  };
}
