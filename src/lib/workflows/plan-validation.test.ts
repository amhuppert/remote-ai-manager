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

  it("rejects an enveloped context whose script commands exceed the lane barrier", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "only", commands: ["typecheck"] },
        },
      },
    });
    definition.executionContexts[1] = {
      ...definition.executionContexts[1]!,
      placement: {
        lane: "implementation",
        mode: "owned",
        ownedPaths: ["src"],
      },
      scriptValidator: { commands: ["typecheck", "test"] },
    };

    const result = validateWorkflowPlan(makePlan(definition), {
      validationCommandPreflight: {
        commandCosts: { typecheck: 2, test: 8 },
        concurrencyLimit: 8,
        laneMergeCommands: ["typecheck"],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "definition.executionContexts.1 (context-implement).scriptValidator.commands.1",
      recordId: "context-implement",
      message: expect.stringMatching(
        /script-validator command "test".*lane-merge barrier/i,
      ),
    });
  });

  it("keeps full-access contexts' independent script validation selection", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "only", commands: ["typecheck"] },
        },
      },
    });
    definition.executionContexts[1] = {
      ...definition.executionContexts[1]!,
      placement: { lane: "implementation", mode: "full" },
      scriptValidator: { commands: ["test"] },
    };

    const result = validateWorkflowPlan(makePlan(definition), {
      validationCommandPreflight: {
        commandCosts: { typecheck: 2, test: 8 },
        concurrencyLimit: 8,
        laneMergeCommands: ["typecheck"],
      },
    });

    expect(result.ok).toBe(true);
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
      "definition.executionContexts[0] (context-plan).outputSchema.properties.verdict.enum",
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

  it("rejects an invariant scope that names an unknown authored context at its exact location", () => {
    const definition = createWorkflowDefinition({
      charter: {
        ...createWorkflowDefinition().charter,
        invariants: [
          {
            id: "targeted-implementation",
            statement:
              "Only the implementation context changes production code.",
            appliesTo: { contextIds: ["context-missing"] },
          },
        ],
      },
    });

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: "definition.charter.invariants.0 (targeted-implementation).appliesTo.contextIds.0",
      message: expect.stringContaining("context-missing"),
      recordId: "targeted-implementation",
    });
  });

  it("accepts and preserves scopes for authored contexts and loop body templates", () => {
    const base = createWorkflowDefinition();
    const [seed, loopBody, publish] = base.executionContexts;
    if (!seed || !loopBody || !publish) {
      throw new Error(
        "fixture must declare seed, loop body, and publish contexts",
      );
    }
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        invariants: [
          {
            id: "scoped-work",
            statement: "The scoped contexts own this work.",
            appliesTo: { contextIds: ["seed", "loop-body"] },
          },
        ],
      },
      executionContexts: [
        { ...seed, id: "seed" },
        {
          ...loopBody,
          id: "loop-body",
          outputSchema: {
            type: "object",
            properties: { verdict: { const: "done" } },
            required: ["verdict"],
          },
        },
        { ...publish, id: "publish" },
      ],
      tasks: [
        { ...base.tasks[0]!, contextId: "seed" },
        { ...base.tasks[1]!, contextId: "loop-body" },
        { ...base.tasks[2]!, contextId: "publish" },
      ],
      edges: [
        {
          id: "edge-seed-loop",
          sourceContextId: "seed",
          targetContextId: "loop-body",
        },
        {
          id: "edge-loop-publish",
          sourceContextId: "loop-body",
          targetContextId: "publish",
        },
      ],
      loopGroups: [
        {
          id: "refine",
          bodyContextIds: ["loop-body"],
          entryContextId: "loop-body",
          exitContextId: "loop-body",
          until: {
            schema: {
              type: "object",
              properties: { verdict: { const: "done" } },
              required: ["verdict"],
            },
          },
          maxPasses: 3,
        },
      ],
    };

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.definition.charter.invariants?.[0]?.appliesTo).toEqual({
      contextIds: ["seed", "loop-body"],
    });
  });

  describe("acceptance-criteria canonicalization (#69 change 4 stage 1)", () => {
    it("wraps prose as exactly one ac-1 record in the returned draft", () => {
      const definition = createWorkflowDefinition();
      const proseByContextId = new Map(
        definition.executionContexts.map((ctx) => [
          ctx.id,
          ctx.acceptanceCriteria,
        ]),
      );

      const result = validateWorkflowPlan(makePlan(definition));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const context of result.draft.definition.executionContexts) {
        expect(context.acceptanceCriteria).toEqual([
          { id: "ac-1", statement: proseByContextId.get(context.id) },
        ]);
      }
    });

    it("passes authored records through with their ids intact", () => {
      const records = [
        { id: "first-outcome", statement: "The first outcome holds." },
        { id: "second-outcome", statement: "The second outcome holds." },
      ];
      const definition = createWorkflowDefinition();
      definition.executionContexts = definition.executionContexts.map(
        (ctx, index) =>
          index === 0 ? { ...ctx, acceptanceCriteria: records } : ctx,
      );

      const result = validateWorkflowPlan(makePlan(definition));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.draft.definition.executionContexts[0]?.acceptanceCriteria,
      ).toEqual(records);
    });

    it("refuses duplicate criterion ids with a located path and use site", () => {
      const definition = createWorkflowDefinition();
      definition.executionContexts = definition.executionContexts.map(
        (ctx, index) =>
          index === 0
            ? {
                ...ctx,
                acceptanceCriteria: [
                  { id: "same-id", statement: "First." },
                  { id: "same-id", statement: "Second." },
                ],
              }
            : ctx,
      );

      const result = validateWorkflowPlan(makePlan(definition));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues).toContainEqual({
        path: "definition.executionContexts.0 (context-plan).acceptanceCriteria.1 (same-id).id",
        message: expect.stringContaining("duplicate criterion id 'same-id'"),
        recordId: "same-id",
      });
    });
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
      expect(paths).toContain(
        "definition.executionContexts.0 (context-plan).title",
      );
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
        (i) => i.path === "definition.tasks.0 (task-plan-1).contextId",
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
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
    };

    it("locates an enabled cohort with no assignments on the empty set", () => {
      const result = validateWorkflowPlan(
        withContextValidator({ enabled: true, assignments: [] }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain(
        "definition.executionContexts.1 (context-implement).contextValidator.assignments",
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
        "definition.executionContexts.1 (context-implement).contextValidator.assignments.1 (general).id",
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
        "definition.executionContexts.1 (context-implement).contextValidator.assignments.0 (General Reviewer).id",
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
            "definition.executionContexts.1 (context-implement).contextValidator.assignments.1 (security).id",
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
            "definition.executionContexts.1 (context-implement).contextValidator.assignments",
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
          (i) =>
            i.path ===
            "definition.executionContexts.0 (context-plan).implementer.id",
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
            "definition.workflowConfig.contextValidator.assignments.1 (general).id",
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

      it("names the context, and no profile, for a non-assignment shape error", () => {
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
          (i) =>
            i.path === "definition.executionContexts.0 (context-plan).title",
        );
        // A shape refusal mounted on the context itself — a bad title, an absent
        // placement — reads identically wherever it was authored, and an array
        // index is not what an author calls the context, so the use site names
        // the context id. There is no assignment here, so there is no profile to
        // name either.
        expect(issue?.message).toContain(
          `Use site: the context "${definition.executionContexts[0]?.id}"`,
        );
        expect(issue?.message).not.toContain("agent profile");
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
        "definition.executionContexts[1] (context-implement).outputSchema.properties.verdict.format",
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
        "definition.executionContexts[1] (context-implement).outputSchema",
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
        'definition.executionContexts[1] (context-implement).outputSchema.properties["http.status"].format',
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
        candidate.path ===
        "definition.executionContexts.1 (context-implement).implementer",
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("profile");
    expect(issue?.recordId).toBe("context-implement");
    // The detector spells its own locator into the message; both spellings
    // name the record so a reader is never told two different locations.
    expect(issue?.message).toContain(
      "definition.executionContexts.1 (context-implement).implementer",
    );
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
        candidate.path ===
        "definition.executionContexts.0 (context-plan).contextValidator",
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("assignments");
    expect(issue?.recordId).toBe("context-plan");
  });

  it("refuses a validator assignment carrying the retired strategy field with a located error", () => {
    const definition = createWorkflowDefinition();
    (
      definition.executionContexts[0] as Record<string, unknown>
    ).contextValidator = {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          strategy: "task",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        },
      ],
    };

    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find(
      (candidate) =>
        candidate.path ===
        "definition.executionContexts.0 (context-plan).contextValidator.assignments.0 (general).strategy",
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("one durable conversation");
    // The locator names the assignment as the record, exactly as it does for
    // every other assignment-level refusal.
    expect(issue?.recordId).toBe("general");
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

// ============================================================
// Semantic authoring lints (#69 change 6)
// ============================================================

/** A definition that trips every semantic lint at once. */
function createLintTrippingDefinition() {
  const definition = createWorkflowDefinition();
  definition.charter.sourcesOfTruth[0] = {
    ...definition.charter.sourcesOfTruth[0]!,
    locator: "https://internal.example/design",
  };
  definition.executionContexts[0] = {
    ...definition.executionContexts[0]!,
    description: "d".repeat(2001),
    acceptanceCriteria: [
      { id: "ac-sweep", statement: "Every call site is migrated" },
      { id: "ac-blob", statement: "x".repeat(601) },
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `ac-${index + 1}`,
        statement: "Behavior is pinned",
      })),
    ],
  };
  definition.tasks[0] = {
    ...definition.tasks[0]!,
    instructions: "i".repeat(8001),
  };
  return definition;
}

/** The `lint/<id>` prefix of each warning, for set-level assertions. */
function lintIds(warnings: { message: string }[]): string[] {
  return warnings.flatMap(
    (warning) => warning.message.match(/^lint\/([a-z-]+):/)?.slice(1) ?? [],
  );
}

describe("validateWorkflowPlan semantic lints", () => {
  it("returns every lint as a warning on an otherwise valid plan", () => {
    const result = validateWorkflowPlan(
      makePlan(createLintTrippingDefinition()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(lintIds(result.warnings))).toEqual(
      new Set([
        "criteria-density",
        "open-quantifier",
        "source-locator-unresolvable",
        "oversized-prose",
      ]),
    );
    // The verdict is untouched: a warning is never an issue.
    expect(result).not.toHaveProperty("issues");
  });

  it("keeps lint warnings located like issues so the CLI printer renders them", () => {
    const result = validateWorkflowPlan(
      makePlan(createLintTrippingDefinition()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContainEqual({
      path: "definition.executionContexts.0 (context-plan).acceptanceCriteria",
      message: expect.stringContaining("lint/criteria-density"),
      recordId: "context-plan",
    });
    expect(result.warnings).toContainEqual({
      path: "definition.tasks.0 (task-plan-1).instructions",
      message: expect.stringContaining("lint/oversized-prose"),
      recordId: "task-plan-1",
    });
    expect(result.warnings).toContainEqual({
      path: "definition.charter.sourcesOfTruth.0 (design-doc).locator",
      message: expect.stringContaining("lint/source-locator-unresolvable"),
      recordId: "design-doc",
    });
  });

  it("still admits the plan and returns the canonical draft", () => {
    const result = validateWorkflowPlan(
      makePlan(createLintTrippingDefinition()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.draft.definition.executionContexts[0]?.acceptanceCriteria,
    ).toHaveLength(13);
  });

  it("makes no relative-path availability claim during synchronous validation", () => {
    const definition = createLintTrippingDefinition();
    definition.charter.sourcesOfTruth[0] = {
      ...definition.charter.sourcesOfTruth[0]!,
      locator: "docs/not-present-in-any-local-root.md",
    };
    const result = validateWorkflowPlan(makePlan(definition));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lintIds(result.warnings)).not.toContain(
      "source-locator-unresolvable",
    );
    expect(lintIds(result.warnings)).toContain("criteria-density");
  });

  it("leaves a plan that trips nothing warning-free", () => {
    const result = validateWorkflowPlan(makePlan());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });
});

// ============================================================
// Id-bearing issue locators (#80 design 3.2)
// ============================================================

describe("validateWorkflowPlan id-bearing issue locators", () => {
  /** The one located issue at `path`, so a failure names the whole issue list. */
  function issueAt(
    result: ReturnType<typeof validateWorkflowPlan>,
    path: string,
  ) {
    if (result.ok) throw new Error("expected an invalid plan");
    const found = result.issues.find((issue) => issue.path === path);
    if (!found) {
      throw new Error(
        `no issue at ${path}; got ${result.issues.map((issue) => issue.path).join(", ")}`,
      );
    }
    return found;
  }

  it("names the task an indexed task locator addresses", () => {
    const definition = createWorkflowDefinition();
    definition.tasks[2] = { ...definition.tasks[2]!, contextId: "ghost" };

    const issue = issueAt(
      validateWorkflowPlan(makePlan(definition)),
      "definition.tasks.2 (task-verify-1).contextId",
    );
    expect(issue).toEqual({
      path: "definition.tasks.2 (task-verify-1).contextId",
      message: expect.stringContaining("task-verify-1"),
      recordId: "task-verify-1",
    });
  });

  it("names the execution context an indexed context locator addresses", () => {
    const definition = createWorkflowDefinition();
    // A duplicate id is the case the annotation is worth most on: the locator
    // resolves to the FIRST context carrying the id, so the index alone leaves
    // an author counting elements to find which record it means.
    definition.executionContexts = [
      ...definition.executionContexts,
      { ...definition.executionContexts[1]!, title: "Implement again" },
    ];

    const issue = issueAt(
      validateWorkflowPlan(makePlan(definition)),
      "definition.executionContexts.1 (context-implement).id",
    );
    expect(issue.recordId).toBe("context-implement");
  });

  it("names the edge an indexed edge locator addresses", () => {
    const definition = createWorkflowDefinition();
    definition.edges[1] = {
      ...definition.edges[1]!,
      targetContextId: "ghost",
    };

    const issue = issueAt(
      validateWorkflowPlan(makePlan(definition)),
      "definition.edges.1 (edge-implement-verify).targetContextId",
    );
    expect(issue.recordId).toBe("edge-implement-verify");
  });

  it("names the charter source an indexed source locator addresses", () => {
    const definition = createWorkflowDefinition();
    definition.charter.sourcesOfTruth[1] = {
      ...definition.charter.sourcesOfTruth[1]!,
      accessPolicy: "worktree-relative",
    };

    const issue = issueAt(
      validateWorkflowPlan(makePlan(definition)),
      "definition.charter.sourcesOfTruth.1 (acceptance-criteria).accessPolicy",
    );
    expect(issue.recordId).toBe("acceptance-criteria");
  });

  it("leaves an indexed segment whose record carries no id alone", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "ghost"] },
      },
    });

    const issue = issueAt(
      validateWorkflowPlan(makePlan(definition), {
        validationCommandPreflight: {
          commandCosts: { typecheck: 2 },
          concurrencyLimit: 8,
        },
      }),
      "definition.workflowConfig.scriptValidator.commands.1",
    );
    expect(issue).not.toHaveProperty("recordId");
  });

  it("leaves a locator with no indexed record segment byte-identical", () => {
    const definition = createWorkflowDefinition();
    definition.edges = [
      ...definition.edges,
      {
        id: "edge-verify-plan",
        sourceContextId: "context-verify",
        targetContextId: "context-plan",
      },
    ];

    const issue = issueAt(
      validateWorkflowPlan(makePlan(definition)),
      "definition.edges",
    );
    expect(issue.message).toContain("acyclic");
    expect(issue).not.toHaveProperty("recordId");
  });

  it("locates a lint warning through the same id-bearing formatter", () => {
    const result = validateWorkflowPlan(
      makePlan(createLintTrippingDefinition()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContainEqual({
      path: "definition.executionContexts.0 (context-plan).acceptanceCriteria",
      message: expect.stringContaining("lint/criteria-density"),
      recordId: "context-plan",
    });
  });
});
