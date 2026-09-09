import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ScopedStatusEvent, SSEEvent } from "@/lib/api/sse-events";
import {
  getTraceContext,
  runWithTrace,
  type TraceContext,
} from "@/lib/logging";
import type { StatusBusEnvelope } from "./status-bus";
import {
  _resetPublicationForTesting,
  publishEvent,
  publishEventBestEffort,
  publishScopedStatus,
  setPublicationBroadcastForTesting,
  subscribeLifecycle,
  type PublishFn,
} from "./publication";

function conversationStatusEvent(conversationId: string): SSEEvent {
  return {
    type: "conversation-status",
    scope: "session",
    projectName: "p",
    sessionName: "s",
    conversationId,
    status: "running",
  };
}

function messageAppendedEvent(): SSEEvent {
  return {
    type: "message-appended",
    scope: "session",
    projectName: "p",
    sessionName: "s",
    conversationId: "conv-1",
    seq: 1,
    message: { role: "assistant", content: [], timestamp: null },
  };
}

function messageUpdatedEvent(): SSEEvent {
  return {
    type: "message-updated",
    scope: "session",
    projectName: "p",
    sessionName: "s",
    conversationId: "conv-1",
    seq: 1,
    message: { role: "assistant", content: [], timestamp: null },
  };
}

describe("publishEvent", () => {
  beforeEach(() => {
    _resetPublicationForTesting();
  });
  afterEach(() => {
    _resetPublicationForTesting();
  });

  it("delivers the raw SSEEvent to the wire unchanged and the lifecycle envelope (payload === event) to subscribers", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);
    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    const event = conversationStatusEvent("conv-1");
    const outcome = publishEvent(event);
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(event);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
    });
    expect(envelopes[0]?.payload).toBe(event);
    expect(envelopes[0]?.timestamp).toBeTypeOf("string");
  });

  it("delivers non-lifecycle events to the wire with zero subscriber envelopes (fallback removed)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);
    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    const unread: SSEEvent = {
      type: "conversation-unread",
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-unread-1",
      unread: true,
    };
    const appended = messageAppendedEvent();

    expect(publishEvent(unread).delivered).toBe(true);
    expect(publishEvent(appended).delivered).toBe(true);
    unsubscribe();

    expect(wire.mock.calls.map((c) => c[0])).toEqual([unread, appended]);
    expect(envelopes).toEqual([]);
  });

  it("does not manufacture a lifecycle envelope for graph-workflow-lane-status (wire delivery only)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);
    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    const outcome = publishEvent({
      type: "graph-workflow-lane-status",
      projectName: "p",
      sessionName: "s",
      executionId: "exec-lane-1",
      laneId: "lane-1",
      kind: "worktree",
      status: "active",
      branchName: "csm/lane-1",
      worktreePath: null,
      includedContextIds: [],
      lastCommittingContextId: null,
    });
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(envelopes).toEqual([]);
  });

  it("runs each broadcast under a fresh sse:broadcast:<type> root trace, even inside an existing trace scope", () => {
    const captured: Array<TraceContext | null> = [];
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      captured.push(getTraceContext() ?? null);
    });
    setPublicationBroadcastForTesting(wire);

    publishEvent(conversationStatusEvent("conv-trace"));
    const outer: TraceContext = {
      traceId: "outer-request-trace",
      action: "request:POST /api/foo",
    };
    runWithTrace(outer, () => {
      publishEvent({
        type: "job-status",
        jobType: "merge",
        status: "running",
        projectName: "p",
        sessionName: "s",
        jobId: "job-trace",
        branchName: "csm/x",
      });
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.action).toBe("sse:broadcast:conversation-status");
    expect(captured[1]?.action).toBe("sse:broadcast:job-status");
    expect(captured[0]?.traceId).toBeTypeOf("string");
    expect(captured[1]?.traceId).not.toBe("outer-request-trace");
    expect(captured[0]?.traceId).not.toBe(captured[1]?.traceId);
  });

  // Pins the UNTRACED_HOT_PATH_TYPES exception to exactly the two
  // message-stream event types: each must reach the wire once with no trace
  // root minted, so a future change can't silently start tracing one of them
  // (or drop it from the exception) without failing this contract.
  it.each([
    ["message-appended", messageAppendedEvent],
    ["message-updated", messageUpdatedEvent],
  ] as const)(
    "publishes the %s hot-path event without minting a trace root (per-event tracing deviation)",
    (_type, build) => {
      const captured: Array<TraceContext | null> = [];
      const wire = vi.fn<(event: SSEEvent) => void>(() => {
        captured.push(getTraceContext() ?? null);
      });
      setPublicationBroadcastForTesting(wire);

      publishEvent(build());

      expect(captured).toEqual([null]);
      expect(wire).toHaveBeenCalledTimes(1);
    },
  );

  it("never throws on transport failure: returns delivered:false with the error and still notifies subscribers", () => {
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      throw new Error("wire down");
    });
    setPublicationBroadcastForTesting(wire);
    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    let outcome: ReturnType<typeof publishEvent> | undefined;
    expect(() => {
      outcome = publishEvent(conversationStatusEvent("conv-fail"));
    }).not.toThrow();
    unsubscribe();

    expect(outcome?.delivered).toBe(false);
    expect(outcome?.error).toBeInstanceOf(Error);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.scopeId).toBe("conv-fail");
  });

  it("never throws on transport failure for wire-only events either", () => {
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      throw new Error("wire down");
    });
    setPublicationBroadcastForTesting(wire);

    const outcome = publishEvent(messageAppendedEvent());
    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it("never throws when a lifecycle event's projected scopeId is empty (bus envelope parse rejects it)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const runningJobWithEmptyId: SSEEvent = {
      type: "job-status",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      jobId: "",
      branchName: "csm/x",
    };

    let outcome: ReturnType<typeof publishEvent> | undefined;
    expect(() => {
      outcome = publishEvent(runningJobWithEmptyId);
    }).not.toThrow();

    expect(outcome?.delivered).toBe(false);
    expect(outcome?.error).toBeInstanceOf(Error);
    // The empty scopeId never reaches the wire.
    expect(wire).not.toHaveBeenCalled();
  });

  it("never throws when a conversation-status event carries an empty conversationId (manager direct-publisher path)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const statusWithEmptyId: SSEEvent = {
      type: "conversation-status",
      scope: "session",
      projectName: "p",
      sessionName: "s",
      conversationId: "",
      status: "running",
    };

    let outcome: ReturnType<typeof publishEvent> | undefined;
    expect(() => {
      outcome = publishEvent(statusWithEmptyId);
    }).not.toThrow();

    expect(outcome?.delivered).toBe(false);
    expect(outcome?.error).toBeInstanceOf(Error);
    expect(wire).not.toHaveBeenCalled();
  });

  it("isolates a subscriber throw: the wire and remaining subscribers still receive the event", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);
    const seen: string[] = [];
    const unsubscribeThrowing = subscribeLifecycle(() => {
      throw new Error("subscriber exploded");
    });
    const unsubscribeHealthy = subscribeLifecycle((envelope) => {
      seen.push(envelope.scopeId);
    });

    const outcome = publishEvent(conversationStatusEvent("conv-iso"));
    unsubscribeThrowing();
    unsubscribeHealthy();

    expect(outcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["conv-iso"]);
  });
});

describe("publishEventBestEffort", () => {
  beforeEach(() => {
    _resetPublicationForTesting();
  });
  afterEach(() => {
    _resetPublicationForTesting();
  });

  const sampleEvent = conversationStatusEvent("conv-be");

  it("publishes the built event on the happy path without warning", () => {
    const publish = vi.fn(() => ({ delivered: true as const }));
    const warn = vi.fn();

    publishEventBestEffort({
      publish,
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(publish).toHaveBeenCalledWith(sampleEvent);
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a build throw and warns with context plus the error message", () => {
    const publish = vi.fn(() => ({ delivered: true as const }));
    const warn = vi.fn();

    publishEventBestEffort({
      publish,
      build: () => {
        throw new Error("bad shape");
      },
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      error: "bad shape",
    });
  });

  it("swallows a publish throw and warns", () => {
    const publish = vi.fn(() => {
      throw new Error("transport down");
    });
    const warn = vi.fn();

    publishEventBestEffort({
      publish,
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      error: "transport down",
    });
  });

  it("warns with the caller's context when the default publish path reports a failed delivery", () => {
    setPublicationBroadcastForTesting(() => {
      throw new Error("wire down");
    });
    const warn = vi.fn();

    expect(() => {
      publishEventBestEffort({
        build: () => sampleEvent,
        logger: { warn },
        failureEvent: "x.broadcast_failed",
        context: { conversationId: "c1" },
      });
    }).not.toThrow();

    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      error: "wire down",
    });
  });

  /**
   * A caller whose logs may not carry free text — checkpoint diagnostics under
   * R9.2 — projects the failure itself. The default stays the message, so
   * every other publisher is unchanged.
   */
  it("lets a caller project the failure into its own log fields", () => {
    const warn = vi.fn();
    const describeError = (error: unknown) => ({
      errorKind: error instanceof Error ? error.name : typeof error,
      errorChars: error instanceof Error ? error.message.length : 0,
    });

    publishEventBestEffort({
      publish: () => {
        throw new TypeError("quoted source: ship the widget");
      },
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
      describeError,
    });

    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      errorKind: "TypeError",
      errorChars: "quoted source: ship the widget".length,
    });
  });

  it("applies the caller's projection to a reported failed delivery too", () => {
    const warn = vi.fn();

    publishEventBestEffort({
      publish: () => ({
        delivered: false,
        error: new Error("quoted source: ship the widget"),
      }),
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
      describeError: () => ({ errorKind: "projected" }),
    });

    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      errorKind: "projected",
    });
  });

  it("warns when an injected publisher reports failure without an error", () => {
    const warn = vi.fn();
    const malformedPublish = (() => ({
      delivered: false,
    })) as unknown as PublishFn;

    publishEventBestEffort({
      publish: malformedPublish,
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      error: "Publication reported failed delivery without an error",
    });
  });
});

describe("publishScopedStatus", () => {
  beforeEach(() => {
    _resetPublicationForTesting();
  });
  afterEach(() => {
    _resetPublicationForTesting();
  });

  it("constructs a scoped-status SSE event and delivers it to the wire with all fields", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const outcome = publishScopedStatus({
      scope: "collaboration",
      scopeId: "wf-collab-1",
      status: "paused",
      projectName: "p",
      sessionName: "s",
      payload: { kind: "paused_for_user_input", round: 2 },
      timestamp: "2026-04-28T00:00:00.000Z",
      reason: "user_input_required",
    });

    expect(outcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(1);
    const [delivered] = wire.mock.calls[0]!;
    expect(delivered).toEqual<ScopedStatusEvent>({
      type: "scoped-status",
      scope: "collaboration",
      scopeId: "wf-collab-1",
      status: "paused",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "p",
      sessionName: "s",
      payload: { kind: "paused_for_user_input", round: 2 },
      reason: "user_input_required",
    });
  });

  it("defaults the timestamp and omits optional payload/reason when not provided", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    publishScopedStatus({
      scope: "workflow",
      scopeId: "wf-generic-7",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });

    const [delivered] = wire.mock.calls[0]!;
    if (delivered.type !== "scoped-status") {
      throw new Error("expected a scoped-status event on the wire");
    }
    expect(delivered.timestamp).toBeTypeOf("string");
    expect("payload" in delivered).toBe(false);
    expect("reason" in delivered).toBe(false);
  });

  it("notifies lifecycle subscribers with the scoped-status fields (not a fallback scope)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);
    const seen: Array<{ scope: string; scopeId: string; status: string }> = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      seen.push({
        scope: envelope.scope,
        scopeId: envelope.scopeId,
        status: envelope.status,
      });
    });

    publishScopedStatus({
      scope: "collaboration",
      scopeId: "wf-collab-99",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });
    publishScopedStatus({
      scope: "workflow",
      scopeId: "wf-gen-99",
      status: "running",
      projectName: "p",
      sessionName: "s",
    });
    unsubscribe();

    expect(seen).toEqual([
      { scope: "collaboration", scopeId: "wf-collab-99", status: "completed" },
      { scope: "workflow", scopeId: "wf-gen-99", status: "running" },
    ]);
  });

  it("isolates wire failures across sequential publishes (first fails, second still delivers)", () => {
    let callCount = 0;
    const statuses: string[] = [];
    const wire = vi.fn<(event: SSEEvent) => void>((event) => {
      callCount++;
      if (event.type === "scoped-status") statuses.push(event.status);
      if (callCount === 1) throw new Error("wire transient");
    });
    setPublicationBroadcastForTesting(wire);

    const first = publishScopedStatus({
      scope: "collaboration",
      scopeId: "wf-fail-1",
      status: "running",
      projectName: "p",
      sessionName: "s",
    });
    const second = publishScopedStatus({
      scope: "collaboration",
      scopeId: "wf-fail-1",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });

    expect(first.delivered).toBe(false);
    expect(first.error).toBeInstanceOf(Error);
    expect(second.delivered).toBe(true);
    expect(statuses).toEqual(["running", "completed"]);
  });
});
