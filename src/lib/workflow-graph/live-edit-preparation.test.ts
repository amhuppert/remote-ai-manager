import { describe, expect, it } from "vitest";
import { AgentProfileNotResolvableError } from "@/lib/agent-profiles/library-service";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { AgentAssignment } from "./config-schemas";
import {
  collectLiveEditAssignments,
  prepareLiveEditAssignmentSnapshots,
} from "./live-edit-preparation";
import {
  makeImplementerAssignment,
  makeProfileSnapshot,
  makeValidatorAssignment,
} from "./test-fixtures";

const AGENT = {
  backend: "claude",
  model: "opus",
  reasoningEffort: "medium",
} as const;

function composeFrom(
  resolvable: ReadonlySet<string>,
  seen: AgentAssignment[] = [],
): (assignment: AgentAssignment) => Promise<AgentProfileSnapshot> {
  return async (assignment) => {
    seen.push(assignment);
    if (!resolvable.has(assignment.profile.id)) {
      throw new AgentProfileNotResolvableError(assignment.profile);
    }
    return makeProfileSnapshot({
      tier: assignment.profile.tier,
      id: assignment.profile.id,
      // The focus is part of the composed bytes, so it must be part of the key.
      resolvedInstructionHash: `sha256:${assignment.profile.id}:${assignment.focus ?? ""}`,
    });
  };
}

describe("collectLiveEditAssignments", () => {
  it("locates every assignment an op batch introduces, cohort members included", () => {
    const operations: WorkflowLiveEditOperation[] = [
      { type: "remove-task", taskId: "task-1" },
      {
        type: "update-context",
        contextId: "context-implement",
        implementer: makeImplementerAssignment(AGENT),
        contextValidator: {
          enabled: true,
          assignments: [
            makeValidatorAssignment({ id: "security" }),
            makeValidatorAssignment({ id: "perf" }),
          ],
        },
      },
      {
        type: "add-context",
        id: "context-new",
        title: "New",
        acceptanceCriteria: "Criteria",
        contextValidator: {
          enabled: false,
          assignments: [makeValidatorAssignment({ id: "dormant" })],
        },
      },
    ];

    const sites = collectLiveEditAssignments(operations);

    expect(
      sites.map((site) => ({
        operationIndex: site.operationIndex,
        contextId: site.contextId,
        field: site.field,
        id: site.assignment.id,
      })),
    ).toEqual([
      {
        operationIndex: 1,
        contextId: "context-implement",
        field: "implementer",
        id: "implementer",
      },
      {
        operationIndex: 1,
        contextId: "context-implement",
        field: "contextValidator.assignments[0]",
        id: "security",
      },
      {
        operationIndex: 1,
        contextId: "context-implement",
        field: "contextValidator.assignments[1]",
        id: "perf",
      },
      {
        operationIndex: 2,
        contextId: "context-new",
        field: "contextValidator.assignments[0]",
        id: "dormant",
      },
    ]);
  });

  it("finds nothing in a batch that carries no assignment", () => {
    expect(
      collectLiveEditAssignments([
        { type: "remove-task", taskId: "task-1" },
        { type: "add-edge", sourceContextId: "a", targetContextId: "b" },
      ]),
    ).toEqual([]);
  });
});

describe("prepareLiveEditAssignmentSnapshots", () => {
  it("composes and hashes every changed ref before the mutation, keyed by ref AND focus", async () => {
    const seen: AgentAssignment[] = [];
    const result = await prepareLiveEditAssignmentSnapshots({
      operations: [
        {
          type: "update-context",
          contextId: "context-implement",
          contextValidator: {
            enabled: true,
            assignments: [
              makeValidatorAssignment({ id: "a", focus: "Data races" }),
              makeValidatorAssignment({ id: "b", focus: "Data races" }),
              makeValidatorAssignment({ id: "c" }),
            ],
          },
        },
      ],
      composeSnapshot: composeFrom(new Set(["general-reviewer"]), seen),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Two distinct (ref, focus) pairs across three assignments: the focused
    // pair composes once, the unfocused one composes separately.
    expect(seen).toHaveLength(2);
    expect(
      result.prepared.snapshotFor(
        makeValidatorAssignment({ id: "a", focus: "Data races" }),
      ).resolvedInstructionHash,
    ).toBe("sha256:general-reviewer:Data races");
    expect(
      result.prepared.snapshotFor(makeValidatorAssignment({ id: "c" }))
        .resolvedInstructionHash,
    ).toBe("sha256:general-reviewer:");
  });

  it("rejects a dangling ref at preparation with a located error, and composes nothing further", async () => {
    const result = await prepareLiveEditAssignmentSnapshots({
      operations: [
        { type: "remove-task", taskId: "task-1" },
        {
          type: "update-context",
          contextId: "context-implement",
          contextValidator: {
            enabled: true,
            assignments: [
              makeValidatorAssignment({ id: "ok" }),
              makeValidatorAssignment({
                id: "gone",
                profile: { tier: "project", id: "deleted-reviewer" },
              }),
            ],
          },
        },
      ],
      composeSnapshot: composeFrom(new Set(["general-reviewer"])),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      {
        code: "profile-unresolvable",
        message: expect.stringContaining("project:deleted-reviewer"),
        contextId: "context-implement",
        operationIndex: 1,
        field: "contextValidator.assignments[1]",
      },
    ]);
  });

  it("reports every dangling ref in the batch, not just the first", async () => {
    const result = await prepareLiveEditAssignmentSnapshots({
      operations: [
        {
          type: "update-context",
          contextId: "context-implement",
          implementer: makeImplementerAssignment(AGENT, {
            profile: { tier: "project", id: "missing-implementer" },
          }),
          contextValidator: {
            enabled: true,
            assignments: [
              makeValidatorAssignment({
                id: "gone",
                profile: { tier: "project", id: "missing-reviewer" },
              }),
            ],
          },
        },
      ],
      composeSnapshot: composeFrom(new Set()),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field)).toEqual([
      "implementer",
      "contextValidator.assignments[0]",
    ]);
  });

  it("hands back a lookup that never consults the library — an unprepared assignment throws", async () => {
    const result = await prepareLiveEditAssignmentSnapshots({
      operations: [],
      composeSnapshot: composeFrom(new Set(["general-reviewer"])),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() =>
      result.prepared.snapshotFor(makeValidatorAssignment({ id: "surprise" })),
    ).toThrow(/not prepared/i);
  });
});
