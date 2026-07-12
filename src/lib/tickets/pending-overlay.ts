/**
 * pending-overlay.ts — the pending-optimistic guard the SSE reducer consults
 * so a mid-flight `ticket-changed` delta can never undo an optimistic move.
 *
 * Optimistic mutations register the lean-field overlay (or removal) they
 * applied, keyed by ticket identity and scoped to the QueryClient, and
 * unregister on settle. While registered, the reducer reapplies the overlay on
 * top of incoming lean items, so event data outside the overlaid fields still
 * lands; genuine deletion events pass through untouched because the server's
 * removal is authoritative. The registry is a WeakMap keyed by QueryClient:
 * tests get isolation from fresh clients and nothing outlives its client.
 *
 * Client-imported: keep this module free of `node:` builtins.
 */

import type { QueryClient } from "@tanstack/react-query";

import type { TicketChangedEvent, TicketListItem } from "./schemas";

export type TicketOverlayPatch = Partial<
  Pick<
    TicketListItem,
    "title" | "workType" | "status" | "attachmentCount" | "updatedAt"
  >
>;

export type TicketPendingOverlay =
  | { kind: "patch"; fields: TicketOverlayPatch }
  | { kind: "remove" };

interface OverlayEntry {
  overlay: TicketPendingOverlay;
}

const registries = new WeakMap<QueryClient, Map<string, Set<OverlayEntry>>>();

function identityKey(projectName: string, number: number): string {
  return JSON.stringify([projectName, number]);
}

/**
 * Register a pending optimistic overlay for one ticket identity. Returns the
 * unregister function the owning mutation calls on settle; unregistering is
 * idempotent and removes only this registration.
 */
export function registerPendingTicketOverlay(
  queryClient: QueryClient,
  projectName: string,
  number: number,
  overlay: TicketPendingOverlay,
): () => void {
  let registry = registries.get(queryClient);
  if (!registry) {
    registry = new Map();
    registries.set(queryClient, registry);
  }
  const key = identityKey(projectName, number);
  let entries = registry.get(key);
  if (!entries) {
    entries = new Set();
    registry.set(key, entries);
  }
  const entry: OverlayEntry = { overlay };
  entries.add(entry);
  const owned = entries;
  return () => {
    owned.delete(entry);
    if (owned.size === 0) registry.delete(key);
  };
}

/**
 * The combined pending overlay for an identity, or null when none is pending.
 * A pending removal dominates; concurrent patches merge in registration order,
 * later registrations winning per field.
 */
export function pendingTicketOverlayFor(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): TicketPendingOverlay | null {
  const entries = registries
    .get(queryClient)
    ?.get(identityKey(projectName, number));
  if (!entries || entries.size === 0) return null;

  const fields: TicketOverlayPatch = {};
  for (const { overlay } of entries) {
    if (overlay.kind === "remove") return { kind: "remove" };
    Object.assign(fields, overlay.fields);
  }
  return { kind: "patch", fields };
}

/**
 * Rewrite an event so reducing it cannot fight the pending overlay: a removal
 * overlay drops the lean item (remove-only), a patch overlay reapplies the
 * optimistic fields over it. Deletion events and events without a lean item
 * pass through by reference.
 */
export function applyOverlayToTicketChangedEvent(
  event: TicketChangedEvent,
  overlay: TicketPendingOverlay | null,
): TicketChangedEvent {
  if (
    overlay === null ||
    event.change === "deleted" ||
    event.listItem === null
  ) {
    return event;
  }
  if (overlay.kind === "remove") {
    return { ...event, listItem: null };
  }
  return { ...event, listItem: { ...event.listItem, ...overlay.fields } };
}
