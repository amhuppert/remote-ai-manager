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
      typeof objectSchema["maxLength"] === "number" &&
      value.length > (objectSchema["maxLength"] as number)
    ) {
      return [`${path}: string longer than maxLength`];
    }
    if (
      Array.isArray(objectSchema["enum"]) &&
      !(objectSchema["enum"] as unknown[]).includes(value)
    ) {
      return [`${path}: not in enum`];
    }
    return [];
  }

  if (objectSchema["type"] === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [`${path}: expected integer`];
    }
    if (
      typeof objectSchema["minimum"] === "number" &&
      value < (objectSchema["minimum"] as number)
    ) {
      return [`${path}: integer below minimum`];
    }
    return [];
  }

  if (objectSchema["type"] === "boolean") {
    if (typeof value !== "boolean") return [`${path}: expected boolean`];
    return [];
  }

  return [];
}

// Claude's native structured-output enforcement (`outputFormat: { type:
// "json_schema" }`) does NOT support these keywords: it validates the model's
// output against them but cannot steer generation to satisfy them, so a schema
// that carries them makes the claude_code backend loop and fail ("Failed to
// provide valid structured output after N attempts"). The JSON Schema handed to
// the backend must omit them; bounds live in field descriptions (advisory) and
// CC's own Zod `safeParse` instead. See docs/structured-data-responses.md.
const UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
] as const;

function unsupportedStructuredOutputKeywordPaths(
  schema: unknown,
  path = "$",
): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) {
    return schema.flatMap((item, idx) =>
      unsupportedStructuredOutputKeywordPaths(item, `${path}[${idx}]`),
    );
  }
  const objectSchema = schema as Record<string, unknown>;
  const hits: string[] = [];
  for (const keyword of UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS) {
    if (keyword in objectSchema) hits.push(`${path}.${keyword}`);
  }
  for (const [key, child] of Object.entries(objectSchema)) {
    hits.push(
      ...unsupportedStructuredOutputKeywordPaths(child, `${path}.${key}`),
    );
  }
  return hits;
}

const agreement = {
  id: "A-1",
  claim: "Use the existing session status bus",
  ref: {
    artifact:
      "memory-bank/collaboration/wf/round-0/agent_one/initial_draft/main.md",
    locator: "#status-bus",
  },
};

const implementationDisagreement = {
  id: "D-1",
  category: "implementation" as const,
  severity: "major" as const,
  claim: "Use a separate queue table",
  reason: "A table would add operational overhead for this workflow",
  proposed_resolution: "Reuse the workflow envelope store instead",
  ref: {
    artifact:
      "memory-bank/collaboration/wf/round-0/agent_two/cross_review/main.md",
  },
};

const objectiveDisagreement = {
  id: "D-2",
  category: "objective" as const,
  severity: "blocking" as const,
  claim: "The user asked for a design, not an implementation",
  reason: "The scope changes which artifacts should be produced",
};

const mainArtifact = (
  agent: "agent_one" | "agent_two",
  phase:
    | "initial_draft"
    | "cross_review"
    | "proposed_changes"
    | "counter_proposal"
    | "resolution_decision"
    | "final_answer",
  round: number,
  id = "main",
  artifact_type: "main_response" | "audit" | "supporting" = "main_response",
  fileName = "main.md",
) => ({
  id,
  artifact_type,
  path: `memory-bank/collaboration/wf/round-${round}/${agent}/${phase}/${fileName}`,
  round,
  agent,
  phase,
  summary: `${phase} ${id}`,
});

const initialDraft = {
  kind: "initial_draft" as const,
  agent: "agent_one" as const,
  round: 0,
  summary: "Initial primary proposal.",
  artifacts: [mainArtifact("agent_one", "initial_draft", 0)],
  assumptions: ["The final answer should stay in the conversation."],
  key_claims: [agreement],
};

const crossReview = {
  kind: "cross_review" as const,
  agent: "agent_two" as const,
  target_agent: "agent_one" as const,
  round: 0,
  summary: "Agent Two review of Agent One's draft.",
  artifacts: [mainArtifact("agent_two", "cross_review", 0)],
  agree: [agreement],
  disagree: [implementationDisagreement],
  revise_self: [
    {
      change: "Adopt the existing notification path",
      because: "It avoids introducing a second delivery mechanism",
    },
  ],
};

const proposedChanges = {
  kind: "proposed_changes" as const,
  agent: "agent_one" as const,
  target_agent: "agent_two" as const,
  round: 1,
  summary: "Primary proposed changes after reading Agent Two's draft.",
  artifacts: [mainArtifact("agent_one", "proposed_changes", 1)],
  accepted_from_other_agent_draft: [agreement],
  proposed_changes: [
    {
      id: "PC-1",
      change: "Use the envelope store for progress snapshots",
      rationale: "Both UI and backend already consume it",
      addresses_disagreement_ids: ["D-1"],
    },
  ],
  remaining_disagreements: [implementationDisagreement],
};

const counterProposal = {
  kind: "counter_proposal" as const,
  agent: "agent_two" as const,
  target_agent: "agent_one" as const,
  round: 1,
  summary: "Agent Two accepts most proposed changes with one alternative.",
  artifacts: [mainArtifact("agent_two", "counter_proposal", 1)],
  accepted_change_ids: ["PC-1"],
  rejected_change_ids: [],
  alternative_changes: [
    {
      id: "AC-1",
      change: "Store open conflicts as first-class artifacts",
      rationale: "The UI needs stable links to each disagreement",
      addresses_disagreement_ids: ["D-2"],
    },
  ],
  agree: [agreement],
  disagree: [objectiveDisagreement],
};

const resolutionDecision = {
  kind: "resolution_decision" as const,
  agent: "agent_one" as const,
  target_agent: "agent_two" as const,
  round: 1,
  summary: "Objective disagreement requires user clarification.",
  artifacts: [mainArtifact("agent_one", "resolution_decision", 1)],
  agreement_reached: false,
  next_action: "ask_user" as const,
  accepted_points: [agreement],
  resolved_disagreements: [
    {
      disagreement_id: "D-1",
      resolution: "Use the workflow envelope store",
      resolved_autonomously: true,
      rationale: "Major implementation disagreements are within threshold",
    },
  ],
  remaining_disagreements: [objectiveDisagreement],
  user_questions: [
    {
      id: "Q-1",
      question: "Should the output be a design or implementation plan?",
      related_disagreement_ids: ["D-2"],
    },
  ],
  rationale: "Objective disagreement requires user clarification.",
};

const openConflicts = {
  kind: "open_conflicts" as const,
  round: 1,
  summary: "Two conflicts require user attention.",
  disagreements: [implementationDisagreement, objectiveDisagreement],
  questions: [
    {
      id: "Q-1",
      question: "Should the output be a design or implementation plan?",
      related_disagreement_ids: ["D-2"],
    },
  ],
};

const finalAnswer = {
  kind: "final_answer" as const,
  agent: "agent_one" as const,
  round: 1,
  summary: "Use the existing workflow envelope store.",
  artifacts: [
    mainArtifact(
      "agent_one",
      "final_answer",
      1,
      "answer",
      "main_response",
      "answer.md",
    ),
    mainArtifact("agent_one", "final_answer", 1, "audit", "audit", "audit.md"),
  ],
  answer_artifact_id: "answer" as const,
  audit_artifact_id: "audit" as const,
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

  it("rejects old inline payload fields and camelCase names", () => {
    const oldStyle = {
      kind: "proposed_changes" as const,
      agent: "agent_one" as const,
      targetAgent: "agent_two" as const,
      narrative: "Old inline narrative.",
      acceptedFromAgentTwoDraft: [agreement],
      proposedChanges: [],
      remainingDisagreements: [],
      report: "inline report",
      supporting: [],
    };

    expect(
      collaborationProposedChangesOutputSchema.safeParse(oldStyle).success,
    ).toBe(false);
  });

  it("requires generated artifact refs for agent-generated artifacts", () => {
    const withoutArtifacts = { ...initialDraft, artifacts: [] };
    expect(
      collaborationInitialDraftOutputSchema.safeParse(withoutArtifacts).success,
    ).toBe(false);
  });

  it("requires final_answer to reference answer and audit artifacts", () => {
    const missingAudit = {
      ...finalAnswer,
      artifacts: [finalAnswer.artifacts[0]],
    };
    expect(
      collaborationFinalAnswerOutputSchema.safeParse(missingAudit).success,
    ).toBe(false);
  });

  it("accepts long inline strings (length bounds are advisory, not schema-enforced)", () => {
    // The manifest schema no longer hard-bounds inline string length: Claude's
    // native json_schema enforcement cannot honor maxLength, so carrying it makes
    // the claude_code backend loop and fail. The "full prose stays in generated
    // files" contract is carried by the prompt and the artifact-file validator.
    const longClaim = {
      ...initialDraft,
      key_claims: [{ id: "A-long", claim: "x".repeat(501) }],
    };
    expect(
      collaborationInitialDraftOutputSchema.safeParse(longClaim).success,
    ).toBe(true);
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

    it(`omits json_schema keywords Claude cannot enforce in ${label}`, () => {
      expect(unsupportedStructuredOutputKeywordPaths(schema)).toEqual([]);
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

  it("accepts a disagreement without optional ref or proposed_resolution in counter_proposal", () => {
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
      key_claims: [{ id: "A-2", claim: "No ref needed" }],
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
      next_action: "abort",
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
