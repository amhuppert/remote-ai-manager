// Shared presentation for collaboration phase progress. The desktop phase strip
// (CollabPhaseStrip) and the mobile compact bar / control sheet all render the
// same phase pips, tones, and verdict chips from these helpers so the two
// surfaces never drift apart.

export type CollabPhaseKind =
  | { kind: "initial_draft" }
  | { kind: "cross_review" }
  | { kind: "negotiation"; round: number }
  | { kind: "open_conflicts" }
  | { kind: "final_answer" }
  | { kind: "failed" };

export type CollabPhaseStatus = "pending" | "active" | "done";

export type CollabPhaseVerdict =
  | "converged"
  | "ask_user"
  | "failed"
  | "user_stopped";

export interface CollabPhaseStripPhase {
  kind: CollabPhaseKind;
  status: CollabPhaseStatus;
}

export function phaseLabel(kind: CollabPhaseKind): string {
  switch (kind.kind) {
    case "initial_draft":
      return "Draft";
    case "cross_review":
      return "X-Rev";
    case "negotiation":
      return `R${kind.round}`;
    case "open_conflicts":
      return "Conflicts";
    case "final_answer":
      return "Final";
    case "failed":
      return "Failed";
  }
}

export function phaseDataKind(kind: CollabPhaseKind): string {
  return kind.kind;
}

export const VERDICT_LABEL: Record<CollabPhaseVerdict, string> = {
  converged: "converged",
  ask_user: "awaiting Alex",
  failed: "failed",
  user_stopped: "stopped",
};

export const VERDICT_GLYPH: Record<CollabPhaseVerdict, string> = {
  converged: "✓",
  ask_user: "?",
  failed: "×",
  user_stopped: "■",
};

export function isStopAvailable(phases: CollabPhaseStripPhase[]): boolean {
  return phases.some((phase) => phase.status === "active");
}

export type PipTone = "red" | "amber" | "done" | "active" | "pending";

export function pipTone(dataKind: string, status: CollabPhaseStatus): PipTone {
  if (dataKind === "failed" && status === "done") return "red";
  if (dataKind === "open_conflicts" && status === "active") return "amber";
  if (status === "done") return "done";
  if (status === "active") return "active";
  return "pending";
}

export const pipTextColor: Record<PipTone, string> = {
  red: "text-red",
  amber: "text-amber",
  done: "text-text-primary",
  active: "text-cyan",
  pending: "text-text-secondary",
};

export const pipDotTone: Record<PipTone, string> = {
  red: "border-red bg-red shadow-[0_0_6px_var(--red-glow)]",
  // open_conflicts+active recolors to amber but does NOT reset the animation
  // from the base [data-status=active] dot rule, so the amber dot still pulses.
  amber:
    "border-amber bg-amber shadow-[0_0_8px_var(--amber-glow)] animate-pulse-dot",
  done: "border-cyan bg-cyan shadow-[0_0_6px_var(--cyan-glow-strong)]",
  active:
    "border-cyan bg-cyan shadow-[0_0_8px_var(--cyan-glow-strong)] animate-pulse-dot",
  pending: "border-border-default bg-transparent",
};

export const verdictColor: Record<CollabPhaseVerdict, string> = {
  converged: "bg-green-glow text-green",
  ask_user: "bg-amber-glow text-amber",
  failed: "bg-red-glow text-red",
  user_stopped: "bg-bg-raised text-text-secondary",
};

// The single phase the compact surfaces summarize: the in-flight step, falling
// back to the last phase once every step is done (a terminal passage always
// carries a verdict, which the caller shows instead).
export function activePhase(
  phases: CollabPhaseStripPhase[],
): CollabPhaseStripPhase | undefined {
  return (
    phases.find((phase) => phase.status === "active") ??
    phases[phases.length - 1]
  );
}
