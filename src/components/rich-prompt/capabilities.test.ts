import { describe, expect, it } from "vitest";
import { resolvePromptCapabilityContext } from "./capabilities";

describe("resolvePromptCapabilityContext", () => {
  it("uses project-scoped providers before a session or conversation exists", () => {
    expect(
      resolvePromptCapabilityContext({ projectName: "command-center" }),
    ).toEqual({
      scope: "project",
      projectName: "command-center",
      backend: undefined,
      isWorkflowManagedConversation: false,
    });
  });

  it("preserves established conversation capability context", () => {
    expect(
      resolvePromptCapabilityContext({
        projectName: "command-center",
        sessionName: "fix-inputs",
        conversationId: "conversation-1",
        backend: "codex",
        isWorkflowManagedConversation: true,
      }),
    ).toEqual({
      scope: "conversation",
      projectName: "command-center",
      sessionName: "fix-inputs",
      conversationId: "conversation-1",
      backend: "codex",
      isWorkflowManagedConversation: true,
    });
  });
});
