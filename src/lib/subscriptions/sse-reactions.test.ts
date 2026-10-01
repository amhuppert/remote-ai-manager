import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { registerSubscriptionSseReactions } from "./sse-reactions";
import { subscriptionKeys } from "./query-keys";

describe("subscription SSE scope", () => {
  it("invalidates affected recipient views and global totals without refreshing unrelated recipients or preferences", () => {
    const client = new QueryClient();
    const affected = subscriptionKeys.overview({
      project: "repo",
      conversation: "one",
    });
    const global = subscriptionKeys.overview({});
    const other = subscriptionKeys.inbox({
      project: "repo",
      conversation: "two",
    });
    const otherProject = subscriptionKeys.overview({ project: "elsewhere" });
    const preferences = subscriptionKeys.preferences("two");
    for (const key of [affected, global, other, otherProject, preferences])
      client.setQueryData(key, {});
    const es = new FakeEventSource("/events");
    registerSubscriptionSseReactions(es, { queryClient: client });
    es.emit("subscriptions-changed", {
      type: "subscriptions-changed",
      projectPath: "/repo",
      conversationId: "one",
    });
    expect(client.getQueryState(affected)?.isInvalidated).toBe(true);
    expect(client.getQueryState(global)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
    expect(client.getQueryState(otherProject)?.isInvalidated).toBe(false);
    expect(client.getQueryState(preferences)?.isInvalidated).toBe(false);
  });
  it("narrows source edits and reconciles all cached views only after a disconnected stream reopens", () => {
    const client = new QueryClient();
    const affected = subscriptionKeys.overview({
      project: "repo",
      sourceKind: "spec",
      sourceId: "spec-one",
    });
    const other = subscriptionKeys.overview({
      project: "repo",
      sourceKind: "notepad",
      sourceId: "pad",
    });
    for (const key of [affected, other]) client.setQueryData(key, {});
    const es = new FakeEventSource("/events");
    registerSubscriptionSseReactions(es, { queryClient: client });
    es.emit("open", {});
    expect(client.getQueryState(affected)?.isInvalidated).toBe(false);
    es.emit("spec-changed", {
      type: "spec-changed",
      projectPath: "/repo",
      specId: "spec-one",
      specSlug: "one",
      occurredAt: "now",
      kind: "updated",
    });
    expect(client.getQueryState(affected)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
    es.emit("error", {});
    es.emit("open", {});
    expect(client.getQueryState(other)?.isInvalidated).toBe(true);
  });
});
