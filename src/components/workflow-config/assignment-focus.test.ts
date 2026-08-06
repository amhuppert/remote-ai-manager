import { describe, expect, it } from "vitest";
import { ASSIGNMENT_FOCUS_MAX_LENGTH } from "@/lib/agent-profiles/block";
import {
  ASSIGNMENT_FOCUS_RULES_HINT,
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

describe("ASSIGNMENT_FOCUS_RULES_HINT", () => {
  it("states both refusal rules before the author can trip them", () => {
    expect(ASSIGNMENT_FOCUS_RULES_HINT).toContain(
      String(ASSIGNMENT_FOCUS_MAX_LENGTH),
    );
    expect(ASSIGNMENT_FOCUS_RULES_HINT).toContain("```");
    expect(ASSIGNMENT_FOCUS_RULES_HINT).toContain("<<<CC_AGENT_PROFILE");
  });
});
