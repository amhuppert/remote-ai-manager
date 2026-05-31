/**
 * Production deps-factory tests for Collaboration Mode.
 *
 * These tests verify that `createCollaborationDeps` returns a fully-shaped
 * `AsymmetricCollaborationSliceDeps` so the manager can call
 * `runAsymmetricCollaborationSlice(input, deps)` with the result without
 * further threading. We deliberately do NOT exercise the full slice here —
 * the slice has its own coverage in `envelope.test.ts`. The shape
 * and the in-process StatusBus default behavior are what callers depend on.
 *
 * `vi.mock` is intentionally avoided per project standards: the production
 * factory is invoked directly. Filesystem-backed sub-services (envelope
 * store, artifact registry) are constructed but never written through, so
 * the lazy `require("@/lib/state-store")` call doesn't actually hit disk.
 */
import { describe, it, expect, vi } from "vitest";

import { createCollaborationDeps } from "./deps-factory";
import type { AsymmetricCollaborationSliceDeps } from "./envelope";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/workflows/primitives/status-bus";
import {
  setTranscriptDeps,
  _resetTranscriptDepsForTesting,
} from "@/lib/prompt/transcript";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeFakeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-A",
    name: null,
    transcriptPath: null,
    status: "running",
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    source: "cc",
    summary: null,
    archived: false,
    unread: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: "q-9",
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    ...overrides,
  } as unknown as ConversationState;
}

function makeStubCallAgent(): AsymmetricCollaborationSliceDeps["callAgent"] {
  return vi.fn(async () => {
    throw new Error(
      "stub callAgent should not be invoked during deps-factory tests",
    );
  });
}

const baseInput = {
  projectPath: "/tmp/projects/example",
  sessionName: "collab-session",
  worktreePath: "/tmp/projects/example/.worktrees/collab-session",
};

describe("createCollaborationDeps", () => {
  it("returns a fully-shaped AsymmetricCollaborationSliceDeps", () => {
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    expect(typeof deps.callAgent).toBe("function");
    expect(deps.laneService).toBeDefined();
    expect(typeof deps.laneService.resolve).toBe("function");
    expect(typeof deps.laneService.initialize).toBe("function");
    expect(typeof deps.laneService.recordOutcome).toBe("function");
    expect(deps.laneScheduler).toBeDefined();
    expect(typeof deps.laneScheduler.schedule).toBe("function");
    expect(deps.envelopeStore).toBeDefined();
    expect(typeof deps.envelopeStore.read).toBe("function");
    expect(typeof deps.envelopeStore.upsert).toBe("function");
    expect(deps.statusBus).toBeDefined();
    expect(typeof deps.statusBus.publish).toBe("function");
    expect(typeof deps.statusBus.subscribe).toBe("function");
    expect(typeof deps.markConversationAwaiting).toBe("function");
    expect(typeof deps.updateConversationBackendRef).toBe("function");
  });

  it("forwards the injected callAgent verbatim", () => {
    const callAgent = makeStubCallAgent();
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent,
    });

    expect(deps.callAgent).toBe(callAgent);
  });

  it("default StatusBus delivers published envelopes to in-process subscribers", () => {
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    const received: StatusBusEnvelope[] = [];
    const unsubscribe = deps.statusBus.subscribe((envelope) => {
      received.push(envelope);
    });

    const outcome = deps.statusBus.publish({
      scope: "collaboration",
      scopeId: "wf-001",
      status: "running",
      payload: { type: "round_started", round: 1 },
    });

    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      scope: "collaboration",
      scopeId: "wf-001",
      status: "running",
      payload: { type: "round_started", round: 1 },
    });
  });

  it("honors a caller-supplied StatusBus override", () => {
    const overrideBus = createStatusBus({ broadcast: () => {} });

    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
      statusBus: overrideBus,
    });

    expect(deps.statusBus).toBe(overrideBus);
  });

  it("creates fresh lane state per call but shares the production scheduler across runs", () => {
    const a = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });
    const b = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    expect(a.laneService).not.toBe(b.laneService);
    expect(a.laneScheduler).toBe(b.laneScheduler);
    expect(a.statusBus).not.toBe(b.statusBus);
  });

  it("threads projectName + sessionName as meta when invoking transcript append, so message-appended broadcasts fire on collaboration transcript writes", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "deps-factory-meta-"));
    const events: SSEEvent[] = [];
    const previousConfigDir = process.env["CC_CONFIG_DIR"];
    process.env["CC_CONFIG_DIR"] = tmpRoot;
    setTranscriptDeps({
      broadcast: (event) => {
        events.push(event);
      },
    });
    try {
      const deps = createCollaborationDeps({
        ...baseInput,
        callAgent: makeStubCallAgent(),
        projectName: "example",
      });

      await deps.appendTranscriptEntry!("conv-A", {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      });

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe("message-appended");
      if (event.type === "message-appended") {
        expect(event.projectName).toBe("example");
        expect(event.sessionName).toBe("collab-session");
        expect(event.conversationId).toBe("conv-A");
        expect(event.seq).toBe(0);
      }
    } finally {
      _resetTranscriptDepsForTesting();
      if (previousConfigDir === undefined) {
        delete process.env["CC_CONFIG_DIR"];
      } else {
        process.env["CC_CONFIG_DIR"] = previousConfigDir;
      }
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("markConversationAwaiting sets unread=true alongside status=awaiting and broadcasts conversation-unread so the conversation pins to 'Finished — unread'", async () => {
    const mutationCalls: Array<{
      projectPath: string;
      sessionName: string;
      conversationId: string;
      label: string;
      result: ConversationState;
    }> = [];
    const publishedEvents: SSEEvent[] = [];

    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
      projectName: "example",
      mutateConversation: async (
        projectPath,
        sessionName,
        conversationId,
        label,
        mutate,
      ) => {
        const conversation = makeFakeConversation({ id: conversationId });
        await mutate(conversation);
        mutationCalls.push({
          projectPath,
          sessionName,
          conversationId,
          label,
          result: conversation,
        });
        return undefined as never;
      },
      publishSessionStatus: (event) => {
        publishedEvents.push(event);
        return { delivered: true };
      },
    });

    await deps.markConversationAwaiting!("conv-A", {
      workflowId: "wf-001",
      timestamp: "2026-04-28T10:00:00.000Z",
    });

    expect(mutationCalls).toHaveLength(1);
    const call = mutationCalls[0]!;
    expect(call.projectPath).toBe(baseInput.projectPath);
    expect(call.sessionName).toBe(baseInput.sessionName);
    expect(call.conversationId).toBe("conv-A");
    expect(call.result.status).toBe("awaiting");
    expect(call.result.unread).toBe(true);
    expect(call.result.pendingQuestionId).toBeNull();
    expect(call.result.pendingQuestions).toBeNull();

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      type: "conversation-unread",
      projectName: "example",
      sessionName: baseInput.sessionName,
      conversationId: "conv-A",
      unread: true,
    });
  });
});
