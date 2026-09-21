import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationCostSettlement,
} from "../conversation";
import {
  emptyCursorBillingLedger,
  type CursorBillingLedger,
} from "./billing-ledger";
import type { CursorBillingStore } from "./billing-ledger-store";
import {
  CursorConversationRuntime,
  type CursorConversationRuntimeDeps,
} from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import type { CursorBillingSnapshot } from "./worker/ipc";
import {
  createScriptedTransport,
  type ScriptedTransport,
  type ScriptedWorker,
  type ScriptedWorkerOptions,
} from "./testing/scripted-worker";

/**
 * Billed-cost reconciliation through the real runtime (ticket #120): the
 * scripted worker plays the provider's usage endpoint, the injected store
 * plays the durable ledger, and every assertion is about what the runtime
 * reported, persisted, and asked for.
 */

const CONVERSATION_ID = "conv-billing";
const AGENT = "agent-scripted";
const MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
} as const;

const TOKENS = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 2,
  totalTokens: 120,
};

function entry(
  runId: string,
  cost: { rawCostCents: number; chargedCents: number } | null,
  usage = TOKENS,
): CursorBillingSnapshot["runs"][number] {
  return { runId, usage, cost };
}

function snapshot(
  runs: CursorBillingSnapshot["runs"],
  cost: CursorBillingSnapshot["cost"] = null,
): CursorBillingSnapshot {
  return { usage: TOKENS, cost, runs };
}

class MemoryBillingStore implements CursorBillingStore {
  ledger: CursorBillingLedger;
  loads = 0;
  saves = 0;
  constructor(initial: CursorBillingLedger = emptyCursorBillingLedger()) {
    this.ledger = initial;
  }
  async load(): Promise<CursorBillingLedger> {
    this.loads += 1;
    return structuredClone(this.ledger);
  }
  async save(ledger: CursorBillingLedger): Promise<void> {
    this.saves += 1;
    this.ledger = structuredClone(ledger);
  }
}

interface Harness {
  runtime: CursorConversationRuntime;
  transport: ScriptedTransport;
  events: ConversationBackendEvent[];
  settlements: ConversationCostSettlement[];
  store: MemoryBillingStore;
  send(
    overrides?: Partial<ConversationBackendTurnInput>,
  ): Promise<ConversationBackendTurnResult>;
  worker(): ScriptedWorker;
}

function createHarness(
  options: {
    worker?: ScriptedWorkerOptions;
    create?: Partial<ConversationBackendCreateInput>;
    deps?: Partial<CursorConversationRuntimeDeps>;
    store?: MemoryBillingStore;
  } = {},
): Harness {
  const transport = createScriptedTransport(options.worker);
  const events: ConversationBackendEvent[] = [];
  const settlements: ConversationCostSettlement[] = [];
  const store = options.store ?? new MemoryBillingStore();
  let runCounter = 0;
  let queryCounter = 0;

  const runtime = new CursorConversationRuntime(
    {
      executionClass: "ordinary-conversation",
      conversationId: CONVERSATION_ID,
      projectPath: "/repo",
      projectName: "repo",
      conversationTarget: {
        scope: "session",
        projectName: "repo",
        sessionName: "s1",
        conversationId: CONVERSATION_ID,
      },
      worktreePath: "/repo/.worktrees/s1",
      persistedRef: null,
      modelSelection: MODEL_SELECTION,
      sessionInstructions: [],
      tooling: {},
      onCostSettled: (settlement) => settlements.push(settlement),
      ...options.create,
    },
    {
      transport,
      storePath: (id) => `/state/cursor/${id}`,
      billingStore: () => store,
      billingRetryDelaysMs: [100, 200],
      resolveModel: async (selection) => ({ ok: true, selection }),
      translatePortableMcpToCursor,
      newRunId: () => `run-${++runCounter}`,
      newQueryId: () => `q-${++queryCounter}`,
      now: () => 1_000,
      stallTimeoutMs: 5_000,
      cancelSettleTimeoutMs: 50,
      ...options.deps,
    },
  );

  return {
    runtime,
    transport,
    events,
    settlements,
    store,
    worker: () => {
      const worker = transport.workers.at(-1);
      if (worker === undefined) throw new Error("no worker started");
      return worker;
    },
    send: (overrides = {}) =>
      runtime.sendTurn({
        promptText: "do the thing",
        imageRefs: [],
        sessionInstructions: [],
        modelSelection: MODEL_SELECTION,
        autonomous: false,
        signal: new AbortController().signal,
        onEvent: (event) => {
          events.push(event);
        },
        ...overrides,
      }),
  };
}

/** A turn that bills one entry with the given cost at turn end. */
function billedTurn(
  cost: { rawCostCents: number; chargedCents: number } | null,
  usageId = "uuid-1",
): ScriptedWorkerOptions["onTurn"] {
  return (turn, worker) => {
    worker.sendInputAccepted(turn.runId);
    worker.sendUsage(turn.runId, TOKENS);
    worker.sendBilling(
      turn.runId,
      null,
      snapshot([entry(usageId, cost)], cost),
    );
    worker.settle(turn.runId, "completed");
  };
}

function noticeTexts(events: ConversationBackendEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "transcript_entry") return [];
    const raw = event.entry.raw;
    if (typeof raw !== "object" || raw === null) return [];
    const content = Reflect.get(raw, "content");
    if (!Array.isArray(content)) return [];
    return content.flatMap((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      typeof Reflect.get(block, "text") === "string"
        ? [Reflect.get(block, "text") as string]
        : [],
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Cursor billed cost at turn end", () => {
  it("reports the turn's billed charge as its cost once the provider settles it", async () => {
    const harness = createHarness({
      worker: {
        onTurn: billedTurn({ rawCostCents: 4.25, chargedCents: 4.25 }),
      },
    });
    const result = await harness.send();
    expect(result.costUsd).toBeCloseTo(0.0425, 6);
    expect(result.cumulativeCostUsd).toBeCloseTo(0.0425, 6);
    expect(result.tokenUsage).toEqual(TOKENS);
    expect(harness.settlements).toEqual([]);
    expect(harness.store.ledger.turns[0]).toMatchObject({
      runId: "run-1",
      agentId: AGENT,
      status: "settled",
      usageIds: ["uuid-1"],
      tokens: TOKENS,
      outcome: "completed",
    });
    expect(harness.store.ledger.availability.state).toBe("available");
    expect(harness.worker().turns[0]?.input.queryBilling).toBe(true);
  });

  it("reports a zero charge as zero, distinct from an unknown cost", async () => {
    const harness = createHarness({
      worker: { onTurn: billedTurn({ rawCostCents: 3.5, chargedCents: 0 }) },
    });
    const result = await harness.send();
    expect(result.costUsd).toBe(0);
    expect(result.cumulativeCostUsd).toBe(0);
  });

  it("leaves cost unknown when the provider has not priced the entry yet", async () => {
    const harness = createHarness({ worker: { onTurn: billedTurn(null) } });
    const result = await harness.send();
    expect(result.costUsd).toBeNull();
    expect(result.tokenUsage).toEqual(TOKENS);
    expect(harness.store.ledger.turns[0]?.status).toBe("attributed");
  });

  it("credits agent-level cost no turn can own through the settlement callback, never the turn", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, TOKENS);
          worker.sendBilling(
            turn.runId,
            null,
            snapshot([entry("uuid-1", { rawCostCents: 6, chargedCents: 6 })], {
              rawCostCents: 10,
              chargedCents: 10,
            }),
          );
          worker.settle(turn.runId, "completed");
        },
      },
    });
    const result = await harness.send();
    expect(result.costUsd).toBeCloseTo(0.06, 6);
    expect(harness.settlements).toEqual([
      { costUsdDelta: 0.04, lineageId: AGENT, cumulativeCostUsd: 0.1 },
    ]);
  });
});

describe("Cursor late billing settlement", () => {
  it("re-asks within bounds and reports the late cost exactly once", async () => {
    const harness = createHarness({
      worker: {
        onTurn: billedTurn(null),
        onUsageQuery: (queryId, worker) => {
          worker.sendBilling(
            null,
            queryId,
            snapshot([entry("uuid-1", { rawCostCents: 4, chargedCents: 4 })], {
              rawCostCents: 4,
              chargedCents: 4,
            }),
          );
        },
      },
    });
    const result = await harness.send();
    expect(result.costUsd).toBeNull();
    expect(harness.worker().usageQueries).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.worker().usageQueries).toEqual(["q-1"]);
    expect(harness.settlements).toEqual([
      { costUsdDelta: 0.04, lineageId: AGENT, cumulativeCostUsd: 0.04 },
    ]);
    expect(harness.store.ledger.turns[0]?.status).toBe("settled");

    // Settled: nothing further is asked, and nothing is re-applied.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.worker().usageQueries).toEqual(["q-1"]);
    expect(harness.settlements).toHaveLength(1);
  });

  it("stops re-asking once the bounded schedule is exhausted", async () => {
    const harness = createHarness({
      worker: {
        onTurn: billedTurn(null),
        onUsageQuery: (queryId, worker) => {
          worker.sendBilling(null, queryId, snapshot([entry("uuid-1", null)]));
        },
      },
    });
    await harness.send();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.worker().usageQueries).toEqual(["q-1", "q-2"]);
    expect(harness.settlements).toEqual([]);
    expect(harness.store.ledger.turns[0]?.status).toBe("attributed");
  });

  it("does not repeat a transient fetch failure beyond the schedule", async () => {
    const harness = createHarness({
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, TOKENS);
          worker.sendBillingFailure(turn.runId, null, "failed", {
            name: "NetworkError",
            code: null,
            status: 503,
            message: "upstream unavailable",
          });
          worker.settle(turn.runId, "completed");
        },
        onUsageQuery: (queryId, worker) => {
          worker.sendBillingFailure(null, queryId, "failed", {
            name: "NetworkError",
            code: null,
            status: 503,
            message: "upstream unavailable",
          });
        },
      },
    });
    const result = await harness.send();
    expect(result.costUsd).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.worker().usageQueries).toEqual(["q-1", "q-2"]);
    expect(harness.store.ledger.turns[0]?.status).toBe("pending");
  });
});

describe("Cursor billing unavailable for the account", () => {
  const refusal = {
    name: "UnknownAgentError",
    code: "feature_unavailable",
    status: 403,
    message:
      "[feature_unavailable] This feature is not available for your account",
  };
  const refusedTurn: ScriptedWorkerOptions["onTurn"] = (turn, worker) => {
    worker.sendInputAccepted(turn.runId);
    worker.sendUsage(turn.runId, TOKENS);
    if (turn.input.queryBilling !== false)
      worker.sendBillingFailure(turn.runId, null, "unavailable", refusal);
    worker.settle(turn.runId, "completed");
  };

  it("keeps cost unknown, discloses once, and stops asking for the session", async () => {
    const harness = createHarness({ worker: { onTurn: refusedTurn } });
    const first = await harness.send();
    expect(first.costUsd).toBeNull();
    expect(first.cumulativeCostUsd).toBeNull();
    expect(first.tokenUsage).toEqual(TOKENS);
    expect(harness.store.ledger.availability).toMatchObject({
      state: "unavailable",
      code: "feature_unavailable",
    });
    expect(harness.store.ledger.turns[0]?.status).toBe("unavailable");
    const notices = noticeTexts(harness.events).filter((text) =>
      /billed cost/i.test(text),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("feature_unavailable");

    const second = await harness.send();
    expect(second.costUsd).toBeNull();
    expect(harness.worker().turns[1]?.input.queryBilling).toBe(false);
    expect(
      noticeTexts(harness.events).filter((text) => /billed cost/i.test(text)),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.worker().usageQueries).toEqual([]);
  });

  it("re-probes once per attach so an account that gains the feature is noticed", async () => {
    const store = new MemoryBillingStore();
    const first = createHarness({ worker: { onTurn: refusedTurn }, store });
    await first.send();
    await first.runtime.close();

    const resumed = createHarness({
      worker: { onTurn: refusedTurn },
      store,
      create: { persistedRef: { backend: "cursor", ref: AGENT } },
    });
    await resumed.send();
    expect(resumed.worker().turns[0]?.input.queryBilling).toBe(true);
    expect(
      noticeTexts(resumed.events).filter((text) => /billed cost/i.test(text)),
    ).toEqual([]);
  });
});

describe("Cursor billing across restarts", () => {
  it("reconciles a pending settlement on resume and never double counts what was applied", async () => {
    const store = new MemoryBillingStore();
    const first = createHarness({
      worker: { onTurn: billedTurn(null) },
      store,
    });
    await first.send();
    await first.runtime.close();
    expect(store.ledger.turns[0]?.status).toBe("attributed");

    const priced = snapshot(
      [entry("uuid-1", { rawCostCents: 4, chargedCents: 4 })],
      { rawCostCents: 4, chargedCents: 4 },
    );
    let resumedRuns = 0;
    const resumed = createHarness({
      store,
      create: { persistedRef: { backend: "cursor", ref: AGENT } },
      deps: { newRunId: () => `run-resumed-${++resumedRuns}` },
      worker: {
        onTurn: (turn, worker) => {
          worker.sendInputAccepted(turn.runId);
          worker.sendUsage(turn.runId, TOKENS);
          // The provider answers the second turn with the whole agent history.
          worker.sendBilling(turn.runId, null, {
            ...priced,
            runs: [
              ...priced.runs,
              entry("uuid-2", { rawCostCents: 1, chargedCents: 1 }),
            ],
            cost: { rawCostCents: 5, chargedCents: 5 },
          });
          worker.settle(turn.runId, "completed");
        },
        onUsageQuery: (queryId, worker) => {
          worker.sendBilling(null, queryId, priced);
        },
      },
    });
    const result = await resumed.send();
    // The resume-time reconciliation settled the first turn before the second
    // turn was dispatched; the second turn's own entry is its cost.
    expect(resumed.worker().usageQueries).toEqual(["q-1"]);
    expect(resumed.settlements).toEqual([
      { costUsdDelta: 0.04, lineageId: AGENT, cumulativeCostUsd: 0.04 },
    ]);
    expect(result.costUsd).toBeCloseTo(0.01, 6);
    expect(result.cumulativeCostUsd).toBeCloseTo(0.05, 6);
    expect(store.ledger.turns.map((turn) => turn.status)).toEqual([
      "settled",
      "settled",
    ]);
    expect(store.ledger.agents[AGENT]?.appliedCents).toBe(5);
  });
});
