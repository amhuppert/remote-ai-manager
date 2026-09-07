import { discoverCursorCapabilities } from "./cursor-discovery";
import {
  createCapabilityConfigComposer,
  promoteSeededRuntimeState,
  projectConversationDiagnosticsSeed,
  type ComposedProjectConversationCapabilitySeed,
} from "./runtime-seed";
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
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";
import type {
  ResolvedCapabilityCascade,
  RuntimeConfigApplyResult,
} from "@/lib/agent-backends/runtime-config";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { getStateStore } from "@/lib/state-store";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  decodeCascadeKind,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeLayer,
  type AgentCapabilityOverrides,
  type AgentCapabilityRuntimeApplicationState,
  type AgentCapabilityScopeContext,
} from "./schemas";

import { defaultGlobalCapabilityOverrideStore } from "./global-store";
import {
  discoverClaudeAgents,
  discoverClaudePlugins,
  discoverClaudeSkills,
  getClaudeRuntimeProbe,
} from "./claude-discovery";
import {
  discoverCodexPluginsCanonical,
  discoverCodexSkillsCanonical,
} from "./codex-discovery";
import {
  composeConversationStartRuntime,
  ownedCascadesForBackend,
  type ComposeConversationStartCascadeInput,
  type ComposeConversationStartInput,
  type ComposeConversationStartResult,
} from "./runtime-composer";
import {
  createCapabilityRuntimeApplyService,
  type AffectedConversation,
  type ApplyConversationIdentity,
  type CapabilityRuntimeApplyService,
} from "./apply";

import {
  createCapabilityMutationService,
  type CapabilityMutationService,
  type MutationScope,
} from "./mutation-service";
import { redactAgentCapabilityText } from "./redaction";
import { defaultScopeCapabilityOverrideStore } from "./scope-store";

const logger = createLogger("agent-capabilities.default-deps");
const stateManager = getStateStore();

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

/**
 * Explicit per-cascade discovery seam. Each persisted cascade kind maps to
 * one provider; the composer selects providers by walking the backend's
 * descriptor-declared cascades (`ownedCascadesForBackend`) — never by
 * branching on backend identity. Providers own their backend-specific
 * inputs internally (e.g. the Claude live-runtime probe), so the composer
 * hands every provider the same neutral input.
 *
 * The interface lives here rather than on the backend descriptor because
 * discovery is expressed in this domain's vocabulary
 * (`AgentCapabilityDiscoveredItem`/diagnostics) and `agent-backends` must not
 * import `agent-capabilities`; population is the bootstrap-style data table
 * below (`defaultDiscoveryProviders`), keyed exhaustively by the persisted
 * cascade-kind enum so declaring a new backend's cascades forces a provider
 * entry at compile time.
 */
export interface CascadeDiscoveryInput {
  worktreePath: string;
  home: string;
  conversationId: string;
}

export interface CascadeDiscoveryProvider {
  discover(
    input: CascadeDiscoveryInput,
  ): Promise<ComposeConversationStartCascadeInput>;
}

export interface ConversationStartCapabilityComposerDeps {
  readGlobalOverrides(): Promise<AgentCapabilityOverrides | undefined>;
  getProjectAgentCapabilityOverrides(
    projectPath: string,
  ): Promise<AgentCapabilityOverrides | undefined>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{
    agentCapabilityOverrides?: AgentCapabilityOverrides;
    conversations: readonly ConversationState[];
  } | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  getDiscoveryProvider(
    cascadeKind: AgentCapabilityCascadeKind,
  ): CascadeDiscoveryProvider | undefined;
  composeRuntime(
    input: ComposeConversationStartInput,
  ): ComposeConversationStartResult;
  homeDir(): string;
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
    {
      layer: "project",
      overrides: await deps.getProjectAgentCapabilityOverrides(
        scope.projectPath,
      ),
    },
  ];

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

  const session = await deps.getSession(scope.projectPath, scope.sessionName);
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

    for (const { cascadeKind } of ownedCascadesForBackend(input.backend)) {
      const provider = deps.getDiscoveryProvider(cascadeKind);
      if (!provider) {
        // A declared cascade without a discovery provider is a wiring gap,
        // not an empty source: mark it failed so the apply layer surfaces a
        // retryable rejection instead of silently composing native defaults.
        logDiscoveryFailure(deps, {
          event: "discovery.provider_missing",
          backend: input.backend,
          cascadeKind,
          conversationScope,
          worktreePath: input.worktreePath,
          error: `no discovery provider registered for cascade '${cascadeKind}'`,
        });
        failedCascadeKinds.push(cascadeKind);
        continue;
      }
      try {
        const discovered = await provider.discover({
          worktreePath: input.worktreePath,
          home,
          conversationId: input.conversationId,
        });
        discoveryByCascade[cascadeKind] = {
          items: discovered.items,
          diagnostics: discovered.diagnostics,
        };
      } catch (err) {
        logDiscoveryFailure(deps, {
          event: "discovery.cascade_failed",
          backend: input.backend,
          cascadeKind,
          conversationScope,
          worktreePath: input.worktreePath,
          error: getErrorMessage(err),
        });
        failedCascadeKinds.push(cascadeKind);
      }
    }

    return deps.composeRuntime({
      backend: input.backend,
      scope: scopeContextForComposeInput(input),
      overrideChain,
      discoveryByCascade,
      failedCascadeKinds,
    });
  };
}

/**
 * Production discovery providers, one per persisted cascade kind. Exhaustive
 * over the enum: adding a cascade kind (the schema edit that admits a new
 * backend's cascades) fails compilation here until its provider is wired.
 */
const defaultDiscoveryProviders: Readonly<
  Record<AgentCapabilityCascadeKind, CascadeDiscoveryProvider>
> = {
  "claude-skills": {
    discover: (input) =>
      discoverClaudeSkills({
        worktreePath: input.worktreePath,
        home: input.home,
        runtimeProbe: getClaudeRuntimeProbe(input.conversationId),
      }),
  },
  "claude-plugins": {
    discover: (input) =>
      discoverClaudePlugins({
        worktreePath: input.worktreePath,
        home: input.home,
      }),
  },
  "claude-agents": {
    discover: (input) =>
      discoverClaudeAgents({
        worktreePath: input.worktreePath,
        home: input.home,
        runtimeProbe: getClaudeRuntimeProbe(input.conversationId),
      }),
  },
  "cursor-skills": {
    discover: (input) => discoverCursorCapabilities(input, "skills"),
  },
  "cursor-plugins": {
    discover: (input) => discoverCursorCapabilities(input, "plugins"),
  },
  "cursor-agents": {
    discover: (input) => discoverCursorCapabilities(input, "agents"),
  },
  "codex-skills": {
    discover: (input) =>
      discoverCodexSkillsCanonical({
        worktreePath: input.worktreePath,
        home: input.home,
      }),
  },
  "codex-plugins": {
    discover: (input) =>
      discoverCodexPluginsCanonical({
        worktreePath: input.worktreePath,
        home: input.home,
      }),
  },
};

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

export const defaultComposeForConversation =
  createConversationStartCapabilityComposer({
    readGlobalOverrides: () => defaultGlobalCapabilityOverrideStore.read(),
    getProjectAgentCapabilityOverrides: (projectPath) =>
      stateManager.getProjectAgentCapabilityOverrides(projectPath),
    getSession: (projectPath, sessionName) =>
      stateManager.getSession(projectPath, sessionName),
    getProjectConversation: (projectPath, conversationId) =>
      stateManager.getProjectConversation(projectPath, conversationId),
    getDiscoveryProvider: (cascadeKind) =>
      defaultDiscoveryProviders[cascadeKind],
    composeRuntime: composeConversationStartRuntime,
    homeDir: () => os.homedir(),
    logDiscoveryFailure(input) {
      logger.error(input.event, {
        backend: input.backend,
        cascadeKind: input.cascadeKind,
        conversationScope: input.conversationScope,
        worktreePath: input.worktreePath,
        error: input.error,
      });
    },
  });

interface RuntimeSnapshot {
  status: "alive" | "dead";
  backend: AgentBackendId;
  isTurnActive?: boolean;
}

export interface AffectedConversationListerDeps {
  listProjectPaths(): Promise<readonly string[]>;
  getProjectSessions(projectPath: string): Promise<
    readonly {
      sessionName: string;
      worktreePath: string;
      agentCapabilityOverrides?: AgentCapabilityOverrides;
      conversations: readonly ConversationState[];
    }[]
  >;
  getProjectAgentCapabilityOverrides(
    projectPath: string,
  ): Promise<AgentCapabilityOverrides | undefined>;
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
    // Memoize each affected project's overrides so the session fanout and the PLC
    // fanout share one focused read per project. Scoped to this invocation, not
    // the factory: a memo that outlived one fanout would mask a later fanout with
    // stale project rules after an intervening override mutation.
    const projectOverridesCache = new Map<
      string,
      AgentCapabilityOverrides | undefined
    >();
    async function projectOverridesFor(
      projectPath: string,
    ): Promise<AgentCapabilityOverrides | undefined> {
      if (!projectOverridesCache.has(projectPath)) {
        projectOverridesCache.set(
          projectPath,
          await deps.getProjectAgentCapabilityOverrides(projectPath),
        );
      }
      return projectOverridesCache.get(projectPath);
    }

    const globalOverrides = await deps.readGlobalOverrides();
    const affected: AffectedConversation[] = [];

    // The session fanout reaches every project for a global change, otherwise
    // only the scoped project; a project-conversation change skips it entirely.
    if (!isProjectConversationMutationScope(input.scope)) {
      const sessionFanoutProjectPaths =
        input.scope.level === "global"
          ? await deps.listProjectPaths()
          : [input.scope.projectPath];

      for (const projectPath of sessionFanoutProjectPaths) {
        if (!scopeCanAffectProject(input.scope, projectPath)) continue;

        const projectName = deps.getProjectDisplayName(projectPath);
        const projectOverrides = await projectOverridesFor(projectPath);
        const sessions = await deps.getProjectSessions(projectPath);
        for (const session of sessions) {
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
                  project: projectOverrides,
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
              isTurnActive: runtime.isTurnActive === true,
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
      const projectOverrides = await projectOverridesFor(projectPath);
      if (
        !mutationAffectsConversationRuntime({
          scope: input.scope,
          cascadeKind: input.cascadeKind,
          changedItemIds: input.changedItemIds,
          overrideChain: {
            global: globalOverrides,
            project: projectOverrides,
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
        isTurnActive: runtime.isTurnActive === true,
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
  listProjectPaths: () => stateManager.listProjectPaths(),
  getProjectSessions: (projectPath) =>
    stateManager.getProjectSessions(projectPath),
  getProjectAgentCapabilityOverrides: (projectPath) =>
    stateManager.getProjectAgentCapabilityOverrides(projectPath),
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
  return decodeCascadeKind(cascadeKind).backend;
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
      return runtime?.isTurnActive === true;
    },
    composeForConversation: defaultComposeForConversation,
    readRuntimeState: defaultRuntimeStateAccessors.readRuntimeState,
    writeRuntimeState: defaultRuntimeStateAccessors.writeRuntimeState,
    applyRuntimeConfig: applyRuntimeConfigToConversationRuntime,
  });

/**
 * Default runtime-config apply port: resolves the conversation's live runtime
 * and its backend descriptor, then hands both to the descriptor's neutral
 * runtime-config adapter. Provider translation happens inside the adapter.
 */
export async function applyRuntimeConfigToConversationRuntime(input: {
  conversation: ApplyConversationIdentity;
  resolved: ResolvedCapabilityCascade;
}): Promise<RuntimeConfigApplyResult> {
  const runtime = getRuntime(input.conversation.conversationId);
  if (!runtime) {
    return { status: "rejected", error: "runtime not registered" };
  }
  if (runtime.backend !== input.conversation.backend) {
    return {
      status: "rejected",
      error: `runtime backend '${runtime.backend}' does not match conversation backend '${input.conversation.backend}'`,
    };
  }
  const descriptor = getBackendDescriptor(runtime.backend);
  const adapter = descriptor.conversation?.runtimeConfig;
  if (!adapter) {
    return {
      status: "rejected",
      error: `backend '${runtime.backend}' has no conversation runtime-config adapter`,
    };
  }
  return adapter.apply({ runtime, resolved: input.resolved });
}

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

    if (result.capabilities.kinds.length === 0) {
      return projectConversationDiagnosticsSeed(backend, result);
    }
    return {
      backend,
      capabilities: result.capabilities,
      diagnostics: result.diagnostics,
      runtimeState: promoteSeededRuntimeState(result.runtimeState),
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

/** @public Accessed via dynamic `import()` in actor-implementations. */
export const composeCapabilityConfigForConversation =
  createCapabilityConfigComposer(defaultComposeForConversation);

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
