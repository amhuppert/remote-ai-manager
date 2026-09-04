import { describe, expect, it } from "vitest";

import {
  parseMemoryArtifactHandle,
  renderMemoryArtifactHandle,
} from "./artifact-handles";
import type { MemoryArtifactRef } from "./schemas";

describe("artifact handles", () => {
  /**
   * The narrowing command a pack renders is meant to be RUNNABLE, so the handle
   * form has to survive the round trip for every artifact kind — including the
   * two whose identity is composite (a session incarnation, a lane's execution
   * context), which are exactly the ones a single-separator parser mangles.
   */
  it.each<[string, MemoryArtifactRef]>([
    ["ticket", { kind: "ticket", ticketId: "ticket-74" }],
    ["spec", { kind: "spec", specId: "spec-memory" }],
    [
      "workflow execution",
      { kind: "workflow_execution", executionId: "exec-1" },
    ],
    [
      "workflow context",
      {
        kind: "workflow_context",
        executionId: "exec-1",
        contextId: "memory-cli",
      },
    ],
    [
      "session incarnation",
      {
        kind: "session",
        projectPath: "/repos/cc",
        sessionName: "csm/memory@work",
        sessionCreatedAt: "2026-08-28T09:00:00.000Z",
      },
    ],
  ])("round-trips a %s handle", (_name, artifact) => {
    const parsed = parseMemoryArtifactHandle(
      renderMemoryArtifactHandle(artifact),
      "/repos/cc",
    );
    // A ticket is the one kind the string cannot settle: its rendered handle is
    // a `tickets.id`, and the parse hands back the reference for the boundary
    // that can look it up rather than a ref that skipped the lookup.
    expect(parsed).toEqual(
      artifact.kind === "ticket"
        ? {
            kind: "ticket",
            ticket: { form: "id", ticketId: artifact.ticketId },
          }
        : { kind: "artifact", artifact },
    );
  });

  /**
   * The id space the help examples and every human-facing surface use. Before
   * these, `ticket:74` parsed straight through as a `tickets.id` of "74" — a
   * link accepted silently that could never match the ref the index composer
   * builds.
   */
  it.each<[string, unknown]>([
    ["ticket:74", { form: "number", projectName: null, number: 74 }],
    ["ticket:cc#74", { form: "number", projectName: "cc", number: 74 }],
    [
      "ticket:command-center#8",
      { form: "number", projectName: "command-center", number: 8 },
    ],
    [
      "ticket:12dc2816-4bbd-4642-bfc5-04d9f664fdef",
      { form: "id", ticketId: "12dc2816-4bbd-4642-bfc5-04d9f664fdef" },
    ],
  ])("reads %s as the reference it is", (handle, ticket) => {
    expect(parseMemoryArtifactHandle(handle, "/repos/cc")).toEqual({
      kind: "ticket",
      ticket,
    });
  });

  it("refuses a ticket number that names no position", () => {
    // Zero and a project with no name are not narrower forms of a valid handle,
    // so they fail here rather than reaching a repository lookup that cannot
    // answer them either.
    expect(parseMemoryArtifactHandle("ticket:0", "/repos/cc")).toBeNull();
    expect(parseMemoryArtifactHandle("ticket:cc#0", "/repos/cc")).toBeNull();
    expect(parseMemoryArtifactHandle("ticket:#74", "/repos/cc")).toBeNull();
    expect(parseMemoryArtifactHandle("ticket:cc#x", "/repos/cc")).toBeNull();
  });

  it("returns null for an unknown kind or a malformed handle", () => {
    expect(parseMemoryArtifactHandle("notepad:np-1", "/repos/cc")).toBeNull();
    expect(parseMemoryArtifactHandle("ticket:", "/repos/cc")).toBeNull();
    expect(parseMemoryArtifactHandle("ticket-74", "/repos/cc")).toBeNull();
    expect(parseMemoryArtifactHandle("context:exec-1", "/repos/cc")).toBeNull();
    expect(
      parseMemoryArtifactHandle("session:name-without-created-at", "/repos/cc"),
    ).toBeNull();
  });

  it("cannot build a session handle without the caller's project", () => {
    // A session incarnation is identified WITHIN a project, so a handle parsed
    // with no project would silently bind to another project's session.
    expect(
      parseMemoryArtifactHandle("session:work@2026-08-28T09:00:00.000Z", null),
    ).toBeNull();
  });
});
