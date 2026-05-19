import { describe, expect, it } from "vitest";

import { mcpConfigKeys, mcpToolsKeys } from "@/lib/query-keys";

import { computeMcpConfigInvalidations } from "./sse-invalidation";

describe("computeMcpConfigInvalidations", () => {
  it("global event invalidates the entire mcp-config subtree", () => {
    const result = computeMcpConfigInvalidations({ level: "global" });
    expect(result).toEqual([{ queryKey: mcpConfigKeys.all }]);
  });

  it("project event invalidates project + every session/conversation under it", () => {
    const result = computeMcpConfigInvalidations({
      level: "project",
      projectName: "my-project",
    });

    // The project's own view.
    expect(result).toContainEqual({
      queryKey: mcpConfigKeys.project("my-project"),
    });

    // The prefix must cover every session within the project. Session keys
    // look like ["mcp-config","session", projectName, sessionName]; a single
    // prefix from sessionsInProject captures them all.
    expect(result).toContainEqual({
      queryKey: mcpConfigKeys.sessionsInProject("my-project"),
    });

    // Likewise every conversation view under this project.
    expect(result).toContainEqual({
      queryKey: mcpConfigKeys.conversationsInProject("my-project"),
    });

    expect(result).toHaveLength(3);
  });

  it("project event with missing projectName returns nothing", () => {
    expect(computeMcpConfigInvalidations({ level: "project" })).toEqual([]);
  });

  it("session event invalidates the session + every conversation under it", () => {
    const result = computeMcpConfigInvalidations({
      level: "session",
      projectName: "p",
      sessionName: "s",
    });

    expect(result).toContainEqual({
      queryKey: mcpConfigKeys.session("p", "s"),
    });
    expect(result).toContainEqual({
      queryKey: mcpConfigKeys.conversationsInSession("p", "s"),
    });
    expect(result).toHaveLength(2);
  });

  it("session event without sessionName returns nothing", () => {
    expect(
      computeMcpConfigInvalidations({
        level: "session",
        projectName: "p",
      }),
    ).toEqual([]);
  });

  it("conversation event invalidates only that conversation", () => {
    const result = computeMcpConfigInvalidations({
      level: "conversation",
      projectName: "p",
      sessionName: "s",
      conversationId: "c",
    });

    expect(result).toEqual([
      { queryKey: mcpConfigKeys.conversation("p", "s", "c") },
    ]);
  });

  it("conversation event with missing identifiers returns nothing", () => {
    expect(
      computeMcpConfigInvalidations({
        level: "conversation",
        projectName: "p",
        sessionName: "s",
      }),
    ).toEqual([]);
  });

  it("computed keys share the mcp-config root segment with both factories", () => {
    // Sanity check that our hard-coded prefixes line up with the actual query
    // key factories. If mcpConfigKeys changes, this test breaks and we update
    // the cascade helper in lockstep.
    expect(mcpConfigKeys.all[0]).toBe("mcp-config");
    expect(mcpToolsKeys.all[0]).toBe("mcp-tools");
  });
});
