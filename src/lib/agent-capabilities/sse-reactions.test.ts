import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { commandKeys } from "@/lib/commands/query-keys";
import { registerAgentCapabilitySseReactions } from "./sse-reactions";

describe("capability command cache invalidation", () => {
  it.each([
    "agent-capabilities-updated",
    "agent-capabilities-discovery-updated",
  ] as const)(
    "invalidates catalogs when %s changes the effective skill list",
    (type) => {
      const client = new QueryClient();
      const sessionKey = commandKeys.list(
        "proj",
        "session",
        "codex",
        "session-conversation",
      );
      const projectKey = commandKeys.projectList(
        "proj",
        "codex",
        "project-conversation",
      );
      client.setQueryData(sessionKey, { items: [] });
      client.setQueryData(projectKey, { items: [] });
      const source = new FakeEventSource("/api/events");
      registerAgentCapabilitySseReactions(source, { queryClient: client });

      source.emit(type, {
        type,
        level: "global",
        cascadeKind: "codex-skills",
        backend: "codex",
        invalidationHints: { level: "global", cascadeKind: "codex-skills" },
        ...(type === "agent-capabilities-updated"
          ? { changedItemIds: ["wait-what"], effectiveHash: "hash" }
          : {
              refreshedAt: "2026-09-18T00:00:00Z",
              sourceSignature: "signature",
            }),
      });

      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(projectKey)?.isInvalidated).toBe(true);
    },
  );
});
