import type { StatusChipTone } from "@/components/ui/StatusChip";
import {
  modelDisplayLabel,
  backendToneToken,
} from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import type { ContextWaitState } from "./derive-wait-state";
import type { ExecutionContextNodeData } from "./derive-graph";

/**
 * The context node's presentation vocabulary — everything the card says,
 * derived and testable without a DOM. The card's Tailwind class maps stay in
 * the component; what a status is CALLED, what a grade MEANS, who the crew is
 * and how the node names itself to a screen reader live here.
 */

export type NodeStatusKey =
  | "pending"
  | "draft"
  | "running"
  | "validating"
  | "advisory-response"
  | "merging"
  | "awaiting-merge"
  | "completed"
  | "published"
  | "halted"
  | "awaiting-approval"
  | "awaiting-user-input"
  | "skipped";

export interface NodeStatus {
  key: NodeStatusKey;
  label: string;
  /**
   * Whether the node carries the live pulse. Running only: the design reserves
   * the animation for work actually in the implementer's hands, so a context
   * under review or merging keeps its own tone without competing for attention.
   */
  live: boolean;
}

const STATUS_LABEL: Record<NodeStatusKey, string> = {
  pending: "Pending",
  draft: "Draft",
  running: "Running",
  validating: "Validating",
  "advisory-response": "Advisory Response",
  merging: "Merging",
  // Where the work IS, not what it is waiting for: the lane worktree holds it
  // until a join carries it into the session.
  "awaiting-merge": "In lane",
  completed: "Completed",
  published: "Published",
  halted: "Halted",
  "awaiting-approval": "Awaiting approval",
  "awaiting-user-input": "Awaiting Input",
  skipped: "Skipped",
};

/**
 * Engine wait state → node status. `published` arrives here as a DERIVED wait
 * state (a completed context whose lane merge landed), never as a stored
 * context status — nothing in this module writes one.
 */
function statusKeyFor(waitState: ContextWaitState | undefined): NodeStatusKey {
  if (!waitState) return "pending";
  switch (waitState.kind) {
    case "running":
    case "validating":
    case "advisory-response":
    case "merging":
    case "awaiting-merge":
    case "completed":
    case "published":
    case "halted":
    case "awaiting-approval":
    case "awaiting-user-input":
    case "skipped":
      return waitState.kind;
    case "ready":
    case "waiting-for-lane":
    case "waiting-for-join":
    case "waiting-for-capacity":
    case "dependency-blocked":
      return "pending";
  }
}

/**
 * The tone a status carries on a design-system pill. The node card draws its
 * own richer pill (dashed rims for the two "waiting on something else" states),
 * but every OTHER surface that names a context's status — the inspector header
 * above all — reads its colour from here, so the rail and the canvas cannot
 * disagree about what running or halted looks like.
 */
const STATUS_TONE: Record<NodeStatusKey, StatusChipTone> = {
  pending: "neutral",
  draft: "neutral",
  running: "cyan",
  validating: "amber",
  "advisory-response": "cyan",
  merging: "green",
  "awaiting-merge": "green",
  completed: "green",
  published: "green",
  halted: "red",
  "awaiting-approval": "amber",
  "awaiting-user-input": "amber",
  skipped: "neutral",
};

export function contextNodeStatusTone(key: NodeStatusKey): StatusChipTone {
  return STATUS_TONE[key];
}

export function contextNodeStatus(
  mode: ExecutionContextNodeData["mode"],
  waitState: ContextWaitState | undefined,
): NodeStatus {
  const key = mode === "builder" ? "draft" : statusKeyFor(waitState);
  return { key, label: STATUS_LABEL[key], live: key === "running" };
}

export type NodeGradeKey = ContextPlacement["mode"];

export interface NodeGrade {
  key: NodeGradeKey;
  label: string;
  /** The design's tooltip copy, verbatim. */
  title: string;
}

export const CONTEXT_GRADE: Record<NodeGradeKey, NodeGrade> = {
  full: {
    key: "full",
    label: "full",
    title:
      "Full access — writes anywhere in the lane worktree; requires exclusive occupancy while it runs",
  },
  owned: {
    key: "owned",
    label: "owning",
    title:
      "Owning — writes only inside its declared paths; runs beside members with disjoint paths",
  },
  readOnly: {
    key: "readOnly",
    label: "read-only",
    title: "Read-only — writes nothing; delivers through its output schema",
  },
};

export function contextNodeGrade(placement: ContextPlacement): NodeGrade {
  return CONTEXT_GRADE[placement.mode];
}

/** The declared owned paths as the chip renders them; empty for other grades. */
export function ownedPathsText(placement: ContextPlacement): string {
  return placement.mode === "owned" ? placement.ownedPaths.join(", ") : "";
}

export interface NodeCrewImplementer {
  backend: AgentBackendId;
  /** The catalog's canonical long name — never the short selector id. */
  modelLabel: string;
  effort: string;
}

export interface NodeCrewSeat {
  seatId: string;
  authority: "blocking" | "advisory";
  backend: AgentBackendId;
  modelLabel: string;
}

export interface NodeCrew {
  implementer: NodeCrewImplementer | null;
  seats: NodeCrewSeat[];
}

/**
 * The crew ledger: who implements this context and who reviews it. A DISABLED
 * cohort contributes no seats — its dormant assignments survive in the config
 * so it can be re-enabled losslessly, but nobody is reviewing right now and the
 * card must not imply otherwise.
 */
export function contextNodeCrew(
  context: ExecutionContextNodeData["context"],
): NodeCrew {
  const implementer = context.implementer;
  const cohort = context.contextValidator;
  return {
    implementer: implementer
      ? {
          backend: implementer.agent.backend,
          modelLabel: modelDisplayLabel(
            implementer.agent.backend,
            implementer.agent.model,
          ),
          effort: implementer.agent.reasoningEffort,
        }
      : null,
    seats:
      cohort?.enabled === true
        ? cohort.assignments.map((assignment) => ({
            seatId: assignment.id,
            authority: assignment.authority,
            backend: assignment.agent.backend,
            modelLabel: modelDisplayLabel(
              assignment.agent.backend,
              assignment.agent.model,
            ),
          }))
        : [],
  };
}

/** Codex is violet; everything else is cyan (design-system rule). */
export function backendIsCodexToned(backend: AgentBackendId): boolean {
  return backendToneToken(backend) === "violet";
}

export interface NodeNotice {
  tone: "amber" | "red" | "cyan";
  text: string;
}

/**
 * The card's notice block: the one sentence that explains a state the status
 * pill cannot. Only states derivable from the node's own data produce one —
 * a halt's recorded reason lives on the halt card, and the notice points there
 * rather than paraphrasing something it does not have.
 */
export function contextNodeNotice(input: {
  placement: ContextPlacement;
  waitState: ContextWaitState | undefined;
}): NodeNotice | null {
  const { placement, waitState } = input;
  if (!waitState) return null;

  if (waitState.kind === "halted") {
    // Cyan is the working tone everywhere else on the card, and that is the
    // point: a halt with an agent on it is not a halt the operator has to
    // answer, and the red notice would send them to act on one that is
    // already being repaired.
    return waitState.repairInFlight
      ? {
          tone: "cyan",
          text: "Halted — a repair agent is working on it. The run resumes on its own if the repair lands.",
        }
      : {
          tone: "red",
          text: "Halted — open the context for the recorded reason.",
        };
  }

  // Concurrency explained where it bites: several owning members share a lane
  // when their paths are disjoint, but a full member needs the lane to itself.
  if (waitState.kind === "waiting-for-lane" && placement.mode === "full") {
    return {
      tone: "amber",
      text: `Full grade — waits for exclusive occupancy of ${placement.lane}.`,
    };
  }

  if (waitState.kind === "dependency-blocked" && waitState.blockedByApproval) {
    return {
      tone: "amber",
      text: "Blocked — an upstream context is awaiting your approval.",
    };
  }

  return null;
}

export interface ContextNodeAriaInput {
  title: string;
  status: NodeStatus;
  laneName: string;
  grade: NodeGrade;
  ownedPaths: string;
  completedTaskCount: number;
  totalTaskCount: number;
  crew: NodeCrew;
  /** Blocks this context overrides at its own tier, e.g. `implementer`. */
  configOverrides: readonly string[];
}

/**
 * The node's accessible name. Everything the card shows visually is in here —
 * including WHY the set-on-this-context marker is lit, which must not be
 * hover-only.
 */
export function contextNodeAriaLabel(input: ContextNodeAriaInput): string {
  const parts = [
    `${input.title} — ${input.status.label}`,
    `lane ${input.laneName}`,
    input.ownedPaths
      ? `${input.grade.label} (${input.ownedPaths})`
      : input.grade.label,
  ];

  if (input.totalTaskCount > 0) {
    parts.push(`${input.completedTaskCount} of ${input.totalTaskCount} tasks`);
  }

  const implementer = input.crew.implementer;
  if (implementer) {
    const provenance =
      input.configOverrides.length > 0
        ? `set on this context: ${input.configOverrides.join(", ")}`
        : "inherited";
    parts.push(
      `implementer ${implementer.modelLabel} ${implementer.effort}`,
      provenance,
    );
  }

  return parts.join(", ");
}
