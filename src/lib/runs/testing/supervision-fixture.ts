import type { ClaimedQueuedBatch } from "@/lib/conversations/message-queue-service";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { compactionConfigSchema } from "@/lib/config/schemas";
import type { GenerateCheckpointInput, generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  EMPTY_CHECKPOINT_USAGE,
  type CheckpointPayload,
  type CheckpointSourceBasis,
} from "@/lib/conversation-checkpoints/schemas";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  SeatTurnPort,
  CoreTurnResult,
  HoldSource,
  UserTurnPort,
} from "@/lib/conversation-core/executor";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextContract,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { RunBoundary } from "../schemas";
import { composeRunSupervision, type RunSupervision } from "../supervision";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A valid frozen payload for operation `id` over `sourceBasis`; its seed hash is `sha256:<id>`. */
export function checkpointPayload(id: string, sourceBasis: CheckpointSourceBasis, createdAt: string): CheckpointPayload {
  const seedText = `## Working state\ncontinue from seq ${sourceBasis.capturedThroughSeq}\n`;
  return {
    id,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis,
    artifactProvenance: null,
    versions: { generatorVersion: "gen-1", builderVersion: "builder-1", normalizerVersion: "norm-1" },
    modelSelection: { modelId: "sonnet", parameters: {} },
    sections: { workingState: {}, recentDialogue: [], recoveryMap: {} },
    seedText,
    seedSha256: `sha256:${id}`,
    sectionBytes: {
      total: Buffer.byteLength(seedText, "utf8"),
      workingState: 10,
      recentDialogue: 0,
      recoveryFraming: 0,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt,
  };
}

/** The payload the generator would return for the build `input` describes. */
export function checkpointPayloadFor(input: GenerateCheckpointInput): CheckpointPayload {
  return checkpointPayload(input.identity.checkpointId, input.source.basis, input.createdAt);
}

export const done = (finalText: string): CoreTurnResult => ({
  status: "succeeded",
  finalText,
  structuredOutput: null,
  outputIssue: null,
  failure: null,
});

export type TurnScript = (
  input: Parameters<SeatTurnPort["run"]>[0],
  supervision: RunSupervision,
) => Promise<CoreTurnResult>;

export function agentStartRequest(
  runId: string,
  contract: Partial<ContextContract> = {},
): ContextStartRequest {
  return {
    contextId: `${runId}.agent`,
    runId,
    ownerConversationId: "owner-1",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    },
    contract: contextContractSchema.parse({
      title: "Fix the notice",
      brief: "Make the failure notice appear once.",
      tasks: [],
      acceptanceCriteria: [],
      outputSchema: null,
      allowTaskAddition: false,
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "standard-agent" },
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: {} },
      },
      reviewers: [],
      checks: [],
      humanApproval: false,
      ownerQuestions: true,
      documents: [],
      ...contract,
    }),
    policy: DEFAULT_CONTEXT_POLICY,
  };
}

/**
 * The real supervision graph on a persistence fixture, with only the edges
 * that leave CC faked: seat turns follow `script`, Git evidence is constant,
 * checks pass, and owner notices are recorded.
 */
export function createSupervisionHarness(fixture: PersistenceFixture) {
  const harness = {
    notified: [] as RunBoundary[],
    turnMessages: [] as string[],
    /** Batches waiting in enrolled conversations' message queues, claimed first in, first out. */
    queued: [] as ClaimedQueuedBatch[],
    userMessages: [] as string[],
    queueRecoveries: [] as string[],
    /** Conversations whose rows are gone; every other enrolled conversation reads as a row. */
    deletedConversations: new Set<string>(),
    /** What conversations' rows hold; none unless a test composes the real rule. */
    conversationHold: { refusal: async () => null } as HoldSource,
    script: (async () => done("Done.")) as TurnScript,
    /** An enrolled conversation's turn, after its text is recorded. */
    userTurn: (async () => done("Hello.")) as (input: Parameters<UserTurnPort["run"]>[0]) => Promise<CoreTurnResult>,
    conversations: 0,
    /** Checkpoints of enrolled conversations: the real repository over the fixture, the rest faked. */
    checkpoint: {
      /** The archive every enrolled conversation reads. */
      entries: [] as TranscriptEntryWithSeq[],
      generate: (async (input) => ({
        ok: true,
        payload: checkpointPayloadFor(input),
        generationPassCount: 1,
        usage: EMPTY_CHECKPOINT_USAGE,
      })) as typeof generateCheckpoint,
      /** Why closing an enrolled conversation's runtime fails; null closes it. */
      closeFailure: null as string | null,
      /** Runtime closes the checkpoints asked for, by conversation, `retry:` marking a retried close. */
      releases: [] as string[],
      /** Queued rows a checkpoint acceptance released. */
      confirmed: [] as string[],
      repo: createConversationCheckpointsRepo(fixture.db, createWriteQueue(), fixture.store.checkpointContinuation),
    },
    compose(): RunSupervision {
      let self: RunSupervision | null = null;
      const supervision = composeRunSupervision({
        db: fixture.db,
        seatTurns: {
          async run(input) {
            harness.turnMessages.push(input.request.message);
            if (self === null) throw new Error("not composed");
            return harness.script(input, self);
          },
        },
        records: {
          async recordInterrupted() {},
          async recordWithdrawn() {},
          hasPendingQuestion: () => false,
          withdrawQuestion: async () => false,
          async claimTurn() {},
          async endClaim() {},
        },
        userTurns: {
          async run(input) {
            harness.userMessages.push(input.request.text);
            return harness.userTurn(input);
          },
        },
        taskTurns: {
          async run() {
            throw new Error("No task turns in this harness");
          },
        },
        queue: {
          async claimNextTurnBatch() {
            return harness.queued.shift() ?? null;
          },
          async markPending() {},
          async markDelivered() {},
          async markFailed() {},
          async recoverAbandonedDeliveries(input) {
            harness.queueRecoveries.push(input.conversationId);
            return 0;
          },
          async runConversationCommand() {
            throw new Error("No conversation commands in this harness");
          },
        },
        getProjectDisplayName: () => "repo",
        debug: {
          records: {
            readDebugMode: async () => null,
            applyCommand: async () => null,
          },
          verify: async () => null,
        },
        readConversation: async (enrollment) =>
          harness.deletedConversations.has(enrollment.conversationId)
            ? null
            : makeConversationState({ id: enrollment.conversationId }),
        conversationHold: harness.conversationHold,
        checkpoints: {
          repo: () => harness.checkpoint.repo,
          readConversation(identity) {
            const scope = scopeRefFromStoreSessionName(identity.sessionName);
            return scope.scope === "project"
              ? fixture.store.getProjectConversation(identity.projectPath, identity.conversationId)
              : fixture.store.getConversation(identity.projectPath, scope.sessionName, identity.conversationId);
          },
          readEntries: async () => ({
            entries: structuredClone(harness.checkpoint.entries),
            maxSeq: harness.checkpoint.entries.at(-1)?.seq ?? -1,
          }),
          findArtifact: async () => null,
          resolveConfig: async () => compactionConfigSchema.parse({}),
          async executeTaskRun() {
            throw new Error("Checkpoint generation is faked in this harness");
          },
          generate: (input, deps) => harness.checkpoint.generate(input, deps),
          resolveCaptureModel: async () => ({ modelId: "sonnet", parameters: {} }),
          backendSupportsCheckpoint: () => true,
          background: { activity: () => null, epoch: () => 0 },
          async confirmQueuedDelivery(input) {
            harness.checkpoint.confirmed.push(...input.ids);
            // Delivered rows leave the queue, as the message queue's own confirmation does.
            return fixture.store.mutateConversation(
              input.projectPath,
              input.sessionName,
              input.conversationId,
              "test.confirm_queued_delivery",
              (row) => {
                const before = row.pendingQueue.length;
                row.pendingQueue = row.pendingQueue.filter((item) => !input.ids.includes(item.id));
                return before - row.pendingQueue.length;
              },
            );
          },
          async appendUserEntryOnce() {},
          async worktreeOf(identity) {
            const scope = scopeRefFromStoreSessionName(identity.sessionName);
            return scope.scope === "project" ? identity.projectPath : `${identity.projectPath}/.worktrees/${scope.sessionName}`;
          },
          runtime: {
            async release(conversationId) {
              harness.checkpoint.releases.push(conversationId);
              if (harness.checkpoint.closeFailure !== null) throw new Error(harness.checkpoint.closeFailure);
            },
            async retryRelease(conversationId) {
              harness.checkpoint.releases.push(`retry:${conversationId}`);
              if (harness.checkpoint.closeFailure !== null) throw new Error(harness.checkpoint.closeFailure);
            },
            closeFailure: async () => null,
          },
          async settleTurnReceipts() {},
          now: () => new Date().toISOString(),
        },
        async createSeatConversation() {
          harness.conversations += 1;
          return `conv-${harness.conversations}`;
        },
        slots: { acquire: async () => () => {} },
        evidence: {
          capture: async () => "git:tree:digest",
          sameContent: (a, b) => a === b,
          changedPaths: async () => [],
        },
        runCheck: async () => ({ status: "passed" }),
        async notifyOwner({ boundary }) {
          harness.notified.push(boundary);
        },
        now: () => new Date().toISOString(),
        logger: () => silent,
      });
      self = supervision;
      return supervision;
    },
  };
  return harness;
}

/** Lets every reconcile, turn and workspace operation run; `turnsSettle: false` skips waiting on turns. */
export async function quiesce(
  s: RunSupervision,
  turnsSettle = true,
): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([
      s.scheduler.idle(),
      turnsSettle ? s.core.idle() : null,
      s.workspace.drain(),
    ]);
  }
}
