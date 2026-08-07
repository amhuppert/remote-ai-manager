import { describe, it, expect } from "vitest";
import {
  resolveProjectConversationRoute,
  type ProjectConversationResolveDeps,
} from "./route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

function makeConversation(id: string): ConversationState {
  return makeConversationState({ id });
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function makeDeps(
  overrides: Partial<ProjectConversationResolveDeps> = {},
): ProjectConversationResolveDeps {
  return {
    resolveProjectPath: async () => "/repos/demo",
    getProjectConversation: async () => makeConversation("conv-1"),
    ...overrides,
  };
}

describe("resolveProjectConversationRoute", () => {
  it("resolves project path and the project conversation", async () => {
    const conversation = makeConversation("conv-1");
    let lookedUpWith: [string, string] | undefined;
    const deps = makeDeps({
      getProjectConversation: async (projectPath, id) => {
        lookedUpWith = [projectPath, id];
        return conversation;
      },
    });

    const result = await resolveProjectConversationRoute(
      deps,
      context({ name: "demo", conversationId: "conv-1" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projectPath).toBe("/repos/demo");
      expect(result.value.conversation).toBe(conversation);
      expect(result.value.conversationId).toBe("conv-1");
    }
    expect(lookedUpWith).toEqual(["/repos/demo", "conv-1"]);
  });

  it("returns 404 when the project is unknown", async () => {
    let lookedUp = false;
    const deps = makeDeps({
      resolveProjectPath: async () => null,
      getProjectConversation: async () => {
        lookedUp = true;
        return makeConversation("conv-1");
      },
    });

    const result = await resolveProjectConversationRoute(
      deps,
      context({ name: "missing", conversationId: "conv-1" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
    expect(lookedUp).toBe(false);
  });

  it("returns 404 when the project conversation is missing", async () => {
    const deps = makeDeps({ getProjectConversation: async () => null });
    const result = await resolveProjectConversationRoute(
      deps,
      context({ name: "demo", conversationId: "ghost" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });
});
