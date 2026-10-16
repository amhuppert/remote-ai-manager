import { describe, expect, it } from "vitest";
import { activeWaitCausation } from "./active-wait-causation";

const recipient = { projectPath: "/repo", conversationId: "conversation" };

describe("active wait transport causation", () => {
  it("includes the originating wake and accepted in-turn wakes belonging to this recipient", async () => {
    const parents = await activeWaitCausation(
      recipient,
      {
        autonomous: false,
        originMessageId: "origin",
        acceptedSubscriptionBatchIds: [
          "live",
          "origin",
          "missing",
          "other-project",
          "other-conversation",
        ],
      },
      {
        async getBatch(id) {
          if (id === "missing") return null;
          return {
            id,
            recipient: {
              ...recipient,
              ...(id === "other-project" ? { projectPath: "/elsewhere" } : {}),
              ...(id === "other-conversation"
                ? { conversationId: "elsewhere" }
                : {}),
            },
          };
        },
      },
    );
    expect(parents).toEqual(["origin", "live"]);
  });

  it("keeps at most eight verified recent parents and treats an ordinary prompt as no wake", async () => {
    const accepted = Array.from({ length: 8 }, (_, index) => `wake-${index}`);
    const deps = {
      async getBatch(id: string) {
        return id === "human-prompt" ? null : { id, recipient };
      },
    };
    expect(
      await activeWaitCausation(
        recipient,
        {
          autonomous: true,
          originMessageId: "origin",
          acceptedSubscriptionBatchIds: accepted,
        },
        deps,
      ),
    ).toEqual(accepted);
    expect(
      await activeWaitCausation(
        recipient,
        {
          autonomous: false,
          originMessageId: "human-prompt",
        },
        deps,
      ),
    ).toEqual([]);
    expect(await activeWaitCausation(recipient, null, deps)).toEqual([]);
  });
});
