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
    workflowConfig: { scriptValidator: { commands: ["pre-merge"] } },
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
        contextValidator: { enabled: false, assignments: [] },
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
    expect(data.charter).toMatchObject({
      missionChars: 214,
      sources: 2,
      invariants: [],
    });
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

  it("renders global and context-scoped charter invariants in the text outline", () => {
    const record = parseOutlineRecord({
      ...RECORD,
      definition: {
        ...RECORD.definition,
        charter: {
          ...RECORD.definition.charter,
          invariants: [
            { id: "global", statement: "Applies everywhere." },
            {
              id: "implementation-only",
              statement: "Applies only to implementation work.",
              appliesTo: { contextIds: ["impl"] },
            },
          ],
        },
      },
    });
    if (!record) throw new Error("record must parse");

    const text = renderOutline(record);

    expect(text).toContain("invariants: global global");
    expect(text).toContain("implementation-only contexts=impl");
  });

  it("projects charter invariant scopes without their statement prose", () => {
    const statement = "Applies only to implementation work.";
    const record = parseOutlineRecord({
      ...RECORD,
      definition: {
        ...RECORD.definition,
        charter: {
          ...RECORD.definition.charter,
          invariants: [
            { id: "global", statement: "Applies everywhere." },
            {
              id: "implementation-only",
              statement,
              appliesTo: { contextIds: ["impl"] },
            },
          ],
        },
      },
    });
    if (!record) throw new Error("record must parse");

    const data = buildOutlineData(record);

    expect(data.charter.invariants).toEqual([
      {
        id: "global",
        contextIds: null,
        statementChars: "Applies everywhere.".length,
      },
      {
        id: "implementation-only",
        contextIds: ["impl"],
        statementChars: statement.length,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain(statement);
  });

  // #69 change 4 stage 1: acceptance criteria are ordered {id, statement}
  // records. The outline stays sizes-not-bodies — it shows each context's
  // record count and the citable ids, never a statement.
  describe("acceptance-criterion records", () => {
    const statement = "Route selection is audited end to end.";
    const RECORDS_RECORD = {
      ...RECORD,
      definition: {
        ...RECORD.definition,
        executionContexts: [
          RECORD.definition.executionContexts[0],
          {
            ...RECORD.definition.executionContexts[1],
            acceptanceCriteria: [
              { id: "ac-1", statement: "The feature works end to end." },
              { id: "audit-log", statement },
            ],
          },
        ],
      },
    };

    it("projects record criteria as ids with sizes, never statements", () => {
      const record = parseOutlineRecord(RECORDS_RECORD);
      if (!record) throw new Error("record must parse");

      const data = buildOutlineData(record);

      expect(data.contexts[1]?.criteria).toEqual([
        {
          id: "ac-1",
          statementChars: "The feature works end to end.".length,
        },
        { id: "audit-log", statementChars: statement.length },
      ]);
      expect(JSON.stringify(data)).not.toContain(statement);
    });

    it("projects legacy prose as the one canonical wrapped record", () => {
      const record = parseOutlineRecord(RECORD);
      if (!record) throw new Error("record must parse");

      const data = buildOutlineData(record);

      expect(data.contexts[0]?.criteria).toEqual([
        {
          id: "ac-1",
          statementChars: "A plan.md describes the approach.".length,
        },
      ]);
    });

    it("renders per-context record counts and ids in the text outline", () => {
      const record = parseOutlineRecord(RECORDS_RECORD);
      if (!record) throw new Error("record must parse");

      const text = renderOutline(record);

      expect(text).toContain("criteria=1");
      expect(text).toContain("criteria=2");
      expect(text).toContain("criteria: plan ac-1 · impl ac-1,audit-log");
      expect(text).not.toContain(statement);
    });

    it("projects an absent acceptanceCriteria as zero records", () => {
      const record = parseOutlineRecord({
        ...RECORD,
        definition: {
          ...RECORD.definition,
          executionContexts: [{ id: "bare", title: "No contract declared" }],
          tasks: [],
          edges: [],
        },
      });
      if (!record) throw new Error("record must parse");

      const data = buildOutlineData(record);

      expect(data.contexts[0]?.criteria).toEqual([]);
      expect(renderOutline(record)).toContain("criteria=0");
    });
  });

  it("renders concrete validation selections for the new selector blocks", () => {
    const record = parseOutlineRecord({
      ...RECORD,
      definition: {
        ...RECORD.definition,
        workflowConfig: {
          scriptValidator: { commands: ["typecheck", "test"] },
          agentValidation: {
            implementer: { mode: "all", except: ["format"] },
            contextValidator: { mode: "only", commands: [] },
          },
          laneMergeValidation: {
            strategy: "final-only",
            commands: { mode: "project" },
          },
        },
        executionContexts: [
          RECORD.definition.executionContexts[0],
          {
            ...RECORD.definition.executionContexts[1],
            agentValidation: {
              implementer: { mode: "only", commands: ["test"] },
            },
          },
        ],
      },
    });
    if (!record) throw new Error("record must parse");
    const text = renderOutline(record);
    expect(text).toContain(
      "validation: script typecheck+test · roles implementer all-except format, validator none · laneMerge final-only project",
    );
    expect(text).toContain(
      "workflow=scriptValidator,agentValidation,laneMergeValidation",
    );
    // The context override list picks up the new block key.
    expect(text).toContain("impl(agentValidation)");
  });

  it("renders an explicit lane-merge command list under every-merge", () => {
    const record = parseOutlineRecord({
      ...RECORD,
      definition: {
        ...RECORD.definition,
        workflowConfig: {
          laneMergeValidation: {
            strategy: "every-merge",
            commands: { mode: "only", commands: ["typecheck", "test"] },
          },
        },
      },
    });
    if (!record) throw new Error("record must parse");
    expect(renderOutline(record)).toContain(
      "validation: laneMerge every-merge typecheck+test",
    );
  });

  it("returns null for an unrecognizable payload", () => {
    expect(parseOutlineRecord({ nope: true })).toBeNull();
  });

  /**
   * R13.1: a saved definition is REFERENCE-bearing — it names profiles the
   * library still owns and resolves nothing. Its staffing view therefore
   * carries the qualified `tier:id`, the strategy, and the runtime, and must
   * NOT carry a revision or a resolved hash: those exist only once execution
   * start seeds a snapshot, and printing them here would claim a determinism a
   * saved document does not have.
   */
  describe("assignment provenance (references)", () => {
    const STAFFED = {
      ...RECORD,
      definition: {
        ...RECORD.definition,
        workflowConfig: {
          ...RECORD.definition.workflowConfig,
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "high",
            },
          },
        },
        executionContexts: [
          RECORD.definition.executionContexts[0],
          {
            ...RECORD.definition.executionContexts[1],
            implementer: {
              id: "implementer",
              profile: { tier: "project", id: "house-implementer" },
              focus: "state-store",
              agent: {
                backend: "codex",
                model: "gpt-5.6",
                reasoningEffort: "high",
              },
            },
            contextValidator: {
              enabled: true,
              assignments: [
                {
                  id: "security",
                  profile: { tier: "global", id: "security-reviewer" },
                  strategy: "task",
                  agent: {
                    backend: "codex",
                    model: "gpt-5.6",
                    reasoningEffort: "high",
                  },
                  continuity: { enabled: true },
                },
                {
                  id: "general",
                  profile: { tier: "builtin", id: "general-reviewer" },
                  strategy: "conversation",
                  agent: {
                    backend: "claude",
                    model: "sonnet",
                    reasoningEffort: "medium",
                  },
                  continuity: { enabled: true },
                },
              ],
            },
          },
        ],
      },
    };

    it("reports each authored assignment with its tier, role, ref, and runtime", () => {
      const data = buildOutlineData(parseOutlineRecord(STAFFED)!);

      expect(data.staffing).toEqual([
        {
          scope: "workflow",
          role: "implementer",
          assignmentId: "implementer",
          profile: "builtin:general-implementer",
          focus: null,
          strategy: null,
          runtime: "claude opus high",
        },
        {
          scope: "impl",
          role: "implementer",
          assignmentId: "implementer",
          profile: "project:house-implementer",
          focus: "state-store",
          strategy: null,
          runtime: "codex gpt-5.6 high",
        },
        {
          scope: "impl",
          role: "validator",
          assignmentId: "security",
          profile: "global:security-reviewer",
          focus: null,
          strategy: "task",
          runtime: "codex gpt-5.6 high",
        },
        {
          scope: "impl",
          role: "validator",
          assignmentId: "general",
          profile: "builtin:general-reviewer",
          focus: null,
          strategy: "conversation",
          runtime: "claude sonnet medium",
        },
      ]);
    });

    it("renders the staffing block as references, never as snapshots", () => {
      const text = renderOutline(parseOutlineRecord(STAFFED)!);

      expect(text).toContain("staffing (references):");
      expect(text).toContain(
        "workflow  implementer  implementer  builtin:general-implementer",
      );
      expect(text).toContain("global:security-reviewer");
      expect(text).toContain("task codex gpt-5.6 high");
      expect(text).toContain('focus "state-store"');
      // A reference has no seeded revision and no resolved hash. Both spellings
      // belong to `live get` alone — that IS the two-shape distinction.
      expect(text).not.toMatch(/@\d/);
      expect(text).not.toContain("#");
    });

    it("says so when a definition authors no assignment at any tier", () => {
      const text = renderOutline(parseOutlineRecord(RECORD)!);
      expect(text).toContain("staffing (references): none authored");
    });

    it("retains the dormant assignments of a disabled cohort", () => {
      const withDormant = {
        ...STAFFED,
        definition: {
          ...STAFFED.definition,
          executionContexts: STAFFED.definition.executionContexts.map(
            (context, index) =>
              index === 1
                ? {
                    ...context,
                    contextValidator: {
                      enabled: false,
                      assignments:
                        STAFFED.definition.executionContexts[1]!
                          .contextValidator!.assignments,
                    },
                  }
                : context,
          ),
        },
      };

      const data = buildOutlineData(parseOutlineRecord(withDormant)!);
      // Dormant assignments are configuration a later edit can enable without
      // touching the library, so an author has to be able to see them.
      const validators = data.staffing.filter(
        (row) => row.role === "validator",
      );
      expect(validators.map((row) => row.assignmentId)).toEqual([
        "security",
        "general",
      ]);
      expect(renderOutline(parseOutlineRecord(withDormant)!)).toMatch(
        /impl\s+validator\s+security\s+global:security-reviewer\s+task codex gpt-5\.6 high\s+\(cohort disabled\)/,
      );
    });
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
      expect(value.context.contextValidator).toEqual({
        enabled: false,
        assignments: [],
      });
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
        workflow: { scriptValidator: { commands: ["pre-merge"] } },
        contexts: {
          plan: { contextValidator: { enabled: false, assignments: [] } },
        },
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
