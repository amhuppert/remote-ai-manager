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
  model: "composer-2.5",
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
      model: BINDING.model,
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
  it("reports fork unsupported rather than aliasing resume", async () => {
    const { adapter, transport } = createAdapter({});
    const outcome = await adapter.fork(ref("agent-live"), {
      projectPath: "/repo",
      anchorMessageId: null,
      sourceTranscriptPath: "/repo/t.jsonl",
      messageIndex: 0,
    });

    expect(outcome).toEqual({ kind: "unsupported" });
    // No ref was copied and no agent was created in fork's name.
    expect(transport.startInputs).toHaveLength(0);
  });
});

describe("busy-agent force-expiry policy", () => {
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
      model: "composer-2.5",
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
      model: "composer-2.5",
      onFrame: () => {},
      onExit: () => {},
    });
    if (started.kind !== "ready") throw new Error("expected a ready worker");
    expect(mayForceExpire(transport, "conv-1", started.session.workerId)).toBe(
      true,
    );
  });
});
