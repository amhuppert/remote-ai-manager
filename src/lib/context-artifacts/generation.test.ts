import { describe, expect, it } from "vitest";
import {
  renderedTranscriptToMarkdown,
  type RenderedTranscript,
} from "@/lib/conversations/transcript-render";
import { EMPTY_TRANSCRIPT_BOUNDARIES } from "@/lib/conversations/history-recovery";
import type { SourceRef } from "@/lib/conversations/schemas";
import { compactionEnvelopeSchema, type CompactionEnvelope } from "./schemas";
import {
  COMPACTION_JSON_SCHEMA,
  PROMPT_VERSION,
  buildCompactionPrompt,
  compactionStructuredOutputSchema,
  type CompactionSourceMeta,
} from "./generation";

const ref: SourceRef = {
  messageIndex: 0,
  messageId: "m-0",
  seqStart: 0,
  seqEnd: 2,
  quote: "please implement the guards",
};

/** Every optional field populated, every array non-empty. */
const maximalEnvelope: CompactionEnvelope = {
  schemaVersion: 1,
  kind: "conversation_compaction",
  source: {
    projectName: "command-center",
    sessionName: "compaction",
    conversationId: "conv-1",
    coveredStartSeq: 0,
    coveredEndSeq: 12,
    messageCount: 4,
    sourceHash: "hash-1",
  },
  agentBrief: "Dense handoff brief.",
  currentState: {
    status: "in-progress",
    latestUserGoal: "ship compaction",
    nextBestActions: ["wire the service"],
  },
  decisions: [
    {
      statement: "Use z.toJSONSchema for the envelope",
      rationale: "hand-mirroring does not scale",
      status: "accepted",
      sourceRefs: [ref],
    },
  ],
  files: [
    {
      path: "src/lib/context-artifacts/generation.ts",
      role: "created",
      details: "prompt builder",
      sourceRefs: [ref],
    },
  ],
  commands: [
    {
      command: "bun run typecheck",
      outcome: "succeeded",
      summary: "clean",
      sourceRefs: [ref],
    },
  ],
  openQuestions: [{ text: "delta cadence?", sourceRefs: [ref] }],
  blockers: [{ text: "waiting on C1 wiring", sourceRefs: [ref] }],
  omissions: { reasoningOmitted: true, largeToolOutputsElided: 2 },
  extras: { note: "extra data" },
};

/**
 * Minimal structural JSON-schema conformance checker covering exactly the
 * constructs z.toJSONSchema emits for the envelope (type, properties/required/
 * additionalProperties, items, minItems, enum, const, anyOf, propertyNames).
 * Returns human-readable mismatch descriptions.
 */
function conformanceErrors(
  value: unknown,
  schema: unknown,
  path: string,
): string[] {
  if (typeof schema === "boolean") {
    return schema ? [] : [`${path}: schema forbids any value`];
  }
  if (typeof schema !== "object" || schema === null) {
    return [`${path}: unsupported schema node`];
  }
  const node = schema as Record<string, unknown>;
  const errors: string[] = [];

  if (Array.isArray(node["anyOf"])) {
    const branchErrors = node["anyOf"].map((branch) =>
      conformanceErrors(value, branch, path),
    );
    if (!branchErrors.some((errs) => errs.length === 0)) {
      errors.push(`${path}: no anyOf branch matched`);
    }
    return errors;
  }

  if (node["const"] !== undefined && value !== node["const"]) {
    errors.push(`${path}: expected const ${JSON.stringify(node["const"])}`);
  }
  if (Array.isArray(node["enum"]) && !node["enum"].includes(value)) {
    errors.push(`${path}: value not in enum`);
  }

  const type = node["type"];
  if (type === "string" && typeof value !== "string") {
    errors.push(`${path}: expected string`);
  } else if (
    (type === "number" || type === "integer") &&
    typeof value !== "number"
  ) {
    errors.push(`${path}: expected number`);
  } else if (type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: expected boolean`);
  } else if (type === "null" && value !== null) {
    errors.push(`${path}: expected null`);
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
    } else {
      if (
        typeof node["minItems"] === "number" &&
        value.length < node["minItems"]
      ) {
        errors.push(`${path}: fewer than minItems`);
      }
      if (node["items"] !== undefined) {
        value.forEach((item, i) => {
          errors.push(
            ...conformanceErrors(item, node["items"], `${path}[${i}]`),
          );
        });
      }
    }
  } else if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
    } else {
      const record = value as Record<string, unknown>;
      const properties =
        typeof node["properties"] === "object" && node["properties"] !== null
          ? (node["properties"] as Record<string, unknown>)
          : {};
      if (Array.isArray(node["required"])) {
        for (const key of node["required"]) {
          if (typeof key === "string" && !(key in record)) {
            errors.push(`${path}: missing required key "${key}"`);
          }
        }
      }
      for (const [key, entryValue] of Object.entries(record)) {
        const propSchema = properties[key];
        if (propSchema !== undefined) {
          errors.push(
            ...conformanceErrors(entryValue, propSchema, `${path}.${key}`),
          );
        } else if (node["additionalProperties"] === false) {
          errors.push(`${path}: unexpected key "${key}"`);
        } else if (
          node["additionalProperties"] !== undefined &&
          node["additionalProperties"] !== true
        ) {
          errors.push(
            ...conformanceErrors(
              entryValue,
              node["additionalProperties"],
              `${path}.${key}`,
            ),
          );
        }
      }
    }
  }

  return errors;
}

function strictOutputSchemaErrors(schema: unknown, path = "$schema"): string[] {
  if (typeof schema === "boolean") return [];
  if (typeof schema !== "object" || schema === null) {
    return [`${path}: unsupported schema node`];
  }

  const node = schema as Record<string, unknown>;
  const errors: string[] = [];
  if ("default" in node) {
    errors.push(`${path}: default is not supported`);
  }

  if (node["type"] === "object") {
    const properties =
      typeof node["properties"] === "object" && node["properties"] !== null
        ? (node["properties"] as Record<string, unknown>)
        : {};
    const required = Array.isArray(node["required"])
      ? new Set(node["required"])
      : new Set<unknown>();
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        errors.push(`${path}: property ${key} is not required`);
      }
    }
    if (node["additionalProperties"] !== false) {
      errors.push(`${path}: additionalProperties must be false`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      errors.push(
        ...strictOutputSchemaErrors(propertySchema, `${path}.${key}`),
      );
    }
  }

  if (node["items"] !== undefined) {
    errors.push(...strictOutputSchemaErrors(node["items"], `${path}[]`));
  }
  if (Array.isArray(node["anyOf"])) {
    node["anyOf"].forEach((branch, index) => {
      errors.push(
        ...strictOutputSchemaErrors(branch, `${path}.anyOf[${index}]`),
      );
    });
  }

  return errors;
}

function makeRendered(
  overrides: Partial<RenderedTranscript> = {},
): RenderedTranscript {
  return {
    conversationId: "conv-1",
    totalMessages: 2,
    maxSeq: 12,
    units: [
      {
        ref: { messageIndex: 0, messageId: "m-0", seqStart: 0, seqEnd: 2 },
        entrySeqs: [0, 1, 2],
        role: "user",
        timestamp: "2026-07-05T00:00:00.000Z",
        lines: ["[s0] please implement the guards"],
      },
      {
        ref: { messageIndex: 1, messageId: "m-1", seqStart: 3, seqEnd: 12 },
        entrySeqs: [3, 12],
        role: "assistant",
        timestamp: "2026-07-05T00:01:00.000Z",
        lines: ["[s3] working on it", "[s12] done"],
      },
    ],
    truncated: false,
    omissions: {
      thinkingOmitted: 0,
      toolResultBytesElided: 0,
      unitsOutsideWindow: 0,
    },
    boundaries: EMPTY_TRANSCRIPT_BOUNDARIES,
    truncation: {
      omittedAfter: null,
      partialEntry: null,
      excerptedEntries: [],
      excerptedEntriesOmitted: 0,
      excerptedEntriesNext: null,
    },
    ...overrides,
  };
}

const sourceMeta: CompactionSourceMeta = {
  projectName: "command-center",
  sessionName: "compaction",
  conversationId: "conv-1",
  coveredStartSeq: 0,
  coveredEndSeq: 12,
  messageCount: 2,
  sourceHash: "hash-1",
};

describe("PROMPT_VERSION", () => {
  it("is the v3 prompt contract", () => {
    expect(PROMPT_VERSION).toBe("3");
  });
});

describe("COMPACTION_JSON_SCHEMA", () => {
  it("is an object schema requiring the envelope's top-level fields", () => {
    expect(COMPACTION_JSON_SCHEMA["type"]).toBe("object");
    const required = COMPACTION_JSON_SCHEMA["required"];
    expect(required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "kind",
        "source",
        "agentBrief",
        "currentState",
        "decisions",
        "files",
        "commands",
        "openQuestions",
        "blockers",
        "omissions",
        "extras",
      ]),
    );
  });

  it("accepts a maximal envelope fixture (structural conformance)", () => {
    expect(
      conformanceErrors(
        { ...maximalEnvelope, extras: {} },
        COMPACTION_JSON_SCHEMA,
        "$",
      ),
    ).toEqual([]);
  });

  it("uses the strict JSON Schema subset required by Codex", () => {
    expect(strictOutputSchemaErrors(COMPACTION_JSON_SCHEMA)).toEqual([]);
  });

  it("normalizes required nullable placeholders to optional domain strings", () => {
    const nullableRef = { ...ref, quote: null };
    const parsed = compactionStructuredOutputSchema.parse({
      ...maximalEnvelope,
      decisions: [
        {
          ...maximalEnvelope.decisions[0],
          rationale: null,
          sourceRefs: [nullableRef],
        },
      ],
      files: [
        {
          ...maximalEnvelope.files[0],
          details: null,
          sourceRefs: [nullableRef],
        },
      ],
      commands: [
        {
          ...maximalEnvelope.commands[0],
          summary: null,
          sourceRefs: [nullableRef],
        },
      ],
      openQuestions: [
        { ...maximalEnvelope.openQuestions[0], sourceRefs: [nullableRef] },
      ],
      blockers: [{ ...maximalEnvelope.blockers[0], sourceRefs: [nullableRef] }],
      extras: {},
    });

    expect(parsed.decisions[0]).not.toHaveProperty("rationale");
    expect(parsed.files[0]).not.toHaveProperty("details");
    expect(parsed.commands[0]).not.toHaveProperty("summary");
    expect(parsed.decisions[0]?.sourceRefs[0]).not.toHaveProperty("quote");
    expect(compactionEnvelopeSchema.safeParse(parsed).success).toBe(true);
  });

  it("stays in lockstep with compactionEnvelopeSchema.parse", () => {
    expect(compactionEnvelopeSchema.parse(maximalEnvelope)).toEqual(
      maximalEnvelope,
    );
  });

  it("rejects structurally invalid envelopes (checker sanity)", () => {
    const broken = { ...maximalEnvelope, agentBrief: 42 };
    expect(
      conformanceErrors(broken, COMPACTION_JSON_SCHEMA, "$").length,
    ).toBeGreaterThan(0);
  });
});

describe("buildCompactionPrompt — full mode", () => {
  const prompt = buildCompactionPrompt({
    mode: "full",
    kind: "conversation_compaction",
    sourceMeta,
    renderedTranscript: makeRendered(),
  });

  it("orders stable instructions, then schema, then dynamic transcript last", () => {
    const schemaAt = prompt.indexOf(JSON.stringify(COMPACTION_JSON_SCHEMA));
    const metaAt = prompt.indexOf("Source metadata");
    const transcriptAt = prompt.indexOf("#0 [seq 0–2] user");
    expect(schemaAt).toBeGreaterThan(-1);
    expect(metaAt).toBeGreaterThan(schemaAt);
    expect(transcriptAt).toBeGreaterThan(metaAt);
  });

  it("embeds the rendered transcript as markdown", () => {
    expect(prompt).toContain(renderedTranscriptToMarkdown(makeRendered()));
  });

  it("carries the source metadata for the model to copy verbatim", () => {
    expect(prompt).toContain('"sourceHash":"hash-1"');
    expect(prompt).toContain('"coveredEndSeq":12');
    expect(prompt).toContain('"kind":"conversation_compaction"');
  });

  it("states the sourceRef citation and no-invention rules", () => {
    expect(prompt).toContain("sourceRefs");
    expect(prompt.toLowerCase()).toContain("never invent");
    expect(prompt).toContain("agentBrief");
    expect(prompt).toContain("Use null for unavailable");
  });

  it("omits delta merge instructions", () => {
    expect(prompt).not.toContain("previous compaction envelope");
  });

  it("keeps the pre-metadata prefix byte-identical across conversations (prompt caching)", () => {
    const other = buildCompactionPrompt({
      mode: "full",
      kind: "message_compaction",
      sourceMeta: { ...sourceMeta, conversationId: "conv-2", sourceHash: "x" },
      renderedTranscript: makeRendered({ conversationId: "conv-2" }),
    });
    const marker = "Source metadata";
    expect(prompt.slice(0, prompt.indexOf(marker))).toBe(
      other.slice(0, other.indexOf(marker)),
    );
  });
});

describe("buildCompactionPrompt — delta mode", () => {
  const deltaTranscript = makeRendered({
    units: [
      {
        ref: { messageIndex: 2, messageId: "m-2", seqStart: 13, seqEnd: 15 },
        entrySeqs: [13, 15],
        role: "assistant",
        timestamp: "2026-07-05T00:02:00.000Z",
        lines: ["[s13] follow-up work", "[s15] finished"],
      },
    ],
    maxSeq: 15,
  });

  const prompt = buildCompactionPrompt({
    mode: "delta",
    kind: "conversation_compaction",
    sourceMeta: { ...sourceMeta, coveredEndSeq: 15 },
    previousEnvelope: maximalEnvelope,
    deltaRenderedTranscript: deltaTranscript,
  });

  it("includes merge instructions and the previous envelope before the delta lines", () => {
    expect(prompt.toLowerCase()).toContain("supersede");
    const previousAt = prompt.indexOf(JSON.stringify(maximalEnvelope));
    const deltaAt = prompt.indexOf("#2 [seq 13–15] assistant");
    expect(previousAt).toBeGreaterThan(-1);
    expect(deltaAt).toBeGreaterThan(previousAt);
  });

  it("labels the new lines with the previous coverage boundary", () => {
    expect(prompt).toContain("seq 12");
  });

  it("carries the extended coverage in the source metadata", () => {
    expect(prompt).toContain('"coveredEndSeq":15');
  });
});
