/**
 * The live-edit apply core (doc 06 route pipeline, extracted per
 * docs/design/cc-cli/08): gate evaluation → serialized atomic mutation with a
 * single `liveRevision` bump → mandatory live-edit event (+ charter event and
 * session `charter.md` rewrite on amendments). The HTTP runtime-edits route and
 * the D1 plan-repair supervisor both drive this one pipeline, so every editor —
 * human or repair agent — rides the identical gates and audit trail; there is
 * deliberately no second path to mutate a launched execution's working
 * definition.
 */

import { createLogger } from "@/lib/logging";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type {
  GraphWorkflowEventDelivery,
  PublishCharterUpdatedInput,
  PublishLiveEditAppliedInput,
} from "./execution-events";
import { renderCharterMarkdown } from "./charter/render";
import type { MutateActiveResult } from "./execution-repository";
import { classifyExecutionEditability } from "./lifecycle-classifier";
import {
  applyLiveExecutionEdits,
  type LiveEditDeps,
  type LiveEditRejectionCode,
  type LiveEditSource,
} from "./runtime-edits";

const logger = createLogger("workflow.live-edit");

// The doc-06 error contract (§"Error contract"): a code-bearing rejection is an
// operation failure (CLI exit 1); a codeless 400/404 is malformed input (exit 2).
export type LiveEditFailureCode =
  | "execution_mismatch"
  | "revision_conflict"
  | "not_editable"
  | LiveEditRejectionCode;

export interface LiveEditFailure {
  status: 400 | 409;
  code: LiveEditFailureCode;
  error: string;
  issues?: WorkflowGraphValidationError[];
  currentLiveRevision?: number;
  instruction?: string;
}

/**
 * The internal request shape. `source` uses the WIDER internal union — the HTTP
 * route parses the client-facing schema (`cli`/`ui`) before building this, and
 * the plan-repair supervisor passes the server-derived `plan-repair`.
 */
export interface LiveEditApplyRequest {
  executionId: string;
  baseLiveRevision: number;
  source: LiveEditSource;
  dryRun?: boolean;
  operations: WorkflowLiveEditOperation[];
}

export type LiveEditApplyOutcome =
  | {
      ok: true;
      applied: number;
      liveRevision: number;
      affectedContextIds: string[];
      dryRun: boolean;
      /** The committed execution on an apply; null on a dry run. */
      execution: GraphWorkflowExecution | null;
    }
  | { ok: false; kind: "no_active_execution" }
  | { ok: false; kind: "rejected"; failure: LiveEditFailure };

export interface LiveEditApplyServiceDeps {
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
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /**
   * Rewrite the session worktree's charter.md pointer copy after an accepted
   * amendment. Lane worktrees re-materialize per iteration; the session
   * worktree's copy is only written at seed time, so it goes stale without
   * this. Best-effort: a failure is logged, never an apply failure — the
   * inline prompt digest is authoritative, the file is a pointer copy.
   */
  writeCharterDocument(input: {
    worktreePath: string;
    markdown: string;
  }): Promise<void>;
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

const NO_ACTIVE_EXECUTION_MESSAGE =
  "Session does not have an active graph workflow execution";

/**
 * The shared gate pipeline run against a single execution snapshot (doc 06 route
 * pipeline gates a–d). Both the dry-run path (against the read accessor's
 * snapshot) and the apply path (against the write-queue-held current state, for
 * apply-time re-classification, D7) run these against their own snapshot.
 */
function evaluateLiveEditRequest(
  execution: GraphWorkflowExecution,
  request: LiveEditApplyRequest,
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

function rejected(failure: LiveEditFailure): LiveEditApplyOutcome {
  const operationIndex = failure.issues?.find(
    (issue) => issue.operationIndex !== undefined,
  )?.operationIndex;
  logger.warn("live_edit.rejected", {
    code: failure.code,
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    issueCount: failure.issues?.length ?? 0,
  });
  return { ok: false, kind: "rejected", failure };
}

export async function applyLiveEditsToActiveExecution(
  input: {
    projectPath: string;
    sessionName: string;
    request: LiveEditApplyRequest;
  },
  deps: LiveEditApplyServiceDeps,
): Promise<LiveEditApplyOutcome> {
  const { projectPath, sessionName, request } = input;
  const liveEditDeps = await deps.buildLiveEditDeps(projectPath);

  // Dry-run — outside the write queue (D14). The state-store mutation primitive
  // always persists; a dry-run reads the snapshot via the accessor, runs the
  // same gates, and reports the would-be result with no persist, no bump, and
  // no events. The verdict is advisory; the apply path re-runs the gates.
  if (request.dryRun === true) {
    const execution = await deps.getActiveExecution(projectPath, sessionName);
    if (!execution) {
      return { ok: false, kind: "no_active_execution" };
    }
    const gate = evaluateLiveEditRequest(execution, request, liveEditDeps);
    if (!gate.ok) {
      return rejected(gate.failure);
    }
    return {
      ok: true,
      applied: request.operations.length,
      liveRevision: execution.liveRevision,
      affectedContextIds: gate.affectedContextIds,
      dryRun: true,
      execution: null,
    };
  }

  // Apply — inside the serialized mutation (atomic). Gates re-run against the
  // write-queue-held current state (apply-time re-classification, D7); a
  // rejection throws so nothing persists. On success bump `liveRevision` by
  // exactly one (D4) and emit the mandatory live-edit event (D12/D16).
  let applied = 0;
  let liveRevision = 0;
  let affectedContextIds: string[] = [];
  const containsCharterAmendment = request.operations.some(
    (operation) => operation.type === "amend-charter",
  );
  let committedExecution: GraphWorkflowExecution | null = null;
  let amendedExecution: GraphWorkflowExecution | null = null;
  try {
    await deps.mutateActive(projectPath, sessionName, (current) => {
      const gate = evaluateLiveEditRequest(current, request, liveEditDeps);
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
        operationCount: request.operations.length,
        affectedContextIds: gate.affectedContextIds,
        source: request.source,
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

      applied = request.operations.length;
      liveRevision = bumpedLiveRevision;
      affectedContextIds = gate.affectedContextIds;
      committedExecution = bumped;
      return { execution: bumped, ...delivery };
    });
  } catch (error) {
    if (error instanceof LiveEditRejectionSignal) {
      return rejected(error.failure);
    }
    if (
      error instanceof Error &&
      error.message === NO_ACTIVE_EXECUTION_MESSAGE
    ) {
      return { ok: false, kind: "no_active_execution" };
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
      source: request.source,
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

  return {
    ok: true,
    applied,
    liveRevision,
    affectedContextIds,
    dryRun: false,
    execution: committedExecution,
  };
}
