import { describe, expect, it } from "vitest";
import type {
  ActiveConversation,
  ProjectActiveConversation,
  SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import { activeConversationHref } from "@/lib/active-conversations/row-helpers";

function sessionRow(
  overrides: Partial<SessionActiveConversation> = {},
): ActiveConversation {
  return {
    scope: "session",
    id: "conv-1",
    name: null,
    summary: null,
    status: "idle",
    unread: false,
    pendingApproval: null,
    pendingQuestionId: null,
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    projectName: "my-project",
    projectPath: "/tmp/my-project",
    sessionName: "my-session",
    archived: false,
    ...overrides,
  } as ActiveConversation;
}

function projectRow(
  overrides: Partial<ProjectActiveConversation> = {},
): ActiveConversation {
  return {
    scope: "project",
    id: "conv-2",
    name: null,
    summary: null,
    status: "idle",
    unread: false,
    pendingApproval: null,
    pendingQuestionId: null,
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    projectName: "my-project",
    projectPath: "/tmp/my-project",
    open: true,
    ...overrides,
  } as ActiveConversation;
}

describe("activeConversationHref", () => {
  it("returns the /conversations page URL for session-scoped rows", () => {
    expect(activeConversationHref(sessionRow())).toBe(
      "/conversations?c=conv-1",
    );
  });

  it("URL-encodes the conversation id", () => {
    expect(activeConversationHref(sessionRow({ id: "a b/c" }))).toBe(
      "/conversations?c=a%20b%2Fc",
    );
  });

  it("keeps the project cockpit focus URL for project-scoped rows", () => {
    expect(activeConversationHref(projectRow())).toBe(
      "/projects/my-project?focus=conv-2",
    );
  });

  it("URL-encodes the project name in the project-scope branch", () => {
    expect(activeConversationHref(projectRow({ projectName: "a b" }))).toBe(
      "/projects/a%20b?focus=conv-2",
    );
  });
});
