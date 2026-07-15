"use client";

import { useState, type ReactNode } from "react";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import { cn } from "@/lib/ui/cn";

const haltCardBase =
  "w-full bg-[var(--cc-red-a06)] border border-[var(--cc-red-border)] border-l-[3px] border-l-red rounded-sm py-sm px-md flex flex-col gap-[6px] text-text-secondary text-[0.74rem] leading-[1.45]";

const haltPathsClass =
  "list-none p-0 m-0 flex flex-col gap-[2px] font-mono text-[0.7rem] [&_li]:text-text-secondary [&_code]:inline-block [&_code]:min-w-[1.5em] [&_code]:text-amber [&_code]:mr-[6px]";

const haltPreClass =
  "font-mono text-[0.7rem] bg-[var(--cc-graph-ink-a40)] border border-border-dim rounded-sm py-[6px] px-[8px] m-0 whitespace-pre-wrap break-words text-text-secondary max-h-[160px] overflow-auto";
interface FormattedHaltReason {
  headline: string;
  detail: ReactNode | null;
  action: string | null;
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

export function formatGraphWorkflowHaltReason(
  reason: GraphWorkflowHaltReason,
): FormattedHaltReason {
  switch (reason.type) {
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
        reason.joinKind === "final_publish" ? "Final publish" : "Context join";
      const scope = reason.contextId ? ` in ${reason.contextId}` : "";
      const conflictsList =
        reason.conflictFiles.length > 0 ? (
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
        headline: `Validator infrastructure error in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "script_validator_missing_command":
      return {
        headline: `Script validator missing command in ${reason.contextId}`,
        detail: <pre className={haltPreClass}>{reason.message}</pre>,
        action: null,
      };
    case "aborted":
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
  }
}

export interface ContextHaltCardProps {
  primary: GraphWorkflowHaltReason;
  secondary?: GraphWorkflowHaltReason[];
  variant?: "banner" | "card";
}

export default function ContextHaltCard({
  primary,
  secondary = [],
  variant = "banner",
}: ContextHaltCardProps) {
  const [expanded, setExpanded] = useState(false);
  const formatted = formatGraphWorkflowHaltReason(primary);
  return (
    <div
      className={cn(
        haltCardBase,
        variant === "card" ? "mb-md" : "mt-[6px] basis-full",
      )}
      role="alert"
    >
      <div className="text-[0.8rem] font-semibold tracking-[0.01em] text-red">
        {formatted.headline}
      </div>
      {formatted.detail && (
        <div className="text-[0.72rem] text-text-secondary [&_p]:m-0">
          {formatted.detail}
        </div>
      )}
      {formatted.action && (
        <div className="text-[0.72rem] text-text-tertiary italic">
          {formatted.action}
        </div>
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
            <ul className="mx-0 mt-[6px] mb-0 flex list-none flex-col gap-[8px] border-t border-dashed border-[var(--cc-red-a25)] px-0 pt-[8px] pb-0 [&_li]:text-[0.72rem] [&_li]:text-text-secondary [&_strong]:font-semibold [&_strong]:text-text-primary">
              {secondary.map((reason, idx) => {
                const f = formatGraphWorkflowHaltReason(reason);
                return (
                  <li key={`${reason.type}-${idx}`}>
                    <strong>{f.headline}</strong>
                    {f.detail && <div>{f.detail}</div>}
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
