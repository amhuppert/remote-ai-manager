import { describe, expect, it } from "vitest";
import {
  compareRelationshipViews,
  normalizeRelationshipDirection,
  otherTicketIdForRelationship,
  relationshipRoleForTicket,
  wouldCreateDirectedCycle,
  type CanonicalRelationshipDirection,
} from "./relationship-semantics";
import type { TicketRelationshipView } from "./schemas";

const ticket = { id: "ticket-b", projectName: "command-center" };
const target = { id: "ticket-a", projectName: "runtime" };

describe("relationship direction normalization", () => {
  it("canonicalizes symmetric related endpoints lexicographically", () => {
    expect(normalizeRelationshipDirection(ticket, target, "related")).toEqual({
      ok: true,
      relationship: {
        relationType: "related",
        sourceTicketId: "ticket-a",
        targetTicketId: "ticket-b",
      },
    });
  });

  it.each([
    ["depends_on", "ticket-b", "ticket-a"],
    ["blocks", "ticket-a", "ticket-b"],
    ["parent", "ticket-a", "ticket-b"],
    ["child", "ticket-b", "ticket-a"],
  ] as const)(
    "normalizes relative role %s into canonical storage direction",
    (role, sourceTicketId, targetTicketId) => {
      const localTarget = { ...target, projectName: ticket.projectName };
      expect(normalizeRelationshipDirection(ticket, localTarget, role)).toEqual(
        {
          ok: true,
          relationship: {
            relationType:
              role === "parent" || role === "child"
                ? "parent_child"
                : "depends_on",
            sourceTicketId,
            targetTicketId,
          },
        },
      );
    },
  );

  it("rejects self-links before direction normalization", () => {
    expect(
      normalizeRelationshipDirection(ticket, { ...ticket }, "depends_on"),
    ).toEqual({ ok: false, reason: "self_link" });
  });

  it("keeps hierarchy project-local while allowing cross-project dependencies", () => {
    expect(normalizeRelationshipDirection(ticket, target, "parent")).toEqual({
      ok: false,
      reason: "scope",
    });
    expect(
      normalizeRelationshipDirection(ticket, target, "depends_on"),
    ).toEqual({
      ok: true,
      relationship: {
        relationType: "depends_on",
        sourceTicketId: ticket.id,
        targetTicketId: target.id,
      },
    });
  });
});

describe("relative relationship views", () => {
  it.each([
    ["related", "source", "related", "target"],
    ["related", "target", "related", "source"],
    ["depends_on", "source", "depends_on", "target"],
    ["depends_on", "target", "blocks", "source"],
    ["parent_child", "source", "child", "target"],
    ["parent_child", "target", "parent", "source"],
  ] as const)(
    "projects %s from its %s endpoint as %s",
    (relationType, side, role, otherSide) => {
      const relationship: CanonicalRelationshipDirection = {
        relationType,
        sourceTicketId: "source",
        targetTicketId: "target",
      };
      expect(relationshipRoleForTicket(relationship, side)).toBe(role);
      expect(otherTicketIdForRelationship(relationship, side)).toBe(otherSide);
    },
  );

  it("returns null for a ticket outside the relationship", () => {
    const relationship: CanonicalRelationshipDirection = {
      relationType: "related",
      sourceTicketId: "source",
      targetTicketId: "target",
    };
    expect(relationshipRoleForTicket(relationship, "other")).toBeNull();
    expect(otherTicketIdForRelationship(relationship, "other")).toBeNull();
  });

  it("orders parent, child, depends-on, blocks, then related with newest rows first", () => {
    const makeView = (
      id: string,
      role: TicketRelationshipView["role"],
      updatedAt: string,
    ): TicketRelationshipView => ({
      id,
      role,
      otherTicket: {
        id: `other-${id}`,
        projectName: "command-center",
        number: 1,
        title: id,
        status: "not_started",
      },
      description: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
    });

    const sorted = [
      makeView("related", "related", "2026-01-05T00:00:00.000Z"),
      makeView("child-old", "child", "2026-01-01T00:00:00.000Z"),
      makeView("blocks", "blocks", "2026-01-04T00:00:00.000Z"),
      makeView("parent", "parent", "2026-01-01T00:00:00.000Z"),
      makeView("depends", "depends_on", "2026-01-03T00:00:00.000Z"),
      makeView("child-b", "child", "2026-01-02T00:00:00.000Z"),
      makeView("child-a", "child", "2026-01-02T00:00:00.000Z"),
    ].sort(compareRelationshipViews);

    expect(sorted.map(({ id }) => id)).toEqual([
      "parent",
      "child-b",
      "child-a",
      "child-old",
      "depends",
      "blocks",
      "related",
    ]);
  });
});

describe("directed cycle checks", () => {
  const edges = [
    { sourceTicketId: "a", targetTicketId: "b" },
    { sourceTicketId: "b", targetTicketId: "c" },
  ];

  it("rejects an edge whose target already reaches its source", () => {
    expect(
      wouldCreateDirectedCycle(edges, {
        sourceTicketId: "c",
        targetTicketId: "a",
      }),
    ).toBe(true);
  });

  it("accepts either acyclic direction and detects self cycles", () => {
    expect(
      wouldCreateDirectedCycle(edges, {
        sourceTicketId: "c",
        targetTicketId: "d",
      }),
    ).toBe(false);
    expect(
      wouldCreateDirectedCycle(edges, {
        sourceTicketId: "d",
        targetTicketId: "a",
      }),
    ).toBe(false);
    expect(
      wouldCreateDirectedCycle(edges, {
        sourceTicketId: "a",
        targetTicketId: "a",
      }),
    ).toBe(true);
  });
});
