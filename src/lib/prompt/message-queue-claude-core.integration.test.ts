/**
 * Claude live input through the conversation core (design C5b §4.2): the
 * The real queue, the core's interactive turns, the
 * production turn input, queue accounting and conversation records over a
 * persistence fixture; the provider is a Claude-shaped runtime at its I/O
 * boundary, one whose input may be answered after the turn's result.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputDeliveryUncertainError } from "@/lib/agent-backends/errors";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createCoreLiveQueueHarness } from "./testing/core-live-queue-fixture";

describe.each(["session", "project"] as const)(
  "Claude live input through the core's running turn (%s)",
  (scope) => {
    let fixture: PersistenceFixture;
    const key = {
      projectPath: "/repo",
      sessionName:
        scope === "project" ? PROJECT_CONVERSATION_SESSION_SENTINEL : "session",
      conversationId: `claude-live-${scope}`,
    };
    const PROMPTS_BEFORE = 4;

    beforeEach(async () => {
      fixture = createPersistenceFixture();
      fixture.seedProject(key.projectPath);
      const conversation = makeConversationState({
        id: key.conversationId,
        status: "awaiting",
        agentBackend: "claude",
        promptCount: PROMPTS_BEFORE,
        scope,
      });
      if (scope === "project") {
        await fixture.seedProjectConversation(key.projectPath, conversation);
      } else {
        fixture.seedSession(key.projectPath, key.sessionName);
        await fixture.seedConversation(
          key.projectPath,
          key.sessionName,
          conversation,
        );
      }
    });
    afterEach(() => fixture.close());

    const harness = () => createCoreLiveQueueHarness(fixture, key);

    it("queues during a running Claude turn, delivers it into the turn on acceptance, archives it once and releases the row (pending → delivered)", async () => {
      const h = harness();
      const turn = await h.startTurn();
      const result = await h.send("live message");

      expect(result).toMatchObject({
        entry: { status: "pending" },
        deliveryTiming: "in_turn",
      });
      expect(h.sent).toEqual(["live message"]);
      expect(h.order).toEqual(["send", "archive", "release"]);
      expect(h.archive).toHaveLength(1);
      expect(h.archive[0]).toMatchObject({
        id: result.entry.id,
        type: "user",
        role: "user",
        content: [{ type: "text", text: "live message" }],
      });
      const reloaded = await h.reload();
      expect(reloaded?.pendingQueue).toEqual([]);
      // An input the provider may answer after the turn counts as a prompt once accepted.
      expect(reloaded?.promptCount).toBe(PROMPTS_BEFORE + 1);
      expect(await h.service.listActive(key)).toEqual([]);

      h.endTurn();
      await turn.ended;
      expect((await h.reload())?.promptCount).toBe(PROMPTS_BEFORE + 2);
    });

    it("holds a lost live acknowledgement for review without next-turn redelivery", async () => {
      const h = harness();
      h.runtime.queueUserInput = async () => {
        throw new InputDeliveryUncertainError("acknowledgement lost");
      };
      const turn = await h.startTurn();
      const result = await h.send("only once");
      h.endTurn();
      await turn.ended;

      expect(result.entry.status).toBe("uncertain");
      expect(h.archive).toEqual([]);
      const reloaded = await h.reload();
      expect(reloaded?.pendingQueue).toMatchObject([{ status: "uncertain" }]);
      expect(reloaded?.promptCount).toBe(PROMPTS_BEFORE + 1);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });

    it("holds an uncertain delivery from another copy of the provider error class without redelivery", async () => {
      class StartupCopyOfInputDeliveryUncertainError extends Error {
        constructor() {
          super("acknowledgement lost");
          this.name = "InputDeliveryUncertainError";
        }
      }
      const h = harness();
      h.runtime.queueUserInput = async () => {
        throw new StartupCopyOfInputDeliveryUncertainError();
      };
      const turn = await h.startTurn();
      const result = await h.send();
      h.endTurn();
      await turn.ended;
      expect(result.entry.status).toBe("uncertain");
      expect(h.archive).toEqual([]);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });

    it("attaches a passive briefing to live user input, accepted with it, without recording it as the person's text", async () => {
      const h = harness();
      let briefing = "pending";
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => {
          briefing = "queued";
          return {
            block: "<passive-briefing>Latest update</passive-briefing>",
            onInputAccepted: async () => {
              briefing = "accepted";
            },
            finish: async () => {},
          };
        },
      };
      const turn = await h.startTurn();
      briefing = "pending";
      await h.send();

      expect(briefing).toBe("accepted");
      expect(h.sent[0]).toContain(
        "<passive-briefing>Latest update</passive-briefing>",
      );
      expect(h.sent[0]).toContain("hello");
      expect(h.archive[0]?.content).toEqual([{ type: "text", text: "hello" }]);
      expect((await h.reload())?.pendingQueue).toEqual([]);
      h.endTurn();
      await turn.ended;
    });

    it("holds a live delivery the runtime never confirmed as uncertain, with its briefing", async () => {
      const h = harness();
      let disposition: string | undefined;
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => ({
          block: "Update",
          onInputAccepted: async () => {},
          finish: async (options) => {
            disposition = options?.disposition;
          },
        }),
      };
      const turn = await h.startTurn();
      h.runtime.queueUserInput = async () => {};
      const result = await h.send();
      h.endTurn();
      await turn.ended;

      expect(result.entry.status).toBe("uncertain");
      expect(disposition).toBe("uncertain");
      expect((await h.reload())?.pendingQueue).toMatchObject([
        { status: "uncertain" },
      ]);
    });

    it("holds accepted input whose archive failed for review, never returning it to pending", async () => {
      const h = harness();
      const turn = await h.startTurn();
      h.failures.archive = true;
      await h.send();
      h.endTurn();
      await turn.ended;

      expect(h.sent).toEqual(["hello"]);
      expect(h.archive).toEqual([]);
      expect((await h.reload())?.pendingQueue).toMatchObject([
        { status: "uncertain" },
      ]);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });

    it("holds accepted input whose release failed for review, and delivers nothing past it", async () => {
      const h = harness();
      const turn = await h.startTurn();
      h.failures.release = true;
      await h.send();
      await h.send("later");
      h.endTurn();
      await turn.ended;

      expect(h.sent).toEqual(["hello"]);
      expect(h.archive).toHaveLength(1);
      expect(
        (await h.reload())?.pendingQueue.map((entry) => entry.status),
      ).toEqual(["uncertain", "pending"]);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });
  },
);
