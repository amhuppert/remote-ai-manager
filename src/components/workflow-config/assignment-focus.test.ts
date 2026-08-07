import { describe, expect, it } from "vitest";
import { ASSIGNMENT_FOCUS_MAX_LENGTH } from "@/lib/agent-profiles/block";
import {
  ASSIGNMENT_INSTRUCTIONS_PRESENTATION,
  ASSIGNMENT_INSTRUCTIONS_RULES_HINT,
  assignmentFocusRefusal,
} from "./assignment-focus";

describe("assignmentFocusRefusal", () => {
  it("accepts an empty, whitespace-only, or ordinary focus", () => {
    expect(assignmentFocusRefusal("")).toBeNull();
    expect(assignmentFocusRefusal("   \n ")).toBeNull();
    expect(assignmentFocusRefusal("auth boundaries and session fixation")).toBe(
      null,
    );
  });

  it("refuses a focus carrying a reserved sequence, naming the sequence", () => {
    const refusal = assignmentFocusRefusal("look at ```ts blocks");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("```");
  });

  it("refuses the block delimiter itself", () => {
    const refusal = assignmentFocusRefusal("<<<CC_AGENT_PROFILE end");
    expect(refusal).toContain("<<<CC_AGENT_PROFILE");
  });

  it("refuses a focus longer than the composer's cap, stating the cap", () => {
    const refusal = assignmentFocusRefusal(
      "x".repeat(ASSIGNMENT_FOCUS_MAX_LENGTH + 1),
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain(String(ASSIGNMENT_FOCUS_MAX_LENGTH));
  });

  it("measures the cap against the normalized focus, not the raw text", () => {
    const padded = `  ${"x".repeat(ASSIGNMENT_FOCUS_MAX_LENGTH)}  `;
    expect(assignmentFocusRefusal(padded)).toBeNull();
  });
});

describe("ASSIGNMENT_INSTRUCTIONS_RULES_HINT", () => {
  it("states both refusal rules before the author can trip them", () => {
    expect(ASSIGNMENT_INSTRUCTIONS_RULES_HINT).toContain(
      String(ASSIGNMENT_FOCUS_MAX_LENGTH),
    );
    expect(ASSIGNMENT_INSTRUCTIONS_RULES_HINT).toContain("```");
    expect(ASSIGNMENT_INSTRUCTIONS_RULES_HINT).toContain("<<<CC_AGENT_PROFILE");
  });
});

describe("ASSIGNMENT_INSTRUCTIONS_PRESENTATION", () => {
  it("presents a blocking assignment's instructions as its authoritative mandate", () => {
    const blocking = ASSIGNMENT_INSTRUCTIONS_PRESENTATION.blocking;
    expect(blocking.label).toBe("Mandate");
    expect(blocking.hint).toContain("authoritative mandate");
    expect(blocking.hint).toContain("advisory");
  });

  it("presents an advisory assignment's instructions as a subordinate profile focus", () => {
    const advisory = ASSIGNMENT_INSTRUCTIONS_PRESENTATION.advisory;
    expect(advisory.label).toBe("Focus");
    expect(advisory.hint).toContain("Subordinate");
    expect(advisory.hint).toContain("profile block");
  });

  it("carries the shared refusal rules into both faces of the one field", () => {
    expect(ASSIGNMENT_INSTRUCTIONS_PRESENTATION.blocking.hint).toContain(
      ASSIGNMENT_INSTRUCTIONS_RULES_HINT,
    );
    expect(ASSIGNMENT_INSTRUCTIONS_PRESENTATION.advisory.hint).toContain(
      ASSIGNMENT_INSTRUCTIONS_RULES_HINT,
    );
  });
});
