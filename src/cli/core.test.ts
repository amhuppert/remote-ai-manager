import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { runCli, type CliEnv, type CliHost } from "./core";

const CLI_BUILD = formatBuildStamp(BUILD_INFO);
const SERVER_URL = "http://127.0.0.1:3000";

const baseEnv: CliEnv = {
  CC_SERVER_URL: SERVER_URL,
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "conv-1",
};

interface RecordedRequest {
  url: string;
  init: { method: string; headers: Record<string, string> };
}

function handshakeBody(overrides: Record<string, unknown> = {}) {
  return {
    serverBuild: CLI_BUILD,
    identity: { project: "cc", session: "my-session", conversation: "conv-1" },
    tokenValid: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  overrides: Partial<CliHost> = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      return jsonResponse(handshakeBody());
    },
    async readTextFile() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
    ...overrides,
  };
}

describe("cctl version", () => {
  it("prints the build stamp and exits 0", async () => {
    const result = await runCli(["version"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`cctl ${CLI_BUILD}\n`);
    expect(result.stderr).toBe("");
  });

  it("treats --version as an alias", async () => {
    const result = await runCli(["--version"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(CLI_BUILD);
  });

  it("emits the --json envelope with the build stamp", async () => {
    const result = await runCli(["version", "--json"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.cliBuild).toBe(CLI_BUILD);
  });
});

describe("usage errors", () => {
  it("exits 2 with usage on stderr for an unknown command", async () => {
    const result = await runCli(["frobnicate"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("frobnicate");
    expect(result.stdout).toBe("");
  });

  it("exits 2 with usage when invoked with no arguments", async () => {
    const result = await runCli([], {}, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage");
  });

  it("exits 2 for an unknown flag", async () => {
    const result = await runCli(["doctor", "--frob"], baseEnv, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--frob");
  });

  it("exits 2 when a value flag is missing its value", async () => {
    const result = await runCli(["doctor", "--token"], baseEnv, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--token");
  });

  it("emits the --json envelope for an unknown command", async () => {
    const result = await runCli(["frobnicate", "--json"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("frobnicate");
  });

  it("emits the --json envelope when invoked with no command", async () => {
    const result = await runCli(["--json"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(typeof envelope.error).toBe("string");
  });

  it("emits the --json envelope even when argv fails to parse", async () => {
    const result = await runCli(
      ["doctor", "--frob", "--json"],
      baseEnv,
      makeHost(),
    );
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("--frob");
  });
});

describe("cctl doctor", () => {
  it("prints server build, cli build, identity, and token validity on success", async () => {
    const host = makeHost();
    const result = await runCli(["doctor"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(SERVER_URL);
    expect(result.stdout).toContain(CLI_BUILD);
    expect(result.stdout).toContain("project=cc");
    expect(result.stdout).toContain("session=my-session");
    expect(result.stdout).toContain("conversation=conv-1");
    expect(result.stdout).toContain("valid (source: env)");
    expect(result.stderr).toBe("");
  });

  it("sends the X-CC-CLI-Build header, bearer token, and identity query params", async () => {
    const host = makeHost();
    await runCli(["doctor"], baseEnv, host);

    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(request.init.headers["x-cc-cli-build"]).toBe(CLI_BUILD);
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/agent/handshake");
    expect(url.searchParams.get("project")).toBe("cc");
    expect(url.searchParams.get("session")).toBe("my-session");
    expect(url.searchParams.get("conversation")).toBe("conv-1");
  });

  it("prefers the --token flag over the env token", async () => {
    const host = makeHost();
    await runCli(["doctor", "--token", "flag-token"], baseEnv, host);
    expect(host.requests[0]?.init.headers["authorization"]).toBe(
      "Bearer flag-token",
    );
  });

  it("prefers the env token over the token file", async () => {
    const readTextFile = vi.fn(async () => "file-token\n");
    const host = makeHost({ readTextFile });
    await runCli(["doctor"], baseEnv, host);
    expect(host.requests[0]?.init.headers["authorization"]).toBe(
      "Bearer env-token",
    );
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("falls back to <configDir>/api-token when no flag or env token exists", async () => {
    const readTextFile = vi.fn(async () => "file-token\n");
    const host = makeHost({ readTextFile });
    const env: CliEnv = { ...baseEnv, CC_CONFIG_DIR: "/cfg" };
    delete env["CC_API_TOKEN"];

    const result = await runCli(["doctor"], env, host);

    expect(readTextFile).toHaveBeenCalledWith(path.join("/cfg", "api-token"));
    expect(host.requests[0]?.init.headers["authorization"]).toBe(
      "Bearer file-token",
    );
    expect(result.stdout).toContain("valid (source: file)");
  });

  it("prefers --server over CC_SERVER_URL", async () => {
    const host = makeHost();
    await runCli(
      ["doctor", "--server", "http://127.0.0.1:4111"],
      baseEnv,
      host,
    );
    expect(host.requests[0]?.url).toContain("http://127.0.0.1:4111");
  });

  it("exits 2 naming CC_SERVER_URL when no server URL is available", async () => {
    const result = await runCli(["doctor"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_SERVER_URL");
  });

  it("exits 3 with an actionable first line when the server is unreachable", async () => {
    const host = makeHost({
      async fetch() {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await runCli(["doctor"], baseEnv, host);

    expect(result.exitCode).toBe(3);
    const firstLine = result.stderr.split("\n")[0] ?? "";
    expect(firstLine).toContain("is the CC server running?");
    expect(result.stderr).toContain("ECONNREFUSED");
  });

  it("renders the advisory hint as a final `hint:` line in text mode", async () => {
    const host = makeHost({
      async fetch() {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await runCli(["doctor"], baseEnv, host);

    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^hint: /);
  });

  it("exits 3 and reports the token source when the server rejects the token", async () => {
    const host = makeHost({
      async fetch() {
        return jsonResponse({ error: "nope" }, 401);
      },
    });
    const result = await runCli(["doctor"], baseEnv, host);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
    expect(result.stderr).toContain("env");
  });

  it("exits 3 and names the token sources when no token could be resolved", async () => {
    const host = makeHost({
      async fetch() {
        return jsonResponse({ error: "nope" }, 401);
      },
    });
    const env: CliEnv = { ...baseEnv };
    delete env["CC_API_TOKEN"];

    const result = await runCli(["doctor"], env, host);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("CC_API_TOKEN");
  });

  it("exits 1 when the server returns an unexpected error status", async () => {
    const host = makeHost({
      async fetch() {
        return jsonResponse({ error: "boom" }, 500);
      },
    });
    const result = await runCli(["doctor"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("500");
  });

  it("warns on stderr but exits 0 when server and CLI builds differ", async () => {
    const host = makeHost({
      async fetch() {
        return jsonResponse(
          handshakeBody({ serverBuild: "other00-2026-01-01T00:00:00.000Z" }),
        );
      },
    });
    const result = await runCli(["doctor"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("other00-2026-01-01T00:00:00.000Z");
    expect(result.stderr).toContain(CLI_BUILD);
  });

  it("emits a --json envelope with the reserved hint field on success", async () => {
    const result = await runCli(["doctor", "--json"], baseEnv, makeHost());

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.serverBuild).toBe(CLI_BUILD);
    expect(envelope.cliBuild).toBe(CLI_BUILD);
    expect(envelope.tokenValid).toBe(true);
    expect(envelope.identity).toEqual({
      project: "cc",
      session: "my-session",
      conversation: "conv-1",
    });
    if ("hint" in envelope) {
      expect(typeof envelope.hint).toBe("string");
    }
  });

  it("emits a --json failure envelope with error and hint when unreachable", async () => {
    const host = makeHost({
      async fetch() {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await runCli(["doctor", "--json"], baseEnv, host);

    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(typeof envelope.error).toBe("string");
    expect(typeof envelope.hint).toBe("string");
  });
});
