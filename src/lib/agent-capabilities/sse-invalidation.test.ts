import { describe, expect, it } from "vitest";

import { agentCapabilityKeys } from "./query-keys";

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
        conversationScope: "session",
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

  it("project conversation events invalidate by project conversation identity without the sentinel", () => {
    expect(
      computeAgentCapabilityInvalidations({
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "conv",
        cascadeKind: "claude-skills",
      }),
    ).toEqual([
      {
        queryKey: [
          "agent-capabilities",
          "conversation",
          "proj",
          "claude-skills",
          "project",
          "conv",
        ],
      },
    ]);
  });

  it("returns no invalidations when a project conversation event leaks the sentinel", () => {
    expect(
      computeAgentCapabilityInvalidations({
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        sessionName: "__project__",
        conversationId: "conv",
        cascadeKind: "claude-skills",
      }),
    ).toEqual([]);
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
