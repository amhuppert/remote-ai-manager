import { describe, expect, it } from "vitest";
import { createWorkflowDefinition } from "./test-fixtures";
import type {
  WorkflowLockedRegion,
  WorkflowSemanticDefinition,
} from "./definition-schemas";
import { mergeServerOwnedRegions } from "./locked-regions";

const PROVENANCE_LOCK: WorkflowLockedRegion = {
  paths: ["/origin", "/approvalRequired"],
  sourceUri:
    "spec-plan://spec-1/revisions/rev-1/attempts/attempt-1/candidates/wf-1",
  reason:
    "The signed native SDD candidate owns provenance and approval policy.",
  instruction:
    "Before launch, reopen and re-propose the plan; after launch, replace the execution.",
};

function storedDraft() {
  return createWorkflowDefinition({
    origin: { sourceUri: PROVENANCE_LOCK.sourceUri },
    approvalRequired: false,
    lockedRegions: [PROVENANCE_LOCK],
  });
}

/** What a planner authors: the definition with no server-owned key at all. */
function bareDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  const {
    origin: _origin,
    approvalRequired: _approvalRequired,
    lockedRegions: _lockedRegions,
    ...bare
  } = createWorkflowDefinition(overrides);
  return bare;
}

describe("mergeServerOwnedRegions", () => {
  it("fills absent /origin, /approvalRequired and /lockedRegions from the previous record", () => {
    const previous = storedDraft();
    const bare = bareDefinition();

    const merged = mergeServerOwnedRegions(previous, bare);

    expect(merged.origin).toEqual(previous.origin);
    expect(merged.approvalRequired).toBe(previous.approvalRequired);
    expect(merged.lockedRegions).toEqual(previous.lockedRegions);
  });

  it("leaves a present value alone even when it differs from the previous record", () => {
    const previous = storedDraft();
    const next = createWorkflowDefinition({
      origin: { sourceUri: "spec-plan://elsewhere" },
      approvalRequired: true,
      lockedRegions: [],
    });

    const merged = mergeServerOwnedRegions(previous, next);

    expect(merged.origin).toEqual({ sourceUri: "spec-plan://elsewhere" });
    expect(merged.approvalRequired).toBe(true);
    expect(merged.lockedRegions).toEqual([]);
  });

  it("adds no key the previous record lacks, so an unmanaged replace stays byte-identical", () => {
    const previous = bareDefinition();
    const next = bareDefinition();

    const merged = mergeServerOwnedRegions(previous, next);

    // An explicitly-undefined key would serialize as `null` and change the
    // stored bytes; the merge must leave the key out entirely.
    expect(Object.keys(merged)).not.toContain("origin");
    expect(Object.keys(merged)).not.toContain("approvalRequired");
    expect(Object.keys(merged)).not.toContain("lockedRegions");
    expect(merged).toEqual(next);
  });

  it("carries every authored field of the submitted plan through untouched", () => {
    const previous = storedDraft();
    const bare = bareDefinition({
      charter: {
        ...createWorkflowDefinition().charter,
        mission: "Ship the merge",
      },
    });

    const merged = mergeServerOwnedRegions(previous, bare);

    expect(merged.charter.mission).toBe("Ship the merge");
    expect(merged.executionContexts).toEqual(bare.executionContexts);
    expect(merged.tasks).toEqual(bare.tasks);
    expect(merged.edges).toEqual(bare.edges);
  });

  it("does not mutate either input", () => {
    const previous = storedDraft();
    const previousSnapshot = structuredClone(previous);
    const bare = bareDefinition();
    const bareSnapshot = structuredClone(bare);

    mergeServerOwnedRegions(previous, bare);

    expect(previous).toEqual(previousSnapshot);
    expect(bare).toEqual(bareSnapshot);
  });
});
