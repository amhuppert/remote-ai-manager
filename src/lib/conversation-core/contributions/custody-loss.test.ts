import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionService } from "@/lib/subscriptions/service";
import { createCustodyLossRecorder } from "./custody-loss";

const identity = {
  projectPath: "/p",
  storeSessionName: "s",
  conversationId: "conv-1",
};
const recipient = { projectPath: "/p", conversationId: "conv-1" };

let persistence: PersistenceFixture | undefined;
afterEach(() => persistence?.close());

function recorderOverFixture() {
  persistence = createPersistenceFixture();
  const service = createSubscriptionService({
    repo: createConversationSubscriptionsRepo(
      persistence.db,
      createWriteQueue(),
    ),
    isRecipientEligible: async () => true,
    readSource: async () => ({ cursor: "0", facts: [], missing: false }),
  });
  const transcript = new Map<string, TranscriptEntry>();
  const record = createCustodyLossRecorder({
    recordRuntimeLossNotice: (input) => service.recordRuntimeLossNotice(input),
    async appendTranscriptEntryOnce(_identity, entry) {
      if (!transcript.has(entry.id)) transcript.set(entry.id, entry);
    },
    log: createCapturingLogger(),
  });
  return { record, service, transcript };
}

describe("custody loss", () => {
  it("tells the conversation's next turn and the person that work custody held was cut short, once however often a restart records it", async () => {
    const { record, service, transcript } = recorderOverFixture();

    await record({
      identity,
      key: "custody-1",
      end: "interrupted",
      collected: true,
      tasks: [],
    });
    // A crash before custody settled: the next boot records it again.
    await record({
      identity,
      key: "custody-1",
      end: "interrupted",
      collected: true,
      tasks: [],
    });

    const briefing = await service.prepareRuntimeLossNotice({
      recipient,
      attemptId: "turn-2",
    });
    expect(briefing.block).toContain("<runtime_recovery>");
    expect(
      briefing.block?.match(/"event":"background-tasks-lost"/g),
    ).toHaveLength(1);
    expect(briefing.block).toContain("the server stopped");
    expect(briefing.block).toContain("will not arrive");
    expect([...transcript.values()]).toEqual([
      expect.objectContaining({
        type: "notice",
        role: "notice",
        content: [
          {
            type: "text",
            text: expect.stringContaining("the server stopped"),
          },
        ],
      }),
    ]);
  });

  it("says why for each way custody can cut work short", async () => {
    const { record, service } = recorderOverFixture();
    await record({
      identity,
      key: "a",
      end: "stopped",
      collected: true,
      tasks: [],
    });
    await record({
      identity,
      key: "b",
      end: "lost",
      collected: true,
      tasks: [],
    });
    await record({
      identity,
      key: "c",
      end: "timed_out",
      collected: true,
      tasks: [],
    });
    await record({
      identity,
      key: "d",
      end: "reconfigured",
      collected: true,
      tasks: [],
    });

    const briefing = await service.prepareRuntimeLossNotice({
      recipient,
      attemptId: "turn-2",
    });
    expect(briefing.block).toContain("it was stopped");
    expect(briefing.block).toContain("the agent's process ended");
    expect(briefing.block).toContain("120 minutes");
    // A configuration change is no one's stop.
    expect(briefing.block).toContain("configuration changed");
    expect(briefing.block?.match(/it was stopped/g)).toHaveLength(1);
  });

  it("says a merge of the session stopped work that custody could not keep (design C5b §3.3)", async () => {
    const { record, service } = recorderOverFixture();
    await record({
      identity,
      key: "turn-1",
      end: "merging",
      collected: true,
      tasks: [],
    });

    const briefing = await service.prepareRuntimeLossNotice({
      recipient,
      attemptId: "turn-2",
    });
    expect(briefing.block).toContain(
      "cut short because the session is being merged",
    );
  });

  it("claims no termination it did not see: when the processes could not be confirmed stopped, only the person hears it, and nothing is re-run", async () => {
    const { record, service, transcript } = recorderOverFixture();
    await record({
      identity,
      key: "custody-1",
      end: "stopped",
      collected: false,
      tasks: [],
    });

    const briefing = await service.prepareRuntimeLossNotice({
      recipient,
      attemptId: "turn-2",
    });
    expect(briefing.block).toBeNull();
    const [notice] = [...transcript.values()];
    const text =
      notice?.content?.[0]?.type === "text" ? notice.content[0].text : "";
    expect(text).toContain("could not be confirmed");
    expect(text).not.toContain("re-run");
    expect(text).not.toMatch(/were terminated/);
  });
});
