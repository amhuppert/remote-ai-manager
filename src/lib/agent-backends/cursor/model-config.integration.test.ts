import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRepoConfig } from "@/lib/projects/repo-config";

import type { ConversationBackendCreateInput } from "../conversation";
import { defaultSelectionForModel } from "../model-selection";
import type { BackendModelSelection } from "../schemas";
import { CursorConversationRuntime } from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import {
  createCursorModelCatalogFacet,
  loadGeneratedCursorModelCatalog,
} from "./model-catalog";
import {
  CURSOR_DEFAULT_MODEL,
  createCursorSupportedModelsReader,
  validateCursorModelSelectionForProject,
} from "./model-policy";
import { cursorConversationBackendFactory } from "./production-wiring";
import {
  createScriptedTransport,
  type ScriptedWorkerOptions,
} from "./testing/scripted-worker";

/**
 * The per-repo supported-model list end to end (spec D10): a real
 * `CommandCenter.json` on disk, the real repo-config reader and per-repo
 * schema, the real model policy, and the real conversation runtime. The only
 * scripted seam is the worker transport, so "no worker spawned" is an
 * observation about production code rather than about a stub.
 */

const CONVERSATION_ID = "conv-cursor-models";
const GENERATED_MODEL_CATALOG = loadGeneratedCursorModelCatalog();
const DEFAULT_MODEL_SELECTION = defaultSelectionForModel(
  GENERATED_MODEL_CATALOG,
  CURSOR_DEFAULT_MODEL,
);
const DEFAULT_MODEL_ALIAS_SELECTION: BackendModelSelection = {
  ...DEFAULT_MODEL_SELECTION,
  modelId: "composer-2-5",
};
const CUSTOM_MODEL_SELECTION = defaultSelectionForModel(
  GENERATED_MODEL_CATALOG,
  "composer-2",
);
const UNLISTED_MODEL_SELECTION = defaultSelectionForModel(
  GENERATED_MODEL_CATALOG,
  "gpt-5.6-sol",
);
const ALL_GENERATED_MODEL_IDS = GENERATED_MODEL_CATALOG.models.map(
  ({ id }) => id,
);

let projectPath: string;

async function writeRepoConfig(config: unknown): Promise<void> {
  await writeFile(
    path.join(projectPath, "CommandCenter.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

beforeEach(async () => {
  projectPath = await mkdtemp(path.join(tmpdir(), "cursor-model-config-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

function createInput(): ConversationBackendCreateInput {
  return {
    executionClass: "ordinary-conversation" as const,
    conversationId: CONVERSATION_ID,
    projectPath,
    projectName: "repo",
    conversationTarget: {
      scope: "session",
      projectName: "repo",
      sessionName: "s1",
      conversationId: CONVERSATION_ID,
    },
    worktreePath: path.join(projectPath, ".worktrees/s1"),
    persistedRef: null,
    modelSelection: DEFAULT_MODEL_SELECTION,
    sessionInstructions: [],
    tooling: {},
  };
}

/**
 * The runtime wired to the production model-resolution chain — the project's
 * configured list read through `ConversationBackendCreateInput.projectPath` —
 * with the configured global selection injected, so the test does not depend
 * on the server's own configuration file.
 */
function createRuntimeOverRepoConfig(
  configuredSelection: BackendModelSelection = DEFAULT_MODEL_SELECTION,
  options: {
    worker?: ScriptedWorkerOptions;
    create?: Partial<ConversationBackendCreateInput>;
  } = {},
) {
  const transport = createScriptedTransport(options.worker);
  const input = { ...createInput(), ...options.create };
  const modelCatalog = createCursorModelCatalogFacet({
    loadCatalog: () => GENERATED_MODEL_CATALOG,
    supportedModels: createCursorSupportedModelsReader(readRepoConfig),
  });
  const runtime = new CursorConversationRuntime(input, {
    transport,
    storePath: (conversationId) => `/state/cursor/${conversationId}`,
    resolveModel: (selection) =>
      validateCursorModelSelectionForProject(
        { projectPath: input.projectPath, selection, configuredSelection },
        { modelCatalog },
      ),
    translatePortableMcpToCursor,
    newRunId: () => "run-1",
    now: () => 1_000,
    stallTimeoutMs: 50,
    cancelSettleTimeoutMs: 50,
  });

  return {
    transport,
    send: (modelSelection: BackendModelSelection = input.modelSelection) =>
      runtime.sendTurn({
        promptText: "do the thing",
        imageRefs: [],
        sessionInstructions: [],
        modelSelection,
        autonomous: false,
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
  };
}

describe("per-repo supported-model list enforced before a worker starts", () => {
  it("refuses a complete selection the project does not list", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: [CURSOR_DEFAULT_MODEL] } },
    });
    const harness = createRuntimeOverRepoConfig();

    const result = await harness.send(UNLISTED_MODEL_SELECTION);

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.message).toContain(UNLISTED_MODEL_SELECTION.modelId);
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("runs a complete variant the project lists", async () => {
    await writeRepoConfig({
      agentBackends: {
        cursor: {
          supportedModels: [
            CURSOR_DEFAULT_MODEL,
            CUSTOM_MODEL_SELECTION.modelId,
          ],
        },
      },
    });
    const harness = createRuntimeOverRepoConfig();

    const result = await harness.send(CUSTOM_MODEL_SELECTION);

    expect(result.failure).toBeNull();
    expect(harness.transport.startInputs[0]?.modelSelection).toEqual(
      CUSTOM_MODEL_SELECTION,
    );
    expect(
      harness.transport.workers[0]?.attachments[0]?.modelSelection,
    ).toEqual(CUSTOM_MODEL_SELECTION);
    expect(
      harness.transport.workers[0]?.turns[0]?.input.modelSelection,
    ).toEqual(CUSTOM_MODEL_SELECTION);
  });

  it("runs an explicitly allowed selection when the configured default is excluded", async () => {
    await writeRepoConfig({
      agentBackends: {
        cursor: { supportedModels: [CUSTOM_MODEL_SELECTION.modelId] },
      },
    });
    const harness = createRuntimeOverRepoConfig();

    const result = await harness.send(CUSTOM_MODEL_SELECTION);

    expect(result.failure).toBeNull();
    expect(harness.transport.startInputs[0]?.modelSelection).toEqual(
      CUSTOM_MODEL_SELECTION,
    );
  });

  it("refuses an applied configured selection outside the project's list", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: [CURSOR_DEFAULT_MODEL] } },
    });
    const harness = createRuntimeOverRepoConfig(CUSTOM_MODEL_SELECTION, {
      create: { modelSelection: CUSTOM_MODEL_SELECTION },
    });

    const result = await harness.send();

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.message).toContain(CUSTOM_MODEL_SELECTION.modelId);
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("uses the complete generated default when the project declares no list", async () => {
    const harness = createRuntimeOverRepoConfig();

    const result = await harness.send();

    expect(result.failure).toBeNull();
    expect(
      harness.transport.workers[0]?.turns[0]?.input.modelSelection,
    ).toEqual(DEFAULT_MODEL_SELECTION);
  });

  it("refuses a partial parameter record rather than filling it from defaults", async () => {
    const harness = createRuntimeOverRepoConfig();

    const result = await harness.send({
      modelId: CURSOR_DEFAULT_MODEL,
      parameters: {},
    });

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.message).toContain("fast");
    expect(harness.transport.startInputs).toHaveLength(0);
  });
});

/**
 * The registered factory must declare both model hooks: the project-scoped one
 * decides membership and the synchronous one guards the bundle shape.
 */
const { validateProjectModelSelection, validateModelSelection } =
  cursorConversationBackendFactory;
if (
  validateProjectModelSelection === undefined ||
  validateModelSelection === undefined
) {
  throw new Error("The Cursor factory declares no model validation hooks.");
}

describe("cursor factory project-scoped model validation", () => {
  it("refuses a shaped bundle absent from the generated catalog", async () => {
    await writeRepoConfig({
      agentBackends: {
        cursor: { supportedModels: ALL_GENERATED_MODEL_IDS },
      },
    });

    const validation = await validateProjectModelSelection({
      projectPath,
      modelSelection: {
        modelId: "not-in-generated-catalog",
        parameters: {},
      },
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.message).toContain("not-in-generated-catalog");
  });

  it("accepts a complete generated selection the project lists", async () => {
    await writeRepoConfig({
      agentBackends: {
        cursor: { supportedModels: ALL_GENERATED_MODEL_IDS },
      },
    });

    expect(
      await validateProjectModelSelection({
        projectPath,
        modelSelection: CUSTOM_MODEL_SELECTION,
      }),
    ).toEqual({
      ok: true,
      modelSelection: CUSTOM_MODEL_SELECTION,
    });
  });

  it("returns the canonical complete selection when it accepts an alias", async () => {
    await writeRepoConfig({
      agentBackends: {
        cursor: { supportedModels: ALL_GENERATED_MODEL_IDS },
      },
    });

    expect(
      await validateProjectModelSelection({
        projectPath,
        modelSelection: DEFAULT_MODEL_ALIAS_SELECTION,
      }),
    ).toEqual({
      ok: true,
      modelSelection: DEFAULT_MODEL_SELECTION,
    });
  });

  it("accepts an unconfigured project running the generated default bundle", async () => {
    expect(
      await validateProjectModelSelection({
        projectPath,
        modelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toEqual({
      ok: true,
      modelSelection: DEFAULT_MODEL_SELECTION,
    });
  });

  it("refuses rather than throwing when the project's configuration is malformed", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: "composer-1" } },
    });

    const validation = await validateProjectModelSelection({
      projectPath,
      modelSelection: DEFAULT_MODEL_SELECTION,
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.message).toContain("supportedModels");
    expect(validation.message).toContain("expected array");
  });
});

describe("cursor factory shape validation", () => {
  it("rejects a blank model id", () => {
    expect(() =>
      validateModelSelection({
        modelId: "   ",
        parameters: {},
      }),
    ).toThrow();
  });

  it("accepts an unrecognized-but-shaped bundle, leaving membership to the project check", () => {
    expect(() =>
      validateModelSelection({
        modelId: "composer-next",
        parameters: { providerOwned: "value" },
      }),
    ).not.toThrow();
  });
});

describe("SDK rejection of a configured model", () => {
  it("surfaces a bounded model-configuration error without falling back to another model", async () => {
    // The project lists the ID, so Command Center's own validation passes and
    // the SDK is the one that refuses it. Retrying on a different model would
    // be the substitution D10 forbids — the refusal has to reach the operator.
    await writeRepoConfig({
      agentBackends: {
        cursor: {
          supportedModels: [
            CURSOR_DEFAULT_MODEL,
            CUSTOM_MODEL_SELECTION.modelId,
          ],
        },
      },
    });
    const harness = createRuntimeOverRepoConfig(DEFAULT_MODEL_SELECTION, {
      worker: {
        onTurn: (turn, worker) => {
          worker.settle(turn.runId, "failed", {
            name: "ConfigurationError",
            message: "model composer-2 is not available for this account",
            code: null,
            status: 400,
          });
        },
      },
    });

    const result = await harness.send(CUSTOM_MODEL_SELECTION);

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.message).toContain(CUSTOM_MODEL_SELECTION.modelId);

    const worker = harness.transport.workers[0];
    expect(worker?.turns).toHaveLength(1);
    expect(worker?.turns.map((turn) => turn.input.modelSelection)).toEqual([
      CUSTOM_MODEL_SELECTION,
    ]);
  });

  it("reapplies the whole declared selection when resuming a persisted ref", async () => {
    await writeRepoConfig({
      agentBackends: {
        cursor: {
          supportedModels: [
            CURSOR_DEFAULT_MODEL,
            CUSTOM_MODEL_SELECTION.modelId,
          ],
        },
      },
    });
    const harness = createRuntimeOverRepoConfig(DEFAULT_MODEL_SELECTION, {
      create: {
        persistedRef: { backend: "cursor", ref: "agent-prior" },
      },
    });

    const result = await harness.send(CUSTOM_MODEL_SELECTION);

    expect(result.failure).toBeNull();
    const worker = harness.transport.workers[0];
    expect(worker?.attachments).toEqual([
      expect.objectContaining({
        mode: "resume",
        ref: "agent-prior",
        modelSelection: CUSTOM_MODEL_SELECTION,
      }),
    ]);
    expect(worker?.turns[0]?.input.modelSelection).toEqual(
      CUSTOM_MODEL_SELECTION,
    );
  });
});
