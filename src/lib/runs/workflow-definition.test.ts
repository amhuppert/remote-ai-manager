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
