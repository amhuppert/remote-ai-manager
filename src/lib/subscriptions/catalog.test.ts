import { describe, expect, it } from "vitest";
import { subscriptionCatalog, validateSubscriptionSelection } from "./catalog";

describe("subscription catalog selections", () => {
  it("offers only supported sources and finite active sources", () => {
    expect(subscriptionCatalog.sources.map((source) => source.kind)).toEqual([
      "notepad",
      "ticket",
      "spec",
      "workflow",
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
