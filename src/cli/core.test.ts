import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { runCli, type CliEnv, type CliHost, type FetchInit } from "./core";

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
  init: FetchInit;
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
    async readFileBytes() {
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

describe("cctl help", () => {
  it("prints global usage on stdout and exits 0 for --help", async () => {
    const result = await runCli(["--help"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: cctl");
    expect(result.stdout).toContain("commands:");
    expect(result.stderr).toBe("");
  });

  it("treats -h and the help command as aliases for --help", async () => {
    for (const argv of [["-h"], ["help"]]) {
      const result = await runCli(argv, {}, makeHost());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("usage: cctl");
    }
  });

  it("prints command-scoped help for <command> --help", async () => {
    const result = await runCli(["dev", "--help"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    // A group node renders an index: its header plus one line per child subcommand.
    expect(result.stdout).toContain("cctl dev —");
    expect(result.stdout).toContain("dev ensure");
    expect(result.stdout).not.toContain("codex");
    expect(result.stderr).toBe("");
  });

  it("scopes help to the command even when a subcommand is present", async () => {
    const result = await runCli(["dev", "ensure", "--help"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cctl dev ensure");
  });

  it("supports `cctl help <command>`", async () => {
    const result = await runCli(["help", "codex"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    // `codex` is a group node: its help is an index — the header plus one line
    // per child subcommand.
    expect(result.stdout).toContain("cctl codex —");
    expect(result.stdout).toContain("codex run");
  });

  it("still exits 2 for --help on an unknown command", async () => {
    const result = await runCli(["frobnicate", "--help"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("frobnicate");
  });

  it("exits 2 for --help on an unknown subpath, listing the parent's children", async () => {
    const result = await runCli(
      ["dev", "frobnicate", "--help"],
      {},
      makeHost(),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown dev subcommand "frobnicate"');
    // the hint steers the agent back to the group's real children
    expect(result.stderr).toContain("dev subcommands: list, ensure, stop");
  });

  it("emits the structured help node in the --json envelope", async () => {
    const result = await runCli(["dev", "--help", "--json"], {}, makeHost());
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    // The JSON help shape is the structured node (doc 04 §3.3), not a text blob.
    expect(envelope.help.command).toBe("dev");
    expect(Array.isArray(envelope.help.usage)).toBe(true);
    expect(envelope.usage).toBeUndefined();
  });

  it("has scoped help for every dispatched command", async () => {
    const commands = [
      "ask",
      "notify",
      "docs",
      "dev",
      "fixture",
      "workflow",
      "charter",
      "decisions",
      "codex",
      "conversation",
      "doctor",
      "version",
    ];
    for (const command of commands) {
      const result = await runCli([command, "--help"], {}, makeHost());
      expect(result.exitCode, `${command} --help should exit 0`).toBe(0);
      expect(result.stdout).toContain(`cctl ${command}`);
    }
  });
});

describe("cctl help — dynamic context (doc 04 §4.4)", () => {
  function contextResponse() {
    return jsonResponse({
      blocks: [
        { title: "dev servers", body: "web — running (http://localhost:5010)" },
      ],
    });
  }

  it("renders server context blocks under context: on success (text)", async () => {
    const host = makeHost({
      async fetch() {
        return contextResponse();
      },
    });
    const result = await runCli(["dev", "ensure", "--help"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("context:");
    expect(result.stdout).toContain("dev servers");
    expect(result.stdout).toContain("web — running");
    expect(result.stderr).toBe("");
  });

  it("includes context.blocks in the JSON help envelope on success", async () => {
    const host = makeHost({
      async fetch() {
        return contextResponse();
      },
    });
    const result = await runCli(
      ["dev", "ensure", "--help", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.help.context.blocks[0].title).toBe("dev servers");
  });

  it("queries help-context with command, identity, forwarded lane params, and a 500ms timeout", async () => {
    // The default host records requests; its handshake-shaped response fails
    // the help-context schema and falls open to [] — this test only asserts the
    // request that was sent, not the (irrelevant) rendered blocks.
    const host = makeHost();
    const laneEnv: CliEnv = {
      ...baseEnv,
      CC_WORKFLOW_EXECUTION_ID: "exec-1",
      CC_WORKFLOW_CONTEXT_ID: "ctx-1",
    };
    await runCli(["workflow", "task", "complete", "--help"], laneEnv, host);

    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/agent/help-context");
    expect(url.searchParams.get("command")).toBe("workflow task complete");
    expect(url.searchParams.get("project")).toBe("cc");
    expect(url.searchParams.get("executionId")).toBe("exec-1");
    expect(url.searchParams.get("contextId")).toBe("ctx-1");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(request.init.timeoutMs).toBe(500);
  });

  it("does not fetch for a static (non-dynamicContext) command's help", async () => {
    const host = makeHost();
    await runCli(["ask", "--help"], baseEnv, host);
    expect(host.requests).toHaveLength(0);
  });

  it("does not fetch for a group node's text help (a pure index, doc 04 §3.1)", async () => {
    const host = makeHost();
    await runCli(["dev", "--help"], baseEnv, host);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl help — fail-open (doc 04 §4.4, byte-identical static fallback)", () => {
  const noServerEnv: CliEnv = (() => {
    const env = { ...baseEnv };
    delete env["CC_SERVER_URL"];
    return env;
  })();

  // No server URL → no fetch attempted → the pure static rendering.
  async function staticOutput(argv: string[]) {
    return runCli(argv, noServerEnv, makeHost());
  }

  const failureHosts: Array<[string, Partial<CliHost>]> = [
    [
      "connection error",
      {
        async fetch() {
          throw new Error("ECONNREFUSED");
        },
      },
    ],
    [
      "timeout (aborted fetch)",
      {
        async fetch() {
          throw new Error("The operation was aborted due to timeout");
        },
      },
    ],
    [
      "non-2xx status",
      {
        async fetch() {
          return jsonResponse({ error: "boom" }, 500);
        },
      },
    ],
    [
      "schema-mismatched body",
      {
        async fetch() {
          return jsonResponse({ not: "blocks" });
        },
      },
    ],
    [
      "unparseable body",
      {
        async fetch() {
          return new Response("<<<not json", { status: 200 });
        },
      },
    ],
  ];

  for (const mode of ["text", "json"] as const) {
    const argv =
      mode === "json"
        ? ["dev", "ensure", "--help", "--json"]
        : ["dev", "ensure", "--help"];

    it(`static baseline exits 0 with empty stderr (${mode})`, async () => {
      const result = await staticOutput(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    for (const [label, override] of failureHosts) {
      it(`renders byte-identical static help on ${label} (${mode})`, async () => {
        const staticResult = await staticOutput(argv);
        const result = await runCli(argv, baseEnv, makeHost(override));
        expect(result.stdout).toBe(staticResult.stdout);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
      });
    }
  }

  it("renders static help (no fetch) when no token resolves", async () => {
    const noTokenEnv: CliEnv = (() => {
      const env = { ...baseEnv };
      delete env["CC_API_TOKEN"];
      return env;
    })();
    const staticResult = await staticOutput(["dev", "ensure", "--help"]);
    const host = makeHost();
    const result = await runCli(["dev", "ensure", "--help"], noTokenEnv, host);
    expect(result.stdout).toBe(staticResult.stdout);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(host.requests).toHaveLength(0);
  });
});

describe("usage errors", () => {
  it("exits 2 with usage on stderr for an unknown command", async () => {
    const result = await runCli(["frobnicate"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("frobnicate");
    expect(result.stdout).toBe("");
  });

  it("emits a scoped one-line error, not the full usage dump", async () => {
    const result = await runCli(["frobnicate"], {}, makeHost());
    // The full dump's marker is the `commands:` section — it must be gone.
    expect(result.stderr).not.toContain("commands:");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain("frobnicate");
    expect(lines[lines.length - 1]).toMatch(/^hint: /);
  });

  it("keeps command arg errors to a scoped one-liner with a help hint", async () => {
    const result = await runCli(["dev", "stop"], baseEnv, makeHost());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("commands:");
    expect(result.stderr).toContain("dev stop requires");
    expect(result.stderr).toContain("--help");
  });

  it("includes the help hint in the --json usage-error envelope", async () => {
    const result = await runCli(["frobnicate", "--json"], {}, makeHost());
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.hint).toContain("--help");
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
