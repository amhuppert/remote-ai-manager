import { expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { commandKeys } from "./query-keys";
import { registerCommandSseReactions } from "./sse-reactions";

it("refreshes conversation and project command catalogs after native skill changes", () => {
  const client = new QueryClient();
  const keys = [
    commandKeys.list("proj", "session", "codex", "conversation"),
    commandKeys.projectList("proj", "codex"),
  ];
  for (const key of keys) client.setQueryData(key, { items: [] });
  client.setQueryData(["unrelated"], true);
  const source = new FakeEventSource("/api/events");
  registerCommandSseReactions(source, { queryClient: client });
  source.emit("commands-changed", { type: "commands-changed" });
  for (const key of keys)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
});
