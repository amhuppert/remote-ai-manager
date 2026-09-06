/**
 * Pure aggregation core for the graph-workflow execution audit CLI
 * (`scripts/workflow-audit/run.ts`, exposed as `bun run workflow:audit`).
 *
 * Everything here is deterministic and IO-free: the loader hands us raw JSON
 * pulled from `command-center.db` and the per-execution `workflow-logs/`
 * directory, and we compute a bounded report of friction points, positives,
 * cost, and timing for an agent (or human) to interpret.
 *
 * The projection schemas below intentionally re-declare a *tolerant subset*
 * of the canonical execution schemas in `src/lib/workflows/schemas.ts`
 * rather than importing them: an audit must be able to read executions
 * persisted by older or newer builds, so every field the strict schema would
 * reject or require is defaulted here. They are read-only projections, not a
 * second source of truth for writes.
 */
import { z } from "zod";

// ============================================================
// Raw record parsing (JSONL lines, event rows)
// ============================================================

export interface JsonlRecord {
  timestamp: string;
  event: string;
  fields: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseJsonlLine(line: string): JsonlRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const { timestamp, event, ...rest } = record;
  if (typeof timestamp !== "string" || typeof event !== "string") return null;
  return { timestamp, event, fields: rest };
}

export interface AuditEvent {
  occurredAt: string;
  preReset: boolean;
  type: string;
  fields: Record<string, unknown>;
}

export function parseAuditEvent(input: {
  occurredAt: string;
  preReset: boolean;
  payload: unknown;
}): AuditEvent | null {
  const record = asRecord(input.payload);
  if (record === null) return null;
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) return null;
  return {
    occurredAt: input.occurredAt,
    preReset: input.preReset,
    type,
    fields: record,
  };
}

// ============================================================
// Execution projection (tolerant subset of the canonical schema)
// ============================================================

const auditHaltReasonSchema = z.object({
  type: z.string().default("unknown"),
  contextId: z.string().nullish().default(null),
  message: z.string().nullish().default(null),
  summary: z.string().nullish().default(null),
});
export type AuditHaltReason = z.infer<typeof auditHaltReasonSchema>;

const auditContextStateSchema = z.object({
  status: z.string().default("unknown"),
  totalTaskCount: z.number().default(0),
  completedTaskCount: z.number().default(0),
  iterationCount: z.number().default(0),
  consecutiveFailureCount: z.number().default(0),
  isolation: z.string().default("session"),
  worktreePath: z.string().nullish().default(null),
  branchName: z.string().nullish().default(null),
  laneId: z.string().nullish().default(null),
  mergeStatus: z.string().default("not-applicable"),
  lastMergeError: z.string().nullish().default(null),
});

const auditTaskStateSchema = z.object({
  taskId: z.string().nullish().default(null),
  contextId: z.string().default(""),
  status: z.string().default("unknown"),
  startedAt: z.string().nullish().default(null),
  completedAt: z.string().nullish().default(null),
  lastConversationId: z.string().nullish().default(null),
  failureMessage: z.string().nullish().default(null),
  failureHistory: z
    .array(
      z.object({
        message: z.string().default(""),
        timestamp: z.string().default(""),
      }),
    )
    .default([]),
});

const auditLaneStateSchema = z
  .object({
    lane: z.string().default("unknown"),
    engine: z.string().default("unknown"),
    backend: z.string().optional(),
    metrics: z
      .object({
        contextTokens: z.number().nullish(),
        contextWindowMax: z.number().nullish(),
      })
      .optional(),
    sessionRef: z
      .object({ conversationId: z.string().optional() })
      .nullish()
      .default(null),
    workflowConversationId: z.string().nullish().default(null),
    lastContextTokens: z.number().nullish().default(null),
    lastContextWindowMax: z.number().nullish().default(null),
    lastTurnUsage: z
      .object({
        inputTokens: z.number().default(0),
        cachedInputTokens: z.number().default(0),
        outputTokens: z.number().default(0),
      })
      .nullish()
      .default(null),
  })
  .transform((lane) => ({
    ...lane,
    engine: lane.backend ?? lane.engine,
    lastContextTokens: lane.metrics
      ? (lane.metrics.contextTokens ?? null)
      : lane.lastContextTokens,
    lastContextWindowMax: lane.metrics
      ? (lane.metrics.contextWindowMax ?? null)
      : lane.lastContextWindowMax,
  }));

const auditJoinStateSchema = z.object({
  kind: z.string().default(""),
  status: z.string().default(""),
  contextId: z.string().nullish().default(null),
  errorMessage: z.string().nullish().default(null),
  conflicts: z
    .object({
      files: z.array(z.string()).default([]),
      message: z.string().nullish().default(null),
    })
    .nullish()
    .default(null),
  // Conflicts the merge machinery auto-resolved (smart-merge sub-turn or the
  // runner's clean retry) — a succeeded join carrying these is NOT a clean
  // merge, and the positives detector must distinguish the two.
  resolvedConflicts: z
    .array(
      z.object({
        sourceLaneId: z.string().default(""),
        files: z.array(z.string()).default([]),
        resolution: z.string().default("unknown"),
      }),
    )
    .default([]),
  sourceLaneIds: z.array(z.string()).default([]),
  completedAt: z.string().nullish().default(null),
});

const auditDefinitionContextSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  iterationPolicy: z
    .object({
      continuity: z
        .object({ contextLimitTokens: z.number().nullish().default(null) })
        .nullish()
        .default(null),
    })
    .nullish()
    .default(null),
});

const auditExecutionProjectionSchema = z.object({
  id: z.string(),
  seedDefinitionId: z.string().default("unknown"),
  seedDefinitionRevision: z.number().default(0),
  boundInputs: z.record(z.string(), z.string()).default({}),
  launchedTier: z.string().default("project"),
  status: z.string().default("unknown"),
  startedAt: z.string(),
  completedAt: z.string().nullish().default(null),
  haltReason: auditHaltReasonSchema.nullish().default(null),
  pendingHaltReason: auditHaltReasonSchema.nullish().default(null),
  secondaryHaltReasons: z.array(auditHaltReasonSchema).default([]),
  charter: z.unknown().optional(),
  sharedDocuments: z.array(z.unknown()).default([]),
  workingDefinition: z
    .object({
      executionContexts: z.array(auditDefinitionContextSchema).default([]),
    })
    .default({ executionContexts: [] }),
  contextStates: z.record(z.string(), auditContextStateSchema).default({}),
  taskStates: z.record(z.string(), auditTaskStateSchema).default({}),
  laneStates: z
    .record(z.string(), z.record(z.string(), auditLaneStateSchema))
    .default({}),
  joins: z.record(z.string(), auditJoinStateSchema).default({}),
});
export type AuditExecution = z.infer<typeof auditExecutionProjectionSchema>;

export function parseExecutionProjection(
  raw: unknown,
): { ok: true; execution: AuditExecution } | { ok: false; error: string } {
  const result = auditExecutionProjectionSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, execution: result.data };
}

// ============================================================
// Audit input (assembled by the loader)
// ============================================================

export interface AuditConversationRow {
  id: string;
  role: string | null;
  totalCostUsd: number | null;
  totalDurationMs: number | null;
  totalTurns: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  transcriptPath: string | null;
  /** Loader-supplied transcript tallies; absent when the file is unreadable. */
  transcriptScan?: TranscriptScan | null;
}

export interface ContextLogs {
  iterations: JsonlRecord[];
  tasks: JsonlRecord[];
  validation: JsonlRecord[];
  validatorResponses: Array<{ file: string; parsePath: string | null }>;
}

export interface AuditInput {
  source: "active" | "archived";
  execution: AuditExecution;
  events: AuditEvent[];
  conversations: AuditConversationRow[];
  contextLogs: Record<string, ContextLogs>;
  /**
   * Execution-level lifecycle records (workflow-logs/<id>/lifecycle.jsonl).
   * The only durable trace of recovered halts and join retry attempts — the
   * execution state retains final outcomes only.
   */
  lifecycle?: JsonlRecord[];
  /** Cross-cutting decision records (workflow-logs/<id>/decisions.jsonl). */
  decisions?: JsonlRecord[];
  paths: { workflowLogsDir: string | null; transcriptsDir: string | null };
  /** Diffstat of the final_publish join commit; loader-supplied, best-effort. */
  finalPublish?: { commitSha: string; files: PublishFileStat[] } | null;
}

// ============================================================
// Report types
// ============================================================

export type Severity = "high" | "medium" | "info";
export type HaltClass = "infrastructure" | "agent" | "user" | "unknown";
export type GapClassification =
  | "agent_work"
  | "human_wait"
  | "halt_wait"
  | "hung_turn"
  | "validation_compute"
  | "join_compute"
  | "unexplained";

/** One halted→resumed pair from lifecycle.jsonl; resumedAt null while halted. */
export interface HaltRecoveryReport {
  haltedAt: string;
  resumedAt: string | null;
  waitMs: number | null;
  haltType: string;
  contextId: string | null;
}

/**
 * A known measurement limitation of this report — figures the reader must
 * treat as floors or inconclusive rather than measured truth.
 */
export interface ConfidenceNote {
  kind: string;
  summary: string;
}

export interface IterationReport {
  iterationNumber: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  agentTurns: number;
  seedPromptLength: number | null;
  maxContextTokens: number | null;
  conversationId: string | null;
  model: string | null;
}

export interface ValidationIssue {
  taskId: string;
  title: string;
  description: string;
}

export interface ValidationReport {
  occurredAt: string;
  pass: boolean;
  summary: string;
  issueCount: number;
  reopenTaskIds: string[];
  issues: ValidationIssue[];
}

export interface WaitReport {
  requestedAt: string;
  resolvedAt: string | null;
  decision: string | null;
  waitMs: number | null;
}

export interface ConversationReport {
  conversationId: string;
  lane: string | null;
  contextId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  transcriptPath: string | null;
  transcript: TranscriptScan | null;
}

export interface TaskFailureReport {
  taskId: string;
  message: string;
  timestamp: string;
}

export interface ContextReport {
  contextId: string;
  title: string;
  status: string;
  totalTaskCount: number;
  completedTaskCount: number;
  iterationCount: number;
  consecutiveFailureCount: number;
  mergeStatus: string;
  branchName: string | null;
  laneId: string | null;
  worktreePath: string | null;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  agentTurnMs: number;
  /**
   * Time inside turn intervals that exceeded the hung-turn threshold with no
   * intermediate record — excluded from agentTurnMs so a dead turn does not
   * read as productive labor.
   */
  hungTurnMs: number;
  scriptValidationRuns: { started: number; passed: number; failed: number };
  /** rotation.scheduled decisions for this context (decisions.jsonl). */
  rotationScheduledCount: number;
  /** implementer.rotation applications, excluding plain context switches. */
  rotationAppliedCount: number;
  iterations: IterationReport[];
  validations: ValidationReport[];
  approvalWaits: WaitReport[];
  userInputWaits: WaitReport[];
  peakContextTokens: number | null;
  contextWindowMax: number | null;
  peakOccupancyPct: number | null;
  /** Configured continuity rotation limit from the working definition. */
  rotationLimitTokens: number | null;
  taskFailures: TaskFailureReport[];
  parseFallbacks: Array<{ file: string; parsePath: string | null }>;
  conversations: ConversationReport[];
}

export interface GapReport {
  startedAt: string;
  endedAt: string;
  gapMs: number;
  classification: GapClassification;
  fromEvent: string;
  toEvent: string;
}

export interface Finding {
  kind: string;
  severity: Severity;
  contextId: string | null;
  summary: string;
}

export interface AuditReport {
  overview: {
    executionId: string;
    seedDefinitionId: string;
    seedDefinitionRevision: number;
    launchedTier: string;
    boundInputs: Record<string, string>;
    status: string;
    source: "active" | "archived";
    startedAt: string;
    completedAt: string | null;
    wallClockMs: number | null;
    contextsTotal: number;
    contextsCompleted: number;
    haltReason: AuditHaltReason | null;
    pendingHaltReason: AuditHaltReason | null;
    secondaryHaltReasons: AuditHaltReason[];
    charterPresent: boolean;
    sharedDocumentCount: number;
  };
  contexts: ContextReport[];
  cost: {
    totalUsd: number;
    /**
     * Recorded totals with each scanned conversation's cost replaced by its
     * transcript lineage total. Null when no transcript scans were available.
     * Diverges from `totalUsd` for rows written before the accrual fix
     * (cumulative-consumed-as-delta inflation).
     */
    correctedTotalUsd: number | null;
    byLane: Record<string, number>;
    byContext: Record<string, number>;
    knownConversationCount: number;
    missingCostCount: number;
    /**
     * Codex context-validator spend from validation-result review artifacts —
     * these runs have no conversation cost row. `estimatedUsd` sums only
     * events that recorded a costUsd (older events carry tokens only); null
     * when no event carried a usage artifact.
     */
    validators: {
      estimatedUsd: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      usageEventCount: number;
      unpricedEventCount: number;
    } | null;
  };
  time: {
    wallClockMs: number | null;
    agentTurnMsTotal: number;
    /** Total time inside hung turn intervals, excluded from agentTurnMsTotal. */
    hungTurnMsTotal: number;
    humanWaitMsTotal: number;
    /**
     * Total halted→resumed wait from lifecycle.jsonl. Distinct from
     * humanWaitMsTotal, which only counts configured approval/user-input
     * gates: a halt has no gate event, so before this metric existed a run
     * with hours of operator recovery reported zero human wait.
     */
    operatorRecoveryWaitMsTotal: number;
    haltRecoveries: HaltRecoveryReport[];
    gaps: GapReport[];
  };
  publish: {
    commitSha: string;
    fileCount: number;
    totalAdditions: number;
    totalDeletions: number;
    scratchFiles: Array<{ path: string; additions: number }>;
  } | null;
  friction: Finding[];
  positives: Finding[];
  /** Measurement limitations — where this report's figures are floors or inconclusive. */
  confidence: ConfidenceNote[];
  pointers: {
    workflowLogsDir: string | null;
    transcripts: Array<{
      conversationId: string;
      transcriptPath: string | null;
      lane: string | null;
      contextId: string | null;
    }>;
  };
}

// ============================================================
// Halt classification
// ============================================================

const INFRA_HALT_TYPES = new Set([
  "infrastructure_blocked",
  "recovery_error",
  "script_validator_missing_command",
  "validator_infra_error",
  "merge_failure",
  "join_failure",
  "merge_precondition_failed",
  "worktree_creation_dirty",
  "execution_loop_failed",
  "agent_turn_failed",
]);
const AGENT_HALT_TYPES = new Set([
  "circuit_breaker",
  "max_iterations",
  "collaboration_failure",
]);

export function classifyHaltReason(type: string): HaltClass {
  if (INFRA_HALT_TYPES.has(type)) return "infrastructure";
  if (AGENT_HALT_TYPES.has(type)) return "agent";
  if (type === "aborted") return "user";
  return "unknown";
}

// ============================================================
// Field access helpers
// ============================================================

function fieldStr(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" ? value : null;
}

function fieldNum(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseIso(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// ============================================================
// Transcript scanning (pure)
// ============================================================

/**
 * Cheap single-pass tallies over one conversation transcript, used to rank
 * hotspot conversations and cross-check DB cost rows without reading the
 * transcript qualitatively.
 *
 * The cost rule mirrors `summarizeTranscriptTelemetry`
 * (src/lib/workflow-graph/conversation-telemetry.ts): Claude's
 * `result.total_cost_usd` is CUMULATIVE per session lineage and codex result
 * frames' `costUsd` is CUMULATIVE per thread, so the true conversation cost
 * is the sum of each lineage's FINAL value. Historical DB rows written before
 * the accrual fixes consumed cumulatives as deltas and are inflated — the
 * `cost_mismatch` detector exists to surface exactly that.
 * Standalone rather than imported per this module's header: the audit CLI
 * must stay dependency-free and tolerant of transcripts from other builds.
 */
export interface TranscriptScan {
  /** Σ of each SDK session lineage's final cumulative cost; null if no results. */
  costUsd: number | null;
  lineageCount: number;
  /** Σ `num_turns` across all SDK result entries; null if no results. */
  apiTurns: number | null;
  toolUseCount: number;
  /** Tool-call counts, most-used first (capped). */
  toolCounts: Array<{ name: string; count: number }>;
  toolErrorCount: number;
  /** Background tasks reported `killed` (typically at a turn boundary). */
  backgroundTasksKilled: number;
  modelFallbacks: number;
  compactions: number;
  reads: { uniqueFiles: number; totalReads: number; repeatReads: number };
  /** Files Read more than once, most-repeated first (capped). */
  topReReads: Array<{ path: string; count: number }>;
}

const TOP_TOOL_COUNTS_LIMIT = 5;
const TOP_RE_READS_LIMIT = 3;

function literalShellReadPath(command: unknown): string | null {
  if (typeof command !== "string") return null;
  // Only standalone reads of a literal path are attributable without a shell
  // interpreter. Pipelines, redirects and expansions remain uncounted.
  if (/[\n\r;$`<>|&*?\\]/.test(command)) return null;
  const match = command
    .trim()
    .match(
      /^(?:cat\s+|sed\s+-n\s+(?:'[\d,$]+p'|"[\d,$]+p"|[\d,$]+p)\s+)(?:--\s+)?(?:'([^']+)'|"([^"]+)"|([^\s'"]+))$/,
    );
  const filePath = match?.[1] ?? match?.[2] ?? match?.[3];
  return filePath && !filePath.startsWith("-") ? filePath : null;
}

export function scanTranscriptText(jsonlText: string): TranscriptScan {
  const lineageFinalCost = new Map<string, number>();
  let committedLineageCost = 0;
  let lineageRestarts = 0;
  let apiTurns: number | null = null;
  const toolCounts = new Map<string, number>();
  const readCounts = new Map<string, number>();
  let toolErrorCount = 0;
  let backgroundTasksKilled = 0;
  let modelFallbacks = 0;
  let compactions = 0;

  for (const line of jsonlText.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    if (entry === null) continue;
    const raw = asRecord(entry.raw);

    // Claude result frames report `total_cost_usd` cumulative per SDK session
    // lineage; codex result frames report `costUsd` cumulative per thread
    // (`backendRef.ref`). Both reduce to final-cumulative-per-lineage.
    const lineageUsage =
      raw === null
        ? null
        : typeof raw.total_cost_usd === "number"
          ? {
              lineageId: String(raw.session_id ?? "unknown"),
              cumulativeCostUsd: raw.total_cost_usd,
              numTurns:
                typeof raw.num_turns === "number" ? raw.num_turns : null,
            }
          : raw.backend === "codex" && typeof raw.costUsd === "number"
            ? {
                lineageId: String(
                  asRecord(raw.backendRef)?.ref ?? "codex-unknown",
                ),
                cumulativeCostUsd: raw.costUsd,
                numTurns:
                  typeof raw.numTurns === "number" ? raw.numTurns : null,
              }
            : null;
    if (lineageUsage !== null) {
      // Cumulative per lineage — the last result in file order is the final.
      // A restarted subprocess can resume the SAME session id with its
      // cumulative reset; the drop is the lineage boundary, so bank the
      // finished lineage's final before tracking the new one.
      const previous = lineageFinalCost.get(lineageUsage.lineageId);
      if (previous !== undefined && lineageUsage.cumulativeCostUsd < previous) {
        committedLineageCost += previous;
        lineageRestarts += 1;
      }
      lineageFinalCost.set(
        lineageUsage.lineageId,
        lineageUsage.cumulativeCostUsd,
      );
      if (lineageUsage.numTurns !== null) {
        apiTurns = (apiTurns ?? 0) + lineageUsage.numTurns;
      }
    }

    if (raw !== null && typeof raw.subtype === "string") {
      if (raw.subtype === "task_updated") {
        const patch = asRecord(raw.patch);
        if (patch !== null && patch.status === "killed") {
          backgroundTasksKilled += 1;
        }
      } else if (raw.subtype === "model_refusal_fallback") {
        modelFallbacks += 1;
      } else if (raw.subtype === "compact_boundary") {
        compactions += 1;
      }
    }

    if (entry.type === "tool_result") {
      const message = asRecord(raw?.message);
      const content = Array.isArray(entry.content)
        ? entry.content
        : message?.content;
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          const block = asRecord(rawBlock);
          if (
            block !== null &&
            block.type === "tool_result" &&
            (block.is_error === true || block.isError === true)
          ) {
            toolErrorCount += 1;
          }
        }
      }
    }

    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      for (const rawBlock of entry.content) {
        const block = asRecord(rawBlock);
        if (block === null || block.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : "unknown";
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        const input = asRecord(block.input);
        const filePath =
          name === "Read"
            ? input?.file_path
            : name === "Bash"
              ? literalShellReadPath(input?.command)
              : null;
        if (typeof filePath === "string" && filePath.length > 0) {
          readCounts.set(filePath, (readCounts.get(filePath) ?? 0) + 1);
        }
      }
    }
  }

  let toolUseCount = 0;
  for (const count of toolCounts.values()) toolUseCount += count;
  let totalReads = 0;
  for (const count of readCounts.values()) totalReads += count;

  return {
    costUsd:
      lineageFinalCost.size === 0
        ? null
        : committedLineageCost +
          [...lineageFinalCost.values()].reduce((sum, cost) => sum + cost, 0),
    lineageCount: lineageFinalCost.size + lineageRestarts,
    apiTurns,
    toolUseCount,
    toolCounts: [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TOOL_COUNTS_LIMIT)
      .map(([name, count]) => ({ name, count })),
    toolErrorCount,
    backgroundTasksKilled,
    modelFallbacks,
    compactions,
    reads: {
      uniqueFiles: readCounts.size,
      totalReads,
      repeatReads: totalReads - readCounts.size,
    },
    topReReads: [...readCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_RE_READS_LIMIT)
      .map(([path, count]) => ({ path, count })),
  };
}

// ============================================================
// Final-publish composition (git numstat)
// ============================================================

export interface PublishFileStat {
  path: string;
  additions: number;
  deletions: number;
}

/** Parses `git show --numstat --format=` output; `-` (binary) counts as 0. */
export function parseGitNumstat(output: string): PublishFileStat[] {
  const files: PublishFileStat[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [rawAdd, rawDel, ...pathParts] = parts;
    const filePath = pathParts.join("\t").trim();
    if (filePath.length === 0) continue;
    const additions = Number.parseInt(rawAdd ?? "", 10);
    const deletions = Number.parseInt(rawDel ?? "", 10);
    files.push({
      path: filePath,
      additions: Number.isNaN(additions) ? 0 : additions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
    });
  }
  return files;
}

/**
 * Lane auto-commits sweep untracked files, so live-run debris (dev-server
 * logs, poll captures) can ride a final publish into the session branch.
 * `.cc/graph-workflow-docs/` is exempt: the engine materializes the charter
 * and shared documents there on purpose.
 */
function isScratchPath(filePath: string): boolean {
  if (filePath.startsWith(".cc/graph-workflow-docs/")) return false;
  return filePath.startsWith(".cc/") || filePath.endsWith(".log");
}

// ============================================================
// Interval math (for gap classification)
// ============================================================

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function overlapMs(gap: Interval, intervals: Interval[]): number {
  let total = 0;
  for (const interval of intervals) {
    const start = Math.max(gap.start, interval.start);
    const end = Math.min(gap.end, interval.end);
    if (end > start) total += end - start;
  }
  return total;
}

// ============================================================
// Aggregation
// ============================================================

const GAP_THRESHOLD_MS = 5 * 60 * 1000;
const LONG_HUMAN_WAIT_MS = 10 * 60 * 1000;
const LONG_STALL_MS = 30 * 60 * 1000;
const WINDOW_PRESSURE_PCT = 70;
const PROMPT_GROWTH_FACTOR = 2;
const PROMPT_GROWTH_MIN_DELTA = 4000;
const MAX_GAPS_REPORTED = 10;
const COST_MISMATCH_MIN_ABS_USD = 0.5;
const COST_MISMATCH_MIN_REL = 0.1;
const ROTATION_OVERRUN_FACTOR = 1.5;
const BACKGROUND_KILL_THRESHOLD = 3;
const SCRATCH_FILES_RENDER_CAP = 3;
const COST_MISMATCH_RENDER_CAP = 3;
/**
 * A turn-start record followed by nothing for this long is treated as hung,
 * not as productive agent work. Chosen well above legitimate long turns
 * observed in real runs (heavy subagent sweeps run ~30-45m) but far below
 * the multi-hour silent-turn incidents this exists to surface.
 */
const HUNG_TURN_THRESHOLD_MS = 60 * 60 * 1000;
const COST_GAP_MIN_TOOL_CALLS = 20;
const COST_GAP_MIN_TURNS = 5;
/** Halt types that mean a join/merge attempt failed. */
const MERGE_CLASS_HALT_TYPES = new Set([
  "merge_failure",
  "join_failure",
  "merge_precondition_failed",
]);

const AGENT_TURN_START_EVENTS = new Set([
  "iteration.prompt_sent",
  "iteration.follow_up_sent",
]);
const VALIDATOR_WORK_START_EVENTS = new Set([
  "context_validator.started",
  "task_validator.started",
  "validator.invoked",
]);
const SCRIPT_VALIDATION_START_EVENTS = new Set(["script_validation.started"]);

interface TimelinePoint {
  at: number;
  label: string;
}

function buildIterations(records: JsonlRecord[]): IterationReport[] {
  const iterations: IterationReport[] = [];
  let current: IterationReport | null = null;
  for (const record of records) {
    if (record.event === "iteration.started") {
      current = {
        iterationNumber:
          fieldNum(record.fields, "iterationNumber") ?? iterations.length + 1,
        startedAt: record.timestamp,
        completedAt: null,
        durationMs: null,
        agentTurns: 0,
        seedPromptLength: null,
        maxContextTokens: null,
        conversationId: null,
        model: fieldStr(record.fields, "model"),
      };
      iterations.push(current);
      continue;
    }
    if (current === null) continue;
    if (record.event === "iteration.conversation_resolved") {
      current.conversationId ??= fieldStr(record.fields, "conversationId");
    } else if (record.event === "iteration.prompt_sent") {
      current.seedPromptLength ??= fieldNum(record.fields, "promptLength");
    } else if (record.event === "iteration.agent_turn_completed") {
      current.agentTurns += 1;
      const tokens = fieldNum(record.fields, "contextTokens");
      if (tokens !== null) {
        current.maxContextTokens = Math.max(
          current.maxContextTokens ?? 0,
          tokens,
        );
      }
    } else if (record.event === "iteration.completed") {
      current.completedAt = record.timestamp;
      const start = parseIso(current.startedAt);
      const end = parseIso(record.timestamp);
      current.durationMs = start !== null && end !== null ? end - start : null;
    }
  }
  return iterations;
}

/** start-event record → next record, for records that bound their own end. */
function collectStartToNextIntervals(
  records: JsonlRecord[],
  startEvents: Set<string>,
): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i];
    const next = records[i + 1];
    if (record === undefined || next === undefined) continue;
    if (!startEvents.has(record.event)) continue;
    const start = parseIso(record.timestamp);
    const end = parseIso(next.timestamp);
    if (start !== null && end !== null && end > start) {
      intervals.push({ start, end });
    }
  }
  return intervals;
}

interface TurnIntervalSplit {
  work: Interval[];
  hung: Array<Interval & { startedAt: string }>;
}

/**
 * Splits implementer turn intervals into productive work vs hung turns. A
 * turn interval runs from its start record to the next record in the log; a
 * trailing turn with no successor is bounded by the execution's last known
 * activity, because a turn that never wrote another record is exactly the
 * hung case this exists to catch.
 */
function splitTurnIntervals(
  records: JsonlRecord[],
  lastActivityMs: number | null,
): TurnIntervalSplit {
  const work: Interval[] = [];
  const hung: TurnIntervalSplit["hung"] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || !AGENT_TURN_START_EVENTS.has(record.event)) {
      continue;
    }
    const start = parseIso(record.timestamp);
    if (start === null) continue;
    const next = records[i + 1];
    const end = next !== undefined ? parseIso(next.timestamp) : lastActivityMs;
    if (end === null || end <= start) continue;
    if (end - start > HUNG_TURN_THRESHOLD_MS) {
      hung.push({ start, end, startedAt: record.timestamp });
    } else {
      work.push({ start, end });
    }
  }
  return { work, hung };
}

/** Pairs execution.halted with the next execution.resumed, FIFO. */
function pairHaltRecoveries(lifecycle: JsonlRecord[]): HaltRecoveryReport[] {
  const recoveries: HaltRecoveryReport[] = [];
  const pending: Array<{
    at: string;
    haltType: string;
    contextId: string | null;
  }> = [];
  for (const record of lifecycle) {
    if (record.event === "execution.halted") {
      const reason = asRecord(record.fields.haltReason);
      pending.push({
        at: record.timestamp,
        haltType:
          (reason !== null ? fieldStr(reason, "type") : null) ?? "unknown",
        contextId: reason !== null ? fieldStr(reason, "contextId") : null,
      });
    } else if (record.event === "execution.resumed") {
      const halt = pending.shift();
      if (halt === undefined) continue;
      const start = parseIso(halt.at);
      const end = parseIso(record.timestamp);
      recoveries.push({
        haltedAt: halt.at,
        resumedAt: record.timestamp,
        waitMs:
          start !== null && end !== null && end > start ? end - start : null,
        haltType: halt.haltType,
        contextId: halt.contextId,
      });
    }
  }
  for (const halt of pending) {
    recoveries.push({
      haltedAt: halt.at,
      resumedAt: null,
      waitMs: null,
      haltType: halt.haltType,
      contextId: halt.contextId,
    });
  }
  return recoveries;
}

function pairWaits(
  events: AuditEvent[],
  pendingType: string,
  resolvedType: string,
  requestedAtKey: string,
  resolvedAtKey: string,
  decisionKey: string,
  contextId: string,
): WaitReport[] {
  const waits: WaitReport[] = [];
  const pendingQueue: AuditEvent[] = [];
  for (const event of events) {
    if (fieldStr(event.fields, "contextId") !== contextId) continue;
    if (event.type === pendingType) {
      pendingQueue.push(event);
    } else if (event.type === resolvedType) {
      const pending = pendingQueue.shift();
      if (pending === undefined) continue;
      const requestedAt =
        fieldStr(pending.fields, requestedAtKey) ?? pending.occurredAt;
      const resolvedAt =
        fieldStr(event.fields, resolvedAtKey) ?? event.occurredAt;
      const start = parseIso(requestedAt);
      const end = parseIso(resolvedAt);
      waits.push({
        requestedAt,
        resolvedAt,
        decision: fieldStr(event.fields, decisionKey),
        waitMs: start !== null && end !== null ? end - start : null,
      });
    }
  }
  for (const pending of pendingQueue) {
    waits.push({
      requestedAt:
        fieldStr(pending.fields, requestedAtKey) ?? pending.occurredAt,
      resolvedAt: null,
      decision: null,
      waitMs: null,
    });
  }
  return waits;
}

function buildValidations(
  events: AuditEvent[],
  contextId: string,
): ValidationReport[] {
  const validations: ValidationReport[] = [];
  for (const event of events) {
    if (event.type !== "graph-workflow-validation-result") continue;
    if (fieldStr(event.fields, "contextId") !== contextId) continue;
    const rawIssues = event.fields.issues;
    const issues: ValidationIssue[] = [];
    if (Array.isArray(rawIssues)) {
      for (const raw of rawIssues) {
        const record = asRecord(raw);
        if (record === null) continue;
        issues.push({
          taskId: fieldStr(record, "taskId") ?? "",
          title: fieldStr(record, "title") ?? "",
          description: fieldStr(record, "description") ?? "",
        });
      }
    }
    const rawReopen = event.fields.reopenTaskIds;
    const reopenTaskIds = Array.isArray(rawReopen)
      ? rawReopen.filter((id): id is string => typeof id === "string")
      : [];
    validations.push({
      occurredAt: event.occurredAt,
      pass: event.fields.pass === true,
      summary: fieldStr(event.fields, "summary") ?? "",
      issueCount: issues.length,
      reopenTaskIds,
      issues,
    });
  }
  return validations.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

const EMPTY_CONTEXT_STATE = auditContextStateSchema.parse({});
const EMPTY_LOGS: ContextLogs = {
  iterations: [],
  tasks: [],
  validation: [],
  validatorResponses: [],
};

export function buildAuditReport(input: AuditInput): AuditReport {
  const { execution, events, conversations, contextLogs } = input;
  const lifecycle = input.lifecycle ?? [];
  const decisions = input.decisions ?? [];

  // Latest timestamp across everything we can see — bounds trailing turn
  // intervals and unresolved halt windows for an execution still in flight.
  let lastActivityMs = parseIso(execution.completedAt);
  const bumpLastActivity = (at: number | null) => {
    if (at !== null) lastActivityMs = Math.max(lastActivityMs ?? at, at);
  };
  bumpLastActivity(parseIso(execution.startedAt));
  for (const event of events) bumpLastActivity(parseIso(event.occurredAt));
  for (const record of lifecycle) bumpLastActivity(parseIso(record.timestamp));
  for (const logs of Object.values(contextLogs)) {
    for (const record of [
      ...logs.iterations,
      ...logs.tasks,
      ...logs.validation,
    ]) {
      bumpLastActivity(parseIso(record.timestamp));
    }
  }

  // ---- lifecycle-derived recovery and retry history --------------------
  const haltRecoveries = pairHaltRecoveries(lifecycle);
  const joinRetryCounts = new Map<string, number>();
  for (const record of lifecycle) {
    if (record.event !== "merge.retry_attempted") continue;
    const target =
      fieldStr(record.fields, "joinId") ??
      fieldStr(record.fields, "contextId") ??
      "unknown";
    joinRetryCounts.set(target, (joinRetryCounts.get(target) ?? 0) + 1);
  }

  // ---- rotation decisions (scheduled vs applied) -----------------------
  const rotationScheduled = new Map<string, number>();
  const rotationApplied = new Map<string, number>();
  for (const record of decisions) {
    const contextId = fieldStr(record.fields, "contextId");
    if (contextId === null) continue;
    if (record.event === "rotation.scheduled") {
      rotationScheduled.set(
        contextId,
        (rotationScheduled.get(contextId) ?? 0) + 1,
      );
    } else if (
      (record.event === "implementer.rotation" ||
        record.event === "validator.rotation") &&
      fieldStr(record.fields, "reason") === "rotation_scheduled"
    ) {
      rotationApplied.set(contextId, (rotationApplied.get(contextId) ?? 0) + 1);
    }
  }

  // ---- conversation attribution --------------------------------------
  const laneByConversation = new Map<
    string,
    { lane: string; contextId: string }
  >();
  for (const [contextId, lanes] of Object.entries(execution.laneStates)) {
    for (const [laneKey, laneState] of Object.entries(lanes)) {
      const conversationId =
        laneState.sessionRef?.conversationId ??
        laneState.workflowConversationId;
      if (typeof conversationId === "string" && conversationId.length > 0) {
        laneByConversation.set(conversationId, {
          lane: laneState.lane === "unknown" ? laneKey : laneState.lane,
          contextId,
        });
      }
    }
  }
  // laneStates only retain the most recent conversation per lane, so rotated
  // implementer conversations are recovered from iteration.conversation_resolved
  // records and validator conversations from validation-result sessionRefs.
  for (const [contextId, logs] of Object.entries(contextLogs)) {
    for (const record of logs.iterations) {
      if (record.event !== "iteration.conversation_resolved") continue;
      const conversationId = fieldStr(record.fields, "conversationId");
      if (conversationId !== null && !laneByConversation.has(conversationId)) {
        laneByConversation.set(conversationId, {
          lane: "implementer",
          contextId,
        });
      }
    }
  }
  for (const event of events) {
    if (event.type !== "graph-workflow-validation-result") continue;
    const contextId = fieldStr(event.fields, "contextId");
    const sessionRef = asRecord(event.fields.sessionRef);
    if (sessionRef === null || contextId === null) continue;
    const conversationId = fieldStr(sessionRef, "conversationId");
    if (conversationId !== null && !laneByConversation.has(conversationId)) {
      laneByConversation.set(conversationId, {
        lane: fieldStr(sessionRef, "lane") ?? "context_validator",
        contextId,
      });
    }
  }
  const contextByConversation = new Map<string, string>();
  for (const [conversationId, ref] of laneByConversation) {
    contextByConversation.set(conversationId, ref.contextId);
  }
  for (const task of Object.values(execution.taskStates)) {
    if (task.lastConversationId !== null && task.contextId.length > 0) {
      if (!contextByConversation.has(task.lastConversationId)) {
        contextByConversation.set(task.lastConversationId, task.contextId);
      }
    }
  }

  const conversationReports: ConversationReport[] = conversations.map(
    (row) => ({
      conversationId: row.id,
      lane: laneByConversation.get(row.id)?.lane ?? null,
      contextId: contextByConversation.get(row.id) ?? null,
      costUsd: row.totalCostUsd,
      durationMs: row.totalDurationMs,
      turns: row.totalTurns,
      transcriptPath: row.transcriptPath,
      transcript: row.transcriptScan ?? null,
    }),
  );

  // ---- per-context reports --------------------------------------------
  const definitionOrder = new Map<string, number>();
  const titles = new Map<string, string>();
  const rotationLimits = new Map<string, number>();
  execution.workingDefinition.executionContexts.forEach((context, index) => {
    definitionOrder.set(context.id, index);
    titles.set(context.id, context.title);
    const limit = context.iterationPolicy?.continuity?.contextLimitTokens;
    if (typeof limit === "number" && limit > 0) {
      rotationLimits.set(context.id, limit);
    }
  });
  const contextIds = new Set<string>([
    ...Object.keys(execution.contextStates),
    ...definitionOrder.keys(),
    ...Object.keys(contextLogs),
  ]);

  const workIntervals: Interval[] = [];
  const humanIntervals: Interval[] = [];
  const hungIntervals: Interval[] = [];
  const validationComputeIntervals: Interval[] = [];
  const hungTurnsByContext = new Map<
    string,
    Array<{ startedAt: string; durationMs: number }>
  >();
  const contexts: ContextReport[] = [];

  for (const contextId of contextIds) {
    const state = execution.contextStates[contextId] ?? EMPTY_CONTEXT_STATE;
    const logs = contextLogs[contextId] ?? EMPTY_LOGS;
    const iterations = buildIterations(logs.iterations);
    const turnSplit = splitTurnIntervals(logs.iterations, lastActivityMs);
    workIntervals.push(...turnSplit.work);
    workIntervals.push(
      ...collectStartToNextIntervals(
        logs.validation,
        VALIDATOR_WORK_START_EVENTS,
      ),
    );
    validationComputeIntervals.push(
      ...collectStartToNextIntervals(
        logs.validation,
        SCRIPT_VALIDATION_START_EVENTS,
      ),
    );
    hungIntervals.push(...turnSplit.hung);
    if (turnSplit.hung.length > 0) {
      hungTurnsByContext.set(
        contextId,
        turnSplit.hung.map((interval) => ({
          startedAt: interval.startedAt,
          durationMs: interval.end - interval.start,
        })),
      );
    }

    let agentTurnMs = 0;
    for (const interval of turnSplit.work) {
      agentTurnMs += interval.end - interval.start;
    }
    let hungTurnMs = 0;
    for (const interval of turnSplit.hung) {
      hungTurnMs += interval.end - interval.start;
    }

    const scriptValidationRuns = { started: 0, passed: 0, failed: 0 };
    for (const record of logs.validation) {
      if (record.event === "script_validation.started") {
        scriptValidationRuns.started += 1;
      } else if (record.event === "script_validation.passed") {
        scriptValidationRuns.passed += 1;
      } else if (record.event === "script_validation.failed") {
        scriptValidationRuns.failed += 1;
      }
    }

    const allRecords = [...logs.iterations, ...logs.tasks, ...logs.validation];
    const timestamps = allRecords
      .map((r) => parseIso(r.timestamp))
      .filter((t): t is number => t !== null);
    const firstActivity =
      timestamps.length > 0 ? Math.min(...timestamps) : null;
    const lastActivity = timestamps.length > 0 ? Math.max(...timestamps) : null;

    const approvalWaits = pairWaits(
      events,
      "graph-workflow-approval-pending",
      "graph-workflow-approval-resolved",
      "requestedAt",
      "decidedAt",
      "decision",
      contextId,
    );
    const userInputWaits = pairWaits(
      events,
      "graph-workflow-user-input-pending",
      "graph-workflow-user-input-resolved",
      "requestedAt",
      "resolvedAt",
      "resolution",
      contextId,
    );
    for (const wait of [...approvalWaits, ...userInputWaits]) {
      const start = parseIso(wait.requestedAt);
      const end = parseIso(wait.resolvedAt);
      if (start !== null && end !== null && end > start) {
        humanIntervals.push({ start, end });
      }
    }

    const laneStates = Object.values(execution.laneStates[contextId] ?? {});
    let peakContextTokens: number | null = null;
    let contextWindowMax: number | null = null;
    for (const iteration of iterations) {
      if (iteration.maxContextTokens !== null) {
        peakContextTokens = Math.max(
          peakContextTokens ?? 0,
          iteration.maxContextTokens,
        );
      }
    }
    for (const record of logs.iterations) {
      if (record.event !== "iteration.agent_turn_completed") continue;
      contextWindowMax ??= fieldNum(record.fields, "contextWindowMax");
    }
    for (const laneState of laneStates) {
      if (laneState.lastContextTokens !== null) {
        peakContextTokens = Math.max(
          peakContextTokens ?? 0,
          laneState.lastContextTokens,
        );
      }
      contextWindowMax ??= laneState.lastContextWindowMax;
    }
    const peakOccupancyPct =
      !laneStates.some((laneState) => laneState.engine === "codex") &&
      !logs.iterations.some(
        (record) =>
          fieldStr(record.fields, "engine") === "codex" ||
          fieldStr(record.fields, "backend") === "codex",
      ) &&
      peakContextTokens !== null &&
      contextWindowMax !== null &&
      contextWindowMax > 0
        ? Math.round((peakContextTokens / contextWindowMax) * 100)
        : null;

    const taskFailures: TaskFailureReport[] = [];
    for (const [taskKey, task] of Object.entries(execution.taskStates)) {
      if (task.contextId !== contextId) continue;
      const taskId = task.taskId ?? taskKey;
      for (const failure of task.failureHistory) {
        taskFailures.push({
          taskId,
          message: failure.message,
          timestamp: failure.timestamp,
        });
      }
      if (task.failureHistory.length === 0 && task.failureMessage !== null) {
        taskFailures.push({
          taskId,
          message: task.failureMessage,
          timestamp: "",
        });
      }
    }

    contexts.push({
      contextId,
      title: titles.get(contextId) ?? contextId,
      status: state.status,
      totalTaskCount: state.totalTaskCount,
      completedTaskCount: state.completedTaskCount,
      iterationCount: state.iterationCount,
      consecutiveFailureCount: state.consecutiveFailureCount,
      mergeStatus: state.mergeStatus,
      branchName: state.branchName,
      laneId: state.laneId,
      worktreePath: state.worktreePath,
      firstActivityAt:
        firstActivity !== null ? new Date(firstActivity).toISOString() : null,
      lastActivityAt:
        lastActivity !== null ? new Date(lastActivity).toISOString() : null,
      agentTurnMs,
      hungTurnMs,
      scriptValidationRuns,
      rotationScheduledCount: rotationScheduled.get(contextId) ?? 0,
      rotationAppliedCount: rotationApplied.get(contextId) ?? 0,
      iterations,
      validations: buildValidations(events, contextId),
      approvalWaits,
      userInputWaits,
      peakContextTokens,
      contextWindowMax,
      peakOccupancyPct,
      rotationLimitTokens: rotationLimits.get(contextId) ?? null,
      taskFailures,
      parseFallbacks: logs.validatorResponses.filter(
        (r) => r.parsePath !== "structured_output",
      ),
      conversations: conversationReports.filter(
        (c) => c.contextId === contextId,
      ),
    });
  }

  contexts.sort((a, b) => {
    const aFirst = parseIso(a.firstActivityAt) ?? Number.POSITIVE_INFINITY;
    const bFirst = parseIso(b.firstActivityAt) ?? Number.POSITIVE_INFINITY;
    if (aFirst !== bFirst) return aFirst - bFirst;
    const aOrder = definitionOrder.get(a.contextId) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = definitionOrder.get(b.contextId) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });

  // ---- cost rollup ------------------------------------------------------
  let totalUsd = 0;
  let missingCostCount = 0;
  let anyTranscriptCost = false;
  let correctedSum = 0;
  const costMismatches: Array<{
    conversationId: string;
    recordedUsd: number;
    transcriptUsd: number;
  }> = [];
  const byLane: Record<string, number> = {};
  const byContext: Record<string, number> = {};
  for (const conversation of conversationReports) {
    const cost = conversation.costUsd;
    if (cost === null) {
      missingCostCount += 1;
    } else {
      totalUsd += cost;
    }
    const transcriptCost = conversation.transcript?.costUsd ?? null;
    if (transcriptCost !== null) {
      anyTranscriptCost = true;
      correctedSum += transcriptCost;
      if (
        cost !== null &&
        Math.abs(cost - transcriptCost) >=
          Math.max(
            COST_MISMATCH_MIN_ABS_USD,
            transcriptCost * COST_MISMATCH_MIN_REL,
          )
      ) {
        costMismatches.push({
          conversationId: conversation.conversationId,
          recordedUsd: cost,
          transcriptUsd: transcriptCost,
        });
      }
    } else {
      correctedSum += cost ?? 0;
    }
    const lane = conversation.lane ?? "unattributed";
    byLane[lane] = (byLane[lane] ?? 0) + (cost ?? 0);
    if (conversation.contextId !== null) {
      byContext[conversation.contextId] =
        (byContext[conversation.contextId] ?? 0) + (cost ?? 0);
    }
  }
  const correctedTotalUsd = anyTranscriptCost ? correctedSum : null;

  // Validator spend that is invisible in conversation cost rows: response
  // artifacts (task-strategy runs have no conversation row at all) and
  // conversation artifacts whose CC conversation row recorded no cost.
  // Accepts both the legacy `engine`/`threadId` artifact shape and the
  // current `backend`/`kind` shape.
  const pricedConversationIds = new Set(
    conversations
      .filter((row) => row.totalCostUsd !== null && row.totalCostUsd > 0)
      .map((row) => row.id),
  );
  let validators: AuditReport["cost"]["validators"] = null;
  // Codex validator threads report thread-CUMULATIVE usage on every decision
  // (a resumed run's counters include all prior runs), so per-thread the true
  // spend is the latest cumulative, not the snapshot sum. A counter drop under
  // the same thread is a thread restart: bank the finished lineage's final and
  // track the new one — mirroring the transcript lineage rule above. Claude
  // task runs restart their cumulative per process, so their per-event usage
  // is already per-run and sums directly.
  interface ValidatorUsageSnapshot {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }
  const codexThreadFinalUsage = new Map<string, ValidatorUsageSnapshot>();
  const summedUsage: ValidatorUsageSnapshot[] = [];
  for (const event of events) {
    if (event.type !== "graph-workflow-validation-result") continue;
    const artifact = asRecord(event.fields.reviewArtifact);
    if (artifact === null) continue;
    const usage = asRecord(artifact.usage);
    if (usage === null) continue;
    if (artifact.kind === "conversation") {
      const ref = fieldStr(artifact, "ref");
      if (ref !== null && pricedConversationIds.has(ref)) continue;
    }
    validators ??= {
      estimatedUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      usageEventCount: 0,
      unpricedEventCount: 0,
    };
    validators.usageEventCount += 1;
    const snapshot: ValidatorUsageSnapshot = {
      inputTokens: fieldNum(usage, "inputTokens") ?? 0,
      cachedInputTokens: fieldNum(usage, "cachedInputTokens") ?? 0,
      outputTokens: fieldNum(usage, "outputTokens") ?? 0,
      costUsd: fieldNum(usage, "costUsd"),
    };
    if (snapshot.costUsd === null) {
      validators.unpricedEventCount += 1;
    }
    const backendName =
      fieldStr(artifact, "backend") ?? fieldStr(artifact, "engine");
    const threadRef =
      fieldStr(artifact, "ref") ?? fieldStr(artifact, "threadId");
    if (backendName === "codex" && threadRef !== null) {
      const previous = codexThreadFinalUsage.get(threadRef);
      const dropped =
        previous !== undefined &&
        (snapshot.inputTokens < previous.inputTokens ||
          (snapshot.costUsd !== null &&
            previous.costUsd !== null &&
            snapshot.costUsd < previous.costUsd));
      if (dropped && previous !== undefined) summedUsage.push(previous);
      codexThreadFinalUsage.set(threadRef, snapshot);
    } else {
      summedUsage.push(snapshot);
    }
  }
  if (validators !== null) {
    for (const usage of [...summedUsage, ...codexThreadFinalUsage.values()]) {
      validators.inputTokens += usage.inputTokens;
      validators.cachedInputTokens += usage.cachedInputTokens;
      validators.outputTokens += usage.outputTokens;
      if (usage.costUsd !== null) {
        validators.estimatedUsd += usage.costUsd;
      }
    }
  }

  // ---- final publish composition ----------------------------------------
  const finalPublish = input.finalPublish ?? null;
  const publish =
    finalPublish === null
      ? null
      : {
          commitSha: finalPublish.commitSha,
          fileCount: finalPublish.files.length,
          totalAdditions: finalPublish.files.reduce(
            (sum, f) => sum + f.additions,
            0,
          ),
          totalDeletions: finalPublish.files.reduce(
            (sum, f) => sum + f.deletions,
            0,
          ),
          scratchFiles: finalPublish.files
            .filter((f) => isScratchPath(f.path))
            .map((f) => ({ path: f.path, additions: f.additions })),
        };

  // ---- timing: wall clock, waits, gaps ---------------------------------
  const startedMs = parseIso(execution.startedAt);
  const completedMs = parseIso(execution.completedAt);
  const wallClockMs =
    startedMs !== null && completedMs !== null ? completedMs - startedMs : null;

  const humanWaitMsTotal = contexts.reduce(
    (sum, context) =>
      sum +
      [...context.approvalWaits, ...context.userInputWaits].reduce(
        (inner, wait) => inner + (wait.waitMs ?? 0),
        0,
      ),
    0,
  );
  const agentTurnMsTotal = contexts.reduce(
    (sum, context) => sum + context.agentTurnMs,
    0,
  );
  const hungTurnMsTotal = contexts.reduce(
    (sum, context) => sum + context.hungTurnMs,
    0,
  );
  const operatorRecoveryWaitMsTotal = haltRecoveries.reduce(
    (sum, recovery) => sum + (recovery.waitMs ?? 0),
    0,
  );
  const haltIntervals: Interval[] = [];
  for (const recovery of haltRecoveries) {
    const start = parseIso(recovery.haltedAt);
    // An unresolved halt idles the execution through the end of the data.
    const end = parseIso(recovery.resumedAt) ?? lastActivityMs;
    if (start !== null && end !== null && end > start) {
      haltIntervals.push({ start, end });
    }
  }

  // Join windows from lifecycle join.started → join.completed/failed pairs.
  // Serialized per-lane merges, pre-merge validation, and conflict sub-turns
  // all run inside these brackets with no per-context log records, so without
  // this class every join surfaced as an "unexplained" stall (audit 1beec403:
  // 52 minutes / 22% of wall clock).
  const joinIntervals: Interval[] = [];
  const openJoinStarts = new Map<string, number>();
  for (const record of lifecycle) {
    const at = parseIso(record.timestamp);
    if (at === null) continue;
    const joinId = fieldStr(record.fields, "joinId") ?? "unknown";
    if (record.event === "join.started") {
      openJoinStarts.set(joinId, at);
    } else if (
      record.event === "join.completed" ||
      record.event === "join.failed"
    ) {
      const start = openJoinStarts.get(joinId);
      openJoinStarts.delete(joinId);
      if (start !== undefined && at > start) {
        joinIntervals.push({ start, end: at });
      }
    }
  }
  // A join still open at the end of the data idles the execution like an
  // unresolved halt does.
  for (const start of openJoinStarts.values()) {
    if (lastActivityMs !== null && lastActivityMs > start) {
      joinIntervals.push({ start, end: lastActivityMs });
    }
  }

  const points: TimelinePoint[] = [];
  if (startedMs !== null)
    points.push({ at: startedMs, label: "execution.started" });
  if (completedMs !== null) {
    points.push({ at: completedMs, label: "execution.completed" });
  }
  for (const event of events) {
    const at = parseIso(event.occurredAt);
    if (at !== null) points.push({ at, label: event.type });
  }
  for (const logs of Object.values(contextLogs)) {
    for (const record of [
      ...logs.iterations,
      ...logs.tasks,
      ...logs.validation,
    ]) {
      const at = parseIso(record.timestamp);
      if (at !== null) points.push({ at, label: record.event });
    }
  }
  points.sort((a, b) => a.at - b.at);

  const mergedWork = mergeIntervals(workIntervals);
  const mergedHuman = mergeIntervals(humanIntervals);
  const mergedHalt = mergeIntervals(haltIntervals);
  const mergedHung = mergeIntervals(hungIntervals);
  const mergedValidationCompute = mergeIntervals(validationComputeIntervals);
  const mergedJoinCompute = mergeIntervals(joinIntervals);
  const gaps: GapReport[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (from === undefined || to === undefined) continue;
    const gapMs = to.at - from.at;
    if (gapMs <= GAP_THRESHOLD_MS) continue;
    const gap: Interval = { start: from.at, end: to.at };
    // Precedence: a halted execution does nothing regardless of what else
    // was nominally open, and a hung turn must not read as agent work.
    let classification: GapClassification;
    if (overlapMs(gap, mergedHalt) / gapMs > 0.5) {
      classification = "halt_wait";
    } else if (overlapMs(gap, mergedHuman) / gapMs > 0.5) {
      classification = "human_wait";
    } else if (overlapMs(gap, mergedHung) / gapMs > 0.5) {
      classification = "hung_turn";
    } else if (overlapMs(gap, mergedValidationCompute) / gapMs > 0.5) {
      classification = "validation_compute";
    } else if (overlapMs(gap, mergedJoinCompute) / gapMs > 0.5) {
      classification = "join_compute";
    } else if (overlapMs(gap, mergedWork) / gapMs > 0.5) {
      classification = "agent_work";
    } else {
      classification = "unexplained";
    }
    gaps.push({
      startedAt: new Date(from.at).toISOString(),
      endedAt: new Date(to.at).toISOString(),
      gapMs,
      classification,
      fromEvent: from.label,
      toEvent: to.label,
    });
  }
  gaps.sort((a, b) => b.gapMs - a.gapMs);
  const reportedGaps = gaps.slice(0, MAX_GAPS_REPORTED);

  // ---- friction ----------------------------------------------------------
  const friction: Finding[] = [];

  const haltFindings: Array<{ reason: AuditHaltReason; pending: boolean }> = [];
  if (execution.haltReason !== null) {
    haltFindings.push({ reason: execution.haltReason, pending: false });
  }
  for (const reason of execution.secondaryHaltReasons) {
    haltFindings.push({ reason, pending: false });
  }
  if (execution.pendingHaltReason !== null) {
    haltFindings.push({ reason: execution.pendingHaltReason, pending: true });
  }
  for (const { reason, pending } of haltFindings) {
    const haltClass = classifyHaltReason(reason.type);
    const detail = reason.message ?? reason.summary ?? "";
    friction.push({
      kind: "halt",
      severity: pending ? "medium" : "high",
      contextId: reason.contextId,
      summary: `${pending ? "pending halt" : "halted"}: ${reason.type} (${haltClass} failure)${detail.length > 0 ? ` — ${detail}` : ""}`,
    });
  }

  // Recovered halts vanish from the execution state (the halt reason is
  // cleared on resume), so without these findings a run with hours of
  // mid-flight recovery reads as if it never halted at all.
  for (const recovery of haltRecoveries) {
    if (recovery.resumedAt === null) continue;
    friction.push({
      kind: "recovered_halt",
      severity: "medium",
      contextId: recovery.contextId,
      summary: `halted (${recovery.haltType}) at ${recovery.haltedAt}, resumed after ${formatMaybeMs(recovery.waitMs)} of operator recovery wait`,
    });
  }

  for (const [contextId, hungTurns] of hungTurnsByContext) {
    for (const turn of hungTurns) {
      friction.push({
        kind: "hung_turn",
        severity: "high",
        contextId,
        summary: `turn started ${turn.startedAt} produced no recorded activity for ${formatMs(turn.durationMs)} — likely hung/silent; excluded from agent-work time`,
      });
    }
  }

  for (const [joinId, retries] of joinRetryCounts) {
    friction.push({
      kind: "join_retry",
      severity: "medium",
      contextId: null,
      summary: `join "${joinId}" needed ${retries} retry attempt(s) before its final state — see lifecycle.jsonl for the attempt history`,
    });
  }

  for (const event of events) {
    if (event.type !== "graph-workflow-circuit-breaker") continue;
    friction.push({
      kind: "circuit_breaker",
      severity: "high",
      contextId: fieldStr(event.fields, "contextId"),
      summary: `circuit breaker event at ${event.occurredAt}`,
    });
  }

  for (const context of contexts) {
    const noGos = context.validations.filter((v) => !v.pass);
    if (noGos.length > 0) {
      const first = noGos[0];
      friction.push({
        kind: "validation_no_go",
        severity: noGos.length > 1 ? "high" : "medium",
        contextId: context.contextId,
        summary: `${noGos.length} NO-GO validation verdict(s); first: ${first?.summary ?? ""}`,
      });
    }
    for (const failure of context.taskFailures) {
      friction.push({
        kind: "task_failure",
        severity: "medium",
        contextId: context.contextId,
        summary: `task "${failure.taskId}": ${failure.message}`,
      });
    }
    if (
      context.peakOccupancyPct !== null &&
      context.peakOccupancyPct >= WINDOW_PRESSURE_PCT
    ) {
      friction.push({
        kind: "context_window_pressure",
        severity: "high",
        contextId: context.contextId,
        summary: `peak context occupancy ${context.peakOccupancyPct}% (${context.peakContextTokens ?? 0} of ${context.contextWindowMax ?? 0} tokens) — output quality degrades near the window limit`,
      });
    }
    if (context.parseFallbacks.length > 0) {
      friction.push({
        kind: "parse_fallback",
        severity: "medium",
        contextId: context.contextId,
        summary: `${context.parseFallbacks.length} validator response(s) parsed via fallback (${context.parseFallbacks
          .map((f) => f.parsePath ?? "unreadable")
          .join(", ")}) — structured output failed`,
      });
    }
    const seedLengths = context.iterations
      .map((i) => i.seedPromptLength)
      .filter((l): l is number => l !== null);
    const firstSeed = seedLengths[0];
    const lastSeed = seedLengths[seedLengths.length - 1];
    if (
      firstSeed !== undefined &&
      lastSeed !== undefined &&
      lastSeed >= firstSeed * PROMPT_GROWTH_FACTOR &&
      lastSeed - firstSeed >= PROMPT_GROWTH_MIN_DELTA
    ) {
      friction.push({
        kind: "prompt_growth",
        severity: "medium",
        contextId: context.contextId,
        summary: `seed prompt grew ${firstSeed} → ${lastSeed} chars across iterations — feedback is accumulating instead of being resolved`,
      });
    }
    for (const wait of [...context.approvalWaits, ...context.userInputWaits]) {
      if (wait.waitMs !== null && wait.waitMs >= LONG_HUMAN_WAIT_MS) {
        friction.push({
          kind: "human_wait",
          severity: "info",
          contextId: context.contextId,
          summary: `workflow blocked ${formatMs(wait.waitMs)} waiting for the human (requested ${wait.requestedAt})`,
        });
      } else if (wait.resolvedAt === null) {
        friction.push({
          kind: "human_wait",
          severity: "info",
          contextId: context.contextId,
          summary: `human gate requested ${wait.requestedAt} was never resolved`,
        });
      }
    }
    if (
      context.mergeStatus === "conflicts" ||
      context.mergeStatus === "merged-failed"
    ) {
      friction.push({
        kind: "merge_conflict",
        severity: "high",
        contextId: context.contextId,
        summary: `merge status "${context.mergeStatus}"`,
      });
    }
    // Occupancy arithmetic is only valid when the backend reported a real
    // context window: codex lanes carry a CUMULATIVE processed-token counter
    // with no window max, and dividing a cumulative counter by the rotation
    // limit produces arithmetically invalid "overruns".
    if (
      context.rotationLimitTokens !== null &&
      context.peakOccupancyPct !== null
    ) {
      let worst: IterationReport | null = null;
      for (const iteration of context.iterations) {
        if (iteration.maxContextTokens === null) continue;
        if (
          iteration.maxContextTokens >=
            context.rotationLimitTokens * ROTATION_OVERRUN_FACTOR &&
          iteration.maxContextTokens > (worst?.maxContextTokens ?? 0)
        ) {
          worst = iteration;
        }
      }
      if (worst !== null && worst.maxContextTokens !== null) {
        const ratio = worst.maxContextTokens / context.rotationLimitTokens;
        friction.push({
          kind: "rotation_overrun",
          severity: "high",
          contextId: context.contextId,
          summary: `iteration ${worst.iterationNumber} peaked at ${worst.maxContextTokens} tokens — ${ratio.toFixed(1)}× the configured rotation limit (${context.rotationLimitTokens}); rotation only takes effect at the iteration boundary, so a long turn outruns it and risks a hard mid-task stop`,
        });
      }
    }
    if (context.rotationScheduledCount > context.rotationAppliedCount) {
      friction.push({
        kind: "rotation_not_applied",
        severity: "medium",
        contextId: context.contextId,
        summary: `${context.rotationScheduledCount} rotation(s) scheduled but only ${context.rotationAppliedCount} applied — the lane kept its conversation past the point the engine decided to rotate it`,
      });
    }
    let contextKills = 0;
    let contextCompactions = 0;
    let scannedConversations = 0;
    for (const conversation of context.conversations) {
      if (conversation.transcript === null) continue;
      scannedConversations += 1;
      contextKills += conversation.transcript.backgroundTasksKilled;
      contextCompactions += conversation.transcript.compactions;
    }
    if (contextKills >= BACKGROUND_KILL_THRESHOLD) {
      friction.push({
        kind: "background_task_kills",
        severity: "medium",
        contextId: context.contextId,
        summary: `${contextKills} armed background task(s) killed at turn boundaries across ${scannedConversations} conversation(s) — orphaned watchers/dev servers force cold re-setup; check the transcript(s) for redone work`,
      });
    }
    if (contextCompactions > 0) {
      friction.push({
        kind: "compaction_events",
        severity: "medium",
        contextId: context.contextId,
        summary: `${contextCompactions} compaction event(s) — the conversation was silently summarized mid-flight; verify nothing load-bearing was dropped`,
      });
    }
  }

  if (costMismatches.length > 0) {
    const worst = [...costMismatches].sort(
      (a, b) =>
        Math.abs(b.recordedUsd - b.transcriptUsd) -
        Math.abs(a.recordedUsd - a.transcriptUsd),
    );
    const shown = worst
      .slice(0, COST_MISMATCH_RENDER_CAP)
      .map(
        (m) =>
          `\`${m.conversationId}\` ${formatUsd(m.recordedUsd)} recorded vs ${formatUsd(m.transcriptUsd)} from the transcript`,
      )
      .join("; ");
    friction.push({
      kind: "cost_mismatch",
      severity: "medium",
      contextId: null,
      summary: `${costMismatches.length} conversation(s) whose recorded cost diverges from the transcript's lineage total (rows written before the accrual fix are inflated): ${shown}${worst.length > COST_MISMATCH_RENDER_CAP ? ` — and ${worst.length - COST_MISMATCH_RENDER_CAP} more` : ""}. Prefer the corrected total.`,
    });
  }

  // A zero/absent cost row on a conversation that clearly did work is a
  // telemetry hole, not a free conversation — the total is a floor.
  const costGapConversations: ConversationReport[] = [];
  for (const conversation of conversationReports) {
    const recorded = conversation.costUsd;
    if (recorded !== null && recorded > 0) continue;
    // A transcript-derived cost exists: the corrected total already fixes it.
    if (conversation.transcript?.costUsd != null) continue;
    const toolCalls = conversation.transcript?.toolUseCount ?? 0;
    const turns = Math.max(
      conversation.turns ?? 0,
      conversation.transcript?.apiTurns ?? 0,
    );
    if (toolCalls < COST_GAP_MIN_TOOL_CALLS && turns < COST_GAP_MIN_TURNS) {
      continue;
    }
    costGapConversations.push(conversation);
    friction.push({
      kind: "cost_gap",
      severity: "medium",
      contextId: conversation.contextId,
      summary: `conversation \`${conversation.conversationId}\` recorded ${recorded === null ? "no cost" : formatUsd(recorded)} despite ${toolCalls > 0 ? `${toolCalls} tool call(s)` : `${turns} sdk turn(s)`} — its spend is missing from the total`,
    });
  }

  if (publish !== null && publish.scratchFiles.length > 0) {
    const scratchAdditions = publish.scratchFiles.reduce(
      (sum, f) => sum + f.additions,
      0,
    );
    const shown = publish.scratchFiles
      .slice(0, SCRATCH_FILES_RENDER_CAP)
      .map((f) => f.path)
      .join(", ");
    friction.push({
      kind: "scratch_debris",
      severity: "medium",
      contextId: null,
      summary: `final publish commit ${publish.commitSha.slice(0, 8)} carried ${publish.scratchFiles.length} scratch file(s) (+${scratchAdditions} lines) into the session branch: ${shown}${publish.scratchFiles.length > SCRATCH_FILES_RENDER_CAP ? `, and ${publish.scratchFiles.length - SCRATCH_FILES_RENDER_CAP} more` : ""}`,
    });
  }

  for (const [joinId, join] of Object.entries(execution.joins)) {
    if (
      join.status === "failed" ||
      join.status === "conflicts" ||
      join.conflicts !== null
    ) {
      friction.push({
        kind: "merge_conflict",
        severity: "high",
        contextId: join.contextId,
        summary: `join "${joinId}" (${join.kind}) status "${join.status}"${join.errorMessage !== null ? ` — ${join.errorMessage}` : ""}`,
      });
    }
  }

  for (const gap of reportedGaps) {
    if (gap.classification !== "unexplained") continue;
    friction.push({
      kind: "stall_gap",
      severity: gap.gapMs >= LONG_STALL_MS ? "high" : "medium",
      contextId: null,
      summary: `no recorded activity for ${formatMs(gap.gapMs)} between ${gap.startedAt} (${gap.fromEvent}) and ${gap.endedAt} (${gap.toEvent})`,
    });
  }

  const severityRank: Record<Severity, number> = {
    high: 0,
    medium: 1,
    info: 2,
  };
  friction.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  // ---- positives ---------------------------------------------------------
  const positives: Finding[] = [];
  if (
    execution.status === "completed" &&
    execution.haltReason === null &&
    execution.secondaryHaltReasons.length === 0 &&
    execution.pendingHaltReason === null &&
    haltRecoveries.length === 0
  ) {
    positives.push({
      kind: "completed_clean",
      severity: "info",
      contextId: null,
      summary: "execution ran to completion with no halts",
    });
  }
  const firstTryContexts = contexts.filter(
    (context) =>
      context.status === "completed" &&
      context.iterationCount <= 1 &&
      context.validations.every((v) => v.pass),
  );
  if (firstTryContexts.length > 0) {
    positives.push({
      kind: "first_try_go",
      severity: "info",
      contextId: null,
      summary: `${firstTryContexts.length} of ${contexts.length} contexts passed first try: ${firstTryContexts
        .map((c) => c.contextId)
        .join(", ")}`,
    });
  }
  const joinEntries = Object.values(execution.joins);
  const anyMergeTrouble =
    joinEntries.some(
      (join) =>
        join.status === "failed" ||
        join.status === "conflicts" ||
        join.conflicts !== null,
    ) ||
    contexts.some(
      (context) =>
        context.mergeStatus === "conflicts" ||
        context.mergeStatus === "merged-failed",
    ) ||
    // Final join states hide the attempt history: a join that failed, halted
    // the run, and succeeded on retry is not a clean merge.
    joinRetryCounts.size > 0 ||
    haltRecoveries.some((recovery) =>
      MERGE_CLASS_HALT_TYPES.has(recovery.haltType),
    );
  const joinsWithAutoResolved = Object.entries(execution.joins).filter(
    ([, join]) => join.resolvedConflicts.length > 0,
  );
  if (joinsWithAutoResolved.length > 0) {
    const detail = joinsWithAutoResolved
      .map(([joinId, join]) =>
        join.resolvedConflicts
          .map(
            (conflict) =>
              `${joinId}: ${conflict.files.join(", ") || "(files unrecorded)"} (${conflict.resolution})`,
          )
          .join("; "),
      )
      .join("; ");
    positives.push({
      kind: "conflicts_auto_resolved",
      severity: "info",
      contextId: null,
      summary: `${joinsWithAutoResolved.length} join(s) had conflicts the merge machinery auto-resolved — ${detail}`,
    });
  }
  if (
    joinEntries.length > 0 &&
    !anyMergeTrouble &&
    joinsWithAutoResolved.length === 0
  ) {
    positives.push({
      kind: "clean_merges",
      severity: "info",
      contextId: null,
      summary: `all ${joinEntries.length} join(s) merged without conflicts`,
    });
  }
  const occupancies = contexts
    .map((c) => c.peakOccupancyPct)
    .filter((p): p is number => p !== null);
  if (occupancies.length > 0 && occupancies.every((p) => p < 50)) {
    positives.push({
      kind: "low_context_pressure",
      severity: "info",
      contextId: null,
      summary: "no context exceeded 50% window occupancy",
    });
  }
  // The engine auto-registers the charter as a shared document at launch, so
  // only documents beyond it are evidence agents actually used the mechanism.
  const nonCharterDocumentCount = execution.sharedDocuments.filter((raw) => {
    const doc = asRecord(raw);
    if (doc === null) return true;
    const kind = typeof doc.kind === "string" ? doc.kind : null;
    const id = typeof doc.id === "string" ? doc.id : "";
    return kind !== "charter" && !id.startsWith("doc-charter-");
  }).length;
  if (nonCharterDocumentCount > 0) {
    positives.push({
      kind: "shared_documents_used",
      severity: "info",
      contextId: null,
      summary: `${nonCharterDocumentCount} shared document(s) registered beyond the charter for cross-context alignment`,
    });
  }
  const resolvedWaits = contexts.flatMap((context) =>
    [...context.approvalWaits, ...context.userInputWaits].filter(
      (w) => w.waitMs !== null,
    ),
  );
  if (
    resolvedWaits.length > 0 &&
    resolvedWaits.every((w) => (w.waitMs ?? 0) < LONG_HUMAN_WAIT_MS)
  ) {
    positives.push({
      kind: "fast_human_turnaround",
      severity: "info",
      contextId: null,
      summary: `all ${resolvedWaits.length} human gate(s) resolved in under 10 minutes`,
    });
  }

  // ---- telemetry confidence ---------------------------------------------
  const confidence: ConfidenceNote[] = [];
  const occupancyUnmeasurable = contexts.filter(
    (context) =>
      context.peakContextTokens !== null && context.peakOccupancyPct === null,
  );
  if (occupancyUnmeasurable.length > 0) {
    confidence.push({
      kind: "occupancy_unmeasurable",
      summary: `context window occupancy is unmeasurable for ${occupancyUnmeasurable
        .map((c) => c.contextId)
        .join(
          ", ",
        )}: token counters lack a comparable occupancy measurement (Codex reports cumulative processed tokens, even when a window capacity is known) — treat occupancy and rotation-overrun conclusions for these contexts as inconclusive`,
    });
  }
  const validatorUnpriced = validators?.unpricedEventCount ?? 0;
  if (validatorUnpriced > 0) {
    confidence.push({
      kind: "unpriced_validators",
      summary: `${validatorUnpriced} of ${validators?.usageEventCount ?? 0} validator decision(s) recorded tokens but no cost — validator spend is a floor`,
    });
  }
  if (missingCostCount > 0) {
    confidence.push({
      kind: "missing_conversation_costs",
      summary: `${missingCostCount} conversation(s) have no recorded cost — the cost total is a floor`,
    });
  }
  if (costGapConversations.length > 0) {
    confidence.push({
      kind: "cost_gaps",
      summary: `${costGapConversations.length} active conversation(s) recorded zero/absent cost — the cost total is a floor`,
    });
  }
  const unscannedCount = conversationReports.filter(
    (conversation) => conversation.transcript === null,
  ).length;
  if (unscannedCount > 0) {
    confidence.push({
      kind: "transcripts_unscanned",
      summary: `${unscannedCount} of ${conversationReports.length} conversation transcript(s) could not be scanned — transcript-derived checks (cost correction, tool stats, compactions) skipped for them`,
    });
  }
  if (hungTurnMsTotal > 0) {
    confidence.push({
      kind: "hung_turns_excluded",
      summary: `${formatMs(hungTurnMsTotal)} of hung-turn time was excluded from the agent-work total — aggregate turn time is not comparable to reports produced before this exclusion`,
    });
  }

  const contextStatesList = Object.values(execution.contextStates);
  return {
    overview: {
      executionId: execution.id,
      seedDefinitionId: execution.seedDefinitionId,
      seedDefinitionRevision: execution.seedDefinitionRevision,
      launchedTier: execution.launchedTier,
      boundInputs: execution.boundInputs,
      status: execution.status,
      source: input.source,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      wallClockMs,
      contextsTotal: contextStatesList.length,
      contextsCompleted: contextStatesList.filter(
        (state) => state.status === "completed",
      ).length,
      haltReason: execution.haltReason,
      pendingHaltReason: execution.pendingHaltReason,
      secondaryHaltReasons: execution.secondaryHaltReasons,
      charterPresent:
        execution.charter !== undefined && execution.charter !== null,
      sharedDocumentCount: nonCharterDocumentCount,
    },
    contexts,
    cost: {
      totalUsd,
      correctedTotalUsd,
      byLane,
      byContext,
      knownConversationCount: conversations.length,
      missingCostCount,
      validators,
    },
    time: {
      wallClockMs,
      agentTurnMsTotal,
      hungTurnMsTotal,
      humanWaitMsTotal,
      operatorRecoveryWaitMsTotal,
      haltRecoveries,
      gaps: reportedGaps,
    },
    publish,
    friction,
    positives,
    confidence,
    pointers: {
      workflowLogsDir: input.paths.workflowLogsDir,
      transcripts: conversationReports.map((c) => ({
        conversationId: c.conversationId,
        transcriptPath: c.transcriptPath,
        lane: c.lane,
        contextId: c.contextId,
      })),
    },
  };
}

// ============================================================
// Markdown rendering (bounded)
// ============================================================

const ISSUES_RENDER_CAP = 3;

export function formatMs(msValue: number): string {
  const totalSeconds = Math.round(msValue / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function formatMaybeMs(value: number | null): string {
  return value === null ? "—" : formatMs(value);
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const o = report.overview;
  lines.push(`# Graph workflow audit — ${o.executionId}`);
  lines.push("");
  lines.push(
    `- Status: **${o.status}** (source: ${o.source}) · definition ${o.seedDefinitionId} rev ${o.seedDefinitionRevision} · tier ${o.launchedTier}`,
  );
  lines.push(
    `- Ran ${o.startedAt} → ${o.completedAt ?? "(not completed)"} · wall clock ${formatMaybeMs(o.wallClockMs)}`,
  );
  lines.push(
    `- Contexts: ${o.contextsCompleted}/${o.contextsTotal} completed · charter: ${o.charterPresent ? "present" : "absent"} · shared documents: ${o.sharedDocumentCount}`,
  );
  if (Object.keys(o.boundInputs).length > 0) {
    lines.push(
      `- Bound inputs: ${Object.entries(o.boundInputs)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  if (o.haltReason !== null) {
    lines.push(`- Halt reason: \`${o.haltReason.type}\``);
  }
  if (report.publish !== null) {
    const p = report.publish;
    lines.push(
      `- Final publish: \`${p.commitSha.slice(0, 8)}\` · ${p.fileCount} file(s) (+${p.totalAdditions}/−${p.totalDeletions})` +
        (p.scratchFiles.length > 0
          ? ` · ⚠ ${p.scratchFiles.length} scratch file(s)`
          : ""),
    );
  }
  lines.push("");

  lines.push("## Friction");
  lines.push("");
  if (report.friction.length === 0) {
    lines.push("None detected by the extractor.");
  }
  for (const finding of report.friction) {
    const scope = finding.contextId !== null ? ` [${finding.contextId}]` : "";
    lines.push(
      `- **${finding.severity}** ${finding.kind}${scope}: ${finding.summary}`,
    );
  }
  lines.push("");

  lines.push("## What worked");
  lines.push("");
  if (report.positives.length === 0) {
    lines.push("Nothing notable detected.");
  }
  for (const positive of report.positives) {
    lines.push(`- ${positive.kind}: ${positive.summary}`);
  }
  lines.push("");

  lines.push("## Cost");
  lines.push("");
  lines.push(
    `Total recorded cost: **${formatUsd(report.cost.totalUsd)}** across ${report.cost.knownConversationCount} conversation(s)` +
      (report.cost.missingCostCount > 0
        ? ` (${report.cost.missingCostCount} with no recorded cost)`
        : ""),
  );
  if (
    report.cost.correctedTotalUsd !== null &&
    Math.abs(report.cost.correctedTotalUsd - report.cost.totalUsd) > 0.01
  ) {
    lines.push(
      `- transcript-corrected total: **${formatUsd(report.cost.correctedTotalUsd)}** (recorded rows written before the accrual fix are inflated — prefer this figure)`,
    );
  }
  for (const [lane, cost] of Object.entries(report.cost.byLane)) {
    lines.push(`- by lane · ${lane}: ${formatUsd(cost)}`);
  }
  for (const [contextId, cost] of Object.entries(report.cost.byContext)) {
    lines.push(`- by context · ${contextId}: ${formatUsd(cost)}`);
  }
  if (report.cost.validators !== null) {
    const v = report.cost.validators;
    lines.push(
      `- context validators (not in the total above): est. ${formatUsd(v.estimatedUsd)} · ` +
        `${formatTokens(v.inputTokens)} in (${formatTokens(v.cachedInputTokens)} cached) / ${formatTokens(v.outputTokens)} out` +
        (v.unpricedEventCount > 0
          ? ` — ${v.unpricedEventCount}/${v.usageEventCount} validation(s) recorded tokens only, so the estimate undercounts`
          : ""),
    );
  }
  lines.push("");

  lines.push("## Time");
  lines.push("");
  lines.push(
    `Wall clock ${formatMaybeMs(report.time.wallClockMs)} · agent turns ${formatMs(report.time.agentTurnMsTotal)}` +
      (report.time.hungTurnMsTotal > 0
        ? ` · hung turns ${formatMs(report.time.hungTurnMsTotal)} (excluded from agent turns)`
        : "") +
      ` · human waits ${formatMs(report.time.humanWaitMsTotal)}` +
      (report.time.haltRecoveries.length > 0
        ? ` · operator recovery ${formatMs(report.time.operatorRecoveryWaitMsTotal)}`
        : ""),
  );
  if (report.time.haltRecoveries.length > 0) {
    lines.push("");
    lines.push("Halt recoveries (operator wait between halt and resume):");
    lines.push("");
    lines.push("| halted | type | context | resumed | wait |");
    lines.push("|---|---|---|---|---|");
    for (const recovery of report.time.haltRecoveries) {
      lines.push(
        `| ${recovery.haltedAt} | ${recovery.haltType} | ${recovery.contextId ?? "—"} | ${recovery.resumedAt ?? "not resumed"} | ${formatMaybeMs(recovery.waitMs)} |`,
      );
    }
  }
  if (report.time.gaps.length > 0) {
    lines.push("");
    lines.push("Largest gaps between recorded activity:");
    lines.push("");
    lines.push("| start | duration | classification | from → to |");
    lines.push("|---|---|---|---|");
    for (const gap of report.time.gaps) {
      lines.push(
        `| ${gap.startedAt} | ${formatMs(gap.gapMs)} | ${gap.classification} | ${gap.fromEvent} → ${gap.toEvent} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Contexts");
  for (const context of report.contexts) {
    lines.push("");
    lines.push(`### ${context.title} (\`${context.contextId}\`)`);
    lines.push("");
    lines.push(
      `- ${context.status} · tasks ${context.completedTaskCount}/${context.totalTaskCount} · iterations ${context.iterationCount} · merge ${context.mergeStatus}`,
    );
    if (context.peakContextTokens !== null) {
      lines.push(
        `- Peak token counter: ${context.peakContextTokens} tokens${context.peakOccupancyPct !== null ? ` (${context.peakOccupancyPct}% of window)` : " (occupancy unknown)"}${context.rotationLimitTokens !== null ? ` · configured occupancy limit ${context.rotationLimitTokens}` : ""}`,
      );
    }
    if (context.iterations.length > 0) {
      lines.push("");
      lines.push(
        "| iter | started | duration | prompt cycles | seed prompt | peak tokens | model |",
      );
      lines.push("|---|---|---|---|---|---|---|");
      for (const iteration of context.iterations) {
        lines.push(
          `| ${iteration.iterationNumber} | ${iteration.startedAt} | ${formatMaybeMs(iteration.durationMs)} | ${iteration.agentTurns} | ${iteration.seedPromptLength ?? "—"} | ${iteration.maxContextTokens ?? "—"} | ${iteration.model ?? "—"} |`,
        );
      }
    }
    for (const validation of context.validations) {
      lines.push("");
      lines.push(
        `- ${validation.pass ? "GO" : "NO-GO"} at ${validation.occurredAt}: ${validation.summary}`,
      );
      const shown = validation.issues.slice(0, ISSUES_RENDER_CAP);
      for (const issue of shown) {
        lines.push(
          `  - ${issue.title}${issue.description.length > 0 ? ` — ${issue.description}` : ""}`,
        );
      }
      if (validation.issues.length > shown.length) {
        lines.push(`  - …and ${validation.issues.length - shown.length} more`);
      }
    }
    for (const wait of context.approvalWaits) {
      lines.push(
        `- Approval gate: requested ${wait.requestedAt}, ${wait.resolvedAt !== null ? `${wait.decision ?? "resolved"} after ${formatMaybeMs(wait.waitMs)}` : "unresolved"}`,
      );
    }
    for (const wait of context.userInputWaits) {
      lines.push(
        `- User question: requested ${wait.requestedAt}, ${wait.resolvedAt !== null ? `${wait.decision ?? "resolved"} after ${formatMaybeMs(wait.waitMs)}` : "unresolved"}`,
      );
    }
    for (const failure of context.taskFailures) {
      lines.push(`- Task failure \`${failure.taskId}\`: ${failure.message}`);
    }
    for (const conversation of context.conversations) {
      const scan = conversation.transcript;
      let costPart =
        conversation.costUsd !== null
          ? formatUsd(conversation.costUsd)
          : "cost unknown";
      if (
        scan?.costUsd != null &&
        conversation.costUsd !== null &&
        Math.abs(conversation.costUsd - scan.costUsd) > 0.01
      ) {
        costPart = `${formatUsd(conversation.costUsd)} recorded → ${formatUsd(scan.costUsd)} transcript-corrected`;
      }
      const parts = [`${costPart}, ${conversation.turns ?? "?"} sdk turns`];
      if (scan !== null) {
        parts.push(
          `${scan.toolUseCount} tool call(s)${scan.toolErrorCount > 0 ? ` (${scan.toolErrorCount} errored)` : ""}`,
        );
        if (scan.backgroundTasksKilled > 0) {
          parts.push(`${scan.backgroundTasksKilled} bg task(s) killed`);
        }
        if (scan.compactions > 0) {
          parts.push(`${scan.compactions} compaction(s)`);
        }
        const topReRead = scan.topReReads[0];
        if (topReRead !== undefined && topReRead.count >= 3) {
          const shortPath = topReRead.path.split("/").slice(-1)[0] ?? "";
          parts.push(`top re-read ${shortPath} ×${topReRead.count}`);
        }
      }
      lines.push(
        `- Conversation \`${conversation.conversationId}\`${conversation.lane !== null ? ` (${conversation.lane})` : ""}: ${parts.join(" · ")}`,
      );
    }
  }
  lines.push("");

  if (report.confidence.length > 0) {
    lines.push("## Telemetry confidence");
    lines.push("");
    lines.push(
      "Known measurement limits of this report — treat the figures involved as floors or inconclusive:",
    );
    lines.push("");
    for (const note of report.confidence) {
      lines.push(`- ${note.kind}: ${note.summary}`);
    }
    lines.push("");
  }

  lines.push("## Where to dig deeper");
  lines.push("");
  if (report.pointers.workflowLogsDir !== null) {
    lines.push(`- Execution logs: \`${report.pointers.workflowLogsDir}\``);
    lines.push(
      `  - per-context: \`contexts/<id>/{iterations,tasks,validation}.jsonl\`, implementer prompts under \`contexts/<id>/prompts/\`, and each validator assignment's prompt, response, and transcript under \`contexts/<id>/validators/<assignmentId>/\``,
    );
  }
  for (const transcript of report.pointers.transcripts) {
    lines.push(
      `- Transcript \`${transcript.conversationId}\`${transcript.lane !== null ? ` (${transcript.lane})` : ""}: ${transcript.transcriptPath !== null ? `\`${transcript.transcriptPath}\`` : "path unknown"}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
