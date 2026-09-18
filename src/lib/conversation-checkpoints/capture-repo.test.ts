import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createConversationCheckpointsRepo,
  type CheckpointResult,
  type ConversationCheckpointsRepo,
} from "./repo";
import { pendingHandoff, capturedHandoff } from "./handoff-fixture";
import { checkpointOperationSchema } from "./schemas";
import type {
  CheckpointHandoff,
  CheckpointPayload,
  CheckpointScopeKey,
} from "./schemas";

const id = "operation-maximal";
const pending = pendingHandoff();
const captured = capturedHandoff();
const basis = pending.admissionSourceBasis;
const finalBasis = { capturedThroughSeq: 413, sourceHash: "sha256:final" };
let key: CheckpointScopeKey = {
  scope: "session",
  projectPath: "/capture",
  sessionName: "session",
  conversationId: "conversation",
};
let begin = {
  key,
  operationId: id,
  captureId: pending.captureId,
  expectedSourceBasis: basis,
  at: "2026-09-07T12:04:01.000Z",
};
const settledAt = "2026-09-07T12:04:04.000Z";
let fx: PersistenceFixture;
let repo: ConversationCheckpointsRepo;

function unwrap<T>(result: CheckpointResult<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.reason);
  return result.value;
}
function payload(handoff = false): CheckpointPayload {
  const seedText = handoff ? JSON.stringify(captured.candidate) : "legacy seed";
  return {
    id,
    schemaVersion: 1,
    sourceBasis: finalBasis,
    artifactProvenance: null,
    versions: {
      generatorVersion: "1",
      builderVersion: "1",
      normalizerVersion: "1",
    },
    modelSelection: { modelId: "source", parameters: {} },
    sections: {
      workingState: handoff ? { agentHandoff: captured.candidate } : {},
      recentDialogue: [],
      recoveryMap: {},
    },
    seedText,
    seedSha256: createHash("sha256").update(seedText).digest("hex"),
    sectionBytes: {
      total: Buffer.byteLength(seedText),
      workingState: Buffer.byteLength(seedText),
      recentDialogue: 0,
      recoveryFraming: 0,
    },
    omissions: [],
    generationPassCount: 1,
    createdAt: settledAt,
  };
}
async function settle(
  handoff: CheckpointHandoff = captured,
  expectedStage: "pending" | "running" | "settling" = "running",
) {
  return repo.settleCapture({
    ...begin,
    expectedStage,
    at: settledAt,
    settlement: { kind: "result", handoff },
  });
}
async function capture() {
  unwrap(await repo.beginCapture(begin));
  return unwrap(await settle());
}
describe.each(["session", "project"] as const)(
  "capture persistence fences (%s)",
  (scope) => {
    beforeEach(async () => {
      key = {
        ...key,
        scope,
        sessionName: scope === "session" ? "session" : null,
      };
      begin = { ...begin, key };
      fx = createPersistenceFixture();
      fx.seedProject(key.projectPath);
      fx.seedSession(key.projectPath, "session");
      const conversation = makeConversationState({
        id: key.conversationId,
        backendRef: { backend: "codex", ref: "prior" },
      });
      if (scope === "session")
        await fx.seedConversation(key.projectPath, "session", conversation);
      else await fx.seedProjectConversation(key.projectPath, conversation);
      repo = createConversationCheckpointsRepo(
        fx.db,
        createWriteQueue(),
        fx.store.checkpointContinuation,
      );
      unwrap(
        await repo.admitOperation({
          key,
          requestId: id,
          sourceBasis: basis,
          priorBackendRef: "prior",
          requestedAt: pending.requestedAt,
          handoff: pending,
        }),
      );
    });
    afterEach(() => fx.close());

    it.each(["included", "omitted"] as const)(
      "retains actual category counts after %s freeze",
      async (decision) => {
        await capture();
        unwrap(
          await repo.freezePayload({
            key,
            operationId: id,
            payload: payload(decision === "included"),
            at: "2026-09-07T12:04:05.000Z",
            handoffDecision:
              decision === "included" ? "included" : "seed_budget",
          }),
        );
        const reloaded = await repo.getOperation(key, id);
        expect(reloaded?.handoff?.candidate).toBeNull();
        expect(reloaded?.handoff).toMatchObject({
          categoryCounts: {
            plan: 1,
            hypotheses: 1,
            failedApproaches: 1,
            blockers: 1,
            nextStep: 1,
          },
        });
        expect(
          (await repo.getReceipt(key, id))?.handoff?.categoryCounts,
        ).toEqual(reloaded?.handoff?.categoryCounts);
      },
    );

    it.each([false, true])(
      "rejects submitted omissions without beginCapture (completion=%s)",
      async (correlatedCompletion) => {
        const before = await repo.getOperation(key, id);
        const result = await settle(
          {
            ...pending,
            stage: "omitted",
            omissionReason: "capture_failed",
            submitted: true,
            correlatedCompletion,
            executionSettled: true,
            auditDurable: true,
            settledAt,
            finalSourceBasis: finalBasis,
          },
          "pending",
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.refusal.code).toBe("invalid_handoff");
        expect(await repo.getOperation(key, id)).toEqual(before);
        expect(await repo.getPayload(key, id)).toBeNull();
      },
    );

    it.each(["pending", "running"] as const)(
      "reserves seed-budget omission for freeze from %s",
      async (stage) => {
        if (stage === "running") unwrap(await repo.beginCapture(begin));
        const before = await repo.getOperation(key, id);
        const result = await settle(
          {
            ...pending,
            stage: "omitted",
            omissionReason: "seed_budget",
            startedAt: stage === "running" ? begin.at : null,
            executionSettled: true,
            auditDurable: true,
            settledAt,
            finalSourceBasis: finalBasis,
          },
          stage,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.refusal.code).toBe("invalid_handoff");
        expect(await repo.getOperation(key, id)).toEqual(before);
        expect(await repo.getPayload(key, id)).toBeNull();
      },
    );

    it("durably begins once and preserves the originally admitted opt-in on rejoin", async () => {
      expect(unwrap(await repo.beginCapture(begin)).handoff?.stage).toBe(
        "running",
      );
      expect(unwrap(await repo.beginCapture(begin)).handoff?.startedAt).toBe(
        begin.at,
      );
      const joined = unwrap(
        await repo.admitOperation({
          key,
          requestId: id,
          sourceBasis: basis,
          priorBackendRef: "changed",
          requestedAt: "later",
          handoff: null,
        }),
      );
      expect(joined.outcome).toBe("reused");
      expect(joined.operation.handoff?.requestedMode).toBe(
        pending.requestedMode,
      );
      expect((await repo.getOperation(key, id))?.handoff?.stage).toBe(
        "running",
      );
    });
    it("refuses wrong scope, capture identity and stale source without changing the row", async () => {
      for (const change of [
        { key: { ...key, projectPath: "/wrong" } },
        { captureId: "wrong" },
        { expectedSourceBasis: finalBasis },
      ]) {
        expect((await repo.beginCapture({ ...begin, ...change })).ok).toBe(
          false,
        );
      }
      expect((await repo.getOperation(key, id))?.handoff).toEqual(pending);
    });
    it("will not freeze an unsettled capture", async () => {
      expect(
        (
          await repo.freezePayload({
            key,
            operationId: id,
            payload: { ...payload(), sourceBasis: basis },
            at: "freeze",
          })
        ).ok,
      ).toBe(false);
      expect(await repo.getPayload(key, id)).toBeNull();
    });
    it("updates the final source once, replaying only the identical settled result", async () => {
      const operation = await capture();
      expect(operation.sourceBasis).toEqual(finalBasis);
      expect(operation.handoff?.admissionSourceBasis).toEqual(basis);
      expect(unwrap(await settle())).toEqual(operation);
      expect((await settle({ ...captured, contentHash: "changed" })).ok).toBe(
        false,
      );
      expect(
        (
          await settle({
            ...captured,
            finalSourceBasis: { ...finalBasis, capturedThroughSeq: 414 },
          })
        ).ok,
      ).toBe(false);
      expect((await repo.getOperation(key, id))?.sourceBasis).toEqual(
        finalBasis,
      );
    });
    it("requires settlement, audit durability and matching immutable request fields", async () => {
      unwrap(await repo.beginCapture(begin));
      for (const change of [
        { executionSettled: false },
        { auditDurable: false },
        { requestedMode: "tool-disabled" as const },
        { admissionSourceBasis: finalBasis },
        { sourceCoverage: { seqStart: 411, seqEnd: 414, entryIds: ["x"] } },
      ]) {
        expect((await settle({ ...captured, ...change })).ok).toBe(false);
      }
      expect((await repo.getOperation(key, id))?.sourceBasis).toEqual(basis);
    });
    it("persists skip and allows cancel to win before settled output", async () => {
      unwrap(await repo.beginCapture(begin));
      const stop = {
        ...begin,
        expectedStage: "running" as const,
        settlement: { kind: "stop" as const, intent: "skip" as const },
      };
      expect(unwrap(await repo.settleCapture(stop)).handoff?.stage).toBe(
        "settling",
      );
      expect(unwrap(await repo.settleCapture(stop)).handoff?.stopIntent).toBe(
        "skip",
      );
      const cancel = {
        ...stop,
        expectedStage: "settling" as const,
        settlement: { kind: "stop" as const, intent: "cancel" as const },
      };
      expect(unwrap(await repo.settleCapture(cancel)).handoff?.stopIntent).toBe(
        "cancel",
      );
      expect((await settle(captured, "settling")).ok).toBe(false);
      expect(
        (
          await repo.freezePayload({
            key,
            operationId: id,
            payload: payload(),
            at: "freeze",
          })
        ).ok,
      ).toBe(false);
    });
    it.each(["included", "seed_budget"] as const)(
      "freezes %s atomically and never revises it",
      async (handoffDecision) => {
        await capture();
        const frozenPayload = payload(handoffDecision === "included");
        const freeze = {
          key,
          operationId: id,
          payload: frozenPayload,
          handoffDecision,
          at: "freeze",
        };
        const frozen = unwrap(await repo.freezePayload(freeze));
        expect(frozen.phase).toBe("retiring");
        expect(frozen.handoff?.stage).toBe(
          handoffDecision === "included" ? "included" : "omitted",
        );
        expect(frozen.handoff?.omissionReason).toBe(
          handoffDecision === "included" ? null : "seed_budget",
        );
        expect(unwrap(await repo.freezePayload(freeze))).toEqual(frozen);
        expect(
          (
            await repo.freezePayload({
              ...freeze,
              handoffDecision:
                handoffDecision === "included" ? "seed_budget" : "included",
            })
          ).ok,
        ).toBe(false);
        expect(await repo.getPayload(key, id)).toEqual(frozenPayload);
        expect((await settle()).ok).toBe(false);
      },
    );
    it.each(["failed", "cancelled", "interrupted"] as const)(
      "finalizes a captured candidate on %s without a payload",
      async (reason) => {
        await capture();
        const outcome = {
          key,
          operationId: id,
          expectedPhase: "building" as const,
          phase:
            reason === "cancelled"
              ? ("cancelled" as const)
              : ("failed" as const),
          failure: { code: reason, message: reason },
          at: "terminal",
        };
        const terminal = unwrap(await repo.recordOutcome(outcome));
        expect(terminal.handoff?.stage).toBe("omitted");
        expect(terminal.handoff?.omissionReason).toBe(
          reason === "failed" ? "checkpoint_failed" : reason,
        );
        expect(terminal.handoff?.contentHash).toBe(captured.contentHash);
        expect(terminal.handoff?.sourceCoverage).toEqual(
          captured.sourceCoverage,
        );
        expect(terminal.handoff?.usage).toEqual(captured.usage);
        expect(await repo.getPayload(key, id)).toBeNull();
      },
    );
    it.each(["captured", "omitted"] as const)(
      "holds a settled %s capture when generation cannot replace lost continuity",
      async (stage) => {
        unwrap(await repo.beginCapture(begin));
        unwrap(
          await settle(
            capturedHandoff({
              continuationDisposition: "clear",
              ...(stage === "omitted"
                ? {
                    stage,
                    candidate: null,
                    omissionReason: "capture_failed" as const,
                  }
                : {}),
            }),
          ),
        );
        unwrap(
          await repo.recordOutcome({
            key,
            operationId: id,
            expectedPhase: "building",
            phase: "needs_reconciliation",
            failure: {
              code: "capture_continuation_lost",
              message: "Generation failed after source continuity was lost",
            },
            at: "terminal",
          }),
        );
        const held = await repo.getOperation(key, id);
        expect(held?.phase).toBe("needs_reconciliation");
        expect(held?.lastStablePhase).toBe("building");
        expect(held?.handoff).toMatchObject({
          stage: "omitted",
          executionSettled: true,
          auditDurable: true,
          continuationDisposition: "clear",
          executionStopAttestation: null,
          omissionReason:
            stage === "omitted" ? "capture_failed" : "checkpoint_failed",
          candidate: null,
          contentHash: captured.contentHash,
        });
        expect(await repo.getPayload(key, id)).toBeNull();
      },
    );
    it.each([
      { disposition: "retain" as const, code: "capture_continuation_lost" },
      { disposition: "clear" as const, code: "capture_cleanup_unverified" },
    ])(
      "refuses a settled hold without a matching continuation-loss reason ($disposition/$code)",
      async ({ disposition, code }) => {
        unwrap(await repo.beginCapture(begin));
        unwrap(
          await settle(
            capturedHandoff({ continuationDisposition: disposition }),
          ),
        );
        const before = await repo.getOperation(key, id);
        const result = await repo.recordOutcome({
          key,
          operationId: id,
          expectedPhase: "building",
          phase: "needs_reconciliation",
          failure: {
            code,
            message: "Cannot establish a continuation-loss hold",
          },
          at: "terminal",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.refusal.code).toBe("illegal_transition");
        expect(await repo.getOperation(key, id)).toEqual(before);
      },
    );
    it("retains ownership on interrupted execution and records explicit attestation without releasing it", async () => {
      unwrap(await repo.beginCapture(begin));
      expect(
        (
          await repo.recordOutcome({
            key,
            operationId: id,
            expectedPhase: "building",
            phase: "cancelled",
            at: "cancel",
          })
        ).ok,
      ).toBe(false);
      const held = unwrap(
        await repo.recordOutcome({
          key,
          operationId: id,
          expectedPhase: "building",
          phase: "needs_reconciliation",
          failure: {
            code: "capture_interrupted",
            message: "execution unknown",
          },
          at: "restart",
        }),
      );
      expect(held.handoff?.omissionReason).toBe("interrupted");
      expect(held.handoff?.executionSettled).toBe(false);
      const attest = {
        key,
        operationId: id,
        expectedPhase: "needs_reconciliation" as const,
        phase: "needs_reconciliation" as const,
        captureExecutionStopAttestation: { at: "ack", source: "cli" as const },
        at: "ack",
      };
      const acknowledged = unwrap(await repo.recordOutcome(attest));
      expect(acknowledged.phase).toBe("needs_reconciliation");
      expect(acknowledged.handoff?.executionStopAttestation).toEqual(
        attest.captureExecutionStopAttestation,
      );
      expect(acknowledged.handoff?.continuationDisposition).toBe("clear");
      expect(unwrap(await repo.recordOutcome(attest))).toEqual(acknowledged);
      expect(
        (
          await repo.recordOutcome({
            key,
            operationId: id,
            expectedPhase: "needs_reconciliation",
            phase: "ready",
            at: "unsafe",
          })
        ).ok,
      ).toBe(false);
      expect(await repo.getPayload(key, id)).toBeNull();
    });

    it("binds unsettled capture observations to their exact attempt and keeps cleanup held", async () => {
      unwrap(await repo.beginCapture(begin));
      const observation = {
        key,
        operationId: id,
        expectedPhase: "building" as const,
        phase: "needs_reconciliation" as const,
        failure: {
          code: "capture_cleanup_unverified",
          message: "owned child remains uncertain",
        },
        at: settledAt,
        captureObservation: {
          captureId: pending.captureId,
          modeEstablished: true,
          submitted: true,
          correlatedCompletion: false,
          activity: captured.activity,
          usage: captured.usage,
          continuationDisposition: "retain" as const,
        },
      };
      expect(
        await repo.recordOutcome({
          ...observation,
          captureObservation: {
            ...observation.captureObservation,
            captureId: "wrong-attempt",
          },
        }),
      ).toMatchObject({ ok: false, refusal: { code: "invalid_handoff" } });
      expect((await repo.getOperation(key, id))?.phase).toBe("building");
      expect(
        await repo.recordOutcome({ ...observation, phase: "failed" }),
      ).toMatchObject({ ok: false, refusal: { code: "invalid_handoff" } });
      unwrap(await repo.recordOutcome(observation));
      expect((await repo.getOperation(key, id))?.handoff).toMatchObject({
        submitted: true,
        modeEstablished: true,
        stage: "omitted",
        omissionReason: "cleanup_unverified",
        executionSettled: false,
        auditDurable: false,
        candidate: null,
        settledAt: null,
        activity: captured.activity,
        usage: captured.usage,
      });
      expect((await repo.getOperation(key, id))?.phase).toBe(
        "needs_reconciliation",
      );
      expect(await repo.getPayload(key, id)).toBeNull();
    });

    it("refuses observed cleanup outside a capture cleanup hold", async () => {
      const observation = {
        key,
        operationId: id,
        captureCleanupObserved: { captureId: pending.captureId },
        phase: "needs_reconciliation" as const,
        at: "observed",
      };
      const before = await repo.getOperation(key, id);
      const building = await repo.recordOutcome({
        ...observation,
        expectedPhase: "building",
      });
      expect(building.ok).toBe(false);
      if (!building.ok) expect(building.refusal.code).toBe("invalid_handoff");
      expect(await repo.getOperation(key, id)).toEqual(before);
      await capture();
      unwrap(
        await repo.freezePayload({
          key,
          operationId: id,
          payload: payload(true),
          handoffDecision: "included",
          at: "freeze",
        }),
      );
      const frozen = await repo.getOperation(key, id);
      const rejected = await repo.recordOutcome({
        ...observation,
        expectedPhase: "retiring",
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.refusal.code).toBe("invalid_handoff");
      expect(await repo.getOperation(key, id)).toEqual(frozen);
      expect(await repo.getPayload(key, id)).not.toBeNull();
    });

    it("records observed capture cleanup durably without operator testimony or releasing the hold", async () => {
      unwrap(await repo.beginCapture(begin));
      unwrap(
        await repo.recordOutcome({
          key,
          operationId: id,
          expectedPhase: "building",
          phase: "needs_reconciliation",
          failure: {
            code: "capture_cleanup_unverified",
            message: "close pending",
          },
          at: "hold",
        }),
      );
      const recovery = {
        key,
        requestId: "recovery",
        recoversOperationId: id,
        sourceBasis: basis,
        priorBackendRef: null,
        requestedAt: "recover",
      };
      const blocked = await repo.admitRecovery(recovery);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.refusal.code).toBe("invalid_handoff");
      const observation = {
        key,
        operationId: id,
        expectedPhase: "needs_reconciliation" as const,
        phase: "needs_reconciliation" as const,
        captureCleanupObserved: { captureId: pending.captureId },
        at: "observed",
      };
      const result = unwrap(await repo.recordOutcome(observation));
      expect(result.handoff).toMatchObject({
        stage: "omitted",
        omissionReason: "cleanup_unverified",
        candidate: null,
        executionSettled: true,
        auditDurable: true,
        continuationDisposition: "clear",
        executionStopAttestation: null,
        settledAt: "observed",
      });
      expect(result.phase).toBe("needs_reconciliation");
      expect(await repo.getOperation(key, id)).toEqual(result);
      expect(await repo.getPayload(key, id)).toBeNull();
      expect(unwrap(await repo.recordOutcome(observation))).toEqual(result);
      for (const invalid of [
        { ...observation, captureCleanupObserved: { captureId: "wrong" } },
        { ...observation, phase: "ready" as const },
        {
          ...observation,
          captureExecutionStopAttestation: {
            at: "observed",
            source: "cli" as const,
          },
        },
      ]) {
        const rejected = await repo.recordOutcome(invalid);
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.refusal.code).toBe("invalid_handoff");
        expect(await repo.getOperation(key, id)).toEqual(result);
      }
      expect(
        unwrap(await repo.admitRecovery(recovery)).operation
          .recoversOperationId,
      ).toBe(id);
    });

    it("preserves a prior omission reason through later checkpoint failure", async () => {
      const omitted = pendingHandoff({
        stage: "omitted",
        omissionReason: "unavailable",
        executionSettled: true,
        auditDurable: true,
        settledAt,
        finalSourceBasis: basis,
      });
      unwrap(await settle(omitted, "pending"));
      const failed = unwrap(
        await repo.recordOutcome({
          key,
          operationId: id,
          expectedPhase: "building",
          phase: "failed",
          failure: { code: "generation_failed", message: "failed" },
          at: "failed",
        }),
      );
      expect(failed.handoff?.omissionReason).toBe("unavailable");
    });

    it("rolls back the seed insert if capture finalization fails", async () => {
      await capture();
      fx.db.exec(
        "CREATE TRIGGER fail_freeze BEFORE UPDATE ON conversation_checkpoint_operations WHEN NEW.phase = 'retiring' BEGIN SELECT RAISE(ABORT, 'freeze fault'); END",
      );
      await expect(
        repo.freezePayload({
          key,
          operationId: id,
          payload: payload(true),
          handoffDecision: "included",
          at: "freeze",
        }),
      ).rejects.toThrow("freeze fault");
      expect(await repo.getPayload(key, id)).toBeNull();
      expect((await repo.getOperation(key, id))?.handoff?.stage).toBe(
        "captured",
      );
    });

    it("rejects a pending intent carrying completed execution or a stop attestation", async () => {
      const otherId = "new-op";
      unwrap(
        await repo.recordOutcome({
          key,
          operationId: id,
          expectedPhase: "building",
          phase: "cancelled",
          at: "cancel",
        }),
      );
      const result = await repo.admitOperation({
        key,
        requestId: otherId,
        sourceBasis: basis,
        priorBackendRef: "prior",
        requestedAt: "now",
        handoff: {
          ...pending,
          captureId: `${otherId}:capture`,
          stopIntent: "cancel",
          executionSettled: true,
          auditDurable: true,
          executionStopAttestation: { at: "old", source: "cli" },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe("invalid_handoff");
      expect(await repo.getOperation(key, otherId)).toBeNull();
    });

    it("rejects a terminal operation that still claims an unfrozen captured candidate", async () => {
      const operation = await capture();
      expect(checkpointOperationSchema.safeParse(operation).success).toBe(true);
      const invalid = checkpointOperationSchema.safeParse({
        ...operation,
        phase: "failed",
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success)
        expect(invalid.error.issues[0]?.path).toEqual(["handoff"]);
    });
  },
);
