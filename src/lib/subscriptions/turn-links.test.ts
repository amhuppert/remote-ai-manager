import { expect, it } from "vitest";
import { subscriptionMessageIndex, subscriptionTurnHref } from "./turn-links";
it("links both scopes to their actual host and selects the exact receipt message", () => {
  const session = {
    scope: "session" as const,
    projectName: "repo",
    sessionName: "session",
    conversationId: "conversation",
  };
  const project = {
    scope: "project" as const,
    projectName: "repo",
    conversationId: "project-conversation",
  };
  expect(subscriptionTurnHref(session, "batch")).toBe(
    "/conversations?c=conversation&m=batch",
  );
  expect(subscriptionTurnHref(project, "batch")).toBe(
    "/projects/repo?focus=project-conversation&m=batch",
  );
  expect(
    subscriptionMessageIndex(
      new URLSearchParams("c=conversation&m=batch"),
      "conversation",
      [{ id: "first" }, { id: "batch" }],
    ),
  ).toBe(1);
  expect(
    subscriptionMessageIndex(
      new URLSearchParams("focus=project-conversation&m=batch"),
      "project-conversation",
      [{ id: "batch" }],
    ),
  ).toBe(0);
  expect(
    subscriptionMessageIndex(
      new URLSearchParams("c=another&m=batch"),
      "conversation",
      [{ id: "batch" }],
    ),
  ).toBeNull();
  expect(
    subscriptionMessageIndex(
      new URLSearchParams("c=conversation&m=missing"),
      "conversation",
      [{ id: "batch" }],
    ),
  ).toBeNull();
});
