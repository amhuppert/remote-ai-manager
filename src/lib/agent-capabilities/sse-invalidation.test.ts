import { describe, expect, it } from "vitest";

import { agentCapabilityKeys } from "@/lib/query-keys";

import { computeAgentCapabilityInvalidations } from "./sse-invalidation";

describe("computeAgentCapabilityInvalidations", () => {
  it("global events invalidate the whole agent-capability subtree", () => {
    expect(
      computeAgentCapabilityInvalidations({
        level: "global",
        cascadeKind: "claude-skills",
      }),
    ).toEqual([{ queryKey: agentCapabilityKeys.all }]);
  });

  it("project events invalidate the project and descendant scopes for that cascade", () => {
    const result = computeAgentCapabilityInvalidations({
      level: "project",
      projectName: "proj",
      cascadeKind: "claude-skills",
    });

    expect(result).toEqual([
      {
        queryKey: agentCapabilityKeys.project("proj", "claude-skills"),
      },
      {
        queryKey: ["agent-capabilities", "session", "proj", "claude-skills"],
      },
      {
        queryKey: [
          "agent-capabilities",
          "conversation",
          "proj",
          "claude-skills",
        ],
      },
    ]);
  });

  it("session events invalidate the session and descendant conversations", () => {
    expect(
      computeAgentCapabilityInvalidations({
        level: "session",
        projectName: "proj",
        sessionName: "sess",
        cascadeKind: "claude-skills",
      }),
    ).toEqual([
      {
        queryKey: agentCapabilityKeys.session("proj", "sess", "claude-skills"),
      },
      {
        queryKey: [
          "agent-capabilities",
          "conversation",
          "proj",
          "claude-skills",
          "sess",
        ],
      },
    ]);
  });

  it("conversation events invalidate only that conversation cascade", () => {
    expect(
      computeAgentCapabilityInvalidations({
        level: "conversation",
        projectName: "proj",
        sessionName: "sess",
        conversationId: "conv",
        cascadeKind: "claude-skills",
      }),
    ).toEqual([
      {
        queryKey: agentCapabilityKeys.conversation(
          "proj",
          "sess",
          "conv",
          "claude-skills",
        ),
      },
    ]);
  });

  it("returns no invalidations when scoped identifiers are incomplete", () => {
    expect(
      computeAgentCapabilityInvalidations({
        level: "session",
        projectName: "proj",
        cascadeKind: "claude-skills",
      }),
    ).toEqual([]);
  });
});
