import { describe, expect, it } from "vitest";
import { buildConversation } from "./build-conversation";
import { conversationStateSchema } from "./schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { ForkedFrom } from "./schemas";

const NOW = "2026-01-01T00:00:00.000Z";

describe("buildConversation", () => {
  it("produces a schema-valid session conversation with canonical defaults", () => {
    const conv = buildConversation({
      id: "conv-1",
      scope: "session",
      name: "sess 1",
      createdAt: NOW,
      agentBackend: "claude",
    });

    // Every field the schema requires must be present and valid.
    expect(conversationStateSchema.parse(conv)).toEqual(conv);

    expect(conv).toMatchObject({
      id: "conv-1",
      scope: "session",
      name: "sess 1",
      status: "new",
      promptCount: 0,
      createdAt: NOW,
      lastActivityAt: NOW,
      source: "cc",
      archived: false,
      agentBackend: "claude",
      backendRef: null,
      transcriptPath: null,
      pendingPromptText: null,
      forkedFrom: null,
      role: null,
      unread: false,
      pendingAgentNotices: [],
      pendingQueue: [],
      lastSeenAlignmentVersion: null,
    });
    // Session conversations never carry the project-only `open` tab flag.
    expect("open" in conv).toBe(false);
  });

  it("marks a project conversation open on creation", () => {
    const conv = buildConversation({
      id: "pc-1",
      scope: "project",
      name: "project chat 1",
      createdAt: NOW,
      agentBackend: "codex",
    });

    expect(conversationStateSchema.parse(conv)).toEqual(conv);
    expect(conv.scope).toBe("project");
    expect(conv.open).toBe(true);
    expect(conv.agentBackend).toBe("codex");
  });

  it("carries fork handoff fields (transcript, prompt, forkedFrom, backendRef)", () => {
    const backendRef: AgentSessionRef = { backend: "claude", ref: "sess-abc" };
    const forkedFrom: ForkedFrom = {
      sourceConversationId: "src",
      messageIndex: 3,
      sourceBackend: "claude",
      sourceBackendRef: backendRef,
      forkLocator: null,
      forkMode: "native",
    };

    const conv = buildConversation({
      id: "fork-1",
      scope: "session",
      name: "fork name",
      createdAt: NOW,
      agentBackend: "claude",
      transcriptPath: "/tmp/fork.jsonl",
      pendingPromptText: "carried draft",
      forkedFrom,
      backendRef,
    });

    expect(conversationStateSchema.parse(conv)).toEqual(conv);
    expect(conv.transcriptPath).toBe("/tmp/fork.jsonl");
    expect(conv.pendingPromptText).toBe("carried draft");
    expect(conv.forkedFrom).toEqual(forkedFrom);
    expect(conv.backendRef).toEqual(backendRef);
  });

  it("threads through an explicit role", () => {
    const conv = buildConversation({
      id: "init-1",
      scope: "session",
      name: "init",
      createdAt: NOW,
      agentBackend: "claude",
      role: "initialization",
    });

    expect(conv.role).toBe("initialization");
  });
});
