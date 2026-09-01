import { describe, expect, it } from "vitest";

import { initialDetailViewForDeepLink } from "./SpecDetailViews";

describe("initialDetailViewForDeepLink", () => {
  it("routes Q/A deep links to Requirements so their DOM targets mount", () => {
    expect(initialDetailViewForDeepLink("Q1", "native-sdd")).toBe(
      "requirements",
    );
    expect(initialDetailViewForDeepLink("A2", "native-sdd")).toBe(
      "requirements",
    );
    expect(initialDetailViewForDeepLink("native-sdd/A1", "native-sdd")).toBe(
      "requirements",
    );
  });

  it("maps structural and launch handles into the five detail views", () => {
    expect(initialDetailViewForDeepLink("R1", "native-sdd")).toBe(
      "requirements",
    );
    expect(initialDetailViewForDeepLink("R1.2", "native-sdd")).toBe(
      "requirements",
    );
    expect(initialDetailViewForDeepLink("D1", "native-sdd")).toBe("design");
    expect(initialDetailViewForDeepLink("T1", "native-sdd")).toBe("history");
    expect(initialDetailViewForDeepLink("execution_start", "native-sdd")).toBe(
      "delivery",
    );
    expect(initialDetailViewForDeepLink(null, "native-sdd")).toBe("overview");
    expect(initialDetailViewForDeepLink("Q1", undefined)).toBe("overview");
    expect(initialDetailViewForDeepLink("not a handle", "native-sdd")).toBe(
      "overview",
    );
  });

  it("routes the delivery gate deep link to the Delivery bridge", () => {
    expect(initialDetailViewForDeepLink("delivery", "native-sdd")).toBe(
      "delivery",
    );
  });
});
