/**
 * The consumer half of R10.1: a committed library change must reach the
 * library queries, and a project-tier change must reach exactly one project's.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";

import {
  agentProfileKeys,
  agentProfileProjectNameFromPath,
} from "./query-keys";
import { registerAgentProfileSseReactions } from "./sse-reactions";

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  registerAgentProfileSseReactions(fake as unknown as EventSource, {
    queryClient,
  });
  return { fake, invalidate };
}

describe("agentProfileProjectNameFromPath", () => {
  it("reads the name the resolver joined onto the base directory", () => {
    expect(agentProfileProjectNameFromPath("/repos/command-center")).toBe(
      "command-center",
    );
    expect(agentProfileProjectNameFromPath("/repos/demo/")).toBe("demo");
  });

  it("returns null when there is no segment to read", () => {
    expect(agentProfileProjectNameFromPath("/")).toBeNull();
    expect(agentProfileProjectNameFromPath("")).toBeNull();
  });
});

describe("registerAgentProfileSseReactions", () => {
  it("invalidates every library query when a global-tier record changes", () => {
    const { fake, invalidate } = setup();

    fake.emit("agent-profile-library-changed", {
      type: "agent-profile-library-changed",
      scope: "global",
      tier: "global",
      id: "security-reviewer",
      revision: 3,
      action: "updated",
    });

    // A global record is visible from every project, so every project's
    // listing is now stale.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: agentProfileKeys.all,
    });
  });

  it("invalidates only the owning project's queries when a project-tier record changes", () => {
    const { fake, invalidate } = setup();

    fake.emit("agent-profile-library-changed", {
      type: "agent-profile-library-changed",
      scope: "project",
      projectPath: "/repos/alpha",
      tier: "project",
      id: "house-reviewer",
      revision: 1,
      action: "created",
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: agentProfileKeys.projectList("alpha"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: agentProfileKeys.projectScope("alpha"),
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: agentProfileKeys.all,
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: agentProfileKeys.projectList("beta"),
    });
  });

  it("falls back to invalidating everything when the project path names nothing", () => {
    const { fake, invalidate } = setup();

    fake.emit("agent-profile-library-changed", {
      type: "agent-profile-library-changed",
      scope: "project",
      projectPath: "/",
      tier: "project",
      id: "house-reviewer",
      revision: 1,
      action: "deleted",
    });

    // A stale library is worse than a redundant refetch.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentProfileKeys.all });
  });

  it("drops a frame that does not match the typed event", () => {
    const { fake, invalidate } = setup();

    // `projectPath` belongs to the project variant only; a global change that
    // carried one would be a different contract than the one consumers read.
    fake.emit("agent-profile-library-changed", {
      type: "agent-profile-library-changed",
      scope: "global",
      projectPath: "/repos/alpha",
      tier: "global",
      id: "security-reviewer",
      revision: 1,
      action: "updated",
    });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
