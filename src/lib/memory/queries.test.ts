import { describe, expect, it } from "vitest";
import { memoryNotesUrl, memoryScopeParams } from "./queries";

describe("memory curation addressing", () => {
  it("reads global memory without inventing a project", () => {
    expect(
      memoryNotesUrl(
        { projectName: null, sessionName: null },
        { includeArchived: false, lifecycle: "proposed" },
      ),
    ).toBe("/api/memory/notes?lifecycle=proposed");
  });
  it("retains the exact incarnation for a completed session's curation", () => {
    const params = memoryScopeParams({
      projectName: "cc",
      sessionName: "ended",
      incarnation: "2026-08-01T00:00:00.000Z",
    });
    expect(params.get("incarnation")).toBe("2026-08-01T00:00:00.000Z");
  });
});
