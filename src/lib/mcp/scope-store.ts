import { createLogger } from "@/lib/logging";
import type { McpOverrideOperation, McpOverrides } from "@/lib/schemas";
import { createStateManager } from "@/lib/state";

import { applyOperations } from "./overrides-patch";

const logger = createLogger("mcp.override-store");

type StateManager = ReturnType<typeof createStateManager>;

export interface ScopeOverrideStoreDeps {
  stateManager: StateManager;
}

interface ScopeOverridePatchResult {
  overrides: McpOverrides;
  changedServerKeys: readonly string[];
}

export interface ScopeOverrideStore {
  patchProject(
    projectPath: string,
    operations: readonly McpOverrideOperation[],
  ): Promise<ScopeOverridePatchResult>;
  patchSession(
    projectPath: string,
    sessionName: string,
    operations: readonly McpOverrideOperation[],
  ): Promise<ScopeOverridePatchResult>;
  patchConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    operations: readonly McpOverrideOperation[],
  ): Promise<ScopeOverridePatchResult>;
}

export function createScopeOverrideStore(
  deps: ScopeOverrideStoreDeps,
): ScopeOverrideStore {
  const { stateManager } = deps;

  async function patchProject(
    projectPath: string,
    operations: readonly McpOverrideOperation[],
  ): Promise<ScopeOverridePatchResult> {
    return stateManager.mutateState(
      `mcp.patchProject[${projectPath}]`,
      (state) => {
        const project = state.projects[projectPath];
        if (!project) {
          throw new Error(`Project "${projectPath}" not found`);
        }
        const result = patchAndPrune(project.mcpOverrides, operations);
        writeOrDelete(project, "mcpOverrides", result.overrides);
        logPatch("project", projectPath, result.changedServerKeys);
        return result;
      },
    );
  }

  async function patchSession(
    projectPath: string,
    sessionName: string,
    operations: readonly McpOverrideOperation[],
  ): Promise<ScopeOverridePatchResult> {
    return stateManager.mutateSession(
      projectPath,
      sessionName,
      "mcp.patchSession",
      (session) => {
        const result = patchAndPrune(session.mcpOverrides, operations);
        writeOrDelete(session, "mcpOverrides", result.overrides);
        logPatch(
          "session",
          `${projectPath}/${sessionName}`,
          result.changedServerKeys,
        );
        return result;
      },
    );
  }

  async function patchConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    operations: readonly McpOverrideOperation[],
  ): Promise<ScopeOverridePatchResult> {
    return stateManager.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "mcp.patchConversation",
      (conversation) => {
        const result = patchAndPrune(conversation.mcpOverrides, operations);
        writeOrDelete(conversation, "mcpOverrides", result.overrides);
        logPatch(
          "conversation",
          `${projectPath}/${sessionName}/${conversationId}`,
          result.changedServerKeys,
        );
        return result;
      },
    );
  }

  return { patchProject, patchSession, patchConversation };
}

/**
 * Apply the override operations against the current scope overrides and strip
 * the field entirely when no servers remain — keeping per-scope state slim.
 */
function patchAndPrune(
  current: McpOverrides | undefined,
  operations: readonly McpOverrideOperation[],
): ScopeOverridePatchResult {
  const base: McpOverrides = current ?? { servers: {} };
  return applyOperations(base, operations);
}

function writeOrDelete<T extends { mcpOverrides?: McpOverrides }>(
  target: T,
  field: "mcpOverrides",
  value: McpOverrides,
): void {
  if (Object.keys(value.servers).length === 0) {
    delete target[field];
    return;
  }
  target[field] = value;
}

function logPatch(
  scope: "project" | "session" | "conversation",
  id: string,
  changedServerKeys: readonly string[],
): void {
  logger.info(`${scope}.patch`, {
    id,
    changedCount: changedServerKeys.length,
  });
}

/**
 * Default singleton backed by the default state manager.
 * Tests should inject their own state manager via `createScopeOverrideStore`.
 */
export const defaultScopeOverrideStore: ScopeOverrideStore =
  createScopeOverrideStore({ stateManager: createStateManager() });
