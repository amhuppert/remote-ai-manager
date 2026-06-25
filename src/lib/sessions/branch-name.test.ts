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
});
