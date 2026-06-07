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
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityCascadeLayer,
  AgentCapabilityOverrides,
  AgentCapabilityRuntimeApplicationState,
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
  type ComposeConversationStartResult,
} from "./runtime-composer";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
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

async function readOverrideChain(
  scope: AgentCapabilityScopeContextInput,
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
      overrides: await defaultGlobalCapabilityOverrideStore.read(),
    },
  ];

  const state = await stateManager.readState();
  const project = state.projects[scope.projectPath];
  if (project) {
    chain.push({
      layer: "project",
      overrides: project.agentCapabilityOverrides,
    });
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

interface AgentCapabilityScopeContextInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

async function defaultComposeForConversation(input: {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  worktreePath: string;
  backend: AgentBackendId;
}): Promise<ComposeConversationStartResult> {
  const overrideChain = await readOverrideChain(input);
  const home = os.homedir();
  const discoveryByCascade: Partial<
    Record<AgentCapabilityCascadeKind, ComposeConversationStartCascadeInput>
  > = {};
  const failedCascadeKinds: AgentCapabilityCascadeKind[] = [];

  if (input.backend === "claude") {
    try {
      const skills = await discoverClaudeSkills({
        worktreePath: input.worktreePath,
        home,
        runtimeProbe: getClaudeRuntimeProbe(input.conversationId),
      });
      discoveryByCascade["claude-skills"] = {
        items: skills.items,
        diagnostics: skills.diagnostics,
      };
    } catch (err) {
      logger.error("discovery.claude_skills_failed", {
        worktreePath: input.worktreePath,
        error: redactAgentCapabilityText(getErrorMessage(err)),
      });
      failedCascadeKinds.push("claude-skills");
    }

    let nativePluginRecords:
      | Awaited<ReturnType<typeof discoverClaudePlugins>>["nativeRecords"]
      | undefined;
    try {
      const plugins = await discoverClaudePlugins({
        worktreePath: input.worktreePath,
        home,
      });
      discoveryByCascade["claude-plugins"] = {
        items: plugins.items,
        diagnostics: plugins.diagnostics,
      };
      nativePluginRecords = plugins.nativeRecords;
    } catch (err) {
      logger.error("discovery.claude_plugins_failed", {
        worktreePath: input.worktreePath,
        error: redactAgentCapabilityText(getErrorMessage(err)),
      });
      failedCascadeKinds.push("claude-plugins");
    }

    try {
      const agents = await discoverClaudeAgents({
        worktreePath: input.worktreePath,
        home,
        runtimeProbe: getClaudeRuntimeProbe(input.conversationId),
      });
      discoveryByCascade["claude-agents"] = {
        items: agents.items,
        diagnostics: agents.diagnostics,
      };
    } catch (err) {
      logger.error("discovery.claude_agents_failed", {
        worktreePath: input.worktreePath,
        error: redactAgentCapabilityText(getErrorMessage(err)),
      });
      failedCascadeKinds.push("claude-agents");
    }

    return composeConversationStartRuntime({
      backend: "claude",
      scope: {
        level: "conversation",
        projectName: input.projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      },
      overrideChain,
      discoveryByCascade,
      failedCascadeKinds,
      nativePluginRecords: nativePluginRecords ?? [],
    });
  }

  try {
    const skills = await discoverCodexSkillsCanonical({
      worktreePath: input.worktreePath,
      home,
    });
    discoveryByCascade["codex-skills"] = {
      items: skills.items,
      diagnostics: skills.diagnostics,
    };
  } catch (err) {
    logger.error("discovery.codex_skills_failed", {
      worktreePath: input.worktreePath,
      error: redactAgentCapabilityText(getErrorMessage(err)),
    });
    failedCascadeKinds.push("codex-skills");
  }

  try {
    const plugins = await discoverCodexPluginsCanonical({
      worktreePath: input.worktreePath,
      home,
    });
    discoveryByCascade["codex-plugins"] = {
      items: plugins.items,
      diagnostics: plugins.diagnostics,
    };
  } catch (err) {
    logger.error("discovery.codex_plugins_failed", {
      worktreePath: input.worktreePath,
      error: redactAgentCapabilityText(getErrorMessage(err)),
    });
    failedCascadeKinds.push("codex-plugins");
  }

  return composeConversationStartRuntime({
    backend: "codex",
    scope: {
      level: "conversation",
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
    },
    overrideChain,
    discoveryByCascade,
    failedCascadeKinds,
  });
}

async function defaultListAffectedConversations(input: {
  scope: MutationScope;
  cascadeKind: AgentCapabilityCascadeKind;
  changedItemIds: readonly string[];
}): Promise<readonly AffectedConversation[]> {
  const [state, globalOverrides] = await Promise.all([
    stateManager.readState(),
    defaultGlobalCapabilityOverrideStore.read(),
  ]);
  const affected: AffectedConversation[] = [];

  for (const [projectPath, project] of Object.entries(state.projects)) {
    if (
      input.scope.level === "project" &&
      input.scope.projectPath !== projectPath
    ) {
      continue;
    }
    if (
      (input.scope.level === "session" ||
        input.scope.level === "conversation") &&
      input.scope.projectPath !== projectPath
    ) {
      continue;
    }

    const projectName = getProjectDisplayName(projectPath);
    if (isProjectConversationMutationScope(input.scope)) {
      continue;
    }
    for (const session of Object.values(project.sessions)) {
      if (
        (input.scope.level === "session" ||
          isSessionConversationMutationScope(input.scope)) &&
        input.scope.sessionName !== session.sessionName
      ) {
        continue;
      }

      for (const conv of session.conversations) {
        if (
          isSessionConversationMutationScope(input.scope) &&
          input.scope.conversationId !== conv.id
        ) {
          continue;
        }

        const runtime = getRuntime(conv.id);
        if (!runtime || runtime.status !== "alive") continue;
        if (cascadeBackend(input.cascadeKind) !== runtime.backend) continue;
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

  return affected;
}

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
    async readRuntimeState(conv) {
      const session = await stateManager.getSession(
        conv.projectPath,
        conv.sessionName,
      );
      const conversation = session?.conversations.find(
        (c) => c.id === conv.conversationId,
      );
      return conversation?.agentCapabilitiesRuntime;
    },
    async writeRuntimeState(input) {
      await stateManager.mutateConversation(
        input.projectPath,
        input.sessionName,
        input.conversationId,
        "agent-capabilities.writeRuntimeState",
        (conversation) => {
          conversation.agentCapabilitiesRuntime = input.state;
        },
      );
    },
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
