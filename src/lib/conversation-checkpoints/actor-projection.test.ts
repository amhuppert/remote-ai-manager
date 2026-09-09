import { describe, expect, it } from "vitest";

import {
  checkpointActorProjection,
  checkpointActorProjectionSchema,
  type CheckpointOperation,
} from "./schemas";

const OPERATION: CheckpointOperation = {
  id: "op-1",
  scope: "session",
  projectPath: "/projects/alpha",
  sessionName: "csm-alpha",
  conversationId: "conv-1",
  ordinal: 1,
  phase: "ready",
  lastStablePhase: null,
  sourceBasis: { capturedThroughSeq: 120, sourceHash: "sha256:source" },
  protectedReferences: {
    priorBackendRef: "prior-provider-session-9d3f",
    acceptedBackendRef: "fresh-provider-session-71ac",
  },
  payloadId: "op-1",
  delivery: null,
  acceptance: null,
  failure: null,
  recoversOperationId: null,
  supersededByOperationId: null,
  generationPassCount: 1,
  usage: {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    costUsd: null,
    durationMs: null,
  },
  requestedAt: "2026-09-07T11:59:00.000Z",
  updatedAt: "2026-09-07T12:00:00.000Z",
};

describe("checkpointActorProjection", () => {
  it("carries only the operation id and phase", () => {
    const projection = checkpointActorProjection(OPERATION);

    expect(projection).toEqual({ operationId: "op-1", phase: "ready" });
    expect(checkpointActorProjectionSchema.safeParse(projection).success).toBe(
      true,
    );
  });

  it("cannot smuggle a provider reference or seed into a machine snapshot", () => {
    const serialized = JSON.stringify(checkpointActorProjection(OPERATION));

    expect(serialized).not.toContain("prior-provider-session-9d3f");
    expect(serialized).not.toContain("fresh-provider-session-71ac");
    expect(serialized).not.toContain("sha256:source");
  });

  it("rejects an actor projection carrying anything beyond id and phase", () => {
    const parsed = checkpointActorProjectionSchema.safeParse({
      operationId: "op-1",
      phase: "ready",
      seedText: "## Working state",
    });

    expect(parsed.success).toBe(false);
  });

  it("projects null when the conversation holds no checkpoint operation", () => {
    expect(checkpointActorProjection(null)).toBeNull();
  });
});
