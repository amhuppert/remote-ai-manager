/**
 * Collaboration Mode types.
 *
 * The wire-shape contracts — the asymmetric per-artifact outputs every
 * participating agent emits — live in
 * `src/lib/workflow-graph/collaboration-schemas.ts` and are documented in
 * `memory-bank/COLLABORATION_MODE_FLOW.md`. This module re-exports them so
 * feature code keeps a stable import site, adds the lane-identity enum that is
 * internal to the orchestrator, and derives provider-neutral JSON Schema
 * constants for `AgentCallRequest.outputSchema`. Backend adapters choose how to
 * transport the complete contract; the shared gate owns normalized acceptance.
 * See docs/structured-data-responses.md.
 */

import { z } from "zod";
import {
  agentProfileRefSchema,
  agentProfileSnapshotSchema,
} from "@/lib/agent-profiles/schemas";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import {
  backendLabel,
  findBackendCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import {
  backendFacetRefusal,
  type GatedBackendFacet,
} from "@/lib/agent-backends/facet-gating";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { CollaborationFlowAgent } from "@/lib/workflow-graph/collaboration-schemas";

export {
  type CollaborationArtifactAgreement,
  type CollaborationArtifactDisagreement,
  type CollaborationAgentArtifactPhase,
  collaborationArtifactSchema,
  type CollaborationArtifact,
  collaborationAutonomousResolutionThresholdSchema,
  type CollaborationAutonomousResolutionThreshold,
  type CollaborationChangeProposal,
  collaborationCounterProposalContentSchema,
  collaborationCounterProposalOutputSchema,
  type CollaborationCounterProposalOutput,
  collaborationCrossReviewContentSchema,
  collaborationCrossReviewOutputSchema,
  type CollaborationCrossReviewOutput,
  type CollaborationDisagreementCategory,
  type CollaborationDisagreementSeverity,
  collaborationFinalAnswerContentSchema,
  collaborationFinalAnswerOutputSchema,
  type CollaborationFinalAnswerOutput,
  type CollaborationFlowAgent,
  type CollaborationGeneratedArtifact,
  collaborationInitialDraftContentSchema,
  type CollaborationInitialDraftContent,
  collaborationInitialDraftOutputSchema,
  type CollaborationInitialDraftOutput,
  collaborationOpenConflictsOutputSchema,
  type CollaborationOpenConflictsOutput,
  collaborationProposedChangesContentSchema,
  collaborationProposedChangesOutputSchema,
  type CollaborationProposedChangesOutput,
  type CollaborationReference,
  type CollaborationReviseSelfArtifact,
  type CollaborationResolvedDisagreement,
  type CollaborationResolutionDecisionNextAction,
  collaborationResolutionDecisionContentSchema,
  collaborationResolutionDecisionOutputSchema,
  type CollaborationResolutionDecisionOutput,
  type CollaborationUserQuestion,
} from "@/lib/workflow-graph/collaboration-schemas";

/**
 * The backends Collaboration Mode runs — the ONE documented product-policy site
 * for participation.
 *
 * Participation is explicit product policy, not "whatever is registered": the
 * flow's cross-review, disagreement, and resolution contracts are evidenced per
 * participant before it is listed here, and its cards carry a catalog-owned
 * accent for each. A newly registered backend is therefore ineligible until its
 * participation is separately evidenced — registering a task runner alone
 * admits nothing — and this enum is what refuses it, at the schema boundary as
 * a bounded client error rather than by an identity branch spread across the
 * orchestrator and every card.
 *
 * Every participant may take either flow-agent position, including alongside
 * itself; `COLLABORATION_SUPPORTED_PAIRS` in ./backend-pair.ts writes that
 * matrix out explicitly, and `COLLABORATION_DEFAULT_PARTNER` there names the
 * suggested partner for each. Cursor's limits are the Cursor adapter's:
 * filesystem and network limits reach it as instructions rather than
 * enforcement, and it reports token usage without a cost figure.
 */
export const collaborationAgentSchema = z.enum(["claude", "codex", "cursor"]);
export type CollaborationAgent = z.infer<typeof collaborationAgentSchema>;

/** Whether a registered backend may participate in Collaboration Mode. */
export function isCollaborationAgent(
  backend: AgentBackendId,
): backend is CollaborationAgent {
  return collaborationAgentSchema.safeParse(backend).success;
}

/**
 * The backend as a collaboration agent, or null when it is not one. Null is the
 * signal UI surfaces gate on: a conversation whose backend cannot collaborate
 * offers no collaboration affordance rather than one that fails on submit.
 */
export function asCollaborationAgent(
  backend: AgentBackendId,
): CollaborationAgent | null {
  return isCollaborationAgent(backend) ? backend : null;
}

/**
 * A registered backend outside the participation policy was asked to take a
 * lane. Bounded and named rather than substituted: silently swapping in an
 * eligible backend would run a flow the caller did not ask for, and letting
 * the ineligible one through would dispatch a lane whose contracts were never
 * evidenced for it. Thrown before anything durable happens.
 */
export class CollaborationBackendNotEligibleError extends Error {
  constructor(
    public readonly agent: CollaborationFlowAgent,
    public readonly backend: AgentBackendId,
  ) {
    super(
      `Backend "${backend}" cannot take the ${agent} lane: Collaboration Mode runs ${listCollaborationAgentLabels()}.`,
    );
    this.name = "CollaborationBackendNotEligibleError";
  }
}

/**
 * Both backends participate but the ordered pair is outside the supported
 * matrix (`COLLABORATION_SUPPORTED_PAIRS`). Unreachable while every ordered
 * pair is admitted; kept as the bounded refusal the matrix would produce.
 */
export class CollaborationPairNotSupportedError extends Error {
  constructor(
    public readonly agentOneBackend: CollaborationAgent,
    public readonly agentTwoBackend: CollaborationAgent,
    reason: string,
  ) {
    super(reason);
    this.name = "CollaborationPairNotSupportedError";
  }
}

/** The backend narrowed to a collaboration agent for `agent`'s lane, or a
 *  {@link CollaborationBackendNotEligibleError}. */
export function requireCollaborationAgent(
  agent: CollaborationFlowAgent,
  backend: AgentBackendId,
): CollaborationAgent {
  if (!isCollaborationAgent(backend)) {
    throw new CollaborationBackendNotEligibleError(agent, backend);
  }
  return backend;
}

/** "Claude, Codex, and Cursor" — the participants as prose, for refusals. */
function listCollaborationAgentLabels(): string {
  const labels = collaborationAgentSchema.options.map(backendLabel);
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Why a registered backend is outside the participation policy, or null when
 * it is in it. The policy half of {@link collaborationBackendAdmission}.
 */
export function collaborationAgentRefusal(
  backend: AgentBackendId,
): string | null {
  if (isCollaborationAgent(backend)) return null;
  const label = findBackendCatalogEntry(backend)?.label ?? backend;
  return `${label} cannot take a Collaboration Mode lane: collaboration runs ${listCollaborationAgentLabels()} only`;
}

/**
 * How a participant's lane is dispatched through AgentCall. The one place that
 * decides it: `callPrimitive` (./helpers.ts) builds the request from this, and
 * the admission below gates on the facet the dispatch actually uses.
 *
 * Claude lanes are conversation turns so Agent One can resume the originating
 * Claude conversation with its full context and hold background subagents open.
 * Every other participant runs as a task: the task runners already own resume
 * (Codex threads, Cursor task refs bound to the originating conversation when
 * the run grants it), governance delivery, and structured-output transport for
 * their provider.
 */
export type CollaborationLaneDispatch = "conversation_turn" | "task_run";

export const COLLABORATION_LANE_DISPATCH: Readonly<
  Record<CollaborationAgent, CollaborationLaneDispatch>
> = {
  claude: "conversation_turn",
  codex: "task_run",
  cursor: "task_run",
};

export function collaborationLaneDispatch(
  backend: CollaborationAgent,
): CollaborationLaneDispatch {
  return COLLABORATION_LANE_DISPATCH[backend];
}

/** The catalog facet a participant's lane dispatch needs. */
export function collaborationLaneFacet(
  backend: CollaborationAgent,
): GatedBackendFacet {
  return collaborationLaneDispatch(backend) === "conversation_turn"
    ? "conversation"
    : "tasks";
}

/**
 * Whether a registered backend can take a collaboration lane, and if not, which
 * of the two independent gates refused it:
 *
 *  - `pair_policy` — the backend is outside the participation list. Asked
 *    first: a backend the policy does not run has no lane dispatch, so no facet
 *    question even applies to it.
 *  - `facet` — the backend participates, but its catalog entry lacks the
 *    facet its lane dispatch uses (the same `backendFacetRefusal` the task and
 *    workflow-role pickers read, spec D13).
 *
 * The one decision the picker's disabled reason, the start route's error code,
 * and the manager's admission all read, so none of them can disagree.
 */
export type CollaborationBackendAdmission =
  | { ok: true }
  | { ok: false; cause: "pair_policy" | "facet"; reason: string };

export function collaborationBackendAdmission(
  entry: BackendCatalogEntry,
): CollaborationBackendAdmission {
  const agent = asCollaborationAgent(entry.id);
  if (agent === null) {
    return {
      ok: false,
      cause: "pair_policy",
      reason: `${entry.label} cannot take a Collaboration Mode lane: collaboration runs ${listCollaborationAgentLabels()} only`,
    };
  }
  const facetRefusal = backendFacetRefusal(
    entry,
    collaborationLaneFacet(agent),
  );
  if (facetRefusal !== null) {
    return {
      ok: false,
      cause: "facet",
      reason: `${facetRefusal}, so it cannot take a Collaboration Mode lane`,
    };
  }
  return { ok: true };
}

/**
 * Why a registered backend cannot take a collaboration lane, or null when it
 * can — the one text a collaboration picker shows on a refused option and its
 * API returns. See {@link collaborationBackendAdmission} for the two causes.
 */
export function collaborationBackendRefusal(
  entry: BackendCatalogEntry,
): string | null {
  const admission = collaborationBackendAdmission(entry);
  return admission.ok ? null : admission.reason;
}

export type CollaborationAgentModelSettings = BackendModelSelection;

/**
 * One flow agent's fully resolved runtime, persisted into the envelope's
 * feature snapshot at start and replayed verbatim on resume. The selection is
 * complete and indivisible; no resume path may reconstruct it from current
 * defaults. `profileSnapshot` is the agent-profile snapshot the lane is
 * staffed with, when one was assigned.
 */
export const collaborationResolvedAgentSchema = z.object({
  backend: collaborationAgentSchema,
  modelSelection: backendModelSelectionSchema,
  profileSnapshot: agentProfileSnapshotSchema.optional(),
});
export type CollaborationResolvedAgent = z.infer<
  typeof collaborationResolvedAgentSchema
>;

/** Both flow agents' resolved runtimes, keyed by flow-agent id. */
export const collaborationAgentsMapSchema = z.object({
  agent_one: collaborationResolvedAgentSchema,
  agent_two: collaborationResolvedAgentSchema,
});
export type CollaborationAgentsMap = z.infer<
  typeof collaborationAgentsMapSchema
>;

/**
 * Agent Two's explicit start-request configuration. The optional selection is
 * a whole value: absent resolves from that backend's configured default, while
 * present replaces it entirely and is validated against the backend catalog.
 */
export const collaborationAgentTwoRequestSchema = z
  .object({
    backend: collaborationAgentSchema,
    modelSelection: backendModelSelectionSchema.optional(),
    profile: agentProfileRefSchema.optional(),
    model: z.never().optional(),
    reasoningEffort: z.never().optional(),
    fastMode: z.never().optional(),
  })
  .strict();
export type CollaborationAgentTwoRequest = z.infer<
  typeof collaborationAgentTwoRequestSchema
>;

const SHORT_TEXT_DESCRIPTION =
  "Short plain-text field only, ideally under ~500 characters. Do not include full prose, markdown tables, code blocks, XML/HTML, or generated file contents. Put substantive content in the generated artifact files.";

const SHORT_STRING_JSON_SCHEMA = {
  type: "string",
  description: SHORT_TEXT_DESCRIPTION,
} as const;

const SHORT_ID_JSON_SCHEMA = {
  type: "string",
  description: "Short stable identifier; keep it under ~80 characters.",
} as const;

const ARTIFACT_PATH_JSON_SCHEMA = {
  type: "string",
  description:
    "Relative POSIX markdown path under memory-bank/collaboration/<workflowId>/, under ~512 characters; never include file contents.",
} as const;

const SUMMARY_JSON_SCHEMA = {
  type: "string",
  description: SHORT_TEXT_DESCRIPTION,
} as const;

const REFERENCE_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["artifact"],
      properties: {
        artifact: ARTIFACT_PATH_JSON_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["artifact", "locator"],
      properties: {
        artifact: ARTIFACT_PATH_JSON_SCHEMA,
        locator: {
          type: "string",
          description:
            "Short locator within the referenced artifact; keep it under ~120 characters.",
        },
      },
    },
  ],
} as const;

const AGREEMENT_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "claim"],
      properties: {
        id: SHORT_ID_JSON_SCHEMA,
        claim: SHORT_STRING_JSON_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "claim", "ref"],
      properties: {
        id: SHORT_ID_JSON_SCHEMA,
        claim: SHORT_STRING_JSON_SCHEMA,
        ref: REFERENCE_JSON_SCHEMA,
      },
    },
  ],
} as const;

const DISAGREEMENT_BASE_PROPERTIES = {
  id: SHORT_ID_JSON_SCHEMA,
  category: {
    type: "string",
    enum: ["objective", "implementation"],
    description:
      "Whether the disagreement is about the user's objective or implementation details.",
  },
  severity: {
    type: "string",
    enum: ["minor", "major", "blocking"],
    description: "Severity used by collaboration policy.",
  },
  claim: SHORT_STRING_JSON_SCHEMA,
  reason: SHORT_STRING_JSON_SCHEMA,
} as const;

const DISAGREEMENT_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "category", "severity", "claim", "reason"],
      properties: { ...DISAGREEMENT_BASE_PROPERTIES },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "category",
        "severity",
        "claim",
        "reason",
        "proposed_resolution",
      ],
      properties: {
        ...DISAGREEMENT_BASE_PROPERTIES,
        proposed_resolution: SHORT_STRING_JSON_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "category", "severity", "claim", "reason", "ref"],
      properties: {
        ...DISAGREEMENT_BASE_PROPERTIES,
        ref: REFERENCE_JSON_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "category",
        "severity",
        "claim",
        "reason",
        "proposed_resolution",
        "ref",
      ],
      properties: {
        ...DISAGREEMENT_BASE_PROPERTIES,
        proposed_resolution: SHORT_STRING_JSON_SCHEMA,
        ref: REFERENCE_JSON_SCHEMA,
      },
    },
  ],
} as const;

const REVISE_SELF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["change", "because"],
  properties: {
    change: SHORT_STRING_JSON_SCHEMA,
    because: SHORT_STRING_JSON_SCHEMA,
  },
} as const;

const CHANGE_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "change", "rationale", "addresses_disagreement_ids"],
  properties: {
    id: SHORT_ID_JSON_SCHEMA,
    change: SHORT_STRING_JSON_SCHEMA,
    rationale: SHORT_STRING_JSON_SCHEMA,
    addresses_disagreement_ids: {
      type: "array",
      items: SHORT_ID_JSON_SCHEMA,
    },
  },
} as const;

const USER_QUESTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "question", "related_disagreement_ids"],
  properties: {
    id: SHORT_ID_JSON_SCHEMA,
    question: SHORT_STRING_JSON_SCHEMA,
    related_disagreement_ids: {
      type: "array",
      items: SHORT_ID_JSON_SCHEMA,
    },
  },
} as const;

const RESOLVED_DISAGREEMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "disagreement_id",
    "resolution",
    "resolved_autonomously",
    "rationale",
  ],
  properties: {
    disagreement_id: SHORT_ID_JSON_SCHEMA,
    resolution: SHORT_STRING_JSON_SCHEMA,
    resolved_autonomously: { type: "boolean" },
    rationale: SHORT_STRING_JSON_SCHEMA,
  },
} as const;

const SHORT_ID_LIST_JSON_SCHEMA = {
  type: "array",
  items: SHORT_ID_JSON_SCHEMA,
} as const;

// round/agent/phase are intentionally absent: the orchestrator owns those for
// every generated artifact (they are always the envelope's round/agent/kind)
// and injects them after parsing, so the model is not asked to echo them.
const GENERATED_ARTIFACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "artifact_type", "path", "summary"],
  properties: {
    id: SHORT_ID_JSON_SCHEMA,
    artifact_type: {
      type: "string",
      enum: ["main_response", "audit", "supporting"],
      description:
        "Type of generated markdown file. main_response contains the substantive phase response.",
    },
    path: ARTIFACT_PATH_JSON_SCHEMA,
    summary: {
      type: "string",
      description:
        "One-line summary of this generated file's contents, under ~300 characters. Do not include the file contents themselves.",
    },
  },
} as const;

const GENERATED_ARTIFACT_LIST_JSON_SCHEMA = {
  type: "array",
  items: GENERATED_ARTIFACT_JSON_SCHEMA,
} as const;

// kind/agent/target_agent/round are intentionally absent from every projection:
// the orchestrator owns this envelope bookkeeping and injects it after parsing
// (see prompt-builders + the collaboration phase files). The model authors only
// the content fields below.
export const COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "artifacts", "assumptions", "key_claims"],
  properties: {
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    assumptions: {
      type: "array",
      items: SHORT_STRING_JSON_SCHEMA,
    },
    key_claims: {
      type: "array",
      items: AGREEMENT_JSON_SCHEMA,
    },
  },
} as const;

export const COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "artifacts", "agree", "disagree", "revise_self"],
  properties: {
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    agree: { type: "array", items: AGREEMENT_JSON_SCHEMA },
    disagree: {
      type: "array",
      items: DISAGREEMENT_JSON_SCHEMA,
    },
    revise_self: {
      type: "array",
      items: REVISE_SELF_JSON_SCHEMA,
    },
  },
} as const;

export const COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "artifacts",
    "accepted_from_other_agent_draft",
    "proposed_changes",
    "remaining_disagreements",
  ],
  properties: {
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    accepted_from_other_agent_draft: {
      type: "array",
      items: AGREEMENT_JSON_SCHEMA,
    },
    proposed_changes: {
      type: "array",
      items: CHANGE_PROPOSAL_JSON_SCHEMA,
    },
    remaining_disagreements: {
      type: "array",
      items: DISAGREEMENT_JSON_SCHEMA,
    },
  },
} as const;

export const COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "artifacts",
    "accepted_change_ids",
    "rejected_change_ids",
    "alternative_changes",
    "agree",
    "disagree",
  ],
  properties: {
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    accepted_change_ids: SHORT_ID_LIST_JSON_SCHEMA,
    rejected_change_ids: SHORT_ID_LIST_JSON_SCHEMA,
    alternative_changes: {
      type: "array",
      items: CHANGE_PROPOSAL_JSON_SCHEMA,
    },
    agree: { type: "array", items: AGREEMENT_JSON_SCHEMA },
    disagree: {
      type: "array",
      items: DISAGREEMENT_JSON_SCHEMA,
    },
  },
} as const;

export const COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "artifacts",
    "agreement_reached",
    "next_action",
    "accepted_points",
    "resolved_disagreements",
    "remaining_disagreements",
    "user_questions",
    "rationale",
  ],
  properties: {
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    agreement_reached: { type: "boolean" },
    next_action: {
      type: "string",
      enum: ["final", "continue_negotiation", "ask_user", "fail"],
    },
    accepted_points: {
      type: "array",
      items: AGREEMENT_JSON_SCHEMA,
    },
    resolved_disagreements: {
      type: "array",
      items: RESOLVED_DISAGREEMENT_JSON_SCHEMA,
    },
    remaining_disagreements: {
      type: "array",
      items: DISAGREEMENT_JSON_SCHEMA,
    },
    user_questions: {
      type: "array",
      items: USER_QUESTION_JSON_SCHEMA,
    },
    rationale: SHORT_STRING_JSON_SCHEMA,
  },
} as const;

export const COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "artifacts", "answer_artifact_id", "audit_artifact_id"],
  properties: {
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    answer_artifact_id: { type: "string", enum: ["answer"] },
    audit_artifact_id: { type: "string", enum: ["audit"] },
  },
} as const;
