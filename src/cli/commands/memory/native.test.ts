import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import type { MemoryNote } from "@/lib/memory/schemas";
import type { CliHost, FetchInit } from "../../transport";
import { createCommandCenterCli } from "../../framework/application";

const env = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "token",
  CC_PROJECT: "project-one",
  CC_CONVERSATION_ID: "conversation-one",
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
};
const note: MemoryNote = {
  id: "internal-memory-id",
  slug: "literal-shell-prose",
  scope: "project",
  projectPath: "/repo/project-one",
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "Pass literal prose through a file",
  body: "Use --body-file.",
  statusNote: null,
  aliases: [],
  indexMode: "auto",
  lifecycle: "active",
  reviewAfter: null,
  expiresAt: null,
  supersedesId: null,
  supersededById: null,
  createdBy: "agent",
  authorConversationId: "conversation-one",
  revision: 3,
  createdAt: "2026-09-17T12:00:00Z",
  updatedAt: "2026-09-17T12:00:00Z",
};
const link = {
  id: "link-one",
  memoryId: note.id,
  kind: "about",
  artifact: { kind: "ticket", ticketId: "ticket-one" },
  createdAt: note.createdAt,
};

function fixture(
  response: unknown,
  status = 200,
  files: Record<string, string> = {},
) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      return new Response(JSON.stringify(response), {
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
  const runtimeHost = createTestHost({
    files: { "/artifacts/.keep": "", ...files },
  });
  return {
    requests,
    runtimeHost,
    run: (argv: string[], format: "json" | "text" = "json") =>
      runForTest(
        createCommandCenterCli(host, {
          artifacts: { directory: "/artifacts", forbiddenRoots: [] },
        }),
        ["memory", ...argv],
        { host: runtimeHost, format, env },
      ),
  };
}

describe("native memory commands", () => {
  it("creates a note with prose, aliases, and server-owned scope attribution", async () => {
    const body = "Literal `ticks` and $VARIABLE\nkeep their bytes.";
    const test = fixture(
      { note, advisories: { overlapCandidates: [], hookWarnings: [] } },
      201,
    );
    const result = await test.run([
      "create",
      "--hook",
      note.hook,
      "--body",
      body,
      "--alias",
      "first",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      env.CC_CONVERSATION_ID,
    );
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      scope: "project",
      kind: "lesson",
      hook: note.hook,
      body,
      aliases: ["first"],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { note } },
    });
    const text = await test.run(["create", "--hook", note.hook], "text");
    expect(text.stdout).toContain(note.slug);
    expect(text.stdout).not.toContain(note.id);
  });

  it("updates only supplied fields with the observed revision", async () => {
    const test = fixture({ note });
    const result = await test.run([
      "update",
      note.slug,
      "--if-revision",
      "3",
      "--scope",
      "project",
      "--status-note",
      "none",
      "--expires-at",
      "none",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      `http://cc.test/api/memory/notes/${note.slug}?scope=project`,
    );
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      baseRevision: 3,
      statusNote: null,
      expiresAt: null,
    });
  });

  it.each([
    {
      argv: ["get", note.slug, "--scope", "project"],
      response: {
        note,
        links: [link],
        lineage: { supersedes: null, supersededBy: null },
      },
      path: `/api/memory/notes/${note.slug}?scope=project`,
      method: "GET",
    },
    {
      argv: ["list", "--scope", "project"],
      response: { notes: [note] },
      path: "/api/memory/notes?scope=project",
      method: "GET",
    },
    {
      argv: ["link", note.slug, "--artifact", "ticket:42"],
      response: { link, note },
      path: `/api/memory/notes/${note.slug}/links`,
      method: "POST",
    },
    {
      argv: ["unlink", note.slug, "--artifact", "ticket:42"],
      response: { link, note },
      path: `/api/memory/notes/${note.slug}/links`,
      method: "DELETE",
    },
    {
      argv: ["mark-reviewed", note.slug, "--status", "--if-revision", "3"],
      response: { note, statusReLease: null },
      path: `/api/memory/notes/${note.slug}/reviewed`,
      method: "POST",
    },
    {
      argv: [
        "observe-rederivation",
        note.slug,
        "--artifact",
        "execution:run-one",
      ],
      response: {
        observed: {
          memoryId: note.id,
          slug: note.slug,
          conversationId: "conversation-one",
          executionId: "run-one",
          contextId: null,
        },
      },
      path: `/api/memory/notes/${note.slug}/rederived`,
      method: "POST",
    },
    {
      argv: ["promote", note.slug, "--if-revision", "3"],
      response: {
        promoted: note,
        superseded: { ...note, slug: "session-lesson" },
      },
      path: `/api/memory/notes/${note.slug}/promote`,
      method: "POST",
    },
    {
      argv: ["review", "--project-candidates", "--promotable"],
      response: { entries: [] },
      path: "/api/memory/review?projectCandidates=true&promotionCandidates=true",
      method: "GET",
    },
    {
      argv: ["archive", note.slug, "--if-revision", "3"],
      response: { note },
      path: `/api/memory/notes/${note.slug}/archive`,
      method: "POST",
    },
    {
      argv: ["delete", note.slug, "--confirm"],
      response: { note },
      path: `/api/memory/notes/${note.slug}`,
      method: "DELETE",
    },
  ])(
    "executes $argv using the production domain transport",
    async ({ argv, response, path, method }) => {
      const test = fixture(response);
      const result = await test.run(argv);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.url).toBe(`http://cc.test${path}`);
      expect(test.requests[0]?.init.method).toBe(method);
      expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
        env.CC_CONVERSATION_ID,
      );
    },
  );

  it("retains the server's bounded recall pack and narrowing information", async () => {
    const pack = {
      mode: "query",
      text: "1 of 2 notes: literal-shell-prose",
      showing: 1,
      total: 2,
      narrowCommand: "cctl memory recall --scope project",
      entries: [
        {
          note,
          tier: "hook",
          statusLine: null,
          readCommand: `cctl memory get ${note.slug}`,
        },
      ],
    };
    const test = fixture({ pack });
    const result = await test.run([
      "recall",
      "shell quoting",
      "--budget",
      "600",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      query: "shell quoting",
      budgetChars: 600,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          pack: {
            text: pack.text,
            showing: 1,
            total: 2,
            narrowCommand: pack.narrowCommand,
          },
        },
      },
    });
  });

  it("retains exact index text as domain data and targets the current conversation", async () => {
    const block = {
      text: "<memory-index>\nexact block\n</memory-index>",
      bytes: 44,
      omitted: 0,
      total: 0,
      withheld: { reviewDue: 0, expired: 0, proposed: 0 },
      entries: [],
    };
    const test = fixture({ mode: "full", block });
    const result = await test.run(["index", "--full"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/memory/index?conversation=conversation-one&full=true",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { block } },
    });
  });

  it("exports the server's archive text without serializing the surrounding response", async () => {
    const archive = "---\narchive: command-center-memory\n---\n";
    const test = fixture({
      archive,
      noteCount: 1,
      generatedAt: note.createdAt,
    });
    const result = await test.run([
      "export",
      "--scope",
      "project",
      "--out",
      "/artifacts/memory.md",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      new TextDecoder().decode(
        test.runtimeHost.filesSnapshot()["/artifacts/memory.md"],
      ),
    ).toBe(archive);
  });

  it("keeps destructive confirmation and no-change writes local", async () => {
    const test = fixture({ note });
    expect((await test.run(["delete", note.slug])).exitCode).toBe(2);
    expect(
      (await test.run(["update", note.slug, "--if-revision", "3"])).exitCode,
    ).toBe(2);
    expect(test.requests).toHaveLength(0);
  });

  it("preserves ambiguity recovery for long literal prose within the diagnostic budget", async () => {
    const body = "Literal `ticks` and $VARIABLE " + "é".repeat(2000);
    const test = fixture(
      {
        error: "The slug exists in multiple scopes.",
        code: "ambiguous_handle",
        details: {
          candidates: [
            { slug: note.slug, scope: "project", lifecycle: "active" },
            { slug: note.slug, scope: "session", lifecycle: "active" },
          ],
        },
      },
      409,
    );
    const result = await test.run([
      "update",
      note.slug,
      "--if-revision",
      "3",
      "--body",
      body,
    ]);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      error: {
        code: "CC_OPERATION_FAILED",
        details: { serverCode: "ambiguous_handle" },
      },
    });
    expect(result.stdout).toContain("--scope=project");
    expect(result.stdout).toContain("$VARIABLE");
  });

  it.each(["inline", "file"])(
    "keeps multiline %s prose recoverable after scope refusal",
    async (source) => {
      const body = "Literal `ticks` and $VARIABLE\nkeep the second line.";
      const test = fixture(
        {
          error: "The slug exists in multiple scopes.",
          code: "ambiguous_handle",
          details: {
            candidates: [
              { slug: note.slug, scope: "project", lifecycle: "active" },
            ],
          },
        },
        409,
        { "/input/body.md": body },
      );
      const result = await test.run([
        "update",
        note.slug,
        "--if-revision",
        "3",
        ...(source === "file"
          ? ["--body-file", "/input/body.md"]
          : ["--body", body]),
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "not_applied",
        error: {
          code: "CC_OPERATION_FAILED",
          details: { serverCode: "ambiguous_handle" },
        },
      });
      expect(result.stdout).toContain("--scope=project");
      expect(result.stdout).toContain(
        source === "file"
          ? "--body-file=/input/body.md"
          : "Repeat the original command",
      );
    },
  );

  it("preserves the authoritative memory policy instruction and never widens scope locally", async () => {
    const test = fixture(
      {
        error: "Contribution is disabled",
        code: "policy_refused",
        instruction: "Use the Memory Library to change this policy.",
        rationale: "Validators remain independent.",
        details: { role: "validator" },
      },
      403,
    );
    const result = await test.run(["create", "--hook", note.hook]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Use the Memory Library to change this policy.",
      error: {
        why: "Validators remain independent.",
        details: { serverCode: "policy_refused" },
      },
    });
  });
});
