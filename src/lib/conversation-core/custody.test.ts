import { describe, expect, it } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { CustodyRow, SegmentUsage } from "./conversation-record";
import { createRuntimeCustody, type CustodyLossReason } from "./custody";
import type { CustodyLease, RetainedRuntime } from "./executor";
import {
  createRuntimeHost,
  type HostedConversation,
  type RuntimeRequirements,
} from "./runtime-host";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const conversation: HostedConversation = {
  conversationId: "conv-1",
  projectPath: "/repo",
  projectName: "repo",
  target: sessionConversationTarget("repo", "session", "conv-1"),
  worktreePath: "/repo/.worktrees/session",
  backend: "claude",
  executionClass: "ordinary-conversation",
  persistedRef: { backend: "claude", ref: "sdk-1" },
};

const sonnet: RuntimeRequirements = {
  modelSelection: { modelId: "sonnet", parameters: {} },
  instructionSelection: { autonomous: false },
};

const turn = {
  source: "user" as const,
  autonomous: false,
  originMessageId: "msg-1",
};

/** A frame of a provider turn, as Claude's interpreter builds it. */
function frame(id: string, text: string): ConversationBackendEvent {
  return {
    type: "transcript_entry",
    entry: {
      seq: 0,
      backend: "claude",
      type: "assistant",
      raw: {
        id,
        timestamp: "2026-10-12T06:03:30.000Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  };
}

/** A provider turn's result: a continuation's, with the probe's shape (`origin: task-notification`). */
function result(
  overrides: Partial<ConversationBackendTurnResult> = {},
): ConversationBackendTurnResult {
  return {
    backendRef: { backend: "claude", ref: "sdk-1" },
    costUsd: 0.25,
    durationMs: 3_400,
    numTurns: 2,
    contextTokens: 1_200,
    contextWindowMax: 200_000,
    contentBlocks: [],
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
    ...overrides,
  };
}

/** A Claude-shaped runtime the test drives along the probe timelines: owed work, its own turns and its death. */
interface FakeRuntime extends ConversationBackendRuntime {
  readonly input: ConversationBackendCreateInput;
  closed: boolean;
  /** The adapter's owed-work answer changes, reported only on a change. */
  owe(next: boolean): void;
  /** A provider turn: its start, its frames in order, and its completion. */
  providerTurn(
    frames: ConversationBackendEvent[],
    ended?: ConversationBackendTurnResult,
  ): void;
  /** The CLI dies on its own. */
  die(): void;
}

function harness(options: { owedWork?: boolean } = {}) {
  const created: FakeRuntime[] = [];
  const tracked: Promise<void>[] = [];
  const writes: Array<{ usage: SegmentUsage | null; row: CustodyRow | null }> =
    [];
  const frames: string[] = [];
  const staged: string[] = [];
  const losses: Array<{ key: string; end: CustodyLossReason }> = [];
  let failNextAppend = false;
  let failNextSegmentWrite = false;
  /** While set, frame appends wait for it, stalling the runtime's event chain. */
  let appendsHeldBy: Promise<void> | null = null;
  const host = createRuntimeHost({
    factory: () => ({
      backend: "claude",
      async createRuntime(input) {
        let status: "alive" | "dead" = "alive";
        let owing = false;
        const terminate = (reason: string) => {
          if (status === "dead") return;
          status = "dead";
          owing = false;
          input.onTerminated?.({ reason });
        };
        const runtime: FakeRuntime = {
          backend: "claude",
          get status() {
            return status;
          },
          modelSelection: input.modelSelection,
          input,
          closed: false,
          ...(options.owedWork === false
            ? {}
            : { owesWork: () => status === "alive" && owing }),
          owe(next) {
            if (owing === next) return;
            owing = next;
            input.onOwedWorkChanged?.(next);
          },
          providerTurn(turnFrames, ended) {
            input.onExternalTurnEvent?.({ type: "external_turn_started" });
            for (const event of turnFrames) input.onExternalTurnEvent?.(event);
            if (ended !== undefined)
              input.onExternalTurnEvent?.({
                type: "external_turn_completed",
                result: ended,
              });
          },
          die() {
            terminate("pump_completed");
          },
          async sendTurn() {
            throw new Error("not used");
          },
          async close() {
            runtime.closed = true;
            terminate("closed");
          },
        };
        created.push(runtime);
        return runtime;
      },
    }),
    async instructions() {
      return {
        sessionInstructions: [],
        alignmentVersion: null,
        alignmentEligible: false,
      };
    },
    async readInstructions() {
      return {
        sessionInstructions: [],
        alignmentVersion: null,
        alignmentEligible: false,
      };
    },
    async tooling() {
      return { overrides: {} };
    },
    async beginSeed() {
      return { async commit() {} };
    },
    callbacks: (hosted, track) =>
      custody.callbacks(hosted, (work) => {
        tracked.push(work);
        track(work);
      }),
    index: { register() {}, unregister() {} },
    log: silent,
  });
  const custody = createRuntimeCustody({
    host,
    records: {
      async recordSegment(_identity, usage, project) {
        if (failNextSegmentWrite) {
          failNextSegmentWrite = false;
          throw new Error("the conversation store is unavailable");
        }
        writes.push({ usage, row: project() });
      },
    },
    async appendFrame(_conversationId, entry: TranscriptEntry) {
      if (appendsHeldBy !== null) await appendsHeldBy;
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error("the transcript could not be written");
      }
      const text = entry.content?.[0];
      frames.push(text?.type === "text" ? text.text : String(entry.type));
    },
    async applyStagedCapabilities(hosted) {
      staged.push(hosted.conversationId);
    },
    async recordLoss({ key, end }) {
      losses.push({ key, end });
    },
    log: silent,
  });

  /** The executor's side of a custody: what it tells, and the row it shows from who holds it. */
  function opener() {
    const told: string[] = [];
    const state: {
      runtime: RetainedRuntime | null;
      claimed: boolean;
      live: boolean;
    } = {
      runtime: null,
      claimed: false,
      live: true,
    };
    const lease: CustodyLease = {
      attemptId: "custody-1",
      row(segmentEnded = false) {
        if (!state.live || state.runtime === null) return null;
        const segment = state.runtime.segmentActive();
        if (state.claimed)
          return { status: "running", source: segment ? "user" : null };
        return segment
          ? { status: "running", source: "user" }
          : { status: "idle", notify: segmentEnded ? "user" : null };
      },
      segmentEnded: () => told.push("segment-ended"),
      settled: () => told.push("settled"),
      lost: () => told.push("lost"),
    };
    return {
      told,
      state,
      lease,
      open: {
        open(runtime: RetainedRuntime) {
          state.runtime = runtime;
          return lease;
        },
      },
      /** Custody ended: its runtime side stops reporting to it. */
      release(end: "handed_over" | "settled") {
        state.live = false;
        state.runtime?.released(end);
      },
    };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.allSettled(tracked);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function obtain(requirements = sonnet): Promise<FakeRuntime> {
    await host.obtain(conversation, requirements);
    const runtime = created.at(-1);
    if (runtime === undefined) throw new Error("no runtime");
    return runtime;
  }

  return {
    host,
    custody,
    created,
    writes,
    frames,
    staged,
    losses,
    opener,
    settle,
    obtain,
    failNextAppend() {
      failNextAppend = true;
    },
    failNextSegmentWrite() {
      failNextSegmentWrite = true;
    },
    holdAppends(until: Promise<void> | null) {
      appendsHeldBy = until;
    },
  };
}

describe("runtime custody", () => {
  it("keeps a runtime that still owes work at its turn's end, and keeps none that owes nothing or cannot say", async () => {
    const h = harness();
    const runtime = await h.obtain();
    const idle = h.opener();
    expect(h.custody.keep("conv-1", turn, idle.open)).toBeNull();
    expect(idle.state.runtime).toBeNull();

    runtime.owe(true);
    const owing = h.opener();
    expect(h.custody.keep("conv-1", turn, owing.open)).toBe(owing.lease);
    expect(runtime.closed).toBe(false);
    expect(h.host.runtime("conv-1")).toBe(runtime);
    // The turn's end is a provider-turn boundary: what was staged meanwhile applies now.
    await h.settle();
    expect(h.staged).toEqual(["conv-1"]);

    const codex = harness({ owedWork: false });
    await codex.obtain();
    const never = codex.opener();
    expect(codex.custody.keep("conv-1", turn, never.open)).toBeNull();
    expect(never.state.runtime).toBeNull();
  });

  it("runs the continuation of finished background work on the row and the transcript, then ends custody once nothing is owed", async () => {
    const h = harness();
    const runtime = await h.obtain();
    // The turn's result arrives with a background task in flight.
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    await h.settle();
    h.staged.length = 0;

    // The task ends; the CLI starts its continuation about 100 ms later.
    runtime.providerTurn([
      frame("f-1", "The suite passed."),
      frame("f-2", "Done."),
    ]);
    await h.settle();
    expect(h.custody.describe("conv-1")).toEqual({
      autonomous: false,
      originMessageId: "msg-1",
    });
    runtime.input.onExternalTurnEvent?.({
      type: "external_turn_completed",
      result: result(),
    });
    runtime.owe(false);
    await h.settle();

    expect(h.frames).toEqual(["The suite passed.", "Done."]);
    expect(h.writes).toEqual([
      { usage: null, row: { status: "running", source: "user" } },
      {
        usage: expect.objectContaining({ costUsd: 0.25, numTurns: 2 }),
        row: { status: "idle", notify: "user" },
      },
    ]);
    expect(custody.told).toEqual(["segment-ended", "settled"]);
    expect(h.staged).toEqual(["conv-1"]);
    expect(h.custody.describe("conv-1")).toBeNull();
  });

  it("charges every provider turn custody holds, through continuations that start more work", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);

    runtime.providerTurn([frame("a", "Starting the next batch.")], result());
    runtime.providerTurn(
      [frame("b", "Both batches passed.")],
      result({ costUsd: 0.5, numTurns: 1 }),
    );
    runtime.owe(false);
    await h.settle();

    expect(
      h.writes.flatMap((write) =>
        write.usage === null ? [] : [write.usage.costUsd],
      ),
    ).toEqual([0.25, 0.5]);
    expect(custody.told).toEqual(["segment-ended", "segment-ended", "settled"]);
  });

  it("keeps the frames and the result of a provider turn when one frame cannot be written", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);

    h.failNextAppend();
    runtime.providerTurn([frame("a", "lost"), frame("b", "Kept.")], result());
    await h.settle();
    expect(h.frames).toEqual(["Kept."]);
    expect(custody.told).toEqual(["segment-ended"]);
  });

  it("still offers the queue the conversation when a provider turn's end cannot be written to the row", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);

    runtime.providerTurn([]);
    await h.settle();
    h.failNextSegmentWrite();
    runtime.input.onExternalTurnEvent?.({
      type: "external_turn_completed",
      result: result(),
    });
    await h.settle();
    expect(custody.told).toEqual(["segment-ended"]);
  });

  it("answers a provider turn's end to the custody that held it when it began, though its events arrive after a handover and a new custody", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const first = h.opener();
    h.custody.keep("conv-1", turn, first.open);
    let resume: () => void = () => {};
    h.holdAppends(new Promise((resolve) => (resume = resolve)));
    runtime.providerTurn([frame("a", "Slow frame.")], result());

    // The chain is stalled on the frame while ownership moves on.
    first.release("handed_over");
    const second = h.opener();
    h.custody.keep("conv-1", turn, second.open);
    h.holdAppends(null);
    resume();
    await h.settle();

    // The displaced provider turn's end is no one's to tell: its usage is kept, and the new custody hears nothing.
    expect(h.writes.at(-1)).toEqual({
      usage: expect.objectContaining({ costUsd: 0.25 }),
      row: null,
    });
    expect(second.told).toEqual([]);
  });

  it("lets a provider turn running at its turn's end become custody's first, keeping the row running", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    // A continuation the CLI started between the turn's result and its end: the turn still owns the row.
    runtime.providerTurn([frame("a", "Checking the output.")]);
    await h.settle();
    expect(h.writes).toEqual([]);

    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    expect(custody.lease.row()).toEqual({ status: "running", source: "user" });
    expect(h.custody.describe("conv-1")).toMatchObject({
      originMessageId: "msg-1",
    });
    // No capability change applies under a running provider turn.
    await h.settle();
    expect(h.staged).toEqual([]);

    runtime.input.onExternalTurnEvent?.({
      type: "external_turn_completed",
      result: result(),
    });
    await h.settle();
    expect(h.writes).toEqual([
      {
        usage: expect.objectContaining({ costUsd: 0.25 }),
        row: { status: "idle", notify: "user" },
      },
    ]);
    expect(h.staged).toEqual(["conv-1"]);
  });

  it("does not end custody on a stale 'owes nothing' when the runtime has taken work up again", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);

    runtime.owe(false);
    runtime.owe(true);
    await h.settle();
    expect(custody.told).toEqual([]);
  });

  it("reports a runtime that dies while custody holds it as lost", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);

    runtime.die();
    await h.settle();
    expect(custody.told).toEqual(["lost"]);
  });

  it("once custody hands the runtime over, records a provider turn's frames and usage for the turn that owns the row, and reports nothing to custody", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    custody.release("handed_over");

    runtime.providerTurn(
      [frame("a", "Taken over.")],
      result({ costUsd: null }),
    );
    runtime.owe(false);
    runtime.die();
    await h.settle();
    expect(h.frames).toEqual(["Taken over."]);
    // The displaced provider turn is a transfer boundary: the taking turn is charged.
    expect(h.writes).toEqual([
      { usage: expect.objectContaining({ costUsd: null }), row: null },
    ]);
    expect(custody.told).toEqual([]);
    expect(h.custody.describe("conv-1")).toBeNull();
  });

  it("names the provider turn custody holds as the turn live input joins: none before custody, in idle custody, between provider turns or once handed over", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    // A provider turn while the ending turn still owns the runtime is that turn's.
    runtime.providerTurn([frame("a", "Checking.")], result());
    expect(h.custody.segment("conv-1")).toBeNull();

    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    expect(h.custody.segment("conv-1")).toBeNull();

    runtime.providerTurn([frame("b", "Working.")]);
    expect(h.custody.segment("conv-1")).toMatchObject({
      attemptId: "custody-1",
      conversation: {
        conversationId: "conv-1",
        worktreePath: "/repo/.worktrees/session",
      },
    });

    runtime.input.onExternalTurnEvent?.({
      type: "external_turn_completed",
      result: result(),
    });
    expect(h.custody.segment("conv-1")).toBeNull();

    runtime.providerTurn([frame("c", "Again.")]);
    custody.release("handed_over");
    expect(h.custody.segment("conv-1")).toBeNull();
  });

  it("tells a provider turn's end only once the live input custody took during it has settled", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    runtime.providerTurn([frame("a", "Working.")]);
    const delivery = Promise.withResolvers<string>();
    h.custody.segment("conv-1")?.own(delivery.promise);
    runtime.input.onExternalTurnEvent?.({
      type: "external_turn_completed",
      result: result(),
    });
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(custody.told).toEqual([]);
    expect(h.writes.filter((write) => write.usage !== null)).toEqual([]);

    delivery.resolve("accepted");
    await h.settle();
    expect(custody.told).toEqual(["segment-ended"]);
    expect(h.writes.at(-1)).toEqual({
      usage: expect.objectContaining({ costUsd: 0.25 }),
      row: { status: "idle", notify: "user" },
    });
  });

  it("closes a handed-over runtime whose configuration drifted before the turn's input, recording the work it cut short", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    custody.release("handed_over");
    await h.settle();
    h.staged.length = 0;

    await h.custody.takeOver(
      conversation,
      { ...sonnet, modelSelection: { modelId: "opus", parameters: {} } },
      "turn-2",
    );
    expect(runtime.closed).toBe(true);
    expect(h.host.runtime("conv-1")).toBeNull();
    expect(h.losses).toEqual([{ key: "drift:turn-2", end: "reconfigured" }]);
    expect(h.staged).toEqual([]);
  });

  it("keeps a handed-over runtime that did not drift, applying staged capability changes only when no provider turn runs", async () => {
    const h = harness();
    const runtime = await h.obtain();
    runtime.owe(true);
    const custody = h.opener();
    h.custody.keep("conv-1", turn, custody.open);
    custody.release("handed_over");
    await h.settle();
    h.staged.length = 0;

    await h.custody.takeOver(conversation, sonnet, "turn-2");
    expect(runtime.closed).toBe(false);
    expect(h.staged).toEqual(["conv-1"]);

    runtime.providerTurn([frame("a", "Still going.")]);
    await h.custody.takeOver(conversation, sonnet, "turn-3");
    expect(h.staged).toEqual(["conv-1"]);
    expect(h.losses).toEqual([]);
  });
});
