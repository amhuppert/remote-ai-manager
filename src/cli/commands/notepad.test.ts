import { describe, expect, it } from "vitest";
import { shellWords } from "@/lib/shared/testing/shell-words";
import { runCli } from "../core";
import type { CliEnv, CliHost, CliResult, FetchInit } from "../shared";

/**
 * Unit layer for `cctl notepad`: the real dispatch and flag parsing against a
 * fake CLI host, so every deterministic refusal is proven to happen BEFORE a
 * request and every accepted invocation is proven to build the path, query, and
 * headers the notepad routes read. Behavior against real persistence is the
 * contract test's job.
 */

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_ID: "conv-1",
};

const NOTEPAD_ID = "6f1c2b7e-2f5a-4a1e-9a0b-3d2c8f4e5a6b";

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
): CliHost & { requests: RecordedRequest[]; written: Record<string, string> } {
  const requests: RecordedRequest[] = [];
  const written: Record<string, string> = {};
  return {
    requests,
    written,
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
    async writeTextFile(filePath, contents) {
      written[filePath] = contents;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

function firstRequest(host: { requests: RecordedRequest[] }): RecordedRequest {
  const first = host.requests[0];
  if (first === undefined) throw new Error("expected a request, found none");
  return first;
}

function bodyOf(request: RecordedRequest): Record<string, unknown> {
  const raw = request.init.body;
  if (raw === undefined) throw new Error("expected a request body, found none");
  return JSON.parse(raw) as Record<string, unknown>;
}

const sampleNotepad = {
  id: NOTEPAD_ID,
  scope: "project",
  projectPath: "/repos/cc",
  name: "Migration notes",
  content: '# Migration notes\n\n<spec-ref spec-slug="notepad" />',
  revision: 4,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

const sampleListItem = {
  id: NOTEPAD_ID,
  scope: "project",
  projectPath: "/repos/cc",
  projectName: "cc",
  name: "Migration notes",
  revision: 4,
  writeMode: "full-edit",
  pinned: true,
  archived: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

describe("cctl notepad dispatch", () => {
  it("exits 2 naming the subcommands when none is given", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["notepad"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("subcommand");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown subcommand before any network call", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["notepad", "rename"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown notepad subcommand "rename"');
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown flag before any network call", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["notepad", "get", NOTEPAD_ID, "--frob", "x"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown flag "--frob"');
    expect(host.requests).toHaveLength(0);
  });
});

/** A bounded list of 3 rows capped at 2, scoped to `project`. */
async function listWithProject(project: string): Promise<CliResult> {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    ...sampleListItem,
    id: `notepad-${index}`,
    name: `Notepad ${index}`,
  }));
  const host = makeHost(() => jsonResponse({ notepads: rows }));
  return runCli(
    ["notepad", "list", "--limit", "2", "--json"],
    { ...baseEnv, CC_PROJECT: project },
    host,
  );
}

/**
 * The project a printed reveal command actually reaches: the string is taken
 * through a REAL shell, and the argv that survives is run back through the CLI
 * from a DIFFERENT ambient project. The answer is the `project` query the second
 * run sends — which is the only thing that decides whose rows come back.
 */
async function projectRevealReaches(reveal: string): Promise<string | null> {
  const words = shellWords(reveal);
  expect(words[0]).toBe("cctl");
  const host = makeHost(() => jsonResponse({ notepads: [] }));
  const result = await runCli(
    [...words.slice(1), "--json"],
    { ...baseEnv, CC_PROJECT: "some-unrelated-project" },
    host,
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return new URL(firstRequest(host).url).searchParams.get("project");
}

describe("cctl notepad list", () => {
  it("merges the ambient project with the global scope by default", async () => {
    const host = makeHost(() => jsonResponse({ notepads: [sampleListItem] }));
    const result = await runCli(["notepad", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const { url, init } = firstRequest(host);
    expect(init.method).toBe("GET");
    expect(new URL(url).pathname).toBe("/api/notepads");
    expect(new URL(url).searchParams.get("project")).toBe("cc");
    expect(new URL(url).searchParams.get("scope")).toBeNull();
    expect(result.stdout).toContain(NOTEPAD_ID);
    expect(result.stdout).toContain("Migration notes");
    expect(result.stdout).toContain("project(cc)");
  });

  it("narrows to the global scope with --global and asks for archived rows", async () => {
    const host = makeHost(() => jsonResponse({ notepads: [] }));
    await runCli(["notepad", "list", "--global", "--archived"], baseEnv, host);

    const params = new URL(firstRequest(host).url).searchParams;
    expect(params.get("scope")).toBe("global");
    expect(params.get("project")).toBeNull();
    expect(params.get("archived")).toBe("true");
  });

  it("bounds rows and names a filter-preserving reveal command", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...sampleListItem,
      id: `notepad-${index}`,
      name: `Notepad ${index}`,
    }));
    const host = makeHost(() => jsonResponse({ notepads: rows }));
    const result = await runCli(
      ["notepad", "list", "--archived", "--limit", "2", "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout);
    expect(envelope.total).toBe(3);
    expect(envelope.returned).toBe(2);
    expect(envelope.truncated).toBe(true);
    expect(envelope.reveal).toBe(
      "cctl notepad list --project cc --archived --limit 3",
    );
    expect(envelope.notepads).toHaveLength(2);
  });

  it("pins the listed project in the reveal command, not the ambient one", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...sampleListItem,
      id: `notepad-${index}`,
      name: `Notepad ${index}`,
    }));
    const host = makeHost(() => jsonResponse({ notepads: rows }));
    const result = await runCli(
      ["notepad", "list", "--project", "beta", "--limit", "2", "--json"],
      { ...baseEnv, CC_PROJECT: "alpha" },
      host,
    );

    expect(new URL(firstRequest(host).url).searchParams.get("project")).toBe(
      "beta",
    );
    // The reveal has to name the project whose rows were bounded away: run from
    // any other ambient scope it would otherwise disclose a different project's
    // notepads.
    expect(JSON.parse(result.stdout).reveal).toBe(
      "cctl notepad list --project beta --limit 3",
    );
  });

  it("quotes a project name the shell would otherwise split", async () => {
    const result = await listWithProject("My Repo");

    // A project name is a directory basename, so it can carry spaces. Unquoted,
    // the reveal would parse as `--project My` and disclose nothing.
    expect(JSON.parse(result.stdout).reveal).toBe(
      "cctl notepad list --project 'My Repo' --limit 3",
    );
  });

  /**
   * The reveal is a command a caller PASTES INTO A SHELL, so the assertion that
   * means anything is where the pasted command actually lands. A name is a
   * directory basename and the project resolver restricts no character, so every
   * case here is a legal project — and each is a way a reveal can quietly list
   * the wrong project, or fail to run at all.
   */
  it.each([
    ["My Repo", "a space the shell would word-split"],
    ["team$prod", "a variable the shell would expand"],
    ["team${prod}", "a braced variable the shell would expand"],
    ["repo`whoami`", "a command substitution the shell would run"],
    ["repo$(whoami)", "a modern command substitution"],
    ["back\\slash", "a backslash the shell would consume"],
    ["it's-mine", "an apostrophe that would close a single quote"],
    ["repo*glob?", "glob characters the shell would expand"],
    ['say"hi"', "double quotes"],
    ["a&b|c;d", "control operators that would end the command"],
    ["--team", "a name the CLI would read as a flag"],
    ["-t", "a short-flag-shaped name"],
    ["--team prod", "a flag-shaped name that also needs quoting"],
    ["--json", "a name colliding with a real global flag"],
  ])("reveals %j (%s) back to the same project", async (project) => {
    const result = await listWithProject(project);
    const reveal = String(JSON.parse(result.stdout).reveal);

    expect(await projectRevealReaches(reveal)).toBe(project);
  });

  it("reveals the global scope without a project selector", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...sampleListItem,
      id: `notepad-${index}`,
      scope: "global",
      projectPath: null,
      projectName: null,
    }));
    const host = makeHost(() => jsonResponse({ notepads: rows }));
    const result = await runCli(
      ["notepad", "list", "--global", "--limit", "2", "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).reveal).toBe(
      "cctl notepad list --global --limit 3",
    );
  });

  it("rejects a non-positive --limit before any network call", async () => {
    const host = makeHost(() => jsonResponse({ notepads: [] }));
    const result = await runCli(
      ["notepad", "list", "--limit", "0"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl notepad get", () => {
  it("prints the canonical content with its reference XML intact", async () => {
    const host = makeHost(() => jsonResponse({ notepad: sampleNotepad }));
    const result = await runCli(["notepad", "get", NOTEPAD_ID], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(new URL(firstRequest(host).url).pathname).toBe(
      `/api/notepads/${NOTEPAD_ID}`,
    );
    expect(result.stdout).toContain('<spec-ref spec-slug="notepad" />');
    expect(result.stdout).toContain("revision: 4");
    expect(result.stdout).toContain("write-mode: full-edit");
  });

  it("writes an artifact receipt instead of truncating oversized content", async () => {
    const big = "x".repeat(80_000);
    const host = makeHost(() =>
      jsonResponse({ notepad: { ...sampleNotepad, content: big } }),
    );
    const result = await runCli(["notepad", "get", NOTEPAD_ID], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(big);
    expect(result.stdout).toContain("artifact: .cc/temp/");
    expect(result.stdout).toContain("format: markdown");
    expect(result.stdout).toContain("bytes: 80000");
    expect(result.stdout).toMatch(/sha256: sha256:[a-f0-9]{64}/);
    expect(Object.values(host.written)[0]).toBe(big);
  });

  it("requires exactly one notepad id", async () => {
    const host = makeHost(() => jsonResponse({}));
    const missing = await runCli(["notepad", "get"], baseEnv, host);
    expect(missing.exitCode).toBe(2);
    const extra = await runCli(
      ["notepad", "get", NOTEPAD_ID, "other"],
      baseEnv,
      host,
    );
    expect(extra.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl notepad create", () => {
  it("creates in the ambient project scope and attributes the caller", async () => {
    const host = makeHost(() =>
      jsonResponse({ notepad: { ...sampleNotepad, revision: 1 } }, 201),
    );
    const result = await runCli(
      ["notepad", "create", "--name", "Migration notes"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = firstRequest(host);
    expect(request.init.method).toBe("POST");
    expect(bodyOf(request)).toMatchObject({
      scope: "project",
      project: "cc",
      name: "Migration notes",
    });
    expect(request.init.headers["x-cc-conversation-id"]).toBe("conv-1");
    expect(result.stdout).toContain(`created ${NOTEPAD_ID}`);
  });

  it("creates in the global scope with --global and no project", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { notepad: { ...sampleNotepad, scope: "global", projectPath: null } },
        201,
      ),
    );
    await runCli(
      ["notepad", "create", "--name", "Standing context", "--global"],
      baseEnv,
      host,
    );

    const body = bodyOf(firstRequest(host));
    expect(body.scope).toBe("global");
    expect(body.project).toBeUndefined();
  });

  it("reads initial content from --content-file", async () => {
    const host = makeHost(() => jsonResponse({ notepad: sampleNotepad }, 201), {
      "/tmp/seed.md": "# Seeded\n",
    });
    await runCli(
      [
        "notepad",
        "create",
        "--name",
        "Seeded",
        "--content-file",
        "/tmp/seed.md",
      ],
      baseEnv,
      host,
    );

    expect(bodyOf(firstRequest(host))).toMatchObject({ content: "# Seeded" });
  });

  it("requires --name before any network call", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["notepad", "create"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--name");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl notepad update and append", () => {
  for (const operation of ["update", "append"] as const) {
    it(`${operation} posts the operation with its base revision and caller`, async () => {
      const host = makeHost(() =>
        jsonResponse({ notepad: { ...sampleNotepad, revision: 5 } }),
      );
      const result = await runCli(
        [
          "notepad",
          operation,
          NOTEPAD_ID,
          "--if-revision",
          "4",
          "--content",
          "fresh text",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(0);
      const request = firstRequest(host);
      expect(new URL(request.url).pathname).toBe(
        `/api/notepads/${NOTEPAD_ID}/content`,
      );
      expect(request.init.method).toBe("POST");
      expect(bodyOf(request)).toEqual({
        operation,
        content: "fresh text",
        baseRevision: 4,
      });
      expect(request.init.headers["x-cc-conversation-id"]).toBe("conv-1");
      expect(result.stdout).toContain("revision: 5");
    });

    it(`${operation} refuses a missing --if-revision at exit 2 before any request`, async () => {
      const host = makeHost(() => jsonResponse({}));
      const result = await runCli(
        ["notepad", operation, NOTEPAD_ID, "--content", "text"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--if-revision");
      expect(host.requests).toHaveLength(0);
    });

    it(`${operation} refuses a malformed --if-revision at exit 2 before any request`, async () => {
      const host = makeHost(() => jsonResponse({}));
      for (const raw of ["0", "-1", "1.5", "four"]) {
        const result = await runCli(
          [
            "notepad",
            operation,
            NOTEPAD_ID,
            "--if-revision",
            raw,
            "--content",
            "text",
          ],
          baseEnv,
          host,
        );
        expect(result.exitCode, `--if-revision ${raw}`).toBe(2);
      }
      expect(host.requests).toHaveLength(0);
    });

    it(`${operation} requires content before any request`, async () => {
      const host = makeHost(() => jsonResponse({}));
      const result = await runCli(
        ["notepad", operation, NOTEPAD_ID, "--if-revision", "4"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--content");
      expect(host.requests).toHaveLength(0);
    });

    it(`${operation} refuses both --content and --content-file`, async () => {
      const host = makeHost(() => jsonResponse({}), { "/tmp/a.md": "a" });
      const result = await runCli(
        [
          "notepad",
          operation,
          NOTEPAD_ID,
          "--if-revision",
          "4",
          "--content",
          "inline",
          "--content-file",
          "/tmp/a.md",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(2);
      expect(host.requests).toHaveLength(0);
    });
  }
});

describe("cctl notepad comment", () => {
  const COMMENT_ID = "cmt-3f9a";

  it("lists the notepad's comments through the comments route", async () => {
    const host = makeHost(() => jsonResponse({ comments: [] }));
    const result = await runCli(
      ["notepad", "comment", "list", NOTEPAD_ID],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const request = firstRequest(host);
    expect(new URL(request.url).pathname).toBe(
      `/api/notepads/${NOTEPAD_ID}/comments`,
    );
    expect(request.init.method).toBe("GET");
    // A read is not attributed: the header exists to name the writer.
    expect(request.init.headers["x-cc-conversation-id"]).toBeUndefined();
    expect(result.stdout).toContain("comments: 0 total, 0 shown");
  });

  it("passes --status through as the server's own filter", async () => {
    const host = makeHost(() => jsonResponse({ comments: [] }));
    const result = await runCli(
      ["notepad", "comment", "list", NOTEPAD_ID, "--status", "open"],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(new URL(firstRequest(host).url).search).toBe("?status=open");
  });

  it("refuses an unknown --status at exit 2 before any request", async () => {
    const host = makeHost(() => jsonResponse({ comments: [] }));
    const result = await runCli(
      ["notepad", "comment", "list", NOTEPAD_ID, "--status", "settled"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("open or resolved");
    expect(host.requests).toHaveLength(0);
  });

  it("replies to a comment with the caller-conversation attribution", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          reply: {
            id: "reply-1",
            commentId: COMMENT_ID,
            body: "Rewrote it.",
            authorKind: "agent",
            authorConversationId: "conv-1",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        },
        201,
      ),
    );
    const result = await runCli(
      [
        "notepad",
        "comment",
        "reply",
        NOTEPAD_ID,
        COMMENT_ID,
        "--body",
        "Rewrote it.",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const request = firstRequest(host);
    expect(new URL(request.url).pathname).toBe(
      `/api/notepads/${NOTEPAD_ID}/comments/${COMMENT_ID}/replies`,
    );
    expect(request.init.method).toBe("POST");
    expect(bodyOf(request)).toEqual({ body: "Rewrote it." });
    expect(request.init.headers["x-cc-conversation-id"]).toBe("conv-1");
    // No revision token rides along: a reply changes no content, so there is
    // nothing for a compare-and-swap to guard.
    expect(bodyOf(request)).not.toHaveProperty("baseRevision");
    expect(result.stdout).toContain(`replied to ${COMMENT_ID}`);
  });

  it("reads the reply body from a file, like every other prose argument", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          reply: {
            id: "reply-1",
            commentId: COMMENT_ID,
            body: "From a file.",
            authorKind: "agent",
            authorConversationId: "conv-1",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      { "/tmp/reply.md": "From a file." },
    );
    const result = await runCli(
      [
        "notepad",
        "comment",
        "reply",
        NOTEPAD_ID,
        COMMENT_ID,
        "--body-file",
        "/tmp/reply.md",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(bodyOf(firstRequest(host))).toEqual({ body: "From a file." });
  });

  it("refuses a reply with no body, and one missing an id, before any request", async () => {
    const host = makeHost(() => jsonResponse({}));

    const noBody = await runCli(
      ["notepad", "comment", "reply", NOTEPAD_ID, COMMENT_ID],
      baseEnv,
      host,
    );
    expect(noBody.exitCode).toBe(2);
    expect(noBody.stderr).toContain("--body");

    const noCommentId = await runCli(
      ["notepad", "comment", "reply", NOTEPAD_ID, "--body", "text"],
      baseEnv,
      host,
    );
    expect(noCommentId.exitCode).toBe(2);
    expect(noCommentId.stderr).toContain("<commentId>");

    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl notepad response handling", () => {
  it("fails loudly when a success body does not match the notepad contract", async () => {
    const host = makeHost(() => jsonResponse({ notepad: { id: 7 } }));
    const result = await runCli(["notepad", "get", NOTEPAD_ID], baseEnv, host);

    expect(result.exitCode).toBe(1);
    // The failure reports the validation evidence — the paths that refused —
    // rather than asserting build skew, which misleads when builds match
    // (command-center#91). `cctl doctor` is named as the check that separates
    // skew from a genuine server/CLI contract defect.
    expect(result.stderr).toContain("failed this CLI's validation");
    expect(result.stderr).toContain("notepad.id");
    expect(result.stderr).not.toContain("same build as this CLI");
    expect(result.stderr).toContain("cctl doctor");
  });

  it("renders a server refusal with its code and reason", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Notepad missing-id does not exist.",
          code: "not_found",
          rationale: "The notepad was deleted.",
          instruction: "List notepads to find the current id.",
          details: { notepadId: "missing-id" },
        },
        404,
      ),
    );
    const result = await runCli(
      ["notepad", "get", "missing-id"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Notepad missing-id does not exist.");
    expect(result.stderr).toContain("why: The notepad was deleted.");
    expect(result.stderr).toContain("instruction: List notepads");
  });
});
