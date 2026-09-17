import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import type { CliHost, FetchInit } from "../../transport";
import { createCommandCenterCli } from "../../framework/application";

const env = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "test-token",
  CC_PROJECT: "project-one",
  CC_SESSION: "session-one",
};
const document = {
  id: "doc-one",
  filePath: "docs/design.md",
  description: "Read before changing the API",
  createdAt: "2026-09-17T12:00:00Z",
};

function fixture(body: unknown, status = 200) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
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
  return {
    requests,
    run: (argv: string[], format: "json" | "text" = "json", overrides = {}) =>
      runForTest(
        createCommandCenterCli(host, {
          artifacts: { directory: "/artifacts", forbiddenRoots: [] },
        }),
        argv,
        {
          host: createTestHost({ files: { "/artifacts/.keep": "" } }),
          format,
          env: { ...env, ...overrides },
        },
      ),
  };
}

describe("native docs commands", () => {
  it("registers the supplied document and reports its actual recovery id", async () => {
    const test = fixture({ document });
    const result = await test.run([
      "docs",
      "register",
      document.filePath,
      "--description",
      document.description,
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      effect: "applied",
      payload: { kind: "inline", data: { document } },
      recovery: {
        references: [{ kind: "reference-document", id: document.id }],
      },
    });
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/reference-documents",
    );
    expect(test.requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      filePath: document.filePath,
      description: document.description,
    });
  });

  it("renders actual document rows from a list response", async () => {
    const test = fixture([document]);
    const result = await test.run(["docs", "list"], "text");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${document.id}  ${document.filePath}`);
    expect(result.stdout).toContain(document.description);
    expect(test.requests[0]?.init.method).toBe("GET");
  });

  it("deletes the addressed document and reports the addressed recovery id", async () => {
    const test = fixture({ ok: true });
    const result = await test.run(["docs", "delete", "doc/one"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toContain("reference-documents/doc%2Fone");
    expect(test.requests[0]?.init.method).toBe("DELETE");
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ kind: "reference-document", id: "doc/one" }] },
    });
  });

  it("refuses missing session identity before sending a request", async () => {
    const test = fixture({ document });
    const result = await test.run(["docs", "list"], "json", { CC_SESSION: "" });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("no session");
    expect(test.requests).toHaveLength(0);
  });

  it("reports malformed successful responses without inventing a registration id", async () => {
    const test = fixture({ document: { filePath: document.filePath } });
    const result = await test.run([
      "docs",
      "register",
      document.filePath,
      "--description",
      document.description,
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      effect: "unknown",
      error: { code: "CC_INVALID_RESPONSE" },
    });
    expect(result.stdout).not.toContain('"kind":"reference-document"');
  });

  it("does not turn a malformed list into a successful empty list", async () => {
    const result = await fixture({ unexpected: [] }).run(["docs", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("CC_INVALID_RESPONSE");
  });

  it("preserves a server refusal instruction and structured issue", async () => {
    const result = await fixture(
      {
        error: "The document is outside the session worktree",
        instruction: "Register a path inside this session worktree.",
        issues: [{ path: "filePath", message: "path escapes the worktree" }],
      },
      400,
    ).run(["docs", "register", "../escape", "--description", "test"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Register a path inside this session worktree.",
      error: { issues: [{ message: "path escapes the worktree" }] },
    });
  });
});
