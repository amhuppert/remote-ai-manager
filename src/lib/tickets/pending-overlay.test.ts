import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  applyOverlayToTicketChangedEvent,
  pendingTicketOverlayFor,
  registerPendingTicketOverlay,
} from "./pending-overlay";
import type { TicketChangedEvent, TicketListItem } from "./schemas";

function item(overrides: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: "alpha-1",
    projectPath: "/projects/alpha",
    projectName: "alpha",
    number: 1,
    title: "A ticket",
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function updatedEvent(listItem: TicketListItem | null): TicketChangedEvent {
  return {
    type: "ticket-changed",
    change: "updated",
    projectName: "alpha",
    ticketNumber: 1,
    listItem,
    attachmentIndexChanged: false,
  };
}

describe("pendingTicketOverlayFor / registerPendingTicketOverlay", () => {
  it("returns null when nothing is registered for the identity", () => {
    const client = new QueryClient();
    expect(pendingTicketOverlayFor(client, "alpha", 1)).toBeNull();
  });

  it("returns the registered patch and clears it on unregister", () => {
    const client = new QueryClient();
    const unregister = registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done" },
    });

    expect(pendingTicketOverlayFor(client, "alpha", 1)).toEqual({
      kind: "patch",
      fields: { status: "done" },
    });
    expect(pendingTicketOverlayFor(client, "alpha", 2)).toBeNull();
    expect(pendingTicketOverlayFor(client, "beta", 1)).toBeNull();

    unregister();
    expect(pendingTicketOverlayFor(client, "alpha", 1)).toBeNull();
  });

  it("merges concurrent patches with later registrations winning per field", () => {
    const client = new QueryClient();
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "in_progress", title: "First" },
    });
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done" },
    });

    expect(pendingTicketOverlayFor(client, "alpha", 1)).toEqual({
      kind: "patch",
      fields: { status: "done", title: "First" },
    });
  });

  it("a pending remove dominates any patches", () => {
    const client = new QueryClient();
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done" },
    });
    const unregisterRemove = registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "remove",
    });

    expect(pendingTicketOverlayFor(client, "alpha", 1)).toEqual({
      kind: "remove",
    });

    unregisterRemove();
    expect(pendingTicketOverlayFor(client, "alpha", 1)).toEqual({
      kind: "patch",
      fields: { status: "done" },
    });
  });

  it("unregister removes only its own registration and is idempotent", () => {
    const client = new QueryClient();
    const unregisterFirst = registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { title: "First" },
    });
    registerPendingTicketOverlay(client, "alpha", 1, {
      kind: "patch",
      fields: { status: "done" },
    });

    unregisterFirst();
    unregisterFirst();
    expect(pendingTicketOverlayFor(client, "alpha", 1)).toEqual({
      kind: "patch",
      fields: { status: "done" },
    });
  });

  it("registrations are scoped per QueryClient", () => {
    const clientA = new QueryClient();
    const clientB = new QueryClient();
    registerPendingTicketOverlay(clientA, "alpha", 1, { kind: "remove" });

    expect(pendingTicketOverlayFor(clientB, "alpha", 1)).toBeNull();
  });
});

describe("applyOverlayToTicketChangedEvent", () => {
  it("returns the same event reference when there is no overlay", () => {
    const event = updatedEvent(item());
    expect(applyOverlayToTicketChangedEvent(event, null)).toBe(event);
  });

  it("a remove overlay nulls the lean item so the reducer only removes", () => {
    const event = updatedEvent(item());
    const effective = applyOverlayToTicketChangedEvent(event, {
      kind: "remove",
    });
    expect(effective).toEqual({ ...event, listItem: null });
  });

  it("a patch overlay reapplies the optimistic fields over the event's lean item", () => {
    const event = updatedEvent(
      item({ status: "not_started", title: "Renamed elsewhere" }),
    );
    const effective = applyOverlayToTicketChangedEvent(event, {
      kind: "patch",
      fields: { status: "done", updatedAt: "2026-07-09T00:00:00.000Z" },
    });
    expect(effective.listItem).toEqual({
      ...item({ title: "Renamed elsewhere" }),
      status: "done",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
  });

  it("leaves deleted events untouched — a genuine deletion beats any overlay", () => {
    const event: TicketChangedEvent = {
      type: "ticket-changed",
      change: "deleted",
      projectName: "alpha",
      ticketNumber: 1,
      listItem: null,
      attachmentIndexChanged: false,
    };
    expect(
      applyOverlayToTicketChangedEvent(event, {
        kind: "patch",
        fields: { status: "done" },
      }),
    ).toBe(event);
  });

  it("leaves events without a lean item untouched", () => {
    const event = updatedEvent(null);
    expect(
      applyOverlayToTicketChangedEvent(event, {
        kind: "patch",
        fields: { status: "done" },
      }),
    ).toBe(event);
  });
});
