import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
};

const DOCS_LIST_HINT =
  "register new docs with 'cctl docs register <path> --description …'; remove stale ones with 'cctl docs delete <id>'";

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

const sampleDoc = {
  id: "doc-1",
  filePath: "docs/a.md",
  description: "why it matters",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("cctl docs register", () => {
  it("POSTs filePath + description and exits 0 with no hint", async () => {
    const host = makeHost(() => jsonResponse({ document: sampleDoc }));
    const result = await runCli(
      ["docs", "register", "docs/a.md", "--description", "why it matters"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/sessions/my-session/reference-documents",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      filePath: "docs/a.md",
      description: "why it matters",
    });
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 2 when --description is missing", async () => {
    const host = makeHost(() => jsonResponse({ document: sampleDoc }));
    const result = await runCli(
      ["docs", "register", "docs/a.md"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--description");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the path argument is missing", async () => {
    const host = makeHost(() => jsonResponse({ document: sampleDoc }));
    const result = await runCli(
      ["docs", "register", "--description", "why"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on a worktree-escape 400 from the server", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "filePath must resolve inside the session worktree",
          issues: [
            { path: "filePath", message: "path escapes the session worktree" },
          ],
        },
        400,
      ),
    );
    const result = await runCli(
      ["docs", "register", "../../etc/passwd", "--description", "evil"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("worktree");
  });
});

describe("cctl docs list", () => {
  it("lists documents and ends with the exact register/delete hint", async () => {
    const host = makeHost(() => jsonResponse([sampleDoc]));
    const result = await runCli(["docs", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("GET");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/reference-documents",
    );
    expect(result.stdout).toContain("docs/a.md");
    expect(result.stdout.endsWith(`hint: ${DOCS_LIST_HINT}\n`)).toBe(true);
  });

  it("carries the hint in the reserved --json envelope field", async () => {
    const host = makeHost(() => jsonResponse([sampleDoc]));
    const result = await runCli(["docs", "list", "--json"], baseEnv, host);

    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.hint).toBe(DOCS_LIST_HINT);
    expect(envelope.documents).toHaveLength(1);
    expect(envelope.documents[0].filePath).toBe("docs/a.md");
  });

  it("handles an empty list and still ends with the hint", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(["docs", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith(`hint: ${DOCS_LIST_HINT}\n`)).toBe(true);
  });
});

describe("cctl docs delete", () => {
  it("DELETEs by id and exits 0 with no hint", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, document: sampleDoc }),
    );
    const result = await runCli(["docs", "delete", "doc-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("DELETE");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/reference-documents/doc-1",
    );
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 2 when the id argument is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["docs", "delete"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the server reports the document is unknown (404)", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: 'Document "nope" not found' }, 404),
    );
    const result = await runCli(["docs", "delete", "nope"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });
});

describe("cctl docs (dispatch)", () => {
  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["docs", "frobnicate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401));
    const result = await runCli(["docs", "list"], baseEnv, host);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });
});
