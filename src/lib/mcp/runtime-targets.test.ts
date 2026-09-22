import {
  projectConversationTarget,
  sessionConversationTarget,
} from "@/lib/conversations/conversation-target";
import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { collectRuntimeTargets } from "./runtime-targets";

describe("collectRuntimeTargets", () => {
  it("collects only alive runtimes and preserves project/session identity", () => {
    const targets = collectRuntimeTargets({
      conversations: [
        {
          projectPath: "/projects/proj",
          target: sessionConversationTarget("proj", "sess-a", "conv-1"),
        },
        {
          projectPath: "/projects/proj",
          target: sessionConversationTarget("proj", "sess-a", "conv-2"),
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
        target: sessionConversationTarget("proj", "sess-a", "conv-1"),
        backend: "claude",
      },
    ]);
  });

  it("includes project conversations alongside session conversations without a synthetic session identity", () => {
    const project = projectConversationTarget("proj", "project-conv");
    const session = sessionConversationTarget("proj", "sess", "session-conv");
    const targets = collectRuntimeTargets({
      conversations: [
        { projectPath: "/projects/proj", target: project },
        { projectPath: "/projects/proj", target: session },
      ],
      getRuntime: () => ({ status: "alive", backend: "claude" }),
    });
    expect(targets.map(({ target }) => target)).toEqual([project, session]);
    expect(targets[0]?.target).not.toHaveProperty("sessionName");
  });

  it("flattens multiple projects and sessions in stable traversal order", () => {
    const targets = collectRuntimeTargets({
      conversations: [
        {
          projectPath: "/projects/proj-a",
          target: sessionConversationTarget("proj-a", "sess-a", "conv-1"),
        },
        {
          projectPath: "/projects/proj-b",
          target: sessionConversationTarget("proj-b", "sess-b", "conv-2"),
        },
      ],
      getRuntime(conversationId: string) {
        return {
          status: "alive" as const,
          backend: conversationId === "conv-1" ? "claude" : "codex",
        };
      },
    });

    expect(targets.map((target) => target.target.conversationId)).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(targets.map((target) => target.backend)).toEqual([
      "claude",
      "codex",
    ]);
    expect(targets.map((target) => target.target.projectName)).toEqual([
      "proj-a",
      "proj-b",
    ]);
  });
});
