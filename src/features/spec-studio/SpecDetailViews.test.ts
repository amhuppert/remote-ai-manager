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

  it("maps structural handles into the detail views", () => {
    expect(initialDetailViewForDeepLink("R1", "native-sdd")).toBe(
      "requirements",
    );
    expect(initialDetailViewForDeepLink("R1.2", "native-sdd")).toBe(
      "requirements",
    );
    expect(initialDetailViewForDeepLink("D1", "native-sdd")).toBe("design");
    expect(initialDetailViewForDeepLink("T1", "native-sdd")).toBe("history");
    expect(initialDetailViewForDeepLink(null, "native-sdd")).toBe("overview");
    expect(initialDetailViewForDeepLink("Q1", undefined)).toBe("overview");
    expect(initialDetailViewForDeepLink("not a handle", "native-sdd")).toBe(
      "overview",
    );
  });
});
