import { describe, expect, it } from "vitest";
import { subscriptionCatalog, validateSubscriptionSelection } from "./catalog";
import { subscribeRequestSchema } from "./controls-schemas";

describe("subscription catalog selections", () => {
  it("allows following notepad comment additions independently of content revisions", () => {
    expect(
      validateSubscriptionSelection("notepad", "passive", [
        "notepad-comment-added",
      ]),
    ).toBeNull();
    expect(
      subscriptionCatalog.sources
        .find((source) => source.kind === "notepad")
        ?.eventKinds.map((event) => event.id),
    ).toContain("notepad-comment-added");
  });
  it("keeps conversation notices internal while allowing their existing passive mode controls", () => {
    expect(
      subscribeRequestSchema.safeParse({
        source: { kind: "conversation", id: "own" },
        reason: "Purpose",
      }).success,
    ).toBe(false);
    expect(
      validateSubscriptionSelection("conversation", "passive", null),
    ).toBeNull();
    expect(
      validateSubscriptionSelection("conversation", "active", null),
    ).toMatch(/passive/i);
  });
  it("offers only supported sources and finite active sources", () => {
    expect(subscriptionCatalog.sources.map((source) => source.kind)).toEqual([
      "notepad",
      "ticket",
      "spec",
      "workflow",
      "run",
      "validation",
      "git_job",
    ]);
    expect(
      subscriptionCatalog.sources
        .filter((source) => source.allowedModes.includes("active"))
        .map((source) => source.kind),
    ).toEqual(["workflow", "validation", "git_job"]);
  });
  it("refuses mismatched events and active event filters rather than silently ignoring them", () => {
    expect(
      validateSubscriptionSelection("ticket", "passive", [
        "notepad-content-revised",
      ]),
    ).toMatch(/event/i);
    expect(validateSubscriptionSelection("ticket", "active", null)).toMatch(
      /passive/i,
    );
    expect(
      validateSubscriptionSelection("workflow", "active", [
        "graph-workflow-boundary:completion",
      ]),
    ).toMatch(/terminal/i);
    expect(
      validateSubscriptionSelection("ticket", "passive", [
        "ticket-status-changed",
      ]),
    ).toBeNull();
    expect(
      validateSubscriptionSelection("workflow", "active", null),
    ).toBeNull();
  });
});
