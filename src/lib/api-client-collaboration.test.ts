import { describe, it, expect } from "vitest";
import {
  collaborationStartResponseSchema,
  collaborationStopResponseSchema,
} from "./api-client";

describe("collaborationStartResponseSchema", () => {
  it("rejects a response shape with a non-started status", () => {
    const result = collaborationStartResponseSchema.safeParse({
      workflowId: "wf-77",
      status: "stopped",
    });
    expect(result.success).toBe(false);
  });
});

describe("collaborationStopResponseSchema", () => {
  it("accepts a stopped response", () => {
    const result = collaborationStopResponseSchema.safeParse({
      workflowId: "wf-77",
      status: "stopped",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-stopped status", () => {
    const result = collaborationStopResponseSchema.safeParse({
      workflowId: "wf-77",
      status: "started",
    });
    expect(result.success).toBe(false);
  });
});
