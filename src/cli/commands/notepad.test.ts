import { describe, expect, it } from "vitest";
import { runCcWithHost } from "../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../transport";

/**
 * Unit layer for `cctl notepad`: commands build the paths, queries, request
 * bodies, and attribution headers the notepad routes read. Behavior against real persistence is the
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

describe("cctl notepad list", () => {
  it("merges the ambient project with the global scope by default", async () => {
    const host = makeHost(() => jsonResponse({ notepads: [sampleListItem] }));
    const result = await runCcWithHost(["notepad", "list"], baseEnv, host);

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
    await runCcWithHost(
      ["notepad", "list", "--global", "--archived"],
      baseEnv,
      host,
    );

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
    const result = await runCcWithHost(
      ["notepad", "list", "--archived", "--limit", "2", "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.omission.total.count).toBe(3);
    expect(envelope.payload.data.omission.returned).toBe(2);
    expect(envelope.payload.data.omission.truncated).toBe(true);
    expect(envelope.payload.data.revealCommand).toBe(
      "cctl notepad list --project=cc --limit=3 --archived",
    );
    expect(envelope.payload.data.notepads).toHaveLength(2);
  });

  it("pins the listed project in the reveal command, not the ambient one", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...sampleListItem,
      id: `notepad-${index}`,
      name: `Notepad ${index}`,
    }));
    const host = makeHost(() => jsonResponse({ notepads: rows }));
    const result = await runCcWithHost(
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
    expect(JSON.parse(result.stdout).payload.data.revealCommand).toBe(
      "cctl notepad list --project=beta --limit=3",
    );
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
    const result = await runCcWithHost(
      ["notepad", "list", "--global", "--limit", "2", "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).payload.data.revealCommand).toBe(
      "cctl notepad list --limit=3 --global",
    );
  });
});

describe("cctl notepad get", () => {
  it("prints the canonical content with its reference XML intact", async () => {
    const host = makeHost(() => jsonResponse({ notepad: sampleNotepad }));
    const result = await runCcWithHost(
      ["notepad", "get", NOTEPAD_ID],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(firstRequest(host).url).pathname).toBe(
      `/api/notepads/${NOTEPAD_ID}`,
    );
    expect(result.stdout).toContain('<spec-ref spec-slug="notepad" />');
    expect(result.stdout).toContain("revision: 4");
    expect(result.stdout).toContain("write-mode: full-edit");
  });
});

describe("cctl notepad create", () => {
  it("creates in the ambient project scope and attributes the caller", async () => {
    const host = makeHost(() =>
      jsonResponse({ notepad: { ...sampleNotepad, revision: 1 } }, 201),
    );
    const result = await runCcWithHost(
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
    await runCcWithHost(
      ["notepad", "create", "--name", "Standing context", "--global"],
      baseEnv,
      host,
    );

    const body = bodyOf(firstRequest(host));
    expect(body.scope).toBe("global");
    expect(body.project).toBeUndefined();
  });
});

describe("cctl notepad update and append", () => {
  for (const operation of ["update", "append"] as const) {
    it(`${operation} posts the operation with its base revision and caller`, async () => {
      const host = makeHost(() =>
        jsonResponse({ notepad: { ...sampleNotepad, revision: 5 } }),
      );
      const result = await runCcWithHost(
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
  }
});

describe("cctl notepad comment", () => {
  const COMMENT_ID = "cmt-3f9a";

  it("lists the notepad's comments through the comments route", async () => {
    const host = makeHost(() => jsonResponse({ comments: [] }));
    const result = await runCcWithHost(
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
    const result = await runCcWithHost(
      ["notepad", "comment", "list", NOTEPAD_ID, "--status", "open"],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(new URL(firstRequest(host).url).search).toBe("?status=open");
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
    const result = await runCcWithHost(
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
});

describe("cctl notepad response handling", () => {
  it("fails loudly when a success body does not match the notepad contract", async () => {
    const host = makeHost(() => jsonResponse({ notepad: { id: 7 } }));
    const result = await runCcWithHost(
      ["notepad", "get", NOTEPAD_ID],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    // The failure reports the validation evidence — the paths that refused —
    // rather than asserting build skew, which misleads when builds match
    // (command-center#91).
    expect(result.stderr).toContain("CC_INVALID_RESPONSE");
    expect(result.stderr).toContain('["notepad","id"]');
    expect(result.stderr).not.toContain("same build as this CLI");
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
    const result = await runCcWithHost(
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
