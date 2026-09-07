import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createConversationStartCapabilityComposer } from "@/lib/agent-capabilities/default-deps";
import { composeConversationStartRuntime } from "@/lib/agent-capabilities/runtime-composer";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { createComposePortableMcpForConversation } from "@/lib/mcp/compose-for-conversation";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversationActorImplementations } from "./actor-implementations";
import { createConversationPolicyState } from "./policy-state";
import { createConversationRuntimePolicy } from "./runtime-policy";
import { ephemeralConversationEffects } from "./effects";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";
import { createConversationManagerFixture } from "./testing/manager-fixture";
import {
  createActorDependenciesFixture,
  createMockBackendRuntime,
  groupActorFixtureDependencies,
} from "./testing/actor-deps-fixture";

function dumpDatabase(db: ReturnType<typeof createPersistenceFixture>["db"]) {
  const tables = z
    .array(z.object({ name: z.string() }))
    .parse(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    );
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()),
    ]),
  );
}

describe("ephemeral policy application through the composed conversation", () => {
  it.each(["session", "project"] as const)(
    "applies capability policy and rejects changed MCP before dispatch at %s scope without database writes",
    async (scope) => {
      const fixture = createPersistenceFixture();
      const projectPath = "/policy-repo";
      const worktreePath = `${projectPath}/.worktrees/execution-lane`;
      const sessionName = scope === "session" ? "session" : "__project__";
      const conversationId = `policy-${scope}`;
      fixture.seedProject(projectPath);
      await fixture.store.mutateProjectAgentCapabilityOverrides(
        projectPath,
        "test.policy",
        () => ({
          write: true,
          overrides: {
            cascades: {
              "codex-skills": { items: { "spec-init": { enabled: false } } },
            },
          },
          result: undefined,
        }),
      );
      const discoveryPaths: string[] = [];
      const composeCapabilities = createConversationStartCapabilityComposer({
        readGlobalOverrides: async () => undefined,
        getProjectAgentCapabilityOverrides:
          fixture.store.getProjectAgentCapabilityOverrides,
        getSession: fixture.store.getSession,
        getProjectConversation: fixture.store.getProjectConversation,
        getDiscoveryProvider: (kind) => ({
          async discover(input) {
            discoveryPaths.push(input.worktreePath);
            return {
              items:
                kind === "codex-skills"
                  ? [
                      {
                        itemId: "spec-init",
                        displayName: "spec-init",
                        capabilityKind: "skill",
                        source: {
                          kind: "project-file",
                          path: `${input.worktreePath}/.agents/skills/spec-init`,
                        },
                        nativeDefault: { enabled: true },
                        runtimeVisibility: "source-only",
                      },
                    ]
                  : [],
            };
          },
        }),
        composeRuntime: composeConversationStartRuntime,
        homeDir: () => "/policy-home",
        logDiscoveryFailure: (error) => {
          throw new Error(error.error);
        },
      });
      let command = "/bin/true";
      const composePortableMcp = createComposePortableMcpForConversation({
        readGlobalOverrides: async () => ({ servers: {} }),
        readProjectOverrides: fixture.store.getProjectMcpOverrides,
        readSessionOverrides: async (p, s) =>
          (await fixture.store.getSession(p, s))?.mcpOverrides,
        readConversationOverrides: async (p, s, c) =>
          (await fixture.store.getConversation(p, s, c))?.mcpOverrides,
        globalConfigPath: () => "/policy-home/.mcp.json",
        async discoverSources(input) {
          if (!input.worktreePath)
            throw new Error("MCP discovery needs the bound worktree");
          discoveryPaths.push(input.worktreePath);
          return {
            servers: [
              {
                serverKey: "s1",
                nativeId: "s1",
                transport: "stdio",
                config: { transport: "stdio", command },
                sourceRefs: [
                  { scope: "global", filePath: input.globalConfigPath },
                ],
                configSignature: command,
                reserved: false,
                diagnostics: [],
              },
            ],
            diagnostics: [],
            sourceFiles: [],
          };
        },
      });
      const appliedCapabilities = vi.fn(async () => ({
        status: "applied" as const,
      }));
      const applyMcp = vi.fn(async () => ({
        disposition: "rejected" as const,
        droppedServerIds: ["s1"],
        droppedFields: [],
        errors: { s1: "server unreachable" },
      }));
      let dispatches = 0;
      const backend = {
        ...createMockBackendRuntime({
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "high" },
          },
          applyPortableMcpConfig: applyMcp,
          async sendTurn(input) {
            dispatches++;
            await input.onEvent({ type: "input_accepted" });
            return {
              backendRef: null,
              costUsd: 0,
              durationMs: 1,
              numTurns: 1,
              contextTokens: null,
              contextWindowMax: null,
              contentBlocks: [{ type: "text", text: "accepted" }],
              aborted: false,
              compacted: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
        }),
        applyCapabilityConfig: appliedCapabilities,
      };
      const dependencies = groupActorFixtureDependencies(
        createActorDependenciesFixture({
          getConversation: fixture.store.getConversation,
          getSessionState: fixture.store.getSession,
          mutateConversation: fixture.store.mutateConversation,
          getConversationBackendFactory: () => ({
            backend: "codex",
            createRuntime: async () => backend,
          }),
        }),
      );
      const adapter = getBackendDescriptor("codex").conversation?.runtimeConfig;
      if (!adapter)
        throw new Error(
          "Codex conversation descriptor has no capability adapter",
        );
      const host = createConversationManagerFixture({
        async loadActors(input) {
          const runtime = getConversationRuntime(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          );
          if (!runtime) throw new Error("Missing hosted runtime");
          const state = createConversationPolicyState({
            persistence: input.persistence,
            managed: runtime.managed,
            effects: dependencies.effects,
            getConversation: fixture.store.getConversation,
          });
          const policy = createConversationRuntimePolicy(
            {
              composePortableMcp,
              composeCapabilities,
              composeDurableProject: async () => {
                throw new Error("No durable project conversation");
              },
              applyRuntimeConfig: (request) =>
                adapter.apply({ runtime: backend, resolved: request.resolved }),
            },
            {
              persistence: input.persistence,
              projectName: "policy-repo",
              worktreePath,
              state,
              getRuntime: () => runtime.managed.backend,
              getTooling: () => runtime.tooling,
            },
          );
          return createConversationActorImplementations({
            ...dependencies,
            effects: ephemeralConversationEffects,
            policy,
          });
        },
      });
      const binding = {
        kind: "ephemeral" as const,
        address: {
          projectPath,
          target: targetFromStoreSessionName(
            "policy-repo",
            sessionName,
            conversationId,
          ),
        },
        worktreePath,
        backend: "codex" as const,
        role: null,
      };
      const before = dumpDatabase(fixture.db);
      try {
        const first = await host.manager.executeConversationTurn({
          binding,
          turn: { kind: "conversation_turn", promptText: "first" },
        });
        expect(first).toMatchObject({
          kind: "settled",
          turn: {
            outcome: {
              kind: "call_result",
              result: { outcome: { kind: "completed" } },
            },
          },
        });
        expect(dispatches).toBe(1);
        expect(appliedCapabilities).toHaveBeenCalledWith({
          config: {
            skills: { config: [{ enabled: false, name: "spec-init" }] },
          },
        });
        const capabilityApplyCount = appliedCapabilities.mock.calls.length;
        const owner = getConversationRuntime(
          conversationRuntimeKey(projectPath, sessionName, conversationId),
        )?.managed;
        const originalHash = owner?.mcpApplicationState?.lastAppliedConfigHash;
        expect(originalHash).toBeTruthy();
        command = "/bin/false";
        const second = await host.manager.executeConversationTurn({
          binding,
          turn: { kind: "conversation_turn", promptText: "second" },
        });
        expect(second).toMatchObject({
          kind: "settled",
          turn: {
            outcome: {
              kind: "call_result",
              result: {
                outcome: {
                  kind: "failed",
                  error: { failureKind: "capability_unavailable" },
                },
              },
            },
          },
        });
        expect(applyMcp).toHaveBeenCalledTimes(1);
        expect(dispatches).toBe(1);
        expect(owner?.mcpApplicationState).toMatchObject({
          lastAppliedConfigHash: originalHash,
          lastApplyDisposition: "rejected",
        });
        expect(appliedCapabilities).toHaveBeenCalledTimes(capabilityApplyCount);
        expect(discoveryPaths.length).toBeGreaterThan(0);
        expect(new Set(discoveryPaths)).toEqual(new Set([worktreePath]));
        expect(
          await fixture.store.getConversation(
            projectPath,
            sessionName,
            conversationId,
          ),
        ).toBeNull();
        expect(dumpDatabase(fixture.db)).toEqual(before);
      } finally {
        await host.manager.stopAllConversationActors();
        host.dispose();
        fixture.close();
      }
    },
  );
});
