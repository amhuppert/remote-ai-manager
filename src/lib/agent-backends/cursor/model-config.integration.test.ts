import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRepoConfig } from "@/lib/projects/repo-config";

import type { ConversationBackendCreateInput } from "../conversation";
import { CursorConversationRuntime } from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import {
  createCursorSupportedModelsReader,
  resolveCursorModelForProject,
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
    sessionInstructions: [],
    tooling: {},
  };
}

/**
 * The runtime wired to the production model-resolution chain — the project's
 * configured list read through `ConversationBackendCreateInput.projectPath` —
 * with only the global profile injected, so the test does not depend on the
 * server's own configuration file.
 */
function createRuntimeOverRepoConfig(
  globalProfileModel: string | null,
  options: {
    worker?: ScriptedWorkerOptions;
    create?: Partial<ConversationBackendCreateInput>;
  } = {},
) {
  const transport = createScriptedTransport(options.worker);
  const input = { ...createInput(), ...options.create };
  const runtime = new CursorConversationRuntime(input, {
    transport,
    storePath: (conversationId) => `/state/cursor/${conversationId}`,
    resolveModel: (explicitSelection) =>
      resolveCursorModelForProject(
        { projectPath: input.projectPath, explicitSelection },
        {
          supportedModels: createCursorSupportedModelsReader(readRepoConfig),
          globalProfileModel: async () => globalProfileModel,
        },
      ),
    translatePortableMcpToCursor,
    newRunId: () => "run-1",
    now: () => 1_000,
    stallTimeoutMs: 50,
    cancelSettleTimeoutMs: 50,
  });

  return {
    transport,
    send: (modelId?: string) =>
      runtime.sendTurn({
        promptText: "do the thing",
        imageRefs: [],
        sessionInstructions: [],
        autonomous: false,
        signal: new AbortController().signal,
        onEvent: () => {},
        ...(modelId !== undefined ? { modelId } : {}),
      }),
  };
}

describe("per-repo supported-model list enforced before a worker starts", () => {
  it("refuses an explicit model the project does not list", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });
    const harness = createRuntimeOverRepoConfig(null);

    const result = await harness.send("composer-2.5");

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.message).toContain("composer-2.5");
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("runs a model the project lists", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });
    const harness = createRuntimeOverRepoConfig(null);

    const result = await harness.send("composer-1");

    expect(result.failure).toBeNull();
    expect(harness.transport.workers[0]?.turns[0]?.input.model).toBe(
      "composer-1",
    );
  });

  it("fails closed when the project's list omits the default and nothing is selected", async () => {
    // The no-substitution edge: with no explicit selection and no global
    // profile, the descriptor default is not a member, so the turn is refused
    // rather than run on a model the project never listed.
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });
    const harness = createRuntimeOverRepoConfig(null);

    const result = await harness.send();

    expect(result.failure?.kind).toBe("backend_error");
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("refuses a globally configured model outside the project's list", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });
    const harness = createRuntimeOverRepoConfig("composer-2.5");

    const result = await harness.send();

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.message).toContain("composer-2.5");
    expect(harness.transport.startInputs).toHaveLength(0);
  });

  it("uses the descriptor default when the project declares no list", async () => {
    const harness = createRuntimeOverRepoConfig(null);

    const result = await harness.send();

    expect(result.failure).toBeNull();
    expect(harness.transport.workers[0]?.turns[0]?.input.model).toBe(
      "composer-2.5",
    );
  });
});

/**
 * The registered factory must declare both model hooks: the project-scoped one
 * is where membership is decided, and a missing hook would make every test
 * below vacuous.
 */
const { validateProjectModelSelection, validateModelAndEffort } =
  cursorConversationBackendFactory;
if (
  validateProjectModelSelection === undefined ||
  validateModelAndEffort === undefined
) {
  throw new Error("The Cursor factory declares no model validation hooks.");
}

describe("cursor factory project-scoped model validation", () => {
  it("refuses an explicit model outside the project's list and names the supported ones", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });

    const validation = await validateProjectModelSelection({
      projectPath,
      modelId: "gpt-5",
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.message).toContain("gpt-5");
    expect(validation.message).toContain("composer-1");
  });

  it("accepts a model the project lists", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });

    expect(
      await validateProjectModelSelection({
        projectPath,
        modelId: "composer-1",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses with no explicit selection when the project's list omits the default", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });

    const validation = await validateProjectModelSelection({
      projectPath,
    });

    expect(validation.ok).toBe(false);
  });

  it("accepts an unconfigured project running the descriptor default", async () => {
    expect(
      await validateProjectModelSelection({
        projectPath,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses rather than throwing when the project's configuration is malformed", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: "composer-1" } },
    });

    const validation = await validateProjectModelSelection({
      projectPath,
      modelId: "composer-1",
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.message).toContain("CommandCenter.json");
  });
});

describe("cursor factory shape validation", () => {
  it("rejects a blank model id", () => {
    // All the sync, project-blind hook can answer: membership belongs to
    // validateProjectModelSelection, which can read the project's list.
    expect(() =>
      validateModelAndEffort({
        modelId: "   ",
      }),
    ).toThrow();
  });

  it("accepts an unrecognized-but-shaped model id, leaving membership to the project check", () => {
    expect(() =>
      validateModelAndEffort({
        modelId: "composer-next",
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
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });
    const harness = createRuntimeOverRepoConfig(null, {
      worker: {
        onTurn: (turn, worker) => {
          worker.settle(turn.runId, "failed", {
            name: "ConfigurationError",
            message: "model composer-1 is not available for this account",
            code: null,
            status: 400,
          });
        },
      },
    });

    const result = await harness.send("composer-1");

    expect(result.failure?.kind).toBe("backend_error");
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.message).toContain("composer-1");

    const worker = harness.transport.workers[0];
    expect(worker?.turns).toHaveLength(1);
    expect(worker?.turns.map((t) => t.input.model)).toEqual(["composer-1"]);
  });

  it("reapplies the declared model when resuming a persisted ref", async () => {
    await writeRepoConfig({
      agentBackends: { cursor: { supportedModels: ["composer-1"] } },
    });
    const harness = createRuntimeOverRepoConfig(null, {
      create: { persistedRef: { backend: "cursor", ref: "agent-prior" } },
    });

    const result = await harness.send("composer-1");

    expect(result.failure).toBeNull();
    const worker = harness.transport.workers[0];
    expect(worker?.attachments).toEqual([
      expect.objectContaining({
        mode: "resume",
        ref: "agent-prior",
        model: "composer-1",
      }),
    ]);
    expect(worker?.turns[0]?.input.model).toBe("composer-1");
  });
});
