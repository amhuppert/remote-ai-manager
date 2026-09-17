import { describe, expect, it } from "vitest";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

const CLI_BUILD = formatBuildStamp(BUILD_INFO);
const MANAGING = "http://127.0.0.1:3000";
const DEV = "http://localhost:3001";
const MANAGING_CONFIG_DIR = "/Users/test/Library/Application Support/cc";
const DEV_CONFIG_DIR = "/repo/.worktrees/feature/.config";

const baseEnv: CliEnv = {
  CC_SERVER_URL: MANAGING,
  CC_API_TOKEN: "managing-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_SCOPE: "session",
  CC_CONVERSATION_ID: "conv-1",
};

function handshakeHost(
  respond: (url: string, token: string | null) => Response,
): CliHost {
  return {
    async fetch(url, init) {
      const auth = init.headers?.["authorization"];
      return respond(url, auth?.replace("Bearer ", "") ?? null);
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

function handshakeBody(overrides: Record<string, unknown> = {}) {
  return {
    serverBuild: CLI_BUILD,
    identity: { project: "cc", session: "my-session", conversation: "conv-1" },
    tokenValid: true,
    cliPath: `${MANAGING_CONFIG_DIR}/bin/cctl`,
    configDir: MANAGING_CONFIG_DIR,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cctl doctor", () => {
  it("carries the server's cctl path and config dir in the JSON envelope", async () => {
    const host = handshakeHost(() => jsonResponse(handshakeBody()));

    const result = await runCli(["doctor", "--json"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    // The skew refusal tells an agent to run `cctl doctor` for the recovery
    // binary's path; an envelope without it makes that hint a dead end.
    expect(envelope.cliPath).toBe(`${MANAGING_CONFIG_DIR}/bin/cctl`);
    expect(envelope.configDir).toBe(MANAGING_CONFIG_DIR);
  });

  it("names the config dir in human output so two instances are distinguishable", async () => {
    const host = handshakeHost(() => jsonResponse(handshakeBody()));

    const result = await runCli(["doctor"], baseEnv, host);

    expect(result.stdout).toContain(MANAGING_CONFIG_DIR);
  });

  it("rejects an incomplete server identity", async () => {
    const host = handshakeHost(() =>
      jsonResponse({
        serverBuild: CLI_BUILD,
        identity: { project: "cc", session: null, conversation: null },
        tokenValid: true,
      }),
    );

    const result = await runCli(["doctor", "--json"], baseEnv, host);

    const envelope = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
  });

  // The ambient token authenticates the managing instance. Pointed at a dev
  // server, the generic "rejected the token" message reads as a broken token
  // rather than as the wrong instance's token, and its recovery needs the very
  // config dir the caller was trying to discover.
  it("explains a 401 from another instance as a per-instance token", async () => {
    const host = handshakeHost((url) =>
      url.startsWith(DEV)
        ? jsonResponse({ error: "unauthorized" }, 401)
        : jsonResponse(handshakeBody()),
    );

    const result = await runCli(
      ["doctor", "--server", DEV, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error).toContain(DEV);
    expect(envelope.error).toContain(MANAGING);
    expect(envelope.hint).toContain("cctl dev doctor");
  });

  it("keeps the plain token failure when no second instance is in play", async () => {
    const host = handshakeHost(() => jsonResponse({ error: "no" }, 401));

    const result = await runCli(["doctor", "--json"], baseEnv, host);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).error).not.toContain("dev doctor");
  });
});

describe("cctl dev doctor", () => {
  const DEV_SERVERS_URL = `${MANAGING}/api/projects/cc/sessions/my-session/dev-servers`;
  const WORKTREE = "/repo/.worktrees/feature";

  function devDoctorHost(overrides?: {
    devToken?: string;
    tokenFile?: string | null;
  }): CliHost {
    const devToken = overrides?.devToken ?? "dev-token";
    return {
      async fetch(url, init) {
        const token =
          init.headers?.["authorization"]?.replace("Bearer ", "") ?? null;
        if (url.startsWith(DEV_SERVERS_URL)) {
          return jsonResponse({
            servers: [
              {
                serverName: "nextjs",
                command: "bun run dev",
                status: "running",
                port: 3001,
                remoteUrl: null,
                startedAt: "2026-01-01T00:00:00Z",
                errorMessage: null,
                recentOutput: [],
                ownedByThisSession: true,
                worktreePath: WORKTREE,
                ownerPid: 1,
                logFilePath: `${WORKTREE}/.cc/dev.log`,
              },
            ],
          });
        }
        if (url.startsWith(DEV)) {
          if (token !== devToken) return jsonResponse({ error: "no" }, 401);
          return jsonResponse(
            handshakeBody({
              serverBuild: "branch-build",
              cliPath: `${DEV_CONFIG_DIR}/bin/cctl`,
              configDir: DEV_CONFIG_DIR,
            }),
          );
        }
        return jsonResponse(handshakeBody());
      },
      async readTextFile(filePath) {
        if (overrides?.tokenFile !== undefined) return overrides.tokenFile;
        return filePath === `${WORKTREE}/.config/api-token`
          ? `${devToken}\n`
          : null;
      },
      async readFileBytes() {
        return null;
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
  }

  it("reports both instances, each with the state directory it owns", async () => {
    const result = await runCli(
      ["dev", "doctor", "--json"],
      baseEnv,
      devDoctorHost(),
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.managing.server).toBe(MANAGING);
    expect(envelope.managing.configDir).toBe(MANAGING_CONFIG_DIR);
    expect(envelope.dev.server).toBe(DEV);
    expect(envelope.dev.serverName).toBe("nextjs");
    expect(envelope.dev.configDir).toBe(DEV_CONFIG_DIR);
    // The load-bearing fact: these are different instances, so nothing a bare
    // cctl verb creates can appear in the dev server's UI or DB.
    expect(envelope.sameInstance).toBe(false);
  });

  it("names which instance a bare cctl verb talks to", async () => {
    const result = await runCli(["dev", "doctor"], baseEnv, devDoctorHost());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(MANAGING_CONFIG_DIR);
    expect(result.stdout).toContain(DEV_CONFIG_DIR);
    expect(result.stdout).toContain("bare `cctl`");
  });

  // Diagnosing the pair is exactly when the binary is skewed against one of
  // them, so the lookup that finds the dev server must not itself be gated.
  it("resolves the dev server without stating a build", async () => {
    const stamped: string[] = [];
    const host = devDoctorHost();
    const inner = host.fetch;
    host.fetch = async (url, init) => {
      if (url.startsWith(DEV_SERVERS_URL) && init.headers?.["x-cc-cli-build"]) {
        stamped.push(url);
      }
      return inner(url, init);
    };

    const result = await runCli(["dev", "doctor"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(stamped).toEqual([]);
  });

  it("points at the dev instance's own token file when it has none to use", async () => {
    const result = await runCli(
      ["dev", "doctor", "--json"],
      baseEnv,
      devDoctorHost({ tokenFile: null }),
    );

    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error).toContain(`${WORKTREE}/.config/api-token`);
  });
});
