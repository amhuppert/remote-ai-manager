import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { collectRuntimeTargets } from "./runtime-targets";

function projectNameFromPath(projectPath: string): string {
  return projectPath.slice(projectPath.lastIndexOf("/") + 1);
}

describe("collectRuntimeTargets", () => {
  it("collects only alive runtimes and preserves project/session identity", () => {
    const targets = collectRuntimeTargets({
      conversations: [
        {
          projectPath: "/projects/proj",
          sessionName: "sess-a",
          conversationId: "conv-1",
        },
        {
          projectPath: "/projects/proj",
          sessionName: "sess-a",
          conversationId: "conv-2",
        },
      ],
      getProjectName: projectNameFromPath,
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
      conversations: [
        {
          projectPath: "/projects/proj-a",
          sessionName: "sess-a",
          conversationId: "conv-1",
        },
        {
          projectPath: "/projects/proj-b",
          sessionName: "sess-b",
          conversationId: "conv-2",
        },
      ],
      getProjectName: projectNameFromPath,
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
    expect(targets.map((target) => target.projectName)).toEqual([
      "proj-a",
      "proj-b",
    ]);
  });
});
