import type { QueryClient } from "@tanstack/react-query";

import type { SpecSseEvent } from "@/lib/api/sse-events";
import type { SpecSseEventType } from "./schemas";

export interface SpecPendingOverlay {
  eventTypes: SpecSseEventType[];
}

export interface PendingSpecOverlayRegistration {
  readonly specId: string;
  readonly token: symbol;
}

interface SpecOverlayState {
  readonly entries: Map<symbol, Set<SpecSseEventType>>;
  readonly deferredEvents: Map<SpecSseEventType, SpecSseEvent>;
}

const registries = new WeakMap<QueryClient, Map<string, SpecOverlayState>>();

function stateFor(
  queryClient: QueryClient,
  specId: string,
  create: boolean,
): SpecOverlayState | null {
  let registry = registries.get(queryClient);
  if (!registry && create) {
    registry = new Map();
    registries.set(queryClient, registry);
  }

  let state = registry?.get(specId);
  if (!state && create && registry) {
    state = { entries: new Map(), deferredEvents: new Map() };
    registry.set(specId, state);
  }

  return state ?? null;
}

function protectedEventTypes(state: SpecOverlayState): Set<SpecSseEventType> {
  const combined = new Set<SpecSseEventType>();
  for (const eventTypes of state.entries.values()) {
    for (const eventType of eventTypes) combined.add(eventType);
  }
  return combined;
}

export function registerPendingSpecOverlay(
  queryClient: QueryClient,
  specId: string,
  eventTypes: readonly SpecSseEventType[],
): PendingSpecOverlayRegistration {
  const state = stateFor(queryClient, specId, true);
  if (!state) throw new Error("Unable to create pending spec overlay state");

  const token = Symbol(specId);
  state.entries.set(token, new Set(eventTypes));
  return { specId, token };
}

export function pendingSpecOverlayFor(
  queryClient: QueryClient,
  specId: string,
): SpecPendingOverlay | null {
  const state = stateFor(queryClient, specId, false);
  if (!state || state.entries.size === 0) return null;

  return {
    eventTypes: [...protectedEventTypes(state)].sort(),
  };
}

export function rememberDeferredSpecEvent(
  queryClient: QueryClient,
  event: SpecSseEvent,
): void {
  const state = stateFor(queryClient, event.specId, false);
  if (!state) return;

  const current = state.deferredEvents.get(event.type);
  if (current && current.occurredAt > event.occurredAt) return;
  state.deferredEvents.set(event.type, event);
}

export function releasePendingSpecOverlay(
  queryClient: QueryClient,
  registration: PendingSpecOverlayRegistration,
): SpecSseEvent[] {
  const registry = registries.get(queryClient);
  const state = registry?.get(registration.specId);
  if (!state || !state.entries.delete(registration.token)) return [];

  const stillProtected = protectedEventTypes(state);
  const released: SpecSseEvent[] = [];
  for (const [eventType, event] of state.deferredEvents) {
    if (stillProtected.has(eventType)) continue;
    state.deferredEvents.delete(eventType);
    released.push(event);
  }

  if (state.entries.size === 0 && state.deferredEvents.size === 0) {
    registry?.delete(registration.specId);
  }

  return released.sort((left, right) =>
    left.occurredAt === right.occurredAt
      ? left.type.localeCompare(right.type)
      : left.occurredAt.localeCompare(right.occurredAt),
  );
}
