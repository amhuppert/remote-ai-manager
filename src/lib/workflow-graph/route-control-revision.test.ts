import { describe, expect, it } from "vitest";
import {
  ROUTE_CONTROL_REVISION_BUMP_TRIGGERS,
  bumpRouteControlRevisions,
  type RouteControlSurfaceDefinition,
} from "./route-control-revision";

const SHIP_GUARD = { schema: { properties: { verdict: { const: "ship" } } } };
const HOLD_GUARD = { schema: { properties: { verdict: { const: "hold" } } } };

function definition(
  overrides: Partial<RouteControlSurfaceDefinition> = {},
): RouteControlSurfaceDefinition {
  return {
    executionContexts: [{ id: "plan" }, { id: "build" }, { id: "doc" }],
    edges: [
      { id: "plan__build", sourceContextId: "plan", targetContextId: "build" },
    ],
    ...overrides,
  };
}

describe("bumpRouteControlRevisions — what bumps", () => {
  it("bumps the source when an outgoing conditional edge is added", () => {
    const before = definition();
    const after = definition({
      edges: [
        ...before.edges,
        {
          id: "plan__doc",
          sourceContextId: "plan",
          targetContextId: "doc",
          when: SHIP_GUARD,
        },
      ],
    });

    expect(bumpRouteControlRevisions({}, before, after)).toEqual({ plan: 1 });
  });

  it("bumps the source when an existing edge's guard changes", () => {
    const before = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: SHIP_GUARD,
        },
      ],
    });
    const after = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: HOLD_GUARD,
        },
      ],
    });

    expect(bumpRouteControlRevisions({ plan: 4 }, before, after)).toEqual({
      plan: 5,
    });
  });

  it("bumps the source when a conditional edge is removed", () => {
    const before = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: { else: true },
        },
      ],
    });
    const after = definition({ edges: [] });

    expect(bumpRouteControlRevisions({}, before, after)).toEqual({ plan: 1 });
  });

  it("bumps the source when its routing cardinality changes", () => {
    const before = definition();
    const after = definition({
      executionContexts: [
        { id: "plan", routing: { cardinality: "exactlyOne" } },
        { id: "build" },
        { id: "doc" },
      ],
    });

    expect(bumpRouteControlRevisions({}, before, after)).toEqual({ plan: 1 });
  });

  it("is monotonic across repeated changes", () => {
    const unconditional = definition();
    const guarded = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: SHIP_GUARD,
        },
      ],
    });

    const first = bumpRouteControlRevisions({}, unconditional, guarded);
    // Reverting to the earlier guard set must NOT reproduce the earlier
    // revision — that is the A→B→A case a content hash cannot survive.
    const second = bumpRouteControlRevisions(first, guarded, unconditional);
    const third = bumpRouteControlRevisions(second, unconditional, guarded);

    expect([first.plan, second.plan, third.plan]).toEqual([1, 2, 3]);
  });
});

describe("bumpRouteControlRevisions — what does not bump", () => {
  it("leaves the map untouched when nothing changed", () => {
    expect(
      bumpRouteControlRevisions({ plan: 2 }, definition(), definition()),
    ).toEqual({ plan: 2 });
  });

  it("does not bump for an added or removed unconditional edge", () => {
    const before = definition();
    const after = definition({
      edges: [
        ...before.edges,
        { id: "plan__doc", sourceContextId: "plan", targetContextId: "doc" },
      ],
    });

    expect(bumpRouteControlRevisions({}, before, after)).toEqual({});
    expect(bumpRouteControlRevisions({}, after, before)).toEqual({});
  });

  it("does not bump a source whose guard document is only re-serialized", () => {
    const before = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: { schema: { type: "object", properties: { a: {}, b: {} } } },
        },
      ],
    });
    const after = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: { schema: { properties: { b: {}, a: {} }, type: "object" } },
        },
      ],
    });

    expect(bumpRouteControlRevisions({}, before, after)).toEqual({});
  });

  it("does not bump a sibling source whose own routes are unchanged", () => {
    const before = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: SHIP_GUARD,
        },
        { id: "build__doc", sourceContextId: "build", targetContextId: "doc" },
      ],
    });
    const after = definition({
      edges: [
        {
          id: "plan__build",
          sourceContextId: "plan",
          targetContextId: "build",
          when: HOLD_GUARD,
        },
        { id: "build__doc", sourceContextId: "build", targetContextId: "doc" },
      ],
    });

    expect(bumpRouteControlRevisions({ build: 3 }, before, after)).toEqual({
      plan: 1,
      build: 3,
    });
  });

  it("gives a newly added context no entry, even when it is born with a guarded out-edge", () => {
    const before = definition();
    const after = definition({
      executionContexts: [...definition().executionContexts, { id: "review" }],
      edges: [
        ...definition().edges,
        {
          id: "review__doc",
          sourceContextId: "review",
          targetContextId: "doc",
          when: SHIP_GUARD,
        },
      ],
    });

    expect(bumpRouteControlRevisions({}, before, after)).toEqual({});
  });

  it("drops the entry of a context that no longer exists", () => {
    const before = definition();
    const after = definition({
      executionContexts: [{ id: "plan" }, { id: "build" }],
    });

    expect(
      bumpRouteControlRevisions({ plan: 1, doc: 7 }, before, after),
    ).toEqual({ plan: 1 });
  });
});

describe("ROUTE_CONTROL_REVISION_BUMP_TRIGGERS", () => {
  it("names the closed bump set the projection implements", () => {
    expect([...ROUTE_CONTROL_REVISION_BUMP_TRIGGERS]).toEqual([
      "outgoing-conditional-edge-added",
      "outgoing-conditional-edge-updated",
      "outgoing-conditional-edge-removed",
      "routing-cardinality-changed",
    ]);
  });
});
