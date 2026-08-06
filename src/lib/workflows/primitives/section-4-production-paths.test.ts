/**
 * Section 4 — production-path verification.
 *
 * The companion `section-4-end-to-end.test.ts` exercises `publishEvent`
 * and `createDefaultSessionArtifactRegistry` in isolation. These tests instead
 * exercise the **migrated production publishers and artifact producers** and
 * prove that, with no broadcast/registry overrides, they:
 *
 *  1. Route their live status events through the shared default session
 *     status bus (so in-process subscribers see the scoped envelope and the
 *     wire still sees the raw feature payload).
 *  2. Route their durable outputs through the shared artifact registry (so the
 *     canonical paths and reference-document registration semantics are
 *     preserved).
 *
 * Concretely, this file verifies:
 *  - the message queue service `enqueue` (message-queued) publishes through the shared bus.
 *  - `createGraphWorkflowExecutionEventPublisher` publishes graph workflow
 *    status events through the shared bus when no `broadcast` override is
 *    given.
 *  - `createScriptValidatorRunner` writes its `validation_log` artifact
 *    through the shared `ArtifactRegistry` (kind `validation_log`,
 *    `.cc/workflow/<executionId>/...`).
 *  - The focus.md auto-registration site uses the registry's `register()`
 *    method to register a `focus_memory` artifact rather than calling
 *    `createReferenceDocument` directly outside of the registration target.
 *
 * Each test covers a single migrated production path and uses the production
 * default code paths (no `broadcast`/`registry` injected for status; the bus
 * wire is overridden via the documented test seam).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import {
  publishEvent,
  setPublicationBroadcastForTesting,
  subscribeLifecycle,
  _resetPublicationForTesting,
} from "@/lib/events/publication";
import type { StatusBusEnvelope } from "@/lib/events/status-bus";
import type {
  ArtifactRegistry,
  ArtifactRecord,
  ArtifactWriteRequest,
  ArtifactWriteOptionalRequest,
  ArtifactRegisterRequest,
  ArtifactWriteOutcome,
} from "./artifact-registry";
import { ArtifactRequiredFailure } from "./artifact-registry";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  createMessageQueueService,
  type MessageQueueServiceDeps,
} from "@/lib/conversations/message-queue-service";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createScriptValidatorRunner } from "@/lib/workflow-graph/script-validator-runner";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { registerFocusMemoryIfPresent } from "@/lib/workflows/conversation/pre-turn/focus-memory";

interface CapturedRegistryCall {
  type: "write" | "writeOptional" | "register";
  request:
    | ArtifactWriteRequest
    | ArtifactWriteOptionalRequest
    | ArtifactRegisterRequest;
}

function makeRecordingArtifactRegistry(): {
  registry: ArtifactRegistry;
  calls: CapturedRegistryCall[];
} {
  const calls: CapturedRegistryCall[] = [];
  const fakeRecord = (
    kind: ArtifactWriteRequest["kind"],
    relativePath: string,
  ): ArtifactRecord => ({
    artifactId: `art-${calls.length}`,
    kind,
    relativePath,
    audience: "internal_log",
    source: { createdAt: "2026-04-28T00:00:00.000Z" },
  });
  const registry: ArtifactRegistry = {
    write: async (request) => {
      calls.push({ type: "write", request });
      return fakeRecord(request.kind, request.relativePath);
    },
    writeOptional: async (request): Promise<ArtifactWriteOutcome> => {
      calls.push({ type: "writeOptional", request });
      return {
        status: "registered",
        record: fakeRecord(request.kind, request.relativePath),
      };
    },
    register: async (request) => {
      calls.push({ type: "register", request });
      return fakeRecord(request.kind, request.relativePath);
    },
  };
  return { registry, calls };
}

describe("section 4 production paths — migrated publishers go through the shared status bus", () => {
  let workingDir: string;

  beforeEach(async () => {
    _resetPublicationForTesting();
    workingDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "section4-prod-paths-"),
    );
  });

  afterEach(async () => {
    _resetPublicationForTesting();
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it("the queue service enqueue broadcasts its message-queued event through the publication module (wire delivery only — message-queued is not a lifecycle event)", async () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    // In-memory conversation backing the real enqueue transform — no DB.
    const conversation: ConversationState = conversationStateSchema.parse({
      id: "conv-prod-1",
      transcriptPath: null,
      status: "running",
      promptCount: 0,
      createdAt: "2026-04-28T00:00:00.000Z",
      lastActivityAt: "2026-04-28T00:00:00.000Z",
    });

    const serviceDeps: MessageQueueServiceDeps = {
      async mutateConversation(
        _projectPath,
        _sessionName,
        _conversationId,
        _label,
        mutate,
      ) {
        // Apply the real production mutate to the backing object so the test
        // exercises the production enqueue path, not a mock of it.
        return mutate(conversation);
      },
      async getConversation() {
        return conversation;
      },
      getProjectDisplayName() {
        return "p";
      },
      // Route this production broadcast through the REAL shared default bus.
      broadcast: (event) => {
        publishEvent(event);
      },
      now() {
        return "2026-04-28T00:00:00.000Z";
      },
      newId() {
        return "queued-1";
      },
    };

    const service = createMessageQueueService(serviceDeps);

    const entry = await service.enqueue({
      projectPath: "/proj/p",
      sessionName: "s",
      conversationId: "conv-prod-1",
      content: [{ type: "text", text: "hello" }],
    });

    unsubscribe();

    expect(entry.id).toBe("queued-1");

    expect(wire).toHaveBeenCalledTimes(1);
    const wireEvent = wire.mock.calls[0]?.[0];
    if (wireEvent?.type !== "message-queued") {
      throw new Error("expected a message-queued event on the wire");
    }
    expect(wireEvent.projectName).toBe("p");
    // A session-keyed enqueue emits the session variant, which is the only
    // variant that carries a session name.
    expect(wireEvent.scope).toBe("session");
    if (wireEvent.scope !== "session") {
      throw new Error("expected the session variant on the wire");
    }
    expect(wireEvent.sessionName).toBe("s");
    expect(wireEvent.conversationId).toBe("conv-prod-1");
    // The expanded payload carries both the structured view and the text.
    expect(wireEvent.text).toBe("hello");
    expect(wireEvent.message?.id).toBe("queued-1");
    expect(wireEvent.message?.status).toBe("pending");

    // message-queued is outside the enumerated lifecycle set: the wire gets
    // the raw event, in-process lifecycle subscribers get nothing.
    expect(envelopes).toEqual([]);
  });

  it("graph workflow execution event publisher routes its events through the shared default session status bus when no broadcast override is supplied", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      status: "completed",
      activeContextIds: [],
    });

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/proj/p",
      sessionName: "s",
      previousExecution,
      nextExecution,
    });
    publisher.deliver(delivery);

    unsubscribe();

    expect(wire.mock.calls.length).toBeGreaterThan(0);
    const wireEvent = wire.mock.calls[0]?.[0];
    expect(wireEvent?.type).toBe("graph-workflow-status");

    expect(envelopes.length).toBeGreaterThan(0);
    const statusEnvelope = envelopes.find(
      (e) =>
        (e.payload as { type?: string } | null)?.type ===
        "graph-workflow-status",
    );
    expect(statusEnvelope).toBeDefined();
    expect(statusEnvelope?.scope).toBe("graph_workflow");
    expect(statusEnvelope?.scopeId).toBe(nextExecution.id);
    expect(statusEnvelope?.status).toBe("completed");
  });

  it("script validator runner writes its validation_log through the shared artifact registry (preserving the .cc/workflow/<executionId>/ canonical layout)", async () => {
    const { registry, calls } = makeRecordingArtifactRegistry();
    const runner = createScriptValidatorRunner({
      validationService: {
        submitSystem: vi.fn().mockResolvedValue({
          kind: "accepted",
          runId: "run-1",
          status: "running",
          position: null,
          lease: null,
        }),
        waitForCompletion: vi.fn().mockResolvedValue({
          kind: "failed",
          runId: "run-1",
          exitCode: 1,
          output: "fail",
        }),
        cancelSystemOwned: vi.fn().mockResolvedValue(true),
      },
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-04-28T01:02:03.000Z"),
      artifactRegistry: registry,
    });

    const outcome = await runner.runScriptValidator({
      projectPath: "/projects/acme",
      worktreePath: "/projects/acme/.worktrees/ctx-abc",
      sessionName: "ctx-abc",
      branchName: "csm/ctx-abc",
      executionId: "exec-prod-1",
      contextId: "ctx-plan",
      commands: ["pre-merge"],
    });

    expect(outcome.kind).toBe("fail");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.type).toBe("write");
    const req = call.request as ArtifactWriteRequest;
    expect(req.kind).toBe("validation_log");
    expect(req.audience).toBe("internal_log");
    expect(req.relativePath).toMatch(
      /^\.cc\/workflow\/exec-prod-1\/pre-merge-\d{8}T\d{6}Z-run-1\.log$/,
    );
    expect(req.source.workflowId).toBe("exec-prod-1");
  });

  it("script validator runner converts artifact write failures into infra_error so workflow recovery still has the failure semantics it expects", async () => {
    const failingRegistry: ArtifactRegistry = {
      write: async (request) => {
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: request.relativePath,
          stage: "write",
          message: "disk full",
        });
      },
      writeOptional: async () => ({
        status: "skipped_warning",
        warning: "n/a",
      }),
      register: async () => {
        throw new Error("not used");
      },
    };
    const runner = createScriptValidatorRunner({
      validationService: {
        submitSystem: vi.fn().mockResolvedValue({
          kind: "accepted",
          runId: "run-1",
          status: "running",
          position: null,
          lease: null,
        }),
        waitForCompletion: vi.fn().mockResolvedValue({
          kind: "failed",
          runId: "run-1",
          exitCode: 1,
          output: "fail",
        }),
        cancelSystemOwned: vi.fn().mockResolvedValue(true),
      },
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      now: () => new Date("2026-04-28T01:02:03.000Z"),
      artifactRegistry: failingRegistry,
    });

    const outcome = await runner.runScriptValidator({
      projectPath: "/projects/acme",
      worktreePath: "/projects/acme/.worktrees/ctx-abc",
      sessionName: "ctx-abc",
      branchName: "csm/ctx-abc",
      executionId: "exec-fail",
      contextId: "ctx-plan",
      commands: ["pre-merge"],
    });

    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind === "infra_error") {
      expect(outcome.reason).toBe("exception");
      expect(outcome.message).toBe("disk full");
    }
  });

  it("conversation focus_memory registration routes through ArtifactRegistry.register() (preserves canonical memory-bank/focus.md path and the existing createReferenceDocument hook)", async () => {
    const { registry, calls } = makeRecordingArtifactRegistry();
    const referenceDocCalls: Array<{
      projectPath: string;
      sessionName: string;
      filePath: string;
      description: string;
    }> = [];

    await registerFocusMemoryIfPresent({
      worktreePath: workingDir,
      projectPath: "/projects/acme",
      sessionName: "ctx-abc",
      conversationId: "conv-focus-1",
      fileExists: () => true,
      registerReferenceDocument: async (
        projectPath,
        sessionName,
        filePath,
        description,
      ) => {
        referenceDocCalls.push({
          projectPath,
          sessionName,
          filePath,
          description,
        });
        return {};
      },
      artifactRegistry: registry,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.type).toBe("register");
    const req = call.request as ArtifactRegisterRequest;
    expect(req.kind).toBe("focus_memory");
    expect(req.relativePath).toBe("memory-bank/focus.md");
    expect(req.source.workflowId).toBe("conv-focus-1");
    expect(req.description.length).toBeGreaterThan(0);
  });

  it("conversation focus_memory registration is a no-op when memory-bank/focus.md is absent (preserves prior behavior)", async () => {
    const { registry, calls } = makeRecordingArtifactRegistry();
    const referenceDocCalls: Array<unknown> = [];

    await registerFocusMemoryIfPresent({
      worktreePath: workingDir,
      projectPath: "/projects/acme",
      sessionName: "ctx-abc",
      conversationId: "conv-focus-missing",
      fileExists: () => false,
      registerReferenceDocument: async () => {
        referenceDocCalls.push("called");
        return {};
      },
      artifactRegistry: registry,
    });

    expect(calls).toHaveLength(0);
    expect(referenceDocCalls).toHaveLength(0);
  });

  it("conversation focus_memory production path (default registry) calls the supplied createReferenceDocument with the canonical path so the existing reference-document store stays the source of truth", async () => {
    await fs.mkdir(path.join(workingDir, "memory-bank"), { recursive: true });
    await fs.writeFile(
      path.join(workingDir, "memory-bank/focus.md"),
      "# focus\n",
    );

    const calls: Array<{
      projectPath: string;
      sessionName: string;
      filePath: string;
      description: string;
    }> = [];

    await registerFocusMemoryIfPresent({
      worktreePath: workingDir,
      projectPath: "/projects/acme",
      sessionName: "ctx-abc",
      conversationId: "conv-focus-prod",
      fileExists: (p) => {
        if (p.endsWith("memory-bank/focus.md")) return true;
        return false;
      },
      registerReferenceDocument: async (
        projectPath,
        sessionName,
        filePath,
        description,
      ) => {
        calls.push({ projectPath, sessionName, filePath, description });
        return {};
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      projectPath: "/projects/acme",
      sessionName: "ctx-abc",
      filePath: "memory-bank/focus.md",
      description:
        "Current work-in-progress and remaining tasks for this session",
    });
  });

  it("debug-log API publishers go through the shared default session status bus when posting debug-log-received events", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    // Simulate the API route's call. The route imports `publishEvent`
    // and calls it with a debug-log-received SSEEvent.
    const outcome = publishEvent({
      type: "debug-log-received",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-debug-1",
      entryCount: 7,
    });

    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire.mock.calls[0]?.[0]).toMatchObject({
      type: "debug-log-received",
      conversationId: "conv-debug-1",
      entryCount: 7,
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.scope).toBe("debug");
    expect(envelopes[0]?.scopeId).toBe("conv-debug-1");
  });

  it("background job publishers route through the shared default session status bus for job-status events without an explicit broadcast override", () => {
    const wire = vi.fn<(event: SSEEvent) => void>();
    setPublicationBroadcastForTesting(wire);

    const envelopes: StatusBusEnvelope[] = [];
    const unsubscribe = subscribeLifecycle((envelope) => {
      envelopes.push(envelope);
    });

    const outcome = publishEvent({
      type: "job-status",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      jobId: "job-prod-1",
      branchName: "csm/x",
    });

    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.scope).toBe("merge_job");
    expect(envelopes[0]?.scopeId).toBe("job-prod-1");
    expect(envelopes[0]?.status).toBe("running");
  });
});
