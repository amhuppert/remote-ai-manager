import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _resetDefaultSessionStatusBusForTesting,
  publishScopedStatusEvent,
  publishSessionStatus,
  setDefaultSessionStatusBusBroadcastForTesting,
  subscribeSessionStatus,
} from "./default-session-status-bus";
import {
  getTraceContext,
  runWithTrace,
  type TraceContext,
} from "@/lib/logging";
import type { ScopedStatusEvent, SSEEvent } from "@/types";

describe("default session status bus", () => {
  beforeEach(() => {
    _resetDefaultSessionStatusBusForTesting();
  });

  afterEach(() => {
    _resetDefaultSessionStatusBusForTesting();
  });

  it("forwards the raw SSEEvent payload to the underlying wire so existing UI consumers keep their contract", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const event: SSEEvent = {
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
      status: "running",
    };

    const outcome = publishSessionStatus(event);
    expect(outcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(event);
  });

  it("isolates wire failures so the calling workflow is not corrupted", () => {
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      throw new Error("wire down");
    });
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const event: SSEEvent = {
      type: "job-status",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      jobId: "job-9",
      branchName: "csm/x",
    };

    const outcome = publishSessionStatus(event);
    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it("publishes the same event types that conversation, graph workflow, and job migrations require", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const events: SSEEvent[] = [
      {
        type: "conversation-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        status: "running",
      },
      {
        type: "ask-question",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        questionId: "q-1",
        questions: [{ question: "ok?", multiSelect: false, options: [] }],
      },
      {
        type: "debug-mode-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        active: true,
        recording: true,
      },
      {
        type: "graph-workflow-status",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-1",
        workflowStatus: "running",
        activeContextIds: [],
        activeBatchIds: [],
        activeJoinIds: [],
        haltReason: null,
        pendingHaltReason: null,
        secondaryHaltReasons: [],
      },
      {
        type: "job-status",
        jobType: "merge",
        status: "running",
        projectName: "p",
        sessionName: "s",
        jobId: "job-9",
        branchName: "csm/x",
      },
      {
        type: "session-finished",
        projectName: "p",
        sessionName: "s",
        branchName: "csm/x",
        detectionMethod: "ancestor",
      },
    ];

    for (const e of events) {
      publishSessionStatus(e);
    }

    expect(wire.mock.calls.map((c) => c[0])).toEqual(events);
  });
});

describe("publishScopedStatusEvent", () => {
  beforeEach(() => {
    _resetDefaultSessionStatusBusForTesting();
  });
  afterEach(() => {
    _resetDefaultSessionStatusBusForTesting();
  });

  it("forwards a collaboration-scope envelope to the wire as a scoped-status SSE event so existing UI consumers see lifecycle updates through /api/events", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const outcome = publishScopedStatusEvent({
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

  it("delivers generic workflow-scope envelopes through the same SSE path so future primitive-native workflows don't need adapter changes", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    publishScopedStatusEvent({
      scope: "workflow",
      scopeId: "wf-generic-7",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });

    expect(wire).toHaveBeenCalledTimes(1);
    const [delivered] = wire.mock.calls[0]!;
    expect(delivered).toMatchObject({
      type: "scoped-status",
      scope: "workflow",
      scopeId: "wf-generic-7",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });
  });

  it("does not break delivery of legacy SSE event types (conversation, debug, graph-workflow, merge job) when scoped-status events are interleaved", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    publishSessionStatus({
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
      status: "running",
    });
    publishScopedStatusEvent({
      scope: "collaboration",
      scopeId: "wf-1",
      status: "running",
      projectName: "p",
      sessionName: "s",
    });
    publishSessionStatus({
      type: "graph-workflow-status",
      projectName: "p",
      sessionName: "s",
      executionId: "exec-1",
      workflowStatus: "running",
      activeContextIds: [],
      activeBatchIds: [],
      activeJoinIds: [],
      haltReason: null,
      pendingHaltReason: null,
      secondaryHaltReasons: [],
    });
    publishSessionStatus({
      type: "job-status",
      jobType: "merge",
      status: "completed",
      projectName: "p",
      sessionName: "s",
      jobId: "job-1",
      branchName: "csm/x",
    });
    publishSessionStatus({
      type: "debug-mode-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
      active: true,
      recording: false,
    });
    publishScopedStatusEvent({
      scope: "workflow",
      scopeId: "wf-9",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });

    const types = wire.mock.calls.map((c) => c[0].type);
    expect(types).toEqual([
      "conversation-status",
      "scoped-status",
      "graph-workflow-status",
      "job-status",
      "debug-mode-status",
      "scoped-status",
    ]);
  });

  it("isolates wire failures so callers receive delivered:false but the publish call never throws and subsequent events still attempt delivery", () => {
    let callCount = 0;
    const calls: SSEEvent[] = [];
    const wire = vi.fn<(event: SSEEvent) => void>((event) => {
      callCount++;
      calls.push(event);
      if (callCount === 1) {
        throw new Error("wire transient");
      }
    });
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const failingPublish = () =>
      publishScopedStatusEvent({
        scope: "collaboration",
        scopeId: "wf-fail-1",
        status: "running",
        projectName: "p",
        sessionName: "s",
      });

    let firstOutcome: ReturnType<typeof failingPublish> | undefined;
    expect(() => {
      firstOutcome = failingPublish();
    }).not.toThrow();
    expect(firstOutcome?.delivered).toBe(false);
    expect(firstOutcome?.error).toBeInstanceOf(Error);

    const secondOutcome = publishScopedStatusEvent({
      scope: "collaboration",
      scopeId: "wf-fail-1",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });

    expect(secondOutcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => (c as { status: string }).status)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("delivers warnings via the production logger wiring (createLogger) when the underlying transport throws so failures are observable in operational logs", () => {
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      throw new Error("transport closed");
    });
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const originalLogSilent = process.env["CC_LOG_SILENT"];
    delete process.env["CC_LOG_SILENT"];

    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        if (typeof chunk === "string") stderrChunks.push(chunk);
        else if (chunk instanceof Uint8Array)
          stderrChunks.push(Buffer.from(chunk).toString("utf8"));
        return true;
      });

    try {
      const outcome = publishSessionStatus({
        type: "conversation-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-9",
        status: "running",
      });

      expect(outcome.delivered).toBe(false);
      const combined = stderrChunks.join("");
      expect(combined).toContain("status-bus.delivery_failed");
    } finally {
      stderrSpy.mockRestore();
      if (originalLogSilent !== undefined) {
        process.env["CC_LOG_SILENT"] = originalLogSilent;
      }
    }
  });

  it("runs each broadcast in a fresh sse:broadcast:<type> trace so wire and subscriber work aggregates per event type", () => {
    const captured: Array<TraceContext | null> = [];
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      captured.push(getTraceContext() ?? null);
    });
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    publishSessionStatus({
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-trace",
      status: "running",
    });
    publishSessionStatus({
      type: "job-status",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      jobId: "job-trace",
      branchName: "csm/x",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.action).toBe("sse:broadcast:conversation-status");
    expect(captured[1]?.action).toBe("sse:broadcast:job-status");
    expect(captured[0]?.traceId).toBeTypeOf("string");
    expect(captured[1]?.traceId).toBeTypeOf("string");
    expect(captured[0]?.traceId).not.toBe(captured[1]?.traceId);
  });

  it("mints a fresh root traceId for each broadcast even when called inside an existing trace scope (so SSE broadcasts aggregate per event type, not per caller)", () => {
    let captured: TraceContext | null = null;
    const wire = vi.fn<(event: SSEEvent) => void>(() => {
      captured = getTraceContext() ?? null;
    });
    setDefaultSessionStatusBusBroadcastForTesting(wire);

    const outer: TraceContext = {
      traceId: "outer-request-trace",
      action: "request:POST /api/foo",
      projectName: "p",
      sessionName: "s",
    };

    runWithTrace(outer, () => {
      publishSessionStatus({
        type: "conversation-status",
        projectName: "p",
        sessionName: "s",
        conversationId: "conv-1",
        status: "running",
      });
    });

    expect(captured).not.toBeNull();
    expect(captured!.action).toBe("sse:broadcast:conversation-status");
    expect(captured!.traceId).not.toBe("outer-request-trace");
    expect(captured!.traceId).toBeTypeOf("string");
  });

  it("notifies in-process subscribers with an envelope whose scope reflects the scoped-status field (not a fallback)", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setDefaultSessionStatusBusBroadcastForTesting(wire);
    const seen: Array<{ scope: string; scopeId: string; status: string }> = [];
    const unsubscribe = subscribeSessionStatus((envelope) => {
      seen.push({
        scope: envelope.scope,
        scopeId: envelope.scopeId,
        status: envelope.status,
      });
    });

    publishScopedStatusEvent({
      scope: "collaboration",
      scopeId: "wf-collab-99",
      status: "completed",
      projectName: "p",
      sessionName: "s",
    });
    publishScopedStatusEvent({
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
});
