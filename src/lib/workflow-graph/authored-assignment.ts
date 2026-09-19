import type { AgentAssignment } from "./config-schemas";

/**
 * Drop the execution-seeded profile snapshot, leaving the authored assignment.
 *
 * The panel reads a WORKING definition, whose assignments carry the bytes the
 * run was seeded with, but it writes an `update-context` op, whose schema is
 * reference-bearing and strict. Echoing the snapshot back would be refused at
 * accept time — an edit names a profile, and the live-edit boundary supplies
 * its snapshot, preserving the frozen bytes of unchanged started assignments.
 */
export function toAuthoredAssignment<T extends AgentAssignment>(
  assignment: T,
): Omit<T, "profileSnapshot"> {
  const authored = { ...assignment };
  if ("profileSnapshot" in authored) delete authored.profileSnapshot;
  return authored;
}
