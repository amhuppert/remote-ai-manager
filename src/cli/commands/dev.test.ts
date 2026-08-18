import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
};

const workflowEnv: CliEnv = {
  ...baseEnv,
  CC_WORKFLOW_EXECUTION_ID: "execution-1",
  CC_WORKFLOW_CONTEXT_ID: "context-1",
};

const ENSURE_HINT =
  "drive the app at http://localhost:5010; re-check liveness with 'cctl dev list'";

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

/** A dev-server runtime-state row as the GET/START routes emit it (no localUrl). */
function server(overrides: Record<string, unknown> = {}) {
  return {
    serverName: "web",
    command: "bun run dev",
    status: "running",
    port: 5010,
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

function makeHost(
  respond: (req: RecordedRequest) => Response,
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      const req = { url, init };
      requests.push(req);
      return respond(req);
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

describe("cctl dev list", () => {
  it("lists servers, leading with the local/remote URLs agents need", async () => {
    const host = makeHost(() => jsonResponse({ servers: [server()] }));
    const result = await runCli(["dev", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("GET");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/dev-servers",
    );
    expect(result.stdout).toContain("http://localhost:5010");
    expect(result.stdout).toContain("https://web.example.ts.net");
  });

  it("derives localUrl from the port in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse({ servers: [server()] }));
    const result = await runCli(["dev", "list", "--json"], baseEnv, host);

    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.servers[0].localUrl).toBe("http://localhost:5010");
    expect(envelope.servers[0].remoteUrl).toBe("https://web.example.ts.net");
  });

  it("renders the failure reason and log path the JSON envelope carries", async () => {
    const host = makeHost(() =>
      jsonResponse({
        servers: [
          server({
            status: "error",
            port: null,
            remoteUrl: null,
            errorMessage: "port 5010 is already in use",
            logFilePath: "/wt/.cc/dev-web.log",
          }),
        ],
      }),
    );
    const result = await runCli(["dev", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("error:  port 5010 is already in use");
    expect(result.stdout).toContain("log:    /wt/.cc/dev-web.log");
  });

  it("omits the error and log lines when the server carries neither", async () => {
    const host = makeHost(() =>
      jsonResponse({ servers: [server({ logFilePath: null })] }),
    );
    const result = await runCli(["dev", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("error:");
    expect(result.stdout).not.toContain("log:");
  });

  it("reports an empty configuration plainly", async () => {
    const host = makeHost(() => jsonResponse({ servers: [] }));
    const result = await runCli(["dev", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no dev servers");
  });

  it("carries the invoking workflow context identity to the server", async () => {
    const host = makeHost(() => jsonResponse({ servers: [server()] }));

    const result = await runCli(["dev", "list"], workflowEnv, host);

    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.searchParams.get("executionId")).toBe("execution-1");
    expect(url.searchParams.get("contextId")).toBe("context-1");
  });

  it("rejects incomplete workflow identity before issuing a request", async () => {
    const host = makeHost(() => jsonResponse({ servers: [server()] }));

    const result = await runCli(
      ["dev", "list"],
      {
        ...baseEnv,
        CC_WORKFLOW_EXECUTION_ID: "execution-1",
      },
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_WORKFLOW_CONTEXT_ID");
    expect(host.requests).toHaveLength(0);
  });

  it("uses an explicitly selected session instead of ambient workflow identity", async () => {
    const host = makeHost(() => jsonResponse({ servers: [server()] }));

    const result = await runCli(
      ["dev", "list", "--project", "cc", "--session", "other"],
      workflowEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/projects/cc/sessions/other/dev-servers");
    expect(url.searchParams.has("executionId")).toBe(false);
    expect(url.searchParams.has("contextId")).toBe(false);
  });

  it("treats a rejected workflow target as an operation failure without retrying as the session", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "workflow context missing",
          code: "WORKFLOW_CONTEXT_NOT_FOUND",
          instruction: "Run `cctl workflow status`.",
        },
        404,
      ),
    );

    const result = await runCli(["dev", "list"], workflowEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("instruction: Run `cctl workflow status`.");
    expect(host.requests).toHaveLength(1);
    expect(
      new URL(host.requests[0]?.url ?? "").searchParams.get("executionId"),
    ).toBe("execution-1");
  });
});

describe("cctl dev ensure", () => {
  it("starts the named server, blocks until running, prints URLs + the drive hint", async () => {
    let getCount = 0;
    const host = makeHost((req) => {
      if (req.init.method === "POST") {
        return jsonResponse(
          {
            status: "accepted",
            server: server({ status: "starting", port: null }),
          },
          202,
        );
      }
      getCount++;
      const isRunning = getCount >= 2;
      return jsonResponse({
        servers: [
          server({
            status: isRunning ? "running" : "starting",
            port: isRunning ? 5010 : null,
            remoteUrl: isRunning ? "https://web.example.ts.net" : null,
          }),
        ],
      });
    });

    const result = await runCli(["dev", "ensure", "web"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const startReq = host.requests.find((r) => r.init.method === "POST");
    expect(new URL(startReq?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/dev-servers/web/start",
    );
    expect(result.stdout).toContain("http://localhost:5010");
    expect(result.stdout.endsWith(`hint: ${ENSURE_HINT}\n`)).toBe(true);
  });

  it("names the log file in the ready block, matching the list rendering", async () => {
    const host = makeHost((req) =>
      req.init.method === "POST"
        ? jsonResponse(
            { status: "accepted", server: server({ status: "starting" }) },
            202,
          )
        : jsonResponse({
            servers: [server({ logFilePath: "/wt/.cc/dev-web.log" })],
          }),
    );

    const result = await runCli(["dev", "ensure", "web"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("log:    /wt/.cc/dev-web.log");
  });

  it("resolves the single configured server when no name is given", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") {
        return jsonResponse(
          { status: "accepted", server: server({ status: "starting" }) },
          202,
        );
      }
      return jsonResponse({ servers: [server({ serverName: "web" })] });
    });

    const result = await runCli(["dev", "ensure"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const startReq = host.requests.find((r) => r.init.method === "POST");
    expect(new URL(startReq?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/dev-servers/web/start",
    );
  });

  it("exits 1 with a CommandCenter.json pointer when nothing is configured (no name)", async () => {
    const host = makeHost(() => jsonResponse({ servers: [] }));
    const result = await runCli(["dev", "ensure"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CommandCenter.json");
    expect(host.requests.every((r) => r.init.method === "GET")).toBe(true);
  });

  it("exits 1 with a CommandCenter.json pointer on the NO_DEV_SERVERS_CONFIGURED code (named)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error:
            "No dev servers are configured for this project. Add a `devServers` entry to CommandCenter.json.",
          code: "NO_DEV_SERVERS_CONFIGURED",
        },
        400,
      ),
    );
    const result = await runCli(["dev", "ensure", "web"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CommandCenter.json");
  });

  it("exits 2 and lists the names when multiple servers are configured and none is named", async () => {
    const host = makeHost(() =>
      jsonResponse({
        servers: [server({ serverName: "web" }), server({ serverName: "api" })],
      }),
    );
    const result = await runCli(["dev", "ensure"], baseEnv, host);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("web");
    expect(result.stderr).toContain("api");
    expect(host.requests.every((r) => r.init.method === "GET")).toBe(true);
  });

  it("exits 1 with the recent output when the server errors while starting", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") {
        return jsonResponse(
          { status: "accepted", server: server({ status: "starting" }) },
          202,
        );
      }
      return jsonResponse({
        servers: [
          server({
            status: "error",
            port: null,
            errorMessage: "boom",
            recentOutput: ["Error: boom", "  at start"],
          }),
        ],
      });
    });
    const result = await runCli(["dev", "ensure", "web"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed to start");
    expect(result.stderr).toContain("boom");
  });

  it("exits 1 when the server never reaches running state (timeout)", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") {
        return jsonResponse(
          { status: "accepted", server: server({ status: "starting" }) },
          202,
        );
      }
      return jsonResponse({
        servers: [server({ status: "starting", port: null })],
      });
    });
    const result = await runCli(["dev", "ensure", "web"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("running state");
  });

  // A bare "did not reach running state" says nothing about why. The facts the
  // next command would fetch are already in the poll the wait gave up on.
  it("carries the last-known status, its recent output, and the list pointer on timeout", async () => {
    const host = makeHost((req) => {
      if (req.init.method === "POST") {
        return jsonResponse(
          { status: "accepted", server: server({ status: "starting" }) },
          202,
        );
      }
      return jsonResponse({
        servers: [
          server({
            status: "starting",
            port: null,
            recentOutput: ["compiling…", "still compiling"],
          }),
        ],
      });
    });

    const result = await runCli(
      ["dev", "ensure", "web", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.details.forensics.join("\n")).toContain(
      "last status: starting",
    );
    expect(envelope.details.forensics.join("\n")).toContain("still compiling");
    expect(envelope.hint).toContain("cctl dev list");
  });

  it("retains workflow identity on the initial list, start, and every readiness poll", async () => {
    let listCount = 0;
    const host = makeHost((req) => {
      if (req.init.method === "POST") {
        return jsonResponse(
          { status: "accepted", server: server({ status: "starting" }) },
          202,
        );
      }
      listCount++;
      return jsonResponse({
        servers: [
          server({
            status: listCount >= 3 ? "running" : "starting",
            port: listCount >= 3 ? 5010 : null,
          }),
        ],
      });
    });

    const result = await runCli(["dev", "ensure"], workflowEnv, host);

    expect(result.exitCode).toBe(0);
    expect(host.requests.length).toBeGreaterThanOrEqual(4);
    for (const request of host.requests) {
      const url = new URL(request.url);
      expect(url.searchParams.get("executionId")).toBe("execution-1");
      expect(url.searchParams.get("contextId")).toBe("context-1");
    }
  });
});

describe("cctl dev stop", () => {
  it("stops the named server and exits 0 with no hint", async () => {
    const host = makeHost(() => jsonResponse({ status: "ok" }));
    const result = await runCli(["dev", "stop", "web"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/dev-servers/web/stop",
    );
    expect(result.stdout).toContain("stopped web");
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 2 when the server name is missing", async () => {
    const host = makeHost(() => jsonResponse({ status: "ok" }));
    const result = await runCli(["dev", "stop"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the server is not running (404)", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: 'Server "web" is not running' }, 404),
    );
    const result = await runCli(["dev", "stop", "web"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not running");
  });

  it("preserves the server's coded 404 in the --json envelope (exit 2)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: 'Unknown dev server "web"', code: "UNKNOWN_DEV_SERVER" },
        404,
      ),
    );
    const result = await runCli(
      ["dev", "stop", "web", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNKNOWN_DEV_SERVER");
  });

  it("carries the invoking workflow context identity to the stop route", async () => {
    const host = makeHost(() => jsonResponse({ status: "ok" }));

    const result = await runCli(["dev", "stop", "web"], workflowEnv, host);

    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.searchParams.get("executionId")).toBe("execution-1");
    expect(url.searchParams.get("contextId")).toBe("context-1");
  });
});

describe("cctl dev (dispatch)", () => {
  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({ servers: [] }));
    const result = await runCli(["dev", "frobnicate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401));
    const result = await runCli(["dev", "list"], baseEnv, host);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });
});
