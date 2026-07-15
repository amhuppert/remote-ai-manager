import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import {
  _createTestDb,
  _installTestDb,
  getDb,
  _resetForTesting as _resetStateDb,
} from "../state-store/state-db";
import { createAgentRunsRepo } from "./repo";
import {
  _resetForTesting,
  cancelAgentRun,
  getAgentRun,
  startAgentRun,
  type AgentRunExecInput,
  type AgentRunExecResult,
  type AgentRunServiceDeps,
  type StartAgentRunInput,
} from "./service";

/**
 * Service-layer tests for the agent-run job. The `runTask` executor is
 * injected so no real backend runs, but bookkeeping is persisted through the
 * real agent-runs repo over a fresh in-memory SQLite DB — so these exercise
 * the genuine job bookkeeping, status transitions, cancellation, and
 * reference-document registration, and prove a run's state survives the
 * request that started it (durable record read back).
 */

const OWNER = { projectName: "cc", sessionName: "sess" };

function makeInput(
  overrides: Partial<StartAgentRunInput> = {},
): StartAgentRunInput {
  return {
    backend: "codex",
    projectName: OWNER.projectName,
    sessionName: OWNER.sessionName,
    prompt: "do the thing",
    worktreePath: "/wt",
    workingDirectory: "/wt",
    timeoutMs: 0,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<AgentRunServiceDeps> = {},
): AgentRunServiceDeps {
  let counter = 0;
  return {
    ensureDir: vi.fn(async () => {}),
    async runTask(): Promise<AgentRunExecResult> {
      return {
        response: "ok",
        structuredOutput: undefined,
        error: null,
        timedOut: false,
      };
    },
    newRunId: () => `run-${++counter}`,
    now: () => "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

/** Poll until the run leaves the "running" state (or a bounded number of ticks). */
async function waitForTerminal(runId: string, owner = OWNER) {
  for (let i = 0; i < 50; i++) {
    const run = getAgentRun(runId, owner);
    if (run && run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 1));
  }
  return getAgentRun(runId, owner);
}

beforeEach(() => {
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(() => {
  _resetForTesting();
  _resetStateDb();
});

describe("startAgentRun", () => {
  it("returns a runId synchronously and reaches a terminal result after the caller returns", async () => {
    // The run resolves on a later tick; startAgentRun must not await it. The
    // deferred is created up front so resolving it never races the executor.
    let resolveRun!: (v: AgentRunExecResult) => void;
    const runGate = new Promise<AgentRunExecResult>((r) => {
      resolveRun = r;
    });
    const runTask = vi.fn(() => runGate);
    const deps = makeDeps({ runTask });

    const { runId } = startAgentRun(makeInput(), deps);

    // Still running immediately after the initiating call has returned.
    expect(getAgentRun(runId, OWNER)?.status).toBe("running");

    // "Client killed" — nothing keeps the run alive but the server. Complete it.
    resolveRun({
      response: null,
      structuredOutput: {
        summary: "did it",
        referenceDocuments: [
          { filePath: "memory-bank/agent-runs/a.md", description: "notes" },
        ],
      },
      error: null,
      timedOut: false,
    });

    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("completed");
    expect(run?.backend).toBe("codex");
    expect(run?.summary).toBe("did it");
    expect(run?.referenceDocuments).toEqual([
      { filePath: "memory-bank/agent-runs/a.md", description: "notes" },
    ]);
  });

  it("writes a durable run record readable through the agent-runs repo", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: null,
        structuredOutput: {
          summary: "persisted",
          referenceDocuments: [
            { filePath: "memory-bank/agent-runs/x.md", description: "x" },
          ],
        },
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startAgentRun(makeInput(), makeDeps({ runTask }));
    await waitForTerminal(runId);

    // The bookkeeping lives in the durable job-record domain, not just in
    // memory: the record round-trips through SQLite with its results intact.
    const record = createAgentRunsRepo(getDb()).getAgentRunRecord(runId);
    expect(record?.status).toBe("completed");
    expect(record?.backend).toBe("codex");
    expect(record?.summary).toBe("persisted");
    expect(record?.referenceDocuments).toEqual([
      { filePath: "memory-bank/agent-runs/x.md", description: "x" },
    ]);
    expect(record?.completedAt).toBeDefined();
  });

  it("threads the requested backend into the executor", async () => {
    const runTask = vi.fn(
      async (input: AgentRunExecInput): Promise<AgentRunExecResult> => {
        expect(input.backend).toBe("claude");
        return { response: "ok", error: null, timedOut: false };
      },
    );
    const { runId } = startAgentRun(
      makeInput({ backend: "claude" }),
      makeDeps({ runTask }),
    );
    const run = await waitForTerminal(runId);

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(run?.backend).toBe("claude");
  });

  it("translates reference-document paths to the worktree when the agent runs in a subdirectory", async () => {
    const register = vi.fn(async () => {});
    const artifactRegistry = { register } as unknown as ArtifactRegistry;
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: null,
        structuredOutput: {
          summary: "s",
          referenceDocuments: [
            { filePath: "memory-bank/agent-runs/a.md", description: "a" },
          ],
        },
        error: null,
        timedOut: false,
      }),
    );
    const deps = makeDeps({ runTask, artifactRegistry });

    const { runId } = startAgentRun(
      makeInput({ worktreePath: "/wt", workingDirectory: "/wt/packages/api" }),
      deps,
    );
    const run = await waitForTerminal(runId);

    // The agent reports "memory-bank/agent-runs/a.md" relative to
    // /wt/packages/api; the registered and returned path is anchored at the
    // session worktree so the agent and CC's document index both resolve it.
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reference_document",
        worktreePath: "/wt",
        relativePath: "packages/api/memory-bank/agent-runs/a.md",
      }),
    );
    expect(run?.referenceDocuments).toEqual([
      {
        filePath: "packages/api/memory-bank/agent-runs/a.md",
        description: "a",
      },
    ]);
  });

  it("registers each reference document through the artifact registry", async () => {
    const register = vi.fn(async () => {});
    const artifactRegistry = { register } as unknown as ArtifactRegistry;
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: null,
        structuredOutput: {
          summary: "s",
          referenceDocuments: [
            { filePath: "memory-bank/agent-runs/a.md", description: "a" },
            { filePath: "memory-bank/agent-runs/b.md", description: "b" },
          ],
        },
        error: null,
        timedOut: false,
      }),
    );
    const deps = makeDeps({ runTask, artifactRegistry });

    const { runId } = startAgentRun(
      makeInput({ workingDirectory: "/wt" }),
      deps,
    );
    await waitForTerminal(runId);

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reference_document",
        worktreePath: "/wt",
        relativePath: "memory-bank/agent-runs/a.md",
        description: "a",
      }),
    );
  });

  it("accepts a JSON-string text payload through the shared extraction fallback", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: JSON.stringify({
          summary: "from-text",
          referenceDocuments: [],
        }),
        structuredOutput: undefined,
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startAgentRun(makeInput(), makeDeps({ runTask }));
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("from-text");
  });

  it("accepts a fenced JSON payload through the shared extraction fallback", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response:
          'Here is the result:\n```json\n{"summary": "from-fence", "referenceDocuments": []}\n```',
        structuredOutput: undefined,
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startAgentRun(makeInput(), makeDeps({ runTask }));
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("from-fence");
  });

  it("marks the run failed with a timeout error when the executor reports a timeout", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: null,
        error: null,
        timedOut: true,
      }),
    );
    const { runId } = startAgentRun(
      makeInput({ timeoutMs: 30_000 }),
      makeDeps({ runTask }),
    );
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("timed out");
  });

  it("marks the run failed when the executor reports an error", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: null,
        error: "boom",
        timedOut: false,
      }),
    );
    const { runId } = startAgentRun(makeInput(), makeDeps({ runTask }));
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("boom");
  });

  it("passes the configured working directory, timeout, and overrides to the executor", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: "ok",
        error: null,
        timedOut: false,
      }),
    );
    const deps = makeDeps({ runTask });
    const { runId } = startAgentRun(
      makeInput({
        workingDirectory: "/wt/sub",
        timeoutMs: 1000,
        model: "gpt-5.5",
        reasoningEffort: "high",
      }),
      deps,
    );
    await waitForTerminal(runId);

    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        workingDirectory: "/wt/sub",
        timeoutMs: 1000,
        model: "gpt-5.5",
        reasoningEffort: "high",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("cancelAgentRun", () => {
  it("aborts a live run, which settles into a terminal failed state", async () => {
    // Model the real runner: an aborted signal surfaces as timedOut=true —
    // including when the signal is already aborted by the time the runner is
    // invoked.
    const runTask = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<AgentRunExecResult>((resolve) => {
          const abort = () =>
            resolve({ response: null, error: null, timedOut: true });
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort);
        }),
    );
    const { runId } = startAgentRun(makeInput(), makeDeps({ runTask }));
    expect(getAgentRun(runId, OWNER)?.status).toBe("running");

    const result = cancelAgentRun(runId, OWNER);
    expect(result.found).toBe(true);

    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error?.toLowerCase()).toContain("cancel");
  });

  it("reports not-found for an unknown run id", () => {
    expect(cancelAgentRun("nope", OWNER)).toEqual({ found: false });
  });
});

describe("ownership scoping", () => {
  it("hides a run from a different session", async () => {
    const runTask = vi.fn(
      async (): Promise<AgentRunExecResult> => ({
        response: "ok",
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startAgentRun(makeInput(), makeDeps({ runTask }));

    expect(
      getAgentRun(runId, { projectName: "cc", sessionName: "other" }),
    ).toBeNull();
    expect(
      cancelAgentRun(runId, { projectName: "cc", sessionName: "other" }),
    ).toEqual({ found: false });
    // The rightful owner still sees it.
    expect(getAgentRun(runId, OWNER)).not.toBeNull();
  });
});
