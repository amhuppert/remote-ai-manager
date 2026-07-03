import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "../state-store/state-db";
import { getCodexRunRecord } from "./repo";
import {
  _resetForTesting,
  cancelCodexRun,
  getCodexRun,
  startCodexRun,
  type CodexExecResult,
  type CodexRunServiceDeps,
  type StartCodexRunInput,
} from "./service";

/**
 * Service-layer TDD for the codex-run job (docs/design/cc-cli/02 §3.3). The
 * `runCodex` executor is injected so the real codex task runner never runs, but
 * bookkeeping is persisted through the real codex-runs repo over a fresh
 * in-memory SQLite DB — so these exercise the genuine job bookkeeping, status
 * transitions, cancellation, and reference-document registration, and prove a
 * run's state survives the request that started it (durable record read back).
 */

const OWNER = { projectName: "cc", sessionName: "sess" };

function makeInput(
  overrides: Partial<StartCodexRunInput> = {},
): StartCodexRunInput {
  return {
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
  overrides: Partial<CodexRunServiceDeps> = {},
): CodexRunServiceDeps {
  let counter = 0;
  return {
    ensureDir: vi.fn(async () => {}),
    async runCodex(): Promise<CodexExecResult> {
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
    const run = getCodexRun(runId, owner);
    if (run && run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 1));
  }
  return getCodexRun(runId, owner);
}

beforeEach(() => {
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(() => {
  _resetForTesting();
  _resetStateDb();
});

describe("startCodexRun", () => {
  it("returns a runId synchronously and reaches a terminal result after the caller returns", async () => {
    // The run resolves on a later tick; startCodexRun must not await it. The
    // deferred is created up front so resolving it never races the executor.
    let resolveRun!: (v: CodexExecResult) => void;
    const runGate = new Promise<CodexExecResult>((r) => {
      resolveRun = r;
    });
    const runCodex = vi.fn(() => runGate);
    const deps = makeDeps({ runCodex });

    const { runId } = startCodexRun(makeInput(), deps);

    // Still running immediately after the initiating call has returned.
    expect(getCodexRun(runId, OWNER)?.status).toBe("running");

    // "Client killed" — nothing keeps the run alive but the server. Complete it.
    resolveRun({
      response: null,
      structuredOutput: {
        summary: "did it",
        referenceDocuments: [
          { filePath: "memory-bank/codex/a.md", description: "notes" },
        ],
      },
      error: null,
      timedOut: false,
    });

    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.summary).toBe("did it");
    expect(run?.referenceDocuments).toEqual([
      { filePath: "memory-bank/codex/a.md", description: "notes" },
    ]);
  });

  it("writes a durable run record readable through the codex-runs repo", async () => {
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: null,
        structuredOutput: {
          summary: "persisted",
          referenceDocuments: [
            { filePath: "memory-bank/codex/x.md", description: "x" },
          ],
        },
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startCodexRun(makeInput(), makeDeps({ runCodex }));
    await waitForTerminal(runId);

    // The bookkeeping lives in the durable job-record domain, not just in
    // memory: the record round-trips through SQLite with its results intact.
    const record = getCodexRunRecord(runId);
    expect(record?.status).toBe("succeeded");
    expect(record?.summary).toBe("persisted");
    expect(record?.referenceDocuments).toEqual([
      { filePath: "memory-bank/codex/x.md", description: "x" },
    ]);
    expect(record?.completedAt).toBeDefined();
  });

  it("translates reference-document paths to the worktree when codex runs in a subdirectory", async () => {
    const register = vi.fn(async () => {});
    const artifactRegistry = { register } as unknown as ArtifactRegistry;
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: null,
        structuredOutput: {
          summary: "s",
          referenceDocuments: [
            { filePath: "memory-bank/codex/a.md", description: "a" },
          ],
        },
        error: null,
        timedOut: false,
      }),
    );
    const deps = makeDeps({ runCodex, artifactRegistry });

    const { runId } = startCodexRun(
      makeInput({ worktreePath: "/wt", workingDirectory: "/wt/packages/api" }),
      deps,
    );
    const run = await waitForTerminal(runId);

    // Codex reports "memory-bank/codex/a.md" relative to /wt/packages/api; the
    // registered and returned path is anchored at the session worktree so the
    // agent and CC's document index both resolve it.
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reference_document",
        worktreePath: "/wt",
        relativePath: "packages/api/memory-bank/codex/a.md",
      }),
    );
    expect(run?.referenceDocuments).toEqual([
      {
        filePath: "packages/api/memory-bank/codex/a.md",
        description: "a",
      },
    ]);
  });

  it("registers each reference document through the artifact registry", async () => {
    const register = vi.fn(async () => {});
    const artifactRegistry = { register } as unknown as ArtifactRegistry;
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: null,
        structuredOutput: {
          summary: "s",
          referenceDocuments: [
            { filePath: "memory-bank/codex/a.md", description: "a" },
            { filePath: "memory-bank/codex/b.md", description: "b" },
          ],
        },
        error: null,
        timedOut: false,
      }),
    );
    const deps = makeDeps({ runCodex, artifactRegistry });

    const { runId } = startCodexRun(
      makeInput({ workingDirectory: "/wt" }),
      deps,
    );
    await waitForTerminal(runId);

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reference_document",
        worktreePath: "/wt",
        relativePath: "memory-bank/codex/a.md",
        description: "a",
      }),
    );
  });

  it("parses a JSON-string structured payload (codex fallback)", async () => {
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: JSON.stringify({
          summary: "from-text",
          referenceDocuments: [],
        }),
        structuredOutput: undefined,
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startCodexRun(makeInput(), makeDeps({ runCodex }));
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.summary).toBe("from-text");
  });

  it("marks the run timed_out when the executor reports a timeout", async () => {
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: null,
        error: null,
        timedOut: true,
      }),
    );
    const { runId } = startCodexRun(
      makeInput({ timeoutMs: 30_000 }),
      makeDeps({ runCodex }),
    );
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("timed_out");
    expect(run?.error).toContain("timed out");
  });

  it("marks the run failed when the executor reports an error", async () => {
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: null,
        error: "boom",
        timedOut: false,
      }),
    );
    const { runId } = startCodexRun(makeInput(), makeDeps({ runCodex }));
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("boom");
  });

  it("passes the configured working directory, timeout, and overrides to the executor", async () => {
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: "ok",
        error: null,
        timedOut: false,
      }),
    );
    const deps = makeDeps({ runCodex });
    const { runId } = startCodexRun(
      makeInput({
        workingDirectory: "/wt/sub",
        timeoutMs: 1000,
        model: "gpt-5.5",
        reasoningEffort: "high",
      }),
      deps,
    );
    await waitForTerminal(runId);

    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/wt/sub",
        timeoutMs: 1000,
        model: "gpt-5.5",
        reasoningEffort: "high",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe("cancelCodexRun", () => {
  it("aborts a live run, which settles into a terminal failed state", async () => {
    // Model the real runner: an aborted signal surfaces as timedOut=true —
    // including when the signal is already aborted by the time codex is invoked.
    const runCodex = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<CodexExecResult>((resolve) => {
          const abort = () =>
            resolve({ response: null, error: null, timedOut: true });
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort);
        }),
    );
    const { runId } = startCodexRun(makeInput(), makeDeps({ runCodex }));
    expect(getCodexRun(runId, OWNER)?.status).toBe("running");

    const result = cancelCodexRun(runId, OWNER);
    expect(result.found).toBe(true);

    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error?.toLowerCase()).toContain("cancel");
  });

  it("reports not-found for an unknown run id", () => {
    expect(cancelCodexRun("nope", OWNER)).toEqual({ found: false });
  });
});

describe("ownership scoping", () => {
  it("hides a run from a different session", async () => {
    const runCodex = vi.fn(
      async (): Promise<CodexExecResult> => ({
        response: "ok",
        error: null,
        timedOut: false,
      }),
    );
    const { runId } = startCodexRun(makeInput(), makeDeps({ runCodex }));

    expect(
      getCodexRun(runId, { projectName: "cc", sessionName: "other" }),
    ).toBeNull();
    expect(
      cancelCodexRun(runId, { projectName: "cc", sessionName: "other" }),
    ).toEqual({ found: false });
    // The rightful owner still sees it.
    expect(getCodexRun(runId, OWNER)).not.toBeNull();
  });
});
