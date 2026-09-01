import { describe, expect, it, vi } from "vitest";
import {
  createLegacyRelatedTicketAdapter,
  type LegacyRelatedTicketAdapterDeps,
} from "./legacy-related-ticket-adapter";
import type { TicketRelationshipService } from "./relationship-service";
import type {
  TicketDetail,
  TicketRelationshipView,
  TicketResult,
} from "./schemas";

const anchor: TicketDetail = {
  id: "ticket-anchor",
  projectPath: "/repos/alpha",
  projectName: "alpha",
  number: 1,
  title: "Anchor",
  description: "",
  workType: "feature",
  status: "in_progress",
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:01:00.000Z",
  attachments: [],
  sessions: [],
  relationships: [],
  statusUpdates: { total: 0, recent: [] },
};

const target: TicketDetail = {
  ...anchor,
  id: "ticket-target",
  projectPath: "/repos/beta",
  projectName: "beta",
  number: 2,
  title: "Target",
};

const relationship: TicketRelationshipView = {
  id: "relationship-canonical",
  role: "related",
  otherTicket: {
    id: target.id,
    projectName: target.projectName,
    number: target.number,
    title: target.title,
    status: target.status,
  },
  description: "",
  createdAt: "2026-08-31T10:02:00.000Z",
  updatedAt: "2026-08-31T10:03:00.000Z",
};

function success<T>(value: T): TicketResult<T> {
  return { ok: true, value };
}

function makeHarness() {
  const getRelationship = vi.fn<TicketRelationshipService["get"]>(async () =>
    success(relationship),
  );
  const addRelationship = vi.fn<TicketRelationshipService["add"]>(async () =>
    success({ relationship, tickets: [anchor, target] }),
  );
  const updateRelationship = vi.fn<TicketRelationshipService["update"]>(
    async (input) =>
      success({
        relationship: { ...relationship, description: input.description },
        tickets: [anchor, target],
      }),
  );
  const removeRelationship = vi.fn<TicketRelationshipService["remove"]>(
    async () =>
      success({
        relationshipId: relationship.id,
        tickets: [{ ...anchor, updatedAt: "2026-08-31T10:04:00.000Z" }, target],
      }),
  );
  const resolveLegacyRelationship = vi.fn<
    LegacyRelatedTicketAdapterDeps["repo"]["resolveLegacyRelationship"]
  >(async () => relationship);
  const deps: LegacyRelatedTicketAdapterDeps = {
    repo: { resolveLegacyRelationship },
    ticketService: {
      async get(identity) {
        if (identity.projectName === anchor.projectName) return success(anchor);
        if (identity.projectName === target.projectName) return success(target);
        return {
          ok: false,
          error: { code: "ticket_not_found", identifier: "missing#1" },
        };
      },
    },
    relationshipService: {
      list: vi.fn(),
      get: getRelationship,
      add: addRelationship,
      update: updateRelationship,
      remove: removeRelationship,
    },
  };
  return {
    adapter: createLegacyRelatedTicketAdapter(deps),
    getRelationship,
    addRelationship,
    updateRelationship,
    removeRelationship,
    resolveLegacyRelationship,
  };
}

describe("legacy related-ticket attachment adapter", () => {
  it("maps legacy add onto a related relationship and synthesizes the old non-empty projection", async () => {
    const harness = makeHarness();

    const result = await harness.adapter.add({
      projectName: "alpha",
      number: 1,
      description: "",
      target: { projectName: "beta", number: 2 },
    });

    expect(harness.addRelationship).toHaveBeenCalledWith({
      projectName: "alpha",
      number: 1,
      target: { projectName: "beta", number: 2 },
      role: "related",
      description: "",
    });
    expect(result).toEqual(
      success({
        id: relationship.id,
        ticketId: anchor.id,
        description: "Related ticket",
        payload: {
          kind: "related_ticket",
          ticketId: target.id,
          identifierSnapshot: "beta#2",
        },
        createdAt: relationship.createdAt,
        updatedAt: relationship.updatedAt,
      }),
    );
  });

  it("resolves every migrated alias while preserving the requested stable handle", async () => {
    const harness = makeHarness();
    harness.getRelationship.mockResolvedValue({
      ok: false,
      error: {
        code: "relationship_not_found",
        details: { identifier: "alpha#1", relationshipId: "legacy-id" },
      },
    });

    const result = await harness.adapter.resolve({
      projectName: "alpha",
      number: 1,
      attachmentId: "legacy-id",
    });

    expect(harness.resolveLegacyRelationship).toHaveBeenCalledWith(
      anchor.id,
      "legacy-id",
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "related_ticket",
        available: true,
        attachment: {
          id: "legacy-id",
          ticketId: anchor.id,
          payload: { ticketId: target.id, identifierSnapshot: "beta#2" },
        },
        ticket: { id: target.id },
        followCommand: "cctl ticket get 'beta#2'",
      },
    });
  });

  it("updates rationale through the canonical relationship id but returns the legacy handle", async () => {
    const harness = makeHarness();
    harness.getRelationship.mockResolvedValue({
      ok: false,
      error: {
        code: "relationship_not_found",
        details: { identifier: "alpha#1", relationshipId: "legacy-id" },
      },
    });

    const result = await harness.adapter.update({
      projectName: "alpha",
      number: 1,
      attachmentId: "legacy-id",
      description: "Revised rationale",
    });

    expect(harness.updateRelationship).toHaveBeenCalledWith({
      projectName: "alpha",
      number: 1,
      relationshipId: relationship.id,
      description: "Revised rationale",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { id: "legacy-id", description: "Revised rationale" },
    });
  });

  it("removes the canonical relationship and reports the requested legacy id plus committed anchor revision", async () => {
    const harness = makeHarness();

    const result = await harness.adapter.remove({
      projectName: "alpha",
      number: 1,
      attachmentId: relationship.id,
    });

    expect(harness.removeRelationship).toHaveBeenCalledWith({
      projectName: "alpha",
      number: 1,
      relationshipId: relationship.id,
    });
    expect(result).toEqual(
      success({
        attachmentId: relationship.id,
        ticketId: anchor.id,
        kind: "related_ticket",
        ticketUpdatedAt: "2026-08-31T10:04:00.000Z",
      }),
    );
  });

  it("preserves the attachment-not-found contract when neither canonical nor alias lookup succeeds", async () => {
    const harness = makeHarness();
    harness.getRelationship.mockResolvedValue({
      ok: false,
      error: {
        code: "relationship_not_found",
        details: { identifier: "alpha#1", relationshipId: "missing" },
      },
    });
    harness.resolveLegacyRelationship.mockResolvedValue(null);

    await expect(
      harness.adapter.isRelationshipHandle({
        projectName: "alpha",
        number: 1,
        attachmentId: "missing",
      }),
    ).resolves.toEqual(success(false));
  });
});
