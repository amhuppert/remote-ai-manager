import { describe, expect, it } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationBackendRuntime,
} from "@/lib/agent-backends/conversation";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { ComposedTooling } from "./runtime-application-state";
import {
  createRuntimeHost,
  type HostedConversation,
  type RuntimeRequirements,
} from "./runtime-host";
import { readNextTurnContextLoss } from "@/lib/memory/next-turn-context-loss";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

interface FakeRuntime extends ConversationBackendRuntime {
  closed: boolean;
  input: ConversationBackendCreateInput;
  kill(): void;
}

function harness() {
  const created: FakeRuntime[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  let instructions = ["You are a CC agent."];
  /** Each created runtime's way to keep its own late work open until it closes. */
  const trackers: Array<(work: Promise<void>) => void> = [];
  let charter: { version: number | null; eligible: boolean } = {
    version: null,
    eligible: false,
  };
  const factory: ConversationBackendFactory = {
    backend: "claude",
    async createRuntime(input) {
      let status: "alive" | "dead" = "alive";
      const runtime: FakeRuntime = {
        backend: "claude",
        get status() {
          return status;
        },
        modelSelection: input.modelSelection,
        closed: false,
        input,
        kill() {
          status = "dead";
        },
        async sendTurn() {
          throw new Error("not used");
        },
        async close() {
          runtime.closed = true;
          status = "dead";
        },
      };
      created.push(runtime);
      return runtime;
    },
  };
  const seeds: Array<{
    conversationId: string;
    composed: ComposedTooling;
    runtime: unknown;
  }> = [];
  let seedFailure: Error | null = null;
  /** Instructions prepared for a turn, which may register documents; reading at rest prepares nothing. */
  const preparations: string[] = [];
  const host = createRuntimeHost({
    factory: () => factory,
    async instructions(hosted) {
      preparations.push(hosted.conversationId);
      return {
        sessionInstructions: instructions,
        alignmentVersion: charter.version,
        alignmentEligible: charter.eligible,
      };
    },
    async readInstructions() {
      return {
        sessionInstructions: instructions,
        alignmentVersion: charter.version,
        alignmentEligible: charter.eligible,
      };
    },
    async tooling() {
      return {
        overrides: { portableMcp: { servers: [] } },
        capabilityState: { cascades: {} },
      };
    },
    async beginSeed(hosted) {
      return {
        async commit(composed, runtime) {
          if (seedFailure !== null) throw seedFailure;
          seeds.push({
            conversationId: hosted.target.conversationId,
            composed,
            runtime,
          });
        },
      };
    },
    callbacks: (_conversation, track) => {
      trackers.push(track);
      return {};
    },
    index: {
      register: (conversationId) => registered.push(conversationId),
      unregister: (conversationId) => unregistered.push(conversationId),
    },
    log: silent,
  });
  return {
    host,
    preparations,
    created,
    registered,
    unregistered,
    seeds,
    failSeeding(error: Error) {
      seedFailure = error;
    },
    setInstructions(next: string[]) {
      instructions = next;
    },
    setCharter(next: typeof charter) {
      charter = next;
    },
    trackers,
  };
}

const conversation: HostedConversation = {
  conversationId: "conv-1",
  projectPath: "/repo",
  projectName: "repo",
  target: sessionConversationTarget("repo", "session", "conv-1"),
  worktreePath: "/repo/.worktrees/session",
  backend: "claude",
  executionClass: "governed-execution",
  persistedRef: { backend: "claude", ref: "sdk-session-1" },
};

const sonnet: RuntimeRequirements = {
  modelSelection: { modelId: "sonnet", parameters: {} },
  instructionSelection: { autonomous: true, askUserQuestionsEnabled: true },
};

describe("runtime host", () => {
  it("creates a runtime with the conversation's instructions, tooling and continuity, then reuses it", async () => {
    const h = harness();
    const first = await h.host.obtain(conversation, sonnet);
    const second = await h.host.obtain(conversation, sonnet);

    expect(first.created).toBe(true);
    expect(second).toEqual({ runtime: first.runtime, created: false });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.input).toMatchObject({
      conversationId: "conv-1",
      executionClass: "governed-execution",
      persistedRef: { backend: "claude", ref: "sdk-session-1" },
      modelSelection: { modelId: "sonnet", parameters: {} },
      sessionInstructions: ["You are a CC agent."],
      tooling: { portableMcp: { servers: [] } },
      worktreePath: "/repo/.worktrees/session",
    });
    expect(h.registered).toEqual(["conv-1"]);
  });

  it("opens a capture runtime in the conversation's own session, in its place, and closes it on release", async () => {
    const h = harness();
    const turn = await h.host.obtain(conversation, sonnet);

    const capture = await h.host.obtainForCapture(conversation, {
      modelSelection: { modelId: "opus", parameters: {} },
      captureId: "op-1:capture",
      mode: "tool-disabled",
    });

    expect(h.created.map((runtime) => runtime.closed)).toEqual([true, false]);
    expect(h.created[1]?.input).toMatchObject({
      persistedRef: { backend: "claude", ref: "sdk-session-1" },
      modelSelection: { modelId: "opus", parameters: {} },
      sessionInstructions: [],
      tooling: {},
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: "op-1:capture",
        mode: "tool-disabled",
      },
    });
    // Nothing is applied to a capture runtime: its mode is established on a session with no tools.
    expect(h.seeds.map((seed) => seed.runtime)).toEqual([turn.runtime]);
    expect(capture).not.toBe(turn.runtime);
    await h.host.release("conv-1");
    expect(h.created[1]?.closed).toBe(true);
  });

  it("gives the agent the identity it acts as when the conversation declares one", async () => {
    const h = harness();
    await h.host.obtain({ ...conversation, callerIdentity: "conv-1" }, sonnet);
    expect(h.created[0]?.input.workflowCallerConversationId).toBe("conv-1");
  });

  it("retires and replaces the runtime when what it was created with changes", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    await h.host.obtain(conversation, {
      ...sonnet,
      modelSelection: { modelId: "opus", parameters: {} },
    });
    h.setInstructions(["You are a CC agent.", "New reference document."]);
    await h.host.obtain(conversation, {
      ...sonnet,
      modelSelection: { modelId: "opus", parameters: {} },
    });

    expect(
      h.created.map((r) => [r.input.modelSelection.modelId, r.closed]),
    ).toEqual([
      ["sonnet", true],
      ["opus", true],
      ["opus", false],
    ]);
    expect(h.unregistered).toEqual(["conv-1", "conv-1"]);
  });

  it("tells how what a turn needs differs from the live runtime, without touching it, and nothing when none is live", async () => {
    const h = harness();
    expect(await h.host.drift(conversation, sonnet)).toEqual([]);
    await h.host.obtain(conversation, sonnet);
    expect(await h.host.drift(conversation, sonnet)).toEqual([]);

    expect(
      await h.host.drift(conversation, {
        ...sonnet,
        modelSelection: { modelId: "opus", parameters: {} },
      }),
    ).toEqual(["modelSelection"]);
    expect(h.created.map((runtime) => runtime.closed)).toEqual([false]);

    h.created[0]?.kill();
    expect(
      await h.host.drift(conversation, {
        ...sonnet,
        modelSelection: { modelId: "opus", parameters: {} },
      }),
    ).toEqual([]);
  });

  it("reuses the runtime a turn's drift check kept, as it is, at that turn's obtain: a configuration saved in between applies next time", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    expect(await h.host.drift(conversation, sonnet)).toEqual([]);
    h.setInstructions(["You are a CC agent.", "A new reference document."]);

    expect(await h.host.obtain(conversation, sonnet)).toMatchObject({
      created: false,
    });
    // The next obtain that no drift check settled compares again.
    expect(await h.host.obtain(conversation, sonnet)).toMatchObject({
      created: true,
    });
    expect(h.created.map((runtime) => runtime.closed)).toEqual([true, false]);
  });

  it("creates a fresh runtime when the live one died, resuming the newest continuity", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    h.created[0]?.kill();
    const next = await h.host.obtain(
      {
        ...conversation,
        persistedRef: { backend: "claude", ref: "sdk-session-2" },
      },
      sonnet,
    );

    expect(next.created).toBe(true);
    expect(h.created[1]?.input.persistedRef).toEqual({
      backend: "claude",
      ref: "sdk-session-2",
    });
  });

  it("replaces a runtime mid-turn with the continuity the completed work produced", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    const replacement = await h.host.replace("conv-1", {
      backend: "claude",
      ref: "sdk-session-3",
    });

    expect(h.created[0]?.closed).toBe(true);
    expect(replacement).toBe(h.created[1]);
    expect(h.created[1]?.input.persistedRef).toEqual({
      backend: "claude",
      ref: "sdk-session-3",
    });
  });

  it("keeps a runtime whose close failed, and creates no replacement until it is collected", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    const runtime = h.created[0];
    if (runtime === undefined) throw new Error("no runtime");
    runtime.close = async () => {
      throw new Error("child process cleanup could not be verified");
    };

    await expect(h.host.release("conv-1")).rejects.toThrow(/cleanup/);
    await expect(h.host.obtain(conversation, sonnet)).rejects.toThrow();
    expect(h.created).toHaveLength(1);
  });

  it("reports a failed close, and collects the runtime only when a retried release closes it", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    const runtime = h.created[0];
    if (runtime === undefined) throw new Error("no runtime");
    const close = runtime.close.bind(runtime);
    let closable = false;
    runtime.close = async () => {
      if (!closable)
        throw new Error("child process cleanup could not be verified");
      await close();
    };
    expect(h.host.closeFailure("conv-1")).toBeNull();

    await expect(h.host.release("conv-1")).rejects.toThrow(/cleanup/);
    expect(h.host.closeFailure("conv-1")).toMatch(/cleanup/);
    // A plain release reports the recorded failure again rather than retrying the close.
    await expect(h.host.release("conv-1")).rejects.toThrow(/cleanup/);
    await expect(h.host.retryRelease("conv-1")).rejects.toThrow(/cleanup/);

    closable = true;
    await h.host.retryRelease("conv-1");
    expect(runtime.closed).toBe(true);
    expect(h.host.closeFailure("conv-1")).toBeNull();
    await h.host.obtain(conversation, sonnet);
    expect(h.created).toHaveLength(2);
  });

  it("blocks the conversation when closing a runtime it is replacing fails", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    const first = h.created[0];
    if (first === undefined) throw new Error("no runtime");
    first.close = async () => {
      throw new Error("child process cleanup could not be verified");
    };

    await expect(
      h.host.obtain(conversation, {
        ...sonnet,
        modelSelection: { modelId: "opus", parameters: {} },
      }),
    ).rejects.toThrow(/cleanup/);
    await expect(h.host.obtain(conversation, sonnet)).rejects.toThrow(
      /did not close/,
    );
    expect(h.created).toHaveLength(1);
  });

  it("releases a conversation's runtime and every runtime at shutdown", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    await h.host.obtain({ ...conversation, conversationId: "conv-2" }, sonnet);
    await h.host.release("conv-1");
    expect(h.created.map((r) => r.closed)).toEqual([true, false]);

    await h.host.releaseAll();
    expect(h.created.map((r) => r.closed)).toEqual([true, true]);
    expect(h.unregistered.sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("closes a runtime only once the work its callbacks started has finished", async () => {
    const h = harness();
    await h.host.obtain(conversation, sonnet);
    let finish: () => void = () => {};
    h.trackers[0]?.(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let released = false;
    const release = h.host.release("conv-1").then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(false);
    finish();
    await release;
    expect(released).toBe(true);
  });

  it("keeps the charter a runtime was created with past its close, until a new runtime replaces it", async () => {
    const h = harness();
    h.setCharter({ version: 4, eligible: true });
    await h.host.obtain(conversation, sonnet);
    await h.host.release("conv-1");
    expect(h.host.alignment("conv-1")).toEqual({ version: 4, eligible: true });

    h.setCharter({ version: 5, eligible: true });
    await h.host.obtain(conversation, sonnet);
    expect(h.host.alignment("conv-1")).toEqual({ version: 5, eligible: true });
  });

  it("persists the application baseline of every runtime it creates, including a mid-turn replacement", async () => {
    const h = harness();
    const first = await h.host.obtain(conversation, sonnet);
    await h.host.obtain(conversation, sonnet);
    const replacement = await h.host.replace("conv-1", {
      backend: "claude",
      ref: "sdk-session-3",
    });

    expect(h.seeds).toEqual([
      {
        conversationId: "conv-1",
        composed: {
          overrides: { portableMcp: { servers: [] } },
          capabilityState: { cascades: {} },
        },
        runtime: first.runtime,
      },
      {
        conversationId: "conv-1",
        composed: {
          overrides: { portableMcp: { servers: [] } },
          capabilityState: { cascades: {} },
        },
        runtime: replacement,
      },
    ]);
  });

  it("fails to provide a runtime whose baseline cannot be persisted, and still closes it on release", async () => {
    const h = harness();
    h.failSeeding(new Error("database is locked"));

    await expect(h.host.obtain(conversation, sonnet)).rejects.toThrow(
      /database is locked/,
    );
    expect(h.created).toHaveLength(1);
    await h.host.release("conv-1");
    expect(h.created[0]?.closed).toBe(true);
  });

  it("tells whether a conversation's next turn finds a live runtime", async () => {
    const h = harness();
    expect(h.host.isLive("conv-1")).toBe(false);
    await h.host.obtain(conversation, sonnet);
    expect(h.host.isLive("conv-1")).toBe(true);
    h.created[0]?.kill();
    expect(h.host.isLive("conv-1")).toBe(false);
  });

  describe("read outside a turn, as the memory index preview reads a runtime custody keeps (design C5b §5)", () => {
    /** The preview's question: would the next turn start without its context, as the turn's own reuse rule says? */
    async function previewLoss(h: ReturnType<typeof harness>) {
      return readNextTurnContextLoss(
        {
          async findConversation() {
            // A conversation that has run but has no stored resume handle: only a live runtime keeps its context.
            return {
              projectPath: "/repo",
              sessionName: "session",
              promptCount: 3,
              hasResumeHandle: false,
              pendingCheckpoint: false,
            };
          },
          getRuntimeConfiguration: (conversationId) =>
            h.host.configuration(conversationId),
          readDesiredRuntimeConfiguration: (conversationId, current) =>
            h.host.desiredConfiguration(conversationId, current),
        },
        "conv-1",
      );
    }

    it("reports what the live runtime was created with, and what the conversation stands at now, without touching it", async () => {
      const h = harness();
      expect(h.host.configuration("conv-1")).toBeUndefined();
      await h.host.obtain(conversation, sonnet);

      const current = h.host.configuration("conv-1");
      expect(current).toMatchObject({
        status: "alive",
        backend: "claude",
        modelSelection: { modelId: "sonnet" },
        repeatableInstructions: ["You are a CC agent."],
      });
      if (current === undefined) throw new Error("no configuration");

      h.setInstructions(["You are a CC agent.", "A new reference document."]);
      expect(
        await h.host.desiredConfiguration("conv-1", current),
      ).toMatchObject({
        modelSelection: { modelId: "sonnet" },
        repeatableInstructions: [
          "You are a CC agent.",
          "A new reference document.",
        ],
      });
      expect(h.created.map((runtime) => runtime.closed)).toEqual([false]);
    });

    it("reads the conversation's instructions at rest, preparing none of them", async () => {
      const h = harness();
      await h.host.obtain(conversation, sonnet);
      const current = h.host.configuration("conv-1");
      if (current === undefined) throw new Error("no configuration");
      expect(h.preparations).toEqual(["conv-1"]);

      await h.host.desiredConfiguration("conv-1", current);
      await previewLoss(h);
      expect(h.preparations).toEqual(["conv-1"]);
    });

    it("predicts reuse of a live runtime whose configuration stands, and a fresh one once it has drifted or died", async () => {
      const h = harness();
      await h.host.obtain(conversation, sonnet);
      expect((await previewLoss(h)).runtimeCreatedWithoutResume).toBe(false);

      h.setInstructions(["You are a CC agent.", "A new reference document."]);
      expect((await previewLoss(h)).runtimeCreatedWithoutResume).toBe(true);

      h.setInstructions(["You are a CC agent."]);
      h.created[0]?.kill();
      expect((await previewLoss(h)).runtimeCreatedWithoutResume).toBe(true);
    });
  });
});
