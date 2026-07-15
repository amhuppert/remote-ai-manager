import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createStatusBus,
  statusBusEnvelopeSchema,
  type StatusBusBroadcastFn,
  type StatusBusEnvelope,
} from "./status-bus";

const FIXED_NOW = "2026-04-28T12:00:00.000Z";

function makeFakeBroadcast(): {
  broadcast: StatusBusBroadcastFn;
  calls: Array<unknown>;
} {
  const calls: unknown[] = [];
  const broadcast: StatusBusBroadcastFn = (event) => {
    calls.push(event);
  };
  return { broadcast, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("statusBusEnvelopeSchema", () => {
  it("requires scope, scopeId, status, timestamp, and a payload", () => {
    const valid = {
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      timestamp: FIXED_NOW,
      payload: { type: "conversation-status", anything: 1 },
    };
    expect(statusBusEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts arbitrary feature-owned payloads without forcing one global schema", () => {
    const conversation = {
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      timestamp: FIXED_NOW,
      payload: {
        type: "conversation-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
      },
    };
    const graph = {
      scope: "graph_workflow",
      scopeId: "exec-1",
      status: "paused",
      timestamp: FIXED_NOW,
      payload: {
        type: "graph-workflow-validation-result",
        validatorType: "context",
        pass: false,
      },
    };
    expect(statusBusEnvelopeSchema.safeParse(conversation).success).toBe(true);
    expect(statusBusEnvelopeSchema.safeParse(graph).success).toBe(true);
  });

  it("rejects envelopes missing the scope or scopeId", () => {
    const missingScope = {
      scopeId: "conv-1",
      status: "running",
      timestamp: FIXED_NOW,
      payload: {},
    };
    const missingScopeId = {
      scope: "conversation",
      status: "running",
      timestamp: FIXED_NOW,
      payload: {},
    };
    expect(statusBusEnvelopeSchema.safeParse(missingScope).success).toBe(false);
    expect(statusBusEnvelopeSchema.safeParse(missingScopeId).success).toBe(
      false,
    );
  });

  it("only allows running, paused, completed, and failed lifecycle statuses", () => {
    const allowed = ["running", "paused", "completed", "failed"];
    for (const status of allowed) {
      expect(
        statusBusEnvelopeSchema.safeParse({
          scope: "conversation",
          scopeId: "conv-1",
          status,
          timestamp: FIXED_NOW,
          payload: {},
        }).success,
      ).toBe(true);
    }
    expect(
      statusBusEnvelopeSchema.safeParse({
        scope: "conversation",
        scopeId: "conv-1",
        status: "weird",
        timestamp: FIXED_NOW,
        payload: {},
      }).success,
    ).toBe(false);
  });
});

describe("createStatusBus", () => {
  it("publishes a scoped envelope through the supplied broadcast function", () => {
    const { broadcast, calls } = makeFakeBroadcast();
    const bus = createStatusBus({
      broadcast,
      now: () => FIXED_NOW,
    });

    bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: {
        type: "conversation-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
      },
    });

    expect(calls.length).toBe(1);
    const env = calls[0] as StatusBusEnvelope;
    expect(env.scope).toBe("conversation");
    expect(env.scopeId).toBe("conv-1");
    expect(env.status).toBe("running");
    expect(env.timestamp).toBe(FIXED_NOW);
    expect(env.payload).toMatchObject({ type: "conversation-status" });
  });

  it("preserves existing event granularity by carrying the full feature payload", () => {
    const { broadcast, calls } = makeFakeBroadcast();
    const bus = createStatusBus({
      broadcast,
      now: () => FIXED_NOW,
    });

    const featurePayload = {
      type: "graph-workflow-task-status",
      executionId: "exec-1",
      taskId: "task-7",
      contextId: "ctx-a",
      status: "running",
      source: "explicit",
      order: 3,
      lastConversationId: null,
    };

    bus.publish({
      scope: "graph_workflow",
      scopeId: "exec-1",
      status: "running",
      payload: featurePayload,
    });

    const env = calls[0] as StatusBusEnvelope;
    expect(env.payload).toEqual(featurePayload);
  });

  it("supports running, paused, completed, and failed status updates", () => {
    const { broadcast, calls } = makeFakeBroadcast();
    const bus = createStatusBus({ broadcast, now: () => FIXED_NOW });

    const statuses = ["running", "paused", "completed", "failed"] as const;
    for (const status of statuses) {
      bus.publish({
        scope: "graph_workflow",
        scopeId: "exec-1",
        status,
        payload: { type: `graph-workflow-${status}`, info: status },
      });
    }
    expect(calls.length).toBe(4);
    expect((calls as StatusBusEnvelope[]).map((e) => e.status)).toEqual(
      statuses,
    );
  });

  it("logs when broadcast fails and never throws (delivery degradation only)", () => {
    const broadcast: StatusBusBroadcastFn = () => {
      throw new Error("transport closed");
    };
    const errors: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const bus = createStatusBus({
      broadcast,
      now: () => FIXED_NOW,
      logger: {
        warn: (event, fields) => errors.push({ event, fields }),
      },
    });

    expect(() =>
      bus.publish({
        scope: "conversation",
        scopeId: "conv-1",
        status: "running",
        payload: { type: "conversation-status", projectName: "p" },
      }),
    ).not.toThrow();

    expect(errors.length).toBe(1);
    expect(errors[0]?.event).toBe("status-bus.delivery_failed");
    expect(errors[0]?.fields).toMatchObject({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
    });
    expect(errors[0]?.fields["error"]).toBeDefined();
  });

  it("returns a delivery outcome to callers that want to observe status delivery", () => {
    const { broadcast: ok } = makeFakeBroadcast();
    const okBus = createStatusBus({ broadcast: ok, now: () => FIXED_NOW });
    const okOutcome = okBus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: { type: "conversation-status" },
    });
    expect(okOutcome.delivered).toBe(true);
    expect(okOutcome.error).toBeUndefined();

    const failingBroadcast: StatusBusBroadcastFn = () => {
      throw new Error("nope");
    };
    const failBus = createStatusBus({
      broadcast: failingBroadcast,
      now: () => FIXED_NOW,
      logger: { warn: () => {} },
    });
    const failOutcome = failBus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: { type: "conversation-status" },
    });
    expect(failOutcome.delivered).toBe(false);
    expect(failOutcome.error).toBeInstanceOf(Error);
  });

  it("does not mutate the supplied payload object on publish", () => {
    const { broadcast } = makeFakeBroadcast();
    const bus = createStatusBus({ broadcast, now: () => FIXED_NOW });
    const original = { type: "x", value: 1 };
    bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: original,
    });
    expect(original).toEqual({ type: "x", value: 1 });
  });

  it("requires non-empty scope and scopeId", () => {
    const { broadcast } = makeFakeBroadcast();
    const bus = createStatusBus({ broadcast, now: () => FIXED_NOW });

    expect(() =>
      bus.publish({
        scope: "",
        scopeId: "conv-1",
        status: "running",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      bus.publish({
        scope: "conversation",
        scopeId: "",
        status: "running",
        payload: {},
      }),
    ).toThrow();
  });

  it("notifies in-process subscribers with the full scoped envelope (not just the payload)", () => {
    const { broadcast } = makeFakeBroadcast();
    const bus = createStatusBus({ broadcast, now: () => FIXED_NOW });

    const seen: StatusBusEnvelope[] = [];
    bus.subscribe((envelope) => {
      seen.push(envelope);
    });

    bus.publish({
      scope: "graph_workflow",
      scopeId: "exec-1",
      status: "paused",
      payload: { type: "graph-workflow-status", workflowStatus: "halted" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      scope: "graph_workflow",
      scopeId: "exec-1",
      status: "paused",
      timestamp: FIXED_NOW,
      payload: { type: "graph-workflow-status", workflowStatus: "halted" },
    });
  });

  it("supports multiple subscribers and isolates failures so other subscribers and the wire still receive the envelope", () => {
    const { broadcast, calls } = makeFakeBroadcast();
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const bus = createStatusBus({
      broadcast,
      now: () => FIXED_NOW,
      logger: {
        warn: (event, fields) => warnings.push({ event, fields }),
      },
    });

    const seenA: StatusBusEnvelope[] = [];
    const seenB: StatusBusEnvelope[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber A failed");
    });
    bus.subscribe((envelope) => seenA.push(envelope));
    bus.subscribe((envelope) => seenB.push(envelope));

    const outcome = bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: { type: "conversation-status" },
    });

    expect(outcome.delivered).toBe(true);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(
      warnings.some((w) => w.event === "status-bus.subscriber_failed"),
    ).toBe(true);
  });

  it("stops notifying a subscriber after its unsubscribe handle is called", () => {
    const { broadcast } = makeFakeBroadcast();
    const bus = createStatusBus({ broadcast, now: () => FIXED_NOW });

    const seen: StatusBusEnvelope[] = [];
    const unsubscribe = bus.subscribe((envelope) => seen.push(envelope));

    bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: {},
    });
    unsubscribe();
    bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "completed",
      payload: {},
    });

    expect(seen).toHaveLength(1);
  });

  it("notifies subscribers even when the wire transport throws (subscriber delivery is independent)", () => {
    const failingBroadcast: StatusBusBroadcastFn = () => {
      throw new Error("wire down");
    };
    const bus = createStatusBus({
      broadcast: failingBroadcast,
      now: () => FIXED_NOW,
      logger: { warn: () => {} },
    });

    const seen: StatusBusEnvelope[] = [];
    bus.subscribe((envelope) => seen.push(envelope));

    const outcome = bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: { type: "conversation-status" },
    });

    expect(outcome.delivered).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scope).toBe("conversation");
  });
});
