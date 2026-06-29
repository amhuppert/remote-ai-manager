/**
 * Collaboration Mode types.
 *
 * The wire-shape contracts — the asymmetric per-artifact outputs every
 * participating agent emits — live in `src/lib/schemas.ts` and are
 * documented in `memory-bank/COLLABORATION_MODE_FLOW.md`. This module
 * re-exports them so feature code keeps a stable import site, adds the
 * lane-identity enum that is internal to the orchestrator, and projects
 * each artifact schema to a JSON Schema constant for backends that enforce
 * structured output natively.
 *
 * IMPORTANT: these JSON Schema constants are handed to Claude's native
 * structured-output enforcement (`outputFormat: { type: "json_schema" }`),
 * which does NOT support `minLength`/`maxLength`/`minItems`/`maxItems`/
 * `minimum`/`maximum`/`pattern`. It validates output against such keywords but
 * cannot steer generation to satisfy them, so including them makes the
 * claude_code backend loop and fail ("Failed to provide valid structured
 * output after N attempts"). Keep these projections to the supported subset
 * (types, `enum`, `anyOf`, `required`, `additionalProperties: false`); express
 * bounds in field descriptions and enforce them in the Zod `safeParse` instead.
 * See docs/structured-data-responses.md.
 */

import { z } from "zod";

export {
  type CollaborationArtifactAgreement,
  type CollaborationArtifactDisagreement,
  type CollaborationAgentArtifactPhase,
  collaborationArtifactSchema,
  type CollaborationArtifact,
  collaborationAutonomousResolutionThresholdSchema,
  type CollaborationAutonomousResolutionThreshold,
  type CollaborationChangeProposal,
  collaborationCounterProposalOutputSchema,
  type CollaborationCounterProposalOutput,
  collaborationCrossReviewOutputSchema,
  type CollaborationCrossReviewOutput,
  type CollaborationDisagreementCategory,
  type CollaborationDisagreementSeverity,
  collaborationFinalAnswerOutputSchema,
  type CollaborationFinalAnswerOutput,
  type CollaborationFlowAgent,
  collaborationGeneratedArtifactSchema,
  type CollaborationGeneratedArtifact,
  type CollaborationGeneratedArtifactType,
  collaborationInitialDraftOutputSchema,
  type CollaborationInitialDraftOutput,
  collaborationOpenConflictsOutputSchema,
  type CollaborationOpenConflictsOutput,
  collaborationProposedChangesOutputSchema,
  type CollaborationProposedChangesOutput,
  type CollaborationReference,
  type CollaborationReviseSelfArtifact,
  type CollaborationResolvedDisagreement,
  type CollaborationResolutionDecisionNextAction,
  collaborationResolutionDecisionOutputSchema,
  type CollaborationResolutionDecisionOutput,
  type CollaborationUserQuestion,
} from "@/lib/workflows/schemas";

const collaborationAgentSchema = z.enum(["claude", "codex"]);
export type CollaborationAgent = z.infer<typeof collaborationAgentSchema>;

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

const FLOW_AGENT_JSON_SCHEMA = {
  type: "string",
  enum: ["agent_one", "agent_two"],
} as const;

const SHORT_ID_LIST_JSON_SCHEMA = {
  type: "array",
  items: SHORT_ID_JSON_SCHEMA,
} as const;

const AGENT_ARTIFACT_PHASE_JSON_SCHEMA = {
  type: "string",
  enum: [
    "initial_draft",
    "cross_review",
    "proposed_changes",
    "counter_proposal",
    "resolution_decision",
    "final_answer",
  ],
} as const;

const GENERATED_ARTIFACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "artifact_type",
    "path",
    "round",
    "agent",
    "phase",
    "summary",
  ],
  properties: {
    id: SHORT_ID_JSON_SCHEMA,
    artifact_type: {
      type: "string",
      enum: ["main_response", "audit", "supporting"],
      description:
        "Type of generated markdown file. main_response contains the substantive phase response.",
    },
    path: ARTIFACT_PATH_JSON_SCHEMA,
    round: {
      type: "integer",
      description: "Collaboration round that generated this file.",
    },
    agent: FLOW_AGENT_JSON_SCHEMA,
    phase: AGENT_ARTIFACT_PHASE_JSON_SCHEMA,
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

export const COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "agent",
    "round",
    "summary",
    "artifacts",
    "assumptions",
    "key_claims",
  ],
  properties: {
    kind: { type: "string", enum: ["initial_draft"] },
    agent: FLOW_AGENT_JSON_SCHEMA,
    round: { type: "integer" },
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
  required: [
    "kind",
    "agent",
    "target_agent",
    "round",
    "summary",
    "artifacts",
    "agree",
    "disagree",
    "revise_self",
  ],
  properties: {
    kind: { type: "string", enum: ["cross_review"] },
    agent: FLOW_AGENT_JSON_SCHEMA,
    target_agent: FLOW_AGENT_JSON_SCHEMA,
    round: { type: "integer" },
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
    "kind",
    "agent",
    "target_agent",
    "round",
    "summary",
    "artifacts",
    "accepted_from_other_agent_draft",
    "proposed_changes",
    "remaining_disagreements",
  ],
  properties: {
    kind: { type: "string", enum: ["proposed_changes"] },
    agent: { type: "string", enum: ["agent_one"] },
    target_agent: { type: "string", enum: ["agent_two"] },
    round: { type: "integer" },
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
    "kind",
    "agent",
    "target_agent",
    "round",
    "summary",
    "artifacts",
    "accepted_change_ids",
    "rejected_change_ids",
    "alternative_changes",
    "agree",
    "disagree",
  ],
  properties: {
    kind: { type: "string", enum: ["counter_proposal"] },
    agent: { type: "string", enum: ["agent_two"] },
    target_agent: { type: "string", enum: ["agent_one"] },
    round: { type: "integer" },
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
    "kind",
    "agent",
    "target_agent",
    "round",
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
    kind: { type: "string", enum: ["resolution_decision"] },
    agent: { type: "string", enum: ["agent_one"] },
    target_agent: { type: "string", enum: ["agent_two"] },
    round: { type: "integer" },
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
  required: [
    "kind",
    "agent",
    "round",
    "summary",
    "artifacts",
    "answer_artifact_id",
    "audit_artifact_id",
  ],
  properties: {
    kind: { type: "string", enum: ["final_answer"] },
    agent: { type: "string", enum: ["agent_one"] },
    round: { type: "integer" },
    summary: SUMMARY_JSON_SCHEMA,
    artifacts: GENERATED_ARTIFACT_LIST_JSON_SCHEMA,
    answer_artifact_id: { type: "string", enum: ["answer"] },
    audit_artifact_id: { type: "string", enum: ["audit"] },
  },
} as const;
