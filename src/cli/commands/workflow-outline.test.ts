import { describe, expect, it } from "vitest";
import {
  buildOutlineData,
  parseOutlineRecord,
  renderOutline,
  sliceCharter,
  sliceConfig,
  sliceContext,
  sliceParams,
  sliceTask,
} from "./workflow-outline";

/** A record shaped like the GET response `item` (a WorkflowDefinitionRecord). */
const RECORD = {
  id: "wf-1",
  name: "tailwind-stage-b1",
  revision: 7,
  createdAt: "2026-03-27T12:00:00.000Z",
  updatedAt: "2026-03-27T12:00:00.000Z",
  definition: {
    schemaVersion: 1,
    workflowConfig: { scriptValidator: { enabled: true } },
    charter: {
      mission: "x".repeat(214),
      conventions: ["a", "b", "c"],
      sourcesOfTruth: [{ rank: 1 }, { rank: 2 }],
    },
    parameters: [
      {
        type: "string",
        name: "feature-name",
        label: "Feature",
        required: true,
      },
    ],
    prerequisites: [{ kind: "path", path: ".kiro/steering/tech.md" }],
    executionContexts: [
      {
        id: "plan",
        title: "Plan the approach",
        acceptanceCriteria: "A plan.md describes the approach.",
        contextValidator: { kind: "disabled" },
      },
      {
        id: "impl",
        title: "Implement",
        acceptanceCriteria: "The feature works end to end.",
        outputSchema: {
          type: "object",
          required: ["verdict"],
          additionalProperties: false,
          properties: {
            verdict: { type: "string", enum: ["pass", "fail"] },
            notes: { type: "string" },
          },
        },
      },
    ],
    tasks: [
      {
        id: "plan-survey",
        contextId: "plan",
        order: 1,
        title: "Survey current CSS",
        instructions: "y".repeat(612),
      },
      {
        id: "impl-tokens",
        contextId: "impl",
        order: 1,
        title: "Migrate tokens",
        instructions: "z".repeat(1400),
      },
    ],
    edges: [{ id: "e1", sourceContextId: "plan", targetContextId: "impl" }],
  },
};

describe("workflow outline", () => {
  it("parses a record and surfaces structure without prose bodies", () => {
    const record = parseOutlineRecord(RECORD);
    expect(record).not.toBeNull();
    const data = buildOutlineData(record!);
    expect(data.revision).toBe(7);
    expect(data.contexts.map((c) => c.id)).toEqual(["plan", "impl"]);
    expect(data.contexts[1]?.deps).toEqual(["plan"]);
    expect(data.contexts[0]?.overrides).toEqual(["contextValidator"]);
    expect(data.tasks[0]).toMatchObject({
      contextId: "plan",
      id: "plan-survey",
      instructionChars: 612,
    });
    expect(data.charter).toMatchObject({ missionChars: 214, sources: 2 });
    expect(data.configOverrides.workflow).toEqual(["scriptValidator"]);
    expect(data.configOverrides.contexts).toEqual([
      { id: "plan", blocks: ["contextValidator"] },
    ]);
  });

  it("renders a compact text outline with sizes, not bodies", () => {
    const record = parseOutlineRecord(RECORD)!;
    const text = renderOutline(record);
    expect(text).toContain('workflow wf-1 "tailwind-stage-b1" rev 7');
    expect(text).toContain("deps=plan");
    expect(text).toContain("(612 chars)");
    expect(text).toContain("(1.4k chars)");
    expect(text).toContain("[contextValidator override]");
    // Prose bodies never appear.
    expect(text).not.toContain("y".repeat(50));
    expect(text).toContain("parameters: feature-name (string, required)");
    expect(text).toContain("prerequisites: path:.kiro/steering/tech.md");
    expect(text).toContain("config overrides: workflow=scriptValidator");
  });

  it("returns null for an unrecognizable payload", () => {
    expect(parseOutlineRecord({ nope: true })).toBeNull();
  });

  it("summarizes a declared outputSchema as a shape, not a body (R7.2)", () => {
    const record = parseOutlineRecord(RECORD);
    if (!record) throw new Error("expected a parsable outline record");
    const data = buildOutlineData(record);
    expect(data.contexts[0]?.outputSchema).toBeNull();
    expect(data.contexts[1]?.outputSchema).toEqual({
      type: "object",
      fieldCount: 2,
    });

    const text = renderOutline(record);
    expect(text).toContain("output schema: object · 2 fields");
    // The declaration itself stays in the `--context` / `--config` slices.
    expect(text).not.toContain("additionalProperties");
    expect(text).not.toContain("verdict");
    // A context that declares none carries no summary at all.
    const planRow = text.split("\n").find((line) => line.includes('"Plan the'));
    expect(planRow).not.toContain("output schema");
  });

  it("renders a one-field schema in the singular and a bare root as 'declared'", () => {
    const singular = parseOutlineRecord({
      ...RECORD,
      definition: {
        ...RECORD.definition,
        executionContexts: [
          {
            id: "one",
            title: "One field",
            acceptanceCriteria: "x",
            outputSchema: {
              type: "object",
              properties: { verdict: { type: "string" } },
            },
          },
          {
            id: "bare",
            title: "No properties",
            acceptanceCriteria: "x",
            outputSchema: { type: "object" },
          },
        ],
        tasks: [],
        edges: [],
      },
    });
    if (!singular) throw new Error("expected a parsable outline record");
    const text = renderOutline(singular);
    expect(text).toContain("output schema: object · 1 field");
    expect(text).toContain("output schema: object");
    expect(text).not.toContain("0 fields");
  });

  it("slices one context with its tasks and full prose", () => {
    const record = parseOutlineRecord(RECORD)!;
    const result = sliceContext(record, "plan");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as {
        context: { id: string; contextValidator?: unknown };
        tasks: Array<{ id: string; instructions: string }>;
      };
      expect(value.context.id).toBe("plan");
      expect(value.context.contextValidator).toEqual({ kind: "disabled" });
      expect(value.tasks[0]?.instructions).toHaveLength(612);
    }
    expect(sliceContext(record, "missing").ok).toBe(false);
  });

  it("slices one task with its full instructions", () => {
    const record = parseOutlineRecord(RECORD)!;
    const result = sliceTask(record, "impl-tokens");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.value as { instructions: string }).instructions,
      ).toHaveLength(1400);
    }
    expect(sliceTask(record, "nope").ok).toBe(false);
  });

  it("slices charter, config, and params sections", () => {
    const record = parseOutlineRecord(RECORD)!;
    const charter = sliceCharter(record);
    expect(
      charter.ok && (charter.value as { mission: string }).mission,
    ).toHaveLength(214);

    const config = sliceConfig(record);
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.value).toEqual({
        workflow: { scriptValidator: { enabled: true } },
        contexts: { plan: { contextValidator: { kind: "disabled" } } },
      });
    }

    const params = sliceParams(record);
    expect(params.ok).toBe(true);
    if (params.ok) {
      const value = params.value as {
        parameters: Array<{ name: string }>;
        prerequisites: Array<{ kind: string }>;
      };
      expect(value.parameters[0]?.name).toBe("feature-name");
      expect(value.prerequisites[0]?.kind).toBe("path");
    }
  });
});
