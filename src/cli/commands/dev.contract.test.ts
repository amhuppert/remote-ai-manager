import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  createDevServerRouteHandlers,
  type DevServerRouteDeps,
} from "@/lib/dev-server/route-handlers";
import {
  NoDevServersConfiguredError,
  type DevServerService,
  type DevServerStatusItem,
} from "@/lib/dev-server/service";
import type { DevServerStatus } from "@/lib/dev-server/schemas";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real dev-server
 * route handlers in-process (no HTTP). Proves the CLI parses the routes' actual
 * response shapes — including deriving localUrl from `port` (the routes strip
 * localUrl via toRuntimeState) — and that `ensure` blocks by polling the list
 * route until the target reaches `running`.
 */

const PROJECT_PATH = "/repos/cc";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;

function item(status: DevServerStatus): DevServerStatusItem {
  const running = status === "running";
  return {
    serverName: "web",
    command: "bun run dev",
    status,
    port: running ? 5010 : null,
    // Set on the service item; the route strips it, forcing the CLI to derive it.
    localUrl: running ? "http://localhost:5010" : null,
    remoteUrl: running ? "https://web.example.ts.net" : null,
    startedAt: null,
    errorMessage: null,
    recentOutput: [],
    ownedByThisSession: running,
    worktreePath: WORKTREE,
    ownerPid: null,
    logFilePath: null,
  };
}

function makeDeps(service: DevServerService): DevServerRouteDeps {
  return {
    async resolveProjectPath() {
      return PROJECT_PATH;
    },
    async getSession() {
      return { worktreePath: WORKTREE };
    },
    service,
    async stopAllForSession() {},
    getServer: () => ({ status: "running" }),
    async stopServer() {},
  };
}

function routeHost(deps: DevServerRouteDeps): CliHost {
  const handlers = createDevServerRouteHandlers(deps);
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // /api/projects/<name>/sessions/<session>/dev-servers[/<serverName>/(start|stop)]
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const serverName = segments[6] ? decodeURIComponent(segments[6]) : "";
      const action = segments[7];
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      if (init.method === "GET") {
        return handlers.GET(request, {
          params: Promise.resolve({ name, session }),
        });
      }
      if (action === "start") {
        return handlers.START(request, {
          params: Promise.resolve({ name, session, serverName }),
        });
      }
      if (action === "stop") {
        return handlers.STOP(request, {
          params: Promise.resolve({ name, session, serverName }),
        });
      }
      throw new Error(`unhandled ${init.method} ${parsed.pathname}`);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "t",
  CC_PROJECT: "cc",
  CC_SESSION: "sess",
};

describe("cctl dev against the real dev-server route handlers", () => {
  it("ensure (no name) starts the single server, polls to running, prints the derived localUrl + hint", async () => {
    let status: DevServerStatus = "stopped";
    let pollsWhileStarting = 0;
    const service: DevServerService = {
      async list() {
        if (status === "starting" && ++pollsWhileStarting >= 2) {
          status = "running";
        }
        return [item(status)];
      },
      async ensure() {
        if (status === "stopped" || status === "error") status = "starting";
        return item(status);
      },
      async stop() {
        status = "stopped";
        return item(status);
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCli(
      ["dev", "ensure"],
      env,
      routeHost(makeDeps(service)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("http://localhost:5010");
    expect(result.stdout).toContain("https://web.example.ts.net");
    expect(
      result.stdout
        .trimEnd()
        .endsWith("re-check liveness with 'cctl dev list'"),
    ).toBe(true);
  });

  it("list renders the derived localUrl for a running server", async () => {
    const service: DevServerService = {
      async list() {
        return [item("running")];
      },
      async ensure() {
        return item("running");
      },
      async stop() {
        return item("stopped");
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCli(
      ["dev", "list", "--json"],
      env,
      routeHost(makeDeps(service)),
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.servers[0].localUrl).toBe("http://localhost:5010");
  });

  it("ensure (named) exits 1 with a CommandCenter.json pointer when nothing is configured", async () => {
    const service: DevServerService = {
      async list() {
        return [];
      },
      async ensure() {
        throw new NoDevServersConfiguredError();
      },
      async stop() {
        return item("stopped");
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCli(
      ["dev", "ensure", "web"],
      env,
      routeHost(makeDeps(service)),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CommandCenter.json");
  });

  it("stop maps to the real STOP route and reports success", async () => {
    const service: DevServerService = {
      async list() {
        return [item("running")];
      },
      async ensure() {
        return item("running");
      },
      async stop() {
        return item("stopped");
      },
      async awaitReady() {
        return item("running");
      },
      async stopUnmanaged() {
        return { killed: [], skipped: [] };
      },
    };

    const result = await runCli(
      ["dev", "stop", "web"],
      env,
      routeHost(makeDeps(service)),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stopped web");
  });
});
