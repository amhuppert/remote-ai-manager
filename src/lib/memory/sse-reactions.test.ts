import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { memoryKeys, type MemoryScopeRef } from "./query-keys";
import { registerMemorySseReactions } from "./sse-reactions";
import type { TicketChangedEvent } from "@/lib/tickets/schemas";
import type { MemoryChangedEvent, MemoryNote } from "./schemas";

/**
 * The panel's caches must reconcile from the typed change frame alone: the
 * frame is content-free by contract (identity, scope owner, lifecycle, head
 * revision), so a reaction can invalidate but never patch prose.
 */

const REF: MemoryScopeRef = { projectName: "cc", sessionName: "s1" };
const OTHER_REF: MemoryScopeRef = { projectName: "other", sessionName: null };

const LIST_FILTERS = { includeArchived: false } as const;
const REVIEW_FILTERS = { promotionCandidates: false, session: null } as const;

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem-1",
    slug: "shared-db",
    scope: "project",
    projectPath: "/repos/cc",
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "one DB across branches",
    body: "",
    statusNote: null,
    aliases: [],
    indexMode: "auto",
    lifecycle: "active",
    reviewAfter: null,
    expiresAt: null,
    supersedesId: null,
    supersededById: null,
    createdBy: "user",
    authorConversationId: null,
    revision: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function changed(
  overrides: Partial<MemoryChangedEvent> = {},
): MemoryChangedEvent {
  return {
    type: "memory-changed",
    change: "updated",
    memoryId: "mem-1",
    slug: "shared-db",
    scope: "project",
    projectPath: "/repos/cc",
    sessionName: null,
    sessionCreatedAt: null,
    lifecycle: "active",
    revision: 4,
    authorKind: "agent",
    link: null,
    ...overrides,
  };
}

function ticketChanged(
  overrides: Partial<TicketChangedEvent> = {},
): TicketChangedEvent {
  return {
    type: "ticket-changed",
    change: "updated",
    projectName: "cc",
    ticketNumber: 88,
    listItem: null,
    attachmentIndexChanged: false,
    ...overrides,
  };
}

let queryClient: QueryClient;
let es: FakeEventSource;

/** Seed a query as fresh data so `isStale` reports invalidation, not absence. */
function seed(key: readonly unknown[], data: unknown): void {
  queryClient.setQueryData(key, data);
}

function isStale(key: readonly unknown[]): boolean {
  const state = queryClient.getQueryCache().find({ queryKey: key })?.state;
  return state?.isInvalidated ?? false;
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  es = new FakeEventSource("/api/events");
  registerMemorySseReactions(es, { queryClient });
});

describe("memory SSE reactions", () => {
  it("invalidates the owning project's list, review queue, and detail", () => {
    seed(memoryKeys.list(REF, LIST_FILTERS), [note()]);
    seed(memoryKeys.review(REF, REVIEW_FILTERS), []);
    seed(memoryKeys.detail(REF, "mem-1"), { note: note(), links: [] });

    es.emit("memory-changed", changed());

    expect(isStale(memoryKeys.list(REF, LIST_FILTERS))).toBe(true);
    expect(isStale(memoryKeys.review(REF, REVIEW_FILTERS))).toBe(true);
    expect(isStale(memoryKeys.detail(REF, "mem-1"))).toBe(true);
  });

  it("leaves another project's list alone for a project-scoped change", () => {
    seed(memoryKeys.list(OTHER_REF, LIST_FILTERS), [note()]);

    es.emit("memory-changed", changed());

    expect(isStale(memoryKeys.list(OTHER_REF, LIST_FILTERS))).toBe(false);
  });

  it("invalidates every project's list for a global note", () => {
    // A global note is reachable from every project's Library, so its owner
    // cannot be used to narrow the invalidation.
    seed(memoryKeys.list(OTHER_REF, LIST_FILTERS), [note()]);

    es.emit(
      "memory-changed",
      changed({ scope: "global", projectPath: null, slug: "house-style" }),
    );

    expect(isStale(memoryKeys.list(OTHER_REF, LIST_FILTERS))).toBe(true);
  });

  it("invalidates every index preview: any note can change any block", () => {
    // Both renders of the same conversation, because a note can change the
    // delta a turn is due and the full index alike.
    seed(memoryKeys.indexPreview("conv-1", "next-turn"), {
      text: "old",
      bytes: 3,
    });
    seed(memoryKeys.indexPreview("conv-1", "full"), { text: "old", bytes: 3 });

    es.emit("memory-changed", changed());

    expect(isStale(memoryKeys.indexPreview("conv-1", "next-turn"))).toBe(true);
    expect(isStale(memoryKeys.indexPreview("conv-1", "full"))).toBe(true);
  });

  it("tells a detail already on screen that its note is gone", () => {
    // Asserted through a live observer on purpose. Dropping the cache entry
    // also leaves `getQueryData` undefined, so a cache-shaped assertion would
    // pass either way while the mounted pane kept rendering the deleted note:
    // removal notifies no observer, and what this reaction owes is the
    // notification.
    seed(memoryKeys.detail(REF, "mem-1"), { note: note(), links: [] });
    const observer = new QueryObserver(queryClient, {
      queryKey: memoryKeys.detail(REF, "mem-1"),
      queryFn: () => Promise.reject(new Error("note deleted")),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data).toBeDefined();

    es.emit("memory-changed", changed({ change: "deleted" }));

    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
  });

  it("drops a frame that does not match the change schema", () => {
    seed(memoryKeys.list(REF, LIST_FILTERS), [note()]);

    es.emit("memory-changed", { type: "memory-changed", change: "invented" });

    expect(isStale(memoryKeys.list(REF, LIST_FILTERS))).toBe(false);
  });
});

/**
 * Freshness is leases and expiry alone (D6), so no artifact transition can
 * change what the next turn's block carries: the memory panel subscribes to
 * memory changes and to nothing else.
 */
describe("ticket changes are not a memory input", () => {
  it("leaves the index previews, the review queues, and the lists alone", () => {
    seed(memoryKeys.indexPreview("conv-1", "next-turn"), {
      text: "old",
      bytes: 3,
    });
    seed(memoryKeys.review(REF, REVIEW_FILTERS), []);
    seed(memoryKeys.list(REF, LIST_FILTERS), [note()]);

    es.emit("ticket-changed", ticketChanged());

    expect(isStale(memoryKeys.indexPreview("conv-1", "next-turn"))).toBe(false);
    expect(isStale(memoryKeys.review(REF, REVIEW_FILTERS))).toBe(false);
    expect(isStale(memoryKeys.list(REF, LIST_FILTERS))).toBe(false);
  });
});
