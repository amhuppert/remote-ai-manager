import { describe, it, expect, vi } from "vitest";
import type { RecordSubscriptionNoticeInput } from "@/lib/subscriptions/service";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { createBackgroundTasksLostHandler } from "./background-tasks-lost";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionService } from "@/lib/subscriptions/service";

const identity = {
  projectPath: "/p",
  sessionName: "s",
  conversationId: "conv-1",
};
const info = {
  reason: "session_closed",
  tasks: [
    { taskId: "t1", description: "watcher" },
    { taskId: "t2", description: null },
  ],
};

function makeHandler(isProjectConversation = false) {
  const records: RecordSubscriptionNoticeInput[] = [];
  const appended: TranscriptEntry[] = [];
  const log = createCapturingLogger();
  const deps = {
    async recordRuntimeLossNotice(input: RecordSubscriptionNoticeInput) {
      records.push(input);
      return true;
    },
    log,
  };
  const handler = createBackgroundTasksLostHandler(deps, {
    ...identity,
    sessionName: isProjectConversation ? "__project__" : "s",
    appendTranscriptEntry: async (_id, entry) => {
      appended.push(entry);
    },
  });
  return { handler, deps, records, appended, log };
}

describe("createBackgroundTasksLostHandler", () => {
  it.each(["long tasks", "escaped details"] as const)(
    "delivers a bounded briefing for %s and durably preserves full loss evidence",
    async (scenario) => {
      const persistence = createPersistenceFixture();
      try {
        const repo = createConversationSubscriptionsRepo(
          persistence.db,
          createWriteQueue(),
        );
        const service = createSubscriptionService({
          repo,
          isRecipientEligible: async () => true,
          readSource: async () => ({ cursor: "0", facts: [], missing: false }),
        });
        const transcript: TranscriptEntry[] = [];
        const handler = createBackgroundTasksLostHandler(
          {
            recordRuntimeLossNotice: (input) =>
              service.recordRuntimeLossNotice(input),
            log: createCapturingLogger(),
          },
          {
            ...identity,
            appendTranscriptEntry: async (_id, entry) => {
              transcript.push(entry);
            },
          },
        );
        const loss = {
          reason:
            scenario === "escaped details"
              ? "shutdown " + "<>\u2028\u2029".repeat(200)
              : "session_closed",
          tasks: Array.from({ length: 100 }, (_, i) => ({
            taskId: `task-${i}`,
            description:
              scenario === "escaped details"
                ? "<>\u2028\u2029".repeat(1000)
                : `Long watcher ${i}: ` + "task evidence ".repeat(200),
          })),
        };
        await handler(loss);
        const recipient = { projectPath: "/p", conversationId: "conv-1" };
        const briefing = await service.prepareRuntimeLossNotice({
          recipient,
          attemptId: scenario,
        });

        expect(briefing.block).toContain('"event":"background-tasks-lost"');
        expect(briefing.block?.length).toBeLessThanOrEqual(2400);
        expect(briefing.block).toContain("100 background task(s)");
        expect(briefing.block).toContain("omitted");
        const reloaded = createConversationSubscriptionsRepo(
          persistence.db,
          createWriteQueue(),
        );
        const delivery = (await reloaded.readInbox(recipient, {})).items[0];
        expect(delivery?.fact.sourceText).toContain(loss.reason);
        expect(delivery?.fact.sourceText).toContain(
          `task-99 (${loss.tasks[99]?.description})`,
        );
        expect(JSON.stringify(transcript[0]?.content)).toContain("task-99");
        expect(delivery?.state).toBe("queued");
        await briefing.onInputAccepted();
        expect(
          (await reloaded.readInbox(recipient, { includeSettled: true }))
            .items[0]?.state,
        ).toBe("accepted");
      } finally {
        persistence.close();
      }
    },
  );

  it.each([false, true])(
    "records an own-conversation inbox notice and human transcript row (project=%s)",
    async (project) => {
      const { handler, records, appended, log } = makeHandler(project);
      await handler(info);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        recipient: { projectPath: "/p", conversationId: "conv-1" },
        source: { kind: "conversation", id: "conv-1" },
        reason: "Background tasks lost",
        fact: {
          eventKind: "background-tasks-lost",
          category: "outcome",
          sourceTitle: "Background tasks",
          revision: null,
          outcome: "terminated",
          retrievalHandle: "cctl conversation read conv-1",
          actorConversationId: null,
        },
      });
      expect(records[0]?.fact.summary).toContain("t1 (watcher)");
      expect(records[0]?.fact.summary).toContain("2 background task(s)");
      expect(records[0]?.fact.summary).toContain("session_closed");
      expect(Number.isNaN(Date.parse(records[0]?.fact.occurredAt ?? ""))).toBe(
        false,
      );
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({ type: "notice", role: "notice" });
      expect(JSON.stringify(appended[0]?.content)).toContain("t1 (watcher)");
      expect(log.entries[0]?.fields).toMatchObject(
        project ? { scope: "project" } : { scope: "session", sessionName: "s" },
      );
      expect(log.allFieldValues()).not.toContain("__project__");
      expect(JSON.stringify(log.entries)).not.toContain("watcher");
    },
  );

  it("assigns a distinct occurrence to every loss invocation", async () => {
    const { handler, records } = makeHandler();
    await handler(info);
    await handler(info);

    const occurrences = records.map(({ fact }) => fact.occurrenceId);
    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences).size).toBe(2);
    expect(occurrences.every((id) => id.length > 0)).toBe(true);
  });

  it("preserves the human notice and logs only failure metadata when inbox persistence rejects", async () => {
    const { deps, appended, log } = makeHandler(true);
    deps.recordRuntimeLossNotice = vi.fn(async () => {
      throw new Error("Inbox unavailable");
    });
    const handler = createBackgroundTasksLostHandler(deps, {
      ...identity,
      sessionName: "__project__",
      appendTranscriptEntry: async (_id, entry) => {
        appended.push(entry);
      },
    });
    await handler(info);

    expect(appended).toHaveLength(1);
    expect(log.entries).toContainEqual({
      level: "warn",
      message: "prompt.background_tasks_lost_persist_failed",
      fields: {
        scope: "project",
        conversationId: "conv-1",
        error: "Inbox unavailable",
      },
    });
    expect(JSON.stringify(log.entries)).not.toContain("watcher");
  });
});
