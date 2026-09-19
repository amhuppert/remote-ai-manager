import { describe, expect, it } from "vitest";
import { composeConversationStartRuntime } from "@/lib/agent-capabilities/runtime-composer";
import {
  CapabilityRouteNotFoundError,
  type CapabilityRouteScope,
} from "@/lib/agent-capabilities/route-handlers";
import {
  createScopedCommandDiscovery,
  type ScopedCommandDiscoveryDeps,
} from "./scoped-discovery";

const sessionConversation: CapabilityRouteScope = {
  level: "conversation",
  projectName: "proj",
  projectPath: "/repo",
  conversationScope: "session",
  sessionName: "work",
  conversationId: "conv",
};

describe("scoped command discovery", () => {
  it.each([
    sessionConversation,
    {
      level: "conversation",
      projectName: "proj",
      projectPath: "/repo",
      conversationScope: "project",
      conversationId: "conv",
    } satisfies CapabilityRouteScope,
    {
      level: "session",
      projectName: "proj",
      projectPath: "/repo",
      sessionName: "work",
    } satisfies CapabilityRouteScope,
    {
      level: "project",
      projectName: "proj",
      projectPath: "/repo",
    } satisfies CapabilityRouteScope,
  ])("resolves the effective cascade for $level scope", async (scope) => {
    const resolvedScopes: CapabilityRouteScope[] = [];
    const discovery = createScopedCommandDiscovery({
      async resolveView(input) {
        resolvedScopes.push(input.scope);
        const view = composeConversationStartRuntime({
          backend: "codex",
          scope: { level: "conversation" },
          overrideChain: [
            {
              layer: "conversation",
              overrides: {
                cascades: {
                  "codex-skills": { items: { hidden: { enabled: false } } },
                },
              },
            },
          ],
          discoveryByCascade: {
            "codex-plugins": { items: [] },
            "codex-skills": {
              items: ["visible", "hidden"].map((itemId) => ({
                itemId,
                displayName: itemId,
                capabilityKind: "skill",
                source: {
                  kind: "user-file",
                  path: `/skills/${itemId}/SKILL.md`,
                },
                nativeDefault: { enabled: true },
                runtimeVisibility: "source-only",
              })),
            },
          },
        }).views[input.cascadeKind];
        if (!view) throw new Error("Unexpected cascade");
        return view;
      },
      async discoverCommands(_cwd, _backend, options) {
        const capabilities = await options?.resolveCapabilities?.();
        return (
          capabilities?.kinds
            .find((kind) => kind.kind === "skills")
            ?.items.filter((item) => item.enabled)
            .map((item) => ({
              name: `$${item.itemId}`,
              type: "skill",
              description: "",
              source: "user",
            })) ?? []
        );
      },
    });

    expect(await discovery("/repo/work", "codex", scope)).toEqual([
      { name: "$visible", type: "skill", description: "", source: "user" },
    ]);
    expect(resolvedScopes).toEqual([scope, scope]);
  });

  it("rejects a conversation outside the requested scope before discovering skills", async () => {
    const deps: ScopedCommandDiscoveryDeps = {
      async resolveView() {
        throw new CapabilityRouteNotFoundError("Conversation not found");
      },
      async discoverCommands(_cwd, _backend, options) {
        await options?.resolveCapabilities?.();
        return [];
      },
    };
    await expect(
      createScopedCommandDiscovery(deps)(
        "/repo/work",
        "codex",
        sessionConversation,
      ),
    ).rejects.toThrow(CapabilityRouteNotFoundError);
  });

  it("does not resolve capability views when discovery does not request them", async () => {
    const discovery = createScopedCommandDiscovery({
      async resolveView() {
        throw new Error("Unexpected capability discovery");
      },
      async discoverCommands() {
        return [
          {
            name: "/commit",
            type: "command",
            description: "",
            source: "project",
          },
        ];
      },
    });
    expect(
      await discovery("/repo/work", "claude", sessionConversation),
    ).toHaveLength(1);
  });
});
