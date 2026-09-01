/**
 * Per-client ordering memory for authoritative ticket state. A ticket number
 * is never reused, so a deletion is a terminal tombstone for that identity.
 * Surviving states use the ticket's `updatedAt` as their ordering token.
 *
 * Raw SSE memory is kept separately from cache timestamps. Mutation overlays
 * deliberately put future-looking timestamps in the cache, while a raw SSE
 * event still needs to be remembered and replayed after that overlay leaves.
 *
 * Client-imported: keep this module free of `node:` builtins.
 */

import type { QueryClient } from "@tanstack/react-query";

import { ticketKeys } from "./query-keys";
import { pendingTicketOverlayFor } from "./pending-overlay";
import type {
  TicketChangedEvent,
  TicketDetail,
  TicketListItem,
} from "./schemas";

interface TicketEventVersion {
  updatedAt: string | null;
  deleted: boolean;
  revision: number;
  latestEvent: TicketChangedEvent | null;
}

export interface TicketEventCursor {
  revision: number;
}

const versions = new WeakMap<QueryClient, Map<string, TicketEventVersion>>();

function identityKey(projectName: string, number: number): string {
  return JSON.stringify([projectName, number]);
}

function laterTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}

function cachedUpdatedAt(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): string | null {
  let latest: string | null = null;
  for (const [, rows] of queryClient.getQueriesData<TicketListItem[]>({
    queryKey: ticketKeys.lists(),
  })) {
    const row = rows?.find(
      (candidate) =>
        candidate.projectName === projectName && candidate.number === number,
    );
    latest = laterTimestamp(latest, row?.updatedAt ?? null);
  }

  const detail = queryClient.getQueryData<TicketDetail>(
    ticketKeys.detail(projectName, number),
  );
  return laterTimestamp(latest, detail?.updatedAt ?? null);
}

function rememberedVersion(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): TicketEventVersion | undefined {
  return versions.get(queryClient)?.get(identityKey(projectName, number));
}

function currentVersion(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  includeCachedVersion: boolean,
): Pick<TicketEventVersion, "updatedAt" | "deleted"> {
  const remembered = rememberedVersion(queryClient, projectName, number);
  return {
    updatedAt: includeCachedVersion
      ? laterTimestamp(
          remembered?.updatedAt ?? null,
          cachedUpdatedAt(queryClient, projectName, number),
        )
      : (remembered?.updatedAt ?? null),
    deleted: remembered?.deleted ?? false,
  };
}

function versionRegistry(
  queryClient: QueryClient,
): Map<string, TicketEventVersion> {
  let registry = versions.get(queryClient);
  if (!registry) {
    registry = new Map();
    versions.set(queryClient, registry);
  }
  return registry;
}

/** Capture the raw-SSE revision before a mutation starts its cache overlay. */
export function captureTicketEventCursor(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): TicketEventCursor {
  const registry = versionRegistry(queryClient);
  const key = identityKey(projectName, number);
  const remembered = registry.get(key);
  const next = {
    updatedAt: laterTimestamp(
      remembered?.updatedAt ?? null,
      cachedUpdatedAt(queryClient, projectName, number),
    ),
    deleted: remembered?.deleted ?? false,
    revision: remembered?.revision ?? 0,
    latestEvent: remembered?.latestEvent ?? null,
  };
  registry.set(key, next);
  return { revision: next.revision };
}

export function isStaleTicketChangedEvent(
  queryClient: QueryClient,
  event: TicketChangedEvent,
  options: { includeCachedVersion?: boolean } = {},
): boolean {
  const remembered = rememberedVersion(
    queryClient,
    event.projectName,
    event.ticketNumber,
  );
  const current = currentVersion(
    queryClient,
    event.projectName,
    event.ticketNumber,
    options.includeCachedVersion ?? true,
  );
  if (event.change === "deleted") return current.deleted;
  if (current.deleted) return true;
  if (event.listItem === null || current.updatedAt === null) return false;
  if (
    remembered?.latestEvent &&
    remembered.updatedAt !== null &&
    event.listItem.updatedAt <= remembered.updatedAt
  ) {
    return true;
  }
  return event.listItem.updatedAt < current.updatedAt;
}

export function rememberTicketChangedEvent(
  queryClient: QueryClient,
  event: TicketChangedEvent,
): void {
  const registry = versionRegistry(queryClient);
  const key = identityKey(event.projectName, event.ticketNumber);
  const current = rememberedVersion(
    queryClient,
    event.projectName,
    event.ticketNumber,
  );
  registry.set(key, {
    updatedAt: laterTimestamp(
      current?.updatedAt ?? null,
      event.listItem?.updatedAt ?? null,
    ),
    deleted: (current?.deleted ?? false) || event.change === "deleted",
    revision: (current?.revision ?? 0) + 1,
    latestEvent: event,
  });
}

/** Record a successful HTTP result without manufacturing an SSE revision. */
export function rememberAuthoritativeTicketVersion(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  updatedAt: string,
): void {
  const registry = versionRegistry(queryClient);
  const key = identityKey(projectName, number);
  const current = registry.get(key);
  registry.set(key, {
    updatedAt: laterTimestamp(current?.updatedAt ?? null, updatedAt),
    deleted: current?.deleted ?? false,
    revision: current?.revision ?? 0,
    latestEvent: current?.latestEvent ?? null,
  });
}

/** Record a successful local deletion as the terminal identity tombstone. */
export function rememberAuthoritativeTicketDeletion(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): void {
  const registry = versionRegistry(queryClient);
  const key = identityKey(projectName, number);
  const current = registry.get(key);
  registry.set(key, {
    updatedAt: current?.updatedAt ?? null,
    deleted: true,
    revision: current?.revision ?? 0,
    latestEvent: current?.latestEvent ?? null,
  });
}

export function isAuthoritativelyDeletedTicket(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): boolean {
  return rememberedVersion(queryClient, projectName, number)?.deleted ?? false;
}

/** Whether remembered authoritative state is newer than an HTTP result. */
export function ticketEventVersionSupersedes(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  updatedAt: string,
): boolean {
  const remembered = rememberedVersion(queryClient, projectName, number);
  if (remembered?.deleted) return true;
  const currentUpdatedAt = laterTimestamp(
    remembered?.updatedAt ?? null,
    pendingTicketOverlayFor(queryClient, projectName, number) === null
      ? cachedUpdatedAt(queryClient, projectName, number)
      : null,
  );
  return currentUpdatedAt !== null && currentUpdatedAt > updatedAt;
}

/** The newest raw SSE event accepted after the supplied mutation cursor. */
export function ticketChangedEventSince(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  cursor: TicketEventCursor,
): TicketChangedEvent | null {
  const remembered = rememberedVersion(queryClient, projectName, number);
  if (!remembered || remembered.revision <= cursor.revision) return null;
  return remembered.latestEvent;
}
