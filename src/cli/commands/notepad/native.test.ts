import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import type { CliHost, FetchInit } from "../../transport";
import { createCommandCenterCli } from "../../framework/application";

const env = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "test-token",
  CC_PROJECT: "project-one",
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
  CC_CONVERSATION_ID: "conversation-one",
};
const notepad = {
  id: "notepad-one",
  scope: "project",
  projectPath: "/repos/project-one",
  name: "Migration notes",
  content: '# Migration\n\n<spec-ref spec-slug="cli" />\n[Image: image-one]',
  revision: 4,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-09-17T12:00:00Z",
  updatedAt: "2026-09-17T12:00:00Z",
};
const reply = {
  id: "reply-one",
  commentId: "comment-one",
  body: "Updated the quoted paragraph.",
  authorKind: "agent",
  authorConversationId: env.CC_CONVERSATION_ID,
  createdAt: "2026-09-17T12:00:00Z",
};
const thread = {
  comment: {
    id: "comment-one",
    notepadId: notepad.id,
    anchor: {
      sectionId: "migration",
      headingLabel: "Migration",
      line: 3,
      charStart: 0,
      charEnd: 7,
      quote: "Old API",
      prefix: "",
      suffix: "",
      notepadRevision: 2,
    },
    body: "Clarify the new API.\nInclude an example.",
    status: "open",
    authorKind: "user",
    authorConversationId: null,
    createdAt: "2026-09-17T12:00:00Z",
    updatedAt: "2026-09-17T12:00:00Z",
    resolvedAt: null,
  },
  replies: [reply],
  passage: { quote: "Old API", location: "Migration, line 3", state: "stale" },
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
  const runtimeHost = createTestHost({
    files: { "/artifacts/.keep": "" },
  });
  return {
    requests,
    runtimeHost,
    run: (argv: string[], format: "json" | "text" = "json", overrides = {}) =>
      runForTest(
        createCommandCenterCli(host, {
          artifacts: { directory: "/artifacts", forbiddenRoots: [] },
        }),
        argv,
        {
          host: runtimeHost,
          format,
          env: { ...env, ...overrides },
        },
      ),
  };
}

describe("native notepad commands", () => {
  it("reads canonical content and metadata at project conversation scope", async () => {
    const test = fixture({ notepad });
    const result = await test.run(["notepad", "get", notepad.id], "text");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(notepad.content);
    expect(result.stdout).toContain("revision: 4");
    expect(result.stdout).toContain("write-mode: full-edit");
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/notepads/notepad-one",
    );
  });

  it("bounds a scoped list and preserves its scope in the exact reveal invocation", async () => {
    const { content: _content, ...metadata } = notepad;
    const items = Array.from({ length: 3 }, (_, index) => ({
      ...metadata,
      id: `notepad-${index}`,
      projectName: "project-one",
    }));
    const test = fixture({ notepads: items });
    const result = await test.run([
      "notepad",
      "list",
      "--limit",
      "1",
      "--archived",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          notepads: [{ id: "notepad-0" }],
          omission: {
            returned: 1,
            total: { kind: "known", count: 3 },
            truncated: true,
            reveal: {
              path: "notepad list",
              flags: { project: "project-one", limit: 3, archived: true },
            },
          },
        },
      },
    });
    expect(
      new URL(test.requests[0]?.url ?? "").searchParams.get("project"),
    ).toBe("project-one");
    expect(
      new URL(test.requests[0]?.url ?? "").searchParams.get("archived"),
    ).toBe("true");
  });

  it("creates a global notepad with caller attribution", async () => {
    const content = 'Literal `code`, $VARIABLE, "quotes"\nand a newline.';
    const created = { ...notepad, scope: "global", projectPath: null, content };
    const test = fixture({ notepad: created }, 201);
    const result = await test.run([
      "notepad",
      "create",
      "--global",
      "--name",
      "Migration notes",
      "--content",
      content,
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      scope: "global",
      name: "Migration notes",
      content,
    });
    expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      env.CC_CONVERSATION_ID,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ kind: "notepad", id: notepad.id }] },
    });
  });

  it.each(["update", "append"])(
    "%s sends the exact base revision and caller attribution",
    async (operation) => {
      const test = fixture({ notepad: { ...notepad, revision: 5 } });
      const result = await test.run([
        "notepad",
        operation,
        notepad.id,
        "--if-revision",
        "4",
        "--content",
        "New content",
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests[0]?.url).toBe(
        "http://cc.test/api/notepads/notepad-one/content",
      );
      expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
        operation,
        baseRevision: 4,
        content: "New content",
      });
      expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
        env.CC_CONVERSATION_ID,
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: { data: { notepad: { revision: 5 } } },
      });
    },
  );

  it("renders the full comment, stale quoted passage, and its attributed replies", async () => {
    const test = fixture({ comments: [thread] });
    const result = await test.run(
      ["notepad", "comment", "list", notepad.id, "--status", "open"],
      "text",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("comment-one  open  stale");
    expect(result.stdout).toContain("Old API");
    expect(result.stdout).toContain("Include an example.");
    expect(result.stdout).toContain(reply.body);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/notepads/notepad-one/comments?status=open",
    );
  });

  it("posts a comment reply without a content revision or status mutation", async () => {
    const test = fixture({ reply }, 201);
    const result = await test.run([
      "notepad",
      "comment",
      "reply",
      notepad.id,
      reply.commentId,
      "--body",
      reply.body,
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests[0]?.url).toBe(
      "http://cc.test/api/notepads/notepad-one/comments/comment-one/replies",
    );
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      body: reply.body,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      recovery: {
        references: [{ kind: "notepad-comment-reply", id: reply.id }],
      },
    });
  });

  it("preserves stale-write instructions, rationale and server details", async () => {
    const test = fixture(
      {
        error: "The notepad changed since it was read.",
        code: "stale_revision",
        rationale: "The revision check preserves the other writer's changes.",
        instruction: "Read the notepad again before retrying.",
        details: { currentRevision: 5, notepadId: notepad.id },
      },
      409,
    );
    const result = await test.run([
      "notepad",
      "update",
      notepad.id,
      "--if-revision",
      "4",
      "--content",
      "new",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Read the notepad again before retrying.",
      error: {
        why: "The revision check preserves the other writer's changes.",
        details: {
          serverCode: "stale_revision",
          serverDetails: { currentRevision: 5 },
        },
      },
    });
  });

  it("leaves mutation effects unknown when a successful response cannot identify the created notepad", async () => {
    const result = await fixture({ notepad: {} }, 201).run([
      "notepad",
      "create",
      "--name",
      "New notes",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "unknown",
      error: { code: "CC_INVALID_RESPONSE" },
    });
    expect(result.stdout).not.toContain('"kind":"notepad"');
  });

  it("offers no agent verbs for changing write mode or resolving user comments", async () => {
    const test = fixture({ notepad });
    expect((await test.run(["notepad", "delete", notepad.id])).exitCode).toBe(
      2,
    );
    expect(
      (
        await test.run([
          "notepad",
          "comment",
          "resolve",
          notepad.id,
          "comment-one",
        ])
      ).exitCode,
    ).toBe(2);
    expect(test.requests).toHaveLength(0);
  });
});
