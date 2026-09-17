import { describe, expect, it } from "vitest";
import {
  CLIENT_ADVISORIES,
  ccTempPayloadAdvisory,
} from "./framework/payload-location";

// Declare-or-fail: client-authored reminders are the enumerated exception to
// "the server authors reminders", so each one must name the failure it earned.
describe("CLIENT_ADVISORIES", () => {
  it("carries an evidence line for every enumerated entry", () => {
    const entries = Object.entries(CLIENT_ADVISORIES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, advisory] of entries) {
      expect(advisory.evidence.length, id).toBeGreaterThan(20);
    }
  });
});

describe("ccTempPayloadAdvisory", () => {
  it("nudges a bare relative payload written to the worktree root", () => {
    const advisory = ccTempPayloadAdvisory("doc.json");
    expect(advisory).toBeDefined();
    expect(advisory).toContain(".cc/temp/");
    expect(advisory).toContain("doc.json");
  });

  // The renderer owns the reminder prefix and the line break, so the advisory
  // text must carry neither.
  it("is a bare single-line reminder body", () => {
    const advisory = ccTempPayloadAdvisory("doc.json");
    expect(advisory).not.toContain("\n");
    expect(advisory?.startsWith("note:")).toBe(false);
  });

  it("nudges a relative payload in a non-.cc subdirectory", () => {
    expect(ccTempPayloadAdvisory("payloads/plan.json")).toContain(".cc/temp/");
  });

  it("stays silent for a payload already under the .cc/ namespace", () => {
    expect(ccTempPayloadAdvisory(".cc/temp/doc.json")).toBeUndefined();
    expect(
      ccTempPayloadAdvisory(".cc/graph-workflow-docs/api.json"),
    ).toBeUndefined();
    expect(ccTempPayloadAdvisory("./.cc/temp/doc.json")).toBeUndefined();
  });

  it("stays silent for an absolute path (worktree root is unknown here)", () => {
    expect(ccTempPayloadAdvisory("/tmp/plan.json")).toBeUndefined();
  });

  it("stays silent for stdin", () => {
    expect(ccTempPayloadAdvisory("-")).toBeUndefined();
  });
});
