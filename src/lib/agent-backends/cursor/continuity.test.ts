import { describe, expect, it } from "vitest";
import { elementAt } from "@/lib/shared/testing/element-at";
import type { ContinuityContext } from "../continuity";
import { ContinuityRefMismatchError } from "../continuity";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { CURSOR_BACKEND_ID } from "./backend-id";
import {
  createCursorContinuityAdapter,
  CursorContinuityError,
  mayForceExpire,
  type CursorContinuityBinding,
} from "./continuity";
import {
  createScriptedTransport,
  type ScriptedWorker,
} from "./testing/scripted-worker";
import { CURSOR_IPC_CODEC_VERSION } from "./worker/ipc";

const CONTEXT: ContinuityContext = {
  projectPath: "/repo",
  sessionName: "s1",
};

const BINDING: CursorContinuityBinding = {
  conversationId: "continuity-probe",
  cwd: "/repo/.worktrees/s1",
  storePath: "/state/cursor/continuity-probe",
  modelSelection: {
    modelId: "claude-opus-5",
    parameters: { effort: "xhigh", thinking: "true", cyber: "false" },
  },
  mcpServers: {},
};

function ref(value: string): AgentSessionRef {
  return { backend: CURSOR_BACKEND_ID, ref: value };
}

/** Fails every attach with one SDK error shape, so a class maps to a verdict. */
function refusingAttach(error: {
  name?: string;
  code?: string;
  status?: number;
}) {
  return (_input: unknown, worker: ScriptedWorker): void => {
    worker.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "attachResult",
      outcome: "failed",
      ref: null,
      error: {
        name: error.name ?? null,
        code: error.code ?? null,
        status: error.status ?? null,
        message: "the provider refused the resume",
      },
    });
  };
}

function createAdapter(worker: Parameters<typeof createScriptedTransport>[0]) {
  const transport = createScriptedTransport(worker);
  return {
    transport,
    adapter: createCursorContinuityAdapter({
      transport,
      resolveBinding: async () => BINDING,
    }),
  };
}

describe("cursor continuity start", () => {
  it("classifies malformed task envelopes without opening a worker", async () => {
    const { adapter, transport } = createAdapter({});
    expect(await adapter.validate(ref("{broken"), CONTEXT)).toEqual({
      status: "stale",
      reason: "cursor_ref_corrupt",
    });
    await expect(
      adapter.resumeOrRecover(ref("{broken"), CONTEXT),
    ).rejects.toMatchObject({
      classification: "corrupt",
    });
    expect(transport.workers).toHaveLength(0);
  });
  it("bounds a silent probe and closes its worker", async () => {
    const transport = createScriptedTransport({ onAttach() {} });
    const adapter = createCursorContinuityAdapter({
      transport,
      resolveBinding: async () => BINDING,
      attachTimeoutMs: 10,
    });
    await expect(adapter.start(CONTEXT)).rejects.toMatchObject({
      classification: "unavailable",
    });
    expect(transport.workers[0]?.closeCount).toBe(1);
  }, 500);
  it("refuses a live conversation slot without attaching or closing its worker", async () => {
    const transport = createScriptedTransport();
    await transport.start({
      ...BINDING,
      target: null,
      ownerToken: {},
      onFrame() {},
      onExit() {},
    });
    const adapter = createCursorContinuityAdapter({
      transport,
      resolveBinding: async () => BINDING,
    });
    await expect(adapter.start(CONTEXT)).rejects.toMatchObject({
      classification: "already_active",
    });
    expect(transport.workers[0]?.closeCount).toBe(0);
    await transport.closeAll();
  });
  it("creates a real agent through a worker and returns its owned ref", async () => {
    const { adapter, transport } = createAdapter({ ref: "agent-new" });
    const created = await adapter.start(CONTEXT);

    expect(created).toEqual({ backend: "cursor", ref: "agent-new" });
    expect(elementAt(transport.workers, 0).attachments[0]).toMatchObject({
      mode: "create",
      ref: null,
    });
  });

  it("binds the probe to the Command Center cwd and caller-owned store", async () => {
    const { adapter, transport } = createAdapter({});
    await adapter.start(CONTEXT);

    expect(transport.startInputs[0]).toMatchObject({
      cwd: BINDING.cwd,
      storePath: BINDING.storePath,
      modelSelection: BINDING.modelSelection,
    });
  });

  it("leaves no worker behind, on success or on refusal", async () => {
    const ok = createAdapter({});
    await ok.adapter.start(CONTEXT);
    expect(elementAt(ok.transport.workers, 0).closeCount).toBe(1);

    const refused = createAdapter({
      onAttach: refusingAttach({ name: "AuthenticationError", status: 401 }),
    });
    await expect(refused.adapter.start(CONTEXT)).rejects.toThrow(
      CursorContinuityError,
    );
    expect(elementAt(refused.transport.workers, 0).closeCount).toBe(1);
  });
});

describe("cursor continuity ref classification", () => {
  it.each([
    ["a stale or deleted agent", { name: "AgentNotFoundError" }, "not_found"],
    ["a random ref", { code: "agent_not_found" }, "not_found"],
    ["a cross-workspace ref", { status: 404 }, "not_found"],
    ["an already-active agent", { name: "AgentBusyError" }, "already_active"],
    ["a rejected configuration", { status: 400 }, "rejected"],
    ["an authentication failure", { status: 401 }, "unavailable"],
  ])(
    "validates %s as its bounded classification",
    async (_case, error, expected) => {
      const { adapter, transport } = createAdapter({
        onAttach: refusingAttach(error),
      });

      const validation = await adapter.validate(ref("agent-x"), CONTEXT);
      expect(validation).toEqual({
        status: "stale",
        reason: `cursor_ref_${expected}`,
      });
      expect(elementAt(transport.workers, 0).closeCount).toBe(1);
    },
  );

  it("validates a live agent as valid", async () => {
    const { adapter } = createAdapter({});
    expect(await adapter.validate(ref("agent-live"), CONTEXT)).toEqual({
      status: "valid",
    });
  });

  it("classifies a corrupt handle without starting a worker", async () => {
    const { adapter, transport } = createAdapter({});
    expect(await adapter.validate(ref("   "), CONTEXT)).toEqual({
      status: "stale",
      reason: "cursor_ref_corrupt",
    });
    expect(await adapter.validate(ref("a\nb"), CONTEXT)).toEqual({
      status: "stale",
      reason: "cursor_ref_corrupt",
    });
    expect(transport.startInputs).toHaveLength(0);
  });
});

describe("cursor continuity resume", () => {
  it("resumes a live agent without recovering", async () => {
    const { adapter, transport } = createAdapter({});
    const resumption = await adapter.resumeOrRecover(
      ref("agent-live"),
      CONTEXT,
    );

    expect(resumption).toEqual({ ref: ref("agent-live"), recovered: false });
    expect(elementAt(transport.workers, 0).attachments[0]).toMatchObject({
      mode: "resume",
      ref: "agent-live",
    });
  });

  it.each([
    ["not_found", { name: "AgentNotFoundError" }],
    ["already_active", { name: "AgentBusyError" }],
    ["rejected", { status: 400 }],
  ])(
    "fails closed on a %s ref rather than minting a replacement session",
    async (expected, error) => {
      const { adapter, transport } = createAdapter({
        onAttach: refusingAttach(error),
      });

      await expect(
        adapter.resumeOrRecover(ref("agent-x"), CONTEXT),
      ).rejects.toMatchObject({
        name: "CursorContinuityError",
        classification: expected,
      });
      // Failing closed means no second attach invented a fresh agent.
      expect(transport.workers).toHaveLength(1);
      expect(elementAt(transport.workers, 0).attachments).toHaveLength(1);
      expect(elementAt(transport.workers, 0).closeCount).toBe(1);
    },
  );

  it("rejects a ref owned by another backend before touching the transport", async () => {
    const { adapter, transport } = createAdapter({});
    await expect(
      adapter.resumeOrRecover({ backend: "claude", ref: "s" }, CONTEXT),
    ).rejects.toThrow(ContinuityRefMismatchError);
    expect(transport.startInputs).toHaveLength(0);
  });
});

describe("cursor fork", () => {
  it("returns a bounded transcript seed without resuming or copying the source agent", async () => {
    const { buildSyntheticForkSeed } =
      await import("@/lib/sessions/synthetic-fork-seed");
    const transport = createScriptedTransport({});
    const adapter = createCursorContinuityAdapter({
      transport,
      resolveBinding: async () => {
        throw new Error("fork must not attach the source");
      },
      buildSyntheticForkSeed: (transcriptPath, messageIndex) =>
        buildSyntheticForkSeed(transcriptPath, messageIndex, {
          readConversationMessages: async () => [
            {
              role: "user",
              content: [{ type: "text", text: "earlier context" }],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "anchored answer" }],
            },
            {
              role: "user",
              content: [{ type: "text", text: "future message" }],
            },
          ],
        }),
    });
    const outcome = await adapter.fork(ref("agent-live"), {
      projectPath: "/repo",
      anchorMessageId: null,
      sourceTranscriptPath: "/source.jsonl",
      messageIndex: 1,
    });
    expect(outcome.kind).toBe("synthetic_seed");
    if (outcome.kind !== "synthetic_seed")
      throw new Error("expected synthetic history");
    expect(outcome.seed).toContain("earlier context");
    expect(outcome.seed).toContain("anchored answer");
    expect(outcome.seed).not.toContain("future message");
    expect(transport.startInputs).toHaveLength(0);
    await expect(
      adapter.fork(
        { backend: "claude", ref: "source" },
        {
          projectPath: "/repo",
          anchorMessageId: null,
          sourceTranscriptPath: "/source.jsonl",
          messageIndex: 1,
        },
      ),
    ).rejects.toThrow(ContinuityRefMismatchError);
  });

  it("refuses an unreadable history instead of creating an empty fork", async () => {
    const adapter = createCursorContinuityAdapter({
      transport: createScriptedTransport({}),
      resolveBinding: async () => BINDING,
      buildSyntheticForkSeed: async () => null,
    });
    await expect(
      adapter.fork(ref("source"), {
        projectPath: "/repo",
        anchorMessageId: null,
        sourceTranscriptPath: "/missing.jsonl",
        messageIndex: 1,
      }),
    ).rejects.toMatchObject({ name: "ContinuityForkError" });
  });
});

describe("busy-agent force-expiry policy", () => {
  it("makes the scripted transport enforce the production model-selection binding", async () => {
    const transport = createScriptedTransport({});
    const input = {
      conversationId: "conv-1",
      target: {
        scope: "project" as const,
        projectName: "repo",
        conversationId: "conv-1",
      },
      cwd: "/repo",
      storePath: "/state",
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { context: "max", effort: "high" },
      },
      ownerToken: {},
      onFrame: () => {},
      onExit: () => {},
    };
    const first = await transport.start(input);
    if (first.kind !== "ready") throw new Error("expected a ready worker");

    const reordered = await transport.start({
      ...input,
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { effort: "high", context: "max" },
      },
    });
    const changed = await transport.start({
      ...input,
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { effort: "low" },
      },
    });
    const differentOwner = await transport.start({
      ...input,
      ownerToken: {},
    });

    expect(reordered.kind).toBe("already_active");
    expect(changed).toMatchObject({
      kind: "binding_mismatch",
      message: expect.stringContaining("different model selection"),
    });
    expect(differentOwner).toMatchObject({
      kind: "binding_mismatch",
      message: expect.stringContaining("different runtime owner"),
    });
    expect(transport.workers).toHaveLength(1);
  });

  it("refuses force-expiry while another live worker owns the conversation", async () => {
    const transport = createScriptedTransport({});
    await transport.start({
      conversationId: "conv-1",
      target: {
        scope: "project",
        projectName: "repo",
        conversationId: "conv-1",
      },
      cwd: "/repo",
      storePath: "/state",
      modelSelection: {
        modelId: "composer-2.5",
        parameters: {},
      },
      ownerToken: {},
      onFrame: () => {},
      onExit: () => {},
    });

    expect(mayForceExpire(transport, "conv-1", "some-other-worker")).toBe(
      false,
    );
  });

  it("admits force-expiry for the asking worker and when no worker is live", async () => {
    const transport = createScriptedTransport({});
    expect(mayForceExpire(transport, "conv-1", "any")).toBe(true);

    const started = await transport.start({
      conversationId: "conv-1",
      target: {
        scope: "project",
        projectName: "repo",
        conversationId: "conv-1",
      },
      cwd: "/repo",
      storePath: "/state",
      modelSelection: {
        modelId: "composer-2.5",
        parameters: {},
      },
      ownerToken: {},
      onFrame: () => {},
      onExit: () => {},
    });
    if (started.kind !== "ready") throw new Error("expected a ready worker");
    expect(mayForceExpire(transport, "conv-1", started.session.workerId)).toBe(
      true,
    );
  });
});
