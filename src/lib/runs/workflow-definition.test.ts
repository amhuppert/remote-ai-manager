import { describe, expect, it } from "vitest";
import { agentLaunchRequestSchema, resolveAgentLaunch } from "./launch";
import {
  compileWorkflow,
  workflowLaunchRequestSchema,
} from "./workflow-definition";

const sonnet = {
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};
const gpt = {
  backend: "codex" as const,
  modelSelection: { modelId: "gpt-5.4", parameters: { reasoning: "high" } },
};

const placement = {
  runId: "run-1",
  cause: "launch-1",
  projectPath: "/repo",
  session: { sessionName: "session", worktreePath: "/repo/.worktrees/session" },
  owner: { conversationId: "owner-1", sessionName: "session" },
};

function launched(raw: unknown) {
  const request = workflowLaunchRequestSchema.parse(raw);
  return compileWorkflow({
    ...placement,
    request,
    seats: Object.fromEntries(
      request.contexts.map((context) => [
        context.key,
        {
          implementer: sonnet,
          reviewers: (context.reviewers ?? []).map(() => gpt),
        },
      ]),
    ),
  });
}

function contract(raw: unknown, key: string) {
  const entry = launched(raw).contexts.find((c) => c.key === key);
  if (entry === undefined) throw new Error(`no context ${key}`);
  return entry.request.contract;
}

/** The located issues parsing reports for a refused definition. */
function issues(raw: unknown) {
  const parsed = workflowLaunchRequestSchema.safeParse(raw);
  if (parsed.success) throw new Error("expected the definition to be refused");
  return parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

const owned = (...paths: string[]) => ({ mode: "owned", paths });
const readOnly = { mode: "readOnly" };

describe("one-context workflow (W1)", () => {
  it("freezes the same start request as the agent launch of the same contract", () => {
    const fields = {
      brief: "Add the endpoint.\nRefuse unknown ids.",
      tasks: [{ title: "Route" }, { title: "Tests", instructions: "Cover refusal" }],
      acceptanceCriteria: ["Refuses unknown ids"],
      checks: ["typecheck"],
      outputSchema: { type: "object" },
      reviewers: [{ authority: "blocking", focus: "Correctness" }],
      timeoutMs: 600000,
    };
    const agent = resolveAgentLaunch({
      ...placement,
      request: agentLaunchRequestSchema.parse(fields),
      seats: { implementer: sonnet, reviewers: [gpt] },
    });
    const workflow = launched({
      title: "Endpoint workflow",
      contexts: [{ key: "agent", ...fields }],
    });

    expect(workflow.kind).toBe("workflow");
    expect(workflow.title).toBe("Endpoint workflow");
    expect(workflow.contexts).toEqual(agent.contexts);
    expect(workflow.contexts[0]?.dependsOn).toEqual([]);
  });
});

describe("workflow definition compiler (W2)", () => {
  it("places each context in the session with its own key, scope and dependencies", () => {
    const launch = launched({
      title: "API then UI",
      contexts: [
        { key: "api", brief: "Build the API", scope: owned("src/api") },
        { key: "ui", brief: "Build the UI", dependsOn: ["api", "api"] },
      ],
    });

    expect(launch.contexts.map((c) => [c.key, c.request.contextId, c.dependsOn])).toEqual([
      ["api", "run-1.api", []],
      ["ui", "run-1.ui", ["api"]],
    ]);
    expect(launch.contexts[0]?.request.workspace.scope).toEqual(owned("src/api"));
    expect(launch.contexts[1]?.request.workspace.scope).toEqual({ mode: "full" });
  });

  it("refuses duplicate keys, unknown or self dependencies, and cycles, each at its location", () => {
    expect(
      issues({
        title: "Broken",
        contexts: [
          { key: "a", brief: "A", dependsOn: ["c"] },
          { key: "a", brief: "A again" },
          { key: "b", brief: "B", dependsOn: ["b", "ghost"] },
        ],
      }).map((e) => e.path),
    ).toEqual(["contexts.1.key", "contexts.0.dependsOn.0", "contexts.2.dependsOn.0", "contexts.2.dependsOn.1"]);

    expect(
      issues({
        title: "Cycle",
        contexts: [
          { key: "a", brief: "A", dependsOn: ["c"], scope: readOnly },
          { key: "b", brief: "B", dependsOn: ["a"], scope: readOnly },
          { key: "c", brief: "C", dependsOn: ["b"], scope: readOnly },
        ],
      }),
    ).toEqual([{ path: "contexts.1.dependsOn", message: "Dependency cycle: a → c → b → a" }]);
  });

  it("refuses an owned path with more than one spelling, at the path", () => {
    expect(
      issues({
        title: "Spellings",
        contexts: [
          { key: "a", brief: "A", scope: owned("./src/api", "src/lib/") },
          { key: "b", brief: "B", dependsOn: ["a"], scope: owned(".", "../x", "/etc", "src//ui") },
          { key: "c", brief: "C", dependsOn: ["b"], scope: owned(".git/hooks", ".cc/temp", " src/x", "src\\y") },
        ],
      }).map((e) => e.path),
    ).toEqual([
      "contexts.0.scope.paths.0",
      "contexts.0.scope.paths.1",
      "contexts.1.scope.paths.0",
      "contexts.1.scope.paths.1",
      "contexts.1.scope.paths.2",
      "contexts.1.scope.paths.3",
      "contexts.2.scope.paths.0",
      "contexts.2.scope.paths.1",
      "contexts.2.scope.paths.2",
      "contexts.2.scope.paths.3",
    ]);
  });

  it("refuses writers that could run together with overlapping scopes, and allows ordered or disjoint ones", () => {
    const overlap = issues({
      title: "Overlap",
      contexts: [
        { key: "a", brief: "A", scope: owned("src/lib") },
        { key: "b", brief: "B", scope: owned("src/lib/runs") },
      ],
    });
    expect(overlap.map((e) => e.path)).toEqual(["contexts.1.scope"]);
    expect(overlap[0]?.message).toContain('"a"');
    expect(overlap[0]?.message).toMatch(/dependsOn/);

    expect(
      issues({
        title: "Full against anything",
        contexts: [
          { key: "a", brief: "A" },
          { key: "b", brief: "B", scope: owned("docs") },
        ],
      }),
    ).toHaveLength(1);

    expect(() =>
      launched({
        title: "Ordered and disjoint",
        contexts: [
          { key: "a", brief: "A" },
          { key: "b", brief: "B", dependsOn: ["a"] },
          { key: "c", brief: "C", dependsOn: ["b"], scope: owned("src/a") },
          { key: "d", brief: "D", dependsOn: ["b"], scope: owned("src/b") },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses a reader beside a writer, whose changes would enter its whole-tree evidence, and lets readers run together", () => {
    const refused = issues({
      title: "Writer and reader",
      contexts: [
        { key: "build", brief: "Build", scope: owned("src/api") },
        { key: "audit", brief: "Audit", scope: readOnly },
      ],
    });
    expect(refused.map((e) => e.path)).toEqual(["contexts.1.scope"]);
    expect(refused[0]?.message).toMatch(/"audit" is read-only/);
    expect(refused[0]?.message).toMatch(/order them with dependsOn/);
    expect(refused[0]?.message).not.toMatch(/disjoint/);

    expect(
      contract(
        {
          title: "Build, then two audits together",
          contexts: [
            { key: "build", brief: "Build", checks: ["typecheck"] },
            { key: "audit-a", brief: "Audit A", dependsOn: ["build"], scope: readOnly, checks: ["test"] },
            { key: "audit-b", brief: "Audit B", dependsOn: ["build"], scope: readOnly, checks: ["test"] },
          ],
        },
        "audit-a",
      ),
    ).toMatchObject({ checks: ["test"], deferredChecks: [] });
  });

  it("defers a whole-tree check of concurrent writers to the context that covers it", () => {
    const definition = {
      title: "Two writers and an integration",
      contexts: [
        { key: "api", brief: "API", scope: owned("src/api"), checks: ["typecheck", "lint"] },
        { key: "ui", brief: "UI", scope: owned("src/ui"), checks: ["typecheck"] },
        { key: "integrate", brief: "Check the journey", dependsOn: ["api", "ui"], scope: readOnly, checks: ["typecheck", "lint"] },
      ],
    };

    expect(contract(definition, "api")).toMatchObject({ checks: [], deferredChecks: ["typecheck", "lint"] });
    expect(contract(definition, "ui")).toMatchObject({ checks: [], deferredChecks: ["typecheck"] });
    expect(contract(definition, "integrate")).toMatchObject({ checks: ["typecheck", "lint"], deferredChecks: [] });
  });

  it("follows coverage through a context whose own check is deferred again", () => {
    // c defers to d; d still has w alongside, so d defers to f, which runs after every writer.
    const chain = (withFinal: boolean) => ({
      title: "Chain",
      contexts: [
        { key: "c", brief: "C", scope: owned("src/c"), checks: ["typecheck"] },
        { key: "w", brief: "W", scope: owned("src/w"), checks: ["typecheck"] },
        { key: "d", brief: "D", dependsOn: ["c"], scope: owned("src/d"), checks: ["typecheck"] },
        ...(withFinal
          ? [{ key: "f", brief: "F", dependsOn: ["d", "w"], scope: readOnly, checks: ["typecheck"] }]
          : []),
      ],
    });

    expect(contract(chain(true), "c")).toMatchObject({ checks: [], deferredChecks: ["typecheck"] });
    expect(contract(chain(true), "d")).toMatchObject({ checks: [], deferredChecks: ["typecheck"] });
    expect(contract(chain(true), "w")).toMatchObject({ checks: [], deferredChecks: ["typecheck"] });
    expect(contract(chain(true), "f")).toMatchObject({ checks: ["typecheck"], deferredChecks: [] });
    expect(issues(chain(false)).map((e) => e.path)).toEqual(["contexts.1.checks.0", "contexts.2.checks.0"]);
  });

  it("refuses a whole-tree check that nothing covers, naming how to cover it", () => {
    const refused = issues({
      title: "Uncovered",
      contexts: [
        { key: "api", brief: "API", scope: owned("src/api"), checks: ["typecheck"] },
        { key: "ui", brief: "UI", scope: owned("src/ui") },
        // Covers nothing for api: it depends on ui only, and api writes beside it.
        { key: "after-ui", brief: "After UI", dependsOn: ["ui"], scope: owned("docs"), checks: ["typecheck"] },
      ],
    });

    expect(refused.map((e) => e.path)).toEqual(["contexts.0.checks.0", "contexts.2.checks.0"]);
    expect(refused[0]?.message).toContain('"ui"');
    expect(refused[0]?.message).toMatch(/depends on "api"/);
  });
});

describe("routes (W3)", () => {
  const triageSchema = {
    type: "object",
    properties: { kind: { type: "string", enum: ["bug", "feature"] } },
    required: ["kind"],
  };
  const isBug = { schema: { type: "object", properties: { kind: { const: "bug" } } } };
  const isFeature = { schema: { type: "object", properties: { kind: { const: "feature" } } } };
  const triage = (extra: Record<string, unknown> = {}) => ({
    key: "triage",
    brief: "Triage",
    scope: readOnly,
    outputSchema: triageSchema,
    ...extra,
  });

  it("freezes guarded dependencies and cardinality, and lets branches that never run together share files", () => {
    const launch = launched({
      title: "Routed",
      contexts: [
        triage({ routing: { cardinality: "exactlyOne" } }),
        { key: "fix", brief: "Fix", dependsOn: [{ key: "triage", when: isBug }] },
        { key: "design", brief: "Design", dependsOn: [{ key: "triage", when: { else: true } }] },
        { key: "notes", brief: "Notes", dependsOn: ["fix"] },
      ],
    });
    expect(launch.contexts.map((c) => [c.key, c.dependsOn, c.when ?? null, c.routing ?? null])).toEqual([
      ["triage", [], null, { cardinality: "exactlyOne" }],
      ["fix", ["triage"], { triage: isBug }, null],
      ["design", ["triage"], { triage: { else: true } }, null],
      ["notes", ["fix"], null, null],
    ]);
  });

  it("still refuses overlapping branches that could both be taken", () => {
    expect(
      issues({
        title: "Independent branches",
        contexts: [
          triage(),
          { key: "fix", brief: "Fix", dependsOn: [{ key: "triage", when: isBug }] },
          { key: "design", brief: "Design", dependsOn: [{ key: "triage", when: isFeature }] },
        ],
      }).map((e) => e.path),
    ).toEqual(["contexts.2.scope"]);
  });

  it("refuses guards that could never be evaluated or never match, each at its location", () => {
    const refused = issues({
      title: "Bad guards",
      contexts: [
        triage(),
        { key: "plain", brief: "No schema", scope: owned("src/plain"), dependsOn: ["triage"] },
        {
          key: "a",
          brief: "A",
          scope: owned("src/a"),
          dependsOn: [{ key: "plain", when: isBug }, { key: "triage", when: { schema: { type: "object", properties: { kind: { const: "urgent" } } } } }],
        },
        { key: "b", brief: "B", scope: owned("src/b"), dependsOn: [{ key: "triage", when: { schema: { type: "object", not: {} } } }] },
        { key: "c", brief: "C", scope: owned("src/c"), dependsOn: [{ key: "triage", when: { else: true } }] },
        { key: "d", brief: "D", scope: owned("src/d"), dependsOn: [{ key: "triage", when: { else: true } }] },
      ],
    });
    expect(refused.map((e) => e.path)).toEqual([
      "contexts.2.dependsOn.0.when",
      "contexts.2.dependsOn.1.when.schema",
      "contexts.3.dependsOn.0.when.schema",
      "contexts.5.dependsOn.0.when",
    ]);
    expect(refused[0]?.message).toMatch(/"plain" declares no outputSchema/);
    expect(refused[1]?.message).toMatch(/urgent/);
    expect(refused[3]?.message).toMatch(/second else/);
  });

  it("refuses an else with nothing to fall back from, routing with no guarded routes, and a guarded dependency listed twice", () => {
    expect(
      issues({
        title: "Odd routes",
        contexts: [
          triage({ routing: { cardinality: "atLeastOne" } }),
          { key: "only", brief: "Only", dependsOn: [{ key: "triage", when: { else: true } }] },
        ],
      }).map((e) => e.path),
    ).toEqual(["contexts.1.dependsOn.0.when", "contexts.0.routing"]);
    expect(
      issues({
        title: "Twice",
        contexts: [triage(), { key: "twice", brief: "Twice", dependsOn: ["triage", { key: "triage", when: isBug }] }],
      }).map((e) => e.path),
    ).toEqual(["contexts.1.dependsOn.1"]);
  });

  it("reports a source without an outputSchema once, not again as lacking routes", () => {
    expect(
      issues({
        title: "Unusable source",
        contexts: [
          { key: "triage", brief: "Triage", scope: readOnly, routing: { cardinality: "exactlyOne" } },
          { key: "fix", brief: "Fix", dependsOn: [{ key: "triage", when: isBug }] },
          { key: "design", brief: "Design", dependsOn: [{ key: "triage", when: { else: true } }] },
        ],
      }).map((e) => e.path),
    ).toEqual(["contexts.1.dependsOn.0.when", "contexts.2.dependsOn.0.when"]);
  });

  it("lets branches share files only when one route excludes the other", () => {
    const definition = (routing: Record<string, unknown>, second: unknown, join: unknown[]) => ({
      title: "Exclusive branches",
      contexts: [
        { key: "plan", brief: "Plan", scope: readOnly },
        triage({ dependsOn: ["plan"], ...routing }),
        { key: "fix", brief: "Fix", dependsOn: [{ key: "triage", when: isBug }], outputSchema: { type: "object" } },
        { key: "design", brief: "Design", dependsOn: [{ key: "triage", when: second }] },
        { key: "after", brief: "After", dependsOn: join },
      ],
    });
    // exactlyOne alone, and else alone, each keep fix and design apart; a context needing fix stays apart too.
    expect(() => launched(definition({ routing: { cardinality: "exactlyOne" } }, isFeature, ["fix"]))).not.toThrow();
    expect(() => launched(definition({}, { else: true }, [{ key: "fix", when: { schema: { type: "object" } } }, "plan"]))).not.toThrow();
    // A context fix's skip does not stop (plan alone satisfies it) can run beside design.
    expect(issues(definition({}, { else: true }, ["fix", "plan"])).map((e) => e.path)).toEqual(["contexts.4.scope"]);
  });

  it("does not count a coverer a route can skip further upstream", () => {
    const refused = issues({
      title: "Transitively skippable coverage",
      contexts: [
        {
          key: "a",
          brief: "A",
          scope: owned("src/a"),
          checks: ["typecheck"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
        { key: "b", brief: "B", scope: owned("src/b") },
        { key: "gate", brief: "Gate", scope: readOnly, dependsOn: [{ key: "a", when: { schema: { type: "object", properties: { ok: { const: true } } } } }, "b"] },
        { key: "final", brief: "Final", scope: readOnly, checks: ["typecheck"], dependsOn: ["gate"] },
      ],
    });
    expect(refused.map((e) => e.path)).toEqual(["contexts.0.checks.0"]);

    // An unguarded path from a to the coverer keeps the coverage.
    expect(() =>
      launched({
        title: "Guaranteed path",
        contexts: [
          {
            key: "a",
            brief: "A",
            scope: owned("src/a"),
            checks: ["typecheck"],
            outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          },
          { key: "b", brief: "B", scope: owned("src/b") },
          { key: "final", brief: "Final", scope: readOnly, checks: ["typecheck"], dependsOn: ["a", "b"] },
        ],
      }),
    ).not.toThrow();
  });

  it("does not count a context a route can skip as covering a deferred check", () => {
    const refused = issues({
      title: "Conditional coverage",
      contexts: [
        {
          key: "a",
          brief: "A",
          scope: owned("src/a"),
          checks: ["typecheck"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
        { key: "b", brief: "B", scope: owned("src/b") },
        {
          key: "final",
          brief: "Final",
          scope: readOnly,
          checks: ["typecheck"],
          dependsOn: [{ key: "a", when: { schema: { type: "object", properties: { ok: { const: true } } } } }, "b"],
        },
      ],
    });
    expect(refused.map((e) => e.path)).toEqual(["contexts.0.checks.0"]);
    expect(refused[0]?.message).toMatch(/a route can skip "final"/);
  });
});

describe("loops (W3)", () => {
  const reviewSchema = {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  };
  const contexts = [
    { key: "plan", brief: "Plan" },
    { key: "implement", brief: "Implement", dependsOn: ["plan"] },
    { key: "review", brief: "Review", dependsOn: ["implement"], outputSchema: reviewSchema },
    { key: "ship", brief: "Ship", dependsOn: ["review"] },
  ];
  const loop = {
    key: "polish",
    body: ["implement", "review"],
    entry: "implement",
    exit: "review",
    until: { schema: { type: "object", properties: { approved: { const: true } } } },
    maxPasses: 3,
  };

  it("freezes a loop into the definition", () => {
    expect(launched({ title: "Loop", contexts, loops: [loop] }).loops).toEqual([loop]);
  });

  it("refuses a loop body that is not one region with a single entry and exit", () => {
    expect(
      issues({
        title: "Shapes",
        contexts,
        loops: [
          { ...loop, body: ["implement", "review", "ghost"], entry: "plan" },
          { ...loop, key: "again", body: ["review"], entry: "review" },
        ],
      }).map((e) => e.path),
    ).toEqual(["loops.0.body.2", "loops.0.entry", "loops.1.body.0"]);

    expect(
      issues({
        title: "Leaks",
        contexts: [
          { key: "plan", brief: "Plan" },
          { key: "spec", brief: "Spec", scope: readOnly, dependsOn: ["plan"] },
          { key: "implement", brief: "Implement", dependsOn: ["plan", "spec"] },
          { key: "review", brief: "Review", dependsOn: ["implement", "spec"], outputSchema: reviewSchema },
          { key: "watch", brief: "Watch", dependsOn: ["implement", "review"], scope: readOnly },
        ],
        loops: [loop],
      }).map((e) => e.path),
    ).toEqual(["contexts.3.dependsOn.1", "contexts.4.dependsOn.0"]);

    expect(
      issues({
        title: "Disconnected",
        contexts: [
          { key: "plan", brief: "Plan" },
          { key: "implement", brief: "Implement", dependsOn: ["plan"] },
          { key: "side", brief: "Side", dependsOn: ["implement"], scope: owned("docs") },
          { key: "review", brief: "Review", dependsOn: ["implement"], scope: owned("src"), outputSchema: reviewSchema },
        ],
        loops: [{ ...loop, body: ["implement", "side", "review"] }],
      }).map((e) => e.path),
    ).toEqual(["loops.0.body.1"]);
  });

  it("refuses routes inside a loop and an exit condition that cannot be evaluated", () => {
    const refused = issues({
      title: "Loop routes",
      contexts: [
        {
          key: "plan",
          brief: "Plan",
          outputSchema: { type: "object", properties: { go: { type: "boolean" } }, required: ["go"] },
        },
        {
          key: "implement",
          brief: "Implement",
          dependsOn: [{ key: "plan", when: { schema: { type: "object", properties: { go: { const: true } } } } }],
          outputSchema: reviewSchema,
        },
        {
          key: "review",
          brief: "Review",
          dependsOn: [{ key: "implement", when: { schema: { type: "object", properties: { approved: { const: false } } } } }],
        },
      ],
      loops: [
        { ...loop, until: { schema: { type: "object", properties: { verdict: { const: "ok" } } } } },
      ],
    });
    expect(refused.map((e) => e.path)).toEqual(["contexts.2.dependsOn.0.when", "loops.0.exit"]);
    expect(refused[1]?.message).toMatch(/declares no outputSchema/);

    expect(
      issues({
        title: "Unmatched exit",
        contexts,
        loops: [{ ...loop, until: { schema: { type: "object", properties: { verdict: { const: "ok" } } } } }],
      }).map((e) => e.path),
    ).toEqual(["loops.0.until.schema"]);
    expect(
      issues({ title: "No passes", contexts, loops: [{ ...loop, maxPasses: 0 }] }).map((e) => e.path),
    ).toEqual(["loops.0.maxPasses"]);
  });
});
