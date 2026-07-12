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

const DECISIONS_FILE = "/tmp/decisions.json";

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

const decisionsFile = (
  decisions: { statement: string; rationale?: string; context?: string }[] = [
    { statement: "Use SQLite", rationale: "Simplicity" },
    { statement: "No focus mode" },
  ],
) => JSON.stringify({ decisions });

describe("cctl decisions propose", () => {
  it("POSTs the decisions + conversationId and exits 0 with no hint", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, batchId: "batch-1", count: 2 }),
      { [DECISIONS_FILE]: decisionsFile() },
    );
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/sessions/my-session/alignment/decisions",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      decisions: [
        { statement: "Use SQLite", rationale: "Simplicity" },
        { statement: "No focus mode" },
      ],
      conversationId: "conv-9",
    });
    expect(result.stdout).toContain(
      "proposed 2 decisions for the user's review",
    );
    expect(result.stdout).not.toContain("hint:");
  });

  it("uses the singular noun for a single decision", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, batchId: "batch-1", count: 1 }),
      { [DECISIONS_FILE]: decisionsFile([{ statement: "One thing" }]) },
    );
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "proposed 1 decision for the user's review",
    );
  });

  it("carries batchId + count in the --json envelope", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, batchId: "batch-42", count: 2 }),
      { [DECISIONS_FILE]: decisionsFile() },
    );
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE, "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.batchId).toBe("batch-42");
    expect(envelope.count).toBe(2);
  });

  it("exits 2 when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["decisions", "propose"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--file");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the file cannot be read", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot read");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when a positional argument is passed", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [DECISIONS_FILE]: decisionsFile(),
    });
    const result = await runCli(
      ["decisions", "propose", "stray", "--file", DECISIONS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when no conversation identity is available", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [DECISIONS_FILE]: decisionsFile(),
    });
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      { ...baseEnv, CC_CONVERSATION_ID: undefined },
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("conversation");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401), {
      [DECISIONS_FILE]: decisionsFile(),
    });
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });

  it("exits 2 with the field path on a 400 validation error", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Invalid request body",
            issues: [
              {
                path: "decisions",
                message: "Array must contain at least 1 element(s)",
              },
            ],
          },
          400,
        ),
      { [DECISIONS_FILE]: JSON.stringify({ decisions: [] }) },
    );
    const result = await runCli(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("decisions");
  });
});

describe("cctl decisions (dispatch)", () => {
  it("exits 2 with no subcommand", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["decisions"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("subcommand");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["decisions", "wat"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});
