"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  outputSchemaEvidenceForReason,
  type OutputSchemaHaltEvidence,
  type OutputSchemaHaltEvidenceByContext,
  type OutputSchemaHaltIssue,
} from "./derive-output-schema-halt";
import { cn } from "@/lib/ui/cn";

const haltCardBase =
  "w-full bg-[var(--cc-red-a06)] border border-[var(--cc-red-border)] border-l-[3px] border-l-red rounded-sm py-sm px-md flex flex-col gap-[6px] text-text-secondary text-[0.74rem] leading-[1.45]";

// Attention variant: a run waiting on a human sign-off must not read as a
// failure, so the approval halt swaps the red chrome for amber.
const haltCardAttention =
  "w-full bg-[var(--cc-amber-a09)] border border-[var(--cc-amber-border)] border-l-[3px] border-l-amber rounded-sm py-sm px-md flex flex-col gap-[6px] text-text-secondary text-[0.74rem] leading-[1.45]";

const haltPathsClass =
  "list-none p-0 m-0 flex flex-col gap-[2px] font-mono text-[0.7rem] [&_li]:text-text-secondary [&_code]:inline-block [&_code]:min-w-[1.5em] [&_code]:text-amber [&_code]:mr-[6px]";

// No max-height of its own: hosts own the height bound (the card's scroll
// wrapper below, or the halt-details dialog's scrolling body).
const haltPreClass =
  "font-mono text-[0.7rem] bg-[var(--cc-graph-ink-a40)] border border-border-dim rounded-sm py-[6px] px-[8px] m-0 whitespace-pre-wrap break-words text-text-secondary";
interface FormattedHaltReason {
  headline: string;
  detail: ReactNode | null;
  action: string | null;
  /**
   * Deep link to the surface that can clear the halt (`?el=` contract — it
   * retries after the target page loads, unlike a raw hash). Hosts decide how
   * to render it; the one-line surfaces (status bar, event log) stay
   * headline-only.
   */
  actionHref?: string;
  /** "attention" = waiting on a human act, not a failure. Default "blocked". */
  tone?: "blocked" | "attention";
}

function renderDirtyPathList(
  dirtyPaths: ReadonlyArray<{ path: string; statusCode: string }>,
  total: number,
): ReactNode {
  const truncatedExtras = total - dirtyPaths.length;
  return (
    <ul className={haltPathsClass}>
      {dirtyPaths.map((p) => (
        <li key={p.path}>
          <code>{p.statusCode.trim() || "??"}</code> {p.path}
        </li>
      ))}
      {truncatedExtras > 0 && <li>+{truncatedExtras} more</li>}
    </ul>
  );
}

export interface FormatHaltReasonOptions {
  /** Omit the per-file conflict list from a join_failure detail, for hosts
   *  that render their own richer conflict presentation (the halt-details
   *  dialog's recovery form). */
  omitConflictFiles?: boolean;
  /**
   * Evidence an `output_schema_validation` trip cannot carry on the halt reason
   * itself — the refused payload and its path-keyed issues live in the
   * validation-failure record, the contract lives on the context. Evidence for
   * THIS reason: hosts derive the whole halt's record with
   * `deriveOutputSchemaHaltEvidenceByContext` and pick per reason with
   * `outputSchemaEvidenceForReason`.
   */
  outputSchemaEvidence?: OutputSchemaHaltEvidence;
  /**
   * Render the full evidence body — refused payload beside the declared
   * contract, plus the budget chips. The one-line and card surfaces stay
   * compact (issue list only); the halt-details dialog asks for this.
   */
  expandOutputSchemaEvidence?: boolean;
}

// The instance-path issue list. Same recipe as `merge_precondition_failed`'s
// dirty-path list — an amber `<code>` locator followed by prose — so a machine
// locator reads the same wherever a halt reports one.
function renderOutputSchemaIssues(
  issues: ReadonlyArray<OutputSchemaHaltIssue>,
): ReactNode {
  return (
    <ul className={haltPathsClass}>
      {issues.map((issue, index) => (
        <li key={`${issue.path ?? issue.title}-${index}`}>
          <code>{issue.path ?? issue.title}</code>
          {issue.description ?? (issue.path !== undefined ? issue.title : "")}
        </li>
      ))}
    </ul>
  );
}

const haltEvidenceLabelClass =
  "mb-[4px] text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase";

function OutputSchemaEvidenceBody({
  evidence,
}: {
  evidence: OutputSchemaHaltEvidence;
}) {
  const chips: string[] = [];
  // Named for the gate's own repair turn so it cannot be read as a D1
  // plan-repair round — the two bound different things and can both be
  // non-zero on the same halt.
  if (evidence.gateRepairAttempts !== null) {
    chips.push(
      evidence.gateRepairBudget !== null
        ? `schema repair turn · ${evidence.gateRepairAttempts} of ${evidence.gateRepairBudget}`
        : `schema repair turn · ${evidence.gateRepairAttempts}`,
    );
  }
  if (evidence.failureCount !== null) {
    chips.push(
      evidence.breakerThreshold !== null
        ? `circuit breaker · ${evidence.failureCount} of ${evidence.breakerThreshold}`
        : `circuit breaker · ${evidence.failureCount}`,
    );
  }
  if (evidence.iteration !== null) {
    chips.push(
      evidence.maxIterations !== null
        ? `iteration ${evidence.iteration} of ${evidence.maxIterations}`
        : `iteration ${evidence.iteration}`,
    );
  }

  return (
    <>
      {evidence.issues.length > 0 && renderOutputSchemaIssues(evidence.issues)}
      {evidence.rejectedOutput !== null && (
        <div>
          <div className={haltEvidenceLabelClass}>Rejected output</div>
          <pre className={haltPreClass}>{evidence.rejectedOutput}</pre>
        </div>
      )}
      {evidence.declaredSchema !== null && (
        <div>
          <div className={haltEvidenceLabelClass}>
            {/* The Edit schema action reachable from this very card can replace
                the contract while the halt stands. The pairing stays with the
                schema that refused; the label says which schema that is. */}
            {evidence.schemaEditedSinceRejection
              ? "Declared schema (at rejection — since edited)"
              : "Declared schema"}
          </div>
          <pre className={haltPreClass}>
            {JSON.stringify(evidence.declaredSchema, null, 2)}
          </pre>
        </div>
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-[6px]">
          {chips.map((chip) => (
            <StatusChip key={chip} tone="neutral">
              {chip}
            </StatusChip>
          ))}
        </div>
      )}
    </>
  );
}

export function formatGraphWorkflowHaltReason(
  reason: GraphWorkflowHaltReason,
  options: FormatHaltReasonOptions = {},
): FormattedHaltReason {
  switch (reason.type) {
    case "delivery_gate_failed": {
      const actionHref =
        reason.spec !== undefined
          ? `/specs/${encodeURIComponent(reason.spec.projectName)}/${encodeURIComponent(reason.spec.specSlug)}?el=delivery`
          : undefined;
      if (reason.refusalCode === "approval_required") {
        return {
          headline: "Delivery gate — waiting on your approval",
          detail: (
            <p>
              {reason.spec !== undefined
                ? `${reason.spec.specName} requires a human delivery approval before this run can publish.`
                : "This run requires a human delivery approval before it can publish."}
            </p>
          ),
          action: "Approve delivery in Spec Studio, then resume this workflow.",
          ...(actionHref !== undefined ? { actionHref } : {}),
          tone: "attention",
        };
      }
      return {
        headline: `Delivery gate refused publish — ${reason.unmet.length} unmet criterion/criteria`,
        detail: (
          <ul className={haltPathsClass}>
            {reason.unmet.map((criterion) => (
              <li key={criterion.criterionId}>
                <code>{criterion.criterionHandle}</code>{" "}
                {criterion.reason ?? criterion.outcome}
              </li>
            ))}
          </ul>
        ),
        action: reason.instruction,
        ...(actionHref !== undefined ? { actionHref } : {}),
      };
    }
    case "merge_precondition_failed":
      return {
        headline: `Cannot merge into ${reason.targetBranch} — ${reason.totalDirtyCount} uncommitted change(s)`,
        detail: renderDirtyPathList(reason.dirtyPaths, reason.totalDirtyCount),
        action:
          "Commit, stash, or discard those changes in the session worktree, then resume.",
      };
    case "agent_turn_failed":
      if (reason.cause === "timeout") {
        return {
          headline: `Agent turn timed out in ${reason.contextId} (${reason.engine})`,
          detail: <pre className={haltPreClass}>{reason.message}</pre>,
          action:
            "Resume to continue from completed tasks, or reduce the next turn's scope.",
        };
      }
      return {
        headline: `Agent turn failed in ${reason.contextId} (${reason.engine})`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: "Resume to retry, or inspect the agent transcript.",
      };
    case "worktree_creation_dirty":
      return {
        headline: `Worktree created with uncommitted changes — ${reason.branchName}`,
        detail: renderDirtyPathList(reason.dirtyPaths, reason.totalDirtyCount),
        action: `Investigate ${reason.worktreePath}; resume to continue.`,
      };
    case "execution_loop_failed":
      return {
        headline: "Execution loop error",
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: "Resume to retry.",
      };
    case "merge_failure":
      return {
        headline: `Merge failed in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: "Resolve conflicts in the worktree, then resume.",
      };
    case "join_failure": {
      const kindLabel =
        reason.joinKind === "final_publish"
          ? "Publish to session"
          : "Context join";
      const scope = reason.contextId ? ` in ${reason.contextId}` : "";
      const conflictsList =
        reason.conflictFiles.length > 0 && !options.omitConflictFiles ? (
          <ul className={haltPathsClass}>
            {reason.conflictFiles.map((path) => (
              <li key={path}>
                <code>UU</code> {path}
              </li>
            ))}
          </ul>
        ) : null;
      return {
        headline: `${kindLabel} failed${scope} — ${reason.sourceLaneIds.length} source lane(s) → ${reason.targetLaneId}`,
        detail: (
          <>
            <pre className={haltPreClass}>{reason.message}</pre>
            {conflictsList}
          </>
        ),
        action: "Resolve conflicts in the target worktree, then resume.",
      };
    }
    case "circuit_breaker":
      // A D2 format turn that kept failing the structured-output gate is a
      // contract problem, not a work problem: the tasks are done and the
      // validator passed. Naming the schema keeps the operator off the tasks.
      if (reason.condition === "output_schema_validation") {
        const evidence = options.outputSchemaEvidence;
        const hasIssues = evidence !== undefined && evidence.issues.length > 0;
        return {
          headline: `Output schema not satisfied in ${reason.contextId}${
            reason.failureCount ? ` (${reason.failureCount} attempts)` : ""
          }`,
          detail:
            evidence !== undefined &&
            options.expandOutputSchemaEvidence === true ? (
              <OutputSchemaEvidenceBody evidence={evidence} />
            ) : hasIssues ? (
              renderOutputSchemaIssues(evidence.issues)
            ) : reason.summary ? (
              <p>{reason.summary}</p>
            ) : null,
          action:
            "The context finished its work but could not produce an output matching its declared outputSchema. Loosen or correct that schema on the context, then resume.",
        };
      }
      return {
        headline: `Circuit breaker tripped in ${reason.contextId}`,
        detail: reason.summary ? <p>{reason.summary}</p> : null,
        action: null,
      };
    case "max_iterations":
      return {
        headline: `Max iterations reached in ${reason.contextId} (${reason.iterationCount})`,
        detail: null,
        action: null,
      };
    case "recovery_error":
      return {
        headline: "Recovery error",
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "validator_infra_error":
      return {
        // Name the specialist when the cohort recorded one: the actionable fact
        // is which reviewer was never heard, not that something in validation
        // broke. The attempt count is omitted at zero, where it would read as a
        // contradiction rather than as "the queue never admitted it".
        headline: reason.assignmentId
          ? `${reason.assignmentId} never returned a verdict in ${reason.contextId}${
              reason.attempts > 0 ? ` (${reason.attempts} attempts)` : ""
            }`
          : `Validator infrastructure error in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "script_validator_missing_command":
      return {
        headline: `Script validator missing command in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "script_validator_unknown_command":
      return {
        headline: `Script validator command ${reason.commandName} is not registered in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "validation_candidate_unavailable":
      return {
        headline: `Could not read the reviewed tree in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "aborted":
      // A cutover abort was not the operator's doing, so it must say who ended
      // the run and why — otherwise an archived entry reads as if someone hit
      // Abort. `summary` carries the migration's own wording.
      if (reason.cause === "migration_cutover") {
        return {
          headline: "Execution ended by a Command Center schema cutover",
          detail: reason.summary === null ? null : <p>{reason.summary}</p>,
          action: "Relaunch the workflow to continue this work.",
          tone: "attention",
        };
      }
      return { headline: "Execution aborted", detail: null, action: null };
    case "collaboration_failure":
      return {
        headline: `Collaboration failure in ${reason.executionContextId} — ${reason.status}`,
        detail: (
          <>
            <p>{reason.summary}</p>
            <pre className={haltPreClass}>{reason.brief}</pre>
          </>
        ),
        action:
          reason.status === "requires_user_input"
            ? "Provide direction to the implementer, then resume."
            : "Review the collaboration log and resume when ready.",
      };
    case "routing_cardinality":
      return {
        headline:
          reason.outcome === "over-selection"
            ? `${reason.contextId} activated ${reason.activatedEdgeIds.length} branches — "${reason.policy}" allows one`
            : `${reason.contextId} activated no branch — "${reason.policy}" requires at least one`,
        detail: (
          <>
            <p>{reason.message}</p>
            <pre className={haltPreClass}>
              {`conditional edges: ${reason.conditionalEdgeIds.join(", ") || "—"}\nactivated: ${
                reason.activatedEdgeIds.join(", ") || "—"
              }`}
            </pre>
          </>
        ),
        action:
          "Edit the guards on this context's outgoing edges (or its cardinality policy) while the execution is quiescent, then resume.",
        tone: "attention",
      };
    case "routing_invariant":
      return {
        headline: `${reason.contextId} cannot be routed — a guard has no output to read`,
        detail: (
          <>
            <p>{reason.message}</p>
            <pre className={haltPreClass}>
              {`edges: ${reason.edgeIds.join(", ") || "—"}\nsources: ${
                reason.sourceContextIds.join(", ") || "—"
              }`}
            </pre>
          </>
        ),
        action:
          "Amend or remove the guard on this context's incoming edges while the execution is quiescent, then resume. The completed source is never edited.",
        tone: "attention",
      };
    case "loop_exit_skipped":
      return {
        headline: `Loop "${reason.loopGroupId}" pass ${reason.pass} lost its exit — ${reason.contextId} was skipped`,
        detail: <p>{reason.message}</p>,
        action:
          "Restore a route to the pass's exit context with a quiescent live edit, then resume. Every branch inside a loop body must reconverge at the exit.",
        tone: "attention",
      };
    case "loop_invariant":
      return {
        headline: `Loop "${reason.loopGroupId}" pass ${reason.pass} cannot be settled — ${reason.contextId} banked no readable output`,
        detail: <p>{reason.message}</p>,
        action:
          "The until predicate is evaluated against the exit's captured output; restore the capture (or amend the exit's output contract) while quiescent, then resume.",
        tone: "attention",
      };
    case "loop_limit_reached":
      // The two scopes have different remedies, so they must not read alike: a
      // loop's own cap is raisable by an audited repair, the execution-wide
      // backstop is a constant.
      return reason.scope === "execution"
        ? {
            headline: `Loop "${reason.loopGroupId}" hit the execution pass backstop after ${reason.totalPassCount} total pass(es)`,
            detail: <p>{reason.message}</p>,
            action:
              "The backstop bounds every loop together and cannot be raised. Amend the exit predicates so the running loops conclude, or continue the remaining work in a new execution, then resume.",
            tone: "attention",
          }
        : {
            headline: `Loop "${reason.loopGroupId}" exhausted its budget after ${reason.maxPasses} pass(es)`,
            detail: <p>{reason.message}</p>,
            action:
              "Raise the pass cap or amend the exit predicate while the execution is quiescent, then resume. Completed passes are never re-run.",
            tone: "attention",
          };
  }
}

// Small text action, sized to sit inside the card's dense body rather than
// competing with the halt headline.
const haltInlineActionClass =
  "w-fit cursor-pointer appearance-none border-0 bg-transparent p-0 font-[inherit] text-[0.72rem] font-semibold text-cyan hover:underline";

function EditSchemaAction({
  contextId,
  onEditSchema,
}: {
  contextId: string;
  onEditSchema(contextId: string): void;
}) {
  return (
    <button
      type="button"
      className={haltInlineActionClass}
      onClick={() => onEditSchema(contextId)}
    >
      Edit schema
    </button>
  );
}

export interface ContextHaltCardProps {
  primary: GraphWorkflowHaltReason;
  secondary?: GraphWorkflowHaltReason[];
  /**
   * Output-schema evidence keyed by context, covering EVERY reason this card
   * renders. A record rather than one evidence object because a concurrent
   * second refusal is stored as a secondary reason, and rendering it without
   * its own paths and payload is the same halt reported two different ways.
   */
  outputSchemaEvidence?: OutputSchemaHaltEvidenceByContext | null;
  /** Opens the refusing context's Config tab. Omitted → not offered. */
  onEditSchema?(contextId: string): void;
}

export default function ContextHaltCard({
  primary,
  secondary = [],
  outputSchemaEvidence,
  onEditSchema,
}: ContextHaltCardProps) {
  const [expanded, setExpanded] = useState(false);
  const primaryEvidence = outputSchemaEvidenceForReason(
    outputSchemaEvidence,
    primary,
  );
  const formatted = formatGraphWorkflowHaltReason(primary, {
    ...(primaryEvidence !== undefined
      ? { outputSchemaEvidence: primaryEvidence }
      : {}),
  });
  const attention = formatted.tone === "attention";
  return (
    <div
      className={cn(attention ? haltCardAttention : haltCardBase, "mb-md")}
      role="alert"
      data-tone={attention ? "attention" : "blocked"}
    >
      <div
        className={cn(
          "text-[0.8rem] font-semibold tracking-[0.01em]",
          attention ? "text-amber" : "text-red",
        )}
      >
        {formatted.headline}
      </div>
      {formatted.detail && (
        <div
          data-testid="halt-detail"
          className="max-h-[240px] overflow-y-auto text-[0.72rem] text-text-secondary [&_p]:m-0"
        >
          {formatted.detail}
        </div>
      )}
      {formatted.action && (
        <div className="text-[0.72rem] text-text-tertiary italic">
          {formatted.action}
        </div>
      )}
      {formatted.actionHref && (
        <Link
          href={formatted.actionHref}
          className="w-fit text-[0.72rem] font-semibold text-cyan hover:underline"
        >
          Open the merge gate →
        </Link>
      )}
      {primaryEvidence !== undefined && onEditSchema !== undefined && (
        <EditSchemaAction
          contextId={primaryEvidence.contextId}
          onEditSchema={onEditSchema}
        />
      )}
      {secondary.length > 0 && (
        <div className="mt-[2px]">
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-[var(--cc-red-a35)] bg-transparent px-[8px] py-[3px] font-[inherit] text-[0.68rem] font-semibold tracking-[0.05em] text-red uppercase hover:bg-[var(--cc-red-a08)]"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            +{secondary.length} more{" "}
            {secondary.length === 1 ? "failure" : "failures"}
          </button>
          {expanded && (
            <ul className="mx-0 mt-[6px] mb-0 flex max-h-[240px] list-none flex-col gap-[8px] overflow-y-auto border-t border-dashed border-[var(--cc-red-a25)] px-0 pt-[8px] pb-0 [&_li]:text-[0.72rem] [&_li]:text-text-secondary [&_strong]:font-semibold [&_strong]:text-text-primary">
              {secondary.map((reason, idx) => {
                const evidence = outputSchemaEvidenceForReason(
                  outputSchemaEvidence,
                  reason,
                );
                const f = formatGraphWorkflowHaltReason(reason, {
                  ...(evidence !== undefined
                    ? { outputSchemaEvidence: evidence }
                    : {}),
                });
                return (
                  <li key={`${reason.type}-${idx}`}>
                    <strong>{f.headline}</strong>
                    {f.detail && <div>{f.detail}</div>}
                    {evidence !== undefined && onEditSchema !== undefined && (
                      <EditSchemaAction
                        contextId={evidence.contextId}
                        onEditSchema={onEditSchema}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
