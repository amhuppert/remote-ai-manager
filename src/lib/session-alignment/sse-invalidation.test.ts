import { describe, expect, it } from "vitest";

import { alignmentKeys } from "./query-keys";
import { computeAlignmentInvalidations } from "./sse-invalidation";
import type { SessionAlignmentUpdatedEvent } from "./schemas";

describe("computeAlignmentInvalidations", () => {
  it("invalidates the whole alignment subtree for an alignment-updated event", () => {
    const event: SessionAlignmentUpdatedEvent = {
      type: "session-alignment-updated",
      projectPath: "/path/to/proj",
      sessionName: "sess",
      activeVersion: 3,
      hasDraft: false,
      pendingProposalBatchIds: [],
    };

    expect(computeAlignmentInvalidations(event)).toEqual([
      { queryKey: alignmentKeys.all },
    ]);
  });
});
