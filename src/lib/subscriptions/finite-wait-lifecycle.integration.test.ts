import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { createJobsRepo } from "@/lib/jobs/repo";
import { validationRunRecordSchema } from "@/lib/validation/schemas";
import { createSubscriptionRuntime } from "./service-factory";
import { retireConsumedFiniteWaitSourcesMigration } from "@/lib/state-store/migrations/0067-retire-consumed-finite-wait-sources";

let fixture: PersistenceFixture | undefined;
afterEach(() => {
  fixture?.close();
  vi.useRealTimers();
});
const recipient = {
  projectPath: "/repos/finite-lifecycle",
  conversationId: "recipient",
};

async function harness(kind: "validation" | "git_job") {
  const f = createPersistenceFixture();
  fixture = f;
  f.seedProject(recipient.projectPath);
  await f.seedProjectConversation(
    recipient.projectPath,
    makeConversationState({ id: recipient.conversationId, scope: "project" }),
  );
  const initialAt = new Date().toISOString();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(initialAt);
  const validations = createValidationRunsRepo(f.db);
  const jobs = createJobsRepo(f.db);
  if (kind === "validation")
    validations.submit(
      validationRunRecordSchema.parse({
        runId: "operation",
        source: "agent_cli",
        commandName: "test",
        cost: 1,
        queueOrder: 0,
        status: "running",
        nonce: "nonce",
        leaseToken: null,
        leaseExpiresAt: null,
        processGroupPid: null,
        projectPath: recipient.projectPath,
        worktreePath: recipient.projectPath,
        sessionName: null,
        conversationId: null,
        workflowExecutionId: null,
        workflowContextId: null,
        workflowRole: null,
        submittedAt: initialAt,
        startedAt: initialAt,
        finishedAt: null,
        queueMs: null,
        execMs: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        scopedPathCount: 0,
        exitCode: null,
        timedOut: false,
      }),
    );
  else
    jobs.createJobRecord({
      jobId: "operation",
      jobType: "commit",
      status: "running",
      projectName: "finite-lifecycle",
      sessionName: "work",
      branchName: "branch",
      startedAt: initialAt,
    });
  const runtime = createSubscriptionRuntime(f.db, createWriteQueue());
  const source = { kind, id: "operation" };
  const input = {
    recipient,
    source,
    reason: "Inspect the result",
    expiresAt: new Date(Date.parse(initialAt) + 1000).toISOString(),
  };
  return {
    ...runtime,
    input,
    finish() {
      if (kind === "validation")
        validations.markPassed(source.id, {
          finishedAt: new Date().toISOString(),
          execMs: 1,
          exitCode: 0,
        });
      else jobs.updateJobRecord(source.id, { status: "completed" });
    },
    advance() {
      vi.setSystemTime(Date.parse(initialAt) + 2000);
    },
    nextInput() {
      return { ...input, expiresAt: new Date(Date.now() + 1000).toISOString() };
    },
  };
}

describe.each(["validation", "git_job"] as const)(
  "finite %s wait lifecycle",
  (kind) => {
    it("repairs a legacy cancelled wait's null cursor without baselining away its later result", async () => {
      const h = await harness(kind);
      const first = await h.activeWaitService.register(h.input);
      await h.controlsService.cancel(recipient, first.subscriptionId);
      if (!fixture) throw Error("Expected fixture");
      fixture.db
        .prepare("UPDATE conversation_subscriptions SET cursor=NULL WHERE id=?")
        .run(first.subscriptionId);
      await retireConsumedFiniteWaitSourcesMigration.up({
        name: retireConsumedFiniteWaitSourcesMigration.name,
        context: { db: fixture.db, configDir: null },
      });
      h.finish();
      const receipt = await h.service.prepareBriefing({
        recipient,
        attemptId: "legacy-later",
      });
      expect(receipt.block).toContain(
        kind === "validation" ? "passed" : "completed",
      );
      await receipt.onInputAccepted();
      expect(
        (await h.repo.readInbox(recipient, { includeSettled: true })).items,
      ).toHaveLength(1);
    });
    it.each(["cancel", "expiry"] as const)(
      "delivers the later terminal result passively after %s and retires only after consumption",
      async (end) => {
        const h = await harness(kind);
        const wait = await h.activeWaitService.register(h.input);
        if (end === "cancel")
          await h.controlsService.cancel(recipient, wait.subscriptionId);
        else {
          h.advance();
          await h.activeWaitService.reconcile(recipient);
          const batch = await h.activeWaitService.prepareBatch(recipient);
          if (!batch) throw Error("Expected expiry wake");
          await h.activeWaitService.settleBatch(batch.id, "accepted");
        }
        expect(await h.repo.get(recipient, wait.subscriptionId)).toMatchObject({
          mode: "passive",
          status: "following",
          expiresAt: null,
        });
        h.finish();
        const briefing = await h.service.prepareBriefing({
          recipient,
          attemptId: "later-result",
        });
        expect(briefing.block).toContain(
          kind === "validation" ? "passed" : "completed",
        );
        await briefing.onInputAccepted();
        const follow = await h.repo.get(recipient, wait.subscriptionId);
        expect(follow?.expiresAt).not.toBeNull();
        expect(Date.parse(follow?.expiresAt ?? "")).toBeLessThanOrEqual(
          Date.now(),
        );
        await h.controlsService.subscribe({
          recipient,
          source: h.input.source,
          reason: "Inspect the result",
          mode: "passive",
        });
        expect(
          (await h.repo.get(recipient, wait.subscriptionId))?.expiresAt,
        ).toBe(follow?.expiresAt);
        expect(
          (await h.service.prepareBriefing({ recipient, attemptId: "again" }))
            .block,
        ).toBeNull();
        await expect(
          h.activeWaitService.register(h.nextInput()),
        ).rejects.toMatchObject({
          code: "ACTIVE_WAIT_SOURCE_FINAL",
          status: 409,
        });
        expect(await h.activeWaitService.list(recipient)).toHaveLength(1);
      },
    );
    it.each(["cancel", "expiry"] as const)(
      "obtains a terminal result never delivered by a %s wait instead of baselining it away",
      async (end) => {
        const h = await harness(kind);
        const first = await h.activeWaitService.register(h.input);
        if (end === "cancel")
          await h.controlsService.cancel(recipient, first.subscriptionId);
        else {
          h.advance();
          await h.activeWaitService.reconcile(recipient);
          const expiry = await h.activeWaitService.prepareBatch(recipient);
          if (!expiry) throw Error("Expected expiry wake");
          await h.activeWaitService.settleBatch(expiry.id, "accepted");
        }
        h.finish();
        const next = await h.activeWaitService.register(h.nextInput());
        expect(next).toMatchObject({
          state: "ready",
          outcome: "source_terminal",
          baselineOccurrenceId: null,
        });
        const batch = await h.activeWaitService.prepareBatch(recipient);
        if (!batch) throw Error("Expected terminal wake");
        await h.activeWaitService.settleBatch(batch.id, "accepted");
        expect(
          (
            await h.repo.readInbox(recipient, { includeSettled: true })
          ).items.filter(
            (row) => row.fact.eventKind !== "subscription-wait-expired",
          ),
        ).toHaveLength(1);
        await expect(
          h.activeWaitService.register(h.nextInput()),
        ).rejects.toMatchObject({ code: "ACTIVE_WAIT_SOURCE_FINAL" });
        expect(await h.activeWaitService.list(recipient)).toHaveLength(2);
      },
    );
  },
);
