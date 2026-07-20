import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { specKeys } from "./query-keys";
import { registerSpecSseReactions } from "./sse-reactions";

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  registerSpecSseReactions(fake as unknown as EventSource, { queryClient });
  return { fake, invalidate };
}

describe("registerSpecSseReactions", () => {
  it("invalidates live chip queries when a published revision changes phase", () => {
    const { fake, invalidate } = setup();

    fake.emit("spec-revision-changed", {
      type: "spec-revision-changed",
      projectPath: "/repos/demo",
      specId: "spec-1",
      specSlug: "native-sdd",
      occurredAt: "2026-07-18T00:00:00Z",
      kind: "revision-proposed",
      revisionId: "revision-2",
    });

    expect(invalidate).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: specKeys.all });
  });

  it("refreshes the active-conversations feed when an execution changes so Active Work stays live", () => {
    const { fake, invalidate } = setup();

    fake.emit("spec-execution-changed", {
      type: "spec-execution-changed",
      projectPath: "/repos/demo",
      specId: "spec-1",
      specSlug: "native-sdd",
      occurredAt: "2026-07-18T00:00:00Z",
      kind: "execution_started",
      revisionId: "revision-2",
      executionId: "execution-1",
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: specKeys.all });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: conversationKeys.active(),
    });
  });

  it("drops malformed spec events without invalidating queries", () => {
    const { fake, invalidate } = setup();

    fake.emit("spec-revision-changed", {
      type: "spec-revision-changed",
      specSlug: "native-sdd",
    });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
