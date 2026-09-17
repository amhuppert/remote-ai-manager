import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { GlobalConfig } from "@/lib/config/schemas";
import {
  cancelAgentRun,
  getAgentRun,
  startAgentRun,
  _resetForTesting,
  type AgentRunExecResult,
  type AgentRunExecInput,
} from "@/lib/agent-runs/service";
import { createAgentRunHandlers } from "@/lib/agent-runs/route-handlers";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import { runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost } from "../../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real agent-run
 * route handlers in-process, backed by the real (in-memory) run service. The
 * executor is injected so no real backend spawns — but the job bookkeeping,
 * status transitions, and cancellation are the production paths. Proves the key
 * design property: a run started without `--wait` outlives its initiating
 * request and is recovered through `cctl agent status`.
 */

const PROJECT_PATH = "/repos/cc";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;
const TOKEN = "contract-token";

let dir: string;

function makeConfig(): GlobalConfig {
  return {
    baseDir: "/repos",
    ignorePatterns: [],
    agentBackends: {
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: 3_600_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
        timeoutMs: null,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
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
        specApprovalRequested: true,
        specApprovalGranted: true,
        specPolicyAdmitted: true,
        planRepair: true,
      },
    },
  };
}

/** An executor that completes after a real tick with a structured result. */
function completingExecutor(): () => Promise<AgentRunExecResult> {
  return async () => {
    await new Promise((r) => setTimeout(r, 5));
    return {
      response: null,
      structuredOutput: {
        summary: "the agent did it",
        referenceDocuments: [
          {
            filePath: "memory-bank/agent-runs/out.md",
            description: "the output",
          },
        ],
      },
      error: null,
      timedOut: false,
    };
  };
}

/** An executor that never settles until its signal aborts (for cancel). */
function abortableExecutor(): (input: {
  signal: AbortSignal;
}) => Promise<AgentRunExecResult> {
  return (input) =>
    new Promise<AgentRunExecResult>((resolve) => {
      const abort = () =>
        resolve({ response: null, error: null, timedOut: true });
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort);
    });
}

function makeHost(
  runTask: (input: AgentRunExecInput) => Promise<AgentRunExecResult>,
): CliHost {
  const handlers = createAgentRunHandlers({
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
    async admitModelSelection({ modelSelection }) {
      return { ok: true, modelSelection };
    },
    startRun(input) {
      return startAgentRun(
        {
          backend: input.backend,
          projectName: input.projectName,
          sessionName: input.sessionName,
          prompt: input.prompt,
          worktreePath: input.worktreePath,
          workingDirectory: input.workingDirectory,
          timeoutMs: input.timeoutMs,
          modelSelection: input.modelSelection,
        },
        {
          ensureDir: async () => {},
          runTask,
          newRunId: () => `run-${Math.random().toString(36).slice(2, 8)}`,
          now: () => "2026-07-02T00:00:00.000Z",
        },
      );
    },
    getRun: getAgentRun,
    cancelRun: cancelAgentRun,
  });

  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // /api/projects/<name>/sessions/<session>/agent-runs[/<runId>[/cancel]]
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
    async readFileBytes() {
      return null;
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
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-agent-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(
    path.join(dir, "prompt.json"),
    JSON.stringify({ backend: "codex", prompt: "analyze the repo" }),
  );
});

afterEach(async () => {
  _resetForTesting();
  _resetStateDb();
  await rm(dir, { recursive: true, force: true });
});

describe("cctl agent against the real route handlers", () => {
  it.each(["codex", "cursor"] as const)(
    "runs %s without fallback and recovers the result via status",
    async (backend) => {
      await writeFile(
        path.join(dir, "prompt.json"),
        JSON.stringify({ backend, prompt: "analyze the repo" }),
      );
      const host = makeHost(async (input) => {
        if (input.backend !== backend)
          throw new Error(`${input.backend} unavailable`);
        expect(input.modelSelection).toEqual(
          makeConfig().agentBackends[backend].modelSelection,
        );
        return completingExecutor()();
      });
      const promptPath = path.join(dir, "prompt.json");

      const started = await runCcWithHost(
        ["agent", "run", "--file", promptPath],
        env(),
        host,
      );
      expect(started.exitCode).toBe(0);
      const runId = JSON.parse(
        (
          await runCcWithHost(
            ["agent", "run", "--file", promptPath, "--json"],
            env(),
            host,
          )
        ).stdout,
      ).payload.data.runId as string;
      expect(typeof runId).toBe("string");

      // Poll status through the real handlers until the run reaches its terminal
      // state — the run completed server-side with no client waiting on it.
      let recovered = "";
      for (let i = 0; i < 50; i++) {
        const status = await runCcWithHost(
          ["agent", "status", runId, "--json"],
          env(),
          host,
        );
        const envelope = JSON.parse(status.stdout).payload.data;
        if (envelope.status !== "running") {
          recovered = status.stdout;
          break;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      const envelope = JSON.parse(recovered).payload.data;
      expect(envelope.status).toBe("completed");
      expect(envelope.summary).toBe("the agent did it");
      expect(envelope.referenceDocuments).toEqual([
        {
          filePath: "memory-bank/agent-runs/out.md",
          description: "the output",
        },
      ]);
    },
  );

  it("run --wait long-polls to the completed result", async () => {
    const host = makeHost(completingExecutor());
    const result = await runCcWithHost(
      ["agent", "run", "--file", path.join(dir, "prompt.json"), "--wait"],
      env(),
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("the agent did it");
    expect(result.stdout).toContain("memory-bank/agent-runs/out.md");
  });

  it("cancel aborts a live run, which then reports a terminal state via status", async () => {
    const host = makeHost(abortableExecutor());
    const promptPath = path.join(dir, "prompt.json");

    const runId = JSON.parse(
      (
        await runCcWithHost(
          ["agent", "run", "--file", promptPath, "--json"],
          env(),
          host,
        )
      ).stdout,
    ).payload.data.runId as string;

    const cancelled = await runCcWithHost(
      ["agent", "cancel", runId],
      env(),
      host,
    );
    expect(cancelled.exitCode).toBe(0);

    let terminal = "";
    for (let i = 0; i < 50; i++) {
      const status = await runCcWithHost(
        ["agent", "status", runId, "--json"],
        env(),
        host,
      );
      const envelope = JSON.parse(status.stdout).payload.data;
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
    const result = await runCcWithHost(
      ["agent", "run", "--file", path.join(dir, "prompt.json")],
      { ...env(), CC_API_TOKEN: "wrong" },
      host,
    );
    expect(result.exitCode).toBe(3);
  });
});
