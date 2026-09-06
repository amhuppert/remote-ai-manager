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
import {
  planRepairStatement,
  type PlanRepairActivity,
} from "./derive-plan-repair-activity";
import { cn } from "@/lib/ui/cn";
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";

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
    case "infrastructure_blocked":
      return {
        headline: `Infrastructure check ${reason.commandName} blocked after ${reason.attempts} attempts`,
        detail: <p>{reason.message}</p>,
        action:
          "Restore the dependency or correct the readiness command, then resume to check readiness again.",
        tone: "attention",
      };
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
    case "ownership_violation":
      return {
        headline: `Lane "${reason.laneId}" changed ${reason.unattributedPaths.length} path(s) no member owns`,
        // Same amber `<code>` locator list the dirty-path halts use, so a
        // machine locator reads the same wherever a halt reports one.
        detail: (
          <ul className={haltPathsClass}>
            {reason.unattributedPaths.map((unattributed) => (
              <li key={unattributed}>
                <code>{unattributed}</code>
              </li>
            ))}
          </ul>
        ),
        // Once plan repair has spoken, its verdict replaces the generic remedy
        // — the same substitution the plan-defect card makes. Repair declines
        // this halt often, and a decline the card never shows is a round the
        // operator paid for and cannot read.
        action:
          reason.summary ??
          `Found while "${reason.contextId}" landed — the lane cannot say which member wrote them. Widen a member's ownership to cover these paths, or remove the writes, then resume.`,
        tone: "attention",
      };
    case "candidate_unstable": {
      // One count, two diagnoses. When something moved, the tree is the story
      // and the card leads with it. When nothing did — a validator answering
      // for a round that was already over — the same copy would send the
      // operator hunting churn that never happened, so the card says which of
      // the two it is. Neither ever suggests a bare resume: resuming before the
      // cause is addressed reproduces the same run of rounds.
      const moved = reason.driftedComponents !== "";
      return {
        headline: moved
          ? `"${reason.contextId}" could not be reviewed — the candidate moved ${reason.consecutiveCount} rounds in a row`
          : `"${reason.contextId}" could not be reviewed — ${reason.consecutiveCount} rounds in a row reached no verdict`,
        detail: (
          <>
            <p>{reason.message}</p>
            <pre className={haltPreClass}>
              {moved
                ? `stage: ${reason.stage}\ndrifted: ${reason.driftedComponents}`
                : `stage: ${reason.stage}\nlast incident: ${
                    reason.lastIncident === "stale_result_rejected"
                      ? "stale round token"
                      : "candidate read back unchanged"
                  }`}
            </pre>
          </>
        ),
        // The repair verdict, when there is one, displaces both remedies: this
        // halt's cause is usually outside the plan, so the round that looked
        // and declined is more use than either generic instruction.
        action:
          reason.summary ??
          (moved
            ? "Find what keeps changing the worktree between the freeze and the review — a sibling writing into a shared lane, or a stale index under it — then resume. No verdict was rendered, so no work was reopened and no attempt was charged."
            : "Nothing was seen to move, so the worktree is not the place to look: the rounds kept being discarded before a verdict could land. Check the validator's own runs for results arriving after their round closed, then resume. No verdict was rendered, so no work was reopened and no attempt was charged."),
        tone: "attention",
      };
    }
    case "plan_defect":
      // The defect is against the CONTRACT, not the work, so the card leads
      // with the clause in conflict and never suggests a bare re-run: resuming
      // before the plan changes reproduces the same refusal.
      return {
        headline: `Plan defect in "${reason.contextId}" — ${reason.planDefects.length} blocking finding(s)`,
        // Same amber `<code>` locator list the path halts use — here the
        // locator is the contract clause the finding names.
        detail: (
          <ul className={haltPathsClass}>
            {reason.planDefects.map((defect) => (
              <li key={`${defect.assignmentId}:${defect.title}`}>
                <code>{defect.conflictingContract}</code> {defect.title} —{" "}
                {defect.whyNotLocallyRemediable}
              </li>
            ))}
          </ul>
        ),
        action:
          reason.summary ??
          "Repair the plan the finding names — the contract, not the work — then resume. Nothing was reopened and no attempt was charged.",
        tone: "attention",
      };
  }
}

// Small text action, sized to sit inside the card's dense body rather than
// competing with the halt headline.
const haltInlineActionClass =
  "w-fit cursor-pointer appearance-none border-0 bg-transparent p-0 font-[inherit] text-[0.72rem] font-semibold text-cyan hover:underline max-768:inline-flex max-768:min-h-[44px] max-768:items-center";

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

/**
 * Split a declaration-lint locator into the keyword it names and the property
 * carrying it. `validateOutputSchemaDeclaration` locates a defect at the exact
 * offending keyword (`$.properties.auditTable.format`), and every JSON Schema
 * keyword is a plain identifier, so the final `.`-segment is always the keyword
 * and never a bracket-quoted property name. The `properties` hop is dropped
 * because the operator reads the payload, not the document that describes it.
 */
function splitDeclarationLocator(
  path: string,
): { keyword: string; property: string } | null {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return null;
  const keyword = path.slice(lastDot + 1);
  if (keyword === "") return null;
  const parent = path.slice(0, lastDot);
  const propertyMatch = /(?:\.|\["?)([^.[\]"]+)"?\]?$/.exec(parent);
  return {
    keyword,
    property: propertyMatch?.[1] ?? parent,
  };
}

/**
 * The engine's refusal, in the contract's own words.
 *
 * Two different defects reach this card and they have different repairs. A
 * contract the subset validator cannot enforce is named keyword-first — that
 * keyword is why nothing the context produced could ever pass — and it is found
 * by the module that owns the subset, not by re-reading the rejection. An
 * enforceable contract that the payload simply missed is named by the refused
 * path AND the engine's own description of it: `toOutputSchemaIssues` sets the
 * issue title EQUAL to its path, so a locator alone would be the whole sentence
 * and would say nothing about what the contract wanted there.
 */
function outputSchemaRefusalSentence(
  contextId: string,
  evidence: OutputSchemaHaltEvidence | undefined,
): string {
  const declarationDefect =
    evidence?.declaredSchema == null
      ? null
      : (validateOutputSchemaDeclaration(evidence.declaredSchema)
          .map((issue) => splitDeclarationLocator(issue.path))
          .find((split) => split !== null) ?? null);
  const issue = evidence?.issues[0];
  const locus = issue?.path;
  const named =
    declarationDefect !== null
      ? `${contextId} declares ${declarationDefect.keyword} on ${declarationDefect.property}.`
      : locus === undefined
        ? `${contextId} produced no output its declared contract accepts.`
        : issue?.description !== undefined
          ? `${contextId} was refused at ${locus} — ${issue.description}.`
          : `${contextId} was refused at ${locus}.`;
  return `${named} Repair the contract, then resume — resume starts the retry budget fresh.`;
}

/**
 * Whether an agent is on this halt, stated on the card that reports it.
 *
 * A repair round leaves the execution reading `halted` for as long as its
 * agent's turn runs, so the card's own chrome — red, stopped, terminal — is the
 * same in both cases. This line is the difference.
 */
function PlanRepairLine({ activity }: { activity: PlanRepairActivity }) {
  const statement = planRepairStatement(activity);
  return (
    <div
      data-testid="halt-repair-line"
      className={cn(
        "flex items-start gap-[6px] text-[0.72rem] leading-[1.45]",
        statement.working ? "text-cyan" : "text-text-tertiary",
      )}
    >
      {statement.working && (
        // Pinned to the first line rather than centred: the sentence wraps, and
        // a dot floating beside the middle of a paragraph reads as a bullet.
        <span
          aria-hidden="true"
          className="mt-[5px] h-[6px] w-[6px] shrink-0 [animation:pulse-dot_2.4s_ease-in-out_infinite] rounded-full bg-cyan shadow-[0_0_8px_var(--color-cyan-glow)] motion-reduce:[animation:none]"
        />
      )}
      <span className="min-w-0">{statement.sentence}</span>
    </div>
  );
}

export interface ContextHaltCardProps {
  primary: GraphWorkflowHaltReason;
  secondary?: GraphWorkflowHaltReason[];
  /**
   * The plan-repair rounds standing against this halt. Omitted by a host that
   * has no execution to read them from; a halt no round has answered says
   * nothing about repair rather than claiming an absence it cannot see.
   */
  planRepairActivity?: PlanRepairActivity | null;
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
  planRepairActivity = null,
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
  // The output-schema refusal is the one halt with a repair the card can point
  // at, so E2 gives it its own headline, its own sentence and its own two
  // actions. Every other halt keeps the formatter's headline and evidence.
  const schemaRefusal =
    primary.type === "circuit_breaker" &&
    primary.condition === "output_schema_validation"
      ? {
          contextId: primary.contextId,
          sentence: outputSchemaRefusalSentence(
            primary.contextId,
            primaryEvidence,
          ),
          // The SAME predicate the page's control matrix reads, so the card's
          // blocked Resume can never stand beside an enabled one: both ask
          // whether the contract that refused is provably still in force.
          resumeBlocked:
            primaryEvidence?.contractUnchangedSinceRejection === true,
        }
      : null;
  return (
    <div
      className={cn(attention ? haltCardAttention : haltCardBase, "mb-md")}
      role="alert"
      data-tone={attention ? "attention" : "blocked"}
    >
      <div
        className={cn(
          "flex items-center gap-sm text-[0.8rem] font-semibold tracking-[0.01em]",
          attention ? "text-amber" : "text-red",
        )}
      >
        {schemaRefusal !== null
          ? "Output schema rejected by the engine"
          : formatted.headline}
        {schemaRefusal !== null && (
          <StatusChip tone="neutral" layoutClassName="ml-auto">
            resumable halt
          </StatusChip>
        )}
      </div>
      {schemaRefusal !== null && (
        <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
          {schemaRefusal.sentence}
        </p>
      )}
      {planRepairActivity !== null && planRepairActivity.rounds.length > 0 && (
        <PlanRepairLine activity={planRepairActivity} />
      )}
      {formatted.detail && (
        <div
          data-testid="halt-detail"
          className="max-h-[240px] overflow-y-auto text-[0.72rem] text-text-secondary [&_p]:m-0"
        >
          {formatted.detail}
        </div>
      )}
      {formatted.action && schemaRefusal === null && (
        <div className="text-[0.72rem] text-text-tertiary italic">
          {formatted.action}
        </div>
      )}
      {schemaRefusal !== null && (
        <div className="flex flex-wrap items-center gap-sm">
          {onEditSchema !== undefined && (
            <button
              type="button"
              className="inline-flex h-[24px] cursor-pointer items-center rounded-sm border border-solid border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a12)] px-[10px] font-mono text-[0.7rem] font-medium text-cyan transition-colors duration-150 hover:bg-[var(--cc-cyan-a20)] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:h-[44px] max-768:px-md"
              onClick={() => onEditSchema(schemaRefusal.contextId)}
            >
              Edit schema
            </button>
          )}
          {schemaRefusal.resumeBlocked ? (
            <button
              type="button"
              disabled
              className="inline-flex h-[24px] cursor-not-allowed items-center rounded-sm border border-solid border-border-default bg-transparent px-[10px] font-mono text-[0.7rem] font-medium text-text-tertiary opacity-60 max-768:h-auto max-768:min-h-[44px] max-768:px-md"
            >
              Resume — blocked until the contract is accepted
            </button>
          ) : (
            // No second Resume once the block lifts: the execution controls own
            // the act, and a duplicate here would be a second, unaudited path to
            // the same mutation.
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              Resume is available in the execution controls.
            </span>
          )}
        </div>
      )}
      {formatted.actionHref && (
        <Link
          href={formatted.actionHref}
          className="w-fit text-[0.72rem] font-semibold text-cyan hover:underline max-768:inline-flex max-768:min-h-[44px] max-768:items-center"
        >
          Open the merge gate →
        </Link>
      )}

      {secondary.length > 0 && (
        <div className="mt-[2px]">
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-[var(--cc-red-a35)] bg-transparent px-[8px] py-[3px] font-[inherit] text-[0.7rem] font-semibold tracking-[0.05em] text-red uppercase hover:bg-[var(--cc-red-a08)] max-768:min-h-[44px] max-768:px-md"
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
