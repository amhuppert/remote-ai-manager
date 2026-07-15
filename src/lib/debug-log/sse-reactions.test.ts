import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { debugLogKeys } from "@/lib/debug-log/query-keys";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { registerDebugLogSseReactions } from "./sse-reactions";

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  registerDebugLogSseReactions(fake as unknown as EventSource, { queryClient });
  return { fake, queryClient, invalidate };
}

describe("registerDebugLogSseReactions — debug-log-received", () => {
  it("invalidates active conversations and writes the stats cache from one typed frame", () => {
    const { fake, queryClient, invalidate } = setup();

    fake.emit("debug-log-received", {
      type: "debug-log-received",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      entryCount: 7,
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
    expect(
      queryClient.getQueryData(debugLogKeys.stats("proj", "sess", "conv-1")),
    ).toBe(7);
  });

  it("does not invalidate or write the stats cache for a wrong-shape frame", () => {
    const { fake, queryClient, invalidate } = setup();

    fake.emit("debug-log-received", {
      type: "debug-log-received",
      projectName: "proj",
      // missing sessionName / conversationId / entryCount
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(debugLogKeys.stats("proj", "sess", "conv-1")),
    ).toBeUndefined();
  });
});
