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
import { agentBackendSchema } from "@/lib/shared/schemas";

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
  type CollaborationCounterProposalContent,
  collaborationCounterProposalOutputSchema,
  type CollaborationCounterProposalOutput,
  collaborationCrossReviewContentSchema,
  type CollaborationCrossReviewContent,
  collaborationCrossReviewOutputSchema,
  type CollaborationCrossReviewOutput,
  type CollaborationDisagreementCategory,
  type CollaborationDisagreementSeverity,
  collaborationFinalAnswerContentSchema,
  type CollaborationFinalAnswerContent,
  collaborationFinalAnswerOutputSchema,
  type CollaborationFinalAnswerOutput,
  type CollaborationFlowAgent,
  collaborationGeneratedArtifactSchema,
  type CollaborationGeneratedArtifact,
  type CollaborationGeneratedArtifactType,
  collaborationInitialDraftContentSchema,
  type CollaborationInitialDraftContent,
  collaborationInitialDraftOutputSchema,
  type CollaborationInitialDraftOutput,
  collaborationOpenConflictsOutputSchema,
  type CollaborationOpenConflictsOutput,
  collaborationProposedChangesContentSchema,
  type CollaborationProposedChangesContent,
  collaborationProposedChangesOutputSchema,
  type CollaborationProposedChangesOutput,
  type CollaborationReference,
  type CollaborationReviseSelfArtifact,
  type CollaborationResolvedDisagreement,
  type CollaborationResolutionDecisionNextAction,
  collaborationResolutionDecisionContentSchema,
  type CollaborationResolutionDecisionContent,
  collaborationResolutionDecisionOutputSchema,
  type CollaborationResolutionDecisionOutput,
  type CollaborationUserQuestion,
} from "@/lib/workflow-graph/collaboration-schemas";

const collaborationAgentSchema = agentBackendSchema;
export type CollaborationAgent = z.infer<typeof collaborationAgentSchema>;

/**
 * The model + reasoning effort a collaboration lane runs with, resolved by
 * the manager (request override for the primary lane, global config for the
 * other). Persisted into the envelope's feature snapshot so the UI can show
 * which model produced each artifact.
 */
export const collaborationAgentModelSettingsSchema = z.object({
  model: z.string(),
  effort: z.string().optional(),
});
export type CollaborationAgentModelSettings = z.infer<
  typeof collaborationAgentModelSettingsSchema
>;

export const collaborationAgentModelSettingsMapSchema = z.object({
  claude: collaborationAgentModelSettingsSchema,
  codex: collaborationAgentModelSettingsSchema,
});
export type CollaborationAgentModelSettingsMap = z.infer<
  typeof collaborationAgentModelSettingsMapSchema
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
