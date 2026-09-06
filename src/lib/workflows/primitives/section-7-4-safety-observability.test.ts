/**
 * Section 7.4 — Verify primitive safety and observability behavior.
 *
 * Sections 7.1, 7.2, and 7.3 verify capability preservation, cross-feature
 * parity, and concurrency/recovery. This suite is the safety/observability
 * guard. It pins down two contracts callers depend on:
 *
 *  1. **Structured logs include relevant identifiers without leaking
 *     payload bodies.** Stateful primitive operations (AgentCall dispatch,
 *     lane scheduling, artifact writes, status delivery) log session,
 *     workflow, lane, artifact, and outcome identifiers — but never the full
 *     prompt text, full artifact contents, or full status payload by
 *     default. This protects logs from prompt injection echo and from
 *     bloating the log volume with payload bodies.
 *
 *  2. **Primitive failure modes degrade observably.** Status delivery
 *     failures are isolated (a wire throw does not corrupt subscribers; a
 *     subscriber throw does not block the wire), required artifact writes
 *     fail with a typed `ArtifactRequiredFailure` while logs preserve
 *     identity but not contents, optional artifacts degrade to
 *     `skipped_warning`, and large workflow lifecycle content can be
 *     persisted as an artifact reference instead of inlined in the
 *     envelope.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import type { Logger } from "@/lib/logging";
import { createLaneScheduler } from "./lane-scheduler";
import {
  ArtifactRequiredFailure,
  createArtifactRegistry,
} from "./artifact-registry";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/events/status-bus";
import { dispatchTaskRun } from "./agent-call-task";
import { dispatchConversationTurn } from "./agent-call-conversation";
import { capabilityViewForBackend } from "./backend-capabilities";
import {
  createInMemoryWorkflowEnvelopeStore,
  writeFeatureSnapshotAsArtifact,
} from "./workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "./workflow-envelope-repository";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type {
  AgentTaskRequest,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

const CLAUDE_CAPABILITY_VIEW = capabilityViewForBackend("claude");
const CLAUDE_MODEL_SELECTION: BackendModelSelection = {
  modelId: "sonnet",
  parameters: { effort: "high" },
};
const CODEX_MODEL_SELECTION: BackendModelSelection = {
  modelId: "gpt-5.2",
  parameters: { reasoning: "high", fast: "false" },
};

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const make =
    (level: CapturedLog["level"]) =>
    (event: string, fields?: Record<string, unknown>) => {
      logs.push({ level, event, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
  return { logger, logs };
}

function flattenForPayloadInspection(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "function") return "[function]";
    if (typeof v === "bigint") return v.toString();
    return v;
  });
}

describe("section 7.4 — primitive safety and observability (Task 7.4)", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "section7-4-safety-"));
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------
  // 1. Structured logs include identity, not payload bodies
  // -----------------------------------------------------------------
  describe("structured logs include identity fields without leaking prompt or payload bodies", () => {
    it("AgentCall task_run failure log includes requestKind, backend, workflowId, laneId, and outcome — but not the prompt text", async () => {
      const { logger, logs } = captureLogger();
      const SECRET_PROMPT = "SECRET_PROMPT_BODY_DO_NOT_LOG_ME";
      const requests: AgentTaskRequest[] = [];

      const runner: AgentTaskRunner = {
        backend: "codex",
        run: vi.fn(async (request: AgentTaskRequest) => {
          requests.push(request);
          return {
            backendRef: { backend: "codex", threadId: "t1" },
            structuredOutput: undefined,
            usage: null,
            error: "synthetic runner error",
            timedOut: false,
            aborted: false,
          };
        }),
      } as unknown as AgentTaskRunner;

      await dispatchTaskRun(
        {
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          backend: "codex",
          prompt: SECRET_PROMPT,
          laneRef: { workflowId: "wf-7-4-A", laneId: "lane-codex" },
        },
        {
          runner,
          capabilityView: { ...CLAUDE_CAPABILITY_VIEW, backend: "codex" },
          workingDirectory: workingDir,
          modelSelection: CODEX_MODEL_SELECTION,
          logger,
        },
      );

      const failureLog = logs.find(
        (l) => l.event === "agent_call.task.runner_error",
      );
      expect(failureLog).toBeDefined();
      // Identity fields present.
      expect(failureLog?.fields.workflowId).toBe("wf-7-4-A");
      expect(failureLog?.fields.laneId).toBe("lane-codex");
      expect(failureLog?.fields.requestKind).toBe("task_run");
      expect(failureLog?.fields.backend).toBe("codex");
      expect(failureLog?.fields.outcome).toBe("failed");
      expect(requests[0]?.modelSelection).toEqual(CODEX_MODEL_SELECTION);
      // The prompt body must not appear in any field of any log.
      for (const entry of logs) {
        expect(flattenForPayloadInspection(entry.fields)).not.toContain(
          SECRET_PROMPT,
        );
      }
    });

    it("AgentCall conversation_turn dispatch logs include identity but never include the prompt text in any field", async () => {
      const { logger, logs } = captureLogger();
      const SECRET_PROMPT = "VERY_SECRET_CONVERSATION_PROMPT_BODY";

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
        outputFormat: undefined,
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

      await dispatchConversationTurn(
        {
          executionClass: "ordinary-conversation" as const,
          kind: "conversation_turn",
          backend: "claude",
          prompt: SECRET_PROMPT,
          laneRef: { workflowId: "wf-conv-1", laneId: "lane-claude" },
        },
        {
          runtime,
          capabilityView: CLAUDE_CAPABILITY_VIEW,
          signal: new AbortController().signal,
          modelSelection: CLAUDE_MODEL_SELECTION,
          logger,
        },
      );

      // Across every log line emitted by the conversation path, no field
      // should contain the prompt body.
      for (const entry of logs) {
        expect(flattenForPayloadInspection(entry.fields)).not.toContain(
          SECRET_PROMPT,
        );
      }

      // The dispatch_start log should include workflow/lane identity.
      const startLog = logs.find(
        (l) => l.event === "agent_call.conversation.dispatch_start",
      );
      expect(startLog?.fields.workflowId).toBe("wf-conv-1");
      expect(startLog?.fields.laneId).toBe("lane-claude");
      expect(startLog?.fields.backend).toBe("claude");
      expect(startLog?.fields.requestKind).toBe("conversation_turn");
    });

    it("ArtifactRegistry write log includes kind/relativePath/workflowId/laneId/audience but not the artifact contents", async () => {
      const { logger, logs } = captureLogger();
      const SECRET_CONTENTS =
        "SECRET_ARTIFACT_BODY_THAT_MUST_NOT_APPEAR_IN_LOGS";

      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        logger: {
          info: (event, fields) => logger.info(event, fields),
          warn: (event, fields) => logger.warn(event, fields),
          error: (event, fields) => logger.error(event, fields),
        },
      });

      const record = await registry.write({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: ".cc/workflow/wf-X/log.txt",
        contents: SECRET_CONTENTS,
        audience: "internal_log",
        source: { workflowId: "wf-X", laneId: "lane-validator" },
      });

      const registered = logs.find(
        (l) => l.event === "artifact-registry.registered",
      );
      expect(registered).toBeDefined();
      expect(registered?.fields.kind).toBe("validation_log");
      expect(registered?.fields.relativePath).toBe(record.relativePath);
      expect(registered?.fields.workflowId).toBe("wf-X");
      expect(registered?.fields.laneId).toBe("lane-validator");
      expect(registered?.fields.audience).toBe("internal_log");
      // Body never enters log fields.
      for (const entry of logs) {
        expect(flattenForPayloadInspection(entry.fields)).not.toContain(
          SECRET_CONTENTS,
        );
      }
    });

    it("ArtifactRegistry write_failed log captures kind/relativePath/workflowId/laneId/error but never the contents body", async () => {
      const { logger, logs } = captureLogger();
      const SECRET_CONTENTS = "SECRET_BLOB_DURING_FAILED_WRITE";

      const registry = createArtifactRegistry({
        writeFile: () => {
          throw new Error("disk write boom");
        },
        ensureDir: () => Promise.resolve(),
        logger: {
          info: (event, fields) => logger.info(event, fields),
          warn: (event, fields) => logger.warn(event, fields),
          error: (event, fields) => logger.error(event, fields),
        },
      });

      await expect(
        registry.write({
          kind: "validation_log",
          worktreePath: workingDir,
          relativePath: ".cc/workflow/wf-fail/log.txt",
          contents: SECRET_CONTENTS,
          audience: "internal_log",
          source: { workflowId: "wf-fail", laneId: "lane-A" },
        }),
      ).rejects.toBeInstanceOf(ArtifactRequiredFailure);

      const failed = logs.find(
        (l) => l.event === "artifact-registry.write_failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.fields.kind).toBe("validation_log");
      expect(failed?.fields.workflowId).toBe("wf-fail");
      expect(failed?.fields.laneId).toBe("lane-A");
      expect(failed?.fields.error).toMatch(/disk write boom/);
      for (const entry of logs) {
        expect(flattenForPayloadInspection(entry.fields)).not.toContain(
          SECRET_CONTENTS,
        );
      }
    });

    it("StatusBus delivery failures log scope/scopeId/status/payloadShape but not the full payload", async () => {
      const { logger, logs } = captureLogger();
      const SECRET_PAYLOAD_FIELD = "SECRET_INTERNAL_PAYLOAD_VALUE";

      const bus = createStatusBus({
        broadcast: () => {
          throw new Error("wire boom");
        },
        logger: { warn: (event, fields) => logger.warn(event, fields) },
      });

      const outcome = bus.publish({
        scope: "conversation",
        scopeId: "conv-7-4",
        status: "running",
        payload: {
          type: "conversation-status",
          internalSecret: SECRET_PAYLOAD_FIELD,
          longField: "x".repeat(10_000),
        },
      });
      expect(outcome.delivered).toBe(false);

      const failed = logs.find((l) => l.event === "status-bus.delivery_failed");
      expect(failed).toBeDefined();
      expect(failed?.fields.scope).toBe("conversation");
      expect(failed?.fields.scopeId).toBe("conv-7-4");
      expect(failed?.fields.status).toBe("running");
      expect(failed?.fields.payloadShape).toBe("object:conversation-status");
      // Full payload body must not appear in log fields.
      for (const entry of logs) {
        expect(flattenForPayloadInspection(entry.fields)).not.toContain(
          SECRET_PAYLOAD_FIELD,
        );
      }
    });

    it("StatusBus subscriber failures log identity + payloadShape but never the payload body", async () => {
      const { logger, logs } = captureLogger();
      const SECRET_BODY = "SUBSCRIBER_FAILURE_PAYLOAD_BODY_LEAK";

      const bus = createStatusBus({
        broadcast: () => undefined,
        logger: { warn: (event, fields) => logger.warn(event, fields) },
      });

      bus.subscribe(() => {
        throw new Error("subscriber blew up");
      });

      bus.publish({
        scope: "graph_workflow",
        scopeId: "exec-1",
        status: "running",
        payload: {
          type: "graph-workflow-status",
          internalNote: SECRET_BODY,
        },
      });

      const failed = logs.find(
        (l) => l.event === "status-bus.subscriber_failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.fields.scope).toBe("graph_workflow");
      expect(failed?.fields.scopeId).toBe("exec-1");
      expect(failed?.fields.status).toBe("running");
      expect(failed?.fields.payloadShape).toBe("object:graph-workflow-status");
      for (const entry of logs) {
        expect(flattenForPayloadInspection(entry.fields)).not.toContain(
          SECRET_BODY,
        );
      }
    });

    it("LaneScheduler logs include sessionKey/workflowId/laneId for both read-only and write-capable executions", async () => {
      const { logger, logs } = captureLogger();
      const scheduler = createLaneScheduler({ logger });

      await scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-read",
          laneId: "lane-read",
          writeCapability: "read_only",
        },
        async () => "read-ok",
      );

      await scheduler.schedule(
        {
          sessionKey: "acme/session-1",
          workflowId: "wf-write",
          laneId: "lane-write",
          writeCapability: "write_capable",
        },
        async () => "write-ok",
      );

      const readEntry = logs.find(
        (l) => l.event === "lane.scheduler.read_only",
      );
      expect(readEntry?.fields.sessionKey).toBe("acme/session-1");
      expect(readEntry?.fields.workflowId).toBe("wf-read");
      expect(readEntry?.fields.laneId).toBe("lane-read");

      const writeEntry = logs.find(
        (l) => l.event === "lane.scheduler.write_capable_enqueued",
      );
      expect(writeEntry?.fields.sessionKey).toBe("acme/session-1");
      expect(writeEntry?.fields.workflowId).toBe("wf-write");
      expect(writeEntry?.fields.laneId).toBe("lane-write");
    });
  });

  // -----------------------------------------------------------------
  // 2. Status delivery degradation
  // -----------------------------------------------------------------
  describe("status delivery degradation isolates wire and subscriber failures from owning workflow state", () => {
    it("when the wire broadcast throws, subscribers still receive the envelope and publish() returns delivered=false rather than throwing", async () => {
      const subscriberCalls: StatusBusEnvelope[] = [];
      const bus = createStatusBus({
        broadcast: () => {
          throw new Error("wire transport down");
        },
      });
      bus.subscribe((env) => subscriberCalls.push(env));

      const outcome = bus.publish({
        scope: "conversation",
        scopeId: "conv-1",
        status: "running",
        payload: { type: "conversation-status" },
      });

      // publish() did not throw; it reported the wire failure.
      expect(outcome.delivered).toBe(false);
      expect(outcome.error?.message).toMatch(/wire transport down/);
      // The subscriber received the envelope despite the wire failure.
      expect(subscriberCalls).toHaveLength(1);
      expect(subscriberCalls[0]?.scope).toBe("conversation");
      expect(subscriberCalls[0]?.scopeId).toBe("conv-1");
    });

    it("when one subscriber throws, the wire still receives the envelope and other subscribers continue to receive subsequent envelopes", async () => {
      const wireCalls: StatusBusEnvelope[] = [];
      const goodSubscriberCalls: StatusBusEnvelope[] = [];
      const bus = createStatusBus({
        broadcast: (env) => wireCalls.push(env),
      });
      bus.subscribe(() => {
        throw new Error("flaky subscriber");
      });
      bus.subscribe((env) => goodSubscriberCalls.push(env));

      const outcome = bus.publish({
        scope: "merge_job",
        scopeId: "job-1",
        status: "running",
        payload: { type: "job-status" },
      });

      // Wire delivery still succeeded.
      expect(outcome.delivered).toBe(true);
      expect(wireCalls).toHaveLength(1);
      // Healthy subscriber still received the envelope.
      expect(goodSubscriberCalls).toHaveLength(1);

      // A second publish still fans out cleanly.
      bus.publish({
        scope: "merge_job",
        scopeId: "job-1",
        status: "completed",
        payload: { type: "job-status", status: "completed" },
      });
      expect(wireCalls).toHaveLength(2);
      expect(goodSubscriberCalls).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------
  // 3. Required vs optional artifact failure observability
  // -----------------------------------------------------------------
  describe("artifact failure modes degrade observably", () => {
    it("required artifact write throws ArtifactRequiredFailure carrying kind/relativePath/stage so callers can route the failure", async () => {
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
      });

      let captured: ArtifactRequiredFailure | undefined;
      try {
        await registry.write({
          kind: "focus_memory",
          worktreePath: workingDir,
          relativePath: "memory-bank/wrong-path.md",
          contents: "x",
          audience: "user_facing",
          source: { workflowId: "wf-fail" },
        });
      } catch (err) {
        if (err instanceof ArtifactRequiredFailure) {
          captured = err;
        }
      }
      expect(captured).toBeDefined();
      expect(captured?.kind).toBe("focus_memory");
      expect(captured?.stage).toBe("path_resolution");
      expect(captured?.relativePath).toBe("memory-bank/wrong-path.md");
    });

    it("optional artifact write degrades to skipped_warning with a structured warn log so the workflow continues without halting", async () => {
      const { logger, logs } = captureLogger();
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        logger: {
          info: (event, fields) => logger.info(event, fields),
          warn: (event, fields) => logger.warn(event, fields),
          error: (event, fields) => logger.error(event, fields),
        },
      });

      const outcome = await registry.writeOptional({
        kind: "focus_memory",
        worktreePath: workingDir,
        relativePath: "memory-bank/not-canonical-path.md",
        contents: "x",
        audience: "user_facing",
        source: { workflowId: "wf-optional" },
      });
      expect(outcome.status).toBe("skipped_warning");

      const warnEntry = logs.find(
        (l) => l.event === "artifact-registry.optional_skipped",
      );
      expect(warnEntry).toBeDefined();
      expect(warnEntry?.fields.kind).toBe("focus_memory");
      expect(warnEntry?.fields.workflowId).toBe("wf-optional");
      expect(warnEntry?.fields.stage).toBe("path_resolution");
      expect(typeof warnEntry?.fields.warning).toBe("string");
    });

    it("optional artifact write succeeds normally when the path is valid — degradation only kicks in on actual failure", async () => {
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
      });

      const outcome = await registry.writeOptional({
        kind: "validation_log",
        worktreePath: workingDir,
        relativePath: ".cc/workflow/wf-OK/log.txt",
        contents: "log line",
        audience: "internal_log",
        source: { workflowId: "wf-OK" },
      });
      expect(outcome.status).toBe("registered");
      if (outcome.status === "registered") {
        expect(outcome.record.kind).toBe("validation_log");
        expect(outcome.record.source.workflowId).toBe("wf-OK");
      }
    });
  });

  // -----------------------------------------------------------------
  // 4. Artifact-reference fallback for large workflow lifecycle content
  // -----------------------------------------------------------------
  describe("artifact-reference fallback keeps the durable envelope payload bounded under large workflow lifecycle content", () => {
    function buildEnvelope(
      overrides: Partial<WorkflowEnvelope> = {},
    ): WorkflowEnvelope {
      return {
        workflowId: "wf-bounded",
        workflowType: "collaboration",
        status: "running",
        phase: "round-N",
        createdAt: "2026-04-28T10:00:00.000Z",
        updatedAt: "2026-04-28T10:00:00.000Z",
        featureSnapshot: { round: 0 },
        ...overrides,
      };
    }

    it("a large feature snapshot is offloaded to an artifact and the envelope stores only the reference shape, keeping the durable payload bounded", async () => {
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        now: () => "2026-04-28T10:00:00.000Z",
        newId: () => "art-snap-7-4",
      });

      const repo = createWorkflowEnvelopeRepository({
        store: createInMemoryWorkflowEnvelopeStore(),
      });
      await repo.create(
        buildEnvelope({
          workflowId: "wf-large",
          featureSnapshot: { placeholder: true },
        }),
      );

      const massiveSnapshot = {
        rounds: Array.from({ length: 80 }, (_, i) => ({
          index: i,
          body: "z".repeat(8_000),
        })),
      };

      const reference = await writeFeatureSnapshotAsArtifact({
        registry,
        worktreePath: workingDir,
        workflowId: "wf-large",
        snapshot: massiveSnapshot,
      });

      expect(reference.kind).toBe("artifact_reference");
      expect(reference.artifactId).toBe("art-snap-7-4");
      expect(reference.relativePath).toBe(
        ".cc/workflow/wf-large/snapshot.json",
      );

      const updated = await repo.update("wf-large", {
        featureSnapshot: reference,
      });
      const inlineSize = JSON.stringify(updated).length;
      // Without offloading, this snapshot would push the envelope past 600KB.
      // With the reference, it stays under 1KB.
      expect(inlineSize).toBeLessThan(1_000);

      // The actual snapshot content lives on disk under the canonical path.
      const onDisk = await fs.readFile(
        path.join(workingDir, ".cc/workflow/wf-large/snapshot.json"),
        "utf-8",
      );
      expect(JSON.parse(onDisk)).toEqual(massiveSnapshot);
    });

    it("an artifact-reference snapshot survives a simulated server restart — a fresh repository instance reads the same reference back from the store", async () => {
      const store = createInMemoryWorkflowEnvelopeStore();
      const repoA = createWorkflowEnvelopeRepository({ store });
      const registry = createArtifactRegistry({
        writeFile: (absolutePath, contents) =>
          fs.writeFile(absolutePath, contents),
        ensureDir: (absolutePath) =>
          fs.mkdir(absolutePath, { recursive: true }).then(() => undefined),
        now: () => "2026-04-28T10:00:00.000Z",
        newId: () => "art-snap-restart",
      });

      await repoA.create(
        buildEnvelope({
          workflowId: "wf-restart",
          featureSnapshot: { placeholder: true },
        }),
      );

      const heavySnapshot = {
        round: 7,
        text: "weighty content ".repeat(500),
      };
      const reference = await writeFeatureSnapshotAsArtifact({
        registry,
        worktreePath: workingDir,
        workflowId: "wf-restart",
        snapshot: heavySnapshot,
      });
      await repoA.update("wf-restart", { featureSnapshot: reference });

      // Simulate restart: drop repoA, instantiate a fresh repository over the
      // same store. The reference must round-trip.
      const repoB = createWorkflowEnvelopeRepository({ store });
      const recovered = await repoB.get("wf-restart");
      expect(recovered?.featureSnapshot).toEqual({
        kind: "artifact_reference",
        artifactId: "art-snap-restart",
        relativePath: ".cc/workflow/wf-restart/snapshot.json",
      });

      // The disk-backed snapshot is still readable post-restart.
      const onDisk = await fs.readFile(
        path.join(workingDir, ".cc/workflow/wf-restart/snapshot.json"),
        "utf-8",
      );
      expect(JSON.parse(onDisk)).toEqual(heavySnapshot);
    });

    it("the artifact-reference fallback uses the validation_log canonical base directory so storage is bounded to .cc/workflow/<workflowId>/", async () => {
      const writes: Array<{ absolutePath: string }> = [];
      const registry = createArtifactRegistry({
        writeFile: async (absolutePath) => {
          writes.push({ absolutePath });
        },
        ensureDir: () => Promise.resolve(),
        now: () => "2026-04-28T10:00:00.000Z",
        newId: () => "art-snap-base-dir",
      });

      const reference = await writeFeatureSnapshotAsArtifact({
        registry,
        worktreePath: workingDir,
        workflowId: "wf-base-dir",
        snapshot: { hello: "world" },
        fileName: "iter-0.json",
      });

      expect(reference.relativePath).toBe(
        ".cc/workflow/wf-base-dir/iter-0.json",
      );
      // The actual write happened under the worktree base dir.
      expect(writes[0]?.absolutePath).toBe(
        path.join(workingDir, ".cc/workflow/wf-base-dir/iter-0.json"),
      );
    });
  });
});
