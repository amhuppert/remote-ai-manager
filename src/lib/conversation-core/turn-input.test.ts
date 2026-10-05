import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { NotepadInjectionSource } from "@/lib/notepads/injection";
import type { PreparedSubscriptionBriefing } from "@/lib/subscriptions/service";
import type { PreparedCheckpointSeed } from "@/lib/workflows/conversation/pre-turn/checkpoint-seed";
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
function harness(options: { failing?: Set<string>; briefing?: string | null } = {}) {
  const calls: string[] = [];
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
      readNotepadForInjection: async (id) => (id === notepad.id ? notepad : null),
    },
    effects: {
      recordNotepadDeliveries: () => write("notepad_deliveries"),
      recordMemoryIndexDeliveries: () => write("memory"),
    },
    subscriptions: {
      prepareBriefing: async () => briefing,
      recordAcceptedNotepadReferences: () => write("notepad_follows"),
    },
    debug: { getDebugLogUrl: () => "http://debug" },
    log: createCapturingLogger(),
  };
  const request = (overrides: Partial<TurnInputRequest> = {}): TurnInputRequest => ({
    mode: "turn",
    execution: {
      projectPath: "/repo",
      target: { scope: "session", projectName: "repo", sessionName: "session", conversationId: "conv-1" },
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
  return { deps, calls, request };
}

describe("turn input", () => {
  it("places a turn's contributions before the message, and a live delivery's briefing alone", async () => {
    const h = harness();
    const turn = await prepareTurnInput(h.deps, h.request());
    const order = ["<briefing/>", "<ticket/>", "<memory/>", "Read this"].map((part) => turn.promptText.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(turn.promptText).toContain("The plan.");

    const live = await prepareTurnInput(h.deps, h.request({ mode: "live", briefingAttemptId: "delivery-1" }));
    expect(live.promptText).toContain("<briefing/>");
    expect(live.promptText).not.toContain("<ticket/>");
    expect(live.promptText).not.toContain("<memory/>");
  });

  it("keeps accepted input first, then the required receipts, the optional one, and the queue release last", async () => {
    const h = harness();
    const input = await prepareTurnInput(h.deps, h.request());
    input.sending();
    await input.accepted({ backend: "claude", ref: "s-1" });
    expect(h.calls).toEqual(["archive", "notepad_deliveries", "passive", "notepad_follows", "memory", "release"]);
    expect(await input.settle()).toBe(true);
    expect(classifyDelivery(input.delivery)).toBe("accepted");
  });

  it("still releases the queue when a receipt fails, retries it at settlement, and keeps it owned while it fails", async () => {
    const failing = new Set(["notepad_follows"]);
    const h = harness({ failing });
    const input = await prepareTurnInput(h.deps, h.request());
    input.sending();
    await expect(input.accepted({ backend: "claude", ref: "s-1" })).resolves.toBeUndefined();
    expect(h.calls).toContain("release");

    expect(await input.settle()).toBe(false);
    expect(h.calls.filter((call) => call === "notepad_follows")).toHaveLength(2);
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
    undelivered.failed(markPromptNotDelivered(new Error("The provider refused it")));
    await undelivered.settle();
    expect(refused.calls).toEqual(["passive_finish:not_sent"]);

    const unknown = harness();
    const sent = await prepareTurnInput(unknown.deps, unknown.request());
    sent.sending();
    await sent.settle();
    expect(unknown.calls).toEqual(["passive_finish:uncertain"]);
    expect(classifyDelivery(sent.delivery)).toBe("uncertain");
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
    expect(seedCalls).toEqual(["seed_dispatched", "seed_accepted", "seed_finish"]);
    expect(h.calls).toEqual(["archive", "notepad_deliveries", "passive", "notepad_follows", "memory", "release"]);
  });
});
