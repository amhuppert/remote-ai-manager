import { describe, expect, it } from "vitest";
import type { ConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import type { ClaimedQueuedBatch } from "@/lib/conversations/message-queue-service";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import type { UserMessageAdmission } from "./executor";
import { createCoreQueueBridge } from "./queue-bridge";

const place = {
  conversationId: "conv-1",
  projectPath: "/repo",
  sessionName: "session",
};

function harness(
  batch: ClaimedQueuedBatch | null,
  admission: UserMessageAdmission,
  busy = false,
  conversationPlace: typeof place = place,
) {
  const marks: string[] = [];
  const sent: unknown[] = [];
  const claims: unknown[] = [];
  const queue: Omit<ConversationQueueDeps, "submitTurn"> = {
    async claimNextTurnBatch(input) {
      claims.push(input);
      return batch;
    },
    async markPending(input) {
      marks.push(`pending:${input.deliveryAttemptId}`);
    },
    async markDelivered(input) {
      marks.push(`delivered:${input.deliveryAttemptId}`);
    },
    async markFailed(input) {
      marks.push(`failed:${input.deliveryAttemptId}:${input.error}`);
    },
    async recoverAbandonedDeliveries() {
      marks.push("recovered");
      return 1;
    },
    async runConversationCommand() {
      throw new Error("not used");
    },
  };
  const bridge = createCoreQueueBridge({
    queue,
    place: (conversationId) =>
      conversationId === "conv-1" ? conversationPlace : null,
    isBusy: () => busy,
    async send(input) {
      sent.push(input);
      return admission;
    },
    getProjectDisplayName: () => "repo",
    log: createCapturingLogger(),
  });
  return { bridge, marks, sent, claims };
}

const accepted: UserMessageAdmission = {
  kind: "accepted",
  cause: "queue:conv-1:att-1",
  settled: new Promise(() => {}),
};

describe("the core's message queue bridge", () => {
  it("hands the conversation's next queued batch to the core as one message, content and identity included", async () => {
    const h = harness(
      {
        deliveryAttemptId: "att-1",
        messageIds: ["q-1", "q-2"],
        hasUserMessage: true,
        content: [
          { type: "text", text: "Then fix the tests" },
          { type: "image", mediaType: "image/png", base64Data: "aGk=" },
        ],
        modelSelection: { modelId: "opus", parameters: {} },
        command: null,
      },
      accepted,
    );
    await h.bridge.drain("conv-1");

    expect(h.sent).toEqual([
      {
        conversationId: "conv-1",
        text: "Then fix the tests",
        images: [
          {
            attachmentId: "queued-0",
            mediaType: "image/png",
            base64Data: "aGk=",
          },
        ],
        modelSelection: { modelId: "opus", parameters: {} },
        inputOrigin: "user",
        queuedDelivery: {
          messageIds: ["q-1", "q-2"],
          deliveryAttemptId: "att-1",
        },
      },
    ]);
    expect(h.marks).toEqual([]);
  });

  it("hands a project conversation's queued batch to the core, claimed under the project conversation's storage key", async () => {
    const projectStore = storeSessionNameFromScopeRef({ scope: "project" });
    const h = harness(
      {
        deliveryAttemptId: "att-p",
        messageIds: ["q-p"],
        hasUserMessage: true,
        content: [{ type: "text", text: "Next" }],
        command: null,
      },
      accepted,
      false,
      { ...place, sessionName: projectStore },
    );
    await h.bridge.drain("conv-1");

    expect(h.claims).toEqual([
      {
        projectPath: "/repo",
        sessionName: projectStore,
        conversationId: "conv-1",
      },
    ]);
    expect(h.sent).toEqual([
      expect.objectContaining({
        conversationId: "conv-1",
        text: "Next",
        inputOrigin: "user",
      }),
    ]);
    expect(h.marks).toEqual([]);
  });

  it("returns a batch the core would not take to the queue", async () => {
    const h = harness(
      {
        deliveryAttemptId: "att-2",
        messageIds: ["q-3"],
        content: [{ type: "text", text: "Run notice" }],
        command: null,
      },
      { kind: "refused", code: "busy", message: "Conversation is busy" },
    );
    await h.bridge.drain("conv-1");
    expect(h.sent).toEqual([
      expect.objectContaining({ inputOrigin: "generated" }),
    ]);
    expect(h.marks).toEqual(["pending:att-2"]);
  });

  it("claims nothing while the conversation runs a turn; its end drains the queue", async () => {
    const h = harness(
      {
        deliveryAttemptId: "att-3",
        messageIds: ["q-4"],
        content: [{ type: "text", text: "Later" }],
        command: null,
      },
      accepted,
      true,
    );
    await h.bridge.drain("conv-1");
    expect(h.sent).toEqual([]);
    expect(h.marks).toEqual([]);
  });

  it("leaves a conversation the core does not run alone", async () => {
    const h = harness(null, accepted);
    await h.bridge.drain("conv-x");
    await h.bridge.recover("conv-x");
    expect(h.marks).toEqual([]);
  });

  it("recovers what a stopped process left claimed", async () => {
    const h = harness(null, accepted);
    await h.bridge.recover("conv-1");
    expect(h.marks).toEqual(["recovered"]);
  });

  it("after a queued command completes, hands the message queued behind it to the core", async () => {
    const batches: ClaimedQueuedBatch[] = [
      {
        deliveryAttemptId: "att-cmd",
        messageIds: ["c-1"],
        content: [{ type: "text", text: "/commit" }],
        command: { command: "commit", hint: "focus on the API" },
      },
      {
        deliveryAttemptId: "att-2",
        messageIds: ["q-2"],
        content: [{ type: "text", text: "Then deploy" }],
        command: null,
      },
    ];
    const commands: string[] = [];
    const sent: unknown[] = [];
    const bridge = createCoreQueueBridge({
      queue: {
        claimNextTurnBatch: async () => batches.shift() ?? null,
        async markPending() {},
        async markDelivered() {},
        async markFailed() {},
        recoverAbandonedDeliveries: async () => 0,
        async runConversationCommand(input) {
          commands.push(input.rawText);
          return { status: "dispatched", jobId: "job-1", usedFallback: false };
        },
      },
      place: (conversationId) => (conversationId === "conv-1" ? place : null),
      isBusy: () => false,
      async send(input) {
        sent.push(input.text);
        return accepted;
      },
      getProjectDisplayName: () => "repo",
      log: createCapturingLogger(),
    });
    await bridge.drain("conv-1");
    expect(commands).toEqual(["/commit"]);
    expect(sent).toEqual(["Then deploy"]);
  });
});
