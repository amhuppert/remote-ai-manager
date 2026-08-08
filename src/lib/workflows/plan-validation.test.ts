import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { validateWorkflowPlan } from "./plan-validation";

/** A well-formed create/replace body: `{ name, description?, definition, layout }`. */
function makePlan(definition = createWorkflowDefinition()) {
  return {
    name: "Test Workflow",
    description: "A workflow under test",
    definition,
    layout: createWorkflowLayout(),
  };
}

describe("validateWorkflowPlan", () => {
  it("accepts a well-formed plan and returns the normalized draft", () => {
    const result = validateWorkflowPlan(makePlan());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.name).toBe("Test Workflow");
      expect(result.draft.description).toBe("A workflow under test");
      expect(result.draft.definition.executionContexts).toHaveLength(3);
      expect(result.warnings).toEqual([]);
    }
  });

  it("locates unknown selector command names when a registry is provided", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "ghost"] },
      },
    });

    const result = validateWorkflowPlan(makePlan(definition), {
      validationCommandPreflight: {
        commandCosts: { typecheck: 2 },
        concurrencyLimit: 8,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      {
        path: "definition.workflowConfig.scriptValidator.commands.1",
        message: expect.stringContaining('Unknown validation command "ghost"'),
      },
    ]);
  });

  it("skips the registry check at project-unbound callers (no registry option)", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["ghost"] },
      },
    });

    expect(validateWorkflowPlan(makePlan(definition)).ok).toBe(true);
  });

  it("rejects an oversized selected command with a located machine-readable error", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["test"] },
      },
    });

    const result = validateWorkflowPlan(makePlan(definition), {
      validationCommandPreflight: {
        commandCosts: { test: 5 },
        concurrencyLimit: 4,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_cost_exceeds_limit");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "definition.workflowConfig.scriptValidator.commands.0",
        message: expect.stringMatching(/cost 5.*limit 4.*lower-worker/),
      }),
    );
  });

  it("accepts a plan with uncovered guard enum values and reports it as a warning (R3.2)", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: {
                  verdict: { type: "string", enum: ["ship", "hold", "stop"] },
                },
                required: ["verdict"],
              },
            }
          : context,
      ),
      edges: base.edges.map((edge) =>
        edge.sourceContextId === "context-plan"
          ? {
              ...edge,
              when: {
                schema: {
                  type: "object",
                  properties: { verdict: { const: "ship" } },
                  required: ["verdict"],
                },
              },
            }
          : edge,
      ),
    };

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe(
      "definition.executionContexts[0].outputSchema.properties.verdict.enum",
    );
    expect(result.warnings[0]?.message).toContain('"hold"');
    expect(result.warnings[0]?.message).toContain('"stop"');
  });

  it("rejects a plan whose definition is missing the required charter", () => {
    const { charter: _charter, ...noCharter } = createWorkflowDefinition();

    const result = validateWorkflowPlan(makePlan(noCharter as never));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path)).toContain("definition.charter");
    }
  });

  it("rejects a plan whose charter has duplicate precedence ranks", () => {
    const definition = createWorkflowDefinition();
    const dupRankCharter = {
      ...definition.charter,
      sourcesOfTruth: [
        {
          rank: 1,
          id: "design-doc",
          label: "Design",
          type: "document" as const,
          locator: "design.md",
          description: "primary",
          accessPolicy: "worktree-relative" as const,
        },
        {
          rank: 1,
          id: "acceptance-criteria",
          label: "AC",
          type: "spec" as const,
          locator: "ac",
          description: "secondary",
          accessPolicy: "worktree-relative" as const,
        },
      ],
    };

    const result = validateWorkflowPlan(
      makePlan({ ...definition, charter: dupRankCharter } as never),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) =>
          i.path.startsWith("definition.charter.sourcesOfTruth"),
        ),
      ).toBe(true);
    }
  });

  it("reports a Zod field error with its JSON path", () => {
    const definition = createWorkflowDefinition();
    // A type error the Zod schema rejects (title must be a string).
    const broken = {
      ...definition,
      executionContexts: definition.executionContexts.map((ctx, index) =>
        index === 0 ? { ...ctx, title: 42 } : ctx,
      ),
    };

    const result = validateWorkflowPlan(makePlan(broken as never));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path);
      expect(paths).toContain("definition.executionContexts.0.title");
      for (const issue of result.issues) {
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("reports an unknown contextId reference with a task-scoped JSON path", () => {
    const definition = createWorkflowDefinition();
    const broken = {
      ...definition,
      tasks: definition.tasks.map((task, index) =>
        index === 0 ? { ...task, contextId: "context-does-not-exist" } : task,
      ),
    };

    const result = validateWorkflowPlan(makePlan(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (i) => i.path === "definition.tasks.0.contextId",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/context-does-not-exist/);
    }
  });

  it("reports a dependency cycle with an edges JSON path", () => {
    const definition = createWorkflowDefinition();
    const cyclic = {
      ...definition,
      edges: [
        ...definition.edges,
        {
          id: "edge-verify-plan",
          sourceContextId: "context-verify",
          targetContextId: "context-plan",
        },
      ],
    };

    const result = validateWorkflowPlan(makePlan(cyclic));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.path === "definition.edges");
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/acyclic/i);
    }
  });

  // R2.1: a cohort's shape refusals have to reach an author as LOCATED issues,
  // not an opaque parse failure — the plan boundary is where a hand-authored
  // plan.json meets the schema.
  describe("validator cohort shape refusal", () => {
    function withContextValidator(contextValidator: unknown) {
      const definition = createWorkflowDefinition();
      return {
        ...makePlan(definition),
        definition: {
          ...definition,
          executionContexts: definition.executionContexts.map(
            (context, index) =>
              index === 1 ? { ...context, contextValidator } : context,
          ),
        },
      };
    }

    const REVIEWER = {
      id: "general",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "conversation",
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      continuity: { enabled: true },
    };

    it("locates an enabled cohort with no assignments on the empty set", () => {
      const result = validateWorkflowPlan(
        withContextValidator({ enabled: true, assignments: [] }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain(
        "definition.executionContexts.1.contextValidator.assignments",
      );
      expect(result.issues[0]?.message).toMatch(/at least one/);
    });

    it("locates a duplicate assignment id on the offending entry", () => {
      const result = validateWorkflowPlan(
        withContextValidator({
          enabled: true,
          assignments: [REVIEWER, { ...REVIEWER, focus: "auth" }],
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain(
        "definition.executionContexts.1.contextValidator.assignments.1.id",
      );
    });

    it("locates an id that violates the grammar on that id", () => {
      const result = validateWorkflowPlan(
        withContextValidator({
          enabled: true,
          assignments: [{ ...REVIEWER, id: "General Reviewer" }],
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain(
        "definition.executionContexts.1.contextValidator.assignments.0.id",
      );
    });

    it("accepts a cohort naming the same profile twice under different focus", () => {
      const result = validateWorkflowPlan(
        withContextValidator({
          enabled: true,
          assignments: [
            { ...REVIEWER, id: "security", focus: "auth boundaries" },
            { ...REVIEWER, id: "performance", focus: "hot paths" },
          ],
        }),
      );

      expect(result.ok).toBe(true);
    });

    /**
     * R13.1: a shape refusal is located by its PATH, but an author reading a
     * message has to know which use site it is about without decoding array
     * indices. The schema that raised it is mounted at four different places
     * and cannot know which — so the plan boundary, which does know, supplies
     * the context/role/assignment-id use site and the qualified profile ref.
     */
    describe("use-site enrichment (R13.1)", () => {
      it("names the context, role, assignment id, and qualified ref on a duplicate id", () => {
        const result = validateWorkflowPlan(
          withContextValidator({
            enabled: true,
            assignments: [
              { ...REVIEWER, id: "security" },
              { ...REVIEWER, id: "security", focus: "auth" },
            ],
          }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const issue = result.issues.find(
          (i) =>
            i.path ===
            "definition.executionContexts.1.contextValidator.assignments.1.id",
        );
        expect(issue?.message).toContain('context "context-implement"');
        expect(issue?.message).toContain('validator assignment "security"');
        expect(issue?.message).toContain("builtin:general-reviewer");
      });

      it("names the cohort use site when the error is the cohort, not an assignment", () => {
        const result = validateWorkflowPlan(
          withContextValidator({ enabled: true, assignments: [] }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const issue = result.issues.find(
          (i) =>
            i.path ===
            "definition.executionContexts.1.contextValidator.assignments",
        );
        expect(issue?.message).toContain('context "context-implement"');
        expect(issue?.message).toContain("validator cohort");
      });

      it("names the implementer use site for an implementer shape error", () => {
        const definition = createWorkflowDefinition();
        const result = validateWorkflowPlan({
          ...makePlan(definition),
          definition: {
            ...definition,
            executionContexts: definition.executionContexts.map(
              (context, index) =>
                index === 0
                  ? {
                      ...context,
                      implementer: {
                        ...context.implementer,
                        id: "Not A Valid Id",
                      },
                    }
                  : context,
            ),
          },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const issue = result.issues.find(
          (i) => i.path === "definition.executionContexts.0.implementer.id",
        );
        expect(issue?.message).toContain('context "context-plan"');
        expect(issue?.message).toContain("implementer assignment");
        expect(issue?.message).toContain("builtin:general-implementer");
      });

      it("names the workflow tier for a workflow-config assignment error", () => {
        const definition = createWorkflowDefinition();
        const result = validateWorkflowPlan({
          ...makePlan(definition),
          definition: {
            ...definition,
            workflowConfig: {
              ...definition.workflowConfig,
              contextValidator: {
                enabled: true,
                assignments: [REVIEWER, { ...REVIEWER, focus: "auth" }],
              },
            },
          },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const issue = result.issues.find(
          (i) =>
            i.path ===
            "definition.workflowConfig.contextValidator.assignments.1.id",
        );
        expect(issue?.message).toContain("workflow-tier");
        expect(issue?.message).toContain('validator assignment "general"');
      });

      it("escapes control characters in the raw values it quotes", () => {
        const result = validateWorkflowPlan(
          withContextValidator({
            enabled: true,
            assignments: [
              {
                ...REVIEWER,
                id: "ev\nil",
                profile: { tier: "builtin", id: "re\nviewer" },
              },
            ],
          }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        // A located issue is one line by contract; a raw newline here would
        // split it and let the second half pose as another issue.
        for (const issue of result.issues) {
          expect(issue.message).not.toContain("\n");
        }
        expect(
          result.issues.some((issue) => issue.message.includes("ev\\nil")),
        ).toBe(true);
      });

      it("names the context as the use site for a non-assignment shape error", () => {
        const definition = createWorkflowDefinition();
        const result = validateWorkflowPlan(
          makePlan({
            ...definition,
            executionContexts: definition.executionContexts.map((ctx, index) =>
              index === 0 ? { ...ctx, title: 42 } : ctx,
            ),
          } as never),
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const issue = result.issues.find(
          (i) => i.path === "definition.executionContexts.0.title",
        );
        // The array index is not what an author calls the context, so a shape
        // refusal mounted on the context itself is located by its id.
        expect(issue?.message).toContain(
          'Use site: the context "context-plan"',
        );
      });
    });
  });

  describe("outputSchema declaration refusal (D2 R1.2)", () => {
    // `validateWorkflowPlan` takes the raw request body, so the declaration is
    // supplied exactly as an author would send it — no cast injects state past
    // the parse the production path performs.
    function withContextOutputSchema(outputSchema: unknown) {
      const definition = createWorkflowDefinition();
      return {
        ...makePlan(definition),
        definition: {
          ...definition,
          executionContexts: definition.executionContexts.map(
            (context, index) =>
              index === 1 ? { ...context, outputSchema } : context,
          ),
        },
      };
    }

    it("accepts a context declaring an outputSchema inside the supported subset", () => {
      const result = validateWorkflowPlan(
        withContextOutputSchema({
          type: "object",
          additionalProperties: false,
          required: ["verdict"],
          properties: {
            verdict: { type: "string", enum: ["pass", "fail"] },
            findings: { type: "array", items: { type: "string" } },
          },
        }),
      );

      expect(result.ok).toBe(true);
    });

    it("refuses an unsupported keyword with a locator naming the context and the schema path", () => {
      const result = validateWorkflowPlan(
        withContextOutputSchema({
          type: "object",
          properties: { verdict: { type: "string", format: "uri" } },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const issue = result.issues.find((candidate) =>
        candidate.path.includes("outputSchema"),
      );
      // Index 1 is `context-implement` — the context the declaration is on.
      expect(issue?.path).toBe(
        "definition.executionContexts[1].outputSchema.properties.verdict.format",
      );
      expect(issue?.message).toMatch(/format/);
    });

    it("refuses an outputSchema that is not an object schema at all", () => {
      const result = validateWorkflowPlan(
        withContextOutputSchema({ type: "string" }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain(
        "definition.executionContexts[1].outputSchema",
      );
    });

    it("brackets a property name containing a dot so the locator stays unambiguous", () => {
      // A dot-joined locator would read
      // `…outputSchema.properties.http.status.format`, which describes a nesting
      // the author never wrote and no reader can invert.
      const result = validateWorkflowPlan(
        withContextOutputSchema({
          type: "object",
          properties: { "http.status": { type: "string", format: "uri" } },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain(
        'definition.executionContexts[1].outputSchema.properties["http.status"].format',
      );
    });

    it("accepts a declaration whose property names collide with Object.prototype", () => {
      const result = validateWorkflowPlan(
        withContextOutputSchema({
          type: "object",
          required: ["constructor"],
          properties: {
            constructor: { type: "string" },
            toString: { type: "string" },
          },
        }),
      );

      expect(result.ok).toBe(true);
    });
  });
});

// R3.2: after the agent-assignment cutover, `workflow validate` must refuse a
// legacy singleton shape with a located, actionable error rather than an opaque
// union failure — and must never normalize it into an assignment.
describe("validateWorkflowPlan post-cutover refusal", () => {
  it("refuses a legacy implementer triple with a located error naming the expected form", () => {
    const definition = createWorkflowDefinition();
    (definition.executionContexts[1] as Record<string, unknown>).implementer = {
      backend: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    };

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find(
      (candidate) =>
        candidate.path === "definition.executionContexts.1.implementer",
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("profile");
  });

  it("refuses a legacy singleton validator with a located error naming the cohort form", () => {
    const definition = createWorkflowDefinition();
    (
      definition.executionContexts[0] as Record<string, unknown>
    ).contextValidator = {
      kind: "use",
      value: {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
    };

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find(
      (candidate) =>
        candidate.path === "definition.executionContexts.0.contextValidator",
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("assignments");
  });

  it("never normalizes a legacy shape into an assignment", () => {
    const definition = createWorkflowDefinition();
    (definition.workflowConfig as Record<string, unknown>).implementer = {
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
    };

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(
      "definition.workflowConfig.implementer",
    );
  });
});
