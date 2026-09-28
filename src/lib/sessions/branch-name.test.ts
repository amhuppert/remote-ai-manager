import { describe, it, expect } from "vitest";
import { sanitizeBranchName } from "./branch-name";

describe("sanitizeBranchName", () => {
  it("lowercases and slugifies a human session name", () => {
    expect(sanitizeBranchName("Add Login Form")).toBe("add-login-form");
  });

  it("collapses runs of non-alphanumeric characters into a single hyphen", () => {
    expect(sanitizeBranchName("Fix:  the___bug!!")).toBe("fix-the-bug");
  });

  it("preserves existing hyphens and strips leading/trailing ones", () => {
    expect(sanitizeBranchName("--readme-polish--")).toBe("readme-polish");
  });

  it("returns an empty string for input with no slug characters", () => {
    expect(sanitizeBranchName("   !!!   ")).toBe("");
  });

  it("uppercases a leading Jira ticket key", () => {
    expect(sanitizeBranchName("track-123 fix some bug")).toBe(
      "TRACK-123-fix-some-bug",
    );
  });

  it("uppercases a ticket key that makes up the whole name", () => {
    expect(sanitizeBranchName("Ab-7")).toBe("AB-7");
  });

  it.each([
    ["a single leading letter", "a-1-thing", "a-1-thing"],
    ["a number that runs into letters", "fix-2fa-login", "fix-2fa-login"],
    ["a key that is not at the start", "fix track-123", "fix-track-123"],
  ])("leaves the name lowercase for %s", (_case, input, expected) => {
    expect(sanitizeBranchName(input)).toBe(expected);
  });
});
