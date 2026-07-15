import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { registerDevServerSseReactions } from "./sse-reactions";

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  registerDevServerSseReactions(fake as unknown as EventSource, {
    queryClient,
  });
  return { fake, invalidate };
}

describe("registerDevServerSseReactions — dev-server-status", () => {
  it("invalidates only the scoped list for the event's project/session", () => {
    const { fake, invalidate } = setup();

    fake.emit("dev-server-status", {
      type: "dev-server-status",
      projectName: "proj",
      sessionName: "sess",
      serverName: "web",
      status: "running",
      port: 3000,
      remoteUrl: null,
      errorMessage: null,
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: devServerKeys.list("proj", "sess"),
    });
  });

  it("does not invalidate for a wrong-shape frame", () => {
    const { fake, invalidate } = setup();

    fake.emit("dev-server-status", {
      type: "dev-server-status",
      projectName: "proj",
      // missing sessionName / serverName / status
    });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
