import { describe, expect, it } from "vitest";
import { cascadeSettings } from "./settings-cascade";

interface Settings {
  seat: { profile: string; model?: string };
  reviewers: string[];
  approval: boolean;
  timeoutMs: number | null;
}

const global: Settings = {
  seat: { profile: "standard" },
  reviewers: [],
  approval: false,
  timeoutMs: null,
};

describe("settings cascade", () => {
  it("takes each key from the nearest tier that sets it and names that tier", () => {
    const cascaded = cascadeSettings<Settings>({
      global,
      template: { approval: true, timeoutMs: 60_000 },
      context: { timeoutMs: 120_000 },
    });

    expect(cascaded).toEqual({
      seat: { value: { profile: "standard" }, from: "global" },
      reviewers: { value: [], from: "global" },
      approval: { value: true, from: "template" },
      timeoutMs: { value: 120_000, from: "context" },
    });
  });

  it("replaces an object or list value whole rather than merging it with a farther tier", () => {
    const cascaded = cascadeSettings<Settings>({
      global,
      template: {
        seat: { profile: "reviewer", model: "opus" },
        reviewers: ["a", "b"],
      },
      context: { seat: { profile: "writer" }, reviewers: ["c"] },
    });

    expect(cascaded.seat).toEqual({
      value: { profile: "writer" },
      from: "context",
    });
    expect(cascaded.reviewers).toEqual({ value: ["c"], from: "context" });
  });

  it("lets an absent or undefined key fall through, which is how a reset reads", () => {
    const cascaded = cascadeSettings<Settings>({
      global,
      template: { approval: true },
      context: { approval: undefined },
    });

    expect(cascaded.approval).toEqual({ value: true, from: "template" });
  });

  it("keeps an explicit null or false as a value that overrides", () => {
    const cascaded = cascadeSettings<Settings>({
      global: { ...global, timeoutMs: 30_000, approval: true },
      context: { timeoutMs: null, approval: false },
    });

    expect(cascaded.timeoutMs).toEqual({ value: null, from: "context" });
    expect(cascaded.approval).toEqual({ value: false, from: "context" });
  });

  it("skips the template tier for a standalone launch", () => {
    const cascaded = cascadeSettings<Settings>({
      global,
      context: { reviewers: ["a"] },
    });

    expect(cascaded.reviewers).toEqual({ value: ["a"], from: "context" });
    expect(cascaded.approval).toEqual({ value: false, from: "global" });
  });
});
