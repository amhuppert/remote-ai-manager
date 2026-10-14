import { describe, expect, it } from "vitest";
import { projectRequirementStatus, projectSpecPhase } from "./phase";

describe("spec authoring phase", () => {
  it("projects a fresh spec and an open amendment as draft", () => {
    expect(projectSpecPhase({ abandoned: false, revisions: [] })).toEqual({
      primary: "draft",
    });
    expect(
      projectSpecPhase({
        abandoned: false,
        revisions: [
          { state: "approved", authoringStage: "design" },
          { state: "draft", authoringStage: "requirements" },
        ],
      }),
    ).toEqual({ primary: "draft", authoringStage: "requirements" });
  });
  it("keeps approved specs approved without a delivery projection", () => {
    expect(
      projectSpecPhase({
        abandoned: false,
        revisions: [{ state: "approved", authoringStage: "design" }],
      }),
    ).toEqual({ primary: "approved", authoringStage: "design" });
  });
  it("keeps legacy approved plan revisions readable", () => {
    expect(
      projectSpecPhase({
        abandoned: false,
        revisions: [{ state: "approved", authoringStage: "plan" }],
      }),
    ).toEqual({ primary: "approved" });
  });
  it("makes abandonment terminal even when a draft remains", () => {
    expect(
      projectSpecPhase({
        abandoned: true,
        revisions: [{ state: "draft", authoringStage: "design" }],
      }),
    ).toEqual({ primary: "abandoned", authoringStage: "design" });
  });
  it("reports requirement approval independently of implementation work", () => {
    expect(projectRequirementStatus({ approvalValidity: null })).toEqual({
      approval: "unapproved",
    });
    expect(projectRequirementStatus({ approvalValidity: "valid" })).toEqual({
      approval: "valid",
    });
  });
});
