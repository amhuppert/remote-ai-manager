/**
 * Production dependency wiring for the capability runtime apply service.
 *
 * Bridges the side-effect-free apply service to the live system:
 *   - Discovery + override resolution feeds `composeConversationStartRuntime`.
 *   - `runtime-registry` enumerates active conversations + reports turn state.
 *   - `stateManager.mutateConversation` reads/writes the persisted runtime
 *     application state under `ConversationState.agentCapabilitiesRuntime`.
 *   - `applyClaudeRuntime` resolves the conversation's `ConversationBackendRuntime`
 *     from the registry and forwards to its `applyClaudeCapabilityConfig`
 *     port — letting the apply service live-apply idle Claude runtimes and
 *     fall back to `staged-idle` when a turn is active or the runtime is
 *     unavailable.
 */

import os from "node:os";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { createStateManager } from "@/lib/state-store";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeLayer,
  AgentCapabilityOverrides,
  AgentCapabilityRuntimeApplicationState,
  AgentCapabilityScopeContext,
} from "./schemas";

import { defaultGlobalCapabilityOverrideStore } from "./global-store";
import {
  discoverClaudeAgents,
  discoverClaudePlugins,
  discoverClaudeSkills,
  type ClaudeRuntimeProbe,
} from "./claude-discovery";
import {
  discoverCodexPluginsCanonical,
  discoverCodexSkillsCanonical,
} from "./codex-discovery";
import {
  composeConversationStartRuntime,
  type ComposeConversationStartCascadeInput,
  type ComposeConversationStartInput,
  type ComposeConversationStartResult,
} from "./runtime-composer";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ApplyConversationIdentity,
  type CapabilityRuntimeApplyService,
  type ClaudeApplyPortInput,
  type ClaudeApplyPortResult,
  type CodexApplyPortInput,
  type CodexApplyPortResult,
} from "./apply";
import type { ClaudeRuntimeCapabilityConfig } from "./claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "./codex-runtime-translator";
import {
  createCapabilityMutationService,
  type CapabilityMutationService,
  type MutationScope,
} from "./mutation-service";
import { redactAgentCapabilityText } from "./redaction";
import { defaultScopeCapabilityOverrideStore } from "./scope-store";

const logger = createLogger("agent-capabilities.default-deps");
const stateManager = createStateManager();

export type ConversationStartCapabilityComposerInput =
  | SessionConversationStartCapabilityComposerInput
  | ProjectConversationStartCapabilityComposerInput;

export interface SessionConversationStartCapabilityComposerInput {
  conversationScope?: "session";
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
}

export interface ProjectConversationStartCapabilityComposerInput {
  conversationScope: "project";
  projectPath: string;
  projectName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
}

export interface ConversationStartCapabilityComposerDeps {
  readGlobalOverrides(): Promise<AgentCapabilityOverrides | undefined>;
  readState(): Promise<ManagerState>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  discoverClaudeSkills(
    input: Parameters<typeof discoverClaudeSkills>[0],
  ): ReturnType<typeof discoverClaudeSkills>;
  discoverClaudePlugins(
    input: Parameters<typeof discoverClaudePlugins>[0],
  ): ReturnType<typeof discoverClaudePlugins>;
  discoverClaudeAgents(
    input: Parameters<typeof discoverClaudeAgents>[0],
  ): ReturnType<typeof discoverClaudeAgents>;
  discoverCodexSkillsCanonical(
    input: Parameters<typeof discoverCodexSkillsCanonical>[0],
  ): ReturnType<typeof discoverCodexSkillsCanonical>;
  discoverCodexPluginsCanonical(
    input: Parameters<typeof discoverCodexPluginsCanonical>[0],
  ): ReturnType<typeof discoverCodexPluginsCanonical>;
  composeRuntime(
    input: ComposeConversationStartInput,
  ): ComposeConversationStartResult;
  homeDir(): string;
  getClaudeRuntimeProbe(conversationId: string): ClaudeRuntimeProbe | undefined;
  logDiscoveryFailure(input: DiscoveryFailureLogInput): void;
}

interface DiscoveryFailureLogInput {
  event: string;
  backend: AgentBackendId;
  cascadeKind: AgentCapabilityCascadeKind;
  conversationScope: "session" | "project";
  worktreePath: string;
  error: string;
}

async function readOverrideChain(
  scope: ConversationStartCapabilityComposerInput,
  deps: ConversationStartCapabilityComposerDeps,
): Promise<
  ReadonlyArray<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }>
> {
  const chain: Array<{
    layer: AgentCapabilityCascadeLayer;
    overrides: AgentCapabilityOverrides | undefined;
  }> = [
    {
      layer: "global",
      overrides: await deps.readGlobalOverrides(),
    },
  ];

  const state = await deps.readState();
  const project = state.projects[scope.projectPath];
  if (project) {
    chain.push({
      layer: "project",
      overrides: project.agentCapabilityOverrides,
    });
    if (isProjectConversationComposeInput(scope)) {
      const conversation = await deps.getProjectConversation(
        scope.projectPath,
        scope.conversationId,
      );
      if (conversation) {
        chain.push({
          layer: "conversation",
          overrides: conversation.agentCapabilityOverrides,
        });
      }
      return chain;
    }

    const session = project.sessions[scope.sessionName];
    if (session) {
      chain.push({
        layer: "session",
        overrides: session.agentCapabilityOverrides,
      });
      const conv = session.conversations.find(
        (c) => c.id === scope.conversationId,
      );
      if (conv) {
        chain.push({
          layer: "conversation",
          overrides: conv.agentCapabilityOverrides,
        });
      }
    }
  }

  return chain;
}

export function createConversationStartCapabilityComposer(
  deps: ConversationStartCapabilityComposerDeps,
): (
  input: ConversationStartCapabilityComposerInput,
) => Promise<ComposeConversationStartResult> {
  return async function composeForConversation(input) {
    const overrideChain = await readOverrideChain(input, deps);
    const home = deps.homeDir();
    const discoveryByCascade: Partial<
      Record<AgentCapabilityCascadeKind, ComposeConversationStartCascadeInput>
    > = {};
    const failedCascadeKinds: AgentCapabilityCascadeKind[] = [];
    const conversationScope = conversationScopeForComposeInput(input);

    if (input.backend === "claude") {
      try {
        const skills = await deps.discoverClaudeSkills({
          worktreePath: input.worktreePath,
          home,
          runtimeProbe: deps.getClaudeRuntimeProbe(input.conversationId),
        });
        discoveryByCascade["claude-skills"] = {
          items: skills.items,
          diagnostics: skills.diagnostics,
        };
      } catch (err) {
        logDiscoveryFailure(deps, {
          event: "discovery.claude_skills_failed",
          backend: "claude",
          cascadeKind: "claude-skills",
          conversationScope,
          worktreePath: input.worktreePath,
          error: getErrorMessage(err),
        });
        failedCascadeKinds.push("claude-skills");
      }

      let nativePluginRecords:
        | Awaited<ReturnType<typeof discoverClaudePlugins>>["nativeRecords"]
        | undefined;
      try {
        const plugins = await deps.discoverClaudePlugins({
          worktreePath: input.worktreePath,
          home,
        });
        discoveryByCascade["claude-plugins"] = {
          items: plugins.items,
          diagnostics: plugins.diagnostics,
        };
        nativePluginRecords = plugins.nativeRecords;
      } catch (err) {
        logDiscoveryFailure(deps, {
          event: "discovery.claude_plugins_failed",
          backend: "claude",
          cascadeKind: "claude-plugins",
          conversationScope,
          worktreePath: input.worktreePath,
          error: getErrorMessage(err),
        });
        failedCascadeKinds.push("claude-plugins");
      }

      try {
        const agents = await deps.discoverClaudeAgents({
          worktreePath: input.worktreePath,
          home,
          runtimeProbe: deps.getClaudeRuntimeProbe(input.conversationId),
        });
        discoveryByCascade["claude-agents"] = {
          items: agents.items,
          diagnostics: agents.diagnostics,
        };
      } catch (err) {
        logDiscoveryFailure(deps, {
          event: "discovery.claude_agents_failed",
          backend: "claude",
          cascadeKind: "claude-agents",
          conversationScope,
          worktreePath: input.worktreePath,
          error: getErrorMessage(err),
        });
        failedCascadeKinds.push("claude-agents");
      }

      return deps.composeRuntime({
        backend: "claude",
        scope: scopeContextForComposeInput(input),
        overrideChain,
        discoveryByCascade,
        failedCascadeKinds,
        nativePluginRecords: nativePluginRecords ?? [],
      });
    }

    try {
      const skills = await deps.discoverCodexSkillsCanonical({
        worktreePath: input.worktreePath,
        home,
      });
      discoveryByCascade["codex-skills"] = {
        items: skills.items,
        diagnostics: skills.diagnostics,
      };
    } catch (err) {
      logDiscoveryFailure(deps, {
        event: "discovery.codex_skills_failed",
        backend: "codex",
        cascadeKind: "codex-skills",
        conversationScope,
        worktreePath: input.worktreePath,
        error: getErrorMessage(err),
      });
      failedCascadeKinds.push("codex-skills");
    }

    try {
      const plugins = await deps.discoverCodexPluginsCanonical({
        worktreePath: input.worktreePath,
        home,
      });
      discoveryByCascade["codex-plugins"] = {
        items: plugins.items,
        diagnostics: plugins.diagnostics,
      };
    } catch (err) {
      logDiscoveryFailure(deps, {
        event: "discovery.codex_plugins_failed",
        backend: "codex",
        cascadeKind: "codex-plugins",
        conversationScope,
        worktreePath: input.worktreePath,
        error: getErrorMessage(err),
      });
      failedCascadeKinds.push("codex-plugins");
    }

    return deps.composeRuntime({
      backend: "codex",
      scope: scopeContextForComposeInput(input),
      overrideChain,
      discoveryByCascade,
      failedCascadeKinds,
    });
  };
}

function isProjectConversationComposeInput(
  input: ConversationStartCapabilityComposerInput,
): input is ProjectConversationStartCapabilityComposerInput {
  return input.conversationScope === "project";
}

function conversationScopeForComposeInput(
  input: ConversationStartCapabilityComposerInput,
): "session" | "project" {
  return isProjectConversationComposeInput(input) ? "project" : "session";
}

function scopeContextForComposeInput(
  input: ConversationStartCapabilityComposerInput,
): AgentCapabilityScopeContext {
  if (isProjectConversationComposeInput(input)) {
    return {
      level: "conversation",
      projectName: input.projectName,
      conversationScope: "project",
      conversationId: input.conversationId,
    };
  }
  return {
    level: "conversation",
    projectName: input.projectName,
    conversationScope: "session",
    sessionName: input.sessionName,
    conversationId: input.conversationId,
  };
}

function logDiscoveryFailure(
  deps: ConversationStartCapabilityComposerDeps,
  input: DiscoveryFailureLogInput,
): void {
  deps.logDiscoveryFailure({
    ...input,
    error: redactAgentCapabilityText(input.error),
  });
}

const defaultComposeForConversation = createConversationStartCapabilityComposer(
  {
    readGlobalOverrides: () => defaultGlobalCapabilityOverrideStore.read(),
    readState: () => stateManager.readState(),
    getProjectConversation: (projectPath, conversationId) =>
      stateManager.getProjectConversation(projectPath, conversationId),
    discoverClaudeSkills,
    discoverClaudePlugins,
    discoverClaudeAgents,
    discoverCodexSkillsCanonical,
    discoverCodexPluginsCanonical,
    composeRuntime: composeConversationStartRuntime,
    homeDir: () => os.homedir(),
    getClaudeRuntimeProbe,
    logDiscoveryFailure(input) {
      logger.error(input.event, {
        backend: input.backend,
        cascadeKind: input.cascadeKind,
        conversationScope: input.conversationScope,
        worktreePath: input.worktreePath,
        error: input.error,
      });
    },
  },
);

interface RuntimeSnapshot {
  status: "alive" | "dead";
  backend: AgentBackendId;
  isTurnActive?: unknown;
}

export interface AffectedConversationListerDeps {
  readState(): Promise<ManagerState>;
  readGlobalOverrides(): Promise<AgentCapabilityOverrides | undefined>;
  listAllProjectConversations(): Promise<
    readonly { projectPath: string; conversation: ConversationState }[]
  >;
  getRuntime(conversationId: string): RuntimeSnapshot | undefined;
  getProjectDisplayName(projectPath: string): string;
}

export function createAffectedConversationLister(
  deps: AffectedConversationListerDeps,
): (input: {
  scope: MutationScope;
  cascadeKind: AgentCapabilityCascadeKind;
  changedItemIds: readonly string[];
}) => Promise<readonly AffectedConversation[]> {
  return async function listAffectedConversations(input) {
    const [state, globalOverrides] = await Promise.all([
      deps.readState(),
      deps.readGlobalOverrides(),
    ]);
    const affected: AffectedConversation[] = [];

    for (const [projectPath, project] of Object.entries(state.projects)) {
      if (!scopeCanAffectProject(input.scope, projectPath)) continue;

      const projectName = deps.getProjectDisplayName(projectPath);
      if (!isProjectConversationMutationScope(input.scope)) {
        for (const session of Object.values(project.sessions)) {
          if (!scopeCanAffectSessionConversation(input.scope, session)) {
            continue;
          }

          for (const conv of session.conversations) {
            if (!scopeCanAffectSessionConversationRecord(input.scope, conv)) {
              continue;
            }

            const runtime = deps.getRuntime(conv.id);
            if (!isLiveRuntimeForCascade(runtime, input.cascadeKind)) continue;
            if (
              !mutationAffectsConversationRuntime({
                scope: input.scope,
                cascadeKind: input.cascadeKind,
                changedItemIds: input.changedItemIds,
                overrideChain: {
                  global: globalOverrides,
                  project: project.agentCapabilityOverrides,
                  session: session.agentCapabilityOverrides,
                  conversation: conv.agentCapabilityOverrides,
                },
              })
            ) {
              continue;
            }

            affected.push({
              conversationScope: "session",
              projectPath,
              projectName,
              sessionName: session.sessionName,
              conversationId: conv.id,
              worktreePath: session.worktreePath,
              backend: runtime.backend,
              isTurnActive: isClaudeTurnActive(runtime),
            });
          }
        }
      }
    }

    if (
      input.scope.level === "session" ||
      isSessionConversationMutationScope(input.scope)
    ) {
      return affected;
    }

    let projectConversations: readonly {
      projectPath: string;
      conversation: ConversationState;
    }[];
    try {
      projectConversations = await deps.listAllProjectConversations();
    } catch (err) {
      logger.error("fanout.project_conversations_list_failed", {
        cascadeKind: input.cascadeKind,
        changedCount: input.changedItemIds.length,
        error: redactAgentCapabilityText(getErrorMessage(err)),
        ...fanoutScopeLogFields(input.scope),
      });
      if (input.scope.level === "global" || input.scope.level === "project") {
        return affected;
      }
      throw err;
    }

    for (const { projectPath, conversation } of projectConversations) {
      if (!scopeCanAffectProject(input.scope, projectPath)) continue;
      if (
        isProjectConversationMutationScope(input.scope) &&
        input.scope.conversationId !== conversation.id
      ) {
        continue;
      }

      const runtime = deps.getRuntime(conversation.id);
      if (!isLiveRuntimeForCascade(runtime, input.cascadeKind)) continue;
      const project = state.projects[projectPath];
      if (
        !mutationAffectsConversationRuntime({
          scope: input.scope,
          cascadeKind: input.cascadeKind,
          changedItemIds: input.changedItemIds,
          overrideChain: {
            global: globalOverrides,
            project: project?.agentCapabilityOverrides,
            conversation: conversation.agentCapabilityOverrides,
          },
        })
      ) {
        continue;
      }

      affected.push({
        conversationScope: "project",
        projectPath,
        projectName: deps.getProjectDisplayName(projectPath),
        conversationId: conversation.id,
        worktreePath: projectPath,
        backend: runtime.backend,
        isTurnActive: isClaudeTurnActive(runtime),
      });
    }

    return affected;
  };
}

function fanoutScopeLogFields(scope: MutationScope): Record<string, string> {
  if (scope.level === "global") {
    return { level: "global" };
  }
  if (scope.level === "project") {
    return { level: "project", projectPath: scope.projectPath };
  }
  if (scope.level === "session") {
    return {
      level: "session",
      projectPath: scope.projectPath,
      sessionName: scope.sessionName,
    };
  }
  if (scope.conversationScope === "project") {
    return {
      level: "conversation",
      projectPath: scope.projectPath,
      conversationScope: "project",
      conversationId: scope.conversationId,
    };
  }
  return {
    level: "conversation",
    projectPath: scope.projectPath,
    conversationScope: "session",
    sessionName: scope.sessionName,
    conversationId: scope.conversationId,
  };
}

function scopeCanAffectProject(
  scope: MutationScope,
  projectPath: string,
): boolean {
  if (scope.level === "global") return true;
  return scope.projectPath === projectPath;
}

function scopeCanAffectSessionConversation(
  scope: MutationScope,
  session: { sessionName: string },
): boolean {
  if (scope.level === "session" || isSessionConversationMutationScope(scope)) {
    return scope.sessionName === session.sessionName;
  }
  return true;
}

function scopeCanAffectSessionConversationRecord(
  scope: MutationScope,
  conversation: { id: string },
): boolean {
  if (!isSessionConversationMutationScope(scope)) return true;
  return scope.conversationId === conversation.id;
}

function isLiveRuntimeForCascade(
  runtime: RuntimeSnapshot | undefined,
  cascadeKind: AgentCapabilityCascadeKind,
): runtime is RuntimeSnapshot & { status: "alive" } {
  if (!runtime || runtime.status !== "alive") return false;
  return cascadeBackend(cascadeKind) === runtime.backend;
}

const defaultListAffectedConversations = createAffectedConversationLister({
  readState: () => stateManager.readState(),
  readGlobalOverrides: () => defaultGlobalCapabilityOverrideStore.read(),
  listAllProjectConversations: () => stateManager.listAllProjectConversations(),
  getRuntime,
  getProjectDisplayName,
});

export interface RuntimeStateAccessorDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: readonly ConversationState[] } | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  mutateConversation<T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  mutateProjectConversation<T = void>(
    projectPath: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
}

export function createRuntimeStateAccessors(deps: RuntimeStateAccessorDeps): {
  readRuntimeState(
    conversation: ApplyConversationIdentity,
  ): Promise<AgentCapabilityRuntimeApplicationState | undefined>;
  writeRuntimeState(
    conversation: ApplyConversationIdentity & {
      state: AgentCapabilityRuntimeApplicationState;
    },
  ): Promise<void>;
} {
  return {
    async readRuntimeState(conv) {
      if (conv.conversationScope === "project") {
        const conversation = await deps.getProjectConversation(
          conv.projectPath,
          conv.conversationId,
        );
        return conversation?.agentCapabilitiesRuntime;
      }

      const session = await deps.getSession(conv.projectPath, conv.sessionName);
      const conversation = session?.conversations.find(
        (c) => c.id === conv.conversationId,
      );
      return conversation?.agentCapabilitiesRuntime;
    },
    async writeRuntimeState(input) {
      if (input.conversationScope === "project") {
        await deps.mutateProjectConversation(
          input.projectPath,
          input.conversationId,
          "agent-capabilities.writeRuntimeState",
          (conversation) => {
            conversation.agentCapabilitiesRuntime = input.state;
          },
        );
        return;
      }

      await deps.mutateConversation(
        input.projectPath,
        input.sessionName,
        input.conversationId,
        "agent-capabilities.writeRuntimeState",
        (conversation) => {
          conversation.agentCapabilitiesRuntime = input.state;
        },
      );
    },
  };
}

const defaultRuntimeStateAccessors = createRuntimeStateAccessors({
  getSession: (projectPath, sessionName) =>
    stateManager.getSession(projectPath, sessionName),
  getProjectConversation: (projectPath, conversationId) =>
    stateManager.getProjectConversation(projectPath, conversationId),
  mutateConversation: (...args) => stateManager.mutateConversation(...args),
  mutateProjectConversation: (...args) =>
    stateManager.mutateProjectConversation(...args),
});

function isProjectConversationMutationScope(
  scope: MutationScope,
): scope is Extract<
  MutationScope,
  { level: "conversation"; conversationScope: "project" }
> {
  return (
    scope.level === "conversation" && scope.conversationScope === "project"
  );
}

function isSessionConversationMutationScope(
  scope: MutationScope,
): scope is Extract<
  MutationScope,
  { level: "conversation"; sessionName: string }
> {
  return (
    scope.level === "conversation" && scope.conversationScope !== "project"
  );
}

interface MutationFanoutOverrideChain {
  global?: AgentCapabilityOverrides;
  project?: AgentCapabilityOverrides;
  session?: AgentCapabilityOverrides;
  conversation?: AgentCapabilityOverrides;
}

const cascadeLayerOrder = {
  global: 0,
  project: 1,
  session: 2,
  conversation: 3,
} as const satisfies Record<MutationScope["level"], number>;

export function mutationAffectsConversationRuntime(input: {
  scope: MutationScope;
  cascadeKind: AgentCapabilityCascadeKind;
  changedItemIds: readonly string[];
  overrideChain: MutationFanoutOverrideChain;
}): boolean {
  if (input.changedItemIds.length === 0) return false;

  const editedLayerIndex = cascadeLayerOrder[input.scope.level];
  const narrowerLayers = (
    ["project", "session", "conversation"] as const
  ).filter((layer) => cascadeLayerOrder[layer] > editedLayerIndex);

  return input.changedItemIds.some(
    (itemId) =>
      !narrowerLayers.some((layer) =>
        hasExplicitOverride(
          input.overrideChain[layer],
          input.cascadeKind,
          itemId,
        ),
      ),
  );
}

function hasExplicitOverride(
  overrides: AgentCapabilityOverrides | undefined,
  cascadeKind: AgentCapabilityCascadeKind,
  itemId: string,
): boolean {
  return overrides?.cascades[cascadeKind]?.items[itemId] !== undefined;
}

function cascadeBackend(
  cascadeKind: AgentCapabilityCascadeKind,
): AgentBackendId {
  return cascadeKind.startsWith("claude-") ? "claude" : "codex";
}

function isClaudeTurnActive(runtime: {
  backend: AgentBackendId;
  isTurnActive?: unknown;
}): boolean {
  if (runtime.backend !== "claude") return false;
  return (runtime as { isTurnActive?: unknown }).isTurnActive === true;
}

function getClaudeRuntimeProbe(
  conversationId: string,
): ClaudeRuntimeProbe | undefined {
  const runtime = getRuntime(conversationId);
  if (!runtime || runtime.backend !== "claude" || runtime.status !== "alive") {
    return undefined;
  }
  if (!runtime.supportedCommands && !runtime.supportedAgents) {
    return undefined;
  }
  return {
    ...(runtime.supportedCommands
      ? { supportedCommands: runtime.supportedCommands.bind(runtime) }
      : {}),
    ...(runtime.supportedAgents
      ? { supportedAgents: runtime.supportedAgents.bind(runtime) }
      : {}),
  };
}

/**
 * Default production capability mutation service. Wires the global + scope
 * stores to the apply fanout hook so persisted overrides immediately reach
 * affected active conversations.
 *
 * `computeEffectiveHash` and `computeView` are intentionally not wired here —
 * they live in the resolver layer (task 4 / 5) and the API route composes the
 * service with the resolver-backed implementations. Routes that need
 * conflict-aware mutations build their own instance via
 * `createCapabilityMutationService` and pass `applyAfterMutation:
 * defaultCapabilityRuntimeApplyService.applyAfterOverrideChange` so the
 * fanout always runs after the persist.
 */
/** @public Accessed via dynamic `import()` in actor-implementations. */
export const defaultCapabilityRuntimeApplyService: CapabilityRuntimeApplyService =
  createCapabilityRuntimeApplyService({
    listAffectedConversations: defaultListAffectedConversations,
    isTurnActive(conversation) {
      const runtime = getRuntime(conversation.conversationId);
      if (!runtime) return false;
      return isClaudeTurnActive(runtime);
    },
    composeForConversation: defaultComposeForConversation,
    readRuntimeState: defaultRuntimeStateAccessors.readRuntimeState,
    writeRuntimeState: defaultRuntimeStateAccessors.writeRuntimeState,
    applyClaudeRuntime: defaultApplyClaudeRuntime,
    applyCodexRuntime: defaultApplyCodexRuntime,
  });

async function defaultApplyClaudeRuntime(
  input: ClaudeApplyPortInput,
): Promise<ClaudeApplyPortResult> {
  const runtime = getRuntime(input.conversationId);
  if (!runtime) {
    return { status: "rejected", error: "claude runtime not registered" };
  }
  if (runtime.backend !== "claude") {
    return { status: "rejected", error: "runtime is not a claude backend" };
  }
  if (runtime.status !== "alive") {
    return { status: "rejected", error: "claude runtime is not alive" };
  }
  if (!runtime.applyClaudeCapabilityConfig) {
    return {
      status: "rejected",
      error: "claude runtime does not expose applyClaudeCapabilityConfig",
    };
  }
  return runtime.applyClaudeCapabilityConfig(input.config);
}

async function defaultApplyCodexRuntime(
  input: CodexApplyPortInput,
): Promise<CodexApplyPortResult> {
  const runtime = getRuntime(input.conversationId);
  if (!runtime) {
    return { status: "rejected", error: "codex runtime not registered" };
  }
  if (runtime.backend !== "codex") {
    return { status: "rejected", error: "runtime is not a codex backend" };
  }
  if (runtime.status !== "alive") {
    return { status: "rejected", error: "codex runtime is not alive" };
  }
  if (!runtime.applyCodexCapabilityConfig) {
    return {
      status: "rejected",
      error: "codex runtime does not expose applyCodexCapabilityConfig",
    };
  }
  return runtime.applyCodexCapabilityConfig(input.config);
}

/** @public Referenced via `import("...").ComposedClaudeCapabilitySeed` in actor-implementations. */
export interface ComposedClaudeCapabilitySeed {
  config: ClaudeRuntimeCapabilityConfig;
  /**
   * Initial capability runtime apply state for the new conversation. Each
   * cascade the composer emitted is recorded as `applied` because the Claude
   * SDK receives this config at session creation. The actor must persist this
   * state via `mutateConversation` so the apply service can compare
   * subsequent mutations against this baseline.
   */
  runtimeState: AgentCapabilityRuntimeApplicationState;
}

/** @public Referenced via `import("...").ComposedCodexCapabilitySeed` in actor-implementations. */
export interface ComposedCodexCapabilitySeed {
  config: CodexRuntimeCapabilityConfig;
  runtimeState: AgentCapabilityRuntimeApplicationState;
}

/**
 * Promote Claude composer-seeded cascades from `staged-next-turn` to
 * `applied`. Codex keeps the staged state until the turn-start apply service
 * pushes the config into the runtime and records the promotion.
 */
function promoteClaudeSeededRuntimeState(
  state: AgentCapabilityRuntimeApplicationState,
): AgentCapabilityRuntimeApplicationState {
  const out: AgentCapabilityRuntimeApplicationState = { cascades: {} };
  for (const [rawKind, cascade] of Object.entries(state.cascades)) {
    if (!cascade) continue;
    const cascadeKind = rawKind as AgentCapabilityCascadeKind;
    if (cascade.pendingHash !== undefined) {
      out.cascades[cascadeKind] = {
        appliedHash: cascade.pendingHash,
        lastApplyStatus: "applied",
      };
    } else {
      out.cascades[cascadeKind] = cascade;
    }
  }
  return out;
}

export type ComposedProjectConversationCapabilitySeed =
  | ({
      backend: "claude";
    } & ComposedClaudeCapabilitySeed)
  | ({
      backend: "codex";
    } & ComposedCodexCapabilitySeed);

export interface ProjectConversationCapabilityConfigComposerDeps {
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  getProjectDisplayName(projectPath: string): string;
  composeForConversation(
    input: ConversationStartCapabilityComposerInput,
  ): Promise<ComposeConversationStartResult>;
}

export function createProjectConversationCapabilityConfigComposer(
  deps: ProjectConversationCapabilityConfigComposerDeps,
): (input: {
  projectPath: string;
  projectName?: string;
  conversationId: string;
}) => Promise<ComposedProjectConversationCapabilitySeed | undefined> {
  return async function composeProjectConversationCapabilityConfig(input) {
    const conversation = await deps.getProjectConversation(
      input.projectPath,
      input.conversationId,
    );
    if (!conversation) {
      logger.error("project-conversation.compose_missing", {
        projectPath: input.projectPath,
        conversationId: input.conversationId,
      });
      throw new Error(
        `Project conversation "${input.conversationId}" not found in project "${input.projectPath}"`,
      );
    }

    const backend = conversation.agentBackend;
    const projectName =
      input.projectName ?? deps.getProjectDisplayName(input.projectPath);
    logger.info("project-conversation.compose_start", {
      projectPath: input.projectPath,
      projectName,
      conversationId: input.conversationId,
      backend,
      worktreePath: input.projectPath,
    });

    const result = await deps.composeForConversation({
      conversationScope: "project",
      projectPath: input.projectPath,
      projectName,
      conversationId: input.conversationId,
      worktreePath: input.projectPath,
      backend,
    });

    if (backend === "claude") {
      if (!result.claudeRuntime) return undefined;
      return {
        backend: "claude",
        config: result.claudeRuntime,
        runtimeState: promoteClaudeSeededRuntimeState(result.runtimeState),
      };
    }

    if (!result.codexRuntime) return undefined;
    return {
      backend: "codex",
      config: { config: result.codexRuntime.config },
      runtimeState: result.runtimeState,
    };
  };
}

const defaultProjectConversationCapabilityConfigComposer =
  createProjectConversationCapabilityConfigComposer({
    getProjectConversation: (projectPath, conversationId) =>
      stateManager.getProjectConversation(projectPath, conversationId),
    getProjectDisplayName,
    composeForConversation: defaultComposeForConversation,
  });

/** @public Accessed by project-conversation prompt runtime wiring. */
export const composeCapabilityConfigForProjectConversation =
  defaultProjectConversationCapabilityConfigComposer;

/**
 * Compose the Claude capability runtime config + initial apply state for a new
 * conversation. The actor seeds `tooling.claudeCapabilityConfig` on the
 * backend factory with the returned `config` and writes `runtimeState` to
 * `conversation.agentCapabilitiesRuntime` so the apply service can promote /
 * compare against this baseline on subsequent mutations.
 */
/** @public Accessed via dynamic `import()` in actor-implementations. */
export async function composeClaudeCapabilityConfigForConversation(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
}): Promise<ComposedClaudeCapabilitySeed | undefined> {
  const result = await defaultComposeForConversation({
    ...input,
    backend: "claude",
  });
  if (!result.claudeRuntime) return undefined;
  return {
    config: result.claudeRuntime,
    runtimeState: promoteClaudeSeededRuntimeState(result.runtimeState),
  };
}

/**
 * Compose the Codex capability runtime config + initial apply state for a new
 * conversation. See `composeClaudeCapabilityConfigForConversation` for the
 * actor wiring contract.
 */
/** @public Accessed via dynamic `import()` in actor-implementations. */
export async function composeCodexCapabilityConfigForConversation(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
}): Promise<ComposedCodexCapabilitySeed | undefined> {
  const result = await defaultComposeForConversation({
    ...input,
    backend: "codex",
  });
  if (!result.codexRuntime) return undefined;
  return {
    config: { config: result.codexRuntime.config },
    runtimeState: result.runtimeState,
  };
}

/**
 * Build a mutation service pre-wired to the default fanout hook. Routes that
 * need hash/view computation pass their own implementations of those two
 * resolver-backed deps while reusing the default stores and apply hook.
 */
export function createDefaultCapabilityMutationService(deps: {
  computeEffectiveHash: (
    scope: MutationScope,
    cascadeKind: AgentCapabilityCascadeKind,
  ) => Promise<string>;
  computeView: (
    scope: MutationScope,
    cascadeKind: AgentCapabilityCascadeKind,
  ) => Promise<
    Awaited<
      ReturnType<CapabilityMutationService["mutate"]> extends Promise<infer R>
        ? R extends { view: infer V }
          ? V
          : never
        : never
    >
  >;
}): CapabilityMutationService {
  return createCapabilityMutationService({
    globalStore: defaultGlobalCapabilityOverrideStore,
    scopeStore: defaultScopeCapabilityOverrideStore,
    computeEffectiveHash: deps.computeEffectiveHash,
    computeView: deps.computeView,
    async applyAfterMutation(input) {
      await defaultCapabilityRuntimeApplyService.applyAfterOverrideChange(
        input,
      );
    },
  });
}
