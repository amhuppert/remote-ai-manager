import { mkdtempSync } from "node:fs";
import { passthroughTurnInput } from "./testing/passthrough-input";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
} from "@/lib/agent-backends/conversation";
import { getConversationTranscriptProjection } from "@/lib/agent-backends/conversation-policy";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import { CONVERSATION_IDENTITY_ENV_VAR } from "@/lib/agent-gateway/conversation-identity";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { ConversationRecordPort } from "./conversation-record";
import { createInteractiveTurns } from "./interactive-turns";
import { createRuntimeHost } from "./runtime-host";
import { createTurnEngine } from "./turn-engine";

// `sdk-env` deletes an env var at load — an infrastructure module with an import-time side effect.
vi.mock("@/lib/shared/sdk-env", () => ({}));

const PROJECT = mkdtempSync(path.join(tmpdir(), "cc-core-project-root-"));
const log = createCapturingLogger();

const records: ConversationRecordPort = {
  async recordSeenAlignment() {},
  async read() {
    return {
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      transcriptPath: null,
      debugMode: null,
      pendingQuestionId: null,
      owner: null,
      forkedFrom: null,
      checkpointFork: undefined,
    };
  },
  async claimTurn() {},
  async endClaim() {},
  async beginTurn() {},
  async admitProfile() {
    return { instructionBlock: null, snapshot: null, lockedAt: null };
  },
  async adoptBackend() {},
  async recordContinuity() {},
  async recordWithdrawn() {},
  async recordInterrupted() {},
  hasPendingQuestion: () => false,
  async withdrawQuestion() {
    return false;
  },
  async settleTurn() {
    return { debug: null };
  },
};

let closeProvider = () => {};
afterEach(() => closeProvider());

/** A project conversation's message, through the real turn engine, runtime host and Claude adapter. */
async function runProjectMessage() {
  const provider = createScriptedConversationBackend({
    backend: "claude",
    responseText: JSON.stringify({ done: true }),
  });
  closeProvider = () => provider.close();
  const created: ConversationBackendCreateInput[] = [];
  const factory: ConversationBackendFactory = {
    ...provider.factory,
    async createRuntime(input) {
      created.push(input);
      return provider.factory.createRuntime(input);
    },
  };
  const host = createRuntimeHost({
    factory: () => factory,
    instructions: async () => ({
      sessionInstructions: ["Work carefully."],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    tooling: async () => ({ overrides: { portableMcp: { servers: [] } } }),
    beginSeed: async () => ({ commit: async () => {} }),
    callbacks: () => ({}),
    index: { register: () => {}, unregister: () => {} },
    log,
  });
  const engine = createTurnEngine({
    host,
    executeAgentCall,
    transcript: {
      async safeAppendTranscriptEntry() {},
      async safeAppendTranscriptEntryOnce() {},
    },
    projection: getConversationTranscriptProjection,
    timeouts: async () => ({ timeoutMs: 0, stallTimeoutMs: 0 }),
    log,
  });
  const result = await createInteractiveTurns({
    engine,
    records,
    host,
    worktreeOf: async (projectPath, target) => {
      if (target.scope !== "project")
        throw new Error("a project conversation has no session worktree");
      return projectPath;
    },
    admitCheckpointFork: async () => null,
    resolveModelSelection: async () => ({
      modelId: "sonnet",
      parameters: { effort: "medium" },
    }),
    continuation: async () => ({
      continuation: { kind: "ordinary" },
      seed: null,
    }),
    prepareInput: async (request) => passthroughTurnInput(request),
    nameConversation: () => {},
    requestUserQuestion: async () => ({
      status: "answered" as const,
      answers: {},
    }),
    persistImages: async ({ promptText }) => ({ promptText, imageRefs: [] }),
    queuedDelivery: () => {
      throw new Error("a direct message has no queued delivery");
    },
    failQueued: async () => {},
    returnQueued: async () => {},
    transcript: { async appendTranscriptEntryOnce() {} },
    getProjectDisplayName: () => "repo",
    startDebugVerification: () => {},
    log,
  }).run({
    conversationId: "conv-p",
    enrollment: {
      conversationId: "conv-p",
      projectPath: PROJECT,
      sessionName: storeSessionNameFromScopeRef({ scope: "project" }),
      enrolledAt: "2026-10-03T10:00:00.000Z",
    },
    request: { kind: "user_message", text: "Hello", inputOrigin: "user" },
    attemptId: "attempt-1",
    signal: new AbortController().signal,
    stream: null,
  });
  await host.releaseAll();
  return { result, created, options: provider.claudeOptions };
}

describe("a project conversation the core runs", () => {
  it("runs its agent in the project root as the project conversation, with no session or conversation identity to act as", async () => {
    const { result, created, options } = await runProjectMessage();

    expect(result).toMatchObject({ status: "succeeded" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      conversationTarget: {
        scope: "project",
        projectName: "repo",
        conversationId: "conv-p",
      },
      worktreePath: PROJECT,
    });
    expect(created[0]).not.toHaveProperty("workflowCallerConversationId");
    expect(options?.cwd).toBe(PROJECT);
    expect(options?.env).toMatchObject({
      CC_CONVERSATION_SCOPE: "project",
      CC_SESSION: "",
      CC_CONVERSATION_ID: "conv-p",
    });
    expect(options?.env).not.toHaveProperty(CONVERSATION_IDENTITY_ENV_VAR);
  });
});
