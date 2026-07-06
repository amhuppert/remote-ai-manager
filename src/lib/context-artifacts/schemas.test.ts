import { describe, expect, it } from "vitest";
import { contextArtifactStatusEventSchema } from "./schemas";

describe("contextArtifactStatusEventSchema", () => {
  // The SSE broadcaster stamps `_sentAt` into every envelope; client-side
  // safeParse must tolerate it for BOTH scope members or the frame is
  // silently dropped.
  it("parses a project-scope event carrying the broadcaster's _sentAt stamp", () => {
    const parsed = contextArtifactStatusEventSchema.safeParse({
      type: "context_artifact_status",
      scope: "project",
      projectName: "proj",
      conversationId: "convo-1",
      artifactId: "artifact-1",
      kind: "conversation_compaction",
      status: "complete",
      _sentAt: 1234567890,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a session-scope event carrying the broadcaster's _sentAt stamp", () => {
    const parsed = contextArtifactStatusEventSchema.safeParse({
      type: "context_artifact_status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "convo-1",
      artifactId: "artifact-1",
      kind: "conversation_compaction",
      status: "pending",
      _sentAt: 1234567890,
    });
    expect(parsed.success).toBe(true);
  });
});
