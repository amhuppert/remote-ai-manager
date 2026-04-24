import { describe, expect, it } from "vitest";

import type { AgentBackendId, ConversationState, SessionState } from "@/types";

import { collectRuntimeTargets } from "./runtime-targets";

function mkConversation(id: string): ConversationState {
  return {
    id,
    createdAt: new Date().toISOString(),
    title: id,
  } as unknown as ConversationState;
}

function mkSession(
  sessionName: string,
  conversations: ConversationState[],
): SessionState {
  return {
    sessionName,
    worktreePath: `/projects/proj/.worktrees/${sessionName}`,
    branch: `cc/${sessionName}`,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conversations,
    activeConversationId: conversations[0]?.id ?? null,
  } as unknown as SessionState;
}

describe("collectRuntimeTargets", () => {
  it("collects only alive runtimes and preserves project/session identity", () => {
    const targets = collectRuntimeTargets({
      projects: [
        {
          projectPath: "/projects/proj",
          projectName: "proj",
          sessions: [
            mkSession("sess-a", [
              mkConversation("conv-1"),
              mkConversation("conv-2"),
            ]),
          ],
        },
      ],
      getRuntime(
        conversationId: string,
      ): { status: "alive" | "dead"; backend: AgentBackendId } | undefined {
        if (conversationId === "conv-1") {
          return { status: "alive", backend: "claude" };
        }
        if (conversationId === "conv-2") {
          return { status: "dead", backend: "codex" };
        }
        return undefined;
      },
    });

    expect(targets).toEqual([
      {
        projectPath: "/projects/proj",
        projectName: "proj",
        sessionName: "sess-a",
        conversationId: "conv-1",
        backend: "claude",
      },
    ]);
  });

  it("flattens multiple projects and sessions in stable traversal order", () => {
    const targets = collectRuntimeTargets({
      projects: [
        {
          projectPath: "/projects/proj-a",
          projectName: "proj-a",
          sessions: [mkSession("sess-a", [mkConversation("conv-1")])],
        },
        {
          projectPath: "/projects/proj-b",
          projectName: "proj-b",
          sessions: [mkSession("sess-b", [mkConversation("conv-2")])],
        },
      ],
      getRuntime(conversationId: string) {
        return {
          status: "alive" as const,
          backend: conversationId === "conv-1" ? "claude" : "codex",
        };
      },
    });

    expect(targets.map((target) => target.conversationId)).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(targets.map((target) => target.backend)).toEqual([
      "claude",
      "codex",
    ]);
  });
});
