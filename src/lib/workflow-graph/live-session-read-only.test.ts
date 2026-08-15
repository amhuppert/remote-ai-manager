import { describe, expect, it } from "vitest";
import { createResolvedWorkflowDefinition } from "@/lib/workflow-graph/test-fixtures";
import type { ContextPlacement } from "./definition-schemas";
import {
  collectLiveSessionReadOnlyViolations,
  isWholeRunLiveSessionReadOnly,
  type LiveSessionReadOnlyContext,
  type LiveSessionReadOnlyDefinition,
} from "./live-session-read-only";

const SESSION_READ_ONLY: ContextPlacement = {
  lane: "session",
  mode: "readOnly",
};

function makeContext(
  id: string,
  overrides: Partial<LiveSessionReadOnlyContext> = {},
): LiveSessionReadOnlyContext {
  return {
    id,
    placement: SESSION_READ_ONLY,
    scriptValidator: { commands: [] },
    collaboration: { enabled: { value: false } },
    ...overrides,
  };
}

function definitionOf(
  contexts: LiveSessionReadOnlyContext[],
  loopContexts?: LiveSessionReadOnlyContext[],
): LiveSessionReadOnlyDefinition {
  return {
    executionContexts: contexts,
    ...(loopContexts === undefined
      ? {}
      : { loopGroups: [{ template: { contexts: loopContexts } }] }),
  };
}

/**
 * The whole exemption question in one table: each row is a resolved member the
 * predicate must judge, and `safe` is the verdict a mechanically read-only run
 * requires. Anything not provably read-only is unsafe, including a member the
 * resolution left without the field the proof reads.
 */
const MEMBERS: ReadonlyArray<{
  name: string;
  overrides: Partial<LiveSessionReadOnlyContext>;
  safe: boolean;
}> = [
  {
    name: "session lane, read-only grade",
    overrides: {},
    safe: true,
  },
  {
    name: "session lane, owned grade",
    overrides: {
      placement: { lane: "session", mode: "owned", ownedPaths: ["src"] },
    },
    safe: false,
  },
  {
    name: "session lane, full grade",
    overrides: { placement: { lane: "session", mode: "full" } },
    safe: false,
  },
  {
    name: "group lane, read-only grade",
    overrides: { placement: { lane: "review", mode: "readOnly" } },
    safe: false,
  },
  {
    name: "group lane, owned grade",
    overrides: {
      placement: { lane: "build", mode: "owned", ownedPaths: ["src"] },
    },
    safe: false,
  },
  {
    name: "group lane, full grade",
    overrides: { placement: { lane: "build", mode: "full" } },
    safe: false,
  },
  {
    name: "engine session lane id rather than the authored name",
    overrides: { placement: { lane: "__session__", mode: "readOnly" } },
    safe: false,
  },
  {
    name: "no placement at all",
    overrides: { placement: undefined },
    safe: false,
  },
  {
    name: "resolved script-validator command selection",
    overrides: { scriptValidator: { commands: ["test"] } },
    safe: false,
  },
  {
    name: "several resolved script-validator commands",
    overrides: { scriptValidator: { commands: ["lint", "typecheck"] } },
    safe: false,
  },
  {
    name: "no script-validator block",
    overrides: { scriptValidator: undefined },
    safe: true,
  },
  {
    name: "collaboration enabled",
    overrides: { collaboration: { enabled: { value: true } } },
    safe: false,
  },
  {
    name: "no collaboration snapshot",
    overrides: { collaboration: undefined },
    safe: false,
  },
];

describe("isWholeRunLiveSessionReadOnly", () => {
  it.each(MEMBERS)(
    "judges a top-level context with $name as safe=$safe",
    ({ overrides, safe }) => {
      const definition = definitionOf([
        makeContext("context-a"),
        makeContext("context-b", overrides),
      ]);

      expect(isWholeRunLiveSessionReadOnly(definition)).toBe(safe);
    },
  );

  it.each(MEMBERS)(
    "judges a loop-template context with $name as safe=$safe",
    ({ overrides, safe }) => {
      const definition = definitionOf(
        [makeContext("context-a")],
        [makeContext("loop-body", overrides)],
      );

      expect(isWholeRunLiveSessionReadOnly(definition)).toBe(safe);
    },
  );

  it("holds for a whole run of read-only session contexts with a read-only loop body", () => {
    const definition = definitionOf(
      [makeContext("context-a"), makeContext("context-b")],
      [makeContext("loop-body-1"), makeContext("loop-body-2")],
    );

    expect(isWholeRunLiveSessionReadOnly(definition)).toBe(true);
  });

  it("judges a production-shaped resolved definition, refusing lane-placed contexts", () => {
    // The shape a seeded execution actually carries — its contexts are placed
    // on group lanes with full access, which is the ordinary launch this
    // exemption must never admit.
    const resolved = createResolvedWorkflowDefinition();

    expect(isWholeRunLiveSessionReadOnly(resolved)).toBe(false);
    expect(collectLiveSessionReadOnlyViolations(resolved)[0]).toMatchObject({
      code: "live-session-read-only-placement",
      field: "executionContexts.0.placement",
    });
  });

  it("fails on the first unsafe member without judging the rest", () => {
    let laterMembersRead = 0;
    const definition: LiveSessionReadOnlyDefinition = {
      executionContexts: [
        makeContext("context-a", {
          placement: { lane: "build", mode: "full" },
        }),
        new Proxy(makeContext("context-b"), {
          get(target, property, receiver) {
            laterMembersRead += 1;
            return Reflect.get(target, property, receiver);
          },
        }),
      ],
    };

    expect(isWholeRunLiveSessionReadOnly(definition)).toBe(false);
    expect(laterMembersRead).toBe(0);
  });
});

describe("collectLiveSessionReadOnlyViolations", () => {
  it("returns no issues for a wholly live-session read-only run", () => {
    const definition = definitionOf(
      [makeContext("context-a")],
      [makeContext("loop-body")],
    );

    expect(collectLiveSessionReadOnlyViolations(definition)).toEqual([]);
  });

  it("locates a write-capable placement at its context and field", () => {
    const definition = definitionOf([
      makeContext("context-a"),
      makeContext("context-b", {
        placement: { lane: "build", mode: "owned", ownedPaths: ["src"] },
      }),
    ]);

    expect(collectLiveSessionReadOnlyViolations(definition)).toEqual([
      expect.objectContaining({
        code: "live-session-read-only-placement",
        contextId: "context-b",
        field: "executionContexts.1.placement",
      }),
    ]);
  });

  it("locates a script-validator selection and a collaboration enablement", () => {
    const definition = definitionOf([
      makeContext("context-a", { scriptValidator: { commands: ["test"] } }),
      makeContext("context-b", { collaboration: { enabled: { value: true } } }),
    ]);

    expect(collectLiveSessionReadOnlyViolations(definition)).toEqual([
      expect.objectContaining({
        code: "live-session-read-only-script-validator",
        contextId: "context-a",
        field: "executionContexts.0.scriptValidator.commands",
      }),
      expect.objectContaining({
        code: "live-session-read-only-collaboration",
        contextId: "context-b",
        field: "executionContexts.1.collaboration.enabled",
      }),
    ]);
  });

  it("locates a loop-template violation inside its group's template", () => {
    const definition = definitionOf(
      [makeContext("context-a")],
      [
        makeContext("loop-body-1"),
        makeContext("loop-body-2", {
          placement: { lane: "session", mode: "full" },
        }),
      ],
    );

    expect(collectLiveSessionReadOnlyViolations(definition)).toEqual([
      expect.objectContaining({
        code: "live-session-read-only-placement",
        contextId: "loop-body-2",
        field: "loopGroups.0.template.contexts.1.placement",
      }),
    ]);
  });

  it("reports every unsafe member rather than stopping at the first", () => {
    const definition = definitionOf([
      makeContext("context-a", {
        placement: { lane: "build", mode: "full" },
      }),
      makeContext("context-b", { collaboration: undefined }),
    ]);

    expect(
      collectLiveSessionReadOnlyViolations(definition).map(
        (issue) => issue.contextId,
      ),
    ).toEqual(["context-a", "context-b"]);
  });
});
