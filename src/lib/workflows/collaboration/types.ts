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
 */

import { z } from "zod";

export {
  type CollaborationArtifactAgreement,
  type CollaborationArtifactDisagreement,
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

const REFERENCE_JSON_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["artifact"],
      properties: {
        artifact: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["artifact", "locator"],
      properties: {
        artifact: { type: "string", minLength: 1 },
        locator: { type: "string", minLength: 1 },
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
        id: { type: "string", minLength: 1 },
        claim: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "claim", "ref"],
      properties: {
        id: { type: "string", minLength: 1 },
        claim: { type: "string", minLength: 1 },
        ref: REFERENCE_JSON_SCHEMA,
      },
    },
  ],
} as const;

const DISAGREEMENT_BASE_PROPERTIES = {
  id: { type: "string", minLength: 1 },
  category: { type: "string", enum: ["objective", "implementation"] },
  severity: { type: "string", enum: ["minor", "major", "blocking"] },
  claim: { type: "string", minLength: 1 },
  reason: { type: "string", minLength: 1 },
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
        "proposedResolution",
      ],
      properties: {
        ...DISAGREEMENT_BASE_PROPERTIES,
        proposedResolution: { type: "string", minLength: 1 },
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
        "proposedResolution",
        "ref",
      ],
      properties: {
        ...DISAGREEMENT_BASE_PROPERTIES,
        proposedResolution: { type: "string", minLength: 1 },
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
    change: { type: "string", minLength: 1 },
    because: { type: "string", minLength: 1 },
  },
} as const;

const CHANGE_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "change", "rationale", "addressesDisagreementIds"],
  properties: {
    id: { type: "string", minLength: 1 },
    change: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    addressesDisagreementIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const USER_QUESTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "question", "relatedDisagreementIds"],
  properties: {
    id: { type: "string", minLength: 1 },
    question: { type: "string", minLength: 1 },
    relatedDisagreementIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const RESOLVED_DISAGREEMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "disagreementId",
    "resolution",
    "resolvedAutonomously",
    "rationale",
  ],
  properties: {
    disagreementId: { type: "string", minLength: 1 },
    resolution: { type: "string", minLength: 1 },
    resolvedAutonomously: { type: "boolean" },
    rationale: { type: "string", minLength: 1 },
  },
} as const;

const FLOW_AGENT_JSON_SCHEMA = {
  type: "string",
  enum: ["agent_one", "agent_two"],
} as const;

const STRING_LIST_JSON_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1 },
} as const;

export const COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "agent",
    "narrative",
    "report",
    "supporting",
    "assumptions",
    "keyClaims",
  ],
  properties: {
    kind: { type: "string", enum: ["initial_draft"] },
    agent: FLOW_AGENT_JSON_SCHEMA,
    narrative: { type: "string", minLength: 1 },
    report: { type: "string", minLength: 1 },
    supporting: STRING_LIST_JSON_SCHEMA,
    assumptions: STRING_LIST_JSON_SCHEMA,
    keyClaims: { type: "array", items: AGREEMENT_JSON_SCHEMA },
  },
} as const;

export const COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "agent",
    "targetAgent",
    "narrative",
    "report",
    "supporting",
    "agree",
    "disagree",
    "reviseSelf",
  ],
  properties: {
    kind: { type: "string", enum: ["cross_review"] },
    agent: FLOW_AGENT_JSON_SCHEMA,
    targetAgent: FLOW_AGENT_JSON_SCHEMA,
    narrative: { type: "string", minLength: 1 },
    report: { type: "string", minLength: 1 },
    supporting: STRING_LIST_JSON_SCHEMA,
    agree: { type: "array", items: AGREEMENT_JSON_SCHEMA },
    disagree: { type: "array", items: DISAGREEMENT_JSON_SCHEMA },
    reviseSelf: { type: "array", items: REVISE_SELF_JSON_SCHEMA },
  },
} as const;

export const COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "agent",
    "targetAgent",
    "narrative",
    "acceptedFromAgentTwoDraft",
    "proposedChanges",
    "remainingDisagreements",
    "report",
    "supporting",
  ],
  properties: {
    kind: { type: "string", enum: ["proposed_changes"] },
    agent: { type: "string", enum: ["agent_one"] },
    targetAgent: { type: "string", enum: ["agent_two"] },
    narrative: { type: "string", minLength: 1 },
    acceptedFromAgentTwoDraft: {
      type: "array",
      items: AGREEMENT_JSON_SCHEMA,
    },
    proposedChanges: { type: "array", items: CHANGE_PROPOSAL_JSON_SCHEMA },
    remainingDisagreements: {
      type: "array",
      items: DISAGREEMENT_JSON_SCHEMA,
    },
    report: { type: "string", minLength: 1 },
    supporting: STRING_LIST_JSON_SCHEMA,
  },
} as const;

export const COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "agent",
    "narrative",
    "acceptedProposedChangeIds",
    "rejectedProposedChangeIds",
    "alternativeChanges",
    "agree",
    "disagree",
    "report",
    "supporting",
  ],
  properties: {
    kind: { type: "string", enum: ["counter_proposal"] },
    agent: { type: "string", enum: ["agent_two"] },
    narrative: { type: "string", minLength: 1 },
    acceptedProposedChangeIds: STRING_LIST_JSON_SCHEMA,
    rejectedProposedChangeIds: STRING_LIST_JSON_SCHEMA,
    alternativeChanges: { type: "array", items: CHANGE_PROPOSAL_JSON_SCHEMA },
    agree: { type: "array", items: AGREEMENT_JSON_SCHEMA },
    disagree: { type: "array", items: DISAGREEMENT_JSON_SCHEMA },
    report: { type: "string", minLength: 1 },
    supporting: STRING_LIST_JSON_SCHEMA,
  },
} as const;

export const COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "agent",
    "agreementReached",
    "nextAction",
    "acceptedPoints",
    "resolvedDisagreements",
    "remainingDisagreements",
    "userQuestions",
    "rationale",
  ],
  properties: {
    kind: { type: "string", enum: ["resolution_decision"] },
    agent: { type: "string", enum: ["agent_one"] },
    agreementReached: { type: "boolean" },
    nextAction: {
      type: "string",
      enum: ["final", "continue_negotiation", "ask_user", "fail"],
    },
    acceptedPoints: { type: "array", items: AGREEMENT_JSON_SCHEMA },
    resolvedDisagreements: {
      type: "array",
      items: RESOLVED_DISAGREEMENT_JSON_SCHEMA,
    },
    remainingDisagreements: {
      type: "array",
      items: DISAGREEMENT_JSON_SCHEMA,
    },
    userQuestions: { type: "array", items: USER_QUESTION_JSON_SCHEMA },
    rationale: { type: "string", minLength: 1 },
  },
} as const;

export const COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "agent", "answer", "report", "supporting"],
  properties: {
    kind: { type: "string", enum: ["final_answer"] },
    agent: { type: "string", enum: ["agent_one"] },
    answer: { type: "string", minLength: 1 },
    report: { type: "string", minLength: 1 },
    supporting: STRING_LIST_JSON_SCHEMA,
  },
} as const;
