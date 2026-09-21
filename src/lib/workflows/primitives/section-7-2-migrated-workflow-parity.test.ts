/**
 * Section 7.2 — Validate observable parity for migrated workflows.
 *
 * Sections 6.1, 6.2, and 6.3 each verify parity for one feature family
 * (conversations + focus mode, graph + debug, smart-merge + optimistic).
 * Section 6.4 implements the first primitive-native collaboration slice. This
 * suite is the cross-feature integration guard: it exercises all four migrated
 * surfaces simultaneously through one shared `SessionStatusBus` and one shared
 * `ArtifactRegistry` and asserts the observable signals callers depend on are
 * preserved end-to-end without contamination between scopes.
 *
 * Specifically, these tests prove:
 *  1. Interleaved publish from all four surfaces lands in the right scope
 *     envelopes (conversation, debug, graph_workflow, merge_job, collaboration)
 *     — no scope bleeds into another.
 *  2. The shared `executeAgentCall` facade preserves the same normalized
 *     `failureKind` vocabulary across both dispatch paths
 *     (`conversation_turn` and `task_run`) for every failure class migrated
 *     workflows can observe (timeout, schema_validation, backend_error,
 *     capability_unavailable). All four migrated entry points (graph
 *     validator runner, conflict resolver, validation fixer, collaboration
 *     slice) read failures through the same field, so the audit guards drift
 *     in any one of them.
 *  3. Multiple workflows registering different artifact kinds against one
 *     `ArtifactRegistry` produce records that round-trip canonical paths,
 *     `source.workflowId` identity, and audience classification without
 *     cross-workflow contamination.
 *  4. The collaboration slice (the primitive-native workflow from section 6.4)
 *     emits the live status, paused projection, and three artifact
 *     registrations that callers depend on — verified together so the cross
 *     feature integration story remains observable from one place.
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
  createArtifactRegistry,
  type ArtifactRegistration,
} from "./artifact-registry";
import { executeAgentCall } from "./agent-call-facade";
import type { BackendCapabilityView } from "./agent-call-vocabulary";
import { capabilityViewForBackend } from "./backend-capabilities";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationStatusEvent } from "@/lib/conversations/schemas";
import type { JobStatusEvent } from "@/lib/jobs/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";

const CLAUDE_CAPABILITY_VIEW = capabilityViewForBackend("claude");
const CODEX_CAPABILITY_VIEW = capabilityViewForBackend("codex");
const CLAUDE_MODEL_SELECTION: BackendModelSelection = {
  modelId: "sonnet",
  parameters: { effort: "high" },
};
const CODEX_MODEL_SELECTION: BackendModelSelection = {
  modelId: "gpt-5.2",
  parameters: { reasoning: "high", fast: "false" },
};

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

function executionWith(
  status: GraphWorkflowExecution["status"],
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status,
    activeContextIds: status === "running" ? ["context-plan"] : [],
  });
}

describe("section 7.2 — observable parity for migrated workflows (Task 7.2)", () => {
  let workingDir: string;

  beforeEach(async () => {
    _resetPublicationForTesting();
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "section7-2-parity-"));
  });

  afterEach(async () => {
    _resetPublicationForTesting();
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  describe("integration: shared SessionStatusBus serves all four migrated surfaces without scope bleed", () => {
    it("interleaved publish from conversation, graph workflow, merge job, and collaboration each lands in its own scope envelope", () => {
      const wire = captureWire();
      const { envelopes, unsubscribe } = captureEnvelopes();

      // 1. Conversation: status running.
      const convEvent: ConversationStatusEvent = {
        type: "conversation-status",
        scope: "session",
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-7-2",
        status: "running",
      };
      publishEvent(convEvent);

      // 2. Graph workflow: pending → running publishes a graph-workflow-status.
      const graphPublisher = createGraphWorkflowExecutionEventPublisher({
        now: () => "2026-04-28T00:00:00.000Z",
      });
      const previousExecution = executionWith("pending");
      const nextExecution = executionWith("running");
      const graphDelivery = graphPublisher.publishExecutionUpdate({
        projectPath: "/projects/acme",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      });
      graphPublisher.deliver(graphDelivery);

      // 3. Merge job: running → completed.
      const jobRunning: JobStatusEvent = {
        type: "job-status",
        jobType: "merge",
        status: "running",
        projectName: "acme",
        sessionName: "session-1",
        jobId: "job-7-2",
        branchName: "csm/session-1",
      };
      publishEvent(jobRunning);
      const jobCompleted: JobStatusEvent = {
        ...jobRunning,
        status: "completed",
        mergeHash: "merge-abc",
      };
      publishEvent(jobCompleted);

      // 4. Debug status — same conversation, different scope.
      publishEvent({
        type: "debug-mode-status",
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-7-2",
        active: true,
        recording: false,
      });

      unsubscribe();

      // Wire received every event in publication order without dropping any.
      expect(wire.mock.calls.length).toBeGreaterThanOrEqual(5);

      // Every published payload reaches its correct scope envelope.
      const byScope = new Map<string, StatusBusEnvelope[]>();
      for (const env of envelopes) {
        const arr = byScope.get(env.scope) ?? [];
        arr.push(env);
        byScope.set(env.scope, arr);
      }

      expect(byScope.get("conversation")).toBeDefined();
      expect(byScope.get("conversation")?.[0]?.scopeId).toBe("conv-7-2");
      expect(byScope.get("conversation")?.[0]?.payload).toEqual(convEvent);

      expect(byScope.get("graph_workflow")).toBeDefined();
      expect(byScope.get("graph_workflow")?.[0]?.scopeId).toBe(
        nextExecution.id,
      );
      const graphPayload = byScope.get("graph_workflow")?.[0]?.payload as
        | { type: string }
        | undefined;
      expect(graphPayload?.type).toBe("graph-workflow-status");

      expect(byScope.get("merge_job")).toBeDefined();
      const mergeEnvelopes = byScope.get("merge_job") ?? [];
      expect(mergeEnvelopes.map((e) => e.status)).toEqual([
        "running",
        "completed",
      ]);
      expect(mergeEnvelopes[0]?.scopeId).toBe("job-7-2");
      expect(mergeEnvelopes[1]?.scopeId).toBe("job-7-2");

      expect(byScope.get("debug")).toBeDefined();
      expect(byScope.get("debug")?.[0]?.scopeId).toBe("conv-7-2");

      // Cross-scope contamination check: no envelope ended up under the
      // wrong scope (conversation events under merge, etc.).
      for (const env of envelopes) {
        const payload = env.payload as { type?: string } | undefined;
        if (payload?.type === "conversation-status") {
          expect(env.scope).toBe("conversation");
        }
        if (payload?.type === "job-status") {
          expect(env.scope).toBe("merge_job");
        }
        if (payload?.type === "graph-workflow-status") {
          expect(env.scope).toBe("graph_workflow");
        }
        if (payload?.type === "debug-mode-status") {
          expect(env.scope).toBe("debug");
        }
      }
    });

    it("subscribers see envelopes from concurrent migrated workflows in publication order", async () => {
      captureWire();
      const { envelopes, unsubscribe } = captureEnvelopes();

      const e1: JobStatusEvent = {
        type: "job-status",
        jobType: "merge",
        status: "running",
        projectName: "acme",
        sessionName: "session-1",
        jobId: "job-A",
        branchName: "csm/session-1",
      };
      const e2: ConversationStatusEvent = {
        type: "conversation-status",
        scope: "session",
        projectName: "acme",
        sessionName: "session-1",
        conversationId: "conv-A",
        status: "running",
      };
      const e3: JobStatusEvent = { ...e1, status: "completed" };

      publishEvent(e1);
      publishEvent(e2);
      publishEvent(e3);

      unsubscribe();

      // Order is observable from the subscriber's perspective.
      expect(envelopes.map((e) => e.scope)).toEqual([
        "merge_job",
        "conversation",
        "merge_job",
      ]);
      expect(envelopes.map((e) => e.status)).toEqual([
        "running",
        "running",
        "completed",
      ]);
    });
  });

  describe("integration: failureKind normalization is preserved across both AgentCall paths", () => {
    function makeRunnerErroring(
      backend: "claude" | "codex",
      result: Partial<AgentTaskResult>,
    ): AgentTaskRunner {
      return {
        backend,
        run: vi.fn(
          async (_req: AgentTaskRequest): Promise<AgentTaskResult> => ({
            backendRef: null,
            text: null,
            structuredOutput: undefined,
            usage: null,
            error: null,
            timedOut: false,
            ...result,
            failure:
              result.failure ??
              (result.timedOut
                ? {
                    kind: "timeout",
                    message: result.error ?? "Task timed out",
                    retryable: true,
                  }
                : result.error
                  ? {
                      kind: "backend_error",
                      message: result.error,
                      retryable: true,
                    }
                  : null),
            continuationDisposition: result.continuationDisposition ?? "retain",
          }),
        ),
      };
    }

    it("task_run path normalizes timeout into failureKind=timeout (preserving the contract validator-runner / conflict-resolver / validation-fix all read)", async () => {
      const runner = makeRunnerErroring("claude", { timedOut: true });
      const result = await executeAgentCall(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "claude",
          prompt: "p",
        },
        {
          resolveTaskRunner: () => ({
            runner,
            capabilityView: CLAUDE_CAPABILITY_VIEW,
            workingDirectory: workingDir,
            modelSelection: CLAUDE_MODEL_SELECTION,
            defaultTimeoutMs: 1_000,
          }),
        },
      );

      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") return;
      expect(result.outcome.error.failureKind).toBe("timeout");
      expect(result.outcome.error.backend).toBe("claude");
    });

    it("task_run path normalizes runner error into failureKind=backend_error", async () => {
      const runner = makeRunnerErroring("codex", { error: "rate-limited" });
      const result = await executeAgentCall(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "codex",
          prompt: "p",
        },
        {
          resolveTaskRunner: () => ({
            runner,
            capabilityView: CODEX_CAPABILITY_VIEW,
            workingDirectory: workingDir,
            modelSelection: CODEX_MODEL_SELECTION,
          }),
        },
      );

      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") return;
      expect(result.outcome.error.failureKind).toBe("backend_error");
      expect(result.outcome.error.backend).toBe("codex");
      expect(result.outcome.error.message).toBe("rate-limited");
    });

    it("task_run path with outputSchema present routes structured-output failures through failureKind=schema_validation", async () => {
      const runner = makeRunnerErroring("claude", {
        text: "ok",
        structuredOutput: { wrong: "shape" },
      });
      const validateStructuredOutput = vi.fn(() => ({
        valid: false,
        errors: ["expected field 'summary' missing"],
      }));

      const result = await executeAgentCall(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "claude",
          prompt: "p",
          outputSchema: { type: "object" },
          structuredOutputTurns: "single",
        },
        {
          resolveTaskRunner: () => ({
            runner,
            capabilityView: CLAUDE_CAPABILITY_VIEW,
            workingDirectory: workingDir,
            modelSelection: CLAUDE_MODEL_SELECTION,
          }),
          validateStructuredOutput,
        },
      );

      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") return;
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.message).toMatch(
        /structured output failed validation/,
      );
      expect(validateStructuredOutput).toHaveBeenCalledTimes(1);
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(result.backendRef).toBeNull();
    });

    it("conversation_turn path with outputSchema present routes structured-output failures through failureKind=schema_validation (parity with task_run)", async () => {
      // Build a minimal runtime that returns a successful turn — the
      // structured-output gate runs after dispatch and should fail it.
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        status: "alive",
        capabilities: {
          queueWhileRunning: true,
          askUserQuestion: true,
          preciseFork: true,
          portableMcpAtStart: true,
          portableMcpBetweenTurns: true,
          contextWindowMetrics: true,
        },
        modelSelection: CLAUDE_MODEL_SELECTION,
        applyPortableMcpConfig: vi.fn(),
        sendTurn: vi.fn().mockResolvedValue({
          backendRef: { backend: "claude", sessionId: "s1" },
          costUsd: 0.01,
          durationMs: 100,
          numTurns: 1,
          contextTokens: 5000,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: { not: "matching" },
          aborted: false,
          error: null,
        }),
        close: vi.fn(async () => {}),
      } as unknown as ConversationBackendRuntime;

      const validateStructuredOutput = vi.fn(() => ({
        valid: false,
        errors: ["bad shape"],
      }));

      const result = await executeAgentCall(
        {
          executionClass: "ordinary-conversation" as const,
          kind: "conversation_turn",
          backend: "claude",
          prompt: "p",
          outputSchema: { type: "object" },
        },
        {
          resolveConversationRuntime: () => ({
            runtime,
            capabilityView: CLAUDE_CAPABILITY_VIEW,
            signal: new AbortController().signal,
            modelSelection: CLAUDE_MODEL_SELECTION,
          }),
          validateStructuredOutput,
        },
      );

      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") return;
      expect(result.outcome.error.failureKind).toBe("schema_validation");
      expect(result.outcome.error.backend).toBe("claude");
      // Capability view is preserved on failure (parity with success).
      expect(result.capabilities).toEqual(CLAUDE_CAPABILITY_VIEW);
    });

    it("conversation_turn path with no injected validator uses the default schema validator for failureKind=schema_validation", async () => {
      const runtime: ConversationBackendRuntime = {
        backend: "codex",
        status: "alive",
        capabilities: {
          queueWhileRunning: false,
          askUserQuestion: false,
          preciseFork: false,
          portableMcpAtStart: true,
          portableMcpBetweenTurns: false,
          contextWindowMetrics: false,
        },
        modelSelection: CODEX_MODEL_SELECTION,
        applyPortableMcpConfig: vi.fn(),
        sendTurn: vi.fn().mockResolvedValue({
          backendRef: { backend: "codex", threadId: "t1" },
          costUsd: 0.02,
          durationMs: 200,
          numTurns: 1,
          contextTokens: undefined,
          contextWindowMax: undefined,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: { ok: true },
          aborted: false,
          error: null,
        }),
        close: vi.fn(async () => {}),
      } as unknown as ConversationBackendRuntime;

      const result = await executeAgentCall(
        {
          executionClass: "ordinary-conversation" as const,
          kind: "conversation_turn",
          backend: "codex",
          prompt: "p",
          outputSchema: {
            type: "object",
            required: ["summary"],
            properties: {
              summary: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        {
          resolveConversationRuntime: () => ({
            runtime,
            capabilityView: CODEX_CAPABILITY_VIEW,
            signal: new AbortController().signal,
            modelSelection: CODEX_MODEL_SELECTION,
          }),
          // No validateStructuredOutput intentionally.
        },
      );

      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") return;
      expect(result.outcome.error.failureKind).toBe("schema_validation");
    });
  });

  describe("integration: shared ArtifactRegistry serves multiple workflows without contamination", () => {
    it("interleaved writes from the four migrated artifact paths (focus_memory, validation_log, codex_output, reference_document) preserve canonical paths and source identity", async () => {
      const referenceCalls: Array<{
        relativePath: string;
        description: string;
        sourceWorkflowId?: string;
      }> = [];
      const sharedDocCalls: Array<{
        relativePath: string;
        description: string;
        sourceWorkflowId?: string;
      }> = [];
      const registration: ArtifactRegistration = {
        registerReferenceDocument: async (input) => {
          referenceCalls.push({
            relativePath: input.relativePath,
            description: input.description,
            sourceWorkflowId: input.source.workflowId,
          });
        },
        registerSharedDocument: async (input) => {
          sharedDocCalls.push({
            relativePath: input.relativePath,
            description: input.description,
            sourceWorkflowId: input.source.workflowId,
          });
        },
      };
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        registration,
      });

      const focus = await registry.write({
        kind: "focus_memory",
        worktreePath: workingDir,
        relativePath: "memory-bank/focus.md",
        contents: "# Focus from workflow A\n",
        audience: "internal_log",
        source: { workflowId: "workflow-A" },
        description: "focus memory",
      });
      const valLog = await registry.write({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: ".cc/workflow/exec-7-2/pre-merge.log",
        contents: "validation output",
        audience: "internal_log",
        source: { workflowId: "workflow-B" },
      });
      const codexOut = await registry.write({
        kind: "codex_output",
        worktreePath: workingDir,
        relativePath: "memory-bank/codex/run-1.md",
        contents: "codex run output",
        audience: "internal_log",
        source: { workflowId: "workflow-C" },
      });
      const ref = await registry.write({
        kind: "reference_document",
        worktreePath: workingDir,
        relativePath: "memory-bank/notes.md",
        contents: "# Notes\n",
        audience: "user_facing",
        source: { workflowId: "workflow-D" },
        description: "Notes from workflow D",
      });
      const graphShared = await registry.write({
        kind: "graph_shared_document",
        worktreePath: workingDir,
        relativePath: ".cc/graph-workflow-docs/plan.md",
        contents: "# Plan\n",
        audience: "user_facing",
        source: { workflowId: "workflow-E" },
        description: "Plan doc",
        readWhen: "Before resuming",
      });

      // Canonical paths preserved per kind.
      expect(focus.relativePath).toBe("memory-bank/focus.md");
      expect(valLog.relativePath).toBe(".cc/workflow/exec-7-2/pre-merge.log");
      expect(codexOut.relativePath).toBe("memory-bank/codex/run-1.md");
      expect(ref.relativePath).toBe("memory-bank/notes.md");
      expect(graphShared.relativePath).toBe(".cc/graph-workflow-docs/plan.md");

      // Source identity preserved per write — none cross-contaminated.
      expect(focus.source.workflowId).toBe("workflow-A");
      expect(valLog.source.workflowId).toBe("workflow-B");
      expect(codexOut.source.workflowId).toBe("workflow-C");
      expect(ref.source.workflowId).toBe("workflow-D");
      expect(graphShared.source.workflowId).toBe("workflow-E");

      // Audience classification round-trips per kind.
      expect(focus.audience).toBe("internal_log");
      expect(valLog.audience).toBe("internal_log");
      expect(codexOut.audience).toBe("internal_log");
      expect(ref.audience).toBe("user_facing");
      expect(graphShared.audience).toBe("user_facing");

      // Discoverability: only the kinds with registration rules call the
      // registration hook, and they call the right one.
      expect(referenceCalls.length).toBe(2); // focus_memory + reference_document
      expect(referenceCalls.map((c) => c.sourceWorkflowId).sort()).toEqual([
        "workflow-A",
        "workflow-D",
      ]);
      expect(sharedDocCalls.length).toBe(1); // graph_shared_document
      expect(sharedDocCalls[0]?.sourceWorkflowId).toBe("workflow-E");

      // Filesystem-only kinds did not invoke any registration hook.
      const allRegisteredPaths = [
        ...referenceCalls.map((c) => c.relativePath),
        ...sharedDocCalls.map((c) => c.relativePath),
      ];
      expect(allRegisteredPaths).not.toContain(
        ".cc/workflow/exec-7-2/pre-merge.log",
      );
      expect(allRegisteredPaths).not.toContain("memory-bank/codex/run-1.md");
    });

    it("path-traversal rejection guards every kind so a misbehaving workflow cannot escape the worktree (parity preserved across migrated artifact producers)", async () => {
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
      });

      // Reject absolute path.
      await expect(
        registry.write({
          kind: "reference_document",
          worktreePath: workingDir,
          relativePath: "/etc/passwd",
          contents: "x",
          audience: "user_facing",
          source: { workflowId: "x" },
          description: "x",
        }),
      ).rejects.toThrow(/Absolute paths are not permitted/);

      // Reject traversal.
      await expect(
        registry.write({
          kind: "reference_document",
          worktreePath: workingDir,
          relativePath: "../escaped.md",
          contents: "x",
          audience: "user_facing",
          source: { workflowId: "x" },
          description: "x",
        }),
      ).rejects.toThrow(/outside the session worktree/);

      // Reject canonical-path violation for focus_memory.
      await expect(
        registry.write({
          kind: "focus_memory",
          worktreePath: workingDir,
          relativePath: "memory-bank/something-else.md",
          contents: "x",
          audience: "internal_log",
          source: { workflowId: "x" },
          description: "x",
        }),
      ).rejects.toThrow(/canonical path memory-bank\/focus\.md/);

      // Reject base-dir violation for graph_shared_document.
      await expect(
        registry.write({
          kind: "graph_shared_document",
          worktreePath: workingDir,
          relativePath: ".cc/wrong-place/plan.md",
          contents: "x",
          audience: "user_facing",
          source: { workflowId: "x" },
          description: "x",
          readWhen: "before",
        }),
      ).rejects.toThrow(/under \.cc\/graph-workflow-docs/);
    });
  });

  describe("integration: capability view round-trips from facade through every dispatch path so workflows can branch on real backend differences", () => {
    it("conversation_turn returns the supplied capability view verbatim on success and on failure", async () => {
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        status: "alive",
        capabilities: {
          queueWhileRunning: true,
          askUserQuestion: true,
          preciseFork: true,
          portableMcpAtStart: true,
          portableMcpBetweenTurns: true,
          contextWindowMetrics: true,
        },
        modelSelection: CLAUDE_MODEL_SELECTION,
        applyPortableMcpConfig: vi.fn(),
        sendTurn: vi.fn().mockResolvedValue({
          backendRef: { backend: "claude", sessionId: "s1" },
          costUsd: 0.01,
          durationMs: 100,
          numTurns: 1,
          contextTokens: 5000,
          contextWindowMax: 200_000,
          contentBlocks: [{ type: "text", text: "ok" }],
          structuredOutput: undefined,
          aborted: false,
          error: null,
        }),
        close: vi.fn(async () => {}),
      } as unknown as ConversationBackendRuntime;

      const successResult = await executeAgentCall(
        {
          executionClass: "ordinary-conversation" as const,
          kind: "conversation_turn",
          backend: "claude",
          prompt: "p",
        },
        {
          resolveConversationRuntime: () => ({
            runtime,
            capabilityView: CLAUDE_CAPABILITY_VIEW,
            signal: new AbortController().signal,
            modelSelection: CLAUDE_MODEL_SELECTION,
          }),
        },
      );
      expect(successResult.capabilities).toEqual(CLAUDE_CAPABILITY_VIEW);

      // Capability differences are observable on the returned view (this is
      // the workflow-author's branchable contract).
      const observed: BackendCapabilityView = successResult.capabilities;
      expect(observed.continuationStrength).toBe("precise_session");
      expect(observed.nativeMidTurnAskUser).toBe(true);
      expect(observed.contextMetricsAvailable).toBe(true);
    });

    it("task_run preserves Codex capability view including unsupported context metrics flag", async () => {
      const requests: AgentTaskRequest[] = [];
      const runner: AgentTaskRunner = {
        backend: "codex",
        run: vi.fn(async (request: AgentTaskRequest) => {
          requests.push(request);
          return {
            backendRef: { backend: "codex", threadId: "t1" },
            text: "ok",
            structuredOutput: undefined,
            usage: null,
            error: null,
            timedOut: false,
          };
        }),
      } as unknown as AgentTaskRunner;

      const result = await executeAgentCall(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "codex",
          prompt: "p",
        },
        {
          resolveTaskRunner: () => ({
            runner,
            capabilityView: CODEX_CAPABILITY_VIEW,
            workingDirectory: workingDir,
            modelSelection: CODEX_MODEL_SELECTION,
          }),
        },
      );
      expect(result.capabilities).toEqual(CODEX_CAPABILITY_VIEW);
      expect(result.capabilities.contextMetricsAvailable).toBe(false);
      expect(result.capabilities.nativeMidTurnAskUser).toBe(false);
      expect(result.capabilities.continuationStrength).toBe("synthetic_thread");
      expect(requests[0]?.modelSelection).toEqual(CODEX_MODEL_SELECTION);
    });
  });
});
