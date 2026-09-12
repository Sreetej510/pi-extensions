import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "../src/adapter-bus.js";
import { isUsageSupportedModel } from "../src/models.js";
import { queryUsage } from "../src/query.js";
import { applyCurrentProviderStatusline, clearUsageStatusline } from "../src/statusline.js";
import type {
  ProviderUsageAdapterV1,
  ProviderUsageBusV1,
  ProviderUsageEventV1,
  ProviderUsageSnapshotV1,
} from "../src/types.js";

const BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;

function usageSnapshot(usedPercent = 32): ProviderUsageSnapshotV1 {
  return {
    version: 1,
    provider: "codex",
    capturedAt: Date.parse("2026-09-12T13:00:00Z"),
    windows: [
      {
        id: "gpt:five_hour",
        label: "5h",
        usedPercent,
        scope: { kind: "account" },
      },
    ],
  };
}

function adapter(
  id: string,
  modelProviders: string[] = ["bridge-provider"],
  refresh: ProviderUsageAdapterV1["refresh"] = async () => usageSnapshot(),
): ProviderUsageAdapterV1 {
  return { id, modelProviders, refresh };
}

async function withCleanBus(run: () => void | Promise<void>): Promise<void> {
  const hadOriginal = Object.hasOwn(globalRegistry, BUS_SYMBOL);
  const original = globalRegistry[BUS_SYMBOL];
  delete globalRegistry[BUS_SYMBOL];
  try {
    await run();
  } finally {
    if (hadOriginal) globalRegistry[BUS_SYMBOL] = original;
    else delete globalRegistry[BUS_SYMBOL];
  }
}

void test("creates a structural global bus before a bridge loads", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const bridgeView = globalRegistry[BUS_SYMBOL] as ProviderUsageBusV1;
    const bridgeAdapter = adapter("bridge");

    bridgeView.register(bridgeAdapter);

    assert.strictEqual(bridgeView, bus);
    assert.strictEqual(getUsageBusV1(), bus);
    assert.deepEqual(bus.adapters(), [bridgeAdapter]);
  });
});

void test("reuses a compatible bus created by a bridge first", async () => {
  await withCleanBus(() => {
    const bridgeAdapter = adapter("bridge-first");
    const bridgeBus: ProviderUsageBusV1 = {
      version: 1,
      register: () => () => {},
      adapters: () => [bridgeAdapter],
      subscribe: () => () => {},
      publish: () => 0,
    };
    globalRegistry[BUS_SYMBOL] = bridgeBus;

    const usageBus = getUsageBusV1();

    assert.strictEqual(usageBus, bridgeBus);
    assert.deepEqual(usageBus.adapters(), [bridgeAdapter]);
  });
});

void test("replaces duplicate adapter ids deterministically and unregisters idempotently", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const first = adapter("duplicate", ["first-provider"]);
    const other = adapter("other", ["other-provider"]);
    const replacement = adapter("duplicate", ["replacement-provider"]);
    const unregisterFirst = bus.register(first);
    const unregisterOther = bus.register(other);
    const unregisterReplacement = bus.register(replacement);

    assert.deepEqual(bus.adapters(), [replacement, other]);

    unregisterFirst();
    assert.deepEqual(bus.adapters(), [replacement, other]);

    unregisterReplacement();
    unregisterReplacement();
    assert.deepEqual(bus.adapters(), [other]);

    unregisterOther();
    unregisterOther();
    assert.deepEqual(bus.adapters(), []);
  });
});

void test("publishes to subscribers and returns the listener count", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const received: string[] = [];
    const unsubscribeFirst = bus.subscribe((event) => received.push(`first:${event.type}`));
    const unsubscribeSecond = bus.subscribe((event) => received.push(`second:${event.type}`));
    const event: ProviderUsageEventV1 = { version: 1, type: "snapshot", snapshot: usageSnapshot() };

    assert.equal(bus.publish(event), 2);
    assert.deepEqual(received, ["first:snapshot", "second:snapshot"]);

    unsubscribeFirst();
    unsubscribeFirst();
    assert.equal(bus.publish(event), 1);
    assert.deepEqual(received, ["first:snapshot", "second:snapshot", "second:snapshot"]);

    unsubscribeSecond();
    assert.equal(bus.publish(event), 0);
  });
});

void test("continues publishing after a listener throws and returns every invocation", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const received: string[] = [];
    bus.subscribe(() => {
      received.push("throwing");
      throw new Error("listener failed");
    });
    bus.subscribe(() => received.push("later"));
    const event: ProviderUsageEventV1 = { version: 1, type: "snapshot", snapshot: usageSnapshot() };

    assert.equal(bus.publish(event), 2);
    assert.deepEqual(received, ["throwing", "later"]);
  });
});

void test("rejects an incompatible preexisting global bus version", async () => {
  await withCleanBus(() => {
    globalRegistry[BUS_SYMBOL] = { version: 2 };

    assert.throws(() => getUsageBusV1(), /incompatible.*version.*2/i);
    assert.deepEqual(globalRegistry[BUS_SYMBOL], { version: 2 });
  });
});

void test("rejects a version-1 global missing any required bus method", async () => {
  await withCleanBus(() => {
    const compatible: ProviderUsageBusV1 = {
      version: 1,
      register: () => () => {},
      adapters: () => [],
      subscribe: () => () => {},
      publish: () => 0,
    };

    globalRegistry[BUS_SYMBOL] = { version: 1 };
    assert.throws(() => getUsageBusV1(), /incompatible.*register/i);

    for (const method of ["register", "adapters", "subscribe", "publish"] as const) {
      globalRegistry[BUS_SYMBOL] = { ...compatible, [method]: undefined };
      assert.throws(() => getUsageBusV1(), new RegExp(`incompatible.*${method}`, "i"));
    }
  });
});

void test("supports and queries a non-native model through its adapter", async () => {
  await withCleanBus(async () => {
    let refreshOptions: { timeoutMs: number; signal?: AbortSignal } | undefined;
    getUsageBusV1().register(
      adapter("query-bridge", ["bridge-provider"], async (options) => {
        refreshOptions = options;
        return usageSnapshot(140);
      }),
    );
    const model = { provider: "bridge-provider", id: "bridge-model", name: "Bridge Model" };
    const ctx = { model } as unknown as ExtensionContext;

    assert.equal(isUsageSupportedModel(model), true);
    const result = await queryUsage(ctx, { timeoutMs: 4321 });

    assert.deepEqual(refreshOptions, { timeoutMs: 4321 });
    assert.deepEqual(result, {
      ok: true,
      report: {
        provider: "codex",
        source: "external-adapter",
        modelProviders: ["bridge-provider"],
        capturedAt: Date.parse("2026-09-12T13:00:00Z"),
        windows: [
          {
            id: "gpt:five_hour",
            label: "5h",
            usedPercent: 100,
            scope: { kind: "account" },
          },
        ],
      },
    });
  });
});

void test("keeps a successful claude-bridge adapter report selected in the statusline", async () => {
  await withCleanBus(async () => {
    getUsageBusV1().register(
      adapter("claude-bridge-adapter", ["claude-bridge"], async () => ({
        ...usageSnapshot(64),
        provider: "anthropic",
      })),
    );
    const statuses: Array<string | undefined> = [];
    const ctx = {
      model: { provider: "claude-bridge", id: "claude-sonnet", name: "Claude Sonnet" },
      ui: {
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      },
    } as unknown as ExtensionContext;

    const result = await queryUsage(ctx, { timeoutMs: 4321 });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.report, {
      provider: "anthropic",
      source: "external-adapter",
      modelProviders: ["claude-bridge"],
      capturedAt: Date.parse("2026-09-12T13:00:00Z"),
      windows: [
        {
          id: "gpt:five_hour",
          label: "5h",
          usedPercent: 64,
          scope: { kind: "account" },
        },
      ],
    });
    assert.equal(applyCurrentProviderStatusline(ctx, [result.report]), true);
    assert.deepEqual(statuses, ["Claude · 5h 64%"]);

    clearUsageStatusline(ctx);
  });
});

void test("reports adapter refresh failures as external-adapter errors", async () => {
  await withCleanBus(async () => {
    const failure = new Error("bridge refresh failed");
    getUsageBusV1().register(adapter("failing-bridge", ["failing-provider"], async () => Promise.reject(failure)));
    const ctx = {
      model: { provider: "failing-provider", id: "failing-model", name: "Failing Model" },
    } as unknown as ExtensionContext;

    const result = await queryUsage(ctx, { timeoutMs: 100 });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.source, "external-adapter");
    assert.equal(result.errors[0]?.message, "bridge refresh failed");
    assert.strictEqual(result.errors[0]?.cause, failure);
  });
});
