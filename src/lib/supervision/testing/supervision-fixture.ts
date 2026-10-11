import { z } from "zod";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import type { ClaimedQueuedBatch } from "@/lib/conversations/message-queue-service";
import { compactionConfigSchema } from "@/lib/config/schemas";
import type {
  GenerateCheckpointInput,
  generateCheckpoint,
} from "@/lib/conversation-checkpoints/generation";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  EMPTY_CHECKPOINT_USAGE,
  type CheckpointPayload,
  type CheckpointSourceBasis,
} from "@/lib/conversation-checkpoints/schemas";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";
import type { CaptureHandoffInput } from "@/lib/agent-backends/conversation";
import type { CaptureHandoffResult } from "@/lib/agent-backends/schemas";
import type { CaptureRuntimeRequest } from "@/lib/conversation-core/checkpoint-capture";
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
import { createFakeLaneGit } from "@/lib/workspace/testing/fake-lane-git";
import { createDirectLaneIntegrator } from "@/lib/workspace/testing/direct-lane-integrator";
import type { WorkspaceExecutorDeps } from "@/lib/workspace/executor";
import type { RunBoundary } from "@/lib/runs/schemas";
import { composeSupervision, type Supervision } from "../supervision";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A valid frozen payload for operation `id` over `sourceBasis`; its seed hash is `sha256:<id>`. */
export function checkpointPayload(
  id: string,
  sourceBasis: CheckpointSourceBasis,
  createdAt: string,
): CheckpointPayload {
  const seedText = `## Working state\ncontinue from seq ${sourceBasis.capturedThroughSeq}\n`;
  return {
    id,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis,
    artifactProvenance: null,
    versions: {
      generatorVersion: "gen-1",
      builderVersion: "builder-1",
      normalizerVersion: "norm-1",
    },
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
export function checkpointPayloadFor(
  input: GenerateCheckpointInput,
): CheckpointPayload {
  return checkpointPayload(
    input.identity.checkpointId,
    input.source.basis,
    input.createdAt,
  );
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
  supervision: Supervision,
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
  const laneGit = createFakeLaneGit();
  const harness = {
    /** The lane Git port, in memory: set heads, dirt or conflicts to steer lane runs. */
    lanes: laneGit.git,
    laneGit,
    /** Every run boundary recorded, in order: what each owner's waking follow delivers. */
    get recorded(): RunBoundary[] {
      const runs = createRunsRepo(fixture.db);
      const ids = z
        .array(z.string())
        .parse(
          fixture.db
            .prepare("SELECT run_id FROM runs ORDER BY rowid")
            .pluck()
            .all(),
        );
      return ids
        .flatMap((id) => runs.boundaries(id))
        .sort((a, b) => a.seq - b.seq);
    },
    /** Runs whose owner was asked to follow them. */
    follows: [] as string[],
    turnMessages: [] as string[],
    /** Batches waiting in interactive conversations' message queues, claimed first in, first out. */
    queued: [] as ClaimedQueuedBatch[],
    userMessages: [] as string[],
    queueRecoveries: [] as string[],
    /** Conversations whose message queue was asked for its next batch, in order. */
    claims: [] as string[],
    /** Conversations the core's records were asked to settle as interrupted by a restart. */
    interrupted: [] as string[],
    /** Conversations whose last runtime did not close, with why. */
    uncollected: new Map<string, string>(),
    /** How many evidence captures fail before they succeed again. */
    evidenceFailures: 0,
    /** What conversations' rows hold; none unless a test composes the real rule. */
    conversationHold: { refusal: async () => null } as HoldSource,
    script: (async () => done("Done.")) as TurnScript,
    /** An interactive conversation's turn, after its text is recorded. */
    userTurn: (async () => done("Hello.")) as (
      input: Parameters<UserTurnPort["run"]>[0],
    ) => Promise<CoreTurnResult>,
    conversations: 0,
    /** Every acceptance check run, in order, with the binding it ran for. */
    checksRun: [] as Array<{ bindingId: string; command: string }>,
    /** Checkpoints of interactive conversations: the real repository over the fixture, the rest faked. */
    checkpoint: {
      /** The archive every interactive conversation reads. */
      entries: [] as TranscriptEntryWithSeq[],
      generate: (async (input) => {
        const payload = checkpointPayloadFor(input);
        // Generation decides a validated handoff's place in the seed; here it always fits.
        if (input.agentHandoff === undefined)
          return {
            ok: true,
            payload,
            generationPassCount: 1,
            usage: EMPTY_CHECKPOINT_USAGE,
          };
        return {
          ok: true,
          payload: {
            ...payload,
            sections: {
              ...payload.sections,
              workingState: { agentHandoff: input.agentHandoff },
            },
          },
          handoffDecision: "included",
          generationPassCount: 1,
          usage: EMPTY_CHECKPOINT_USAGE,
        };
      }) as typeof generateCheckpoint,
      /** Why closing an interactive conversation's runtime fails; null closes it. */
      closeFailure: null as string | null,
      /** Runtime closes the checkpoints asked for, by conversation, `retry:` marking a retried close. */
      releases: [] as string[],
      /** Queued rows a checkpoint acceptance released. */
      confirmed: [] as string[],
      /** The handoff capture each capture runtime runs; null fails the runtime's creation. */
      capture: null as
        | ((input: CaptureHandoffInput) => Promise<CaptureHandoffResult>)
        | null,
      /** When set, the next archive read fails once. */
      failNextRead: false,
      /** Capture audit entries whose next append fails once, by entry id. */
      failingAppends: new Set<string>(),
      /** Every capture runtime opened, with the session it resumes and its purpose. */
      captures: [] as Array<
        Pick<
          CaptureRuntimeRequest,
          "backendRef" | "captureId" | "mode" | "modelSelection"
        >
      >,
      repo: createConversationCheckpointsRepo(
        fixture.db,
        createWriteQueue(),
        fixture.store.checkpointContinuation,
      ),
    },
    compose(): Supervision {
      let self: Supervision | null = null;
      const checkRunner: WorkspaceExecutorDeps["runCheck"] = async (input) => {
        harness.checksRun.push({
          bindingId: input.bindingId,
          command: input.command,
        });
        return { status: "passed" };
      };
      const supervision = composeSupervision({
        db: fixture.db,
        seatTurns: {
          async run(input) {
            harness.turnMessages.push(input.request.message);
            if (self === null) throw new Error("not composed");
            return harness.script(input, self);
          },
        },
        records: {
          async recordInterrupted(identity) {
            harness.interrupted.push(identity.conversationId);
          },
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
          async claimNextTurnBatch(input) {
            harness.claims.push(input.conversationId);
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
        conversationHold: harness.conversationHold,
        checkpoints: {
          repo: () => harness.checkpoint.repo,
          readConversation(identity) {
            const scope = scopeRefFromStoreSessionName(identity.sessionName);
            return scope.scope === "project"
              ? fixture.store.getProjectConversation(
                  identity.projectPath,
                  identity.conversationId,
                )
              : fixture.store.getConversation(
                  identity.projectPath,
                  scope.sessionName,
                  identity.conversationId,
                );
          },
          async readEntries() {
            if (harness.checkpoint.failNextRead) {
              harness.checkpoint.failNextRead = false;
              throw new Error("the transcript could not be read");
            }
            return {
              entries: structuredClone(harness.checkpoint.entries),
              maxSeq: harness.checkpoint.entries.at(-1)?.seq ?? -1,
            };
          },
          findArtifact: async () => null,
          resolveConfig: async () => compactionConfigSchema.parse({}),
          taskLane: () => async () => {
            throw new Error("Checkpoint generation is faked in this harness");
          },
          generate: (input, deps) => harness.checkpoint.generate(input, deps),
          resolveCaptureModel: async () => ({
            modelId: "sonnet",
            parameters: {},
          }),
          backendSupportsCheckpoint: () => true,
          captureAvailability: () => ({
            available: true,
            mode: "tool-disabled",
          }),
          // The archive a capture appends to is the one every checkpoint reads.
          async appendCaptureEntryOnce(_conversationId, entry) {
            const { entries, failingAppends } = harness.checkpoint;
            if (failingAppends.delete(entry.id))
              throw new Error("the transcript could not be written");
            if (entries.some((e) => e.entryId === entry.id)) return;
            if (
              entry.role !== "user" &&
              entry.role !== "assistant" &&
              entry.role !== "notice"
            )
              return;
            entries.push({
              seq: (entries.at(-1)?.seq ?? -1) + 1,
              entryId: entry.id,
              role: entry.role,
              timestamp: entry.timestamp,
              content: entry.content ?? [],
              ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
            });
          },
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
                row.pendingQueue = row.pendingQueue.filter(
                  (item) => !input.ids.includes(item.id),
                );
                return before - row.pendingQueue.length;
              },
            );
          },
          async appendUserEntryOnce() {},
          async worktreeOf(identity) {
            const scope = scopeRefFromStoreSessionName(identity.sessionName);
            return scope.scope === "project"
              ? identity.projectPath
              : `${identity.projectPath}/.worktrees/${scope.sessionName}`;
          },
          runtime: {
            async release(conversationId) {
              harness.checkpoint.releases.push(conversationId);
              if (harness.checkpoint.closeFailure !== null)
                throw new Error(harness.checkpoint.closeFailure);
            },
            async retryRelease(conversationId) {
              harness.checkpoint.releases.push(`retry:${conversationId}`);
              if (harness.checkpoint.closeFailure !== null)
                throw new Error(harness.checkpoint.closeFailure);
            },
            closeFailure: async (conversationId) =>
              harness.uncollected.get(conversationId) ?? null,
            async openForCapture(input) {
              harness.checkpoint.captures.push({
                backendRef: input.backendRef,
                captureId: input.captureId,
                mode: input.mode,
                modelSelection: input.modelSelection,
              });
              const capture = harness.checkpoint.capture;
              if (capture === null)
                throw new Error("the capture runtime could not be started");
              return {
                modelSelection: input.modelSelection,
                captureHandoff: capture,
              };
            },
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
          async capture() {
            if (harness.evidenceFailures > 0) {
              harness.evidenceFailures -= 1;
              throw new Error("git could not read the worktree");
            }
            return "git:tree:digest";
          },
          sameContent: (a, b) => a === b,
          changedPaths: async () => [],
        },
        lanes: harness.lanes,
        integrator: createDirectLaneIntegrator({
          lanes: harness.lanes,
          runCheck: checkRunner,
        }),
        runCheck: checkRunner,
        async followOwner(run) {
          harness.follows.push(run.runId);
        },
        boundariesRecorded() {},
        runChanged() {},
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
  s: Supervision,
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
