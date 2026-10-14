import { describe, it, expect } from "vitest";
import { buildSessionContext, buildConversationContext } from "./copy-context";
import type { SessionState } from "@/lib/sessions/schemas";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    scope: "session",
    nameOrigin: "default",
    name: null,
    transcriptPath: "/tmp/transcripts/conv-1.jsonl",
    status: "awaiting" as const,
    promptCount: 3,
    createdAt: "2026-03-28T10:00:00Z",
    lastActivityAt: "2026-03-28T12:00:00Z",
    source: "cc" as const,
    summary: null,
    archived: false,
    totalCostUsd: 0.42,
    totalDurationMs: 60000,
    totalTurns: 5,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: 80000,
    contextWindowMax: 200000,
    debugMode: null,
    agentBackend: "claude" as const,
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    owner: null,
    turnGeneration: 0,
    profileSnapshot: null,
    profileLockedAt: null,
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}): SessionState {
  return {
    sessionName: "my-session",
    worktreePath: "/home/user/project/.worktrees/my-session",
    branchName: "csm/my-session",
    createdAt: "2026-03-28T09:00:00Z",
    lastActivityAt: "2026-03-28T12:00:00Z",
    archived: false,
    finished: false,
    conversations: [makeConversation()],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    referenceDocuments: [],
    ...overrides,
  } as SessionState;
}

describe("buildSessionContext", () => {
  it("includes basic session fields", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "my-project",
      sessionName: "my-session",
      session,
    });

    expect(result).toContain("<project>my-project</project>");
    expect(result).toContain("<session>my-session</session>");
    expect(result).toContain("<branch>csm/my-session</branch>");
    expect(result).toContain(
      "<worktree>/home/user/project/.worktrees/my-session</worktree>",
    );
    expect(result).toContain("<created>2026-03-28T09:00:00Z</created>");
    expect(result).toContain("<conversation-count>1</conversation-count>");
    expect(result).toContain("<total-prompts>3</total-prompts>");
    expect(result).toContain("<source>cc</source>");
    expect(result).toContain("<creation-mode>normal</creation-mode>");
    expect(result).toContain("<finished>false</finished>");
  });

  it("includes session status", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
    });
    expect(result).toContain("<status>awaiting</status>");
  });

  it("wraps output in xml code block", () => {
    const session = makeSession();
    const result = buildSessionContext({
      projectName: "p",
      sessionName: "s",
      session,
    });
    expect(result).toMatch(/^```xml\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain("<session-context>");
    expect(result).toContain("</session-context>");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildConversationContext
// ---------------------------------------------------------------------------

describe("buildConversationContext", () => {
  it("includes basic conversation fields", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "my-project",
      sessionName: "my-session",
      session,
      conversationId: "conv-1",
    });

    expect(result).toContain("<project>my-project</project>");
    expect(result).toContain("<session>my-session</session>");
    expect(result).toContain("<branch>csm/my-session</branch>");
    expect(result).toContain(
      "<worktree>/home/user/project/.worktrees/my-session</worktree>",
    );
    expect(result).toContain("<conversation-id>conv-1</conversation-id>");
    expect(result).toContain("<agent-backend>claude</agent-backend>");
    expect(result).toContain("<agent-session-ref>null</agent-session-ref>");
    expect(result).toContain("<status>awaiting</status>");
    expect(result).toContain("<prompt-count>3</prompt-count>");
    expect(result).toContain(
      "<last-activity>2026-03-28T12:00:00Z</last-activity>",
    );
    expect(result).toContain(
      "<transcript-path>/tmp/transcripts/conv-1.jsonl</transcript-path>",
    );
    expect(result).toContain("<total-cost-usd>0.42</total-cost-usd>");
    expect(result).toContain("<total-duration-ms>60000</total-duration-ms>");
    expect(result).toContain("<total-turns>5</total-turns>");
    expect(result).toContain("<source>cc</source>");
    expect(result).toContain("<session-source>cc</session-source>");
    expect(result).toContain("<creation-mode>normal</creation-mode>");
  });

  it("wraps output in xml code block", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });
    expect(result).toMatch(/^```xml\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain("<conversation-context>");
    expect(result).toContain("</conversation-context>");
  });

  it("includes conversation role when set", () => {
    const session = makeSession({
      conversations: [makeConversation({ role: "iteration" })],
    });
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });

    expect(result).toContain("<role>iteration</role>");
  });

  it("includes context token info when available", () => {
    const session = makeSession({
      conversations: [
        makeConversation({ contextTokens: 80000, contextWindowMax: 200000 }),
      ],
    });
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "conv-1",
    });

    expect(result).toContain("<context-tokens>80000</context-tokens>");
    expect(result).toContain("<context-window-max>200000</context-window-max>");
  });

  it("handles missing conversation gracefully", () => {
    const session = makeSession();
    const result = buildConversationContext({
      projectName: "p",
      sessionName: "s",
      session,
      conversationId: "nonexistent",
    });

    // Should still produce valid output with empty values
    expect(result).toContain("<conversation-context>");
    expect(result).toContain("<conversation-id>nonexistent</conversation-id>");
    expect(result).toContain("<status></status>");
  });
});
