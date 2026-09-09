import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
/**
 * Compaction generation service (docs/design/conversation-compaction/README.md
 * §7.1, §7.2): self-contained background execution — the artifact row is the
 * job record and `context_artifact_status` SSE is the progress channel. No
 * jobs-table involvement.
 *
 * The model call runs on a SYNTHETIC TRANSIENT actor lane (the graph-workflow
 * validator precedent): never the target conversation's real actor, so
 * compaction cannot contend with live turns and always honors the configured
 * compaction backend/model instead of the conversation's own.
 */

import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import {
  compactionExecutionRequirements,
  compactionRepairRequirements,
} from "@/lib/config/task-admission";
import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import {
  groupTranscriptEntries,
  NORMALIZER_VERSION,
} from "@/lib/conversations/transcript-render";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { CompactionConfig } from "@/lib/config/schemas";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import {
  generateCompactionEnvelope,
  isArtifactVersionCurrent,
  lastRenderedSeq,
} from "./envelope-generation";
import { PROMPT_VERSION } from "./generation";
import { redactEnvelopeStrings } from "./redaction";
import type { CompactionRunMode } from "./guards";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type ArtifactKind,
  type CompactionEnvelope,
  type ContextArtifactCreatedBy,
  type ContextArtifactRow,
  type ContextArtifactScope,
  type ContextArtifactStatusEvent,
} from "./schemas";
import type { ContextArtifactsRepo } from "./repo";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("context-artifacts");
const genLogger = createLogger("context-artifacts.generation");
const auditLogger = createLogger("context-artifacts.audit");

export const EMPTY_TRANSCRIPT_COMPACTION_ERROR =
  "transcript is empty; nothing to compact";

export interface CompactionServiceDeps {
  executeTaskRun(input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
  readEntries(transcriptPath: string | null): Promise<TranscriptEntriesResult>;
  repo: ContextArtifactsRepo;
  resolveConfig(projectPath: string): Promise<CompactionConfig>;
  broadcast(event: SSEEvent): void;
  /** ISO-8601 timestamp source. */
  now(): string;
}

export interface TriggerCompactionInput {
  kind: ArtifactKind;
  scope: ContextArtifactScope;
  projectPath: string;
  projectName: string;
  /** null for project-scope conversations. */
  sessionName: string | null;
  conversationId: string;
  transcriptPath: string | null;
  /** Required for `message_compaction`. */
  messageIndex?: number;
  /** Regenerate from scratch even when the artifact is fresh. */
  force?: boolean;
  createdBy: ContextArtifactCreatedBy;
  createdByConversationId?: string | null;
  /** Audit tag naming the trigger surface (e.g. "ui_api", "agent_api"). */
  trigger: string;
}

export type TriggerCompactionResult =
  | {
      outcome: "started";
      artifactId: string;
      timeoutMs: number;
      completion: Promise<ContextArtifactRow>;
    }
  | {
      outcome: "coalesced";
      artifactId: string;
      timeoutMs: number;
      completion: Promise<ContextArtifactRow>;
    }
  | { outcome: "already_fresh"; artifact: ContextArtifactRow }
  | { outcome: "invalid"; error: string };

export interface CompactionService {
  trigger(input: TriggerCompactionInput): Promise<TriggerCompactionResult>;
}

interface InFlightRun {
  artifactId: string;
  timeoutMs: number;
  completion: Promise<ContextArtifactRow>;
}

interface GenerationPlan {
  mode: CompactionRunMode;
  /** Set when mode === "delta" (complete previous artifact with payload). */
  previousEnvelope: CompactionEnvelope | null;
  previousCoveredStartSeq: number | null;
  messageId: string | null;
  /** Coverage the initial run is expected to produce. */
  expected: { startSeq: number; endSeq: number };
}

function flightKey(input: TriggerCompactionInput): string {
  return `${input.conversationId}::${input.kind}::${input.messageIndex ?? ""}`;
}

export function createCompactionService(
  deps: CompactionServiceDeps,
): CompactionService {
  const inFlight = new Map<string, InFlightRun>();
  // Per-key trigger serialization (§7.2): `runTrigger` awaits transcript and
  // config reads before it registers the in-flight run, so a truly concurrent
  // trigger for the same slot must queue behind the first one's setup to see
  // the registration and coalesce instead of starting a second generation.
  const triggerMutex = createKeyedMutex();

  function statusEvent(
    input: TriggerCompactionInput,
    artifactId: string,
    status: ContextArtifactRow["status"],
    error?: string,
  ): ContextArtifactStatusEvent {
    const payload = {
      type: "context_artifact_status" as const,
      conversationId: input.conversationId,
      artifactId,
      kind: input.kind,
      status,
      ...(input.messageIndex !== undefined
        ? { messageIndex: input.messageIndex }
        : {}),
      ...(error !== undefined ? { error } : {}),
    };
    if (input.scope === "session" && input.sessionName !== null) {
      return {
        ...payload,
        scope: "session",
        projectName: input.projectName,
        sessionName: input.sessionName,
      };
    }
    return { ...payload, scope: "project", projectName: input.projectName };
  }

  function findConversationArtifact(
    conversationId: string,
  ): ContextArtifactRow | null {
    return (
      deps.repo
        .findByConversation(conversationId)
        .find((row) => row.kind === "conversation_compaction") ?? null
    );
  }

  function planRun(
    input: TriggerCompactionInput,
    entries: TranscriptEntryWithSeq[],
    maxSeq: number,
    existing: ContextArtifactRow | null,
  ): GenerationPlan | { error: string } {
    if (input.kind === "message_compaction") {
      if (input.messageIndex === undefined) {
        return { error: "messageIndex is required for message_compaction" };
      }
      const units = groupTranscriptEntries(entries);
      const unit = units[input.messageIndex];
      if (!unit) {
        return {
          error: `message index ${input.messageIndex} is out of range (conversation has ${units.length} messages)`,
        };
      }
      const firstPart = unit.parts[0];
      const lastPart = unit.parts[unit.parts.length - 1];
      if (!firstPart || !lastPart) {
        return { error: `message index ${input.messageIndex} has no entries` };
      }
      return {
        mode: "full",
        previousEnvelope: null,
        previousCoveredStartSeq: null,
        messageId: unit.messageId,
        expected: { startSeq: firstPart.seq, endSeq: lastPart.seq },
      };
    }

    const firstEntry = entries[0];
    if (!firstEntry) {
      return { error: EMPTY_TRANSCRIPT_COMPACTION_ERROR };
    }

    const canDelta =
      input.force !== true &&
      existing !== null &&
      existing.status === "complete" &&
      existing.payload !== null &&
      isArtifactVersionCurrent(existing) &&
      maxSeq > existing.coveredEndSeq;

    if (canDelta && existing !== null && existing.payload !== null) {
      return {
        mode: "delta",
        previousEnvelope: existing.payload,
        previousCoveredStartSeq: existing.coveredStartSeq,
        messageId: null,
        expected: { startSeq: existing.coveredStartSeq, endSeq: maxSeq },
      };
    }

    return {
      mode: "full",
      previousEnvelope: null,
      previousCoveredStartSeq: null,
      messageId: null,
      expected: {
        startSeq: firstEntry.seq,
        endSeq: lastRenderedSeq(entries, maxSeq),
      },
    };
  }

  /** Everything one generation run needs, resolved once at trigger time. */
  interface RunContext {
    input: TriggerCompactionInput;
    artifactId: string;
    baseRow: ContextArtifactRow;
    plan: GenerationPlan;
    entries: TranscriptEntryWithSeq[];
    maxSeq: number;
    config: CompactionConfig;
    modelSelection: BackendModelSelection;
  }

  function persistSuccess(
    ctx: RunContext,
    outcome: {
      envelope: CompactionEnvelope;
      sourceHash: string;
      inputBytes: number;
      mode: CompactionRunMode;
    },
    startedAt: number,
  ): ContextArtifactRow {
    const redactedEnvelope = redactEnvelopeStrings(outcome.envelope);
    const completedAt = deps.now();
    const finalRow: ContextArtifactRow = {
      ...ctx.baseRow,
      coveredStartSeq: redactedEnvelope.source.coveredStartSeq,
      coveredEndSeq: redactedEnvelope.source.coveredEndSeq,
      sourceHash: outcome.sourceHash,
      status: "complete",
      error: null,
      payload: redactedEnvelope,
      updatedAt: completedAt,
    };
    // Per-column update, not upsert: a row deleted mid-generation must stay
    // deleted, so the completion write no-ops (and skips the broadcast) when
    // the row is gone.
    const persisted = deps.repo.updateChangedColumns(ctx.artifactId, {
      coveredStartSeq: finalRow.coveredStartSeq,
      coveredEndSeq: finalRow.coveredEndSeq,
      sourceHash: finalRow.sourceHash,
      status: finalRow.status,
      error: finalRow.error,
      payload: finalRow.payload,
      updatedAt: finalRow.updatedAt,
    });
    if (!persisted) {
      genLogger.warn("artifact.generation.discarded_row_deleted", {
        artifactId: ctx.artifactId,
        conversationId: ctx.input.conversationId,
        kind: ctx.input.kind,
        durationMs: Date.now() - startedAt,
      });
      return finalRow;
    }
    deps.broadcast(statusEvent(ctx.input, ctx.artifactId, "complete"));
    genLogger.info("artifact.generation.completed", {
      artifactId: ctx.artifactId,
      conversationId: ctx.input.conversationId,
      kind: ctx.input.kind,
      mode: outcome.mode,
      modelSelection: ctx.modelSelection,
      durationMs: Date.now() - startedAt,
      inputBytes: outcome.inputBytes,
      outputBytes: Buffer.byteLength(JSON.stringify(redactedEnvelope), "utf-8"),
      coverage: {
        startSeq: finalRow.coveredStartSeq,
        endSeq: finalRow.coveredEndSeq,
      },
    });
    return finalRow;
  }

  async function runGeneration(ctx: RunContext): Promise<ContextArtifactRow> {
    const { input, artifactId, config, modelSelection } = ctx;
    const startedAt = Date.now();

    genLogger.info("artifact.generation.started", {
      artifactId,
      conversationId: input.conversationId,
      kind: input.kind,
      mode: ctx.plan.mode,
      backend: config.backend,
      modelSelection,
      messageIndex: input.messageIndex ?? null,
    });

    function failRun(error: string): ContextArtifactRow {
      const failedAt = deps.now();
      deps.repo.updateChangedColumns(artifactId, {
        status: "failed",
        error,
        updatedAt: failedAt,
      });
      deps.broadcast(statusEvent(input, artifactId, "failed", error));
      genLogger.error("artifact.generation.failed", {
        artifactId,
        conversationId: input.conversationId,
        kind: input.kind,
        modelSelection,
        durationMs: Date.now() - startedAt,
        error,
      });
      return {
        ...ctx.baseRow,
        status: "failed",
        error,
        updatedAt: failedAt,
      };
    }

    const laneSessionName =
      input.sessionName ?? PROJECT_CONVERSATION_SESSION_SENTINEL;
    try {
      const outcome = await generateCompactionEnvelope(
        {
          runId: artifactId,
          kind: input.kind,
          messageIndex: input.messageIndex ?? null,
          projectName: input.projectName,
          sessionName: input.sessionName,
          source: {
            conversationId: input.conversationId,
            entries: ctx.entries,
            maxSeq: ctx.maxSeq,
            capturedThroughSeq: ctx.maxSeq,
          },
          plan: {
            mode: ctx.plan.mode,
            previousEnvelope: ctx.plan.previousEnvelope,
            expected: ctx.plan.expected,
          },
          lane: {
            // The compaction lane inherits the scope of the conversation it
            // compacts — a project conversation has no session name, which is
            // why the store name above falls back to the sentinel.
            address: {
              projectPath: input.projectPath,
              target: targetFromStoreSessionName(
                input.projectName,
                laneSessionName,
                `compaction-${artifactId}`,
              ),
            },
            worktreePath: input.projectPath,
            backend: config.backend,
          },
          modelSelection,
          timeoutMs: resolveConfiguredTimeoutMs(config.timeoutMs),
        },
        { executeTaskRun: deps.executeTaskRun, log: genLogger },
      );
      if (!outcome.ok) return failRun(outcome.error);
      return persistSuccess(ctx, outcome, startedAt);
    } catch (err) {
      return failRun(getErrorMessage(err));
    }
  }

  function trigger(
    input: TriggerCompactionInput,
  ): Promise<TriggerCompactionResult> {
    const key = flightKey(input);
    return triggerMutex.run(key, () => runTrigger(input, key));
  }

  async function runTrigger(
    input: TriggerCompactionInput,
    key: string,
  ): Promise<TriggerCompactionResult> {
    logger.info("artifact.requested", {
      kind: input.kind,
      trigger: input.trigger,
      createdBy: input.createdBy,
      conversationId: input.conversationId,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      messageIndex: input.messageIndex ?? null,
      force: input.force === true,
    });
    auditLogger.info("audit.compaction_triggered", {
      callerConversationId: input.createdByConversationId ?? null,
      targetConversationId: input.conversationId,
      trigger: input.trigger,
    });

    const running = inFlight.get(key);
    if (running) {
      return {
        outcome: "coalesced",
        artifactId: running.artifactId,
        timeoutMs: running.timeoutMs,
        completion: running.completion,
      };
    }

    const { entries, maxSeq } = await deps.readEntries(input.transcriptPath);

    const existing =
      input.kind === "message_compaction"
        ? input.messageIndex !== undefined
          ? deps.repo.findMessageArtifact(
              input.conversationId,
              input.messageIndex,
            )
          : null
        : findConversationArtifact(input.conversationId);

    if (
      input.force !== true &&
      existing !== null &&
      existing.status === "complete"
    ) {
      // Message artifacts are coverage-fresh forever: transcripts are
      // append-only, so a message's own lines never change (§16 open item 1).
      // Conversation artifacts are coverage-fresh while coverage reaches
      // maxSeq. Either kind refreshes on generator version drift — the
      // API/CLI `outdated` hint points callers at a plain (non-force) compact.
      const fresh =
        (input.kind === "message_compaction" ||
          maxSeq <= existing.coveredEndSeq) &&
        isArtifactVersionCurrent(existing);
      if (fresh) {
        return { outcome: "already_fresh", artifact: existing };
      }
    }

    const plan = planRun(input, entries, maxSeq, existing);
    if ("error" in plan) {
      return { outcome: "invalid", error: plan.error };
    }

    const config = await deps.resolveConfig(input.projectPath);
    await assertBackendExecution(
      config.backend,
      compactionExecutionRequirements,
    );
    await assertBackendExecution(config.backend, compactionRepairRequirements);
    const modelSelection =
      input.kind === "conversation_compaction"
        ? config.conversationModelSelection
        : config.messageModelSelection;
    const nowIso = deps.now();
    const artifactId = existing?.id ?? randomUUID();

    const baseRow: ContextArtifactRow = {
      id: artifactId,
      kind: input.kind,
      scope: input.scope,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      messageId: plan.messageId ?? existing?.messageId ?? null,
      messageIndex: input.messageIndex ?? null,
      // A pre-existing row keeps its achieved coverage until the run
      // succeeds: the coverage columns must never claim seqs the retained
      // payload does not cover (failRun leaves them untouched, and freshness
      // derivation reads them without a status guard).
      coveredStartSeq: existing?.coveredStartSeq ?? plan.expected.startSeq,
      coveredEndSeq: existing?.coveredEndSeq ?? plan.expected.endSeq,
      sourceHash: existing?.sourceHash ?? "",
      status: "pending",
      error: null,
      backend: config.backend,
      modelSelection,
      schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
      createdBy: input.createdBy,
      createdByConversationId: input.createdByConversationId ?? null,
      payload: existing?.payload ?? null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    deps.repo.upsert(baseRow);
    deps.broadcast(statusEvent(input, artifactId, "pending"));

    const ctx: RunContext = {
      input,
      artifactId,
      baseRow,
      plan,
      entries,
      maxSeq,
      config,
      modelSelection,
    };
    const completion = runGeneration(ctx).finally(() => {
      if (inFlight.get(key)?.completion === completion) {
        inFlight.delete(key);
      }
    });
    const resolvedTimeoutMs = resolveConfiguredTimeoutMs(config.timeoutMs);
    inFlight.set(key, { artifactId, timeoutMs: resolvedTimeoutMs, completion });

    return {
      outcome: "started",
      artifactId,
      timeoutMs: resolvedTimeoutMs,
      completion,
    };
  }

  return { trigger };
}
