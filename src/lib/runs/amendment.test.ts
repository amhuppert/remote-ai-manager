import { describe, expect, it } from "vitest";
import {
  contextContractSchema,
  DEFAULT_CONTEXT_POLICY,
  type ContextProgress,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import {
  amendDefinition,
  frozenKeys,
  type ProposedDefinition,
} from "./amendment";
import { planRun, type ObservedContexts } from "./schedule";
import type {
  RouteGuard,
  RunDefinitionContext,
  RunFacts,
  RunLaneState,
  RunLoop,
} from "./schemas";

function request(
  key: string,
  brief = `Brief ${key}`,
  model = "sonnet",
): ContextStartRequest {
  const seat = {
    profile: { tier: "builtin" as const, id: "standard-agent" },
    backend: "claude" as const,
    modelSelection: { modelId: model, parameters: {} },
  };
  return {
    contextId: `run-1.${key}`,
    runId: "run-1",
    ownerConversationId: "owner-1",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    },
    contract: contextContractSchema.parse({
      title: `Title ${key}`,
      brief,
      tasks: [],
      acceptanceCriteria: [],
      outputSchema: { type: "object" },
      allowTaskAddition: true,
      implementer: { id: "implementer", ...seat },
      reviewers: [],
      checks: [],
      humanApproval: false,
      ownerQuestions: true,
      documents: [],
    }),
    policy: DEFAULT_CONTEXT_POLICY,
  };
}

interface Defined {
  key: string;
  /** A backend the owner wrote for its implementer; resolution fills one in otherwise. */
  backend?: string;
  dependsOn?: string[];
  when?: Record<string, RouteGuard>;
  routing?: { cardinality: "independent" | "atLeastOne" | "exactlyOne" };
  lane?: string;
  brief?: string;
  model?: string;
  checks?: string[];
  deferredChecks?: string[];
}

const context = (d: Defined): RunDefinitionContext => ({
  key: d.key,
  dependsOn: d.dependsOn ?? [],
  ...(d.when !== undefined ? { when: d.when } : {}),
  ...(d.routing !== undefined ? { routing: d.routing } : {}),
  ...(d.lane !== undefined ? { lane: d.lane } : {}),
  request: withChecks(
    request(d.key, d.brief, d.model),
    d.checks ?? [],
    d.deferredChecks ?? [],
  ),
});

function withChecks(
  start: ContextStartRequest,
  checks: string[],
  deferredChecks: string[],
): ContextStartRequest {
  return { ...start, contract: { ...start.contract, checks, deferredChecks } };
}

const laneEntry = (key: string, checks: string[] = []) => ({
  key,
  laneId: `1-${key}`,
  worktreePath: `/repo/.worktrees/session.1-${key}`,
  branch: `csm/session-1-${key}`,
  target: { worktreePath: "/repo/.worktrees/session", branch: "csm/session" },
  checks,
});

/** The context as its owner wrote it: what the run reads back, before seats are resolved. */
const authoredContext = (d: Defined) => ({
  key: d.key,
  brief: d.brief ?? `Brief ${d.key}`,
  ...(d.dependsOn !== undefined ? { dependsOn: d.dependsOn } : {}),
  ...(d.when !== undefined ? { when: d.when } : {}),
  ...(d.routing !== undefined ? { routing: d.routing } : {}),
  ...(d.lane !== undefined ? { lane: d.lane } : {}),
  ...(d.backend !== undefined ? { backend: d.backend } : {}),
  checks: [...(d.checks ?? []), ...(d.deferredChecks ?? [])].sort(),
});

function definition(
  defined: Defined[],
  loops: RunLoop[] = [],
  laneChecks: Record<string, string[]> = {},
): ProposedDefinition {
  const laneKeys = [
    ...new Set(defined.flatMap((d) => (d.lane === undefined ? [] : [d.lane]))),
  ];
  return {
    title: "Amended",
    authored: { title: "Amended", contexts: defined.map(authoredContext) },
    contexts: defined.map(context),
    ...(loops.length > 0 ? { loops } : {}),
    ...(laneKeys.length > 0
      ? { lanes: laneKeys.map((key) => laneEntry(key, laneChecks[key])) }
      : {}),
  };
}

function facts(
  defined: Defined[],
  started: Array<[string, number]>,
  options: { loops?: RunLoop[]; lanes?: Record<string, RunLaneState> } = {},
): RunFacts {
  const proposed = definition(defined, options.loops);
  return {
    runId: "run-1",
    kind: "workflow",
    title: "Original",
    definition: {
      revision: 1,
      contexts: proposed.contexts,
      ...(proposed.loops !== undefined ? { loops: proposed.loops } : {}),
      ...(proposed.lanes !== undefined ? { lanes: proposed.lanes } : {}),
      ...(proposed.authored !== undefined
        ? { authored: proposed.authored }
        : {}),
    },
    ...(options.lanes !== undefined ? { lanes: options.lanes } : {}),
    documents: [],
    charter: [],
    invocations: started.map(([key, pass]) => ({
      key,
      pass,
      contextId: pass === 0 ? `run-1.${key}` : `run-1.${key}.pass${pass + 1}`,
      startCause: `run-1:start:${key}:${pass}`,
    })),
    control: { paused: false, cancelled: false, fault: null },
    acts: [],
  };
}

const succeeded = (output: unknown) => ({
  progress: { kind: "succeeded", candidateId: "c" } satisfies ContextProgress,
  output,
  active: false,
});
const running = {
  progress: {
    kind: "running",
    obligation: { kind: "work", reason: "initial" },
  } satisfies ContextProgress,
  active: true,
};

function observed(
  entries: Record<
    string,
    { progress: ContextProgress; output?: unknown; active: boolean }
  >,
): ObservedContexts {
  return new Map(
    Object.entries(entries).map(([id, entry]) => [
      `run-1.${id}`,
      { openQuestions: 0, ...entry },
    ]),
  );
}

function amend(
  current: RunFacts,
  seen: ObservedContexts,
  proposed: ProposedDefinition,
) {
  return amendDefinition(current, seen, proposed);
}

const issuesOf = (result: ReturnType<typeof amendDefinition>): string[] =>
  result.ok ? [] : result.issues;

describe("amending a run's definition", () => {
  const chain: Defined[] = [
    { key: "api" },
    { key: "docs", dependsOn: ["api"] },
  ];

  it("changes and adds work that has not started, keeping a started context as it started", () => {
    const current = facts(chain, [["api", 0]]);
    const result = amend(
      current,
      observed({ api: succeeded({ summary: "built" }) }),
      definition([
        // The seat a started context resolved at launch stands, even when resolution would now pick another model.
        { key: "api", model: "opus" },
        { key: "docs", dependsOn: ["api"], brief: "Document the new routes" },
        { key: "review", dependsOn: ["docs"] },
      ]),
    );
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.title).toBe("Amended");
    expect(result.definition.revision).toBe(2);
    expect(result.definition.contexts.map((c) => c.key)).toEqual([
      "api",
      "docs",
      "review",
    ]);
    expect(result.definition.contexts[0]).toEqual(
      current.definition.contexts[0],
    );
    expect(result.definition.contexts[1]?.request.contract.brief).toBe(
      "Document the new routes",
    );
  });

  it("keeps a provisioned lane where it is", () => {
    const laned: Defined[] = [{ key: "api", lane: "api" }];
    const current = facts(laned, [["api", 0]], {
      lanes: {
        api: {
          provision: { attempt: 1, outcome: { kind: "requested" } },
          publication: null,
        },
      },
    });
    const moved = definition(laned);
    const lanes = (moved.lanes ?? []).map((lane) => ({
      ...lane,
      worktreePath: "/repo/.worktrees/elsewhere",
    }));
    expect(
      issuesOf(amend(current, observed({ api: running }), { ...moved, lanes })),
    ).toEqual([
      expect.stringMatching(
        /lane "api" has been provisioned, or asked to be, so its worktree and branch cannot change/,
      ),
    ]);
  });

  it("refuses a seat its owner changed on a started context, so the definition it reads back stays true", () => {
    const current = facts(chain, [["api", 0]]);
    expect(
      issuesOf(
        amend(
          current,
          observed({ api: running }),
          definition([{ key: "api", backend: "codex" }, chain[1] as Defined]),
        ),
      ),
    ).toEqual([
      expect.stringMatching(
        /"api" has started, so its request .* cannot change/,
      ),
    ]);
  });

  it("names the contexts an amendment keeps as they started: every started one and a started loop's whole body", () => {
    const loop: RunLoop = {
      key: "polish",
      body: ["implement", "review"],
      entry: "implement",
      exit: "review",
      until: { schema: { type: "object" } },
      maxPasses: 2,
    };
    const looped: Defined[] = [
      { key: "plan" },
      { key: "implement", dependsOn: ["plan"] },
      { key: "review", dependsOn: ["implement"] },
    ];
    expect(
      [
        ...frozenKeys(
          facts(
            looped,
            [
              ["plan", 0],
              ["implement", 0],
            ],
            { loops: [loop] },
          ),
        ),
      ].sort(),
    ).toEqual(["implement", "plan", "review"]);
  });

  it("names new work beside a started context, which would leave its checks to later work, apart from a changed request", () => {
    const tested: Defined[] = [{ key: "api", checks: ["test"] }];
    const current = facts(tested, [["api", 0]]);
    const seen = observed({ api: running });
    expect(
      issuesOf(
        amend(
          current,
          seen,
          definition([{ key: "api", deferredChecks: ["test"] }, { key: "ui" }]),
        ),
      ),
    ).toEqual([
      expect.stringMatching(
        /"api" has started, and this amendment changes which of its checks it runs itself/,
      ),
    ]);
    expect(
      issuesOf(
        amend(current, seen, definition([{ key: "api", checks: ["lint"] }])),
      ),
    ).toEqual([expect.stringContaining("its request")]);
  });

  it("refuses to put a started context into a loop, which would run it again after its result was used", () => {
    const current = facts(chain, [
      ["api", 0],
      ["docs", 0],
    ]);
    const seen = observed({
      api: succeeded({ approved: false }),
      docs: running,
    });
    const again: RunLoop = {
      key: "again",
      body: ["api"],
      entry: "api",
      exit: "api",
      until: { schema: { properties: { approved: { const: true } } } },
      maxPasses: 3,
    };
    expect(issuesOf(amend(current, seen, definition(chain, [again])))).toEqual([
      expect.stringContaining(
        '"api" has started, so the loop it runs in cannot change',
      ),
    ]);
  });

  it("refuses to remove or change a context that started", () => {
    const current = facts(chain, [["api", 0]]);
    const seen = observed({ api: running });
    expect(
      issuesOf(amend(current, seen, definition([{ key: "docs" }]))),
    ).toEqual([expect.stringContaining('"api" has started')]);
    expect(
      issuesOf(
        amend(
          current,
          seen,
          definition([
            { key: "api", brief: "Something else" },
            chain[1] ?? { key: "docs" },
          ]),
        ),
      ),
    ).toEqual([expect.stringContaining('"api" has started')]);
  });

  describe("routes", () => {
    const isBug = { schema: { properties: { kind: { const: "bug" } } } };
    const isFeature = {
      schema: { properties: { kind: { const: "feature" } } },
    };
    const routed = (
      fixGuard: RouteGuard,
      cardinality?: "exactlyOne",
    ): Defined[] => [
      {
        key: "triage",
        ...(cardinality !== undefined ? { routing: { cardinality } } : {}),
      },
      { key: "fix", dependsOn: ["triage"], when: { triage: fixGuard } },
      { key: "design", dependsOn: ["triage"], when: { triage: isFeature } },
    ];

    it("keeps a route choice that stands, but lets new work consume the result", () => {
      const current = facts(routed(isBug), [["triage", 0]]);
      const seen = observed({ triage: succeeded({ kind: "feature" }) });
      expect(
        issuesOf(amend(current, seen, definition(routed(isFeature)))),
      ).toEqual([
        expect.stringContaining(
          'the route from "triage" to "fix" was not taken',
        ),
        expect.stringContaining('"fix" was skipped'),
      ]);
      expect(
        amend(
          current,
          seen,
          definition([
            ...routed(isBug),
            { key: "notes", dependsOn: ["triage"] },
          ]),
        ).ok,
      ).toBe(true);
    });

    it("refuses reviving a context its route skipped, whether its own route or a skipped dependency's decided it", () => {
      // u started without t's work, because triage's result skipped t.
      const layout = (t: Defined): Defined[] => [
        { key: "triage" },
        { key: "v", dependsOn: ["triage"] },
        { key: "p", dependsOn: ["triage"], when: { triage: isBug } },
        t,
        { key: "u", dependsOn: ["t", "v"] },
      ];
      const skippedByRoute = {
        key: "t",
        dependsOn: ["v", "triage"],
        when: { triage: isBug },
      };
      const seen = observed({
        triage: succeeded({ kind: "feature" }),
        v: succeeded({ summary: "v" }),
        u: running,
      });
      const direct = facts(layout(skippedByRoute), [
        ["triage", 0],
        ["v", 0],
        ["u", 0],
      ]);
      expect(
        issuesOf(
          amend(
            direct,
            seen,
            definition(layout({ key: "t", dependsOn: ["v"] })),
          ),
        ),
      ).toContainEqual(expect.stringContaining('"t" was skipped'));

      const propagated = facts(layout({ key: "t", dependsOn: ["p"] }), [
        ["triage", 0],
        ["v", 0],
        ["u", 0],
      ]);
      expect(
        issuesOf(
          amend(
            propagated,
            seen,
            definition(layout({ key: "t", dependsOn: ["p", "v"] })),
          ),
        ),
      ).toContainEqual(expect.stringContaining('"t" was skipped'));
    });

    it("refuses dropping a route not taken into work still waiting on other work, which would then run it", () => {
      const waiting: Defined[] = [
        { key: "triage" },
        { key: "gate" },
        { key: "fix", dependsOn: ["gate", "triage"], when: { triage: isBug } },
      ];
      const current = facts(waiting, [
        ["triage", 0],
        ["gate", 0],
      ]);
      const seen = observed({
        triage: succeeded({ kind: "feature" }),
        gate: running,
      });
      expect(planRun(current, seen).keys.get("fix")?.kind).toBe("waiting");
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition([
              { key: "triage" },
              { key: "gate" },
              { key: "fix", dependsOn: ["gate"] },
            ]),
          ),
        ),
      ).toEqual([
        expect.stringContaining(
          'the route from "triage" to "fix" was not taken',
        ),
      ]);
      // Dropping the whole unstarted context stays allowed.
      expect(
        amend(current, seen, definition([{ key: "triage" }, { key: "gate" }]))
          .ok,
      ).toBe(true);
    });

    it("refuses a new route that would change a choice already made, such as an else route's", () => {
      const fallback: Defined[] = [
        { key: "triage" },
        { key: "gate" },
        { key: "bug", dependsOn: ["triage"], when: { triage: isBug } },
        {
          key: "fallback",
          dependsOn: ["triage", "gate"],
          when: { triage: { else: true } },
        },
      ];
      const current = facts(fallback, [
        ["triage", 0],
        ["gate", 0],
      ]);
      const seen = observed({
        triage: succeeded({ kind: "feature" }),
        gate: running,
      });
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition([
              ...fallback,
              {
                key: "feature",
                dependsOn: ["triage"],
                when: { triage: isFeature },
              },
            ]),
          ),
        ),
      ).toEqual([
        expect.stringContaining(
          'the route from "triage" to "fallback" was taken',
        ),
      ]);
    });

    it("lets the owner change the routes of a result that broke its cardinality, which is what clears that halt", () => {
      const current = facts(routed(isBug, "exactlyOne"), [["triage", 0]]);
      const seen = observed({ triage: succeeded({ kind: "chore" }) });
      expect(planRun(current, seen).halts.map((halt) => halt.kind)).toEqual([
        "route_cardinality",
      ]);
      const fixed = definition(routed({ else: true }, "exactlyOne"));
      const result = amend(current, seen, fixed);
      expect(result.ok).toBe(true);
    });
  });

  describe("loops", () => {
    const loop = (
      maxPasses: number,
      until: RunLoop["until"] = {
        schema: { properties: { approved: { const: true } } },
      },
    ): RunLoop => ({
      key: "polish",
      body: ["draft", "critique"],
      entry: "draft",
      exit: "critique",
      until,
      maxPasses,
    });
    const body: Defined[] = [
      { key: "draft" },
      { key: "critique", dependsOn: ["draft"] },
    ];

    it("lets a started loop run more passes, and nothing else about it change", () => {
      const current = facts(body, [["draft", 0]], { loops: [loop(2)] });
      const seen = observed({ draft: running });
      expect(amend(current, seen, definition(body, [loop(4)])).ok).toBe(true);
      expect(
        issuesOf(amend(current, seen, definition(body, [loop(1)]))),
      ).toEqual([expect.stringContaining('loop "polish"')]);
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition(body, [loop(2, { schema: { required: ["approved"] } })]),
          ),
        ),
      ).toEqual([expect.stringContaining('loop "polish"')]);
      // A member of a started loop's body that has not run this pass is part of that body all the same.
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition(
              [
                body[0] ?? { key: "draft" },
                { key: "critique", dependsOn: ["draft"], brief: "Be harsher" },
              ],
              [loop(2)],
            ),
          ),
        ),
      ).toEqual([expect.stringContaining('"critique"')]);
    });
  });

  describe("lanes", () => {
    const ready: RunLaneState = {
      provision: {
        attempt: 1,
        outcome: { kind: "provisioned", baseline: "b0" },
      },
      publication: null,
    };
    const lanes: Defined[] = [
      { key: "api", lane: "a" },
      { key: "tests", lane: "a", dependsOn: ["api"] },
      { key: "ui", lane: "b" },
    ];

    it("keeps a lane its route skipped skipped, since other lanes and the session went on without its code", () => {
      const isBug = { schema: { properties: { kind: { const: "bug" } } } };
      const layout = (extra: Defined[]): Defined[] => [
        { key: "triage" },
        {
          key: "fix",
          lane: "a",
          dependsOn: ["triage"],
          when: { triage: isBug },
        },
        { key: "join", lane: "b", dependsOn: ["triage", "fix"] },
        ...extra,
      ];
      const current = facts(
        layout([]),
        [
          ["triage", 0],
          ["join", 0],
        ],
        { lanes: { b: ready } },
      );
      const seen = observed({
        triage: succeeded({ kind: "feature" }),
        join: running,
      });
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition(
              layout([{ key: "n", lane: "a", dependsOn: ["triage"] }]),
            ),
          ),
        ),
      ).toEqual([expect.stringContaining('lane "a" was skipped')]);
      expect(
        amend(
          current,
          seen,
          definition(layout([{ key: "n", lane: "c", dependsOn: ["triage"] }])),
        ).ok,
      ).toBe(true);
    });

    it("keeps a provisioned lane's members, checks and prerequisites, and lets lanes not yet provisioned change", () => {
      const current = facts(lanes, [["api", 0]], { lanes: { a: ready } });
      const seen = observed({ api: running });
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition([
              ...lanes,
              { key: "docs", lane: "a", dependsOn: ["api"] },
            ]),
          ),
        ),
      ).toEqual([expect.stringContaining('lane "a"')]);
      expect(
        issuesOf(
          amend(current, seen, definition(lanes, [], { a: ["typecheck"] })),
        ),
      ).toEqual([expect.stringContaining('lane "a"')]);
      expect(
        issuesOf(
          amend(
            current,
            seen,
            definition([
              lanes[0] ?? { key: "api" },
              { key: "tests", lane: "a", dependsOn: ["api", "ui"] },
              { key: "ui", lane: "b" },
            ]),
          ),
        ),
      ).toEqual([expect.stringContaining('lane "a"')]);
      expect(
        amend(
          current,
          seen,
          definition(
            [...lanes, { key: "e2e", lane: "b", dependsOn: ["ui"] }],
            [],
            { b: ["test"] },
          ),
        ).ok,
      ).toBe(true);
    });
  });
});
