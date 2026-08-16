import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { SpecSseEvent } from "@/lib/api/sse-events";
import {
  registerPendingSpecOverlay,
  releasePendingSpecOverlay,
} from "./pending-overlay";
import {
  applySpecSseEvent,
  reduceSpecSseEvent,
  replayDeferredSpecEvents,
  specSseCacheKeys,
} from "./sse-reducer";

const common = {
  projectPath: "/repos/command-center",
  specId: "spec-1",
  specSlug: "native-sdd",
  occurredAt: "2026-07-18T14:00:00.000Z",
};

const events: SpecSseEvent[] = [
  {
    type: "spec-changed",
    kind: "content-changed",
    ...common,
    revisionId: "revision-1",
    elementIds: ["requirement-1"],
  },
  {
    type: "spec-revision-changed",
    kind: "proposed",
    ...common,
    revisionId: "revision-1",
    elementIds: ["requirement-1"],
  },
  {
    type: "spec-approval-changed",
    kind: "approval-granted",
    ...common,
    revisionId: "revision-1",
    subjectId: "requirement-1",
  },
  {
    type: "spec-execution-changed",
    kind: "running",
    ...common,
    revisionId: "revision-1",
    executionId: "execution-1",
  },
  {
    type: "spec-evidence-changed",
    kind: "proof-verdict-recorded",
    ...common,
    revisionId: "revision-1",
    criterionId: "criterion-1",
    executionId: "execution-1",
  },
  {
    type: "spec-attention-changed",
    kind: "needs-you-added",
    ...common,
    attentionId: "attention-1",
    active: true,
  },
  {
    type: "spec-delivery-plan-changed",
    kind: "reaffirmed",
    ...common,
    attemptId: "attempt-1",
    draftRevision: 3,
    candidateId: null,
  },
];

describe("reduceSpecSseEvent", () => {
  it.each([
    ["spec-changed", ["content", "lint", "summary"]],
    ["spec-revision-changed", ["approval", "content", "revision", "summary"]],
    ["spec-approval-changed", ["approval", "attention", "summary"]],
    ["spec-execution-changed", ["attention", "execution", "summary"]],
    ["spec-evidence-changed", ["evidence", "execution", "summary"]],
    ["spec-attention-changed", ["attention", "summary"]],
    ["spec-delivery-plan-changed", ["deliveryPlan", "summary"]],
  ] as const)("reduces %s to its affected cache facets", (type, facets) => {
    const event = events.find((candidate) => candidate.type === type);
    if (!event) throw new Error(`missing fixture for ${type}`);

    expect(reduceSpecSseEvent(event, null)).toEqual({
      clearApprovalBanner: type === "spec-approval-changed",
      deferInvalidation: false,
      facets,
    });
  });

  it("marks an event deferred when a pending overlay owns its event type", () => {
    expect(
      reduceSpecSseEvent(events[0]!, {
        eventTypes: ["spec-changed"],
      }),
    ).toEqual({
      clearApprovalBanner: false,
      deferInvalidation: true,
      facets: ["content", "lint", "summary"],
    });
  });
});

describe("applySpecSseEvent", () => {
  it.each(events)(
    "invalidates live surfaces for $type without polling",
    (event) => {
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");

      applySpecSseEvent(client, event);

      expect(invalidate).toHaveBeenCalledWith({
        queryKey: specSseCacheKeys.lists(),
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: specSseCacheKeys.summary(event.projectPath, event.specSlug),
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: specSseCacheKeys.detail(event.projectPath, event.specSlug),
      });
    },
  );

  it("synchronously clears a stale approval banner from the affected spec cache", () => {
    const client = new QueryClient();
    const detailKey = specSseCacheKeys.detail(
      common.projectPath,
      common.specSlug,
    );
    client.setQueryData(detailKey, {
      spec: { id: common.specId, slug: common.specSlug },
      approvalBanner: {
        subjectId: "requirement-1",
        message: "Approval required",
      },
    });

    applySpecSseEvent(client, events[2]!);

    expect(client.getQueryData(detailKey)).toEqual({
      spec: { id: common.specId, slug: common.specSlug },
      approvalBanner: null,
    });
  });

  it("reconciles a deferred server event after its optimistic overlay settles", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const registration = registerPendingSpecOverlay(client, common.specId, [
      "spec-changed",
    ]);

    applySpecSseEvent(client, events[0]!);
    expect(invalidate).not.toHaveBeenCalled();

    const deferred = releasePendingSpecOverlay(client, registration);
    replayDeferredSpecEvents(client, deferred);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: specSseCacheKeys.detail(common.projectPath, common.specSlug),
    });
  });
});
