import { mkdtempSync } from "node:fs";
import { passthroughTurnInput } from "./testing/passthrough-input";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversationTranscriptProjection } from "@/lib/agent-backends/conversation-policy";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import {
  computeCascadeRuntimeHash,
  seedRuntimeApplicationState,
} from "@/lib/agent-capabilities/runtime-hashes";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { ConversationRecordPort } from "./conversation-record";
import { createInteractiveTurns } from "./interactive-turns";
import { createNativeSeatTurns } from "./native-seat-turns";
import { createRuntimeApplicationState } from "./runtime-application-state";
import { createRuntimeHost } from "./runtime-host";
import { createTurnEngine } from "./turn-engine";

vi.mock("@/lib/shared/sdk-env", () => ({}));

const PROJECT = "/repo";
const SESSION = "session";
const WORKTREE = mkdtempSync(path.join(tmpdir(), "cc-core-application-wt-"));
const log = createCapturingLogger();

const DOCS_MCP: PortableMcpConfig = {
  servers: [{ id: "docs", transport: "stdio", command: "/bin/true" }],
};
const reviewOff = [{ itemId: "review", enabled: false }];
const SKILLS: ResolvedCapabilityCascade = {
  backend: "claude",
  kinds: [
    {
      kind: "skills",
      items: reviewOff.map((item) => ({
        ...item,
        originLayer: "conversation" as const,
      })),
    },
  ],
};
const skillsHash = computeCascadeRuntimeHash({
  cascadeKind: "claude-skills",
  rows: reviewOff,
});

let fixture: PersistenceFixture;
let closeProvider = () => {};
afterEach(() => {
  closeProvider();
  fixture.close();
});

/** The row's own fields come from the store; only what a turn reads to start is answered here. */
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

async function compose() {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION, { worktreePath: WORKTREE });
  // What a conversation-level MCP change saved while no runtime ran leaves behind.
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({
      id: "conv-1",
      agentBackend: "claude",
      mcpRuntime: {
        pendingConfigHash: computeEffectiveConfigHash(DOCS_MCP),
        pendingServerKeys: ["docs"],
        lastApplyDisposition: "no_active_runtime",
      },
    }),
  );
  const provider = createScriptedConversationBackend({
    backend: "claude",
    responseText: JSON.stringify({ done: true }),
  });
  closeProvider = () => provider.close();
  const applicationState = createRuntimeApplicationState({
    conversations: fixture.deps,
    publish: () => {},
    log,
  });
  const host = createRuntimeHost({
    factory: () => provider.factory,
    instructions: async () => ({
      sessionInstructions: ["Work carefully."],
      alignmentVersion: null,
      alignmentEligible: false,
    }),
    tooling: async () => ({
      overrides: { portableMcp: DOCS_MCP, capabilities: SKILLS },
      capabilityState: seedRuntimeApplicationState([
        {
          cascadeKind: "claude-skills",
          pendingHash: skillsHash,
          pendingItemIds: ["review"],
          lastApplyStatus: "staged-next-turn",
        },
      ]),
    }),
    beginSeed: applicationState.beginSeed,
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
    recordAccepted: applicationState.recordAccepted,
    log,
  });
  return { host, engine };
}

async function runSeatTurn(): Promise<unknown> {
  const { host, engine } = await compose();
  return createNativeSeatTurns({
    engine,
    records,
    host,
    getProjectDisplayName: () => "repo",
    composeWriteEnvelope: () => {
      throw new Error("a full-scope seat needs no envelope");
    },
    fsWriteRestriction: () => "enforced",
    materializeDocuments: async () => {},
    log,
  }).run({
    conversationId: "conv-1",
    binding: {
      conversationId: "conv-1",
      contextId: "ctx-1",
      assignmentId: "implementer",
      replacement: 0,
      role: "implementer",
      projectPath: PROJECT,
      sessionName: SESSION,
      backend: "claude",
      createdAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z",
    },
    request: {
      kind: "work",
      documents: [],
      workspace: {
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        grant: { kind: "full_write" },
        writes: { mode: "all" },
      },
      seat: {
        contextId: "ctx-1",
        conversationId: null,
        assignmentId: "implementer",
        role: "implementer",
        assignment: {
          id: "implementer",
          profile: { tier: "builtin", id: "standard-agent" },
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
        replacement: 0,
        canAsk: false,
      },
      message: "Implement the task",
      timeoutMs: null,
    },
    attemptId: "attempt-1",
    signal: new AbortController().signal,
  });
}

async function runInteractiveTurn(): Promise<unknown> {
  const { host, engine } = await compose();
  return createInteractiveTurns({
    engine,
    records,
    host,
    worktreeOf: async () => WORKTREE,
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
    conversationId: "conv-1",
    place: {
      conversationId: "conv-1",
      projectPath: PROJECT,
      sessionName: SESSION,
    },
    request: { kind: "user_message", text: "Hello", inputOrigin: "user" },
    attemptId: "attempt-1",
    signal: new AbortController().signal,
    stream: null,
  });
}

describe("application state of core conversations", () => {
  it.each([
    ["seat", runSeatTurn],
    ["interactive", runInteractiveTurn],
  ] as const)(
    "settles the MCP and capability configuration a %s turn's runtime delivered on the conversation row",
    async (_kind, runTurn) => {
      expect(await runTurn()).toMatchObject({ status: "succeeded" });

      const row = await fixture
        .recreateStore()
        .getConversation(PROJECT, SESSION, "conv-1");
      expect(row?.mcpRuntime).toEqual({
        lastAppliedConfigHash: computeEffectiveConfigHash(DOCS_MCP),
        lastApplyDisposition: "applied_now",
      });
      // Applied through the core's own receipt, never rejected by an apply that looks for a registered runtime.
      expect(row?.agentCapabilitiesRuntime).toEqual({
        cascades: {
          "claude-skills": {
            appliedHash: skillsHash,
            lastApplyStatus: "applied",
          },
        },
      });
    },
  );
});
