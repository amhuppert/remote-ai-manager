import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import type {
  TicketChangedEvent,
  TicketListItem,
  TicketListSort,
  TicketStatus,
  TicketWorkType,
} from "./schemas";
import {
  matchesTicketListFilters,
  normalizeTicketListFilters,
  sortTicketListItems,
  type TicketListFilters,
} from "./list-filters";
import { registerPendingTicketOverlay } from "./pending-overlay";
import { ticketKeys } from "./query-keys";
import { ticketQueries } from "./queries";
import {
  applyTicketChangedEvent,
  reduceTicketListForEvent,
} from "./sse-reducer";

// ---------------------------------------------------------------------------
// Deterministic property harness (no fast-check dependency; seeded PRNG)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  const index = Math.floor(rand() * values.length);
  const value = values[index];
  if (value === undefined) throw new Error("empty pool");
  return value;
}

const PROJECTS = ["alpha", "beta"] as const;
const NUMBERS = [1, 2, 3, 4] as const;
const STATUSES: readonly TicketStatus[] = [
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "closed",
];
const WORK_TYPES: readonly TicketWorkType[] = [
  "feature",
  "bug",
  "research",
  "tech_debt",
  "performance",
];
const TIMES = [
  "2026-07-01T00:00:00.000Z",
  "2026-07-02T00:00:00.000Z",
  "2026-07-03T00:00:00.000Z",
  "2026-07-04T00:00:00.000Z",
] as const;
const SORTS: readonly TicketListSort[] = ["updated", "created"];
const CHANGES: readonly TicketChangedEvent["change"][] = [
  "created",
  "updated",
  "deleted",
  "attachments",
  "session",
];

function genItem(
  rand: () => number,
  identity?: { projectName: string; number: number },
): TicketListItem {
  const projectName = identity?.projectName ?? pick(rand, PROJECTS);
  const number = identity?.number ?? pick(rand, NUMBERS);
  return {
    id: `${projectName}-${number}`,
    projectPath: `/projects/${projectName}`,
    projectName,
    number,
    title: `Ticket ${projectName}#${number}`,
    workType: pick(rand, WORK_TYPES),
    status: pick(rand, STATUSES),
    attachmentCount: Math.floor(rand() * 4),
    activeSessionName: rand() < 0.3 ? "some-session" : null,
    createdAt: pick(rand, TIMES),
    updatedAt: pick(rand, TIMES),
  };
}

function genFilters(rand: () => number): TicketListFilters {
  return normalizeTicketListFilters({
    ...(rand() < 0.5 ? { projectName: pick(rand, PROJECTS) } : {}),
    ...(rand() < 0.5 ? { status: pick(rand, STATUSES) } : {}),
    ...(rand() < 0.5 ? { workType: pick(rand, WORK_TYPES) } : {}),
    sort: pick(rand, SORTS),
  });
}

/** A realistic cache: distinct identities, filter-matching, sorted. */
function genCache(
  rand: () => number,
  filters: TicketListFilters,
): TicketListItem[] {
  const count = Math.floor(rand() * 7);
  const byIdentity = new Map<string, TicketListItem>();
  for (let i = 0; i < count; i++) {
    const candidate = genItem(rand);
    if (!matchesTicketListFilters(filters, candidate)) continue;
    byIdentity.set(candidate.id, candidate);
  }
  return sortTicketListItems(filters.sort, [...byIdentity.values()]);
}

function genEvent(rand: () => number): TicketChangedEvent {
  const change = pick(rand, CHANGES);
  const projectName = pick(rand, PROJECTS);
  const number = pick(rand, NUMBERS);
  return {
    type: "ticket-changed",
    change,
    projectName,
    ticketNumber: number,
    listItem:
      change === "deleted" ? null : genItem(rand, { projectName, number }),
    attachmentIndexChanged: change === "attachments",
    ...(change === "session" ? { linkedSessionName: "linked-session" } : {}),
  };
}

function identityRows(
  list: readonly TicketListItem[],
  event: TicketChangedEvent,
): TicketListItem[] {
  return list.filter(
    (row) =>
      row.projectName === event.projectName &&
      row.number === event.ticketNumber,
  );
}

describe("reduceTicketListForEvent — properties over generated deltas", () => {
  const CASES = 300;

  it("is idempotent, keeps caches sorted and duplicate-free, and places the identity exactly per the filters", () => {
    for (let seed = 0; seed < CASES; seed++) {
      const rand = mulberry32(seed);
      const filters = genFilters(rand);
      const cache = genCache(rand, filters);
      const event = genEvent(rand);

      const once = reduceTicketListForEvent(cache, filters, event);
      const twice = reduceTicketListForEvent(once, filters, event);

      // Idempotence: applying the same delta again changes nothing.
      expect(twice, `seed ${seed}`).toEqual(once);

      // The result stays in shared-module order.
      expect(once, `seed ${seed}`).toEqual(
        sortTicketListItems(filters.sort, once),
      );

      // The changed identity appears at most once, exactly when the event
      // carries a lean item that matches the list's typed filters.
      const rows = identityRows(once, event);
      const shouldContain =
        event.listItem !== null &&
        matchesTicketListFilters(filters, event.listItem);
      expect(rows.length, `seed ${seed}`).toBe(shouldContain ? 1 : 0);
      if (shouldContain) {
        expect(rows[0], `seed ${seed}`).toEqual(event.listItem);
      }

      // Every other row is untouched, in its original relative order.
      const othersBefore = cache.filter(
        (row) => identityRows([row], event).length === 0,
      );
      const othersAfter = once.filter(
        (row) => identityRows([row], event).length === 0,
      );
      expect(othersAfter, `seed ${seed}`).toEqual(othersBefore);

      // Purity: the input cache was not mutated.
      expect(cache, `seed ${seed}`).toEqual(
        sortTicketListItems(filters.sort, cache),
      );
    }
  });
});

describe("ticket list query ordering around SSE", () => {
  it("aborts an older in-flight list response before applying a newer event", async () => {
    const client = new QueryClient();
    const listKey = ticketKeys.list(normalizeTicketListFilters({}));
    const original = genItem(mulberry32(41), {
      projectName: "alpha",
      number: 1,
    });
    client.setQueryData(listKey, [original]);
    let requestSignal: AbortSignal | undefined;
    let resolveOldResponse: (response: Response) => void = () => {};
    const fetchSpy = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          resolveOldResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const oldRefetch = client
        .fetchQuery({ ...ticketQueries.list({}), staleTime: 0 })
        .catch(() => undefined);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

      applyTicketChangedEvent(client, {
        type: "ticket-changed",
        change: "deleted",
        projectName: "alpha",
        ticketNumber: 1,
        listItem: null,
        attachmentIndexChanged: false,
      });
      const wasAborted = requestSignal?.aborted ?? false;
      resolveOldResponse(Response.json([original]));
      await oldRefetch;

      expect(wasAborted).toBe(true);
      expect(client.getQueryData<TicketListItem[]>(listKey)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reduceTicketListForEvent — pinned cases", () => {
  const filters = normalizeTicketListFilters({});

  it("re-sorts an updated item into its new position", () => {
    const a = genItem(mulberry32(1), { projectName: "alpha", number: 1 });
    const b = genItem(mulberry32(2), { projectName: "alpha", number: 2 });
    const cache = sortTicketListItems("updated", [
      { ...a, updatedAt: "2026-07-01T00:00:00.000Z" },
      { ...b, updatedAt: "2026-07-02T00:00:00.000Z" },
    ]);

    const moved = reduceTicketListForEvent(cache, filters, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: { ...a, updatedAt: "2026-07-04T00:00:00.000Z" },
      attachmentIndexChanged: false,
    });
    expect(moved.map((r) => r.id)).toEqual(["alpha-1", "alpha-2"]);
  });

  it("deletion removes the identity from every cache shape", () => {
    const a = genItem(mulberry32(3), { projectName: "alpha", number: 1 });
    const result = reduceTicketListForEvent([a], filters, {
      type: "ticket-changed",
      change: "deleted",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: null,
      attachmentIndexChanged: false,
    });
    expect(result).toEqual([]);
  });

  it("evicts the identity from caches whose filters no longer match", () => {
    const inProgress = normalizeTicketListFilters({ status: "in_progress" });
    const a = {
      ...genItem(mulberry32(4), { projectName: "alpha", number: 1 }),
      status: "in_progress" as const,
    };
    const result = reduceTicketListForEvent([a], inProgress, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: { ...a, status: "done" },
      attachmentIndexChanged: false,
    });
    expect(result).toEqual([]);
  });

  it("returns the same array reference when the event is a no-op for this cache", () => {
    const beta = normalizeTicketListFilters({ projectName: "beta" });
    const row = {
      ...genItem(mulberry32(5), { projectName: "beta", number: 2 }),
    };
    const cache = [row];
    const result = reduceTicketListForEvent(cache, beta, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: genItem(mulberry32(6), { projectName: "alpha", number: 1 }),
      attachmentIndexChanged: false,
    });
    expect(result).toBe(cache);
  });
});

describe("applyTicketChangedEvent", () => {
  const allKey = ticketKeys.list(normalizeTicketListFilters({}));
  const doneKey = ticketKeys.list(
    normalizeTicketListFilters({ status: "done" }),
  );

  function seededClient() {
    const client = new QueryClient();
    const t1 = {
      ...genItem(mulberry32(10), { projectName: "alpha", number: 1 }),
      status: "not_started" as const,
    };
    const t2 = {
      ...genItem(mulberry32(11), { projectName: "beta", number: 2 }),
      status: "done" as const,
    };
    client.setQueryData(allKey, [t1, t2]);
    client.setQueryData(doneKey, [t2]);
    client.setQueryData(ticketKeys.detail("alpha", 1), { id: "alpha-1" });
    client.setQueryData(ticketKeys.detail("beta", 2), { id: "beta-2" });
    client.setQueryData(ticketKeys.sessionLinks("alpha"), {});
    client.setQueryData(ticketKeys.sessionLinks("beta"), {});
    return { client, t1, t2 };
  }

  it("reduces every cached list and invalidates exactly the one detail key on a plain update", () => {
    const { client, t1 } = seededClient();
    const updated = { ...t1, status: "done" as const };

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: updated,
      attachmentIndexChanged: false,
    });

    expect(
      client
        .getQueryData<TicketListItem[]>(doneKey)
        ?.map((r) => r.id)
        .sort(),
    ).toEqual(["alpha-1", "beta-2"]);
    expect(
      client
        .getQueryData<TicketListItem[]>(allKey)
        ?.find((r) => r.id === "alpha-1")?.status,
    ).toBe("done");
    // Req 9.8: an open detail view must reflect changes from any source, so
    // the one detail key refetches even when the lean event carried the list
    // fields; session-link caches stay untouched without a named session.
    expect(
      client.getQueryState(ticketKeys.detail("alpha", 1))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(ticketKeys.detail("beta", 2))?.isInvalidated,
    ).toBe(false);
    expect(
      client.getQueryState(ticketKeys.sessionLinks("alpha"))?.isInvalidated,
    ).toBe(false);
  });

  it("removes the identity everywhere and drops the one detail cache on deletion", () => {
    const { client } = seededClient();

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "deleted",
      projectName: "beta",
      ticketNumber: 2,
      listItem: null,
      attachmentIndexChanged: false,
    });

    expect(
      client.getQueryData<TicketListItem[]>(allKey)?.map((r) => r.id),
    ).toEqual(["alpha-1"]);
    expect(client.getQueryData<TicketListItem[]>(doneKey)).toEqual([]);
    expect(client.getQueryData(ticketKeys.detail("beta", 2))).toBeUndefined();
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toBeDefined();
  });

  it("clears an actively observed detail and invalidates the project session-link map on deletion", () => {
    const { client } = seededClient();
    const detailKey = ticketKeys.detail("beta", 2);
    const observer = new QueryObserver(client, {
      queryKey: detailKey,
      queryFn: async () => ({ id: "unexpected" }),
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "deleted",
      projectName: "beta",
      ticketNumber: 2,
      listItem: null,
      attachmentIndexChanged: false,
    });

    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(
      client.getQueryData(ticketKeys.sessionLinks("beta")),
    ).toBeUndefined();
    unsubscribe();
  });

  it("treats a repeated deletion frame as a side-effect-free duplicate", () => {
    const { client } = seededClient();
    const resetSpy = vi.spyOn(client, "resetQueries");
    const event: TicketChangedEvent = {
      type: "ticket-changed",
      change: "deleted",
      projectName: "beta",
      ticketNumber: 2,
      listItem: null,
      attachmentIndexChanged: false,
    };

    applyTicketChangedEvent(client, event);
    expect(resetSpy).toHaveBeenCalledTimes(2);

    applyTicketChangedEvent(client, event);
    expect(resetSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidates exactly the one detail key when the attachment index changed", () => {
    const { client, t1 } = seededClient();

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "attachments",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: { ...t1, attachmentCount: t1.attachmentCount + 1 },
      attachmentIndexChanged: true,
    });

    expect(
      client.getQueryState(ticketKeys.detail("alpha", 1))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(ticketKeys.detail("beta", 2))?.isInvalidated,
    ).toBe(false);
    expect(
      client
        .getQueryData<TicketListItem[]>(allKey)
        ?.find((r) => r.id === "alpha-1")?.attachmentCount,
    ).toBe(t1.attachmentCount + 1);
  });

  it("invalidates exactly the one project session-link key when a session is named", () => {
    const { client, t1 } = seededClient();

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "session",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: { ...t1, activeSessionName: "ticket-session" },
      attachmentIndexChanged: false,
      linkedSessionName: "ticket-session",
    });

    expect(
      client.getQueryState(ticketKeys.sessionLinks("alpha"))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(ticketKeys.sessionLinks("beta"))?.isInvalidated,
    ).toBe(false);
    expect(
      client
        .getQueryData<TicketListItem[]>(allKey)
        ?.find((r) => r.id === "alpha-1")?.activeSessionName,
    ).toBe("ticket-session");
  });
});

describe("applyTicketChangedEvent — pending optimistic overlays", () => {
  const allKey = ticketKeys.list(normalizeTicketListFilters({}));
  const doneKey = ticketKeys.list(
    normalizeTicketListFilters({ status: "done" }),
  );
  const notStartedKey = ticketKeys.list(
    normalizeTicketListFilters({ status: "not_started" }),
  );

  /** Caches as they look right after an optimistic not_started → done move. */
  function movedClient() {
    const client = new QueryClient();
    const moved = {
      ...genItem(mulberry32(20), { projectName: "alpha", number: 1 }),
      status: "done" as const,
      updatedAt: "2026-07-04T00:00:00.000Z",
    };
    client.setQueryData(allKey, [moved]);
    client.setQueryData(doneKey, [moved]);
    client.setQueryData(notStartedKey, []);
    client.setQueryData(ticketKeys.detail("alpha", 1), { id: "alpha-1" });
    return { client, moved };
  }

  /** The pre-move server truth arriving late over SSE. */
  function staleEvent(moved: TicketListItem): TicketChangedEvent {
    return {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: {
        ...moved,
        status: "not_started",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      attachmentIndexChanged: false,
    };
  }

  it("a stale event cannot undo a pending optimistic move", () => {
    const { client, moved } = movedClient();
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done", updatedAt: moved.updatedAt },
    });

    applyTicketChangedEvent(client, staleEvent(moved));

    expect(
      client
        .getQueryData<TicketListItem[]>(allKey)
        ?.find((r) => r.id === "alpha-1")?.status,
    ).toBe("done");
    expect(
      client.getQueryData<TicketListItem[]>(doneKey)?.map((r) => r.id),
    ).toEqual(["alpha-1"]);
    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);
  });

  it("event data outside the overlaid fields still applies", () => {
    const { client, moved } = movedClient();
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done", updatedAt: moved.updatedAt },
    });

    const event = staleEvent(moved);
    if (event.listItem === null) throw new Error("expected lean item");
    applyTicketChangedEvent(client, {
      ...event,
      listItem: { ...event.listItem, title: "Renamed elsewhere" },
    });

    const row = client
      .getQueryData<TicketListItem[]>(allKey)
      ?.find((r) => r.id === "alpha-1");
    expect(row?.status).toBe("done");
    expect(row?.title).toBe("Renamed elsewhere");
  });

  it("a stale event stays rejected once the overlay is unregistered", () => {
    const { client, moved } = movedClient();
    const unregister = registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done", updatedAt: moved.updatedAt },
    });
    unregister();

    applyTicketChangedEvent(client, staleEvent(moved));

    expect(
      client
        .getQueryData<TicketListItem[]>(allKey)
        ?.find((r) => r.id === "alpha-1")?.status,
    ).toBe("done");
    expect(
      client.getQueryData<TicketListItem[]>(doneKey)?.map((r) => r.id),
    ).toEqual(["alpha-1"]);
    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);
  });

  it("a delayed pre-delete event cannot resurrect a deleted ticket", () => {
    const { client, moved } = movedClient();

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "deleted",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: null,
      attachmentIndexChanged: false,
    });
    applyTicketChangedEvent(client, staleEvent(moved));

    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    expect(client.getQueryData<TicketListItem[]>(doneKey)).toEqual([]);
    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);
  });

  it("remembers a newer delta after it moves the ticket out of the only cached filter", () => {
    const client = new QueryClient();
    const original = {
      ...genItem(mulberry32(22), { projectName: "alpha", number: 1 }),
      status: "not_started" as const,
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    client.setQueryData(notStartedKey, [original]);

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: {
        ...original,
        status: "done",
        updatedAt: "2026-07-04T00:00:00.000Z",
      },
      attachmentIndexChanged: false,
    });
    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: {
        ...original,
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      attachmentIndexChanged: false,
    });

    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);
  });

  it("no event can resurrect a ticket while its delete is pending", () => {
    const client = new QueryClient();
    client.setQueryData(allKey, []);
    client.setQueryData(notStartedKey, []);
    registerPendingTicketOverlay(client, "alpha", 1, { kind: "remove" });

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "updated",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: genItem(mulberry32(21), { projectName: "alpha", number: 1 }),
      attachmentIndexChanged: false,
    });

    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    expect(client.getQueryData<TicketListItem[]>(notStartedKey)).toEqual([]);
  });

  it("skips the detail invalidation while an overlay is pending — the owning mutation's onSettled covers it", () => {
    const { client, moved } = movedClient();
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done", updatedAt: moved.updatedAt },
    });

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "attachments",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: { ...moved, attachmentCount: moved.attachmentCount + 1 },
      attachmentIndexChanged: true,
    });

    expect(
      client.getQueryState(ticketKeys.detail("alpha", 1))?.isInvalidated,
    ).toBe(false);

    applyTicketChangedEvent(client, staleEvent(moved));

    expect(
      client.getQueryState(ticketKeys.detail("alpha", 1))?.isInvalidated,
    ).toBe(false);
  });

  it("a genuine deletion still removes everything despite a patch overlay", () => {
    const { client, moved } = movedClient();
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done", updatedAt: moved.updatedAt },
    });

    applyTicketChangedEvent(client, {
      type: "ticket-changed",
      change: "deleted",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: null,
      attachmentIndexChanged: false,
    });

    expect(client.getQueryData<TicketListItem[]>(allKey)).toEqual([]);
    expect(client.getQueryData<TicketListItem[]>(doneKey)).toEqual([]);
    expect(client.getQueryData(ticketKeys.detail("alpha", 1))).toBeUndefined();
  });
});
