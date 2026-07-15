/**
 * Guardrail + parity tests for the Claude structured-output projection
 * (design doc Blocker 1 §1.2.2).
 *
 * Admission rule: every production schema constant that can reach Claude's
 * native structured-output enforcement (`outputFormat: { type: "json_schema" }`)
 * MUST appear in CLAUDE_BOUND_SCHEMA_INVENTORY below. When adding a new
 * Claude-bound schema constant, add it to the inventory so the recursive
 * guardrail proves its projection carries no unsupported keywords.
 */

import { describe, it, expect } from "vitest";
import {
  UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS,
  projectSchemaForClaude,
  unsupportedStructuredOutputKeywordPaths,
} from "./structured-output-projection";
import {
  COMPACTION_JSON_SCHEMA,
  compactionStructuredOutputSchema,
} from "@/lib/context-artifacts/generation";
import { VALIDATOR_OUTPUT_SCHEMA } from "@/lib/workflow-graph/validator-runner";
import { workflowAgentValidatorResultSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  COMMIT_MESSAGE_JSON_SCHEMA,
  MERGE_MESSAGE_JSON_SCHEMA,
  commitMessageOutputSchema,
} from "@/lib/conversation-commands/schemas";
import {
  COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
  COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
  COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
  COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
  COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
} from "@/lib/workflows/collaboration/types";
import { AGENT_RUN_OUTPUT_SCHEMA } from "@/lib/agent-runs/schemas";
import {
  TICKET_COMMAND_JSON_SCHEMA,
  ticketCommandOutputSchema,
} from "@/lib/tickets/slash-command";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/structured-output-gate";

const KEYWORD_SAMPLES: Record<
  (typeof UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS)[number],
  unknown
> = {
  minLength: 1,
  maxLength: 5,
  pattern: "^a$",
  minimum: 0,
  maximum: 10,
  exclusiveMinimum: 0,
  exclusiveMaximum: 10,
  multipleOf: 2,
  minItems: 1,
  maxItems: 3,
};

/** Embeds `keyword` at a top-level property, inside `items`, in an `anyOf` branch, and in `$defs`. */
function schemaCarrying(
  keyword: string,
  value: unknown,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      topLevel: { type: "string", [keyword]: value },
      list: { type: "array", items: { type: "number", [keyword]: value } },
      branch: {
        anyOf: [{ type: "string", [keyword]: value }, { type: "null" }],
      },
    },
    required: ["topLevel"],
    additionalProperties: false,
    $defs: {
      helper: { type: "integer", [keyword]: value },
    },
  };
}

describe("projectSchemaForClaude — per-keyword strip (T2.1)", () => {
  for (const keyword of UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS) {
    it(`strips ${keyword} at top-level property, items, anyOf branch, and $defs`, () => {
      const schema = schemaCarrying(keyword, KEYWORD_SAMPLES[keyword]);
      const hits = unsupportedStructuredOutputKeywordPaths(schema);
      expect(hits.length).toBeGreaterThanOrEqual(4);
      expect(
        unsupportedStructuredOutputKeywordPaths(projectSchemaForClaude(schema)),
      ).toEqual([]);
    });
  }
});

describe("projectSchemaForClaude — preservation (T2.2)", () => {
  const MAXIMAL_SUPPORTED_SCHEMA: Record<string, unknown> = {
    type: "object",
    title: "Maximal",
    description: "carries every supported keyword",
    properties: {
      status: {
        type: "string",
        enum: ["open", "closed"],
        description: "lifecycle state",
      },
      version: { const: 1 },
      tags: { type: "array", items: { type: "string" } },
      nested: {
        type: "object",
        properties: { flag: { type: "boolean", default: false } },
        required: ["flag"],
        additionalProperties: false,
      },
      choice: { anyOf: [{ type: "string" }, { $ref: "#/$defs/thing" }] },
      all: { allOf: [{ type: "object" }] },
      one: { oneOf: [{ type: "number" }, { type: "null" }] },
    },
    required: ["status", "version"],
    additionalProperties: false,
    $defs: {
      thing: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  };

  it("round-trips a maximal supported-subset schema deep-equal", () => {
    expect(projectSchemaForClaude(MAXIMAL_SUPPORTED_SCHEMA)).toEqual(
      MAXIMAL_SUPPORTED_SCHEMA,
    );
  });

  const KEYWORD_CARRYING_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 10,
        description: "keep me",
      },
      count: { type: "integer", minimum: 0, maximum: 5 },
      refs: {
        type: "array",
        items: { type: "string", pattern: "^x" },
        minItems: 1,
        maxItems: 4,
      },
      ratio: {
        type: "number",
        exclusiveMinimum: 0,
        exclusiveMaximum: 1,
        multipleOf: 0.25,
      },
    },
    required: ["name", "count", "refs"],
    additionalProperties: false,
  };

  it("removes only the unsupported keys and touches nothing else", () => {
    expect(projectSchemaForClaude(KEYWORD_CARRYING_SCHEMA)).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "keep me" },
        count: { type: "integer" },
        refs: { type: "array", items: { type: "string" } },
        ratio: { type: "number" },
      },
      required: ["name", "count", "refs"],
      additionalProperties: false,
    });
  });

  it("does not mutate the input schema", () => {
    const before = structuredClone(KEYWORD_CARRYING_SCHEMA);
    projectSchemaForClaude(KEYWORD_CARRYING_SCHEMA);
    expect(KEYWORD_CARRYING_SCHEMA).toEqual(before);
  });
});

describe("COMPACTION_JSON_SCHEMA live hazard (T2.3)", () => {
  // Documents why the projection exists: the raw generated schema carries
  // keywords Claude validates but cannot steer (docs/structured-data-responses.md
  // §Backend Enforcement Compatibility) while the compaction backend defaults
  // to "claude" (src/lib/config/schemas.ts).
  it("carries unsupported keywords in its raw generated form", () => {
    const paths = unsupportedStructuredOutputKeywordPaths(
      COMPACTION_JSON_SCHEMA,
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.endsWith(".minItems"))).toBe(true);
  });

  it("is fully clean after projection", () => {
    expect(
      unsupportedStructuredOutputKeywordPaths(
        projectSchemaForClaude(COMPACTION_JSON_SCHEMA),
      ),
    ).toEqual([]);
  });
});

const CLAUDE_BOUND_SCHEMA_INVENTORY: ReadonlyArray<{
  label: string;
  schema: Record<string, unknown>;
}> = [
  { label: "COMPACTION_JSON_SCHEMA", schema: COMPACTION_JSON_SCHEMA },
  { label: "VALIDATOR_OUTPUT_SCHEMA", schema: VALIDATOR_OUTPUT_SCHEMA },
  { label: "COMMIT_MESSAGE_JSON_SCHEMA", schema: COMMIT_MESSAGE_JSON_SCHEMA },
  { label: "MERGE_MESSAGE_JSON_SCHEMA", schema: MERGE_MESSAGE_JSON_SCHEMA },
  {
    label: "COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA",
    schema: COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  },
  {
    label: "COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA",
    schema: COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
  },
  {
    label: "COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA",
    schema: COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
  },
  {
    label: "COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA",
    schema: COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
  },
  {
    label: "COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA",
    schema: COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
  },
  {
    label: "COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA",
    schema: COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
  },
  { label: "AGENT_RUN_OUTPUT_SCHEMA", schema: AGENT_RUN_OUTPUT_SCHEMA },
  { label: "TICKET_COMMAND_JSON_SCHEMA", schema: TICKET_COMMAND_JSON_SCHEMA },
];

describe("Claude-bound schema inventory guardrail (T2.4)", () => {
  for (const { label, schema } of CLAUDE_BOUND_SCHEMA_INVENTORY) {
    it(`projects ${label} without any unsupported keyword`, () => {
      expect(
        unsupportedStructuredOutputKeywordPaths(projectSchemaForClaude(schema)),
      ).toEqual([]);
    });
  }
});

// ── T2.5 parity fixtures ────────────────────────────────────────────────────

const sourceRef = {
  messageIndex: 0,
  messageId: null,
  seqStart: 0,
  seqEnd: 1,
  quote: null,
};

const compactionFixture = {
  schemaVersion: 1,
  kind: "conversation_compaction",
  source: {
    projectName: "demo",
    sessionName: null,
    conversationId: "conv-1",
    coveredStartSeq: 0,
    coveredEndSeq: 12,
    messageCount: 4,
    sourceHash: "abc123",
  },
  agentBrief: "Working on the widget module.",
  currentState: {
    status: "in_progress",
    latestUserGoal: "Ship the widget",
    nextBestActions: ["run the tests"],
  },
  decisions: [
    {
      statement: "Use the existing bus",
      rationale: null,
      status: "accepted",
      sourceRefs: [sourceRef],
    },
  ],
  files: [
    {
      path: "src/widget.ts",
      role: "modified",
      details: null,
      sourceRefs: [sourceRef],
    },
  ],
  commands: [
    {
      command: "bun run test",
      outcome: "succeeded",
      summary: null,
      sourceRefs: [sourceRef],
    },
  ],
  openQuestions: [{ text: "Rename the module?", sourceRefs: [sourceRef] }],
  blockers: [],
  omissions: { reasoningOmitted: false, largeToolOutputsElided: 0 },
  extras: {},
};

const validatorFixture = {
  summary: "All acceptance criteria verified.",
  issues: [
    {
      taskId: "task-1",
      title: "Missing test",
      description: "No unit test covers the retry path.",
    },
  ],
};

const commitFixture = { message: "feat: add the widget" };
const mergeFixture = {
  message: "merge: land the widget",
  resolutionContext: "kept ours for src/widget.ts",
};
const ticketFixture = {
  title: "Fix flaky retry",
  description: "Retries fail under load.",
  workType: "bug",
};

interface ParityCase {
  label: string;
  schema: Record<string, unknown>;
  fixture: unknown;
  acceptedByZod(): boolean;
}

const PARITY_CASES: ParityCase[] = [
  {
    label: "compaction",
    schema: COMPACTION_JSON_SCHEMA,
    fixture: compactionFixture,
    acceptedByZod: () =>
      compactionStructuredOutputSchema.safeParse(compactionFixture).success,
  },
  {
    label: "validator",
    schema: VALIDATOR_OUTPUT_SCHEMA,
    fixture: validatorFixture,
    acceptedByZod: () =>
      workflowAgentValidatorResultSchema.safeParse(validatorFixture).success,
  },
  {
    label: "commit message",
    schema: COMMIT_MESSAGE_JSON_SCHEMA,
    fixture: commitFixture,
    acceptedByZod: () =>
      commitMessageOutputSchema.safeParse(commitFixture).success,
  },
  {
    label: "merge message",
    schema: MERGE_MESSAGE_JSON_SCHEMA,
    fixture: mergeFixture,
    acceptedByZod: () =>
      commitMessageOutputSchema.safeParse(mergeFixture).success,
  },
  {
    label: "ticket command",
    schema: TICKET_COMMAND_JSON_SCHEMA,
    fixture: ticketFixture,
    acceptedByZod: () =>
      ticketCommandOutputSchema.safeParse(ticketFixture).success,
  },
];

/**
 * Collects the contract-bearing facts of a JSON schema (`required` sets,
 * `additionalProperties: false`, `enum` members) so source and projection can
 * be compared fact-for-fact.
 */
function collectContractFacts(
  node: unknown,
  path = "$",
  facts: string[] = [],
): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      collectContractFacts(item, `${path}[${index}]`, facts),
    );
    return facts;
  }
  if (typeof node !== "object" || node === null) return facts;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record["required"])) {
    facts.push(`${path}.required=${[...record["required"]].sort().join(",")}`);
  }
  if (record["additionalProperties"] === false) {
    facts.push(`${path}.additionalProperties=false`);
  }
  if (Array.isArray(record["enum"])) {
    facts.push(`${path}.enum=${record["enum"].map(String).join("|")}`);
  }
  for (const [key, child] of Object.entries(record)) {
    collectContractFacts(child, `${path}.${key}`, facts);
  }
  return facts;
}

describe("projection parity — projected shapes retain the contract (T2.5)", () => {
  for (const parityCase of PARITY_CASES) {
    const projected = () => projectSchemaForClaude(parityCase.schema);

    it(`accepts a Zod-valid ${parityCase.label} fixture against the projected schema`, () => {
      expect(parityCase.acceptedByZod()).toBe(true);
      expect(validateJsonSchemaSubset(projected(), parityCase.fixture)).toEqual(
        { valid: true },
      );
    });

    it(`still rejects an empty object as ${parityCase.label}`, () => {
      const outcome = validateJsonSchemaSubset(projected(), {});
      expect(outcome.valid).toBe(false);
    });

    it(`still rejects an extraneous top-level property in ${parityCase.label}`, () => {
      const polluted = {
        ...(parityCase.fixture as Record<string, unknown>),
        unexpected_field: "x",
      };
      const outcome = validateJsonSchemaSubset(projected(), polluted);
      expect(outcome.valid).toBe(false);
    });

    it(`keeps required sets, additionalProperties, and enums unchanged for ${parityCase.label}`, () => {
      expect(collectContractFacts(projected())).toEqual(
        collectContractFacts(parityCase.schema),
      );
    });
  }
});
