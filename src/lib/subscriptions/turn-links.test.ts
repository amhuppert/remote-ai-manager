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
it("selects a later wake receipt by provenance without changing its merged message index", () => {
  const origin = (batchId: string) => ({
    source: "subscription_update" as const,
    subscriptionUpdate: { batchId },
  });
  const messages = [
    { id: "earlier-assistant" },
    {
      id: "ordinary-user",
      sourceParts: [
        { seq: 1 },
        { seq: 2, origin: origin("first-batch") },
        { seq: 3, origin: origin("later-batch") },
      ],
    },
  ];
  for (const batchId of ["first-batch", "later-batch"])
    expect(
      subscriptionMessageIndex(
        new URLSearchParams(`c=conversation&m=${batchId}`),
        "conversation",
        messages,
      ),
    ).toBe(1);
  expect(
    subscriptionMessageIndex(
      new URLSearchParams("focus=conversation&m=later-batch"),
      "conversation",
      messages,
    ),
  ).toBe(1);
  expect(
    subscriptionMessageIndex(
      new URLSearchParams("c=another&m=later-batch"),
      "conversation",
      messages,
    ),
  ).toBeNull();
});
