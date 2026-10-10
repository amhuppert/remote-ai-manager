import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { NotepadInjectionSource } from "@/lib/notepads/injection";
import type { PreparedSubscriptionBriefing } from "@/lib/subscriptions/service";
import type { PreparedCheckpointSeed } from "@/lib/conversation-checkpoints/checkpoint-seed";
import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import {
  classifyDelivery,
  prepareTurnInput,
  type TurnInputDependencies,
  type TurnInputRequest,
} from "./turn-input";

const notepad: NotepadInjectionSource = {
  id: "np-1",
  name: "Plan",
  revision: 3,
  openComments: { count: 0, latestCreatedAt: null },
  writeMode: "full-edit",
  content: "The plan.",
};

/** Records each write in order; a named write can be made to fail. */
function harness(
  options: {
    failing?: Set<string>;
    briefing?: string | null;
    recovery?: string | null;
    recoveryFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const claimed = { briefing: false };
  const failing = options.failing ?? new Set<string>();
  const write = async (name: string) => {
    calls.push(name);
    if (failing.has(name)) throw new Error(`${name} failed`);
  };
  const briefing: PreparedSubscriptionBriefing = {
    block: options.briefing === undefined ? "<briefing/>" : options.briefing,
    onInputAccepted: () => write("passive"),
    async finish(settled) {
      calls.push(`passive_finish:${settled?.disposition ?? "accepted"}`);
    },
  };
  const deps: TurnInputDependencies = {
    context: {
      getLiveTicketBlock: async () => "<ticket/>",
      getMemoryIndexBlock: async () => ({
        mode: "full",
        composedAt: "t",
        entries: [],
        block: "<memory/>",
        rendered: null,
      }),
      readLiveReference: async () => null,
      readNotepadForInjection: async (id) =>
        id === notepad.id ? notepad : null,
    },
    effects: {
      recordNotepadDeliveries: () => write("notepad_deliveries"),
      recordMemoryIndexDeliveries: () => write("memory"),
      mutateConversation: async (_project, _session, _conversation, label) =>
        write(label === "acknowledgeSyntheticForkSeed" ? "fork_seed" : label),
      prepareRuntimeLossNotice: async () => {
        if (options.recoveryFails) throw new Error("notices unreadable");
        return {
          block: options.recovery ?? null,
          onInputAccepted: () => write("recovery"),
          async finish(settled) {
            calls.push(`recovery_finish:${settled?.disposition ?? "accepted"}`);
          },
        };
      },
    },
    subscriptions: {
      prepareBriefing: async () => {
        claimed.briefing = true;
        return briefing;
      },
      recordAcceptedNotepadReferences: () => write("notepad_follows"),
    },
    debug: { getDebugLogUrl: () => "http://debug" },
    log: createCapturingLogger(),
  };
  const request = (
    overrides: Partial<TurnInputRequest> = {},
  ): TurnInputRequest => ({
    mode: "turn",
    execution: {
      projectPath: "/repo",
      target: {
        scope: "session",
        projectName: "repo",
        sessionName: "session",
        conversationId: "conv-1",
      },
      worktreePath: "/repo/.worktrees/session",
      role: null,
      persistence: "durable",
      executionAttemptId: "attempt-1",
      debugMode: null,
      turn: { inputOrigin: "user", promptText: "Read this" },
    },
    promptText: `Read this <notepad-ref notepad-id="np-1" />`,
    briefingAttemptId: "attempt-1",
    runtimeCreatedWithoutResume: false,
    checkpoint: null,
    archive: () => write("archive"),
    release: () => write("release"),
    ...overrides,
  });
  return { deps, calls, request, claimed };
}

describe("a fork's history in turn input", () => {
  it("acknowledges it after the input is kept and before the queue is released", async () => {
    const h = harness();
    const input = await prepareTurnInput(
      h.deps,
      h.request({ forkSeed: "Earlier history." }),
    );
    input.sending();
    await input.accepted({ backend: "cursor", ref: "s-1" });

    expect(h.calls.indexOf("archive")).toBeLessThan(
      h.calls.indexOf("fork_seed"),
    );
    expect(h.calls.indexOf("fork_seed")).toBeLessThan(
      h.calls.indexOf("release"),
    );
  });

  it("acknowledges it against the session the turn ended on when the backend named none while it ran", async () => {
    const h = harness();
    const input = await prepareTurnInput(
      h.deps,
      h.request({ forkSeed: "Earlier history." }),
    );
    input.sending();
    await input.accepted(null);
    expect(h.calls).not.toContain("fork_seed");

    await input.ended({ backend: "claude", ref: "s-9" });

    expect(h.calls).toContain("fork_seed");
    expect(await input.settle()).toBe(true);
  });

  it("does not acknowledge it for a turn whose input was never accepted", async () => {
    const h = harness();
    const input = await prepareTurnInput(
      h.deps,
      h.request({ forkSeed: "Earlier history." }),
    );
    input.sending();

    await input.ended({ backend: "claude", ref: "s-9" });

    expect(h.calls).not.toContain("fork_seed");
  });
});

describe("turn input", () => {
  it("places a turn's contributions before the message, and a live delivery's briefing alone", async () => {
    const h = harness();
    const turn = await prepareTurnInput(h.deps, h.request());
    const order = ["<briefing/>", "<ticket/>", "<memory/>", "Read this"].map(
      (part) => turn.promptText.indexOf(part),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(turn.promptText).toContain("The plan.");

    const live = await prepareTurnInput(
      h.deps,
      h.request({ mode: "live", briefingAttemptId: "delivery-1" }),
    );
    expect(live.promptText).toContain("<briefing/>");
    expect(live.promptText).not.toContain("<ticket/>");
    expect(live.promptText).not.toContain("<memory/>");
  });

  it("keeps accepted input first, then the required receipts, the optional one, and the queue release last", async () => {
    const h = harness();
    const input = await prepareTurnInput(h.deps, h.request());
    input.sending();
    await input.accepted({ backend: "claude", ref: "s-1" });
    expect(h.calls).toEqual([
      "archive",
      "notepad_deliveries",
      "passive",
      "notepad_follows",
      "memory",
      "release",
    ]);
    expect(await input.settle()).toBe(true);
    expect(classifyDelivery(input.delivery)).toBe("accepted");
  });

  it("still releases the queue when a receipt fails, retries it at settlement, and keeps it owned while it fails", async () => {
    const failing = new Set(["notepad_follows"]);
    const h = harness({ failing });
    const input = await prepareTurnInput(h.deps, h.request());
    input.sending();
    await expect(
      input.accepted({ backend: "claude", ref: "s-1" }),
    ).resolves.toBeUndefined();
    expect(h.calls).toContain("release");

    expect(await input.settle()).toBe(false);
    expect(h.calls.filter((call) => call === "notepad_follows")).toHaveLength(
      2,
    );
    failing.clear();
    expect(await input.settle()).toBe(true);
    expect(h.calls.filter((call) => call === "release")).toHaveLength(1);
  });

  it("writes no receipt for input never accepted, settling its briefing as not sent or uncertain", async () => {
    const neverSent = harness();
    const unsent = await prepareTurnInput(neverSent.deps, neverSent.request());
    expect(await unsent.settle()).toBe(true);
    expect(neverSent.calls).toEqual(["passive_finish:not_sent"]);
    expect(classifyDelivery(unsent.delivery)).toBe("not_sent");

    const refused = harness();
    const undelivered = await prepareTurnInput(refused.deps, refused.request());
    undelivered.sending();
    undelivered.failed(
      markPromptNotDelivered(new Error("The provider refused it")),
    );
    await undelivered.settle();
    expect(refused.calls).toEqual(["passive_finish:not_sent"]);

    const unknown = harness();
    const sent = await prepareTurnInput(unknown.deps, unknown.request());
    sent.sending();
    await sent.settle();
    expect(unknown.calls).toEqual(["passive_finish:uncertain"]);
    expect(classifyDelivery(sent.delivery)).toBe("uncertain");
  });

  it("tells the agent first that its previous runtime's background tasks ended, and settles that reminder with the input", async () => {
    const h = harness({ recovery: "<runtime_recovery/>" });
    const turn = await prepareTurnInput(h.deps, h.request());
    expect(turn.promptText.startsWith("<runtime_recovery/>")).toBe(true);
    turn.sending();
    await turn.accepted({ backend: "claude", ref: "s-1" });
    expect(h.calls).toEqual([
      "archive",
      "recovery",
      "notepad_deliveries",
      "passive",
      "notepad_follows",
      "memory",
      "release",
    ]);

    const unsent = harness({ recovery: "<runtime_recovery/>" });
    const refused = await prepareTurnInput(unsent.deps, unsent.request());
    refused.sending();
    refused.failed(markPromptNotDelivered(new Error("Refused")));
    await refused.settle();
    expect(unsent.calls).toEqual([
      "recovery_finish:not_sent",
      "passive_finish:not_sent",
    ]);

    const live = harness({ recovery: "<runtime_recovery/>" });
    const delivery = await prepareTurnInput(
      live.deps,
      live.request({ mode: "live", briefingAttemptId: "delivery-1" }),
    );
    expect(delivery.promptText).not.toContain("<runtime_recovery/>");
  });

  it("claims no briefing for a turn whose recovery reminder cannot be read", async () => {
    const h = harness({ recoveryFails: true });
    await expect(prepareTurnInput(h.deps, h.request())).rejects.toThrow(
      "notices unreadable",
    );
    expect(h.claimed.briefing).toBe(false);
  });

  it("settles a checkpoint input accepted without a reference: the seed's reconciliation owns it, the briefing is uncertain", async () => {
    const h = harness();
    // As the real seed does: it archives the input and records it for reconciliation, never opening its gate.
    const checkpoint: PreparedCheckpointSeed = {
      operationId: "op-1",
      seedSha256: "sha",
      block: "<checkpoint/>",
      bind: async () => {},
      async onInputAccepted(given) {
        await given?.archive?.();
      },
      onBackendInit: async () => {},
      markDispatched: () => {},
      markDispatchFailure: () => {},
      finish: async () => {},
    };
    const input = await prepareTurnInput(h.deps, h.request({ checkpoint }));
    input.sending();
    await input.accepted(null);

    expect(await input.settle()).toBe(true);
    expect(h.calls).toEqual(["archive", "passive_finish:uncertain"]);
  });

  it("lets a delivered checkpoint release everything else only once its own acceptance holds", async () => {
    const h = harness();
    const seedCalls: string[] = [];
    let handoff: Parameters<PreparedCheckpointSeed["onInputAccepted"]>[0];
    let acknowledged = false;
    const checkpoint: PreparedCheckpointSeed = {
      operationId: "op-1",
      seedSha256: "sha",
      block: "<checkpoint/>",
      bind: async () => {},
      async onInputAccepted(given) {
        handoff = given;
        await given?.archive?.();
        seedCalls.push("seed_accepted");
      },
      onBackendInit: async () => {},
      markDispatched: () => seedCalls.push("seed_dispatched"),
      markDispatchFailure: () => {},
      async finish() {
        seedCalls.push("seed_finish");
        // As the real seed does: what its acceptance releases runs once.
        if (!acknowledged) await handoff?.acknowledge?.();
        acknowledged = true;
      },
    };
    const input = await prepareTurnInput(h.deps, h.request({ checkpoint }));
    expect(input.promptText.startsWith("<checkpoint/>")).toBe(true);
    input.sending();
    await input.accepted({ backend: "claude", ref: "s-1" });
    expect(h.calls).toEqual(["archive"]);
    expect(await input.settle()).toBe(true);
    expect(seedCalls).toEqual([
      "seed_dispatched",
      "seed_accepted",
      "seed_finish",
    ]);
    expect(h.calls).toEqual([
      "archive",
      "notepad_deliveries",
      "passive",
      "notepad_follows",
      "memory",
      "release",
    ]);
  });
});
