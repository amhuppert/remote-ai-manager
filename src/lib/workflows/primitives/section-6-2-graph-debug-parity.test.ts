/**
 * Section 6.2 — graph + debug workflow parity verification.
 *
 * Task 6.2 of the composable-workflow-primitives spec requires that debug and
 * graph workflows be adapted to shared execution, lanes, gates, and artifacts
 * **without changing the request/response shapes, event names, artifact paths,
 * or durable state visible to existing callers**.
 *
 * The primary migrations are in place:
 *  - `execution-events.ts` defaults to `publishEvent` instead of the
 *    older direct-broadcast wire.
 *  - `script-validator-runner.ts` writes `validation_log` artifacts through
 *    the shared `ArtifactRegistry` primitive.
 *  - The conversation manager publishes `debug-mode-status` /
 *    `debug-log-received` events through `publishEvent`.
 *  - `validator-runner.ts` builds `task_run` `AgentCallRequest`s and dispatches
 *    them through the shared `executeAgentCall` facade (verified by the
 *    "validator-runner builds task_run requests through deps.executeAgentCall"
 *    test below).
 *  - `iteration-orchestrator.ts` routes both circuit-breaker trip points
 *    (script-validator failure path, context-validator failure path) through
 *    the shared `runCircuitBreakerGate` primitive instead of inline
 *    `failureCount >= threshold` checks (verified by the dedicated
 *    iteration-orchestrator tests that inject a spy into the
 *    `runCircuitBreakerGate` dep).
 *  - Validator responses run through the structured-output Zod schema, which
 *    surfaces deterministic gate-style outcomes (`pass` / `fail` /
 *    `infra_error`) on top of the underlying `parseValidatorResponse`.
 *  - Implementer turns intentionally enter the `AgentCall` primitive through
 *    the conversation actor (`executePromptStream` → `executePromptForMachine`
 *    → `dispatchTurnViaAgentCall` → `executeAgentCall`) so the graph workflow
 *    keeps the conversation lifecycle (transcript writing, single-flight
 *    session lock, machine-state transitions) the UI relies on.
 *
 * These tests act as parity guards: every graph + debug SSE event variant the
 * existing UI consumes must still pass through the shared bus unchanged, the
 * canonical pre-merge log path must remain `.cc/workflow/<executionId>/...`,
 * and structured-output / circuit-breaker decisions must continue to map onto
 * the shared gate vocabulary so workflow-policy code keeps the same
 * branchable contract.
 *
 * Each test exercises the production default path (no broadcast/registry
 * override beyond the documented test seam) so a future regression that
 * silently changes a wire shape, a status mapping, or a canonical artifact
 * path is caught here rather than at runtime in the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowExecutionEventPublisherDeps,
} from "@/lib/workflow-graph/execution-events";
import { createScriptValidatorRunner } from "@/lib/workflow-graph/script-validator-runner";
import { applyJoinProgress } from "@/lib/workflow-graph/context-transitions";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import { runCircuitBreakerGate } from "./circuit-breaker-gate";
import { runStructuredOutputGate } from "./structured-output-gate";
import { workflowBlockingValidatorResultSchema } from "@/lib/workflow-graph/definition-schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowStatus,
  GraphWorkflowTaskStatus,
} from "@/lib/workflow-graph/definition-schemas";
function captureWire() {
  const wire = vi.fn<(event: SSEEvent) => void>();
  setPublicationBroadcastForTesting(wire);
  return wire;
}

function captureEnvelopes() {
  const envelopes: StatusBusEnvelope[] = [];
  const unsubscribe = subscribeLifecycle((envelope) => {
    envelopes.push(envelope);
  });
  return { envelopes, unsubscribe };
}

function makeExecutionWithStatus(
  status: GraphWorkflowStatus,
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status,
    activeContextIds: status === "running" ? ["context-plan"] : [],
  });
}

describe("section 6.2 — graph + debug workflow parity (Task 6.2)", () => {
  let workingDir: string;

  beforeEach(async () => {
    _resetPublicationForTesting();
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "section6-2-"));
  });

  afterEach(async () => {
    _resetPublicationForTesting();
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  describe("graph-workflow-status preserves every status variant on the wire", () => {
    const cases: Array<{
      status: GraphWorkflowStatus;
      expectedScopeStatus: "running" | "paused" | "completed" | "failed";
    }> = [
      { status: "pending", expectedScopeStatus: "running" },
      { status: "running", expectedScopeStatus: "running" },
      { status: "paused", expectedScopeStatus: "paused" },
      { status: "halted", expectedScopeStatus: "paused" },
      { status: "completed", expectedScopeStatus: "completed" },
      { status: "aborted", expectedScopeStatus: "failed" },
    ];

    for (const { status, expectedScopeStatus } of cases) {
      it(`preserves graph-workflow-status payload for status=${status} and maps to envelope status=${expectedScopeStatus}`, () => {
        const wire = captureWire();
        const { envelopes, unsubscribe } = captureEnvelopes();

        const publisher = createGraphWorkflowExecutionEventPublisher({
          now: () => "2026-04-28T00:00:00.000Z",
        });

        const previousExecution =
          status === "pending" ? null : makeExecutionWithStatus("pending");
        const nextExecution = makeExecutionWithStatus(status);

        const delivery = publisher.publishExecutionUpdate({
          projectPath: "/projects/acme",
          sessionName: "session-1",
          previousExecution,
          nextExecution,
        });
        publisher.deliver(delivery);

        unsubscribe();

        const statusCalls = wire.mock.calls
          .map((c) => c[0])
          .filter((e) => e.type === "graph-workflow-status");
        expect(statusCalls).toHaveLength(1);
        expect(statusCalls[0]).toEqual({
          type: "graph-workflow-status",
          projectName: "acme",
          sessionName: "session-1",
          executionId: nextExecution.id,
          workflowStatus: status,
          activeContextIds: nextExecution.activeContextIds,
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: null,
          pendingHaltReason: null,
          secondaryHaltReasons: [],
        });

        const envelope = envelopes.find(
          (e) =>
            (e.payload as { type?: string } | null)?.type ===
            "graph-workflow-status",
        );
        expect(envelope).toBeDefined();
        expect(envelope?.scope).toBe("graph_workflow");
        expect(envelope?.scopeId).toBe(nextExecution.id);
        expect(envelope?.status).toBe(expectedScopeStatus);
      });
    }
  });

  describe("graph-workflow-task-status preserves every status variant on the wire", () => {
    // Note: `pending` is the initial task state in the fixture, so a
    // pending-stays-pending transition is correctly silent under the
    // diff-only contract — it's exercised by the no-emit regression test
    // below rather than the per-variant suite.
    const cases: Array<{
      status: GraphWorkflowTaskStatus;
      expectedScopeStatus: "running" | "paused" | "completed" | "failed";
    }> = [
      { status: "running", expectedScopeStatus: "running" },
      { status: "interrupted", expectedScopeStatus: "paused" },
      { status: "completed", expectedScopeStatus: "completed" },
      { status: "failed", expectedScopeStatus: "failed" },
    ];

    for (const { status, expectedScopeStatus } of cases) {
      it(`preserves graph-workflow-task-status payload for status=${status} and maps to envelope status=${expectedScopeStatus}`, () => {
        const wire = captureWire();
        const { envelopes, unsubscribe } = captureEnvelopes();

        const publisher = createGraphWorkflowExecutionEventPublisher({
          now: () => "2026-04-28T00:00:00.000Z",
        });

        const previousExecution = makeExecutionWithStatus("running");
        const nextExecution: GraphWorkflowExecution = {
          ...previousExecution,
          taskStates: {
            ...previousExecution.taskStates,
            "task-plan-1": {
              ...previousExecution.taskStates["task-plan-1"]!,
              status,
              startedAt:
                status === "running" || status === "completed"
                  ? "2026-04-28T00:00:01.000Z"
                  : null,
              completedAt:
                status === "completed" ? "2026-04-28T00:00:02.000Z" : null,
            },
          },
        };

        const delivery = publisher.publishExecutionUpdate({
          projectPath: "/projects/acme",
          sessionName: "session-1",
          previousExecution,
          nextExecution,
        });
        publisher.deliver(delivery);

        unsubscribe();

        const taskStatusCalls = wire.mock.calls
          .map((c) => c[0])
          .filter((e) => e.type === "graph-workflow-task-status");
        expect(taskStatusCalls).toHaveLength(1);
        expect(taskStatusCalls[0]).toMatchObject({
          type: "graph-workflow-task-status",
          projectName: "acme",
          sessionName: "session-1",
          executionId: nextExecution.id,
          taskId: "task-plan-1",
          contextId: "context-plan",
          status,
          source: "user",
          order: 1,
        });

        const taskEnvelope = envelopes.find(
          (e) =>
            (e.payload as { type?: string } | null)?.type ===
            "graph-workflow-task-status",
        );
        expect(taskEnvelope).toBeDefined();
        expect(taskEnvelope?.scope).toBe("graph_workflow_task");
        expect(taskEnvelope?.scopeId).toBe(`${nextExecution.id}/task-plan-1`);
        expect(taskEnvelope?.status).toBe(expectedScopeStatus);
      });
    }
  });

  it("preserves graph-workflow-circuit-breaker payload through the shared bus", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const previousExecution = makeExecutionWithStatus("running");
    const nextExecution: GraphWorkflowExecution = {
      ...previousExecution,
      status: "halted",
      activeContextIds: ["context-plan"],
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: "consecutive failures exhausted retry budget",
      },
      contextStates: {
        ...previousExecution.contextStates,
        "context-plan": {
          ...previousExecution.contextStates["context-plan"]!,
          consecutiveFailureCount: 3,
          consecutiveCandidateMismatchCount: 0,
        },
      },
    };

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });
    publisher.deliver(delivery);

    unsubscribe();

    const breaker = wire.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "graph-workflow-circuit-breaker");
    expect(breaker).toEqual({
      type: "graph-workflow-circuit-breaker",
      projectName: "acme",
      sessionName: "session-1",
      executionId: nextExecution.id,
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: "consecutive failures exhausted retry budget",
    });

    // Point event outside the enumerated lifecycle set: wire-only,
    // no lifecycle envelope is manufactured for it.
    const envelope = envelopes.find(
      (e) =>
        (e.payload as { type?: string } | null)?.type ===
        "graph-workflow-circuit-breaker",
    );
    expect(envelope).toBeUndefined();
  });

  it("preserves graph-workflow-validation-result payload through the shared bus", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const execution = makeExecutionWithStatus("running");
    const validationDelivery = publisher.publishValidationResult({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      validatorType: "context",
      pass: false,
      summary: "two issues",
      issues: [
        {
          taskId: "task-plan-1",
          title: "Plan is too narrow",
          description: "Add steps for migration testing",
        },
      ],
      reopenTaskIds: ["task-plan-1"],
      sessionRef: {
        backend: "claude",
        ref: "claude-conv-1",
        lane: "context_validator",
        refKind: "conversation",
        workflowConversationId: "claude-conv-1",
      },
    });
    publisher.deliver(validationDelivery);

    unsubscribe();

    const validation = wire.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "graph-workflow-validation-result");
    expect(validation).toMatchObject({
      type: "graph-workflow-validation-result",
      projectName: "acme",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      validatorType: "context",
      pass: false,
      summary: "two issues",
      reopenTaskIds: ["task-plan-1"],
      sessionRef: {
        backend: "claude",
        ref: "claude-conv-1",
        lane: "context_validator",
        refKind: "conversation",
        workflowConversationId: "claude-conv-1",
      },
    });

    // Point event outside the enumerated lifecycle set: wire-only,
    // no lifecycle envelope is manufactured for it.
    const envelope = envelopes.find(
      (e) =>
        (e.payload as { type?: string } | null)?.type ===
        "graph-workflow-validation-result",
    );
    expect(envelope).toBeUndefined();
  });

  it("preserves graph-workflow-shared-documents-updated payload through the shared bus", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const previousExecution = makeExecutionWithStatus("running");
    const nextExecution: GraphWorkflowExecution = {
      ...previousExecution,
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Plan doc",
          readWhen: "Before resuming",
          kind: "shared",
          createdAt: "2026-04-28T00:00:00.000Z",
          updatedAt: "2026-04-28T00:00:00.000Z",
          lastUpdatedByConversationId: "conv-1",
        },
      ],
    };

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });
    publisher.deliver(delivery);

    unsubscribe();

    const docsEvent = wire.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "graph-workflow-shared-documents-updated");
    expect(docsEvent).toMatchObject({
      type: "graph-workflow-shared-documents-updated",
      projectName: "acme",
      sessionName: "session-1",
      executionId: nextExecution.id,
      documents: nextExecution.sharedDocuments,
    });

    // Point event outside the enumerated lifecycle set: wire-only,
    // no lifecycle envelope is manufactured for it.
    const envelope = envelopes.find(
      (e) =>
        (e.payload as { type?: string } | null)?.type ===
        "graph-workflow-shared-documents-updated",
    );
    expect(envelope).toBeUndefined();
  });

  it("preserves graph-workflow-context-status payload through the shared bus", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const previousExecution = makeExecutionWithStatus("running");
    const nextExecution: GraphWorkflowExecution = {
      ...previousExecution,
      contextStates: {
        ...previousExecution.contextStates,
        "context-plan": {
          ...previousExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
        },
      },
    };

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });
    publisher.deliver(delivery);

    unsubscribe();

    const contextStatus = wire.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "graph-workflow-context-status");
    expect(contextStatus).toEqual({
      type: "graph-workflow-context-status",
      projectName: "acme",
      sessionName: "session-1",
      executionId: nextExecution.id,
      contextId: "context-plan",
      status: "completed",
      remainingTaskCount: 0,
      iterationCount: 1,
    });

    const envelope = envelopes.find(
      (e) =>
        (e.payload as { type?: string } | null)?.type ===
        "graph-workflow-context-status",
    );
    expect(envelope).toBeDefined();
    expect(envelope?.scope).toBe("graph_workflow_context");
    expect(envelope?.scopeId).toBe(`${nextExecution.id}/context-plan`);
  });

  it("does not emit any wire events when execution state is unchanged (preserves existing diff-only behavior)", () => {
    const wire = captureWire();
    const { unsubscribe } = captureEnvelopes();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const execution = makeExecutionWithStatus("running");

    publisher.publishExecutionUpdate({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      previousExecution: execution,
      nextExecution: execution,
    });

    unsubscribe();
    expect(wire).not.toHaveBeenCalled();
  });

  it("respects an explicit broadcast override (existing tests / call sites that bypass the shared bus continue to work)", () => {
    const wire = captureWire();
    const overrideBroadcast =
      vi.fn<
        NonNullable<GraphWorkflowExecutionEventPublisherDeps["broadcast"]>
      >();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: overrideBroadcast,
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const previousExecution = makeExecutionWithStatus("pending");
    const nextExecution = makeExecutionWithStatus("running");

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });
    publisher.deliver(delivery);

    expect(overrideBroadcast).toHaveBeenCalled();
    expect(wire).not.toHaveBeenCalled();
  });

  it("preserves debug-mode-status payload through the shared bus with the debug scope envelope", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: SSEEvent = {
      type: "debug-mode-status",
      projectName: "acme",
      sessionName: "session-1",
      conversationId: "conv-debug-1",
      active: true,
      recording: true,
    };
    const outcome = publishEvent(event);
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.scope).toBe("debug");
    expect(envelopes[0]?.scopeId).toBe("conv-debug-1");
  });

  it("preserves debug-log-received payload through the shared bus with the debug scope envelope", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: SSEEvent = {
      type: "debug-log-received",
      projectName: "acme",
      sessionName: "session-1",
      conversationId: "conv-debug-1",
      entryCount: 4,
    };
    const outcome = publishEvent(event);
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.scope).toBe("debug");
    expect(envelopes[0]?.scopeId).toBe("conv-debug-1");
  });

  it("script-validator-runner preserves the canonical .cc/workflow/<executionId>/pre-merge-*.log path through the shared artifact registry", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
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
          output: "fail output captured",
        }),
        cancelSystemOwned: vi.fn().mockResolvedValue(true),
      },
      writeFile: async (filePath: string, contents: string) => {
        writes.push({ path: filePath, content: contents });
      },
      mkdir: async (dirPath: string) => {
        mkdirs.push(dirPath);
        return undefined;
      },
      now: () => new Date("2026-04-28T01:02:03.000Z"),
    });

    const outcome = await runner.runScriptValidator({
      projectPath: "/projects/acme",
      worktreePath: "/projects/acme/.worktrees/ctx-abc",
      sessionName: "ctx-abc",
      branchName: "csm/ctx-abc",
      executionId: "exec-task-6-2",
      contextId: "ctx-plan",
      commands: ["pre-merge"],
    });

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.logRelativePath).toMatch(
        /^\.cc\/workflow\/exec-task-6-2\/pre-merge-\d{8}T\d{6}Z-run-1\.log$/,
      );
      expect(
        outcome.logFilePath.startsWith(
          "/projects/acme/.worktrees/ctx-abc/.cc/workflow/exec-task-6-2/",
        ),
      ).toBe(true);
    }

    expect(writes).toHaveLength(1);
    const writtenPath = writes[0]!.path;
    expect(writtenPath.includes(".cc/workflow/exec-task-6-2/")).toBe(true);
    expect(writes[0]!.content).toContain("execution: exec-task-6-2");
    expect(writes[0]!.content).toContain("context: ctx-plan");
    expect(writes[0]!.content).toContain("fail output captured");

    expect(mkdirs.length).toBeGreaterThan(0);
    expect(mkdirs.some((m) => m.includes(".cc/workflow/exec-task-6-2"))).toBe(
      true,
    );
  });

  it("structured-output gate fails when a validator response does not match the workflow validator Zod schema (deterministic gate path preserved)", () => {
    const validator = (
      _schema: Record<string, unknown>,
      value: unknown,
    ): { valid: boolean; errors?: string[] } => {
      const parsed = workflowBlockingValidatorResultSchema.safeParse(value);
      if (parsed.success) return { valid: true };
      return {
        valid: false,
        errors: parsed.error.issues.map((i) => i.message),
      };
    };

    const passResult = runStructuredOutputGate(
      {},
      { summary: "ok", issues: [], advisories: [] },
      validator,
    );
    expect(passResult.status).toBe("pass");
    expect(passResult.kind).toBe("structured_output");

    const failResult = runStructuredOutputGate(
      {},
      { summary: 42, issues: "not-an-array" },
      validator,
    );
    expect(failResult.status).toBe("fail");
    if (failResult.status !== "fail") return;
    expect(failResult.kind).toBe("structured_output");
    expect(failResult.reason).toMatch(/structured output failed validation/);
    const errors = (failResult.details as { errors: string[] }).errors;
    expect(errors.length).toBeGreaterThan(0);
  });

  it("graph workflow execution loop routes its consecutive-failure halt through the runCircuitBreakerGate dep", async () => {
    const { createGraphWorkflowExecutionLoop } =
      await import("@/lib/workflow-graph/execution-loop");

    const definition = createResolvedWorkflowDefinition();
    const contextId = definition.executionContexts[0]!.id;
    const threshold =
      definition.executionContexts[0]!.circuitBreaker
        .consecutiveFailureThreshold ?? 3;

    // Built from the shared factory, not hand-rolled: the loop reads lane,
    // join, and collaboration state unconditionally, so a partial execution
    // cast into shape throws inside the context task and the run halts on
    // recovery_error before ever reaching the breaker.
    const baseExecution = createWorkflowExecution({
      workingDefinition: definition,
      status: "running",
      activeContextIds: [contextId],
      startedAt: "2026-04-28T00:00:00.000Z",
    });
    const initialExecution: GraphWorkflowExecution = {
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        [contextId]: {
          ...baseExecution.contextStates[contextId]!,
          status: "running",
          iterationCount: 1,
          consecutiveFailureCount: threshold - 1,
        },
      },
    };

    let currentExecution = initialExecution;

    const sendSpy = vi.fn(
      async (_p: string, _s: string, _event: { type: "complete" }) => {
        return currentExecution;
      },
    );

    const recordPendingHaltReasonSpy = vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        reason: GraphWorkflowHaltReason;
      }) => {
        if (currentExecution.pendingHaltReason !== null) {
          return { execution: currentExecution, accepted: false };
        }
        currentExecution = {
          ...currentExecution,
          pendingHaltReason: input.reason,
        };
        return { execution: currentExecution, accepted: true };
      },
    );

    const drainAndHaltSpy = vi.fn(async () => {
      const haltReason = currentExecution.pendingHaltReason;
      if (!haltReason) {
        throw new Error("drainAndHalt requires pendingHaltReason");
      }
      currentExecution = {
        ...currentExecution,
        status: "halted",
        haltReason,
        pendingHaltReason: null,
      };
      return currentExecution;
    });

    const runCircuitBreakerGate = vi.fn(
      (input: { failureCount: number; threshold: number }) =>
        input.failureCount >= input.threshold
          ? {
              status: "fail" as const,
              kind: "circuit_breaker" as const,
              reason: "tripped",
              details: {
                failureCount: input.failureCount,
                threshold: input.threshold,
                tripped: true,
              },
            }
          : {
              status: "pass" as const,
              kind: "circuit_breaker" as const,
              details: {
                failureCount: input.failureCount,
                threshold: input.threshold,
                tripped: false,
              },
            },
    );

    const sessionStub = {
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: {
        async scheduleEligibleContexts() {
          if (currentExecution.status !== "running") {
            return {
              execution: currentExecution,
              scheduled: { kind: "none" },
            };
          }
          return {
            execution: currentExecution,
            scheduled: { kind: "solo", contextId },
          };
        },
        send: sendSpy,
        recordPendingHaltReason: recordPendingHaltReasonSpy,
        drainAndHalt: drainAndHaltSpy,
        async mutateActive(_p, _s, fn) {
          const result = await fn(currentExecution);
          currentExecution =
            "execution" in result && "events" in result
              ? result.execution
              : result;
          return currentExecution;
        },
        async getActive() {
          return currentExecution;
        },
      },
      iterationOrchestrator: {
        runIteration: async () => {
          const next = {
            ...currentExecution,
            contextStates: {
              ...currentExecution.contextStates,
              [contextId]: {
                ...currentExecution.contextStates[contextId]!,
                consecutiveFailureCount: threshold,
              },
            },
          };
          currentExecution = next;
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: true,
          };
        },
      },
      parallelWorktrees: {
        provision: vi.fn(),
        provisionBatch: vi.fn(),
        dispose: vi.fn(),
        provisionLane: vi.fn(),
        provisionLaneBatch: vi.fn(),
        disposeLane: vi.fn(),
        cleanupLane: vi.fn(async () => ({ status: "removed" as const })),
      },
      mergeMutex: { withMergeMutex: async (_k, fn) => fn() },
      sessionGitLock: { withSessionGitLock: async (_k, fn) => fn() },
      mergeRunner: { run: vi.fn() },
      joinRunner: {
        async run({ joinId, mutateActive }) {
          await mutateActive((e) =>
            applyJoinProgress(e, joinId, new Date().toISOString(), {
              status: "succeeded",
            }),
          );
          return { status: "succeeded" };
        },
      },
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: {
        resolve: () => ({
          worktreePath: sessionStub.worktreePath,
          branchName: sessionStub.branchName,
          isolation: "session",
          laneId: null,
        }),
      },
      getSession: async () => sessionStub as never,
      runCircuitBreakerGate,
    });

    const result = await loop.run({
      projectPath: "/projects/acme",
      projectName: "acme",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(runCircuitBreakerGate).toHaveBeenCalledWith({
      failureCount: threshold,
      threshold,
    });
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("circuit_breaker");
  });

  it("circuit-breaker gate maps execution context's consecutiveFailureCount onto the shared gate vocabulary", () => {
    const definition = createResolvedWorkflowDefinition();
    const threshold =
      definition.executionContexts[0]!.circuitBreaker
        .consecutiveFailureThreshold ?? 3;

    const passing = runCircuitBreakerGate({
      failureCount: 0,
      threshold,
    });
    expect(passing.status).toBe("pass");
    expect(passing.kind).toBe("circuit_breaker");

    const tripped = runCircuitBreakerGate({
      failureCount: threshold,
      threshold,
    });
    expect(tripped.status).toBe("fail");
    if (tripped.status !== "fail") return;
    expect(tripped.kind).toBe("circuit_breaker");
    expect(tripped.details).toMatchObject({
      tripped: true,
      failureCount: threshold,
      threshold,
    });
  });

  it("verifies graph workflow event ordering on the wire matches the publisher contract through its boundary", () => {
    const wire = captureWire();

    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-04-28T00:00:00.000Z",
    });

    const previousExecution = makeExecutionWithStatus("running");
    const nextExecution: GraphWorkflowExecution = {
      ...previousExecution,
      status: "halted",
      activeContextIds: ["context-plan"],
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
      contextStates: {
        ...previousExecution.contextStates,
        "context-plan": {
          ...previousExecution.contextStates["context-plan"]!,
          status: "halted",
          consecutiveFailureCount: 3,
          consecutiveCandidateMismatchCount: 0,
          iterationCount: 1,
        },
      },
      taskStates: {
        ...previousExecution.taskStates,
        "task-plan-1": {
          ...previousExecution.taskStates["task-plan-1"]!,
          status: "failed",
          failureMessage: "validation failed",
        },
      },
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Plan doc",
          readWhen: "Before resuming",
          kind: "shared",
          createdAt: "2026-04-28T00:00:00.000Z",
          updatedAt: "2026-04-28T00:00:00.000Z",
          lastUpdatedByConversationId: "conv-1",
        },
      ],
    };

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/acme",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });
    publisher.deliver(delivery);

    const types = wire.mock.calls.map(
      (c) => (c[0] as GraphWorkflowSSEEvent).type,
    );
    expect(types).toEqual([
      "graph-workflow-status",
      "graph-workflow-context-status",
      "graph-workflow-task-status",
      "graph-workflow-circuit-breaker",
      "graph-workflow-shared-documents-updated",
      "graph-workflow-boundary",
    ]);
  });

  describe("graph implementer + validator route through the conversation entrypoint (Task 6.2)", () => {
    it("validator-runner builds task_run requests through deps.executeWorkflowTaskRun", async () => {
      const { createValidatorRunner, buildValidatorOutputSchema } =
        await import("@/lib/workflow-graph/validator-runner");
      const fixtures = await import("@/lib/workflow-graph/test-fixtures");

      const executeWorkflowTaskRunSpy = vi.fn().mockResolvedValue({
        kind: "text",
        text: JSON.stringify({
          summary: "All good",
          issues: [],
          advisories: [],
        }),
        usage: {
          costUsd: null,
          durationMs: null,
          contextTokens: null,
          contextWindowMax: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
        },
        backendRef: null,
      });

      const runner = createValidatorRunner({
        resolveWorktreePath: async () => workingDir,
        resolveTimeoutMs: async () => 60_000,
        executeWorkflowTaskRun: executeWorkflowTaskRunSpy,
        getProjectDisplayName: () => "test-project",
      });

      const definition = fixtures.createResolvedWorkflowDefinition({
        executionContexts: fixtures
          .createResolvedWorkflowDefinition()
          .executionContexts.map((ctx) =>
            ctx.id === "context-plan"
              ? {
                  ...ctx,
                  acceptanceCriteria: "Reviewed",
                  contextValidator: {
                    enabled: true,
                    assignments: [
                      {
                        id: "general",
                        profile: { tier: "builtin", id: "general-reviewer" },
                        profileSnapshot: makeProfileSnapshot(),
                        strategy: "conversation",
                        authority: "blocking",
                        agent: {
                          backend: "claude",
                          modelSelection: {
                            modelId: "sonnet",
                            parameters: { effort: "medium" },
                          },
                        },
                        continuity: { enabled: true },
                      },
                    ],
                  },
                }
              : ctx,
          ),
      });
      const execution = fixtures.createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        workingDefinition: definition,
      });
      const contextDef = execution.workingDefinition.executionContexts.find(
        (c) => c.id === "context-plan",
      )!;

      await runner.runContextValidator({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        context: contextDef,
        validator: contextDef.contextValidator.assignments[0]!,
      });

      expect(executeWorkflowTaskRunSpy).toHaveBeenCalledTimes(1);
      const [input] = executeWorkflowTaskRunSpy.mock.calls[0]!;
      expect(input).toMatchObject({
        kind: "task_run",
        outputFormat: {
          type: "json_schema",
          schema: buildValidatorOutputSchema({
            authority: contextDef.contextValidator.assignments[0]!.authority,
            taskIds: ["task-plan-1"],
            criterionIds: ["ac-1"],
            issueCriterionCitation: "required",
          }),
        },
      });
    });
  });
});
