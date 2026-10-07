import { describe, expect, it } from "vitest";
import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import {
  preparePassiveSubscriptionContext,
  type PassiveSubscriptionContextDependencies,
} from "./passive-subscription-context";

function fixture() {
  let state = "pending";
  let preparations = 0;
  let failAcceptance = false;
  let accepted = false;
  const finishes: (() => Promise<void>)[] = [];
  const deps: PassiveSubscriptionContextDependencies = {
    prepareBriefing: async () => {
      preparations++;
      state = "queued";
      return {
        block: "<passive-briefing>Update</passive-briefing>",
        onInputAccepted: async () => {
          accepted = true;
          if (failAcceptance) throw new Error("receipt unavailable");
          state = "accepted";
        },
        finish: async (options) => {
          if (accepted) {
            if (failAcceptance) throw new Error("receipt unavailable");
            state = "accepted";
          } else
            state =
              options?.disposition === "not_sent" ? "pending" : "uncertain";
        },
      };
    },
  };
  return {
    prepare: (eligible = true) =>
      preparePassiveSubscriptionContext(
        deps,
        {
          recipient: { projectPath: "/repo", conversationId: "c" },
          attemptId: "attempt",
          eligible,
        },
        (finish) => finishes.push(finish),
      ),
    state: () => state,
    preparations: () => preparations,
    finishes,
    failAcceptance: (value: boolean) => {
      failAcceptance = value;
    },
  };
}

describe("passive subscription delivery", () => {
  it("leaves machine input pending without claiming a briefing", async () => {
    const f = fixture();
    const context = await f.prepare(false);
    await context.onInputAccepted();
    await context.finish();
    expect(f.preparations()).toBe(0);
    expect(f.state()).toBe("pending");
    expect(context.block).toBeNull();
  });

  it("settles only on input acceptance and owns the required receipt", async () => {
    const f = fixture();
    const context = await f.prepare();
    expect(context.block).toContain("Update");
    expect(f.state()).toBe("queued");
    expect(f.finishes).toHaveLength(1);
    context.markDispatched();
    await context.onInputAccepted();
    await context.finish();
    expect(f.state()).toBe("accepted");
  });

  it("releases preparation failures and proven undelivered sends", async () => {
    for (const dispatched of [false, true]) {
      const f = fixture();
      const context = await f.prepare();
      if (dispatched) {
        context.markDispatched();
        context.markDispatchFailure(
          markPromptNotDelivered(new Error("closed")),
        );
      }
      await context.finish();
      expect(f.state()).toBe("pending");
    }
  });

  it("holds a send without acceptance as uncertain, including a replacement send", async () => {
    const f = fixture();
    const context = await f.prepare();
    context.markDispatched();
    context.markDispatchFailure(markPromptNotDelivered(new Error("closed")));
    context.markDispatched();
    await context.finish();
    expect(f.state()).toBe("uncertain");
    expect(f.preparations()).toBe(1);
  });

  it("repairs an accepted receipt without preparing or dispatching again", async () => {
    const f = fixture();
    const context = await f.prepare();
    context.markDispatched();
    f.failAcceptance(true);
    await expect(context.onInputAccepted()).rejects.toThrow(
      "receipt unavailable",
    );
    await expect(context.finish()).rejects.toThrow("receipt unavailable");
    f.failAcceptance(false);
    await context.finish();
    expect(f.state()).toBe("accepted");
    expect(f.preparations()).toBe(1);
  });

  it("refuses dispatch after its owner finishes an unsent briefing", async () => {
    const f = fixture();
    const context = await f.prepare();
    await f.finishes[0]?.();
    expect(() => context.markDispatched()).toThrow("finalized");
    expect(f.state()).toBe("pending");
  });
});
