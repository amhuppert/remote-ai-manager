/**
 * Dynamic help-context providers (docs/design/cc-cli/04 §4.3).
 *
 * Each provider owns one top-level command prefix (`dev`, `workflow`, …), reads
 * existing services/repos through injected deps, never mutates, and returns `[]`
 * when it has nothing worth saying — an absent context must not render an empty
 * section. The service (`service.ts`) resolves the calling command's first path
 * segment to a provider in this map, so a broken or slow provider is isolated to
 * its own prefix.
 *
 * The provider factories are pure given their injected deps (no server imports
 * except erased types); the production deps wiring lives in `provider-deps.ts`
 * so this module stays light and directly unit-testable.
 */
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "@/lib/workflow-graph/constants";
import type { DevServerStatusItem } from "@/lib/dev-server/service";
import type { ArtifactKind } from "@/lib/context-artifacts/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";

import type { HelpContextBlock } from "./schemas";

/**
 * The resolved identity + command a provider inspects. `command` is the command
 * path split into segments (e.g. ["workflow","create"]); the identity fields are
 * present only when the caller forwarded them.
 */
export interface HelpContextRequest {
  command: string[];
  project?: string;
  session?: string;
  conversation?: string;
  executionId?: string;
  contextId?: string;
}

/**
 * A read-only provider of dynamic help-context blocks for one command prefix.
 * Method syntax (not a property) so parameter checking stays bivariant when a
 * concrete provider is assigned to this slot (engineering-principles).
 */
export interface HelpContextProvider {
  provide(request: HelpContextRequest): Promise<HelpContextBlock[]>;
}

/** Prefix → provider, keyed by the command's first path segment. */
export type HelpContextProviderMap = Map<string, HelpContextProvider>;

/** One artifact's freshness, as the conversation provider needs it. */
export interface ConversationArtifactSummary {
  kind: ArtifactKind;
  /** The transcript advanced past the artifact's covered range. */
  stale: boolean;
  /** The generator improved since the artifact was made (version drift). */
  outdated: boolean;
}

// --- Deps slices (method syntax → bivariant params) -------------------------

/** Dev-server reads, shared by the `dev` and `fixture` providers. */
export interface DevServerHelpDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  listDevServers(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<DevServerStatusItem[]>;
}

/** Graph-workflow execution read for the `workflow` provider. */
export interface WorkflowHelpDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
}

/** Compaction-artifact read for the `conversation` provider. */
export interface ConversationHelpDeps {
  resolveConversationArtifacts(input: {
    conversationId: string;
    project?: string;
    session?: string;
  }): Promise<ConversationArtifactSummary[]>;
}

/** The union every v1 provider draws from; `buildHelpContextProviders` takes it whole. */
export interface HelpContextProviderDeps
  extends DevServerHelpDeps, WorkflowHelpDeps, ConversationHelpDeps {}

// --- Providers --------------------------------------------------------------

function devServerLine(server: DevServerStatusItem): string {
  const local = server.localUrl ?? "no local URL";
  const remote = server.remoteUrl ? ` · remote ${server.remoteUrl}` : "";
  return `${server.serverName} — ${server.status} — ${local}${remote}`;
}

/**
 * `dev` — the calling session's configured dev servers (name, status, local +
 * remote URL). `[]` when the project configures none, or the caller lacks a
 * project/session identity to scope the read.
 */
export function createDevProvider(
  deps: DevServerHelpDeps,
): HelpContextProvider {
  return {
    async provide(request) {
      if (!request.project || !request.session) return [];
      const projectPath = await deps.resolveProjectPath(request.project);
      if (!projectPath) return [];
      const servers = await deps.listDevServers({
        projectPath,
        sessionName: request.session,
      });
      if (servers.length === 0) return [];
      return [
        { title: "dev servers", body: servers.map(devServerLine).join("\n") },
      ];
    },
  };
}

/**
 * `fixture` — a fixture is useless without a running dev server, so this surfaces
 * whether one is up. `[]` when the project configures none; one line pointing at
 * the running URL, or at `cctl dev ensure` when configured-but-stopped.
 */
export function createFixtureProvider(
  deps: DevServerHelpDeps,
): HelpContextProvider {
  return {
    async provide(request) {
      if (!request.project || !request.session) return [];
      const projectPath = await deps.resolveProjectPath(request.project);
      if (!projectPath) return [];
      const servers = await deps.listDevServers({
        projectPath,
        sessionName: request.session,
      });
      if (servers.length === 0) return [];
      const running = servers.find((s) => s.status === "running");
      const body = running
        ? `${running.serverName} is running at ${running.localUrl ?? "the local URL"} — fixtures can drive it`
        : "no dev server is running — run 'cctl dev ensure' before driving fixtures";
      return [{ title: "fixture dev server", body }];
    },
  };
}

/** The in-progress task's title for a context, or null when none is running. */
function currentTaskTitle(
  execution: GraphWorkflowExecution,
  contextId: string,
): string | null {
  const running = Object.values(execution.taskStates).find(
    (task) => task.contextId === contextId && task.status === "running",
  );
  if (!running) return null;
  const def = execution.workingDefinition.tasks.find(
    (task) => task.id === running.taskId,
  );
  return def?.title ?? null;
}

/**
 * `workflow` — lane identity, current task, remaining tasks, iteration budget vs
 * the circuit-breaker threshold, and a reminder that lane-only verbs exist. Only
 * fires inside a lane: `[]` unless BOTH executionId and contextId are present and
 * resolve to the session's active execution.
 */
export function createWorkflowProvider(
  deps: WorkflowHelpDeps,
): HelpContextProvider {
  return {
    async provide(request) {
      if (!request.executionId || !request.contextId) return [];
      if (!request.project || !request.session) return [];
      const projectPath = await deps.resolveProjectPath(request.project);
      if (!projectPath) return [];
      const execution = await deps.getActiveGraphWorkflowExecution(
        projectPath,
        request.session,
      );
      if (!execution || execution.id !== request.executionId) return [];

      const contextState = execution.contextStates[request.contextId];
      if (!contextState) return [];
      const contextDef = execution.workingDefinition.executionContexts.find(
        (c) => c.id === request.contextId,
      );

      const threshold =
        contextDef?.circuitBreaker.consecutiveFailureThreshold ??
        DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
      const remaining = Math.max(
        0,
        contextState.totalTaskCount - contextState.completedTaskCount,
      );
      const title = currentTaskTitle(execution, request.contextId);

      const body = [
        `lane: ${contextDef?.title ?? request.contextId}`,
        `current task: ${title ?? "none in progress"}`,
        `remaining tasks: ${remaining}`,
        `iterations: ${contextState.iterationCount} of ${threshold} before the circuit breaker halts`,
        "lane-only verbs: cctl workflow task complete/add, shared-doc upsert, collab request",
      ].join("\n");
      return [{ title: "workflow lane", body }];
    },
  };
}

/**
 * `conversation` — the caller's conversation id and whether compaction artifacts
 * exist for it (and whether any are stale). `[]` without a conversation param.
 */
export function createConversationProvider(
  deps: ConversationHelpDeps,
): HelpContextProvider {
  return {
    async provide(request) {
      if (!request.conversation) return [];
      const artifacts = await deps.resolveConversationArtifacts({
        conversationId: request.conversation,
        ...(request.project !== undefined ? { project: request.project } : {}),
        ...(request.session !== undefined ? { session: request.session } : {}),
      });

      const lines = [`conversation: ${request.conversation}`];
      if (artifacts.length === 0) {
        lines.push(
          "no compaction artifacts yet — 'cctl conversation compact' creates one",
        );
      } else {
        const staleCount = artifacts.filter(
          (a) => a.stale || a.outdated,
        ).length;
        lines.push(
          staleCount > 0
            ? `${artifacts.length} compaction artifact(s), ${staleCount} stale — refresh with 'cctl conversation compact'`
            : `${artifacts.length} compaction artifact(s), all fresh`,
        );
      }
      return [{ title: "conversation", body: lines.join("\n") }];
    },
  };
}

/**
 * Build the prefix→provider map for production wiring. Keyed by the command's
 * first path segment (docs/design/cc-cli/04 §4.3).
 */
export function buildHelpContextProviders(
  deps: HelpContextProviderDeps,
): HelpContextProviderMap {
  return new Map<string, HelpContextProvider>([
    ["dev", createDevProvider(deps)],
    ["fixture", createFixtureProvider(deps)],
    ["workflow", createWorkflowProvider(deps)],
    ["conversation", createConversationProvider(deps)],
  ]);
}
