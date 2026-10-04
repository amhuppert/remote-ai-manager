import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextProgress,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import {
  decideNext,
  deriveRunProgress,
  onlyHaltsRemain,
  planRun,
  type ObservedContexts,
} from "./schedule";
import type { RouteGuard, RunFacts, RunLoop } from "./schemas";

const seat = {
  profile: { tier: "builtin" as const, id: "standard-agent" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

function request(
  key: string,
  outputSchema: Record<string, unknown> | null = null,
): ContextStartRequest {
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
      brief: `Brief ${key}`,
      tasks: [],
      acceptanceCriteria: [],
      outputSchema,
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

/** api and ui are roots; integrate depends on both. */
function facts(
  started: string[],
  control: RunFacts["control"] = { paused: false, cancelled: false, fault: null },
): RunFacts {
  return {
    runId: "run-1",
    kind: "workflow",
    title: "Two writers and an integration",
    definition: {
      revision: 1,
      contexts: [
        { key: "api", dependsOn: [], request: request("api") },
        { key: "ui", dependsOn: [], request: request("ui") },
        { key: "integrate", dependsOn: ["api", "ui"], request: request("integrate") },
      ],
    },
    invocations: started.map((key) => ({
      key,
      pass: 0,
      contextId: `run-1.${key}`,
      startCause: `run-1:start:${key}:0`,
      request: request(key),
    })),
    control,
  };
}

const running: ContextProgress = {
  kind: "running",
  obligation: { kind: "work", reason: "initial" },
};
const succeeded = (candidateId: string): ContextProgress => ({
  kind: "succeeded",
  candidateId,
});
const halted: ContextProgress = {
  kind: "halted",
  halt: "turn_failed",
  detail: "The provider failed.",
};

/** Observations by definition key for first passes, or by Context id (`run-1.key.pass2`) for later ones. */
function observed(
  entries: Record<string, { progress: ContextProgress | null; output?: unknown; active?: boolean }>,
): ObservedContexts {
  return new Map(
    Object.entries(entries).map(([key, entry]) => [
      key.startsWith("run-1.") ? key : `run-1.${key}`,
      { active: false, ...entry },
    ]),
  );
}

describe("scheduler", () => {
  it("starts every context without dependencies at launch", () => {
    expect(decideNext(facts([]), observed({})).map((s) => s.key)).toEqual(["api", "ui"]);
  });

  it("starts a context once all its dependencies succeeded, with their accepted outputs as inputs", () => {
    const partly = observed({
      api: { progress: succeeded("c-api"), output: { endpoint: "/v1/x" } },
      ui: { progress: running },
    });
    expect(decideNext(facts(["api", "ui"]), partly)).toEqual([]);

    const both = observed({
      api: { progress: succeeded("c-api"), output: { endpoint: "/v1/x" } },
      ui: { progress: succeeded("c-ui"), output: { summary: "Built the page." } },
    });
    expect(decideNext(facts(["api", "ui"]), both)).toEqual([
      {
        key: "integrate",
        pass: 0,
        contextId: "run-1.integrate",
        inputs: [
          { key: "api", title: "Title api", output: { endpoint: "/v1/x" } },
          { key: "ui", title: "Title ui", output: { summary: "Built the page." } },
        ],
      },
    ]);
  });

  it("starts nothing new while paused or cancelled, and never starts a context twice", () => {
    const done = observed({
      api: { progress: succeeded("c-api"), output: null },
      ui: { progress: succeeded("c-ui"), output: null },
    });
    expect(decideNext(facts(["api", "ui"], { paused: true, cancelled: false, fault: null }), done)).toEqual([]);
    expect(decideNext(facts(["api", "ui"], { paused: false, cancelled: true, fault: null }), done)).toEqual([]);
    expect(decideNext(facts(["api", "ui", "integrate"]), done)).toEqual([]);
  });
});

describe("run progress", () => {
  const question: ContextProgress = {
    kind: "waiting",
    obligation: { kind: "await_answer", questionId: "q-1" },
  };

  it("succeeds only when every defined context succeeded, not every started one", () => {
    const roots = observed({
      api: { progress: succeeded("c-api") },
      ui: { progress: succeeded("c-ui") },
    });
    expect(deriveRunProgress(facts(["api", "ui"]), roots)).toEqual({ kind: "running" });

    const all = observed({
      api: { progress: succeeded("c-api") },
      ui: { progress: succeeded("c-ui") },
      integrate: { progress: succeeded("c-int") },
    });
    expect(deriveRunProgress(facts(["api", "ui", "integrate"]), all)).toEqual({
      kind: "succeeded",
    });
  });

  it("needs the owner only once no other context can make progress", () => {
    expect(
      deriveRunProgress(facts(["api", "ui"]), observed({ api: { progress: question }, ui: { progress: running } })),
    ).toEqual({ kind: "running" });
    // integrate waits on api, so nothing else can move.
    expect(
      deriveRunProgress(
        facts(["api", "ui"]),
        observed({ api: { progress: halted }, ui: { progress: succeeded("c-ui") } }),
      ),
    ).toEqual({ kind: "needs_owner", reasons: ["api: halted (turn_failed)"] });
  });

  it("reports a paused run as draining while a started context's admitted effect still runs", () => {
    const paused = { paused: true, cancelled: false, fault: null };
    expect(
      deriveRunProgress(
        facts(["api", "ui"], paused),
        observed({ api: { progress: running, active: true }, ui: { progress: running } }),
      ),
    ).toEqual({ kind: "paused", draining: true });
    expect(
      deriveRunProgress(facts(["api", "ui"], paused), observed({ api: { progress: running }, ui: { progress: running } })),
    ).toEqual({ kind: "paused", draining: false });
  });

  it("needs the owner while the run itself faulted, and starts nothing until then", () => {
    const faulted = { paused: false, cancelled: false, fault: { detail: "The definition could not be read", at: "t" } };
    const roots = observed({
      api: { progress: succeeded("c-api"), output: null },
      ui: { progress: succeeded("c-ui"), output: null },
    });
    expect(decideNext(facts(["api", "ui"], faulted), roots)).toEqual([]);
    expect(deriveRunProgress(facts(["api", "ui"], faulted), roots)).toEqual({
      kind: "needs_owner",
      reasons: ["run: The definition could not be read"],
    });
  });

  it("counts a started context its host has not created yet as work in progress", () => {
    expect(
      deriveRunProgress(
        facts(["api", "ui"]),
        observed({ api: { progress: question }, ui: { progress: null } }),
      ),
    ).toEqual({ kind: "running" });
  });

  it("is cancelled once every started context stopped, whatever never started", () => {
    const cancelled: ContextProgress = { kind: "cancelled" };
    expect(
      deriveRunProgress(
        facts(["api", "ui"], { paused: false, cancelled: true, fault: null }),
        observed({ api: { progress: cancelled }, ui: { progress: running } }),
      ),
    ).toEqual({ kind: "stopping" });
    expect(
      deriveRunProgress(
        facts(["api", "ui"], { paused: false, cancelled: true, fault: null }),
        observed({ api: { progress: cancelled }, ui: { progress: succeeded("c-ui") } }),
      ),
    ).toEqual({ kind: "cancelled" });
    // A start no Context took up before the permit was revoked never will be.
    expect(
      deriveRunProgress(
        facts(["api", "ui"], { paused: false, cancelled: true, fault: null }),
        observed({ api: { progress: cancelled }, ui: { progress: null } }),
      ),
    ).toEqual({ kind: "cancelled" });
  });
});

interface Defined {
  key: string;
  dependsOn?: string[];
  when?: Record<string, RouteGuard>;
  routing?: { cardinality: "independent" | "atLeastOne" | "exactlyOne" };
  outputSchema?: Record<string, unknown>;
}

/** A definition with routes or loops; `started` lists [key, pass] in start order. */
function workflow(
  defined: Defined[],
  started: Array<[string, number]>,
  loops: RunLoop[] = [],
): RunFacts {
  const requests = new Map(
    defined.map((d) => [d.key, request(d.key, d.outputSchema ?? null)]),
  );
  return {
    runId: "run-1",
    kind: "workflow",
    title: "Routed work",
    definition: {
      revision: 1,
      contexts: defined.map((d) => ({
        key: d.key,
        dependsOn: d.dependsOn ?? [],
        ...(d.when !== undefined ? { when: d.when } : {}),
        ...(d.routing !== undefined ? { routing: d.routing } : {}),
        request: requests.get(d.key) ?? request(d.key),
      })),
      loops,
    },
    invocations: started.map(([key, pass]) => ({
      key,
      pass,
      contextId: at(key, pass),
      startCause: `run-1:start:${key}:${pass}`,
      request: requests.get(key) ?? request(key),
    })),
    control: { paused: false, cancelled: false, fault: null },
  };
}

const keysOf = (starts: ReturnType<typeof decideNext>) =>
  starts.map((start) => `${start.key}@${start.pass}`);

/** The Context a pass of a key runs in: later passes get fresh Contexts. */
const at = (key: string, pass: number): string =>
  pass === 0 ? `run-1.${key}` : `run-1.${key}.pass${pass + 1}`;

describe("routes", () => {
  const triageSchema = {
    type: "object",
    properties: { kind: { type: "string", enum: ["bug", "feature", "chore"] } },
    required: ["kind"],
  };
  const isBug = { schema: { properties: { kind: { const: "bug" } } } };
  const isFeature = { schema: { properties: { kind: { const: "feature" } } } };

  /** triage routes to fix (bug) or design (else); notes follows fix; report joins fix and design. */
  const routed = (cardinality?: "atLeastOne" | "exactlyOne"): Defined[] => [
    {
      key: "triage",
      outputSchema: triageSchema,
      ...(cardinality !== undefined ? { routing: { cardinality } } : {}),
    },
    { key: "fix", dependsOn: ["triage"], when: { triage: isBug } },
    { key: "design", dependsOn: ["triage"], when: { triage: { else: true } } },
    { key: "notes", dependsOn: ["fix"] },
    { key: "report", dependsOn: ["fix", "design"] },
  ];

  it("starts only the branch whose guard matches the accepted output, and skips the rest", () => {
    const triaged = observed({ triage: { progress: succeeded("c-t"), output: { kind: "bug" } } });
    expect(decideNext(workflow(routed(), [["triage", 0]]), triaged)).toEqual([
      {
        key: "fix",
        pass: 0,
        contextId: "run-1.fix",
        inputs: [{ key: "triage", title: "Title triage", output: { kind: "bug" } }],
      },
    ]);
    expect(planRun(workflow(routed(), [["triage", 0]]), triaged).keys.get("design")).toEqual({
      kind: "skipped",
    });
  });

  it("takes the else branch when no guarded sibling matched, and skips what only the other branch leads to", () => {
    const facts = workflow(routed(), [["triage", 0], ["design", 0]]);
    const designed = observed({
      triage: { progress: succeeded("c-t"), output: { kind: "feature" } },
      design: { progress: succeeded("c-d"), output: { summary: "Designed it." } },
    });
    // report joins fix and design: the skipped fix drops out, so report builds on design alone.
    expect(decideNext(facts, designed)).toEqual([
      {
        key: "report",
        pass: 0,
        contextId: "run-1.report",
        inputs: [{ key: "design", title: "Title design", output: { summary: "Designed it." } }],
      },
    ]);
    expect(planRun(facts, designed).keys.get("notes")).toEqual({ kind: "skipped" });

    const finished = workflow(routed(), [["triage", 0], ["design", 0], ["report", 0]]);
    const all = observed({
      triage: { progress: succeeded("c-t"), output: { kind: "feature" } },
      design: { progress: succeeded("c-d"), output: { summary: "Designed it." } },
      report: { progress: succeeded("c-r"), output: { summary: "Reported." } },
    });
    expect(deriveRunProgress(finished, all)).toEqual({ kind: "succeeded" });
  });

  it("commits no route from a source whose choice breaks its cardinality, while independent work continues", () => {
    const defined: Defined[] = [
      { key: "triage", outputSchema: triageSchema, routing: { cardinality: "atLeastOne" } },
      { key: "fix", dependsOn: ["triage"], when: { triage: isBug } },
      { key: "design", dependsOn: ["triage"], when: { triage: isFeature } },
      { key: "log", dependsOn: ["triage"] },
      { key: "docs" },
    ];
    const facts = workflow(defined, [["triage", 0], ["docs", 0]]);
    const chore = { progress: succeeded("c-t"), output: { kind: "chore" } };
    expect(decideNext(facts, observed({ triage: chore, docs: { progress: running } }))).toEqual([]);
    const plan = planRun(facts, observed({ triage: chore, docs: { progress: running } }));
    expect(plan.halts).toEqual([
      expect.objectContaining({ kind: "route_cardinality", occurrence: "route:triage:cardinality" }),
    ]);
    expect(plan.keys.get("fix")).toEqual({ kind: "waiting", pass: 0, on: ["triage"] });
    expect(deriveRunProgress(facts, observed({ triage: chore, docs: { progress: running } }))).toEqual({
      kind: "running",
    });
    // Once nothing else can move, the run needs its owner, and it never succeeds around the halt.
    const progress = deriveRunProgress(
      facts,
      observed({ triage: chore, docs: { progress: succeeded("c-docs") } }),
    );
    expect(progress.kind).toBe("needs_owner");
    expect(progress.kind === "needs_owner" ? progress.reasons : []).toEqual([
      expect.stringContaining('route: "triage"'),
    ]);
  });

  it("refuses to choose two branches where exactly one is allowed", () => {
    const defined: Defined[] = [
      { key: "triage", outputSchema: triageSchema, routing: { cardinality: "exactlyOne" } },
      { key: "fix", dependsOn: ["triage"], when: { triage: isBug } },
      { key: "also", dependsOn: ["triage"], when: { triage: { schema: { required: ["kind"] } } } },
    ];
    const facts = workflow(defined, [["triage", 0]]);
    const bug = observed({ triage: { progress: succeeded("c-t"), output: { kind: "bug" } } });
    expect(decideNext(facts, bug)).toEqual([]);
    expect(planRun(facts, bug).halts.map((h) => h.kind)).toEqual(["route_cardinality"]);
  });

  it("reads a guard only where one was given, whatever the dependency is called", () => {
    // `constructor` names a property every plain object inherits.
    const defined: Defined[] = [
      { key: "triage", outputSchema: triageSchema },
      { key: "constructor", dependsOn: ["triage"], when: { triage: isFeature } },
      { key: "join", dependsOn: ["constructor", "triage"], when: { triage: isBug } },
    ];
    const facts = workflow(defined, [["triage", 0]]);
    const bug = observed({ triage: { progress: succeeded("c-t"), output: { kind: "bug" } } });
    expect(decideNext(facts, bug)).toEqual([
      {
        key: "join",
        pass: 0,
        contextId: "run-1.join",
        inputs: [{ key: "triage", title: "Title triage", output: { kind: "bug" } }],
      },
    ]);
  });

  it("counts halts as all that stands only when no other work remains, whatever pause or fault hold", () => {
    const defined: Defined[] = [
      { key: "triage", outputSchema: triageSchema, routing: { cardinality: "atLeastOne" } },
      { key: "fix", dependsOn: ["triage"], when: { triage: isFeature } },
      { key: "docs" },
      { key: "after-docs", dependsOn: ["docs"] },
    ];
    const chore = { progress: succeeded("c-t"), output: { kind: "chore" } };
    const control = (paused: boolean, fault: RunFacts["control"]["fault"] = null) => ({ paused, cancelled: false, fault });
    const remains = (started: Array<[string, number]>, seen: ObservedContexts, paused = false, fault: RunFacts["control"]["fault"] = null) => {
      const facts = { ...workflow(defined, started), control: control(paused, fault) };
      return onlyHaltsRemain(facts, seen, planRun(facts, seen));
    };
    const docsDone = { progress: succeeded("c-docs"), output: null };

    // Paused with a start still due: the pause holds that work, it does not finish it.
    expect(remains([["triage", 0], ["docs", 0]], observed({ triage: chore, docs: docsDone }), true)).toBe(false);
    // A question held by the pause still waits on the owner.
    const heldQuestion: ContextProgress = {
      kind: "paused",
      next: { kind: "waiting", obligation: { kind: "await_answer", questionId: "q-1" } },
      draining: false,
    };
    expect(remains([["triage", 0], ["docs", 0]], observed({ triage: chore, docs: { progress: heldQuestion } }), true)).toBe(false);
    // A fault may hide work that is still running.
    expect(
      remains(
        [["triage", 0], ["docs", 0], ["after-docs", 0]],
        observed({ triage: chore, docs: docsDone, "after-docs": { progress: succeeded("c-a"), output: null } }),
        false,
        { detail: "The Run could not be read", at: "t" },
      ),
    ).toBe(false);
    expect(
      remains(
        [["triage", 0], ["docs", 0], ["after-docs", 0]],
        observed({ triage: chore, docs: docsDone, "after-docs": { progress: succeeded("c-a"), output: null } }),
        true,
      ),
    ).toBe(true);
  });

  it("halts the routes it cannot evaluate instead of reading a missing output as false", () => {
    const facts = workflow(routed(), [["triage", 0]]);
    const unreadable = observed({ triage: { progress: succeeded("c-t"), output: null } });
    expect(decideNext(facts, unreadable)).toEqual([]);
    expect(planRun(facts, unreadable).halts.map((h) => [h.kind, h.occurrence])).toEqual([
      ["route_unevaluable", "route:fix:unevaluable"],
      ["route_unevaluable", "route:design:unevaluable"],
    ]);
    expect(deriveRunProgress(facts, unreadable).kind).toBe("needs_owner");
  });
});

describe("loops", () => {
  const reviewSchema = {
    type: "object",
    properties: { approved: { type: "boolean" }, findings: { type: "string" } },
    required: ["approved"],
  };
  const polish = (maxPasses: number): RunLoop => ({
    key: "polish",
    body: ["implement", "review"],
    entry: "implement",
    exit: "review",
    until: { schema: { properties: { approved: { const: true } } } },
    maxPasses,
  });
  const defined: Defined[] = [
    { key: "plan" },
    { key: "implement", dependsOn: ["plan"] },
    { key: "review", dependsOn: ["implement"], outputSchema: reviewSchema },
    { key: "ship", dependsOn: ["review"] },
  ];
  const planned = { progress: succeeded("c-plan"), output: { summary: "Planned." } };
  const rejected = { approved: false, findings: "Missing tests." };

  it("runs the next pass in fresh Contexts, carrying the exit's result, until the exit condition holds", () => {
    const firstPass = workflow(defined, [["plan", 0], ["implement", 0], ["review", 0]], [polish(3)]);
    const reviewed = observed({
      plan: planned,
      implement: { progress: succeeded("c-i1"), output: { summary: "Implemented." } },
      review: { progress: succeeded("c-r1"), output: rejected },
    });
    expect(decideNext(firstPass, reviewed)).toEqual([
      {
        key: "implement",
        pass: 1,
        contextId: "run-1.implement.pass2",
        inputs: [
          { key: "plan", title: "Title plan", output: { summary: "Planned." } },
          { key: "review", title: "Title review (pass 1)", output: rejected },
        ],
      },
    ]);

    // Within a pass, a member waits on that pass's work, not the last pass's.
    const secondPass = workflow(
      defined,
      [["plan", 0], ["implement", 0], ["review", 0], ["implement", 1]],
      [polish(3)],
    );
    const implementing = new Map([
      ...reviewed,
      ...observed({ [at("implement", 1)]: { progress: running } }),
    ]);
    expect(decideNext(secondPass, implementing)).toEqual([]);
    expect(planRun(secondPass, implementing).keys.get("review")).toEqual({
      kind: "waiting",
      pass: 1,
      on: ["implement"],
    });
    const implemented = new Map([
      ...reviewed,
      ...observed({ [at("implement", 1)]: { progress: succeeded("c-i2"), output: { summary: "Added tests." } } }),
    ]);
    expect(decideNext(secondPass, implemented)).toEqual([
      {
        key: "review",
        pass: 1,
        contextId: "run-1.review.pass2",
        inputs: [{ key: "implement", title: "Title implement", output: { summary: "Added tests." } }],
      },
    ]);
  });

  it("gives work after the loop only the final pass's result, once the loop succeeded on its last allowed pass", () => {
    const facts = workflow(
      defined,
      [["plan", 0], ["implement", 0], ["review", 0], ["implement", 1], ["review", 1]],
      [polish(2)],
    );
    const lastPassRunning = observed({
      plan: planned,
      implement: { progress: succeeded("c-i1"), output: { summary: "Implemented." } },
      review: { progress: succeeded("c-r1"), output: rejected },
      [at("implement", 1)]: { progress: succeeded("c-i2"), output: { summary: "Added tests." } },
      [at("review", 1)]: { progress: running },
    });
    expect(decideNext(facts, lastPassRunning)).toEqual([]);

    const approved = { approved: true, findings: "" };
    const lastPassApproved = new Map([
      ...lastPassRunning,
      ...observed({ [at("review", 1)]: { progress: succeeded("c-r2"), output: approved } }),
    ]);
    expect(decideNext(facts, lastPassApproved)).toEqual([
      {
        key: "ship",
        pass: 0,
        contextId: "run-1.ship",
        inputs: [{ key: "review", title: "Title review", output: approved }],
      },
    ]);
    const shipped = workflow(
      defined,
      [["plan", 0], ["implement", 0], ["review", 0], ["implement", 1], ["review", 1], ["ship", 0]],
      [polish(2)],
    );
    expect(
      deriveRunProgress(
        shipped,
        new Map([...lastPassApproved, ...observed({ ship: { progress: succeeded("c-s") } })]),
      ),
    ).toEqual({ kind: "succeeded" });
  });

  it("halts an exhausted loop and starts nothing after it", () => {
    const facts = workflow(defined, [["plan", 0], ["implement", 0], ["review", 0]], [polish(1)]);
    const reviewed = observed({
      plan: planned,
      implement: { progress: succeeded("c-i1"), output: { summary: "Implemented." } },
      review: { progress: succeeded("c-r1"), output: rejected },
    });
    expect(decideNext(facts, reviewed)).toEqual([]);
    expect(planRun(facts, reviewed).halts).toEqual([
      expect.objectContaining({ kind: "loop_exhausted", occurrence: "loop:polish:exhausted:1" }),
    ]);
    const progress = deriveRunProgress(facts, reviewed);
    expect(progress.kind === "needs_owner" ? progress.reasons : []).toEqual([
      expect.stringContaining('loop "polish"'),
    ]);
  });

  it("halts a loop whose exit result cannot be evaluated", () => {
    const facts = workflow(defined, [["plan", 0], ["implement", 0], ["review", 0]], [polish(3)]);
    const unreadable = observed({
      plan: planned,
      implement: { progress: succeeded("c-i1"), output: { summary: "Implemented." } },
      review: { progress: succeeded("c-r1"), output: null },
    });
    expect(decideNext(facts, unreadable)).toEqual([]);
    expect(planRun(facts, unreadable).halts.map((h) => h.occurrence)).toEqual([
      "loop:polish:unevaluable:1",
    ]);
  });

  it("routes out of a loop on the final pass's result only", () => {
    const risky = { schema: { type: "object", properties: { risky: { const: true } } } };
    const routedOut: Defined[] = [
      ...defined.slice(0, 3),
      { key: "escalate", dependsOn: ["review"], when: { review: risky } },
      { key: "ship", dependsOn: ["review"], when: { review: { else: true } } },
    ];
    const facts = workflow(
      routedOut,
      [["plan", 0], ["implement", 0], ["review", 0], ["implement", 1], ["review", 1]],
      [polish(3)],
    );
    const passes = observed({
      plan: planned,
      implement: { progress: succeeded("c-i1"), output: { summary: "First." } },
      review: { progress: succeeded("c-r1"), output: { approved: false, risky: false } },
      [at("implement", 1)]: { progress: succeeded("c-i2"), output: { summary: "Second." } },
      [at("review", 1)]: { progress: succeeded("c-r2"), output: { approved: true, risky: true } },
    });
    expect(decideNext(facts, passes)).toEqual([
      {
        key: "escalate",
        pass: 0,
        contextId: "run-1.escalate",
        inputs: [{ key: "review", title: "Title review", output: { approved: true, risky: true } }],
      },
    ]);
    expect(planRun(facts, passes).keys.get("ship")).toEqual({ kind: "skipped" });
  });

  it("carries the exit results of the three most recent passes into the next one", () => {
    const passes = [0, 1, 2, 3];
    const facts = workflow(
      defined,
      [["plan", 0], ...passes.flatMap((pass): Array<[string, number]> => [["implement", pass], ["review", pass]])],
      [polish(6)],
    );
    const seen = observed({
      plan: planned,
      ...Object.fromEntries(
        passes.flatMap((pass) => [
          [at("implement", pass), { progress: succeeded(`c-i${pass}`), output: { summary: `Try ${pass + 1}.` } }],
          [at("review", pass), { progress: succeeded(`c-r${pass}`), output: { approved: false, findings: `F${pass + 1}` } }],
        ]),
      ),
    });
    expect(decideNext(facts, seen)).toEqual([
      {
        key: "implement",
        pass: 4,
        contextId: "run-1.implement.pass5",
        inputs: [
          { key: "plan", title: "Title plan", output: { summary: "Planned." } },
          { key: "review", title: "Title review (pass 2)", output: { approved: false, findings: "F2" } },
          { key: "review", title: "Title review (pass 3)", output: { approved: false, findings: "F3" } },
          { key: "review", title: "Title review (pass 4)", output: { approved: false, findings: "F4" } },
        ],
      },
    ]);
  });

  it("holds the next pass through a pause and starts it on resume", () => {
    const facts = workflow(defined, [["plan", 0], ["implement", 0], ["review", 0]], [polish(3)]);
    const reviewed = observed({
      plan: planned,
      implement: { progress: succeeded("c-i1"), output: { summary: "Implemented." } },
      review: { progress: succeeded("c-r1"), output: rejected },
    });
    const paused = { ...facts, control: { paused: true, cancelled: false, fault: null } };
    expect(decideNext(paused, reviewed)).toEqual([]);
    expect(deriveRunProgress(paused, reviewed)).toEqual({ kind: "paused", draining: false });
    expect(planRun(paused, reviewed).loops.get("polish")).toEqual({ kind: "next", pass: 0 });
    expect(keysOf(decideNext(facts, reviewed))).toEqual(["implement@1"]);
  });

  it("skips the whole loop when the route into its entry is not taken", () => {
    const gated: Defined[] = [
      {
        key: "plan",
        outputSchema: { type: "object", properties: { go: { type: "boolean" } }, required: ["go"] },
      },
      { key: "implement", dependsOn: ["plan"], when: { plan: { schema: { properties: { go: { const: true } } } } } },
      { key: "review", dependsOn: ["implement"], outputSchema: reviewSchema },
      { key: "ship", dependsOn: ["review"] },
    ];
    const facts = workflow(gated, [["plan", 0]], [polish(3)]);
    const stop = observed({ plan: { progress: succeeded("c-plan"), output: { go: false } } });
    expect(decideNext(facts, stop)).toEqual([]);
    expect(planRun(facts, stop).keys.get("review")).toEqual({ kind: "skipped" });
    expect(deriveRunProgress(facts, stop)).toEqual({ kind: "succeeded" });
  });
});
