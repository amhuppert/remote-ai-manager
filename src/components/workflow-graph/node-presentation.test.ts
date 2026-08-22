import { describe, expect, it } from "vitest";
import {
  CONTEXT_GRADE,
  contextNodeAriaLabel,
  contextNodeCrew,
  contextNodeGrade,
  contextNodeNotice,
  contextNodeStatus,
  ownedPathsText,
} from "./node-presentation";
import type { ExecutionContextNodeData } from "./derive-graph";

function context(
  overrides: Partial<ExecutionContextNodeData["context"]> = {},
): ExecutionContextNodeData["context"] {
  return {
    id: "ctx_checkout",
    title: "Implement checkout",
    acceptanceCriteria: "Checkout works",
    placement: {
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["src/checkout", "src/risk"],
    },
    implementer: {
      id: "implementer",
      profile: { tier: "project", id: "checkout-impl" },
      agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
    },
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "security",
          profile: { tier: "global", id: "security-reviewer" },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "high",
          },
          strategy: "conversation",
          authority: "blocking",
          continuity: { enabled: true },
        },
        {
          id: "style",
          profile: { tier: "project", id: "style-reviewer" },
          agent: {
            backend: "codex",
            model: "gpt-5.6-luna",
            reasoningEffort: "medium",
          },
          strategy: "task",
          authority: "advisory",
          continuity: { enabled: true },
        },
      ],
    },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
    ...overrides,
  } as ExecutionContextNodeData["context"];
}

describe("contextNodeStatus", () => {
  it("reads Draft in builder mode regardless of any wait state", () => {
    expect(contextNodeStatus("builder", undefined)).toMatchObject({
      key: "draft",
      label: "Draft",
      live: false,
    });
  });

  it("maps the engine's derived published state to its own status", () => {
    expect(contextNodeStatus("execution", { kind: "published" })).toMatchObject(
      {
        key: "published",
        label: "Published",
        live: false,
      },
    );
  });

  it("pulses only while a context is running", () => {
    expect(contextNodeStatus("execution", { kind: "running" }).live).toBe(true);
    expect(contextNodeStatus("execution", { kind: "validating" }).live).toBe(
      false,
    );
    expect(contextNodeStatus("execution", { kind: "completed" }).live).toBe(
      false,
    );
  });

  it("labels the design's remaining states", () => {
    expect(contextNodeStatus("execution", undefined).label).toBe("Pending");
    expect(contextNodeStatus("execution", { kind: "halted" }).label).toBe(
      "Halted",
    );
    expect(
      contextNodeStatus("execution", { kind: "awaiting-approval" }).label,
    ).toBe("Awaiting approval");
  });
});

describe("contextNodeGrade", () => {
  it("labels an owning placement and carries the design's tooltip copy", () => {
    const grade = contextNodeGrade(context().placement);

    expect(grade.key).toBe("owned");
    expect(grade.label).toBe("owning");
    expect(grade.title).toBe(CONTEXT_GRADE.owned.title);
    expect(grade.title).toMatch(/writes only inside its declared paths/);
  });

  it("labels full and read-only placements", () => {
    expect(contextNodeGrade({ lane: "delivery", mode: "full" }).label).toBe(
      "full",
    );
    expect(contextNodeGrade({ lane: "session", mode: "readOnly" }).label).toBe(
      "read-only",
    );
  });
});

describe("ownedPathsText", () => {
  it("joins declared owned paths and is empty for every other grade", () => {
    expect(ownedPathsText(context().placement)).toBe("src/checkout, src/risk");
    expect(ownedPathsText({ lane: "delivery", mode: "full" })).toBe("");
    expect(ownedPathsText({ lane: "session", mode: "readOnly" })).toBe("");
  });
});

describe("contextNodeCrew", () => {
  it("shows the implementer's long model name, backend and effort", () => {
    const crew = contextNodeCrew(context());

    expect(crew.implementer).toMatchObject({
      backend: "claude",
      // The catalog's canonical long name, never the short selector id.
      modelLabel: "Opus 5",
      effort: "high",
    });
    expect(crew.implementer?.modelLabel).not.toBe("opus");
  });

  it("lists every validator seat with its authority and backend", () => {
    const crew = contextNodeCrew(context());

    expect(crew.seats).toEqual([
      {
        seatId: "security",
        authority: "blocking",
        backend: "claude",
        modelLabel: "Sonnet",
      },
      {
        seatId: "style",
        authority: "advisory",
        backend: "codex",
        modelLabel: "GPT-5.6 Luna",
      },
    ]);
  });

  it("lists no seats when the cohort is disabled", () => {
    const disabled = context({
      contextValidator: { enabled: false, assignments: [] },
    });

    expect(contextNodeCrew(disabled).seats).toEqual([]);
  });
});

describe("contextNodeAriaLabel", () => {
  const base = {
    title: "Implement checkout",
    status: contextNodeStatus("execution", { kind: "running" }),
    laneName: "delivery",
    grade: contextNodeGrade(context().placement),
    ownedPaths: "src/checkout, src/risk",
    completedTaskCount: 3,
    totalTaskCount: 5,
    crew: contextNodeCrew(context()),
    configOverrides: [] as string[],
  };

  it("names status, lane, grade, paths, tasks and the implementer", () => {
    expect(contextNodeAriaLabel(base)).toBe(
      "Implement checkout — Running, lane delivery, owning (src/checkout, src/risk), 3 of 5 tasks, implementer Opus 5 high, inherited",
    );
  });

  it("carries the set-on-this-context reason rather than leaving it to a tooltip", () => {
    expect(
      contextNodeAriaLabel({
        ...base,
        configOverrides: ["implementer", "iteration policy"],
      }),
    ).toContain("set on this context: implementer, iteration policy");
  });

  it("omits the paths and task clauses when there is nothing to say", () => {
    const label = contextNodeAriaLabel({
      ...base,
      ownedPaths: "",
      totalTaskCount: 0,
      completedTaskCount: 0,
    });

    expect(label).toBe(
      "Implement checkout — Running, lane delivery, owning, implementer Opus 5 high, inherited",
    );
  });
});

describe("contextNodeNotice", () => {
  it("explains why a full-grade member cannot start on an occupied lane", () => {
    expect(
      contextNodeNotice({
        placement: { lane: "delivery", mode: "full" },
        waitState: { kind: "waiting-for-lane", laneId: "delivery" },
      }),
    ).toEqual({
      tone: "amber",
      text: "Full grade — waits for exclusive occupancy of delivery.",
    });
  });

  it("says nothing for an owning member queued on the same lane", () => {
    expect(
      contextNodeNotice({
        placement: {
          lane: "delivery",
          mode: "owned",
          ownedPaths: ["src/checkout"],
        },
        waitState: { kind: "waiting-for-lane", laneId: "delivery" },
      }),
    ).toBeNull();
  });

  it("names an upstream approval as the reason a context is blocked", () => {
    expect(
      contextNodeNotice({
        placement: { lane: "delivery", mode: "full" },
        waitState: {
          kind: "dependency-blocked",
          unmetDependencyIds: ["ctx_plan"],
          blockedByApproval: true,
        },
      }),
    ).toEqual({
      tone: "amber",
      text: "Blocked — an upstream context is awaiting your approval.",
    });
  });

  it("marks a halted context in red and points at its recorded reason", () => {
    expect(
      contextNodeNotice({
        placement: { lane: "delivery", mode: "full" },
        waitState: { kind: "halted" },
      }),
    ).toEqual({
      tone: "red",
      text: "Halted — open the context for the recorded reason.",
    });
  });

  it("says nothing about a healthy context", () => {
    expect(
      contextNodeNotice({
        placement: { lane: "delivery", mode: "full" },
        waitState: { kind: "running" },
      }),
    ).toBeNull();
    expect(
      contextNodeNotice({
        placement: { lane: "delivery", mode: "full" },
        waitState: undefined,
      }),
    ).toBeNull();
  });
});
