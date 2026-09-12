import { cursorAgentStorePath } from "./store-path";
import { createCursorTaskRunner } from "./task-runner";
import type { AgentTaskRunner } from "../task";
import { createCursorContinuityBindingResolver } from "./continuity-binding";
import { getConversation, getSession } from "@/lib/state-store";
import os from "node:os";
import { rm } from "node:fs/promises";
import { getPublishedManagedSkillBundle } from "@/lib/managed-skills/service";
import { prepareCursorCapabilityDelivery } from "./capability-delivery";
/**
 * Production bindings for the Cursor adapter's dependency-injected seams.
 *
 * Every Cursor module below this file takes its collaborators as parameters so
 * the conformance suite and the adapter's own tests can drive the REAL runtime,
 * continuity, classifier, and projection logic against scripted ports. This
 * module is the one place that binds those seams to the real OS: the supervised
 * worker transport, the Command Center-owned agent store, the global
 * configuration read, and the production bounds.
 *
 * It is server-only. `registry.ts` is its sole importer.
 */

import { randomUUID } from "node:crypto";

import { readConfig } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { readRepoConfig } from "@/lib/projects/repo-config";

import type { ConversationBackendFactory } from "../conversation";
import type { BackendContinuityAdapter } from "../continuity";
import { assertCursorRuntimePolicy } from "./runtime-policy";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "../schemas";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { createCursorContinuityAdapter } from "./continuity";
import {
  CursorConversationRuntime,
  CURSOR_RUNTIME_DEFAULT_BOUNDS,
} from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import {
  createCursorModelCatalogFacet,
  loadGeneratedCursorModelCatalog,
} from "./model-catalog";
import {
  createCursorSupportedModelsReader,
  validateCursorModelSelectionForProject,
  type CursorModelSelectionResolution,
} from "./model-policy";
import { createProductionCursorWorkerTransport } from "./worker/supervisor";
import type { CursorWorkerTransport } from "./worker-port";

const logger = createLogger("cursor:production-wiring");

/**
 * One supervisor for the whole server: it owns the active-worker registry that
 * makes "a worker already serves this conversation" answerable, and two
 * supervisors would each believe the other's workers do not exist.
 */
let transport: CursorWorkerTransport | null = null;

function productionTransport(): CursorWorkerTransport {
  transport ??= createProductionCursorWorkerTransport();
  return transport;
}

/**
 * The global Cursor profile's complete selection. Read per validation rather
 * than cached because the profile is editable at runtime.
 */
async function globalProfileSelection(): Promise<BackendModelSelection> {
  const config = await readConfig();
  return config.agentBackends.cursor.modelSelection;
}

/**
 * The project's configured supported-model list (D10), read per resolution from
 * the project's `CommandCenter.json` — an operator editing the list must not
 * have to restart the server for the next turn to honour it.
 *
 * Null means "this project configures none", which the model policy reads as
 * the descriptor default list — the documented unconfigured behavior, not a
 * substitution.
 */
const projectSupportedModels =
  createCursorSupportedModelsReader(readRepoConfig);

export const cursorModelCatalog = createCursorModelCatalogFacet({
  loadCatalog: loadGeneratedCursorModelCatalog,
  supportedModels: projectSupportedModels,
});

export function resolveCursorModelForProduction(
  projectPath: string,
  selection: BackendModelSelection,
): Promise<CursorModelSelectionResolution> {
  return globalProfileSelection().then((configuredSelection) =>
    validateCursorModelSelectionForProject(
      { projectPath, selection, configuredSelection },
      { modelCatalog: cursorModelCatalog },
    ),
  );
}

export const cursorConversationBackendFactory: ConversationBackendFactory = {
  backend: CURSOR_BACKEND_ID,

  /**
   * Shape only. Exact variant and project-allowlist validation needs the
   * project-effective catalog and therefore belongs to the asynchronous hook.
   */
  validateModelSelection(selection): void {
    backendModelSelectionSchema.parse(selection);
  },

  async validateProjectModelSelection(input) {
    const resolution = await resolveCursorModelForProduction(
      input.projectPath,
      input.modelSelection,
    );
    if (resolution.ok) {
      return { ok: true, modelSelection: resolution.selection };
    }

    logger.warn("model_selection.rejected", {
      backend: CURSOR_BACKEND_ID,
      code: resolution.code,
      modelId: resolution.modelId,
      ...(resolution.parameterId !== undefined
        ? { parameterId: resolution.parameterId }
        : {}),
    });
    return {
      ok: false,
      code: resolution.code,
      message: resolution.message,
      modelId: resolution.modelId,
      ...(resolution.parameterId !== undefined
        ? { parameterId: resolution.parameterId }
        : {}),
    };
  },

  /**
   * Both fields come from ONE resolution, so what a surface offers and what it
   * would run by default can never disagree. A project whose configuration is
   * unreadable or permits nothing reports an empty list and no default rather
   * than the descriptor's — the creation surface then has to ask.
   */
  async resolveProjectModelOptions(input) {
    const configuredSelection = await globalProfileSelection();
    try {
      const catalog = await cursorModelCatalog.getCatalog({
        projectPath: input.projectPath,
        configuredSelection,
      });
      return {
        models: catalog.models.map(({ id }) => id),
        defaultModelId: catalog.defaultModelId,
      };
    } catch {
      return { models: [], defaultModelId: null };
    }
  },

  async createRuntime(input) {
    assertCursorRuntimePolicy(input);
    logger.info("cursor-factory.create_runtime", {
      conversationId: input.conversationId,
      modelId: input.modelSelection.modelId,
    });

    const capabilityDelivery = await prepareCursorCapabilityDelivery({
      worktreePath: input.worktreePath,
      home: os.homedir(),
      storePath: cursorAgentStorePath(input.conversationId),
      bundle: getPublishedManagedSkillBundle(),
      resumed: input.persistedRef !== null,
      hermetic: false,
      resolved: input.tooling.capabilities ?? { backend: "cursor", kinds: [] },
    });
    return new CursorConversationRuntime(input, {
      capabilityDelivery,
      transport: productionTransport(),
      storePath: cursorAgentStorePath,
      resolveModel: (selection) =>
        resolveCursorModelForProduction(input.projectPath, selection),
      translatePortableMcpToCursor,
      newRunId: () => randomUUID(),
      now: () => Date.now(),
      ...CURSOR_RUNTIME_DEFAULT_BOUNDS,
    });
  },
};

export function createProductionCursorContinuityAdapter(): BackendContinuityAdapter {
  return createCursorContinuityAdapter({
    transport: productionTransport(),
    resolveBinding: createCursorContinuityBindingResolver({
      getConversation,
      getSession,
      storePath: cursorAgentStorePath,
      resolveModel: (selection, projectPath) =>
        resolveCursorModelForProduction(projectPath, selection),
    }),
  });
}

export const cursorTaskRunner: AgentTaskRunner = {
  backend: "cursor",
  run(input) {
    return createCursorTaskRunner({
      removeStore: (id) =>
        rm(cursorAgentStorePath(id), { recursive: true, force: true }),
      transport: productionTransport(),
      storePath: cursorAgentStorePath,
      resolveModel: (selection, cwd) =>
        resolveCursorModelForProduction(cwd, selection),
      translatePortableMcpToCursor,
      newRunId: randomUUID,
      now: Date.now,
      ...CURSOR_RUNTIME_DEFAULT_BOUNDS,
      prepareCapabilities: (request, storePath) =>
        prepareCursorCapabilityDelivery({
          worktreePath: request.workingDirectory,
          home: os.homedir(),
          storePath,
          bundle: getPublishedManagedSkillBundle(),
          resumed:
            request.resumeRef != null &&
            request.executionProfile !== "isolated-one-shot",
          hermetic: request.executionProfile === "isolated-one-shot",
          resolved: request.tooling?.capabilities ?? {
            backend: "cursor",
            kinds: [],
          },
        }),
    }).run(input);
  },
};

/** Test seam: drop the memoized supervisor so a suite starts from no workers. */
export function _resetCursorProductionTransportForTesting(): void {
  transport = null;
}
