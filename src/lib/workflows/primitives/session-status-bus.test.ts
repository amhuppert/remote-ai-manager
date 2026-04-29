import { describe, it, expect, beforeEach } from "vitest";
import {
  createSessionStatusBus,
  publishScopedStatus,
  resolveSessionStatusScope,
} from "./session-status-bus";
import type { SSEEvent } from "@/types";

interface CapturedBroadcast {
  events: SSEEvent[];
}

function makeCapture(): CapturedBroadcast {
  return { events: [] };
}

beforeEach(() => {});

describe("resolveSessionStatusScope", () => {
  it("classifies known SSE event types into the documented scopes", () => {
    expect(
      resolveSessionStatusScope({ type: "conversation-status" }).scope,
    ).toBe("conversation");
    expect(resolveSessionStatusScope({ type: "ask-question" }).scope).toBe(
      "conversation",
    );
    expect(resolveSessionStatusScope({ type: "debug-mode-status" }).scope).toBe(
      "debug",
    );
    expect(
      resolveSessionStatusScope({ type: "debug-log-received" }).scope,
    ).toBe("debug");
    expect(
      resolveSessionStatusScope({ type: "graph-workflow-status" }).scope,
    ).toBe("graph_workflow");
    expect(
      resolveSessionStatusScope({ type: "graph-workflow-task-status" }).scope,
    ).toBe("graph_workflow");
    expect(resolveSessionStatusScope({ type: "session-finished" }).scope).toBe(
      "merge_job",
    );
    expect(
      resolveSessionStatusScope({ type: "job-status", jobType: "merge" }).scope,
    ).toBe("merge_job");
    expect(
      resolveSessionStatusScope({ type: "notification-created" }).scope,
    ).toBe("notification");
  });

  it("passes scope, scopeId, and status through directly for scoped-status events (collaboration scope)", () => {
    const resolution = resolveSessionStatusScope({
      type: "scoped-status",
      scope: "collaboration",
      scopeId: "wf-collab-1",
      status: "paused",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "p",
      sessionName: "s",
    });
    expect(resolution).toEqual({
      scope: "collaboration",
      scopeId: "wf-collab-1",
      status: "paused",
    });
  });

  it("passes scope, scopeId, and status through for the generic workflow scope", () => {
    const resolution = resolveSessionStatusScope({
      type: "scoped-status",
      scope: "workflow",
      scopeId: "wf-generic-7",
      status: "completed",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "p",
      sessionName: "s",
    });
    expect(resolution).toEqual({
      scope: "workflow",
      scopeId: "wf-generic-7",
      status: "completed",
    });
  });

  it("falls back to the generic workflow scope when scoped-status carries an unrecognized scope", () => {
    const resolution = resolveSessionStatusScope({
      type: "scoped-status",
      scope: "future-feature-not-yet-defined",
      scopeId: "wf-x",
      status: "running",
      timestamp: "2026-04-28T00:00:00.000Z",
      projectName: "p",
      sessionName: "s",
    });
    expect(resolution.scope).toBe("workflow");
    expect(resolution.scopeId).toBe("wf-x");
    expect(resolution.status).toBe("running");
  });

  it("derives scopeId from the event payload", () => {
    expect(
      resolveSessionStatusScope({
        type: "conversation-status",
        conversationId: "conv-1",
      }).scopeId,
    ).toBe("conv-1");
    expect(
      resolveSessionStatusScope({
        type: "graph-workflow-status",
        executionId: "exec-7",
      }).scopeId,
    ).toBe("exec-7");
    expect(
      resolveSessionStatusScope({
        type: "job-status",
        jobType: "merge",
        jobId: "job-9",
      }).scopeId,
    ).toBe("job-9");
  });

  it("maps lifecycle status from feature payloads", () => {
    expect(
      resolveSessionStatusScope({
        type: "conversation-status",
        status: "running",
      }).status,
    ).toBe("running");
    expect(
      resolveSessionStatusScope({
        type: "conversation-status",
        status: "awaiting",
      }).status,
    ).toBe("paused");
    expect(
      resolveSessionStatusScope({
        type: "conversation-status",
        status: "waiting_for_input",
      }).status,
    ).toBe("paused");
    expect(
      resolveSessionStatusScope({
        type: "job-status",
        status: "completed",
      }).status,
    ).toBe("completed");
    expect(
      resolveSessionStatusScope({
        type: "job-status",
        status: "failed",
      }).status,
    ).toBe("failed");
    expect(
      resolveSessionStatusScope({
        type: "job-status",
        status: "conflicts",
      }).status,
    ).toBe("paused");
    expect(resolveSessionStatusScope({ type: "ask-question" }).status).toBe(
      "paused",
    );
  });
});

describe("createSessionStatusBus", () => {
  it("forwards the feature payload (not the envelope) to the underlying broadcast wire", () => {
    const cap = makeCapture();
    const bus = createSessionStatusBus({
      broadcast: (event) => cap.events.push(event),
    });

    const featureEvent: SSEEvent = {
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
      status: "running",
    };

    bus.publish({
      scope: "conversation",
      scopeId: "conv-1",
      status: "running",
      payload: featureEvent,
    });

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]).toEqual(featureEvent);
  });

  it("delivers the full scoped envelope to in-process subscribers while the wire receives the raw feature payload", () => {
    const cap = makeCapture();
    const bus = createSessionStatusBus({
      broadcast: (event) => cap.events.push(event),
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const seen: Array<{
      scope: string;
      scopeId: string;
      status: string;
      timestamp: string;
      payload: unknown;
    }> = [];
    bus.subscribe((envelope) => {
      seen.push({
        scope: envelope.scope,
        scopeId: envelope.scopeId,
        status: envelope.status,
        timestamp: envelope.timestamp,
        payload: envelope.payload,
      });
    });

    const featureEvent: SSEEvent = {
      type: "graph-workflow-task-status",
      projectName: "p",
      sessionName: "s",
      executionId: "exec-1",
      taskId: "t-1",
      contextId: "c-1",
      status: "running",
      source: "user",
      order: 1,
    };

    publishScopedStatus(featureEvent, { bus });

    expect(seen).toEqual([
      {
        scope: "graph_workflow",
        scopeId: "exec-1",
        status: "running",
        timestamp: "2026-04-28T00:00:00.000Z",
        payload: featureEvent,
      },
    ]);
    expect(cap.events).toEqual([featureEvent]);
  });
});

describe("publishScopedStatus", () => {
  it("derives scope, scopeId, and lifecycle status from a known SSE event and broadcasts the unchanged payload", () => {
    const cap = makeCapture();
    const bus = createSessionStatusBus({
      broadcast: (event) => cap.events.push(event),
    });

    const event: SSEEvent = {
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
      status: "running",
    };

    const outcome = publishScopedStatus(event, { bus });
    expect(outcome.delivered).toBe(true);
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]).toEqual(event);
  });

  it("preserves multiple feature payload shapes within one scope (no global payload schema)", () => {
    const cap = makeCapture();
    const bus = createSessionStatusBus({
      broadcast: (event) => cap.events.push(event),
    });

    const events: SSEEvent[] = [
      {
        type: "graph-workflow-status",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-1",
        workflowStatus: "running",
        activeContextId: null,
        haltReason: null,
      },
      {
        type: "graph-workflow-task-status",
        projectName: "p",
        sessionName: "s",
        executionId: "exec-1",
        taskId: "task-1",
        contextId: "ctx-1",
        status: "running",
        source: "user",
        order: 1,
      },
    ];

    for (const e of events) {
      publishScopedStatus(e, { bus });
    }

    expect(cap.events).toEqual(events);
  });

  it("does not throw when the wire fails (status delivery failures stay isolated)", () => {
    const bus = createSessionStatusBus({
      broadcast: () => {
        throw new Error("wire down");
      },
      logger: { warn: () => {} },
    });

    const event: SSEEvent = {
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-1",
      status: "running",
    };
    const outcome = publishScopedStatus(event, { bus });
    expect(outcome.delivered).toBe(false);
  });
});
