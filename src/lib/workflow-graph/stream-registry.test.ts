import { describe, expect, it } from "vitest";
import { addClient, emit, _resetForTesting } from "./stream-registry";

describe("graph workflow stream registry", () => {
  it("delivers live stream frames to connected session clients", () => {
    _resetForTesting();

    const chunks: string[] = [];
    const cleanup = addClient("/projects/repo", "session-1", {
      enqueue(chunk: Uint8Array) {
        chunks.push(new TextDecoder().decode(chunk));
      },
      close() {},
      desiredSize: 1,
    } as ReadableStreamDefaultController);

    emit("/projects/repo", "session-1", {
      type: "iteration-boundary",
      conversationId: "conversation-1",
      contextId: "context-plan",
      status: "started",
    });

    expect(chunks).toEqual([
      JSON.stringify({
        type: "iteration-boundary",
        conversationId: "conversation-1",
        contextId: "context-plan",
        status: "started",
      }) + "\n",
    ]);

    cleanup();
    _resetForTesting();
  });
});
