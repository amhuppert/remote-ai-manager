"use client";

import { useState, type ReactNode } from "react";
import type { GraphWorkflowHaltReason } from "@/types";

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
    <ul className="wb-exec-halt-paths">
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
      return {
        headline: `Agent turn failed in ${reason.contextId} (${reason.engine})`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
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
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: "Resume to retry.",
      };
    case "merge_failure":
      return {
        headline: `Merge failed in ${reason.contextId}`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: "Resolve conflicts in the worktree, then resume.",
      };
    case "join_failure": {
      const kindLabel =
        reason.joinKind === "final_publish" ? "Final publish" : "Context join";
      const scope = reason.contextId ? ` in ${reason.contextId}` : "";
      const conflictsList =
        reason.conflictFiles.length > 0 ? (
          <ul className="wb-exec-halt-paths">
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
            <pre className="wb-exec-halt-pre">{reason.message}</pre>
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
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: null,
      };
    case "validator_infra_error":
      return {
        headline: `Validator infrastructure error in ${reason.contextId}`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: null,
      };
    case "script_validator_missing_command":
      return {
        headline: `Script validator missing command in ${reason.contextId}`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: null,
      };
    case "aborted":
      return { headline: "Execution aborted", detail: null, action: null };
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
  const className =
    variant === "card" ? "wb-exec-halt-card" : "wb-exec-halt-banner";
  return (
    <div className={className} role="alert">
      <div className="wb-exec-halt-headline">{formatted.headline}</div>
      {formatted.detail && (
        <div className="wb-exec-halt-detail">{formatted.detail}</div>
      )}
      {formatted.action && (
        <div className="wb-exec-halt-action">{formatted.action}</div>
      )}
      {secondary.length > 0 && (
        <div className="wb-exec-halt-secondary">
          <button
            type="button"
            className="wb-exec-halt-chip"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            +{secondary.length} more{" "}
            {secondary.length === 1 ? "failure" : "failures"}
          </button>
          {expanded && (
            <ul className="wb-exec-halt-secondary-list">
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
