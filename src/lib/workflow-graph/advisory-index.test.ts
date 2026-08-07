/**
 * The execution-level advisory index projection (R9, D9).
 *
 * Pure set arithmetic over one seat's advisories: which kinds outlive their
 * round, and what replacing a seat's slice means when the same seat reports
 * again inside one round.
 */

import { describe, expect, it } from "vitest";
import { indexAdvisoriesForSeat } from "@/lib/workflow-graph/advisory-index";
import type {
  GraphWorkflowAdvisoryIndexEntry,
  GraphWorkflowValidationAdvisory,
} from "@/lib/workflow-graph/schemas";

function advisory(
  overrides: Partial<GraphWorkflowValidationAdvisory> & {
    identity: GraphWorkflowValidationAdvisory["identity"];
  },
): GraphWorkflowValidationAdvisory {
  return {
    kind: "plan",
    title: "Split the migration into its own task",
    description: "The rollback is work in its own right.",
    deliveredAt: null,
    disposition: null,
    ...overrides,
  };
}

describe("execution-level advisory index (R9)", () => {
  it("indexes plan and out_of_scope advisories and leaves implementation ones out", () => {
    const next = indexAdvisoriesForSeat({
      index: [],
      contextId: "context-plan",
      roundSeq: 1,
      assignmentId: "security",
      advisories: [
        advisory({
          kind: "implementation",
          title: "Extract the helper",
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        }),
        advisory({
          kind: "plan",
          title: "Split the migration into its own task",
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
        }),
        advisory({
          kind: "out_of_scope",
          title: "The auth middleware has no rate limit",
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 3 },
        }),
      ],
    });

    // An implementation advisory is answered inside the round that raised it, so
    // indexing it would fill the long-lived list with settled business.
    expect(next).toEqual([
      {
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
        kind: "plan",
        title: "Split the migration into its own task",
        contextId: "context-plan",
      },
      {
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 3 },
        kind: "out_of_scope",
        title: "The auth middleware has no rate limit",
        contextId: "context-plan",
      },
    ]);
  });

  it("keeps entries from other seats, rounds, and contexts", () => {
    const existing: GraphWorkflowAdvisoryIndexEntry[] = [
      {
        identity: { roundSeq: 1, assignmentId: "general", ordinal: 1 },
        kind: "plan",
        title: "general's earlier observation",
        contextId: "context-plan",
      },
      {
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        kind: "out_of_scope",
        title: "another context's observation",
        contextId: "context-build",
      },
    ];

    const next = indexAdvisoriesForSeat({
      index: existing,
      contextId: "context-plan",
      roundSeq: 2,
      assignmentId: "security",
      advisories: [
        advisory({
          kind: "plan",
          title: "round 2's observation",
          identity: { roundSeq: 2, assignmentId: "security", ordinal: 1 },
        }),
      ],
    });

    expect(next.map((entry) => entry.title)).toEqual([
      "general's earlier observation",
      "another context's observation",
      "round 2's observation",
    ]);
  });

  it("replaces the seat's own slice when it reports again in the same round", () => {
    const first = indexAdvisoriesForSeat({
      index: [],
      contextId: "context-plan",
      roundSeq: 1,
      assignmentId: "security",
      advisories: [
        advisory({
          title: "the first attempt's observation",
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        }),
        advisory({
          title: "an observation the retry drops",
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
        }),
      ],
    });

    // A lane re-dispatched after an infrastructure failure re-stamps ordinals
    // 1..n over the same identities, so an index that appended would show one
    // round's seat twice and keep an advisory the seat no longer reports.
    const second = indexAdvisoriesForSeat({
      index: first,
      contextId: "context-plan",
      roundSeq: 1,
      assignmentId: "security",
      advisories: [
        advisory({
          title: "the retry's observation",
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        }),
      ],
    });

    expect(second).toEqual([
      {
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        kind: "plan",
        title: "the retry's observation",
        contextId: "context-plan",
      },
    ]);
  });

  it("clears the seat's slice when a re-report raises nothing indexable", () => {
    const first = indexAdvisoriesForSeat({
      index: [],
      contextId: "context-plan",
      roundSeq: 1,
      assignmentId: "security",
      advisories: [
        advisory({
          identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        }),
      ],
    });

    expect(
      indexAdvisoriesForSeat({
        index: first,
        contextId: "context-plan",
        roundSeq: 1,
        assignmentId: "security",
        advisories: [],
      }),
    ).toEqual([]);
  });
});
