import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { readConfig } from "@/lib/config/loader";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowLiveEditRequest } from "@/lib/workflows/edit-schemas";
import { workflowLiveEditRequestSchema } from "@/lib/workflows/edit-schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type PublishCharterUpdatedInput,
  type PublishLiveEditAppliedInput,
} from "./execution-events";
import { CHARTER_DOCUMENT_PATH, renderCharterMarkdown } from "./charter/render";
import {
  createGraphWorkflowExecutionRepository,
  type MutateActiveResult,
} from "./execution-repository";
import { formatDefinitionEditIssue } from "./definition-edits";
import { classifyExecutionEditability } from "./lifecycle-classifier";
import {
  coerceGlobalDefaults,
  resolveCollaborationConfigWithProvenance,
  resolveContext,
} from "./resolve-config";
import {
  applyLiveExecutionEdits,
  type LiveEditDeps,
  type LiveEditRejectionCode,
  type ResolvedContextConfig,
} from "./runtime-edits";
import { createRegisteredGraphExecutionContract } from "./execution-contract-port";

const logger = createLogger("workflow.live-edit");

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const eventPublisher = createGraphWorkflowExecutionEventPublisher();
const executionRepository = createGraphWorkflowExecutionRepository({
  getSession: defaultGetSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  eventPublisher,
});

/**
 * Resolve the concrete config a new `add-context` op seeds from when no
 * `configFromContextId` is given and the deferred script-validator prerequisite,
 * both computed once per request (the pure core's deps are sync). Resolves the
 * global defaults through the same cascade a launch uses, against a synthetic
 * no-override context, so a live-added context matches what a seeded one carries.
 */
async function defaultBuildLiveEditDeps(
  projectPath: string,
): Promise<LiveEditDeps> {
  const repoConfig = await readRepoConfig(projectPath);
  const hasPreMergeCommand = Boolean(repoConfig?.preMergeCommand);

  const global = await readConfig();
  const defaults = coerceGlobalDefaults(global.workflowDefaults);
  const syntheticContext: GraphWorkflowExecutionContextDefinition = {
    id: "__live_edit_global_defaults__",
    title: "Live edit defaults",
    acceptanceCriteria: "Live edit defaults",
  };
  const resolved = resolveContext(defaults, {}, syntheticContext);
  const collaboration = resolveCollaborationConfigWithProvenance(
    defaults,
    {},
    syntheticContext,
  );
  const resolvedGlobalDefaults: ResolvedContextConfig = {
    implementer: resolved.implementer,
    contextValidator: resolved.contextValidator,
    scriptValidator: resolved.scriptValidator,
    humanApprovalGate: resolved.humanApprovalGate,
    askUserQuestions: resolved.askUserQuestions,
    mutability: resolved.mutability,
    circuitBreaker: resolved.circuitBreaker,
    iterationPolicy: resolved.iterationPolicy,
    planRepair: resolved.planRepair,
    collaboration,
  };

  return {
    createTaskId: () => `task-${randomUUID()}`,
    resolvedGlobalDefaults: () => resolvedGlobalDefaults,
    hasPreMergeCommand: () => hasPreMergeCommand,
    now: () => new Date().toISOString(),
    executionContract: createRegisteredGraphExecutionContract(),
  };
}

export interface GraphWorkflowRuntimeEditRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  buildLiveEditDeps(projectPath: string): Promise<LiveEditDeps>;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery;
  publishCharterUpdated(
    input: PublishCharterUpdatedInput,
  ): GraphWorkflowEventDelivery;
  /**
   * Rewrite the session worktree's charter.md pointer copy after an accepted
   * amendment. Lane worktrees re-materialize per iteration; the session
   * worktree's copy is only written at seed time, so it goes stale without
   * this. Best-effort: a failure is logged, never a request failure — the
   * inline prompt digest is authoritative, the file is a pointer copy.
   */
  writeCharterDocument(input: {
    worktreePath: string;
    markdown: string;
  }): Promise<void>;
}

async function defaultWriteCharterDocument(input: {
  worktreePath: string;
  markdown: string;
}): Promise<void> {
  const absolutePath = path.join(input.worktreePath, CHARTER_DOCUMENT_PATH);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, input.markdown);
}

const defaultDeps: GraphWorkflowRuntimeEditRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getActiveExecution: getActiveGraphWorkflowExecution,
  mutateActive: executionRepository.mutateActive,
  buildLiveEditDeps: defaultBuildLiveEditDeps,
  publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
  publishCharterUpdated: eventPublisher.publishCharterUpdated,
  writeCharterDocument: defaultWriteCharterDocument,
};

// The doc-06 error contract (§"Error contract"): a code-bearing rejection is an
// operation failure (CLI exit 1); a codeless 400/404 is malformed input (exit 2).
type LiveEditFailureCode =
  | "execution_mismatch"
  | "revision_conflict"
  | "not_editable"
  | LiveEditRejectionCode;

interface LiveEditFailure {
  status: 400 | 409;
  code: LiveEditFailureCode;
  error: string;
  issues?: WorkflowGraphValidationError[];
  currentLiveRevision?: number;
  instruction?: string;
}

type LiveEditGateResult =
  | {
      ok: true;
      execution: GraphWorkflowExecution;
      affectedContextIds: string[];
    }
  | { ok: false; failure: LiveEditFailure };

/** Thrown inside the serialized mutation so a rejection persists nothing. */
class LiveEditRejectionSignal extends Error {
  constructor(readonly failure: LiveEditFailure) {
    super(failure.error);
    this.name = "LiveEditRejectionSignal";
  }
}

/**
 * The shared gate pipeline run against a single execution snapshot (doc 06 route
 * pipeline gates a–d). Both the dry-run path (against the read accessor's
 * snapshot) and the apply path (against the write-queue-held current state, for
 * apply-time re-classification, D7) run these against their own snapshot.
 */
function evaluateLiveEditRequest(
  execution: GraphWorkflowExecution,
  request: WorkflowLiveEditRequest,
  liveEditDeps: LiveEditDeps,
): LiveEditGateResult {
  if (request.executionId !== execution.id) {
    return {
      ok: false,
      failure: {
        status: 409,
        code: "execution_mismatch",
        error: `executionId "${request.executionId}" does not match the active execution "${execution.id}"`,
      },
    };
  }

  if (request.baseLiveRevision !== execution.liveRevision) {
    return {
      ok: false,
      failure: {
        status: 409,
        code: "revision_conflict",
        error: `execution changed since liveRevision ${request.baseLiveRevision} (current ${execution.liveRevision}) — re-read the live outline`,
        currentLiveRevision: execution.liveRevision,
      },
    };
  }

  const editability = classifyExecutionEditability(execution);
  if (editability.kind === "not-editable") {
    return {
      ok: false,
      failure: {
        status: 409,
        code: "not_editable",
        error: `execution is not editable (${editability.reason})`,
      },
    };
  }

  const applied = applyLiveExecutionEdits(
    execution,
    { operations: request.operations, source: request.source },
    liveEditDeps,
  );
  if (!applied.ok) {
    return {
      ok: false,
      failure: {
        status:
          applied.code === "region_locked" ||
          applied.code === "spec_grouping_frozen"
            ? 409
            : 400,
        code: applied.code,
        error: "live edit was rejected",
        issues: applied.issues,
        ...(applied.instruction ? { instruction: applied.instruction } : {}),
      },
    };
  }

  return {
    ok: true,
    execution: applied.execution,
    affectedContextIds: applied.affectedContextIds,
  };
}

function respondLiveEditFailure(failure: LiveEditFailure): Response {
  const operationIndex = failure.issues?.find(
    (issue) => issue.operationIndex !== undefined,
  )?.operationIndex;
  logger.warn("live_edit.rejected", {
    code: failure.code,
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    issueCount: failure.issues?.length ?? 0,
  });

  const body: Record<string, unknown> = {
    error: failure.error,
    code: failure.code,
  };
  if (failure.currentLiveRevision !== undefined) {
    body["currentLiveRevision"] = failure.currentLiveRevision;
  }
  if (failure.issues) {
    body["issues"] = failure.issues.map(formatDefinitionEditIssue);
  }
  if (failure.instruction) {
    body["instruction"] = failure.instruction;
  }
  return NextResponse.json(body, { status: failure.status });
}

async function resolveSession(
  context: RouteContext,
  deps: GraphWorkflowRuntimeEditRouteDeps,
): Promise<{ error: Response } | { projectPath: string; sessionName: string }> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");
  const resolved = await resolveProjectSessionOr404(
    deps,
    projectName,
    sessionName,
  );
  if (!resolved.ok) return { error: resolved.response };
  return { projectPath: resolved.value.projectPath, sessionName };
}

export function createGraphWorkflowRuntimeEditRouteHandlers(
  deps: GraphWorkflowRuntimeEditRouteDeps = defaultDeps,
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid live edit request: body must be JSON",
          issues: [{ path: "body", message: "invalid JSON" }],
        },
        { status: 400 },
      );
    }

    const parsed = workflowLiveEditRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid live edit request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "operations",
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    const editRequest = parsed.data;

    const resolved = await resolveSession(context, deps);
    if ("error" in resolved) {
      return resolved.error;
    }
    const { projectPath, sessionName } = resolved;

    const liveEditDeps = await deps.buildLiveEditDeps(projectPath);

    // Dry-run — outside the write queue (D14). The state-store mutation primitive
    // always persists; a dry-run reads the snapshot via the accessor, runs the
    // same gates, and reports the would-be result with no persist, no bump, and
    // no events. The verdict is advisory; the apply path re-runs the gates.
    if (editRequest.dryRun === true) {
      const execution = await deps.getActiveExecution(projectPath, sessionName);
      if (!execution) {
        return notFound(
          "Session does not have an active graph workflow execution",
        );
      }
      const gate = evaluateLiveEditRequest(
        execution,
        editRequest,
        liveEditDeps,
      );
      if (!gate.ok) {
        return respondLiveEditFailure(gate.failure);
      }
      return NextResponse.json({
        applied: editRequest.operations.length,
        liveRevision: execution.liveRevision,
        affectedContextIds: gate.affectedContextIds,
        dryRun: true,
      });
    }

    // Apply — inside the serialized mutation (atomic). Gates re-run against the
    // write-queue-held current state (apply-time re-classification, D7); a
    // rejection throws so nothing persists. On success bump `liveRevision` by
    // exactly one (D4) and emit the mandatory live-edit event (D12/D16).
    let applied = 0;
    let liveRevision = 0;
    let affectedContextIds: string[] = [];
    const containsCharterAmendment = editRequest.operations.some(
      (operation) => operation.type === "amend-charter",
    );
    let amendedExecution: GraphWorkflowExecution | null = null;
    try {
      await deps.mutateActive(projectPath, sessionName, (current) => {
        const gate = evaluateLiveEditRequest(
          current,
          editRequest,
          liveEditDeps,
        );
        if (!gate.ok) {
          throw new LiveEditRejectionSignal(gate.failure);
        }

        const bumpedLiveRevision = gate.execution.liveRevision + 1;
        const bumped: GraphWorkflowExecution = {
          ...gate.execution,
          liveRevision: bumpedLiveRevision,
        };
        const delivery = deps.publishLiveEditApplied({
          projectPath,
          sessionName,
          executionId: bumped.id,
          liveRevision: bumpedLiveRevision,
          operationCount: editRequest.operations.length,
          affectedContextIds: gate.affectedContextIds,
          source: editRequest.source,
        });

        // An amendment additionally emits the dedicated charter event (its own
        // hash-bearing audit row + the UI's refresh signal for charter surfaces).
        if (containsCharterAmendment) {
          const latestAmendment = bumped.charterAmendments.at(-1);
          const charterDelivery = deps.publishCharterUpdated({
            projectPath,
            sessionName,
            definitionId: bumped.seedDefinitionId,
            definitionRevision: bumped.seedDefinitionRevision,
            charterHash: latestAmendment?.charterHash ?? "",
            execution: bumped,
          });
          delivery.events.push(...charterDelivery.events);
          delivery.pushes.push(...charterDelivery.pushes);
          amendedExecution = bumped;
        }

        applied = editRequest.operations.length;
        liveRevision = bumpedLiveRevision;
        affectedContextIds = gate.affectedContextIds;
        return { execution: bumped, ...delivery };
      });
    } catch (error) {
      if (error instanceof LiveEditRejectionSignal) {
        return respondLiveEditFailure(error.failure);
      }
      if (
        error instanceof Error &&
        error.message ===
          "Session does not have an active graph workflow execution"
      ) {
        return notFound(error.message);
      }
      throw error;
    }

    // Post-commit: refresh the session worktree's charter.md pointer copy.
    // Best-effort — the amendment is already durable and broadcast; the inline
    // prompt digest renders from the execution, not this file.
    if (amendedExecution !== null) {
      const committed: GraphWorkflowExecution = amendedExecution;
      const latestAmendment = committed.charterAmendments.at(-1);
      logger.info("live_edit.charter_amended", {
        executionId: committed.id,
        seq: latestAmendment?.seq,
        source: editRequest.source,
        fieldsChanged: latestAmendment?.fieldsChanged,
        charterHash: latestAmendment?.charterHash,
      });
      try {
        const session = await deps.getSession(projectPath, sessionName);
        if (session?.worktreePath) {
          await deps.writeCharterDocument({
            worktreePath: session.worktreePath,
            markdown: renderCharterMarkdown(
              committed.charter,
              committed.charterAmendments,
            ),
          });
        }
      } catch (error) {
        logger.warn("live_edit.charter_document_write_failed", {
          executionId: committed.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return NextResponse.json({
      applied,
      liveRevision,
      affectedContextIds,
      dryRun: false,
    });
  }

  return { POST };
}

const defaultGraphWorkflowRuntimeEditHandlers =
  createGraphWorkflowRuntimeEditRouteHandlers();

export const applyGraphWorkflowRuntimeEdits = withTracing(
  defaultGraphWorkflowRuntimeEditHandlers.POST,
);
