import { describe, expect, it } from "vitest";
import type { EdgeGuardDeclaration } from "@/lib/workflow-graph/edge-guard-validation";
import {
  activeDependencySourceIds,
  incomingRoutes,
  projectRoutes,
  resolvedRouteEdge,
  routeVerdict,
  type RouteCardinalityPolicy,
  type RouteProjection,
  type RouteProjectionContextStatus,
  type RouteProjectionLoop,
} from "./route-projection";

/**
 * The route-resolution truth table (D4 R1/R2/R3). Every routing rule the engine
 * has is decided here and nowhere else, so this suite is the contract the
 * scheduler, lane readiness, joins, upstream-input resolution, the final
 * publish, the CLI and the UI all inherit.
 */

interface TestOutput {
  value: Record<string, unknown>;
  iteration: number;
}

const VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

/** A guard matching one `verdict` value. */
function verdictIs(value: string): EdgeGuardDeclaration {
  return {
    schema: { type: "object", properties: { verdict: { const: value } } },
  };
}

const ELSE: EdgeGuardDeclaration = { else: true };

interface ContextSpec {
  id: string;
  status?: RouteProjectionContextStatus;
  outputSchema?: Record<string, unknown>;
  cardinality?: RouteCardinalityPolicy;
}

interface EdgeSpec {
  id?: string;
  from: string;
  to: string;
  when?: EdgeGuardDeclaration;
}

function project(spec: {
  contexts: ContextSpec[];
  edges: EdgeSpec[];
  outputs?: Record<string, Record<string, unknown>>;
  loops?: RouteProjectionLoop[];
}): RouteProjection {
  return projectRoutes<TestOutput>({
    executionContexts: spec.contexts.map((context) => ({
      id: context.id,
      ...(context.outputSchema ? { outputSchema: context.outputSchema } : {}),
      ...(context.cardinality
        ? { routing: { cardinality: context.cardinality } }
        : {}),
    })),
    edges: spec.edges.map((edge) => ({
      id: edge.id ?? `${edge.from}__${edge.to}`,
      sourceContextId: edge.from,
      targetContextId: edge.to,
      ...(edge.when ? { when: edge.when } : {}),
    })),
    contextStates: Object.fromEntries(
      spec.contexts.map((context) => [
        context.id,
        { status: context.status ?? "pending" },
      ]),
    ),
    contextOutputs: Object.fromEntries(
      Object.entries(spec.outputs ?? {}).map(([contextId, value]) => [
        contextId,
        { value, iteration: 1 },
      ]),
    ),
    ...(spec.loops ? { loops: spec.loops } : {}),
  });
}

/** The classifier fixture: a completed source with a captured `verdict`. */
function classifier(
  verdict: string,
  edges: EdgeSpec[],
  extra: ContextSpec[] = [],
) {
  return project({
    contexts: [
      { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
      ...extra,
    ],
    edges,
    outputs: { classify: { verdict } },
  });
}

function resolutionOf(projection: RouteProjection, edgeId: string): string {
  return resolvedRouteEdge(projection, edgeId)?.resolution.kind ?? "missing";
}

describe("guard evaluation runs through the shared schema-subset validator (R1.2)", () => {
  it("activates an edge whose guard matches the source's captured output", () => {
    const projection = classifier(
      "bug",
      [{ from: "classify", to: "fix", when: verdictIs("bug") }],
      [{ id: "fix" }],
    );

    expect(resolutionOf(projection, "classify__fix")).toBe("active");
    expect(routeVerdict(projection, "fix")).toEqual({ kind: "eligible" });
  });

  it("deactivates an edge whose guard does not match, skipping the target", () => {
    const projection = classifier(
      "feature",
      [{ from: "classify", to: "fix", when: verdictIs("bug") }],
      [{ id: "fix" }],
    );

    expect(resolutionOf(projection, "classify__fix")).toBe("inactive");
    expect(routeVerdict(projection, "fix")).toEqual({
      kind: "skip",
      edgeEvaluations: [{ edgeId: "classify__fix", verdict: "inactive" }],
    });
  });

  it.each([
    // Declared but never banked — a live edit can re-add a schema after capture.
    ["pending", { outputSchema: VERDICT_SCHEMA }, undefined],
    // Banked under a contract the definition no longer declares.
    ["orphaned", {}, { verdict: "bug" }],
    // Neither declaration nor payload.
    ["none", {}, undefined],
  ] as const)(
    "never evaluates a %s lookup — it raises the resumable invariant halt instead",
    (reason, contextExtras, output) => {
      const projection = project({
        contexts: [
          { id: "classify", status: "completed", ...contextExtras },
          { id: "fix" },
        ],
        edges: [{ from: "classify", to: "fix", when: verdictIs("bug") }],
        ...(output ? { outputs: { classify: output } } : {}),
      });

      expect(
        resolvedRouteEdge(projection, "classify__fix")?.resolution,
      ).toEqual({
        kind: "unevaluable",
        reason,
      });
      expect(routeVerdict(projection, "fix")).toEqual({
        kind: "halt",
        reason: "guard-unevaluable",
        edgeIds: ["classify__fix"],
      });
    },
  );

  describe("adversarial payload keys", () => {
    it.each(["__proto__", "constructor", "toString"])(
      "does not let an inherited %s satisfy a guard that requires it",
      (key) => {
        const projection = project({
          contexts: [
            {
              id: "classify",
              status: "completed",
              outputSchema: VERDICT_SCHEMA,
            },
            { id: "fix" },
          ],
          edges: [
            {
              from: "classify",
              to: "fix",
              when: {
                schema: JSON.parse(
                  `{"type":"object","properties":{"${key}":{"type":"string"}},"required":["${key}"]}`,
                ) as Record<string, unknown>,
              },
            },
          ],
          outputs: { classify: { verdict: "bug" } },
        });

        expect(resolutionOf(projection, "classify__fix")).toBe("inactive");
        expect(routeVerdict(projection, "fix")).toMatchObject({ kind: "skip" });
      },
    );

    it("activates on a genuine OWN payload property with an exotic name", () => {
      const projection = project({
        contexts: [
          { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
          { id: "fix" },
        ],
        edges: [
          {
            from: "classify",
            to: "fix",
            when: {
              schema: JSON.parse(
                '{"type":"object","properties":{"__proto__":{"const":"ok"}},"required":["__proto__"]}',
              ) as Record<string, unknown>,
            },
          },
        ],
        outputs: {
          classify: JSON.parse('{"verdict":"bug","__proto__":"ok"}') as Record<
            string,
            unknown
          >,
        },
      });

      expect(resolutionOf(projection, "classify__fix")).toBe("active");
    });

    it("does not read an Object.prototype member as an exotically named context's capture", () => {
      // `contextOutputs["constructor"]` is a function on the prototype chain; a
      // guard evaluated against it would be a route decided on a payload no
      // context ever produced.
      const projection = project({
        contexts: [
          {
            id: "constructor",
            status: "completed",
            outputSchema: VERDICT_SCHEMA,
          },
          { id: "fix" },
        ],
        edges: [{ from: "constructor", to: "fix", when: verdictIs("bug") }],
      });

      expect(
        resolvedRouteEdge(projection, "constructor__fix")?.resolution,
      ).toEqual({
        kind: "unevaluable",
        reason: "pending",
      });
    });
  });
});

describe("else edges resolve order-free (R1.3)", () => {
  const branches = (order: "else-last" | "else-first"): EdgeSpec[] => {
    const conditional: EdgeSpec[] = [
      { id: "to-bug", from: "classify", to: "fix", when: verdictIs("bug") },
      {
        id: "to-feature",
        from: "classify",
        to: "build",
        when: verdictIs("feature"),
      },
    ];
    const fallback: EdgeSpec = {
      id: "to-triage",
      from: "classify",
      to: "triage",
      when: ELSE,
    };
    return order === "else-last"
      ? [...conditional, fallback]
      : [fallback, ...conditional];
  };

  const targets: ContextSpec[] = [
    { id: "fix" },
    { id: "build" },
    { id: "triage" },
  ];

  it.each(["else-last", "else-first"] as const)(
    "activates the else edge when no sibling activated (%s declaration order)",
    (order) => {
      const projection = classifier("unclear", branches(order), targets);

      expect(resolutionOf(projection, "to-triage")).toBe("active");
      expect(resolutionOf(projection, "to-bug")).toBe("inactive");
      expect(resolutionOf(projection, "to-feature")).toBe("inactive");
      expect(routeVerdict(projection, "triage")).toEqual({ kind: "eligible" });
    },
  );

  it.each(["else-last", "else-first"] as const)(
    "leaves the else edge inactive when a sibling activated (%s declaration order)",
    (order) => {
      const projection = classifier("bug", branches(order), targets);

      expect(resolutionOf(projection, "to-bug")).toBe("active");
      expect(resolutionOf(projection, "to-triage")).toBe("inactive");
      expect(routeVerdict(projection, "triage")).toMatchObject({
        kind: "skip",
      });
    },
  );

  it("does not fire the else branch of a skipped source", () => {
    const projection = project({
      contexts: [
        { id: "classify", status: "skipped", outputSchema: VERDICT_SCHEMA },
        { id: "fix" },
        { id: "triage" },
      ],
      edges: [
        { id: "to-bug", from: "classify", to: "fix", when: verdictIs("bug") },
        { id: "to-triage", from: "classify", to: "triage", when: ELSE },
      ],
    });

    expect(resolutionOf(projection, "to-triage")).toBe("inactive");
    expect(routeVerdict(projection, "triage")).toMatchObject({ kind: "skip" });
  });

  it("does not decide the else edge while a sibling guard is unevaluable", () => {
    const projection = project({
      contexts: [
        { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
        { id: "fix" },
        { id: "triage" },
      ],
      edges: [
        { id: "to-bug", from: "classify", to: "fix", when: verdictIs("bug") },
        { id: "to-triage", from: "classify", to: "triage", when: ELSE },
      ],
    });

    expect(resolvedRouteEdge(projection, "to-triage")?.resolution).toEqual({
      kind: "unevaluable",
      reason: "pending",
    });
  });
});

describe("every drawn edge is a conjunctive prerequisite (R2.1)", () => {
  const mixedInput = (verdict: string) =>
    project({
      contexts: [
        { id: "prep", status: "completed" },
        { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
        { id: "fix" },
      ],
      edges: [
        { id: "prep-edge", from: "prep", to: "fix" },
        {
          id: "guard-edge",
          from: "classify",
          to: "fix",
          when: verdictIs("bug"),
        },
      ],
      outputs: { classify: { verdict } },
    });

  it("skips a target whose landed unconditional dependency sits beside a resolved-false guard", () => {
    const projection = mixedInput("feature");

    expect(resolutionOf(projection, "prep-edge")).toBe("active");
    expect(resolutionOf(projection, "guard-edge")).toBe("inactive");
    expect(routeVerdict(projection, "fix")).toEqual({
      kind: "skip",
      edgeEvaluations: [
        { edgeId: "prep-edge", verdict: "active" },
        { edgeId: "guard-edge", verdict: "inactive" },
      ],
    });
  });

  it("runs the same target once the guard resolves true", () => {
    const projection = mixedInput("bug");

    expect(routeVerdict(projection, "fix")).toEqual({ kind: "eligible" });
    expect(activeDependencySourceIds(projection, "fix")).toEqual([
      "prep",
      "classify",
    ]);
  });
});

describe("skip propagation and fan-in compose by topology (R2.3)", () => {
  /**
   * classify guards two branch intermediates; both feed one unconditional
   * fan-in. Exactly the shape that reconciles R2.1 with a single active branch:
   * the fan-in's OWN edges carry no guard, so the skipped branch's edge is
   * omitted rather than vetoing the join.
   */
  function branchFanIn(
    verdict: string,
    options: { fixStatus?: RouteProjectionContextStatus } = {},
  ) {
    return project({
      contexts: [
        { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
        {
          id: "fix",
          ...(options.fixStatus ? { status: options.fixStatus } : {}),
        },
        { id: "build" },
        { id: "merge" },
        { id: "report" },
      ],
      edges: [
        { id: "to-fix", from: "classify", to: "fix", when: verdictIs("bug") },
        {
          id: "to-build",
          from: "classify",
          to: "build",
          when: verdictIs("feature"),
        },
        { id: "fix-merge", from: "fix", to: "merge" },
        { id: "build-merge", from: "build", to: "merge" },
        { id: "merge-report", from: "merge", to: "report" },
      ],
      outputs: { classify: { verdict } },
    });
  }

  it("runs a fan-in on the landed branch, omitting the skipped intermediate's edge", () => {
    const projection = branchFanIn("bug", { fixStatus: "completed" });

    expect(routeVerdict(projection, "build")).toMatchObject({ kind: "skip" });
    expect(resolutionOf(projection, "build-merge")).toBe("omitted");
    expect(resolutionOf(projection, "fix-merge")).toBe("active");
    expect(routeVerdict(projection, "merge")).toEqual({ kind: "eligible" });
    expect(activeDependencySourceIds(projection, "merge")).toEqual(["fix"]);
  });

  it("skips a fan-in and its exclusive descendants when every predecessor path is skipped", () => {
    const projection = branchFanIn("neither");

    expect(routeVerdict(projection, "fix")).toMatchObject({ kind: "skip" });
    expect(routeVerdict(projection, "build")).toMatchObject({ kind: "skip" });
    expect(routeVerdict(projection, "merge")).toEqual({
      kind: "skip",
      edgeEvaluations: [
        { edgeId: "fix-merge", verdict: "omitted" },
        { edgeId: "build-merge", verdict: "omitted" },
      ],
    });
    expect(routeVerdict(projection, "report")).toEqual({
      kind: "skip",
      edgeEvaluations: [{ edgeId: "merge-report", verdict: "omitted" }],
    });
  });

  it("waits for every incoming route to resolve before deciding, even beside a resolved-false edge", () => {
    const projection = project({
      contexts: [
        { id: "slow", status: "running" },
        { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
        { id: "merge" },
      ],
      edges: [
        { id: "slow-merge", from: "slow", to: "merge" },
        {
          id: "guard-merge",
          from: "classify",
          to: "merge",
          when: verdictIs("bug"),
        },
      ],
      outputs: { classify: { verdict: "feature" } },
    });

    expect(resolutionOf(projection, "slow-merge")).toBe("unresolved");
    expect(resolutionOf(projection, "guard-merge")).toBe("inactive");
    expect(routeVerdict(projection, "merge")).toEqual({ kind: "waiting" });
  });

  it("treats an entry context with no incoming edges as eligible", () => {
    const projection = project({ contexts: [{ id: "start" }], edges: [] });

    expect(routeVerdict(projection, "start")).toEqual({ kind: "eligible" });
    expect(incomingRoutes(projection, "start")).toEqual([]);
  });

  it("does not skip a context that already started", () => {
    const projection = project({
      contexts: [
        { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
        { id: "fix", status: "running" },
        { id: "after" },
      ],
      edges: [
        { from: "classify", to: "fix", when: verdictIs("bug") },
        { id: "fix-after", from: "fix", to: "after" },
      ],
      outputs: { classify: { verdict: "feature" } },
    });

    // The route says skip, but `running` is not a skippable status — the engine
    // never reaches it, and downstream must not be derived as skipped off it.
    expect(routeVerdict(projection, "fix")).toMatchObject({ kind: "skip" });
    expect(resolutionOf(projection, "fix-after")).toBe("unresolved");
    expect(routeVerdict(projection, "after")).toEqual({ kind: "waiting" });
  });
});

describe("cardinality outcomes (R3)", () => {
  function withCardinality(
    verdict: string,
    cardinality: RouteCardinalityPolicy | undefined,
    edges: EdgeSpec[],
  ) {
    return project({
      contexts: [
        {
          id: "classify",
          status: "completed",
          outputSchema: VERDICT_SCHEMA,
          ...(cardinality ? { cardinality } : {}),
        },
        { id: "fix" },
        { id: "build" },
        { id: "triage" },
      ],
      edges,
      outputs: { classify: { verdict } },
    });
  }

  const oneBranch: EdgeSpec[] = [
    { id: "to-fix", from: "classify", to: "fix", when: verdictIs("bug") },
  ];
  const twoBranches: EdgeSpec[] = [
    ...oneBranch,
    { id: "to-build", from: "classify", to: "build", when: verdictIs("bug") },
  ];

  it("never violates the implicit independent policy", () => {
    const projection = withCardinality("neither", undefined, twoBranches);

    expect(projection.cardinality).toEqual([
      {
        sourceContextId: "classify",
        policy: "independent",
        conditionalEdgeIds: ["to-fix", "to-build"],
        activatedEdgeIds: [],
        outcome: "satisfied",
      },
    ]);
  });

  it("reports under-selection when atLeastOne activates nothing", () => {
    const projection = withCardinality("neither", "atLeastOne", oneBranch);

    expect(projection.cardinality[0]).toMatchObject({
      outcome: "under-selection",
      activatedEdgeIds: [],
    });
  });

  it("counts an activated else edge toward atLeastOne", () => {
    const projection = withCardinality("neither", "atLeastOne", [
      ...oneBranch,
      { id: "to-triage", from: "classify", to: "triage", when: ELSE },
    ]);

    expect(projection.cardinality[0]).toMatchObject({
      outcome: "satisfied",
      activatedEdgeIds: ["to-triage"],
    });
  });

  it("reports over-selection when exactlyOne activates two branches", () => {
    const projection = withCardinality("bug", "exactlyOne", twoBranches);

    expect(projection.cardinality[0]).toMatchObject({
      outcome: "over-selection",
      activatedEdgeIds: ["to-fix", "to-build"],
    });
  });

  it("is satisfied when exactlyOne activates one branch", () => {
    const projection = withCardinality("bug", "exactlyOne", oneBranch);

    expect(projection.cardinality[0]).toMatchObject({ outcome: "satisfied" });
  });

  it("stays unresolved while the source has not completed", () => {
    const projection = project({
      contexts: [
        {
          id: "classify",
          status: "running",
          outputSchema: VERDICT_SCHEMA,
          cardinality: "exactlyOne",
        },
        { id: "fix" },
      ],
      edges: oneBranch,
    });

    expect(projection.cardinality[0]).toMatchObject({ outcome: "unresolved" });
  });

  it("reports nothing for a source with no conditional outgoing edges", () => {
    const projection = project({
      contexts: [{ id: "prep", status: "completed" }, { id: "fix" }],
      edges: [{ from: "prep", to: "fix" }],
    });

    expect(projection.cardinality).toEqual([]);
  });
});

describe("the transitive must-run set", () => {
  it("includes entry contexts and unconditional descendants of must-run predecessors", () => {
    const projection = project({
      contexts: [
        { id: "plan" },
        { id: "implement" },
        { id: "classify" },
        { id: "fix" },
        { id: "report" },
      ],
      edges: [
        { from: "plan", to: "implement" },
        { from: "implement", to: "classify" },
        { from: "classify", to: "fix", when: verdictIs("bug") },
        // Unconditional, but its only predecessor is itself conditionally
        // reached — the transitive counterexample a direct-guard-only check
        // would wrongly call must-run.
        { from: "fix", to: "report" },
      ],
    });

    expect([...projection.mustRunContextIds].sort()).toEqual([
      "classify",
      "implement",
      "plan",
    ]);
  });

  it("keeps a fan-in must-run when at least one unconditional path is must-run", () => {
    const projection = project({
      contexts: [
        { id: "plan" },
        { id: "classify" },
        { id: "fix" },
        { id: "merge" },
      ],
      edges: [
        { from: "plan", to: "classify" },
        { from: "classify", to: "fix", when: verdictIs("bug") },
        { from: "fix", to: "merge" },
        { from: "plan", to: "merge" },
      ],
    });

    expect(projection.mustRunContextIds.has("merge")).toBe(true);
  });
});

describe("publish settlement", () => {
  it("is unsettled while any context is neither completed nor skipped", () => {
    const projection = project({
      contexts: [
        { id: "plan", status: "completed" },
        { id: "implement", status: "running" },
      ],
      edges: [{ from: "plan", to: "implement" }],
    });

    expect(projection.publish).toEqual({
      settled: false,
      outstandingContextIds: ["implement"],
      contributingContextIds: ["plan"],
      skippedContextIds: [],
      outstandingLoopExitContextIds: [],
    });
  });

  it("settles with a derived skip contributing nothing", () => {
    const projection = project({
      contexts: [
        { id: "classify", status: "completed", outputSchema: VERDICT_SCHEMA },
        { id: "fix" },
      ],
      edges: [{ from: "classify", to: "fix", when: verdictIs("bug") }],
      outputs: { classify: { verdict: "feature" } },
    });

    expect(projection.publish).toEqual({
      settled: true,
      outstandingContextIds: [],
      contributingContextIds: ["classify"],
      skippedContextIds: ["fix"],
      outstandingLoopExitContextIds: [],
    });
  });

  /**
   * The resolved shape: a loop's declared exit is NOT an execution context — the
   * body lives in per-pass instances — so a context-only settlement calls a tail
   * loop finished between one pass landing and the next being materialized.
   */
  function tailLoop(
    activation: RouteProjectionLoop["activation"],
    concludingExitContextId: string | null = null,
  ): RouteProjection {
    return project({
      contexts: [
        { id: "refine__p1__work", status: "completed" },
        {
          id: "refine__p1__judge",
          status: "completed",
          outputSchema: VERDICT_SCHEMA,
        },
      ],
      edges: [{ from: "refine__p1__work", to: "refine__p1__judge" }],
      loops: [
        {
          id: "refine",
          exitContextId: "judge",
          bodyContextIds: ["refine__p1__work", "refine__p1__judge"],
          activationContextId: "refine__p1__work",
          activation,
          concludingExitContextId,
        },
      ],
    });
  }

  it("holds the publish open on an unsettled loop's logical exit", () => {
    for (const activation of ["unstarted", "running"] as const) {
      expect(tailLoop(activation).publish).toEqual({
        settled: false,
        outstandingContextIds: ["judge"],
        contributingContextIds: ["refine__p1__work", "refine__p1__judge"],
        skippedContextIds: [],
        outstandingLoopExitContextIds: ["judge"],
      });
    }
  });

  it("releases the publish once a loop concludes or is declined", () => {
    expect(tailLoop("concluded", "refine__p1__judge").publish).toMatchObject({
      settled: true,
      outstandingLoopExitContextIds: [],
    });
    // A declined loop owes nothing: the logical exit is not a skipped CONTEXT
    // either, so it contributes to neither side of the settlement.
    expect(tailLoop("skipped").publish).toMatchObject({
      settled: true,
      outstandingLoopExitContextIds: [],
      skippedContextIds: [],
    });
  });
});

describe("loop-exit resolution carries both source ids (D1)", () => {
  const loop = (
    activation: RouteProjectionLoop["activation"],
    concludingExitContextId: string | null = null,
  ): RouteProjectionLoop => ({
    id: "refine",
    exitContextId: "judge",
    bodyContextIds: ["work", "judge"],
    activationContextId: "work",
    activation,
    concludingExitContextId,
  });

  function loopGraph(
    activation: RouteProjectionLoop["activation"],
    options: {
      concluding?: string;
      exitStatus?: RouteProjectionContextStatus;
      outputs?: Record<string, Record<string, unknown>>;
      when?: EdgeGuardDeclaration;
    } = {},
  ) {
    return project({
      contexts: [
        { id: "work", status: "completed" },
        {
          id: "judge",
          status: options.exitStatus ?? "pending",
          outputSchema: VERDICT_SCHEMA,
        },
        { id: "judge#2", status: "completed", outputSchema: VERDICT_SCHEMA },
        { id: "publish" },
      ],
      edges: [
        { id: "work-judge", from: "work", to: "judge" },
        {
          id: "judge-publish",
          from: "judge",
          to: "publish",
          ...(options.when ? { when: options.when } : {}),
        },
      ],
      ...(options.outputs ? { outputs: options.outputs } : {}),
      loops: [loop(activation, options.concluding ?? null)],
    });
  }

  it("resolves an ordinary edge's effective source to its logical source", () => {
    const projection = project({
      contexts: [{ id: "plan", status: "completed" }, { id: "implement" }],
      edges: [{ id: "plan-implement", from: "plan", to: "implement" }],
    });

    expect(resolvedRouteEdge(projection, "plan-implement")).toMatchObject({
      logicalSourceId: "plan",
      effectiveSourceId: "plan",
    });
  });

  it("holds a running loop's external edges unresolved with no effective source", () => {
    const projection = loopGraph("running", { exitStatus: "completed" });

    expect(resolvedRouteEdge(projection, "judge-publish")).toMatchObject({
      logicalSourceId: "judge",
      effectiveSourceId: null,
      resolution: { kind: "unresolved" },
    });
    expect(routeVerdict(projection, "publish")).toEqual({ kind: "waiting" });
  });

  it("resolves a concluded loop against the concluding pass's exit instance", () => {
    const projection = loopGraph("concluded", {
      concluding: "judge#2",
      when: verdictIs("done"),
      outputs: { "judge#2": { verdict: "done" } },
    });

    expect(resolvedRouteEdge(projection, "judge-publish")).toMatchObject({
      logicalSourceId: "judge",
      effectiveSourceId: "judge#2",
      resolution: { kind: "active" },
    });
    expect(activeDependencySourceIds(projection, "publish")).toEqual([
      "judge#2",
    ]);
  });

  it("omits an untaken loop's unconditional external edge and deactivates a guarded one", () => {
    expect(resolutionOf(loopGraph("skipped"), "judge-publish")).toBe("omitted");
    expect(
      resolutionOf(
        loopGraph("skipped", { when: verdictIs("done") }),
        "judge-publish",
      ),
    ).toBe("inactive");
  });
});
