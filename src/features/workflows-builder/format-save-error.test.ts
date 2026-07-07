import { describe, it, expect } from "vitest";
import { ApiCallError } from "@/lib/api/errors";
import { formatWorkflowSaveError } from "./format-save-error";

describe("formatWorkflowSaveError", () => {
  it("appends one 'path: message' line per structured issue", () => {
    const error = new ApiCallError(
      "Workflow plan is invalid",
      undefined,
      undefined,
      undefined,
      undefined,
      [
        {
          path: "definition.executionContexts.0.acceptanceCriteria",
          message: "Invalid input: expected string, received undefined",
        },
        { path: "definition.tasks.1.contextId", message: "unknown context" },
      ],
    );

    expect(formatWorkflowSaveError(error)).toBe(
      "Workflow plan is invalid\n" +
        "definition.executionContexts.0.acceptanceCriteria: Invalid input: expected string, received undefined\n" +
        "definition.tasks.1.contextId: unknown context",
    );
  });

  it("returns just the message when the error carries no issues", () => {
    const error = new ApiCallError("Workflow not found");
    expect(formatWorkflowSaveError(error)).toBe("Workflow not found");
  });

  it("returns just the message when the issues array is empty", () => {
    const error = new ApiCallError(
      "Workflow plan is invalid",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(formatWorkflowSaveError(error)).toBe("Workflow plan is invalid");
  });

  it("falls back to a generic message for non-API errors", () => {
    expect(formatWorkflowSaveError(new Error("boom"))).toBe(
      "Failed to save workflow draft",
    );
    expect(formatWorkflowSaveError("nope")).toBe(
      "Failed to save workflow draft",
    );
  });
});
