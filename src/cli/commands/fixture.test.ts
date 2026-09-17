import { describe, expect, it } from "vitest";
import { runCcWithHost } from "../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../transport";

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

/**
 * Both CC instances gated, as they are during any branch work: the managing
 * server runs the installed build and the worktree dev server runs the branch,
 * so whichever stamp a binary carries is skewed against one of them. This host
 * refuses every stamped caller the way `src/middleware.ts` does — no binary can
 * satisfy the pair, which is exactly why fixture states no build at all.
 */
function refusingEverySkewedCaller(
  host: CliHost & { requests: RecordedRequest[] },
): CliHost & { requests: RecordedRequest[] } {
  const inner = host.fetch;
  host.fetch = async (url, init) => {
    if (init.headers?.["x-cc-cli-build"] !== undefined) {
      host.requests.push({ url, init });
      return jsonResponse(
        {
          error:
            "refused before execution: this cctl is not the build this server published",
          code: "build_skew",
          details: { serverBuild: "another-build", serverCliPath: null },
        },
        409,
      );
    }
    return inner(url, init);
  };
  return host;
}

describe("fixture across a build-skewed instance pair", () => {
  it("creates the session when neither server would accept this binary's build", async () => {
    const host = refusingEverySkewedCaller(
      makeHost(({ url, init }) => {
        if (
          url === `${TARGET}/api/projects/scratch/sessions` &&
          init.method === "POST"
        ) {
          return jsonResponse(createdSession(), 201);
        }
        return null;
      }),
    );

    const result = await runCcWithHost(
      ["fixture", "session", "create", "scratch", "--skip-warm", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).payload.data.sessionName).toBe("fx-test");
    expect(
      host.requests.filter(
        (r) => r.init.headers?.["x-cc-cli-build"] !== undefined,
      ),
    ).toEqual([]);
  });

  it("runs a turn when neither server would accept this binary's build", async () => {
    const conversationsUrl = `${TARGET}/api/projects/scratch/sessions/fx-test/conversations`;
    const host = refusingEverySkewedCaller(
      makeHost(({ url, init }) => {
        if (url === conversationsUrl && init.method === "GET") {
          return jsonResponse([{ id: "c1", status: "new", archived: false }]);
        }
        if (url === `${conversationsUrl}/c1/prompt` && init.method === "POST") {
          return sseResponse("event: done\ndata: {}\n\n");
        }
        return null;
      }),
    );

    const result = await runCcWithHost(
      ["fixture", "prompt", "scratch", "fx-test", "--text", "go", "--wait"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(
      host.requests.filter(
        (r) => r.init.headers?.["x-cc-cli-build"] !== undefined,
      ),
    ).toEqual([]);
  });
});

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
    const result = await runCcWithHost(
      ["fixture", "session", "create", "scratch", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.payload.data.sessionName).toBe("fx-test");
    expect(envelope.payload.data.conversationId).toBe("c1");
    expect(envelope.payload.data.target).toBe(TARGET);
    expect(envelope.payload.data.urls.session).toBe(
      `${TARGET}/projects/scratch/fx-test`,
    );
    expect(envelope.payload.data.urls.conversation).toBe(
      `${TARGET}/conversations?c=c1`,
    );
    expect(envelope.payload.data.worktreePath).toBe("/wt");
    expect(envelope.payload.data.dbPath).toBe("/wt/.config/command-center.db");
    expect(envelope.payload.data.transcriptPath).toBe(
      "/wt/.config/transcripts/c1.jsonl",
    );

    const create = host.requests.find((r) => r.init.method === "POST");
    expect(create?.url).toBe(`${TARGET}/api/projects/scratch/sessions`);
    const body = JSON.parse(create?.init.body ?? "{}");
    expect(body.mode).toBe("normal");
    expect(body.sessionName).toMatch(/^fx-[a-z0-9]+$/);
  });

  it("passes --name through as the session name", async () => {
    const host = createHost();
    await runCcWithHost(
      ["fixture", "session", "create", "scratch", "--name", "probe-x"],
      baseEnv,
      host,
    );
    const create = host.requests.find((r) => r.init.method === "POST");
    expect(JSON.parse(create?.init.body ?? "{}").sessionName).toBe("probe-x");
  });

  it("warms the routes the agent will visit next", async () => {
    const host = createHost();
    await runCcWithHost(
      ["fixture", "session", "create", "scratch"],
      baseEnv,
      host,
    );

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
    await runCcWithHost(
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
    const result = await runCcWithHost(
      ["fixture", "session", "create", "nope"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("scratch");
    expect(result.stderr).toContain("other");
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

    const result = await runCcWithHost(
      ["fixture", "session", "create", "scratch", "--skip-warm", "--json"],
      workflowEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.target).toBe(laneTarget);
    expect(envelope.payload.data.worktreePath).toBe(laneWorktree);
    expect(envelope.payload.data.dbPath).toBe(
      `${laneWorktree}/.config/command-center.db`,
    );
    expect(envelope.payload.data.dbPath).not.toBe(
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

      const result = await runCcWithHost(
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

    const result = await runCcWithHost(
      ["fixture", "session", "create", "scratch", "--skip-warm", "--json"],
      workflowEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        message: "workflow execution is not active",
        details: { serverCode: "WORKFLOW_EXECUTION_NOT_ACTIVE" },
      },
      instruction: "Run `cctl workflow status`.",
    });
    expect(host.requests.filter(({ init }) => init.method === "POST")).toEqual(
      [],
    );
  });

  // Unstamped requests give up the build gate, so a drifted envelope has to be
  // reported as one: read as "no servers", it sends the caller to start a dev
  // server that is already running.
  it("reports an unreadable dev-servers envelope instead of reading it as none", async () => {
    const host = makeHost(() => null);
    host.fetch = async (url, init) => {
      host.requests.push({ url, init });
      if (url === DEV_SERVERS_URL) {
        return jsonResponse({ devServers: [{ name: "nextjs", state: "up" }] });
      }
      return jsonResponse({ error: "unrouted" }, 404);
    };

    const result = await runCcWithHost(
      ["fixture", "session", "create", "scratch"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "development server registry response is invalid",
    );
    expect(result.stderr).not.toContain("cctl dev ensure");
  });

  it("names the repointed-CC_SERVER_URL trap when the managing server cannot resolve the session", async () => {
    const host = makeHost(() => null);
    host.fetch = async (url, init) => {
      host.requests.push({ url, init });
      return jsonResponse({ error: "Project not found" }, 404);
    };

    const result = await runCcWithHost(
      ["fixture", "session", "create", "scratch"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Project not found");
    expect(result.stderr).toContain("CC_SERVER_URL");
    expect(result.stderr).toContain("--target");
  });

  it("refuses to run against the managing CC server", async () => {
    const result = await runCcWithHost(
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
    expect(result.stderr).toContain("managing CC instance");
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
    const result = await runCcWithHost(
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
    const result = await runCcWithHost(
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
    const result = await runCcWithHost(
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
    expect(envelope.payload.data.worktreeRemoved).toBe(true);
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
    const result = await runCcWithHost(
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
    expect(envelope.payload.data.conversationId).toBe("c1");
    expect(envelope.payload.data.turn).toBe("completed");
    expect(envelope.payload.data.transcriptPath).toBe(
      "/wt/.config/transcripts/c1.jsonl",
    );

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
    const result = await runCcWithHost(
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
    const result = await runCcWithHost(
      ["fixture", "prompt", "scratch", "fx-test", "--text", "go", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.turn).toBe("started");
    expect(envelope.hint).toContain("status");
  });

  it("surfaces a turn error from the SSE stream", async () => {
    const host = promptHost(() =>
      sseResponse('event: error\ndata: {"message":"model exploded"}\n\n'),
    );
    const result = await runCcWithHost(
      ["fixture", "prompt", "scratch", "fx-test", "--text", "go", "--wait"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("model exploded");
  });

  // The failure arm is exactly where the transcript matters, so it must carry
  // the same pointers the success arm prints.
  it("points a failed turn at the transcript and db the success path names", async () => {
    const host = promptHost(() =>
      sseResponse('event: error\ndata: {"message":"model exploded"}\n\n'),
    );
    const result = await runCcWithHost(
      [
        "fixture",
        "prompt",
        "scratch",
        "fx-test",
        "--text",
        "go",
        "--wait",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      effect: "applied",
      error: {
        details: {
          transcriptPath: "/wt/.config/transcripts/c1.jsonl",
          dbPath: "/wt/.config/command-center.db",
        },
      },
    });
  });

  it("times out a hung turn when --timeout is given", async () => {
    // The fake host's sleep resolves instantly, so the timeout branch wins
    // the race against the never-ending stream.
    const host = promptHost(() => hangingSseResponse());
    const result = await runCcWithHost(
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
    const result = await runCcWithHost(
      ["fixture", "status", "scratch", "fx-test", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.conversations).toEqual([
      { id: "c1", name: "fx-test 1", status: "running" },
      { id: "c2", name: "fx-test 2", status: "awaiting" },
    ]);
  });
});
