/**
 * Tests for the asymmetric Collaboration Mode artifact contract.
 *
 * Each artifact (initial_draft, cross_review, proposed_changes,
 * counter_proposal, resolution_decision, final_answer, open_conflicts) is
 * an independent kind-discriminated record. Tests verify each schema parses
 * a representative fixture, the discriminated-union catch-all parses every
 * kind, and the JSON Schema projection is Codex-strict-compatible.
 */
import { describe, it, expect } from "vitest";
import {
  collaborationArtifactSchema,
  collaborationAutonomousResolutionThresholdSchema,
  collaborationCounterProposalOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationFinalAnswerOutputSchema,
  collaborationInitialDraftOutputSchema,
  collaborationOpenConflictsOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationResolutionDecisionOutputSchema,
  type CollaborationArtifact,
} from "../schemas";
import {
  COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
  COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
  COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
  COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
  COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
} from "./types";

function strictRequiredGaps(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const objectSchema = schema as Record<string, unknown>;
  const gaps: string[] = [];

  if (
    objectSchema["type"] === "object" &&
    objectSchema["properties"] &&
    typeof objectSchema["properties"] === "object" &&
    !Array.isArray(objectSchema["properties"])
  ) {
    const properties = objectSchema["properties"] as Record<string, unknown>;
    const required = new Set(
      Array.isArray(objectSchema["required"])
        ? objectSchema["required"].filter((item) => typeof item === "string")
        : [],
    );
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        gaps.push(`${path}.properties.${key}`);
      }
    }
  }

  for (const key of ["properties", "items", "anyOf"] as const) {
    const child = objectSchema[key];
    if (Array.isArray(child)) {
      child.forEach((entry, idx) => {
        gaps.push(...strictRequiredGaps(entry, `${path}.${key}[${idx}]`));
      });
      continue;
    }
    if (!child || typeof child !== "object") continue;
    if (key === "properties" && !Array.isArray(child)) {
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        gaps.push(
          ...strictRequiredGaps(
            propertySchema,
            `${path}.properties.${propertyName}`,
          ),
        );
      }
      continue;
    }
    gaps.push(...strictRequiredGaps(child, `${path}.${key}`));
  }

  return gaps;
}

function validateAgainstJsonSchema(
  value: unknown,
  schema: unknown,
  path = "$",
): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }
  const objectSchema = schema as Record<string, unknown>;

  if (Array.isArray(objectSchema["anyOf"])) {
    const branches = objectSchema["anyOf"];
    const branchErrors: string[][] = [];
    for (const branch of branches) {
      const errors = validateAgainstJsonSchema(value, branch, path);
      if (errors.length === 0) return [];
      branchErrors.push(errors);
    }
    return [
      `${path}: did not match any anyOf branch (${branchErrors
        .map((errs, idx) => `branch ${idx}: ${errs.join("; ")}`)
        .join(" | ")})`,
    ];
  }

  if (objectSchema["type"] === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected object`];
    }
    const obj = value as Record<string, unknown>;
    const properties =
      (objectSchema["properties"] as Record<string, unknown> | undefined) ?? {};
    const required = Array.isArray(objectSchema["required"])
      ? (objectSchema["required"] as string[])
      : [];
    const errors: string[] = [];
    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`${path}.${key}: missing required property`);
      }
    }
    if (objectSchema["additionalProperties"] === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key}: extraneous property`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in obj) {
        errors.push(
          ...validateAgainstJsonSchema(
            obj[key],
            propertySchema,
            `${path}.${key}`,
          ),
        );
      }
    }
    return errors;
  }

  if (objectSchema["type"] === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const errors: string[] = [];
    value.forEach((item, idx) => {
      errors.push(
        ...validateAgainstJsonSchema(
          item,
          objectSchema["items"],
          `${path}[${idx}]`,
        ),
      );
    });
    return errors;
  }

  if (objectSchema["type"] === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (
      typeof objectSchema["minLength"] === "number" &&
      value.length < (objectSchema["minLength"] as number)
    ) {
      return [`${path}: string shorter than minLength`];
    }
    if (
      Array.isArray(objectSchema["enum"]) &&
      !(objectSchema["enum"] as unknown[]).includes(value)
    ) {
      return [`${path}: not in enum`];
    }
    return [];
  }

  if (objectSchema["type"] === "boolean") {
    if (typeof value !== "boolean") return [`${path}: expected boolean`];
    return [];
  }

  return [];
}

const agreement = {
  id: "A-1",
  claim: "Use the existing session status bus",
  ref: {
    artifact: "memory-bank/collaboration/wf/agent-one/draft.md",
    locator: "#status-bus",
  },
};

const implementationDisagreement = {
  id: "D-1",
  category: "implementation" as const,
  severity: "major" as const,
  claim: "Use a separate queue table",
  reason: "A table would add operational overhead for this workflow",
  proposedResolution: "Reuse the workflow envelope store instead",
  ref: {
    artifact: "memory-bank/collaboration/wf/agent-two/review.md",
  },
};

const objectiveDisagreement = {
  id: "D-2",
  category: "objective" as const,
  severity: "blocking" as const,
  claim: "The user asked for a design, not an implementation",
  reason: "The scope changes which artifacts should be produced",
};

const initialDraft = {
  kind: "initial_draft" as const,
  agent: "agent_one" as const,
  narrative: "Initial primary proposal.",
  report: "memory-bank/collaboration/wf/initial/agent-one.md",
  supporting: [],
  assumptions: ["The final answer should stay in the conversation."],
  keyClaims: [agreement],
};

const crossReview = {
  kind: "cross_review" as const,
  agent: "agent_two" as const,
  targetAgent: "agent_one" as const,
  narrative: "Agent Two review of Agent One's draft.",
  report: "memory-bank/collaboration/wf/cross-review/agent-two.md",
  supporting: [],
  agree: [agreement],
  disagree: [implementationDisagreement],
  reviseSelf: [
    {
      change: "Adopt the existing notification path",
      because: "It avoids introducing a second delivery mechanism",
    },
  ],
};

const proposedChanges = {
  kind: "proposed_changes" as const,
  agent: "agent_one" as const,
  targetAgent: "agent_two" as const,
  narrative: "Primary proposed changes after reading Agent Two's draft.",
  acceptedFromAgentTwoDraft: [agreement],
  proposedChanges: [
    {
      id: "PC-1",
      change: "Use the envelope store for progress snapshots",
      rationale: "Both UI and backend already consume it",
      addressesDisagreementIds: ["D-1"],
    },
  ],
  remainingDisagreements: [implementationDisagreement],
  report: "memory-bank/collaboration/wf/negotiation-1/proposed.md",
  supporting: [],
};

const counterProposal = {
  kind: "counter_proposal" as const,
  agent: "agent_two" as const,
  narrative: "Agent Two accepts most proposed changes with one alternative.",
  acceptedProposedChangeIds: ["PC-1"],
  rejectedProposedChangeIds: [],
  alternativeChanges: [
    {
      id: "AC-1",
      change: "Store open conflicts as first-class artifacts",
      rationale: "The UI needs stable links to each disagreement",
      addressesDisagreementIds: ["D-2"],
    },
  ],
  agree: [agreement],
  disagree: [objectiveDisagreement],
  report: "memory-bank/collaboration/wf/negotiation-1/counter.md",
  supporting: [],
};

const resolutionDecision = {
  kind: "resolution_decision" as const,
  agent: "agent_one" as const,
  agreementReached: false,
  nextAction: "ask_user" as const,
  acceptedPoints: [agreement],
  resolvedDisagreements: [
    {
      disagreementId: "D-1",
      resolution: "Use the workflow envelope store",
      resolvedAutonomously: true,
      rationale: "Major implementation disagreements are within threshold",
    },
  ],
  remainingDisagreements: [objectiveDisagreement],
  userQuestions: [
    {
      id: "Q-1",
      question: "Should the output be a design or implementation plan?",
      relatedDisagreementIds: ["D-2"],
    },
  ],
  rationale: "Objective disagreement requires user clarification.",
};

const openConflicts = {
  kind: "open_conflicts" as const,
  disagreements: [implementationDisagreement, objectiveDisagreement],
  questions: [
    {
      id: "Q-1",
      question: "Should the output be a design or implementation plan?",
      relatedDisagreementIds: ["D-2"],
    },
  ],
};

const finalAnswer = {
  kind: "final_answer" as const,
  agent: "agent_one" as const,
  answer: "# Final design\n\nUse the existing workflow envelope store.",
  report: "memory-bank/collaboration/wf/final.md",
  supporting: [],
};

describe("Collaboration Mode asymmetric artifact schemas", () => {
  it("parses every artifact kind used by the new flow", () => {
    const artifacts: CollaborationArtifact[] = [
      initialDraft,
      crossReview,
      proposedChanges,
      counterProposal,
      resolutionDecision,
      openConflicts,
      finalAnswer,
    ];

    for (const artifact of artifacts) {
      const result = collaborationArtifactSchema.safeParse(artifact);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(artifact);
      }
    }
  });

  it("exposes individual schemas for backend prompts and UI fixtures", () => {
    expect(collaborationInitialDraftOutputSchema.parse(initialDraft)).toEqual(
      initialDraft,
    );
    expect(collaborationCrossReviewOutputSchema.parse(crossReview)).toEqual(
      crossReview,
    );
    expect(
      collaborationProposedChangesOutputSchema.parse(proposedChanges),
    ).toEqual(proposedChanges);
    expect(
      collaborationCounterProposalOutputSchema.parse(counterProposal),
    ).toEqual(counterProposal);
    expect(
      collaborationResolutionDecisionOutputSchema.parse(resolutionDecision),
    ).toEqual(resolutionDecision);
    expect(collaborationOpenConflictsOutputSchema.parse(openConflicts)).toEqual(
      openConflicts,
    );
    expect(collaborationFinalAnswerOutputSchema.parse(finalAnswer)).toEqual(
      finalAnswer,
    );
  });

  it("requires disagreement category and severity", () => {
    const missingCategory = collaborationArtifactSchema.safeParse({
      ...counterProposal,
      disagree: [
        {
          id: "D-bad",
          severity: "major",
          claim: "Missing category",
          reason: "Category drives control flow",
        },
      ],
    });
    expect(missingCategory.success).toBe(false);

    const badSeverity = collaborationArtifactSchema.safeParse({
      ...counterProposal,
      disagree: [
        {
          ...implementationDisagreement,
          severity: "severe",
        },
      ],
    });
    expect(badSeverity.success).toBe(false);
  });

  it("validates autonomous resolution threshold values", () => {
    for (const threshold of ["none", "minor", "major", "blocking"]) {
      expect(
        collaborationAutonomousResolutionThresholdSchema.safeParse(threshold)
          .success,
      ).toBe(true);
    }

    expect(
      collaborationAutonomousResolutionThresholdSchema.safeParse("all").success,
    ).toBe(false);
  });
});

describe("Collaboration Mode asymmetric JSON Schema projections", () => {
  const cases: Array<{
    label: string;
    fixture: unknown;
    schema: unknown;
  }> = [
    {
      label: "initial_draft",
      fixture: initialDraft,
      schema: COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
    },
    {
      label: "cross_review",
      fixture: crossReview,
      schema: COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
    },
    {
      label: "proposed_changes",
      fixture: proposedChanges,
      schema: COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
    },
    {
      label: "counter_proposal",
      fixture: counterProposal,
      schema: COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
    },
    {
      label: "resolution_decision",
      fixture: resolutionDecision,
      schema: COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
    },
    {
      label: "final_answer",
      fixture: finalAnswer,
      schema: COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
    },
  ];

  for (const { label, fixture, schema } of cases) {
    it(`exposes a strict-required JSON Schema for ${label}`, () => {
      expect(strictRequiredGaps(schema)).toEqual([]);
    });

    it(`accepts the ${label} fixture against its JSON Schema projection`, () => {
      expect(validateAgainstJsonSchema(fixture, schema)).toEqual([]);
    });

    it(`rejects an empty object as ${label}`, () => {
      const errors = validateAgainstJsonSchema({}, schema);
      expect(errors.length).toBeGreaterThan(0);
    });

    it(`rejects an extraneous top-level property in ${label}`, () => {
      const polluted = { ...(fixture as object), unexpected_field: "x" };
      const errors = validateAgainstJsonSchema(polluted, schema);
      expect(errors.length).toBeGreaterThan(0);
    });
  }

  it("rejects an unknown disagreement category in cross_review", () => {
    const bad = {
      ...crossReview,
      disagree: [
        {
          ...implementationDisagreement,
          category: "process",
        },
      ],
    };
    const errors = validateAgainstJsonSchema(
      bad,
      COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a disagreement without optional ref or proposedResolution in counter_proposal", () => {
    const minimal = {
      ...counterProposal,
      disagree: [
        {
          id: "D-3",
          category: "implementation" as const,
          severity: "minor" as const,
          claim: "Trivial naming nit",
          reason: "It is purely cosmetic",
        },
      ],
    };
    expect(
      validateAgainstJsonSchema(
        minimal,
        COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
      ),
    ).toEqual([]);
  });

  it("accepts an agreement without optional ref in initial_draft", () => {
    const minimal = {
      ...initialDraft,
      keyClaims: [{ id: "A-2", claim: "No ref needed" }],
    };
    expect(
      validateAgainstJsonSchema(
        minimal,
        COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
      ),
    ).toEqual([]);
  });

  it("rejects a resolution_decision with an unknown nextAction", () => {
    const bad = {
      ...resolutionDecision,
      nextAction: "abort",
    };
    const errors = validateAgainstJsonSchema(
      bad,
      COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a final_answer authored by agent_two", () => {
    const bad = { ...finalAnswer, agent: "agent_two" };
    const errors = validateAgainstJsonSchema(
      bad,
      COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
