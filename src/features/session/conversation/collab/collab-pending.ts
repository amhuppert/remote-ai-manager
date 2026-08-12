import { backendLabel } from "@/lib/agent-backends/catalog";
import type { CollabAgentsDisplayMap } from "@/features/session/conversation/collab/envelope-adapter";
import type {
  CollaborationAgent,
  CollaborationFlowAgent,
} from "@/lib/workflows/collaboration/types";
import type { CollabConnectorAnchor } from "@/features/session/conversation/collab/CollabConnector";
import type { CollabPassageStatus } from "@/features/session/conversation/collab/envelope-adapter";
import type {
  GroupedArtifacts,
  NegotiationRound,
} from "@/features/session/conversation/collab/CollabPassage";

// Derives the "who is working on what right now" placeholders for a live
// collaboration passage. Artifacts are only appended when a beat *completes*, so
// each in-flight step is an absence in the grouped timeline: a lane missing its
// draft, a missing cross-review, a round whose next artifact has not landed. A
// `CollabPendingStep` mounts a shimmer card in the exact lane cell where the real
// artifact card will land, so arrival is a fill-in rather than a layout jump.
//
// The asymmetric flow the derivation walks (see workflow-envelope.ts):
//   1. initial drafts    — agent_one (primary) + agent_two, in parallel
//   2. cross-review      — agent_two reviews agent_one's draft
//   3. negotiation round — proposed_changes (agent_one) → counter_proposal
//                          (agent_two) → resolution_decision (agent_one)
//   4. final answer      — agent_one

export type CollabPendingKind =
  | "initial_draft"
  | "cross_review"
  | "proposed_changes"
  | "counter_proposal"
  | "resolution_decision"
  | "final_answer";

export interface CollabPendingStep {
  /** Stable card id, unique across the passage timeline. */
  id: string;
  kind: CollabPendingKind;
  flowAgent: CollaborationFlowAgent;
  /** Resolved backend for accent colour, label, and model-settings lookup. */
  agent: CollaborationAgent;
  lane: CollabConnectorAnchor;
  /** Connector origin override when the reviewed lane differs from the source. */
  sourceLaneOverride?: CollabConnectorAnchor;
  /** Row id for section grouping (mirrors the finished-card row ids). */
  rowId: string;
  rowKind: string;
  /** Pending drafts join the existing parallel drafts row; others get a row. */
  mergeIntoDraftsRow: boolean;
  /** Phase eyebrow, matching the finished card's header. */
  eyebrow: string;
  /** Animated status label (e.g. "reviewing Claude's draft"). */
  statusText: string;
  round?: number;
  /** Skeleton line count in the card body. */
  lines: number;
}

/** Resolves a flow agent's backend for accent colour and labels. */
type BackendOf = (flowAgent: CollaborationFlowAgent) => CollaborationAgent;

function draftStep(
  flowAgent: CollaborationFlowAgent,
  backendOf: BackendOf,
  lane: CollabConnectorAnchor,
): CollabPendingStep {
  return {
    id:
      flowAgent === "agent_one"
        ? "pending-draft-primary"
        : "pending-draft-secondary",
    kind: "initial_draft",
    flowAgent,
    agent: backendOf(flowAgent),
    lane,
    rowId: "drafts",
    rowKind: "drafts",
    mergeIntoDraftsRow: true,
    eyebrow: "Initial Draft",
    statusText: "drafting",
    lines: 3,
  };
}

function proposedStep(round: number, backendOf: BackendOf): CollabPendingStep {
  return {
    id: `pending-round-${round}-proposed`,
    kind: "proposed_changes",
    flowAgent: "agent_one",
    agent: backendOf("agent_one"),
    lane: "left",
    rowId: `round-${round}-proposed`,
    rowKind: "proposed",
    mergeIntoDraftsRow: false,
    eyebrow: "Proposed changes",
    statusText: "drafting proposed changes",
    round,
    lines: 2,
  };
}

function counterStep(round: number, backendOf: BackendOf): CollabPendingStep {
  return {
    id: `pending-round-${round}-counter`,
    kind: "counter_proposal",
    flowAgent: "agent_two",
    agent: backendOf("agent_two"),
    lane: "right",
    rowId: `round-${round}-counter`,
    rowKind: "counter",
    mergeIntoDraftsRow: false,
    eyebrow: "Counter-proposal",
    statusText: "drafting counter-proposal",
    round,
    lines: 2,
  };
}

function decisionStep(round: number, backendOf: BackendOf): CollabPendingStep {
  return {
    id: `pending-round-${round}-decision`,
    kind: "resolution_decision",
    flowAgent: "agent_one",
    agent: backendOf("agent_one"),
    lane: "full",
    rowId: `round-${round}-decision`,
    rowKind: "decision",
    mergeIntoDraftsRow: false,
    eyebrow: "Resolution",
    statusText: `resolving round ${round}`,
    round,
    lines: 2,
  };
}

function finalStep(backendOf: BackendOf): CollabPendingStep {
  return {
    id: "pending-final-answer",
    kind: "final_answer",
    flowAgent: "agent_one",
    agent: backendOf("agent_one"),
    lane: "full",
    rowId: "final-answer",
    rowKind: "final-answer",
    mergeIntoDraftsRow: false,
    eyebrow: "Final answer",
    statusText: "composing final answer",
    lines: 3,
  };
}

function lastRound(rounds: NegotiationRound[]): NegotiationRound | undefined {
  return rounds[rounds.length - 1];
}

/**
 * The pending (in-flight) cards to append to a passage timeline. Empty unless
 * the passage is actively running (`drafting`/`negotiating`) — a paused passage
 * hands control to the open-conflicts card, and a terminal passage is history.
 */
export function deriveCollabPendingSteps(
  grouped: GroupedArtifacts,
  status: CollabPassageStatus,
  primary: CollaborationAgent,
  agents?: CollabAgentsDisplayMap,
): CollabPendingStep[] {
  if (status !== "drafting" && status !== "negotiating") return [];

  // Configured per-agent backends win (they may name the SAME backend for
  // both agents); the opposite-backend derivation is only the fallback for
  // runs that predate per-agent configs.
  const backendOf: BackendOf = (flowAgent) =>
    agents?.[flowAgent]?.backend ??
    (flowAgent === "agent_one"
      ? primary
      : primary === "claude"
        ? "codex"
        : "claude");

  // Walk the frontier most-advanced-first so a partial snapshot (a later beat
  // present without an earlier one) resolves to the furthest step reached, never
  // to a phantom "still drafting" placeholder.

  // Phase 3 — negotiation rounds: proposed (agent_one) → counter (agent_two) →
  // decision (agent_one) → next round or final.
  const last = lastRound(grouped.rounds);
  if (last) {
    if (last.proposed && !last.counter && !last.decision) {
      return [counterStep(last.round, backendOf)];
    }
    if (last.proposed && last.counter && !last.decision) {
      return [decisionStep(last.round, backendOf)];
    }
    if (last.decision) {
      if (last.decision.next_action === "continue_negotiation") {
        return [proposedStep(last.round + 1, backendOf)];
      }
      if (last.decision.next_action === "final") {
        return [finalStep(backendOf)];
      }
      // ask_user pauses (the open-conflicts card takes over); fail is terminal —
      // neither shows a pending card.
    }
    return [];
  }

  // Phase 2 — cross-review done means agent_one's first proposal is next; not yet
  // means agent_two is still reviewing agent_one's draft (folded review;
  // agent_one's own review lands inside its proposed_changes).
  if (grouped.crossReview) return [proposedStep(1, backendOf)];

  const hasPrimaryDraft = grouped.initialDrafts.some(
    (d) => d.agent === "agent_one",
  );
  const hasSecondaryDraft = grouped.initialDrafts.some(
    (d) => d.agent === "agent_two",
  );
  if (hasPrimaryDraft && hasSecondaryDraft) {
    return [
      {
        id: "pending-cross-review",
        kind: "cross_review",
        flowAgent: "agent_two",
        agent: backendOf("agent_two"),
        lane: "right",
        sourceLaneOverride: "left",
        rowId: "cross-review",
        rowKind: "cross-review",
        mergeIntoDraftsRow: false,
        eyebrow: "Cross-review",
        statusText: `reviewing ${backendLabel(backendOf("agent_one"))}'s draft`,
        lines: 2,
      },
    ];
  }

  // Phase 1 — drafts run in parallel; a lane still missing its draft is an agent
  // still writing.
  const steps: CollabPendingStep[] = [];
  if (!hasPrimaryDraft) steps.push(draftStep("agent_one", backendOf, "left"));
  if (!hasSecondaryDraft) {
    steps.push(draftStep("agent_two", backendOf, "right"));
  }
  return steps;
}
