import { describe, expect, it } from "vitest";
import { GraphWorkflowResourceMissingError } from "./lifecycle-errors";
import { respondToManagerError } from "./lifecycle-http";
import { GraphWorkflowTransitionConflictError } from "./workflow-manager";

describe("lifecycle refusal responses", () => {
  it.each(["execution", "definition", "context"] as const)(
    "identifies a missing %s independently of display prose",
    async (resource) => {
      const error = new GraphWorkflowResourceMissingError(
        resource,
        "The addressed resource is unavailable.",
      );
      const response = respondToManagerError(error);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: error.message });
    },
  );

  it("keeps invalid-transition status and facts when its prose changes", async () => {
    const error = new GraphWorkflowTransitionConflictError(
      "resume",
      "completed",
      ["paused", "halted"],
      "Cannot resume a completed workflow.",
    );
    error.message = "This operation cannot proceed.";
    const response = respondToManagerError(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: error.message,
      code: error.code,
      details: {
        action: "resume",
        currentStatus: "completed",
        allowedStatuses: ["paused", "halted"],
      },
    });
  });
});
