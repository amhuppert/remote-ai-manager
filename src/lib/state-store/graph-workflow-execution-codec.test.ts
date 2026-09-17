import { describe, expect, it } from "vitest";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { decodeGraphWorkflowExecution } from "./graph-workflow-execution-codec";

/**
 * A stored candidate as the repository hands it to the codec: the merged
 * definition ⊕ runtime tiers, still raw. Every case below edits this shape the
 * way a row written by an older build actually looks on disk — a key ABSENT,
 * not present-and-null.
 */
function storedCandidate(
  edit: (candidate: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const built = buildMaximalGraphWorkflowExecution();
  if (typeof built !== "object" || built === null) {
    throw new Error("maximal fixture must be an object");
  }
  const candidate = JSON.parse(JSON.stringify(built)) as Record<
    string,
    unknown
  >;
  edit(candidate);
  return candidate;
}

function decodeOrThrow(candidate: unknown) {
  const decoded = decodeGraphWorkflowExecution(candidate);
  if (!decoded.ok) {
    throw new Error(`decode failed: ${JSON.stringify(decoded.issues)}`);
  }
  if (decoded.value === null) throw new Error("decode produced null");
  return decoded.value;
}

describe("decodeGraphWorkflowExecution origin floor", () => {
  // D2: a pre-D7 row carries no origin at all. Flooring it from the seed
  // fields at the decode boundary is what lets every consumer branch on origin
  // unconditionally instead of re-deriving provenance per call site.
  it("floors a pre-D7 row to a template origin derived from its seed fields", () => {
    const decoded = decodeOrThrow(
      storedCandidate((candidate) => {
        delete candidate.origin;
        candidate.seedDefinitionId = "seed-legacy";
        candidate.seedDefinitionRevision = 4;
        candidate.launchedTier = "global";
      }),
    );

    expect(decoded.origin).toEqual({
      kind: "template",
      definitionId: "seed-legacy",
      definitionRevision: 4,
      tier: "global",
    });
  });

  it("floors a row written before launchedTier existed to the project tier", () => {
    const decoded = decodeOrThrow(
      storedCandidate((candidate) => {
        delete candidate.origin;
        delete candidate.launchedTier;
        candidate.seedDefinitionId = "seed-older";
        candidate.seedDefinitionRevision = 1;
      }),
    );

    expect(decoded.origin).toEqual({
      kind: "template",
      definitionId: "seed-older",
      definitionRevision: 1,
      tier: "project",
    });
  });

  it("leaves a stored template origin alone rather than re-deriving it", () => {
    // The stored origin and the seed fields deliberately disagree: a floor that
    // ran unconditionally would overwrite the recorded provenance with the
    // projection columns it was derived from.
    const decoded = decodeOrThrow(
      storedCandidate((candidate) => {
        candidate.seedDefinitionId = "seed-maximal";
        candidate.seedDefinitionRevision = 3;
        candidate.origin = {
          kind: "template",
          definitionId: "def-recorded",
          definitionRevision: 9,
          tier: "project",
        };
      }),
    );

    expect(decoded.origin).toEqual({
      kind: "template",
      definitionId: "def-recorded",
      definitionRevision: 9,
      tier: "project",
    });
  });

  it("decodes a one-off row as one_off without a saved definition identity", () => {
    const decoded = decodeOrThrow(
      storedCandidate((candidate) => {
        Object.assign(candidate, {
          seedDefinitionId: null,
          seedDefinitionRevision: null,
          launchedTier: "project",
        });
        candidate.origin = {
          kind: "one_off",
          planName: "Repair the flaky suite",
        };
      }),
    );

    expect(decoded.origin).toEqual({
      kind: "one_off",
      planName: "Repair the flaky suite",
    });
    expect(decoded.seedDefinitionId).toBeNull();
    expect(decoded.seedDefinitionRevision).toBeNull();
    expect(decoded.launchedTier).toBe("project");
  });

  it("decodes a spec-delivery row as spec_delivery without a saved definition identity", () => {
    const decoded = decodeOrThrow(
      storedCandidate((candidate) => {
        Object.assign(candidate, {
          seedDefinitionId: null,
          seedDefinitionRevision: null,
          launchedTier: "project",
        });
        candidate.origin = {
          kind: "spec_delivery",
          specSlug: "conversation-compaction",
          candidateId: "cand-42",
        };
      }),
    );

    expect(decoded.origin).toEqual({
      kind: "spec_delivery",
      specSlug: "conversation-compaction",
      candidateId: "cand-42",
    });
    expect(decoded.seedDefinitionId).toBeNull();
    expect(decoded.seedDefinitionRevision).toBeNull();
    expect(decoded.launchedTier).toBe("project");
  });

  // D2 authorizes flooring exactly one shape — a pre-D7 row where `origin` is
  // ABSENT. A stored `null` is not that row: JSON has no `undefined`, so a null
  // origin can only have been written by a post-D7 build that failed to record
  // provenance. Flooring it would silently relabel a corrupt row as a template
  // run, and on a one-off row the seed sentinel would supply a definition id
  // that matches nothing. Refusing it keeps the row's own repair visible.
  it("refuses a null origin instead of flooring it as a legacy row", () => {
    const decoded = decodeGraphWorkflowExecution(
      storedCandidate((candidate) => {
        candidate.origin = null;
      }),
    );

    expect(decoded.ok).toBe(false);
  });

  it("refuses a null origin on a one-off row rather than reading its sentinel as provenance", () => {
    const decoded = decodeGraphWorkflowExecution(
      storedCandidate((candidate) => {
        Object.assign(candidate, {
          seedDefinitionId: null,
          seedDefinitionRevision: null,
          launchedTier: "project",
        });
        candidate.origin = null;
      }),
    );

    expect(decoded.ok).toBe(false);
  });

  it("floors a pre-D7 row's launch document, abandonment, and dirty pin", () => {
    const decoded = decodeOrThrow(
      storedCandidate((candidate) => {
        delete candidate.origin;
        delete candidate.launchDocument;
        delete candidate.abandonment;
        delete candidate.liveSessionReadOnlyPinned;
      }),
    );

    expect(decoded.launchDocument).toBeNull();
    expect(decoded.abandonment).toBeNull();
    expect(decoded.liveSessionReadOnlyPinned).toBe(false);
  });

  it("decodes the recorded launch document, abandonment, and pin unchanged", () => {
    const candidate = storedCandidate();
    const decoded = decodeOrThrow(candidate);

    expect(decoded.launchDocument).toEqual(candidate.launchDocument);
    expect(decoded.abandonment).toEqual(candidate.abandonment);
    expect(decoded.liveSessionReadOnlyPinned).toBe(true);
  });
});
