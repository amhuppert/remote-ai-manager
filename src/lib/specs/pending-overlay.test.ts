import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { SpecChangedEvent } from "@/lib/api/sse-events";
import {
  pendingSpecOverlayFor,
  registerPendingSpecOverlay,
  releasePendingSpecOverlay,
  rememberDeferredSpecEvent,
} from "./pending-overlay";

const event: SpecChangedEvent = {
  type: "spec-changed",
  kind: "content-changed",
  projectPath: "/repos/command-center",
  specId: "spec-1",
  specSlug: "native-sdd",
  occurredAt: "2026-07-18T14:00:00.000Z",
  revisionId: "revision-1",
  elementIds: ["requirement-1"],
};

describe("pending spec overlays", () => {
  it("combines event types from concurrent registrations", () => {
    const client = new QueryClient();
    registerPendingSpecOverlay(client, "spec-1", ["spec-changed"]);
    registerPendingSpecOverlay(client, "spec-1", ["spec-approval-changed"]);

    expect(pendingSpecOverlayFor(client, "spec-1")).toEqual({
      eventTypes: ["spec-approval-changed", "spec-changed"],
    });
  });

  it("releases only deferred events no longer protected by another overlay", () => {
    const client = new QueryClient();
    const first = registerPendingSpecOverlay(client, "spec-1", [
      "spec-changed",
    ]);
    const second = registerPendingSpecOverlay(client, "spec-1", [
      "spec-changed",
    ]);
    rememberDeferredSpecEvent(client, event);

    expect(releasePendingSpecOverlay(client, first)).toEqual([]);
    expect(releasePendingSpecOverlay(client, second)).toEqual([event]);
    expect(pendingSpecOverlayFor(client, "spec-1")).toBeNull();
  });

  it("keeps only the latest deferred event for an event type", () => {
    const client = new QueryClient();
    const registration = registerPendingSpecOverlay(client, "spec-1", [
      "spec-changed",
    ]);
    rememberDeferredSpecEvent(client, event);
    const latest = {
      ...event,
      occurredAt: "2026-07-18T14:01:00.000Z",
      elementIds: ["requirement-2"],
    };
    rememberDeferredSpecEvent(client, latest);

    expect(releasePendingSpecOverlay(client, registration)).toEqual([latest]);
  });
});
