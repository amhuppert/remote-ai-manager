import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "conv-9",
};

const CHARTER_FILE = "/tmp/charter.json";

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

function makeHost(
  respond: (req: RecordedRequest) => Response,
  files: Record<string, string> = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      const req = { url, init };
      requests.push(req);
      return respond(req);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const charterFile = (content = "## Mission\nShip the thing.") =>
  JSON.stringify({ content });

describe("cctl charter write", () => {
  it("POSTs the file content + conversationId and exits 0 with no hint", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, status: "draft_ready", version: null }),
      {
        [CHARTER_FILE]: charterFile(),
      },
    );
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/sessions/my-session/alignment/charter",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      content: "## Mission\nShip the thing.",
      conversationId: "conv-9",
    });
    expect(result.stdout).toContain("pending the user's approval");
    expect(result.stdout).not.toContain("hint:");
  });

  it("reports activation with the version when the draft auto-activates", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, status: "activated", version: 3 }),
      { [CHARTER_FILE]: charterFile() },
    );
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("charter activated as version 3");
  });

  it("carries the status in the --json envelope", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, status: "draft_ready", version: null }),
      { [CHARTER_FILE]: charterFile() },
    );
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE, "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe("draft_ready");
  });

  it("lets --conversation override the ambient conversation identity", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, status: "draft_ready", version: null }),
      { [CHARTER_FILE]: charterFile() },
    );
    await runCli(
      [
        "charter",
        "write",
        "--file",
        CHARTER_FILE,
        "--conversation",
        "conv-override",
      ],
      baseEnv,
      host,
    );
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}").conversationId).toBe(
      "conv-override",
    );
  });

  it("exits 2 when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["charter", "write"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--file");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the file cannot be read", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot read");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the file is not valid JSON", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [CHARTER_FILE]: "not json",
    });
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when a positional argument is passed", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [CHARTER_FILE]: charterFile(),
    });
    const result = await runCli(
      ["charter", "write", "stray", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when no conversation identity is available", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [CHARTER_FILE]: charterFile(),
    });
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      { ...baseEnv, CC_CONVERSATION_ID: undefined },
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("conversation");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401), {
      [CHARTER_FILE]: charterFile(),
    });
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });

  it("exits 1 when the server refuses (409 no active runtime)", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          { error: "no active conversation runtime; cannot author alignment" },
          409,
        ),
      { [CHARTER_FILE]: charterFile() },
    );
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no active conversation runtime");
  });

  it("exits 2 with the field path on a 400 validation error", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Invalid request body",
            issues: [
              {
                path: "content",
                message: "String must contain at least 1 character(s)",
              },
            ],
          },
          400,
        ),
      { [CHARTER_FILE]: charterFile("") },
    );
    const result = await runCli(
      ["charter", "write", "--file", CHARTER_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("content");
  });
});

describe("cctl charter (dispatch)", () => {
  it("exits 2 with no subcommand", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["charter"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("subcommand");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["charter", "frobnicate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});
