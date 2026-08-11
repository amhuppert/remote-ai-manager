import { describe, expect, it } from "vitest";
import { EXPANSION_CAPS } from "./expansion-caps";
import {
  EMPTY_EXPANSION_RECEIPTS,
  checkExpansionBudgetCaps,
  checkExpansionRequestCaps,
  classifyExpansionAttempt,
  countExpansionCreatedContexts,
  countExpansionCreatedContextsFor,
  recordExpansionAcceptance,
  recordExpansionRefusal,
  resolveExpansionProvenance,
} from "./expansion-receipts";
import {
  expansionCanonicalByteLength,
  expansionCanonicalPayload,
  expansionPayloadHash,
} from "./expansion-payload";
import { graphWorkflowExpansionReceiptsSchema } from "./schemas";
import type {
  GraphWorkflowExpansionAcceptanceReceipt,
  GraphWorkflowExpansionReceipts,
  GraphWorkflowExpansionRefusalReceipt,
} from "./schemas";

const INVOKER = "context-plan";

function acceptance(
  overrides: Partial<GraphWorkflowExpansionAcceptanceReceipt> = {},
): GraphWorkflowExpansionAcceptanceReceipt {
  return {
    requestId: "req-1",
    payloadHash: "a".repeat(64),
    invokerContextId: INVOKER,
    initiatorConversationId: "conversation-7",
    rationale: "fan out candidates",
    addedContextIds: ["child-a"],
    addedTaskIds: ["child-a-t1"],
    rejoinContextIds: [],
    liveRevision: 2,
    acceptedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function refusal(
  overrides: Partial<GraphWorkflowExpansionRefusalReceipt> = {},
): GraphWorkflowExpansionRefusalReceipt {
  return {
    requestId: "req-1",
    payloadHash: "b".repeat(64),
    invokerContextId: INVOKER,
    refusalCode: "expansion-cap-contexts-per-request",
    refusedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function ledger(
  accepted: GraphWorkflowExpansionAcceptanceReceipt[] = [],
  refusals: GraphWorkflowExpansionRefusalReceipt[] = [],
): GraphWorkflowExpansionReceipts {
  return { accepted, refusals };
}

function requestOfSize(input: {
  contexts?: number;
  tasks?: number;
  edges?: number;
  canonicalBytes?: number;
}) {
  return {
    contexts: Array.from({ length: input.contexts ?? 1 }, (_, i) => i),
    tasks: Array.from({ length: input.tasks ?? 1 }, (_, i) => i),
    edges: Array.from({ length: input.edges ?? 1 }, (_, i) => i),
    canonicalBytes: input.canonicalBytes ?? 100,
  };
}

describe("canonical payload hashing", () => {
  it("gives two payloads that differ only in key order the same identity", () => {
    const a = expansionCanonicalPayload({
      requestId: "req-1",
      rationale: "why",
      contexts: [{ handle: "candidate-a", title: "A" }],
    });
    const b = expansionCanonicalPayload({
      contexts: [{ title: "A", handle: "candidate-a" }],
      rationale: "why",
      requestId: "req-1",
    });

    expect(a).toEqual(b);
    expect(expansionPayloadHash(a)).toEqual(expansionPayloadHash(b));
  });

  it("gives a different identity to a payload whose content changed", () => {
    const original = expansionPayloadHash(
      expansionCanonicalPayload({ requestId: "req-1", rationale: "why" }),
    );
    const edited = expansionPayloadHash(
      expansionCanonicalPayload({ requestId: "req-1", rationale: "why not" }),
    );

    expect(edited).not.toEqual(original);
  });

  it("produces a lowercase sha-256 hex digest the receipt schema accepts", () => {
    const hash = expansionPayloadHash(
      expansionCanonicalPayload({ requestId: "req-1" }),
    );

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      graphWorkflowExpansionReceiptsSchema.parse(
        ledger([acceptance({ payloadHash: hash })]),
      ),
    ).not.toThrow();
  });

  it("measures canonical size in UTF-8 bytes, not UTF-16 code units", () => {
    // A 4-byte astral character is two JS "characters"; a cap measured in
    // `.length` would admit a payload twice the size it thinks it is.
    const canonical = expansionCanonicalPayload({ rationale: "𝒳" });

    expect(expansionCanonicalByteLength(canonical)).toBeGreaterThan(
      canonical.length,
    );
  });
});

describe("per-request caps (R8)", () => {
  it("admits a request sitting exactly on every ceiling", () => {
    expect(
      checkExpansionRequestCaps(
        requestOfSize({
          contexts: EXPANSION_CAPS.contextsPerRequest,
          tasks: EXPANSION_CAPS.tasksPerRequest,
          edges: EXPANSION_CAPS.edgesPerRequest,
          canonicalBytes: EXPANSION_CAPS.canonicalPayloadBytes,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    {
      label: "contexts",
      request: requestOfSize({
        contexts: EXPANSION_CAPS.contextsPerRequest + 1,
      }),
      code: "expansion-cap-contexts-per-request",
    },
    {
      label: "tasks",
      request: requestOfSize({ tasks: EXPANSION_CAPS.tasksPerRequest + 1 }),
      code: "expansion-cap-tasks-per-request",
    },
    {
      label: "edges",
      request: requestOfSize({ edges: EXPANSION_CAPS.edgesPerRequest + 1 }),
      code: "expansion-cap-edges-per-request",
    },
    {
      label: "canonical bytes",
      request: requestOfSize({
        canonicalBytes: EXPANSION_CAPS.canonicalPayloadBytes + 1,
      }),
      code: "expansion-cap-payload-bytes",
    },
  ])("refuses a request one past the $label ceiling", ({ request, code }) => {
    expect(checkExpansionRequestCaps(request)?.code).toBe(code);
  });
});

describe("budget caps counted from the permanent ledger (R8)", () => {
  it("admits a request that lands exactly on the per-invoker ceiling", () => {
    const receipts = ledger([
      acceptance({
        addedContextIds: Array.from(
          { length: EXPANSION_CAPS.contextsPerAddingContext - 2 },
          (_, i) => `child-${i}`,
        ),
      }),
    ]);

    expect(
      checkExpansionBudgetCaps({
        receipts,
        invokerContextId: INVOKER,
        newContextCount: 2,
      }),
    ).toBeNull();
  });

  it("refuses the request that would push one invoker past its ceiling", () => {
    const receipts = ledger([
      acceptance({
        addedContextIds: Array.from(
          { length: EXPANSION_CAPS.contextsPerAddingContext - 2 },
          (_, i) => `child-${i}`,
        ),
      }),
    ]);

    expect(
      checkExpansionBudgetCaps({
        receipts,
        invokerContextId: INVOKER,
        newContextCount: 3,
      })?.code,
    ).toBe("expansion-cap-contexts-per-adding-context");
  });

  it("charges each invoker its own per-invoker budget", () => {
    const receipts = ledger([
      acceptance({
        invokerContextId: "other-context",
        addedContextIds: Array.from(
          { length: EXPANSION_CAPS.contextsPerAddingContext },
          (_, i) => `other-${i}`,
        ),
      }),
    ]);

    expect(countExpansionCreatedContextsFor(receipts, "other-context")).toBe(
      EXPANSION_CAPS.contextsPerAddingContext,
    );
    expect(countExpansionCreatedContextsFor(receipts, INVOKER)).toBe(0);
    expect(
      checkExpansionBudgetCaps({
        receipts,
        invokerContextId: INVOKER,
        newContextCount: 1,
      }),
    ).toBeNull();
  });

  it("refuses the request that would push the execution past the cumulative ceiling", () => {
    // Spread across five invokers so no per-invoker ceiling fires first: the
    // cumulative cap has to be the thing that refuses.
    const receipts = ledger(
      Array.from({ length: 5 }, (_, lane) =>
        acceptance({
          requestId: `req-${lane}`,
          invokerContextId: `context-${lane}`,
          addedContextIds: Array.from(
            { length: EXPANSION_CAPS.contextsPerExecution / 5 },
            (_, i) => `lane-${lane}-child-${i}`,
          ),
        }),
      ),
    );

    expect(countExpansionCreatedContexts(receipts)).toBe(
      EXPANSION_CAPS.contextsPerExecution,
    );
    expect(
      checkExpansionBudgetCaps({
        receipts,
        invokerContextId: "context-fresh",
        newContextCount: 1,
      })?.code,
    ).toBe("expansion-cap-contexts-per-execution");
  });

  it("keeps spent budget spent when a generated context is later removed", () => {
    // Receipts are permanent, and the budget counts receipts rather than live
    // contexts — that is what makes the cap monotone. The ledger below records
    // ten contexts for an invoker whose children no longer exist anywhere.
    const receipts = ledger([
      acceptance({
        addedContextIds: Array.from(
          { length: EXPANSION_CAPS.contextsPerAddingContext },
          (_, i) => `removed-${i}`,
        ),
      }),
    ]);

    expect(
      checkExpansionBudgetCaps({
        receipts,
        invokerContextId: INVOKER,
        newContextCount: 1,
      })?.code,
    ).toBe("expansion-cap-contexts-per-adding-context");
  });
});

describe("idempotency classification (R6.3)", () => {
  it("treats a key the ledger has never seen as a new attempt", () => {
    expect(
      classifyExpansionAttempt({
        receipts: EMPTY_EXPANSION_RECEIPTS,
        invokerContextId: INVOKER,
        requestId: "req-1",
        payloadHash: "a".repeat(64),
      }),
    ).toEqual({ kind: "new" });
  });

  it("replays the acceptance receipt for the same key and payload", () => {
    const receipt = acceptance();

    expect(
      classifyExpansionAttempt({
        receipts: ledger([receipt]),
        invokerContextId: INVOKER,
        requestId: "req-1",
        payloadHash: receipt.payloadHash,
      }),
    ).toEqual({ kind: "replay", receipt });
  });

  it("refuses the same requestId carrying a different payload as reuse", () => {
    expect(
      classifyExpansionAttempt({
        receipts: ledger([acceptance()]),
        invokerContextId: INVOKER,
        requestId: "req-1",
        payloadHash: "c".repeat(64),
      }),
    ).toEqual({ kind: "reused", priorPayloadHash: "a".repeat(64) });
  });

  it("scopes the key to the invoking context, so two lanes may reuse an id", () => {
    expect(
      classifyExpansionAttempt({
        receipts: ledger([acceptance()]),
        invokerContextId: "other-context",
        requestId: "req-1",
        payloadHash: "c".repeat(64),
      }),
    ).toEqual({ kind: "new" });
  });

  it("re-refuses a retained refusal identically", () => {
    const receipt = refusal();

    expect(
      classifyExpansionAttempt({
        receipts: ledger([], [receipt]),
        invokerContextId: INVOKER,
        requestId: "req-1",
        payloadHash: receipt.payloadHash,
      }),
    ).toEqual({ kind: "replay-refusal", receipt });
  });

  it("prefers an acceptance over a stale refusal for the same key", () => {
    // A transient refusal the lane then fixed (an unsettled rejoin target, a
    // lost binding) leaves a record behind. Once the retry was ACCEPTED, the
    // acceptance is the answer — otherwise a successful expansion would start
    // reporting as refused.
    const accepted = acceptance();

    expect(
      classifyExpansionAttempt({
        receipts: ledger(
          [accepted],
          [refusal({ payloadHash: accepted.payloadHash })],
        ),
        invokerContextId: INVOKER,
        requestId: "req-1",
        payloadHash: accepted.payloadHash,
      }),
    ).toEqual({ kind: "replay", receipt: accepted });
  });

  it("treats an attempt whose refusal record was evicted as a new attempt", () => {
    // The honest half of the eviction contract (decision D5): a bounded ring
    // cannot promise identical re-refusal forever, so a forgotten attempt is
    // re-validated against CURRENT state rather than answered from memory.
    let receipts = EMPTY_EXPANSION_RECEIPTS;
    const evicted = refusal({ requestId: "req-evicted" });
    receipts = recordExpansionRefusal(receipts, evicted);
    for (let i = 0; i < EXPANSION_CAPS.refusalRingSize; i += 1) {
      receipts = recordExpansionRefusal(
        receipts,
        refusal({
          requestId: `req-later-${i}`,
          payloadHash: `${i}`.padStart(64, "0"),
        }),
      );
    }

    expect(receipts.refusals).toHaveLength(EXPANSION_CAPS.refusalRingSize);
    expect(
      receipts.refusals.some((entry) => entry.requestId === "req-evicted"),
    ).toBe(false);
    expect(
      classifyExpansionAttempt({
        receipts,
        invokerContextId: INVOKER,
        requestId: "req-evicted",
        payloadHash: evicted.payloadHash,
      }),
    ).toEqual({ kind: "new" });
  });
});

describe("ledger writes", () => {
  it("keeps acceptance receipts permanently and refusals in a bounded ring", () => {
    let receipts = EMPTY_EXPANSION_RECEIPTS;
    for (let i = 0; i < EXPANSION_CAPS.refusalRingSize + 5; i += 1) {
      receipts = recordExpansionRefusal(
        receipts,
        refusal({
          requestId: `req-${i}`,
          payloadHash: `${i}`.padStart(64, "0"),
        }),
      );
    }
    receipts = recordExpansionAcceptance(receipts, acceptance());

    expect(receipts.refusals).toHaveLength(EXPANSION_CAPS.refusalRingSize);
    expect(receipts.refusals[0]?.requestId).toBe("req-5");
    expect(
      receipts.refusals[EXPANSION_CAPS.refusalRingSize - 1]?.requestId,
    ).toBe(`req-${EXPANSION_CAPS.refusalRingSize + 4}`);
    expect(receipts.accepted).toHaveLength(1);
    // Both bounds are the ones the persisted schema declares.
    expect(() =>
      graphWorkflowExpansionReceiptsSchema.parse(receipts),
    ).not.toThrow();
  });

  it("replaces rather than accumulates a repeated refusal, so the ring stays informative", () => {
    let receipts = EMPTY_EXPANSION_RECEIPTS;
    receipts = recordExpansionRefusal(
      receipts,
      refusal({ requestId: "other" }),
    );
    for (let i = 0; i < 5; i += 1) {
      receipts = recordExpansionRefusal(receipts, refusal());
    }

    expect(receipts.refusals).toHaveLength(2);
    expect(receipts.refusals.map((entry) => entry.requestId)).toEqual([
      "other",
      "req-1",
    ]);
  });

  it("leaves the input ledger untouched", () => {
    const original = ledger([], []);
    recordExpansionAcceptance(original, acceptance());
    recordExpansionRefusal(original, refusal());

    expect(original).toEqual({ accepted: [], refusals: [] });
  });
});

describe("node-level provenance (R8)", () => {
  it("resolves the receipt that created a context or a task", () => {
    const first = acceptance({
      requestId: "req-1",
      addedContextIds: ["child-a"],
      addedTaskIds: ["child-a-t1"],
    });
    const second = acceptance({
      requestId: "req-2",
      payloadHash: "d".repeat(64),
      addedContextIds: ["child-b"],
      addedTaskIds: ["child-b-t1", "child-b-t2"],
    });
    const receipts = ledger([first, second]);

    expect(resolveExpansionProvenance(receipts, "child-b")).toEqual({
      nodeKind: "context",
      receipt: second,
    });
    expect(resolveExpansionProvenance(receipts, "child-b-t2")).toEqual({
      nodeKind: "task",
      receipt: second,
    });
    expect(resolveExpansionProvenance(receipts, "child-a-t1")).toEqual({
      nodeKind: "task",
      receipt: first,
    });
  });

  it("returns null for a planner-authored node", () => {
    expect(
      resolveExpansionProvenance(ledger([acceptance()]), "context-plan"),
    ).toBeNull();
  });
});
