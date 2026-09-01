import type {
  TicketRelationshipRole,
  TicketRelationshipType,
  TicketRelationshipView,
} from "./schemas";

export interface RelationshipEndpoint {
  id: string;
  projectName: string;
}

export interface CanonicalRelationshipDirection {
  relationType: TicketRelationshipType;
  sourceTicketId: string;
  targetTicketId: string;
}

export type NormalizeRelationshipResult =
  | { ok: true; relationship: CanonicalRelationshipDirection }
  | { ok: false; reason: "self_link" | "scope" };

export interface DirectedRelationshipEdge {
  sourceTicketId: string;
  targetTicketId: string;
}

export function normalizeRelationshipDirection(
  ticket: RelationshipEndpoint,
  target: RelationshipEndpoint,
  role: TicketRelationshipRole,
): NormalizeRelationshipResult {
  if (ticket.id === target.id) {
    return { ok: false, reason: "self_link" };
  }

  if (
    (role === "parent" || role === "child") &&
    ticket.projectName !== target.projectName
  ) {
    return { ok: false, reason: "scope" };
  }

  if (role === "related") {
    const [sourceTicketId, targetTicketId] = [ticket.id, target.id].sort();
    return {
      ok: true,
      relationship: {
        relationType: "related",
        sourceTicketId: sourceTicketId!,
        targetTicketId: targetTicketId!,
      },
    };
  }

  if (role === "depends_on") {
    return {
      ok: true,
      relationship: {
        relationType: "depends_on",
        sourceTicketId: ticket.id,
        targetTicketId: target.id,
      },
    };
  }

  if (role === "blocks") {
    return {
      ok: true,
      relationship: {
        relationType: "depends_on",
        sourceTicketId: target.id,
        targetTicketId: ticket.id,
      },
    };
  }

  if (role === "parent") {
    return {
      ok: true,
      relationship: {
        relationType: "parent_child",
        sourceTicketId: target.id,
        targetTicketId: ticket.id,
      },
    };
  }

  return {
    ok: true,
    relationship: {
      relationType: "parent_child",
      sourceTicketId: ticket.id,
      targetTicketId: target.id,
    },
  };
}

export function relationshipRoleForTicket(
  relationship: CanonicalRelationshipDirection,
  ticketId: string,
): TicketRelationshipRole | null {
  const isSource = relationship.sourceTicketId === ticketId;
  const isTarget = relationship.targetTicketId === ticketId;
  if (!isSource && !isTarget) return null;

  if (relationship.relationType === "related") return "related";
  if (relationship.relationType === "depends_on") {
    return isSource ? "depends_on" : "blocks";
  }
  return isSource ? "child" : "parent";
}

export function otherTicketIdForRelationship(
  relationship: CanonicalRelationshipDirection,
  ticketId: string,
): string | null {
  if (relationship.sourceTicketId === ticketId) {
    return relationship.targetTicketId;
  }
  if (relationship.targetTicketId === ticketId) {
    return relationship.sourceTicketId;
  }
  return null;
}

const ROLE_ORDER: Record<TicketRelationshipRole, number> = {
  parent: 0,
  child: 1,
  depends_on: 2,
  blocks: 3,
  related: 4,
};

export function compareRelationshipViews(
  left: TicketRelationshipView,
  right: TicketRelationshipView,
): number {
  const roleDifference = ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
  if (roleDifference !== 0) return roleDifference;

  const updatedDifference = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDifference !== 0) return updatedDifference;
  return right.id.localeCompare(left.id);
}

export function wouldCreateDirectedCycle(
  edges: readonly DirectedRelationshipEdge[],
  proposed: DirectedRelationshipEdge,
): boolean {
  if (proposed.sourceTicketId === proposed.targetTicketId) return true;

  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = targetsBySource.get(edge.sourceTicketId) ?? [];
    targets.push(edge.targetTicketId);
    targetsBySource.set(edge.sourceTicketId, targets);
  }

  const pending = [proposed.targetTicketId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === proposed.sourceTicketId) return true;
    visited.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }

  return false;
}
