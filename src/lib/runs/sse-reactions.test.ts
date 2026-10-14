import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { RUN_REFRESH_WINDOW_MS } from "./cache";
import { runKeys } from "./query-keys";
import { registerRunSseReactions } from "./sse-reactions";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  registerRunSseReactions(fake as unknown as EventSource, { queryClient });
  const stale = (key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated ?? null;
  const settle = () => vi.advanceTimersByTimeAsync(RUN_REFRESH_WINDOW_MS);
  return { fake, queryClient, stale, settle };
}

/** Just enough of a cached page for the reactions to read who works in it. */
function cachedPage(input: {
  owner: string;
  seats?: string[];
  earlierSeats?: string[];
}) {
  return {
    owner: { conversationId: input.owner, title: null, backend: null },
    contexts: [
      {
        agents: (input.seats ?? []).map((conversationId) => ({
          conversationId,
        })),
        previousInvocations: [
          {
            agents: (input.earlierSeats ?? []).map((conversationId) => ({
              conversationId,
            })),
          },
        ],
      },
    ],
  };
}

const session = { scope: "session", projectName: "plc", sessionName: "fx" };

describe("run SSE reactions", () => {
  it("refreshes the changed run's page, its session's list and every session's current runs, and nothing else", async () => {
    const { fake, queryClient, stale, settle } = setup();
    const list = runKeys.list("plc", "fx");
    const page = runKeys.page("plc", "fx", "run-1");
    const other = runKeys.page("plc", "fx", "run-2");
    const elsewhere = runKeys.list("plc", "other");
    const active = runKeys.active();
    for (const key of [list, page, other, elsewhere, active])
      queryClient.setQueryData(key, []);

    fake.emit("run-changed", {
      type: "run-changed",
      projectName: "plc",
      sessionName: "fx",
      runId: "run-1",
    });
    await settle();

    expect([
      stale(list),
      stale(page),
      stale(other),
      stale(elsewhere),
      stale(active),
    ]).toEqual([true, true, false, false, true]);
  });

  it("refreshes the pages a seat works in when its turn starts or ends, earlier passes included, and the list when it spends", async () => {
    const { fake, queryClient, stale, settle } = setup();
    const current = runKeys.page("plc", "fx", "run-1");
    const earlier = runKeys.page("plc", "fx", "run-2");
    const owned = runKeys.page("plc", "fx", "run-3");
    const list = runKeys.list("plc", "fx");
    queryClient.setQueryData(
      current,
      cachedPage({ owner: "o-1", seats: ["s-1"] }),
    );
    queryClient.setQueryData(
      earlier,
      cachedPage({ owner: "o-2", earlierSeats: ["s-1"] }),
    );
    queryClient.setQueryData(owned, cachedPage({ owner: "s-1" }));
    queryClient.setQueryData(list, []);

    fake.emit("conversation-status", {
      type: "conversation-status",
      ...session,
      conversationId: "s-1",
      status: "running",
    });
    await settle();
    // The owner's own turns are not on its run's page.
    expect([stale(current), stale(earlier), stale(owned), stale(list)]).toEqual(
      [true, true, false, false],
    );

    fake.emit("conversation-usage-updated", {
      type: "conversation-usage-updated",
      ...session,
      conversationId: "s-1",
      totalCostUsd: 1.5,
    });
    await settle();
    expect(stale(list)).toBe(true);
  });

  it("refreshes what names a conversation once it is renamed or deleted, owner or seat", async () => {
    const { fake, queryClient, stale, settle } = setup();
    const owned = runKeys.page("plc", "fx", "run-1");
    const seated = runKeys.page("plc", "fx", "run-2");
    const unrelated = runKeys.page("plc", "fx", "run-3");
    const list = runKeys.list("plc", "fx");
    queryClient.setQueryData(owned, cachedPage({ owner: "o-1" }));
    queryClient.setQueryData(
      seated,
      cachedPage({ owner: "o-2", seats: ["s-1"] }),
    );
    queryClient.setQueryData(unrelated, cachedPage({ owner: "o-3" }));
    queryClient.setQueryData(list, [{ owner: { conversationId: "o-1" } }]);

    fake.emit("conversation-renamed", {
      type: "conversation-renamed",
      ...session,
      conversationId: "o-1",
      name: "Owner one",
    });
    await settle();
    expect([
      stale(owned),
      stale(seated),
      stale(unrelated),
      stale(list),
    ]).toEqual([true, false, false, true]);

    fake.emit("conversation-deleted", {
      type: "conversation-deleted",
      ...session,
      conversationId: "s-1",
    });
    await settle();
    expect([stale(seated), stale(unrelated)]).toEqual([true, false]);
  });

  it("refetches an open page once for a burst of signals that name it", async () => {
    const { fake, queryClient, settle } = setup();
    const page = runKeys.page("plc", "fx", "run-1");
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: page,
      queryFn: async () => {
        fetches += 1;
        return cachedPage({ owner: "o-1", seats: ["s-1", "s-2"] });
      },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);

    for (const conversationId of ["s-1", "s-2"])
      fake.emit("conversation-status", {
        type: "conversation-status",
        ...session,
        conversationId,
        status: "awaiting",
      });
    fake.emit("run-changed", {
      type: "run-changed",
      projectName: "plc",
      sessionName: "fx",
      runId: "run-1",
    });
    await settle();

    expect(fetches).toBe(2);
    unsubscribe();
  });
});
