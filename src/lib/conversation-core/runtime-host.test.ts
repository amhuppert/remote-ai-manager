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
  const host = createRuntimeHost({
    factory: () => factory,
    async instructions() {
      return { sessionInstructions: instructions, alignmentVersion: null };
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
    callbacks: () => ({}),
    index: {
      register: (conversationId) => registered.push(conversationId),
      unregister: (conversationId) => unregistered.push(conversationId),
    },
    log: silent,
  });
  return {
    host,
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
});
