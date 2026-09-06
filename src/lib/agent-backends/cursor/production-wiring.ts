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
import path from "node:path";

import { getConfigDirPath, readConfig } from "@/lib/config/loader";
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
import {
  createCursorContinuityAdapter,
  type CursorContinuityBinding,
} from "./continuity";
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
 * The Command Center-owned root for a conversation's SDK agent store. Under the
 * CC config directory rather than the worktree, so a ref survives worktree
 * removal and the SDK never writes into a repository checkout.
 */
export function cursorAgentStorePath(conversationId: string): string {
  return path.join(getConfigDirPath(), "cursor", "agents", conversationId);
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

    return new CursorConversationRuntime(input, {
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

/**
 * A continuity probe needs the cwd, agent store, and model the ref was minted
 * under; the neutral `ContinuityContext` carries only a project path and
 * session name. In Phase 1 no production caller needs that binding: an ordinary
 * conversation resumes through its own runtime's persisted ref, synthetic forks
 * read only the CC transcript, and the
 * workflow and collaboration surfaces that call `start`/`validate`/
 * `resumeOrRecover` are refused for Cursor by facet gating.
 *
 * So this fails closed rather than guessing a store: a probe run against the
 * wrong store would report a perfectly valid ref as missing, and a wrong
 * "not_found" is worse than a bounded refusal that names the gap.
 */
export function createProductionCursorContinuityAdapter(): BackendContinuityAdapter {
  return createCursorContinuityAdapter({
    transport: productionTransport(),
    resolveBinding: (): Promise<CursorContinuityBinding> =>
      Promise.reject(
        new Error(
          "Cursor continuity probes need a conversation-scoped cwd and agent store; no Phase 1 caller supplies one.",
        ),
      ),
  });
}

/** Test seam: drop the memoized supervisor so a suite starts from no workers. */
export function _resetCursorProductionTransportForTesting(): void {
  transport = null;
}
