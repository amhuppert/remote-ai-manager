import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "managing-conv",
};

const workflowEnv: CliEnv = {
  ...baseEnv,
  CC_WORKFLOW_EXECUTION_ID: "execution-1",
  CC_WORKFLOW_CONTEXT_ID: "context-1",
};

const DEV_SERVERS_URL =
  "http://127.0.0.1:3000/api/projects/cc/sessions/my-session/dev-servers";
const TARGET = "http://localhost:3001";

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An SSE response whose stream never ends — a turn that never completes. */
function hangingSseResponse(): Response {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function devServer(overrides: Record<string, unknown> = {}) {
  return {
    serverName: "nextjs",
    command: "bun run dev",
    status: "running",
    port: 3001,
    remoteUrl: "https://web.example.ts.net",
    startedAt: "2026-01-01T00:00:00Z",
    errorMessage: null,
    recentOutput: [],
    ownedByThisSession: true,
    worktreePath: "/wt",
    ownerPid: 123,
    logFilePath: "/wt/.cc/dev.log",
    ...overrides,
  };
}

function createdSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionName: "fx-test",
    worktreePath: "/scratch/.worktrees/fx-test",
    branchName: "csm/fx-test",
    conversations: [{ id: "c1", name: "fx-test 1", status: "new" }],
    ...overrides,
  };
}

/**
 * Routes requests the way a managing server + dev-server pair would: the
 * dev-servers list from the managing server, everything else per `routes`.
 */
function makeHost(
  routes: (req: RecordedRequest) => Response | null,
  sessionServer = devServer(),
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      const req = { url, init };
      requests.push(req);
      if (url === DEV_SERVERS_URL && init.method === "GET") {
        return jsonResponse({ servers: [sessionServer] });
      }
      const routed = routes(req);
      if (routed) return routed;
      return jsonResponse({ error: `unrouted: ${init.method} ${url}` }, 404);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl fixture session create", () => {
  function createHost() {
    return makeHost(({ url, init }) => {
      if (
        url === `${TARGET}/api/projects/scratch/sessions` &&
        init.method === "POST"
      ) {
        return jsonResponse(createdSession(), 201);
      }
      if (init.method === "GET" && url.startsWith(TARGET)) {
        return new Response("<html></html>", { status: 200 });
      }
      return null;
    });
  }

  it("creates the session on the dev server and returns ids, urls, and state paths", async () => {
    const host = createHost();
    const result = await runCli(
      ["fixture", "session", "create", "scratch", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.sessionName).toBe("fx-test");
    expect(envelope.conversationId).toBe("c1");
    expect(envelope.target).toBe(TARGET);
    expect(envelope.urls.session).toBe(`${TARGET}/projects/scratch/fx-test`);
    expect(envelope.urls.conversation).toBe(`${TARGET}/conversations?c=c1`);
    expect(envelope.worktreePath).toBe("/wt");
    expect(envelope.dbPath).toBe("/wt/.config/command-center.db");
    expect(envelope.transcriptPath).toBe("/wt/.config/transcripts/c1.jsonl");

    const create = host.requests.find((r) => r.init.method === "POST");
    expect(create?.url).toBe(`${TARGET}/api/projects/scratch/sessions`);
    const body = JSON.parse(create?.init.body ?? "{}");
    expect(body.mode).toBe("normal");
    expect(body.sessionName).toMatch(/^fx-[a-z0-9]+$/);
  });

  it("passes --name through as the session name", async () => {
    const host = createHost();
    await runCli(
      ["fixture", "session", "create", "scratch", "--name", "probe-x"],
      baseEnv,
      host,
    );
    const create = host.requests.find((r) => r.init.method === "POST");
    expect(JSON.parse(create?.init.body ?? "{}").sessionName).toBe("probe-x");
  });

  it("warms the routes the agent will visit next", async () => {
    const host = createHost();
    await runCli(["fixture", "session", "create", "scratch"], baseEnv, host);

    const warmed = host.requests
      .filter((r) => r.init.method === "GET" && r.url.startsWith(TARGET))
      .map((r) => r.url);
    expect(warmed).toContain(`${TARGET}/projects/scratch/fx-test`);
    expect(warmed).toContain(`${TARGET}/conversations?c=c1`);
    expect(warmed).toContain(
      `${TARGET}/api/projects/scratch/sessions/fx-test/conversations`,
    );
  });

  it("skips warm-up with --skip-warm", async () => {
    const host = createHost();
    await runCli(
      ["fixture", "session", "create", "scratch", "--skip-warm"],
      baseEnv,
      host,
    );
    const warmed = host.requests.filter(
      (r) => r.init.method === "GET" && r.url.startsWith(TARGET),
    );
    expect(warmed).toHaveLength(0);
  });

  it("names the available projects when the target project is unknown", async () => {
    const host = makeHost(({ url, init }) => {
      if (
        url.endsWith("/api/projects/nope/sessions") &&
        init.method === "POST"
      ) {
        return jsonResponse({ error: "project not found" }, 404);
      }
      if (url === `${TARGET}/api/projects` && init.method === "GET") {
        return jsonResponse([{ name: "scratch" }, { name: "other" }]);
      }
      return null;
    });
    const result = await runCli(
      ["fixture", "session", "create", "nope"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("scratch");
    expect(result.stderr).toContain("other");
  });

  it("requires a target project argument", async () => {
    const result = await runCli(
      ["fixture", "session", "create"],
      baseEnv,
      makeHost(() => null),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("project");
  });
});

describe("fixture target resolution", () => {
  it("uses the verified workflow-context dev server and reports only its datastore paths", async () => {
    const siblingTarget = TARGET;
    const laneTarget = "http://localhost:3002";
    const siblingWorktree = "/repo/.worktrees/session";
    const laneWorktree = "/repo/.worktrees/lane";
    const host = makeHost(
      ({ url, init }) => {
        const parsed = new URL(url);
        if (
          parsed.pathname ===
            "/api/projects/cc/sessions/my-session/dev-servers" &&
          init.method === "GET"
        ) {
          expect(parsed.searchParams.get("executionId")).toBe("execution-1");
          expect(parsed.searchParams.get("contextId")).toBe("context-1");
          return jsonResponse({
            servers: [devServer({ port: 3002, worktreePath: laneWorktree })],
          });
        }
        if (
          url === `${laneTarget}/api/projects/scratch/sessions` &&
          init.method === "POST"
        ) {
          return jsonResponse(createdSession(), 201);
        }
        if (
          url === `${siblingTarget}/api/projects/scratch/sessions` &&
          init.method === "POST"
        ) {
          return jsonResponse(createdSession(), 201);
        }
        return null;
      },
      devServer({ worktreePath: siblingWorktree }),
    );

    const result = await runCli(
      ["fixture", "session", "create", "scratch", "--skip-warm", "--json"],
      workflowEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.target).toBe(laneTarget);
    expect(envelope.worktreePath).toBe(laneWorktree);
    expect(envelope.dbPath).toBe(`${laneWorktree}/.config/command-center.db`);
    expect(envelope.dbPath).not.toBe(
      `${siblingWorktree}/.config/command-center.db`,
    );
    const fixtureWrites = host.requests.filter(
      ({ init }) => init.method === "POST",
    );
    expect(fixtureWrites.map(({ url }) => url)).toEqual([
      `${laneTarget}/api/projects/scratch/sessions`,
    ]);
  });

  it.each([
    [
      "context id",
      { CC_WORKFLOW_EXECUTION_ID: "execution-1" },
      "CC_WORKFLOW_CONTEXT_ID",
    ],
    [
      "execution id",
      { CC_WORKFLOW_CONTEXT_ID: "context-1" },
      "CC_WORKFLOW_EXECUTION_ID",
    ],
  ])(
    "rejects a missing %s before reading or writing either worktree",
    async (_label, workflowIdentity, missingName) => {
      const host = makeHost(() => null);

      const result = await runCli(
        ["fixture", "session", "create", "scratch"],
        { ...baseEnv, ...workflowIdentity },
        host,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(missingName);
      expect(host.requests).toHaveLength(0);
    },
  );

  it("fails closed when the server rejects stale workflow identity", async () => {
    const host = makeHost(({ url, init }) => {
      const parsed = new URL(url);
      if (
        parsed.pathname ===
          "/api/projects/cc/sessions/my-session/dev-servers" &&
        parsed.searchParams.has("executionId")
      ) {
        return jsonResponse(
          {
            error: "workflow execution is not active",
            code: "WORKFLOW_EXECUTION_NOT_ACTIVE",
            instruction: "Run `cctl workflow status`.",
          },
          409,
        );
      }
      if (init.method === "POST") {
        return jsonResponse(createdSession(), 201);
      }
      return null;
    });

    const result = await runCli(
      ["fixture", "session", "create", "scratch", "--skip-warm", "--json"],
      workflowEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: "workflow execution is not active",
      code: "WORKFLOW_EXECUTION_NOT_ACTIVE",
      instruction: "Run `cctl workflow status`.",
    });
    expect(host.requests.filter(({ init }) => init.method === "POST")).toEqual(
      [],
    );
  });

  it("refuses to run against the managing CC server", async () => {
    const result = await runCli(
      [
        "fixture",
        "session",
        "create",
        "scratch",
        "--target",
        "http://127.0.0.1:3000",
      ],
      baseEnv,
      makeHost(() => null),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("managing CC server");
  });

  it("fails with a dev-ensure hint when no dev server is running", async () => {
    const host = makeHost(() => null);
    host.fetch = async (url, init) => {
      host.requests.push({ url, init });
      if (url === DEV_SERVERS_URL) {
        return jsonResponse({
          servers: [devServer({ status: "stopped", port: null })],
        });
      }
      return jsonResponse({ error: "unrouted" }, 404);
    };
    const result = await runCli(
      ["fixture", "session", "create", "scratch"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cctl dev ensure");
  });

  it("requires --dev to disambiguate multiple running servers", async () => {
    const host = makeHost(() => null);
    host.fetch = async (url, init) => {
      host.requests.push({ url, init });
      if (url === DEV_SERVERS_URL) {
        return jsonResponse({
          servers: [
            devServer(),
            devServer({ serverName: "storybook", port: 6006 }),
          ],
        });
      }
      return jsonResponse({ error: "unrouted" }, 404);
    };
    const result = await runCli(
      ["fixture", "session", "create", "scratch"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nextjs");
    expect(result.stderr).toContain("storybook");
  });
});

describe("cctl fixture session delete", () => {
  it("deletes via the query-param contract, not a path param", async () => {
    const host = makeHost(({ init }) => {
      if (init.method === "DELETE") {
        return jsonResponse({ success: true, worktreeRemoved: true });
      }
      return null;
    });
    const result = await runCli(
      ["fixture", "session", "delete", "scratch", "fx-test", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const del = host.requests.find((r) => r.init.method === "DELETE");
    expect(del?.url).toBe(
      `${TARGET}/api/projects/scratch/sessions?sessionName=fx-test`,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.worktreeRemoved).toBe(true);
  });
});

describe("cctl fixture prompt", () => {
  const conversationsUrl = `${TARGET}/api/projects/scratch/sessions/fx-test/conversations`;
  const promptUrl = `${conversationsUrl}/c1/prompt`;

  function promptHost(promptResponse: () => Response) {
    return makeHost(({ url, init }) => {
      if (url === conversationsUrl && init.method === "GET") {
        return jsonResponse([
          { id: "c1", name: "fx-test 1", status: "new", archived: false },
        ]);
      }
      if (url === promptUrl && init.method === "POST") {
        return promptResponse();
      }
      return null;
    });
  }

  it("posts the prompt and waits for the SSE done event with --wait", async () => {
    const host = promptHost(() =>
      sseResponse(
        'event: start\ndata: {}\n\nevent: assistant-message\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n',
      ),
    );
    const result = await runCli(
      [
        "fixture",
        "prompt",
        "scratch",
        "fx-test",
        "--text",
        "say hi",
        "--wait",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.conversationId).toBe("c1");
    expect(envelope.turn).toBe("completed");
    expect(envelope.transcriptPath).toBe("/wt/.config/transcripts/c1.jsonl");

    const post = host.requests.find((r) => r.url === promptUrl);
    expect(JSON.parse(post?.init.body ?? "{}").prompt).toBe("say hi");
  });

  it("uses an explicit --conversation id without looking one up", async () => {
    const host = makeHost(({ url, init }) => {
      if (url.endsWith("/conversations/c9/prompt") && init.method === "POST") {
        return sseResponse("event: done\ndata: {}\n\n");
      }
      return null;
    });
    const result = await runCli(
      [
        "fixture",
        "prompt",
        "scratch",
        "fx-test",
        "--conversation",
        "c9",
        "--text",
        "hi",
        "--wait",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const lookups = host.requests.filter(
      (r) => r.init.method === "GET" && r.url.startsWith(TARGET),
    );
    expect(lookups).toHaveLength(0);
  });

  it("returns started without waiting when --wait is absent", async () => {
    const host = promptHost(() => hangingSseResponse());
    const result = await runCli(
      ["fixture", "prompt", "scratch", "fx-test", "--text", "go", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.turn).toBe("started");
    expect(envelope.hint).toContain("status");
  });

  it("surfaces a turn error from the SSE stream", async () => {
    const host = promptHost(() =>
      sseResponse('event: error\ndata: {"message":"model exploded"}\n\n'),
    );
    const result = await runCli(
      ["fixture", "prompt", "scratch", "fx-test", "--text", "go", "--wait"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("model exploded");
  });

  it("times out a hung turn when --timeout is given", async () => {
    // The fake host's sleep resolves instantly, so the timeout branch wins
    // the race against the never-ending stream.
    const host = promptHost(() => hangingSseResponse());
    const result = await runCli(
      [
        "fixture",
        "prompt",
        "scratch",
        "fx-test",
        "--text",
        "go",
        "--wait",
        "--timeout",
        "5",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("timed out");
    expect(result.stderr).toContain("fixture status");
  });

  it("requires --text", async () => {
    const result = await runCli(
      ["fixture", "prompt", "scratch", "fx-test"],
      baseEnv,
      makeHost(() => null),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--text");
  });
});

describe("cctl fixture status", () => {
  it("lists the target session's conversations with statuses", async () => {
    const host = makeHost(({ url, init }) => {
      if (
        url.endsWith("/sessions/fx-test/conversations") &&
        init.method === "GET"
      ) {
        return jsonResponse([
          { id: "c1", name: "fx-test 1", status: "running", archived: false },
          { id: "c2", name: "fx-test 2", status: "awaiting", archived: false },
        ]);
      }
      return null;
    });
    const result = await runCli(
      ["fixture", "status", "scratch", "fx-test", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.conversations).toEqual([
      { id: "c1", name: "fx-test 1", status: "running" },
      { id: "c2", name: "fx-test 2", status: "awaiting" },
    ]);
  });
});
