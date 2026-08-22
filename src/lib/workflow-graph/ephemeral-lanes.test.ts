import { describe, expect, it } from "vitest";
import {
  defaultEphemeralLaneName,
  definitionLaneNames,
  ephemeralLaneBand,
  resolveEphemeralLaneName,
} from "./ephemeral-lanes";
import { createWorkflowDefinition } from "./test-fixtures";

function resolve(name: string, taken: string[] = [], currentName = "new-lane") {
  return resolveEphemeralLaneName({ name, currentName, taken });
}

describe("definitionLaneNames", () => {
  it("collects the lanes the draft already spells", () => {
    expect(definitionLaneNames(createWorkflowDefinition()).sort()).toEqual([
      "implement",
      "plan",
      "verify",
    ]);
  });

  it("reports the internal session id under its authored spelling", () => {
    const names = definitionLaneNames({
      executionContexts: [{ placement: { lane: "__session__" } }],
    });
    expect(names).toEqual(["session"]);
  });

  it("tolerates a draft that is not loaded yet", () => {
    expect(definitionLaneNames(null)).toEqual([]);
  });
});

describe("defaultEphemeralLaneName", () => {
  it("names the first band new-lane", () => {
    expect(defaultEphemeralLaneName(["plan", "delivery"])).toBe("new-lane");
  });

  // A default name that collided would draw a band claiming to be a lane that
  // already has members, which is the duplicate band §2.2 refuses.
  it("suffixes past every taken spelling", () => {
    expect(defaultEphemeralLaneName(["new-lane", "new-lane-2"])).toBe(
      "new-lane-3",
    );
  });
});

describe("resolveEphemeralLaneName", () => {
  it("accepts a fresh legal name", () => {
    expect(resolve("rollback", ["plan"])).toEqual({
      outcome: "renamed",
      laneName: "rollback",
    });
  });

  it("trims before deciding anything", () => {
    expect(resolve("  rollback  ", ["plan"])).toEqual({
      outcome: "renamed",
      laneName: "rollback",
    });
  });

  it("treats the band's own name as a no-op", () => {
    expect(resolve("new-lane", ["plan"], "new-lane")).toEqual({
      outcome: "unchanged",
      laneName: "new-lane",
    });
  });

  it("refuses an empty name", () => {
    const result = resolve("   ", ["plan"]);
    expect(result.outcome).toBe("refused");
    expect(result).toMatchObject({
      message: expect.stringContaining("needs a name"),
    });
  });

  it("refuses the reserved session lane", () => {
    const result = resolve("session", ["plan"]);
    expect(result.outcome).toBe("refused");
    expect(result).toMatchObject({
      message: expect.stringContaining("read-only contexts only"),
    });
  });

  it("refuses the engine's internal session id", () => {
    const result = resolve("__session__", ["plan"]);
    expect(result.outcome).toBe("refused");
    expect(result).toMatchObject({
      message: expect.stringContaining("internal id"),
    });
  });

  it("refuses a name the lane grammar rejects, quoting the violation", () => {
    const result = resolve("release/train", ["plan"]);
    expect(result).toEqual({
      outcome: "refused",
      message:
        "Lane names become branch and worktree path segments: it must match /^[A-Za-z0-9_.-]+$/.",
    });
  });

  // §2.2: typing an existing lane's name means "use the existing lane".
  it("merges into a lane that already exists rather than duplicating it", () => {
    const result = resolve("delivery", ["plan", "delivery"]);
    expect(result).toEqual({
      outcome: "merged",
      laneName: "delivery",
      notice:
        'Naming it delivery means "use the existing lane" — the band merges with it rather than creating a duplicate.',
    });
  });
});

describe("ephemeralLaneBand", () => {
  // A lane has no grade, so an empty lane has nothing to summarize.
  it("is a member-less band with no grade summary", () => {
    expect(ephemeralLaneBand({ id: "e1", name: "rollback" })).toEqual({
      laneName: "rollback",
      state: "pending",
      reserved: false,
      memberContextIds: [],
      memberCount: 0,
      membershipLabel: "0 members",
      gradeSummary: "",
      runtime: null,
    });
  });
});
