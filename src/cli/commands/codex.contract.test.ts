import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { GlobalConfig } from "@/lib/config/schemas";
import {
  cancelCodexRun,
  getCodexRun,
  startCodexRun,
  _resetForTesting,
  type CodexExecResult,
} from "@/lib/codex-runs/service";
import { createCodexRunHandlers } from "@/lib/codex-runs/route-handlers";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real codex-run
 * route handlers in-process, backed by the real (in-memory) run service. The
 * codex executor is injected so no real codex spawns — but the job bookkeeping,
 * status transitions, and cancellation are the production paths. Proves the key
 * design property: a run started without `--wait` outlives its initiating
 * request and is recovered through `cctl codex status`.
 */

const PROJECT_PATH = "/repos/cc";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;
const TOKEN = "contract-token";

let dir: string;

function makeConfig(): GlobalConfig {
  return {
    baseDir: "/repos",
    ignorePatterns: [],
    claudeTimeoutMs: 3_600_000,
    defaultModel: "opus",
    defaultAgentBackend: "claude",
    pushNotification: {
      enabled: false,
      provider: "ntfy",
      serverUrl: "https://ntfy.sh",
      topic: "",
      triggers: {
        jobCompleted: true,
        waitingForInput: true,
        workflowCompleted: true,
        workflowHalted: true,
        conversationIdle: true,
      },
    },
    codex: { enabled: true, model: "gpt-5.4" },
  };
}

/** A codex executor that completes after a real tick with a structured result. */
function completingExecutor(): () => Promise<CodexExecResult> {
  return async () => {
    await new Promise((r) => setTimeout(r, 5));
    return {
      response: null,
      structuredOutput: {
        summary: "codex did it",
        referenceDocuments: [
          { filePath: "memory-bank/codex/out.md", description: "the output" },
        ],
      },
      error: null,
      timedOut: false,
    };
  };
}

/** A codex executor that never settles until its signal aborts (for cancel). */
function abortableExecutor(): (input: {
  signal: AbortSignal;
}) => Promise<CodexExecResult> {
  return (input) =>
    new Promise<CodexExecResult>((resolve) => {
      const abort = () =>
        resolve({ response: null, error: null, timedOut: true });
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort);
    });
}

function makeHost(
  runCodex: (input: { signal: AbortSignal }) => Promise<CodexExecResult>,
): CliHost {
  const handlers = createCodexRunHandlers({
    auth: createAgentAuth({ configDir: dir }),
    async resolveProjectPath() {
      return PROJECT_PATH;
    },
    async getSession() {
      return { sessionName: "sess", worktreePath: WORKTREE };
    },
    async readConfig() {
      return makeConfig();
    },
    startRun(input) {
      return startCodexRun(
        {
          projectName: input.projectName,
          sessionName: input.sessionName,
          prompt: input.prompt,
          worktreePath: input.worktreePath,
          workingDirectory: input.workingDirectory,
          timeoutMs: input.timeoutMs,
          ...(input.model !== undefined ? { model: input.model } : {}),
        },
        {
          ensureDir: async () => {},
          runCodex,
          newRunId: () => `run-${Math.random().toString(36).slice(2, 8)}`,
          now: () => "2026-07-02T00:00:00.000Z",
        },
      );
    },
    getRun: getCodexRun,
    cancelRun: cancelCodexRun,
  });

  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // /api/projects/<name>/sessions/<session>/codex-runs[/<runId>[/cancel]]
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const runId = segments[6] ? decodeURIComponent(segments[6]) : "";
      const isCancel = segments[7] === "cancel";
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });

      if (init.method === "GET") {
        return handlers.GET(request, {
          params: Promise.resolve({ name, session, runId }),
        });
      }
      if (isCancel) {
        return handlers.CANCEL(request, {
          params: Promise.resolve({ name, session, runId }),
        });
      }
      return handlers.POST(request, {
        params: Promise.resolve({ name, session }),
      });
    },
    async readTextFile(filePath) {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async sleep(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function env(): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: "cc",
    CC_SESSION: "sess",
  };
}

beforeEach(async () => {
  _installTestDb(_createTestDb({ inMemory: true }));
  _resetForTesting();
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-codex-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(
    path.join(dir, "prompt.json"),
    JSON.stringify({ prompt: "analyze the repo" }),
  );
});

afterEach(async () => {
  _resetForTesting();
  _resetStateDb();
  await rm(dir, { recursive: true, force: true });
});

describe("cctl codex against the real route handlers", () => {
  it("run (no --wait) starts a run that outlives the call and is recovered via status", async () => {
    const host = makeHost(completingExecutor());
    const promptPath = path.join(dir, "prompt.json");

    const started = await runCli(
      ["codex", "run", "--file", promptPath],
      env(),
      host,
    );
    expect(started.exitCode).toBe(0);
    const runId = JSON.parse(
      (
        await runCli(
          ["codex", "run", "--file", promptPath, "--json"],
          env(),
          host,
        )
      ).stdout,
    ).runId as string;
    expect(typeof runId).toBe("string");

    // Poll status through the real handlers until the run reaches its terminal
    // state — the run completed server-side with no client waiting on it.
    let recovered = "";
    for (let i = 0; i < 50; i++) {
      const status = await runCli(
        ["codex", "status", runId, "--json"],
        env(),
        host,
      );
      const envelope = JSON.parse(status.stdout);
      if (envelope.status !== "running") {
        recovered = status.stdout;
        break;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    const envelope = JSON.parse(recovered);
    expect(envelope.status).toBe("succeeded");
    expect(envelope.summary).toBe("codex did it");
    expect(envelope.referenceDocuments).toEqual([
      { filePath: "memory-bank/codex/out.md", description: "the output" },
    ]);
  });

  it("run --wait long-polls to the completed result", async () => {
    const host = makeHost(completingExecutor());
    const result = await runCli(
      ["codex", "run", "--file", path.join(dir, "prompt.json"), "--wait"],
      env(),
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codex did it");
    expect(result.stdout).toContain(
      "hint: codex registered 1 reference documents",
    );
  });

  it("cancel aborts a live run, which then reports a terminal state via status", async () => {
    const host = makeHost(abortableExecutor());
    const promptPath = path.join(dir, "prompt.json");

    const runId = JSON.parse(
      (
        await runCli(
          ["codex", "run", "--file", promptPath, "--json"],
          env(),
          host,
        )
      ).stdout,
    ).runId as string;

    const cancelled = await runCli(["codex", "cancel", runId], env(), host);
    expect(cancelled.exitCode).toBe(0);

    let terminal = "";
    for (let i = 0; i < 50; i++) {
      const status = await runCli(
        ["codex", "status", runId, "--json"],
        env(),
        host,
      );
      const envelope = JSON.parse(status.stdout);
      if (envelope.status !== "running") {
        terminal = envelope.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(terminal).toBe("failed");
  });

  it("exits 3 when the real token gate rejects a wrong token", async () => {
    const host = makeHost(completingExecutor());
    const result = await runCli(
      ["codex", "run", "--file", path.join(dir, "prompt.json")],
      { ...env(), CC_API_TOKEN: "wrong" },
      host,
    );
    expect(result.exitCode).toBe(3);
  });

  it("exits 1 when codex is disabled (409 business precondition)", async () => {
    // A dedicated host whose config reports codex disabled.
    const handlers = createCodexRunHandlers({
      auth: createAgentAuth({ configDir: dir }),
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      async getSession() {
        return { sessionName: "sess", worktreePath: WORKTREE };
      },
      async readConfig() {
        return { ...makeConfig(), codex: { enabled: false, model: "gpt-5.4" } };
      },
      startRun: () => ({ runId: "x" }),
      getRun: getCodexRun,
      cancelRun: cancelCodexRun,
    });
    const host: CliHost = {
      async fetch(url, init) {
        return handlers.POST(
          new Request(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
          }),
          { params: Promise.resolve({ name: "cc", session: "sess" }) },
        );
      },
      async readTextFile(filePath) {
        try {
          return await readFile(filePath, "utf-8");
        } catch {
          return null;
        }
      },
      async sleep() {},
      platform: os.platform(),
      homedir: os.homedir(),
    };
    const result = await runCli(
      ["codex", "run", "--file", path.join(dir, "prompt.json")],
      env(),
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not enabled");
  });
});
