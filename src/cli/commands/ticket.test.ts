import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function firstOf<T>(items: readonly T[], label: string): T {
  const first = items[0];
  if (first === undefined) {
    throw new Error(`expected at least one recorded ${label}, found none`);
  }
  return first;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  respond: (req: RecordedRequest) => Response,
  files: Record<string, Uint8Array<ArrayBuffer>> = {},
  textFiles: Record<string, string> = {},
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
      return textFiles[filePath] ?? null;
    },
    async readFileBytes(filePath) {
      return files[filePath] ?? null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const sampleDetail = {
  id: "ticket-1",
  projectPath: "/repos/cc",
  projectName: "cc",
  number: 12,
  title: "Fix the flaky gate",
  description: "It fails on Tuesdays.",
  workType: "bug",
  status: "not_started",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  attachments: [],
  sessions: [],
  relationships: [],
  statusUpdates: { total: 0, recent: [] },
};

const sampleListItem = {
  id: "ticket-1",
  projectPath: "/repos/cc",
  projectName: "cc",
  number: 12,
  title: "Fix the flaky gate",
  workType: "bug",
  status: "not_started",
  attachmentCount: 0,
  activeSessionName: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const sampleRelationship = {
  id: "rel-1",
  role: "depends_on",
  otherTicket: {
    id: "ticket-2",
    projectName: "other",
    number: 7,
    title: "Ship the prerequisite",
    status: "in_progress",
  },
  description: "API contract first",
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-03T00:00:00Z",
};

const sampleStatusUpdate = {
  id: "update-1",
  ticketId: "ticket-1",
  bodyMarkdown: "Implemented the first slice.",
  author: {
    kind: "agent",
    conversationId: "conversation-1",
    conversationName: "Ticket work",
    projectName: "cc",
    scope: "session",
    sessionName: "ticket-work",
    backend: "codex",
    redactedProfileSnapshot: null,
  },
  createdAt: "2026-01-04T00:00:00Z",
};

describe("cctl ticket dispatch", () => {
  it("exits 2 naming the subcommands when none is given", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["ticket"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("subcommand");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown subcommand before any network call", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["ticket", "frob"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown ticket subcommand "frob"');
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown flag before any network call", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "get", "12", "--frob", "x"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown flag "--frob"');
    expect(host.requests).toHaveLength(0);
  });

  it("rejects an unsafe bare ticket number before any network call", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(
      ["ticket", "get", "9007199254740993"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid ticket reference");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl ticket create", () => {
  it("exits 2 before any network call when --title is missing", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(
      ["ticket", "create", "--type", "bug"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--title");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 before any network call when --type is missing", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(
      ["ticket", "create", "--title", "Fix"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--type");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 naming the allowed work types on an invalid --type", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(
      ["ticket", "create", "--title", "Fix", "--type", "chore"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("tech_debt");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a project identity", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(
      ["ticket", "create", "--title", "Fix", "--type", "bug"],
      { CC_SERVER_URL: baseEnv["CC_SERVER_URL"] },
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--project");
    expect(host.requests).toHaveLength(0);
  });

  it("maps a server validation failure to exit 2 with issues in the envelope", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Ticket request validation failed",
          code: "validation_failed",
          issues: [{ path: "title", message: "too short" }],
        },
        400,
      ),
    );
    const result = await runCli(
      ["ticket", "create", "--title", "x", "--type", "bug", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.code).toBe("validation_failed");
    expect(envelope.issues).toEqual([{ path: "title", message: "too short" }]);
  });
});

describe("cctl ticket list", () => {
  it("lists across projects via --all against the global endpoint", async () => {
    const host = makeHost(() => jsonResponse([sampleListItem]));
    const result = await runCli(
      ["ticket", "list", "--all"],
      { CC_SERVER_URL: baseEnv["CC_SERVER_URL"], CC_API_TOKEN: "env-token" },
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]!.url).pathname).toBe("/api/tickets");
  });

  it("exits 2 on an invalid --sort before any network call", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(
      ["ticket", "list", "--sort", "priority"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("states a zero count when no tickets match", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(["ticket", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tickets: 0 total, 0 shown");
  });

  it("fails on a malformed list response instead of reporting no tickets", async () => {
    const host = makeHost(() => jsonResponse({ nope: true }));
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("invalid_response");
  });
});

describe("cctl ticket list — attachment-index enrichment", () => {
  const attachedItem = { ...sampleListItem, attachmentCount: 1 };

  it("exits 3 when the index fetch cannot reach the server", async () => {
    const host = makeHost((req) => {
      if (req.url.includes("/attachments")) throw new Error("ECONNREFUSED");
      return jsonResponse([attachedItem]);
    });
    const result = await runCli(
      ["ticket", "list", "--attachments"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
  });

  it("propagates a structured index-fetch failure instead of rendering an empty index", async () => {
    const host = makeHost((req) =>
      req.url.includes("/attachments")
        ? jsonResponse({ error: "index exploded", code: "index_kaboom" }, 500)
        : jsonResponse([attachedItem]),
    );
    const result = await runCli(
      ["ticket", "list", "--attachments", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("index exploded");
    expect(envelope.code).toBe("index_kaboom");
  });

  it("fails on a malformed index response instead of dropping the entries", async () => {
    const host = makeHost((req) =>
      req.url.includes("/attachments")
        ? jsonResponse({ nope: true })
        : jsonResponse([attachedItem]),
    );
    const result = await runCli(
      ["ticket", "list", "--attachments", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("invalid_response");
    expect(result.stderr).toContain("cc#12");
  });
});

describe("cctl ticket list — bounded default", () => {
  function listItems(count: number, attachmentCount = 0) {
    return Array.from({ length: count }, (_unused, index) => ({
      ...sampleListItem,
      id: `ticket-${index + 1}`,
      number: index + 1,
      attachmentCount,
    }));
  }

  it("leads with the count and caps the rows, naming the exact reveal command", async () => {
    const host = makeHost(() => jsonResponse(listItems(25)));
    const result = await runCli(["ticket", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(
      "tickets: 25 total, 20 shown — rest: cctl ticket list --limit 25",
    );
    expect(result.stdout).toContain("cc#20  ");
    expect(result.stdout).not.toContain("cc#21  ");
  });

  it("carries the same counts and reveal command in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(listItems(25)));
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);

    const envelope = JSON.parse(result.stdout);
    expect(envelope.total).toBe(25);
    expect(envelope.returned).toBe(20);
    expect(envelope.truncated).toBe(true);
    expect(envelope.reveal).toBe("cctl ticket list --limit 25");
    expect(envelope.tickets).toHaveLength(20);
  });

  it("reveals every row through --limit and reports nothing omitted", async () => {
    const host = makeHost(() => jsonResponse(listItems(25)));
    const result = await runCli(
      ["ticket", "list", "--limit", "30", "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout);
    expect(envelope.tickets).toHaveLength(25);
    expect(envelope.truncated).toBe(false);
    expect(envelope.reveal).toBeUndefined();
  });

  it("keeps the filters in effect in the reveal command", async () => {
    const host = makeHost(() => jsonResponse(listItems(25)));
    const result = await runCli(
      [
        "ticket",
        "list",
        "--all",
        "--status",
        "in_progress",
        "--type",
        "bug",
        "--sort",
        "created",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).reveal).toBe(
      "cctl ticket list --all --status in_progress --type bug --sort created --limit 25",
    );
  });

  it("prints the count line when nothing matches", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(["ticket", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tickets: 0 total, 0 shown");
  });

  it("renders attachment counts from the list payload without a request per ticket", async () => {
    const host = makeHost(() => jsonResponse(listItems(3, 2)));
    const result = await runCli(["ticket", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(1);
    expect(result.stdout).toContain("attachments: 2");
  });

  it("fetches the attachment index only for the rows the cap keeps", async () => {
    const host = makeHost((req) =>
      req.url.includes("/attachments")
        ? jsonResponse({
            attachments: [
              sampleAttachment("att-1", { kind: "note", markdown: "m" }),
            ],
          })
        : jsonResponse(listItems(3, 1)),
    );
    const result = await runCli(
      ["ticket", "list", "--attachments", "--limit", "2"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(3);
  });

  it("exits 2 on a non-positive --limit before any network call", async () => {
    const host = makeHost(() => jsonResponse(listItems(3)));
    const result = await runCli(
      ["ticket", "list", "--limit", "0"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--limit");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl ticket get — identifier forms", () => {
  it("splits at the last # so project names containing # survive", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleDetail, projectName: "my#project" }),
    );
    const result = await runCli(
      ["ticket", "get", "my#project#12"],
      { CC_SERVER_URL: baseEnv["CC_SERVER_URL"], CC_API_TOKEN: "env-token" },
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/my%23project/tickets/12",
    );
  });

  it("prefers the reference's project over the ambient scope", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleDetail, projectName: "other" }),
    );
    await runCli(["ticket", "get", "other#7"], baseEnv, host);
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/other/tickets/7",
    );
  });

  it("exits 2 before any network call on a malformed reference", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    for (const ref of ["twelve", "#12", "cc#", "cc#zero", "-3", "1.5"]) {
      const result = await runCli(["ticket", "get", ref], baseEnv, host);
      expect(result.exitCode, `ref "${ref}"`).toBe(2);
      expect(result.stderr).toContain(ref);
    }
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 before any network call when the argument is missing", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(["ticket", "get"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 1 with ticket_not_found naming the reference for an unknown ticket", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Ticket not found: cc#99", code: "ticket_not_found" },
        404,
      ),
    );
    const result = await runCli(
      ["ticket", "get", "99", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.code).toBe("ticket_not_found");
    expect(envelope.error).toContain("cc#99");
  });

  it("fails on a malformed detail response instead of dropping the index", async () => {
    const host = makeHost(() => jsonResponse({ nope: true }));
    const result = await runCli(
      ["ticket", "get", "12", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("invalid_response");
    expect(envelope.error).toContain("cc#12");
  });

  it("does not call a legacy unverified session active", async () => {
    const host = makeHost((req) =>
      new URL(req.url).pathname.endsWith("/session-links")
        ? jsonResponse({})
        : jsonResponse({
            ...sampleDetail,
            sessions: [
              {
                id: "legacy-link-1",
                ticketId: "ticket-1",
                projectPath: "/repos/cc",
                sessionName: "csm/legacy-gate",
                sessionCreatedAt: null,
                startMode: "prepared",
                linkedAt: "2026-01-02T00:00:00Z",
                endedAt: null,
                endReason: null,
              },
            ],
          }),
    );

    const result = await runCli(["ticket", "get", "12"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("csm/legacy-gate (status unknown)");
    expect(result.stdout).not.toContain("csm/legacy-gate (active)");
  });
});

describe("cctl ticket relation", () => {
  it("lists bounded outlines with a role filter and cursor continuation", async () => {
    const host = makeHost(() =>
      jsonResponse({
        items: [sampleRelationship],
        total: 4,
        nextCursor: "next_cursor",
      }),
    );
    const cursor = Buffer.from(
      JSON.stringify({ timestamp: "2026-01-03T00:00:00Z", id: "rel-9" }),
      "utf8",
    ).toString("base64url");
    const result = await runCli(
      [
        "ticket",
        "relation",
        "list",
        "12",
        "--role",
        "depends_on",
        "--limit",
        "1",
        "--cursor",
        cursor,
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const url = new URL(firstOf(host.requests, "request").url);
    expect(url.pathname).toBe("/api/projects/cc/tickets/12/relationships");
    expect(url.searchParams.get("role")).toBe("depends_on");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("cursor")).toBe(cursor);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      relationships: [
        {
          id: "rel-1",
          descriptionPreview: "API contract first",
          getCommand: "cctl ticket relation get 'cc#12' 'rel-1'",
        },
      ],
      total: 4,
      returned: 1,
      truncated: true,
      next: {
        cursor: "next_cursor",
        command:
          "cctl ticket relation list 'cc#12' --role depends_on --limit 1 --cursor 'next_cursor'",
      },
    });
  });

  it.each(["related", "depends_on", "blocks", "parent", "child"] as const)(
    "adds the relative %s role while resolving both ticket references independently",
    async (role) => {
      const responseRelationship = { ...sampleRelationship, role };
      const host = makeHost(() =>
        jsonResponse(
          {
            relationship: responseRelationship,
            tickets: [
              { ...sampleDetail, projectName: "host" },
              { ...sampleDetail, id: "ticket-2", number: 7 },
            ],
          },
          201,
        ),
      );
      const result = await runCli(
        [
          "ticket",
          "relation",
          "add",
          "host#12",
          "7",
          "--role",
          role,
          "--description",
          "why",
          "--json",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(0);
      const request = firstOf(host.requests, "request");
      expect(new URL(request.url).pathname).toBe(
        "/api/projects/host/tickets/12/relationships",
      );
      expect(JSON.parse(request.init.body ?? "{}")).toEqual({
        target: { projectName: "cc", number: 7 },
        role,
        description: "why",
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        relationship: { role },
      });
    },
  );

  it("reads add and update prose from the registry-derived file flags", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          relationship: sampleRelationship,
          tickets: [sampleDetail],
        }),
      {},
      {
        ".cc/temp/add.md": " rationale from file \n",
        ".cc/temp/update.md": " replacement rationale \n",
      },
    );

    const added = await runCli(
      [
        "ticket",
        "relation",
        "add",
        "12",
        "other#7",
        "--role",
        "related",
        "--description-file",
        ".cc/temp/add.md",
      ],
      baseEnv,
      host,
    );
    const updated = await runCli(
      [
        "ticket",
        "relation",
        "update",
        "12",
        "rel-1",
        "--description-file",
        ".cc/temp/update.md",
      ],
      baseEnv,
      host,
    );

    expect(added.exitCode).toBe(0);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}").description).toBe(
      "rationale from file",
    );
    expect(JSON.parse(host.requests[1]!.init.body ?? "{}").description).toBe(
      "replacement rationale",
    );
  });

  it("preserves both empty inline spellings so update can clear a rationale", async () => {
    const host = makeHost(() =>
      jsonResponse({
        relationship: { ...sampleRelationship, description: "" },
        tickets: [sampleDetail],
      }),
    );

    const spaced = await runCli(
      ["ticket", "relation", "update", "12", "rel-1", "--description", ""],
      baseEnv,
      host,
    );
    const attached = await runCli(
      ["ticket", "relation", "update", "12", "rel-1", "--description="],
      baseEnv,
      host,
    );

    expect(spaced.exitCode).toBe(0);
    expect(attached.exitCode).toBe(0);
    expect(host.requests).toHaveLength(2);
    for (const request of host.requests) {
      expect(JSON.parse(request.init.body ?? "{}")).toEqual({
        description: "",
      });
    }
  });

  it("keeps empty values invalid for unrelated value flags", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "relation", "add", "12", "other#7", "--role="],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--role");
    expect(host.requests).toHaveLength(0);
  });

  it("gets a full rationale and removes by stable relationship id", async () => {
    const host = makeHost((request) =>
      request.init.method === "DELETE"
        ? jsonResponse({ relationshipId: "rel-1", tickets: [sampleDetail] })
        : jsonResponse(sampleRelationship),
    );
    const got = await runCli(
      ["ticket", "relation", "get", "12", "rel-1"],
      baseEnv,
      host,
    );
    const removed = await runCli(
      ["ticket", "relation", "remove", "12", "rel-1", "--json"],
      baseEnv,
      host,
    );

    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("API contract first");
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      ok: true,
      removed: { relationshipId: "rel-1" },
    });
    expect(host.requests[1]!.init.method).toBe("DELETE");
  });

  it("returns bounded add and update receipts instead of raw relationship Markdown", async () => {
    const fullRationale = `${"sensitive rationale ".repeat(4_000)}RELATIONSHIP_TAIL`;
    const host = makeHost(() =>
      jsonResponse({
        relationship: { ...sampleRelationship, description: fullRationale },
        tickets: [sampleDetail],
      }),
    );

    const added = await runCli(
      [
        "ticket",
        "relation",
        "add",
        "12",
        "other#7",
        "--role",
        "related",
        "--description",
        "requested rationale",
        "--json",
      ],
      baseEnv,
      host,
    );
    const updated = await runCli(
      [
        "ticket",
        "relation",
        "update",
        "12",
        "rel-1",
        "--description",
        "replacement",
        "--json",
      ],
      baseEnv,
      host,
    );
    const addedText = await runCli(
      [
        "ticket",
        "relation",
        "add",
        "12",
        "other#7",
        "--role",
        "related",
        "--description",
        "requested rationale",
      ],
      baseEnv,
      host,
    );
    const updatedText = await runCli(
      [
        "ticket",
        "relation",
        "update",
        "12",
        "rel-1",
        "--description",
        "replacement",
      ],
      baseEnv,
      host,
    );

    for (const result of [added, updated, addedText, updatedText]) {
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(60_000);
      expect(result.stdout).not.toContain("RELATIONSHIP_TAIL");
    }
    for (const result of [added, updated]) {
      expect(JSON.parse(result.stdout).relationship).toMatchObject({
        id: "rel-1",
        descriptionPreview: expect.any(String),
        getCommand: "cctl ticket relation get 'cc#12' 'rel-1'",
      });
      expect(JSON.parse(result.stdout).relationship).not.toHaveProperty(
        "description",
      );
    }
    for (const result of [addedText, updatedText]) {
      expect(result.stdout).toContain(
        "get: cctl ticket relation get 'cc#12' 'rel-1'",
      );
    }
  });

  it.each([
    ["--role", "sideways"],
    ["--limit", "0"],
    ["--limit", "101"],
    ["--cursor", "not-a-cursor"],
  ])("rejects invalid list %s locally", async (flag, value) => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "relation", "list", "12", flag, value],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("maps semantic HTTP 400 relationship refusals to exit 1 with structured detail", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "A relationship must connect two distinct tickets.",
          code: "relationship_self_link",
          details: { ticketId: "ticket-1" },
          rationale: "A relationship must connect two distinct tickets.",
          issues: [{ path: "target", message: "matches the source" }],
        },
        400,
      ),
    );
    const result = await runCli(
      ["ticket", "relation", "add", "12", "12", "--role", "related", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "relationship_self_link",
      details: { ticketId: "ticket-1" },
      rationale: "A relationship must connect two distinct tickets.",
      issues: [{ path: "target", message: "matches the source" }],
    });
  });
});

describe("cctl ticket status-update", () => {
  const agentEnv = {
    ...baseEnv,
    CC_CONVERSATION_ID: "conversation-1",
  };

  it("posts Markdown with provenance only from CC_CONVERSATION_ID", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          update: sampleStatusUpdate,
          ticket: {
            ...sampleDetail,
            statusUpdates: { total: 1, recent: [sampleStatusUpdate] },
          },
        },
        201,
      ),
    );
    const result = await runCli(
      [
        "ticket",
        "status-update",
        "add",
        "12",
        "--body",
        "Implemented the first slice.",
        "--json",
      ],
      agentEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = firstOf(host.requests, "request");
    expect(request.init.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/tickets/12/status-updates",
    );
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      bodyMarkdown: "Implemented the first slice.",
    });
    expect(request.init.headers?.["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
  });

  it("trims ambient provenance and rejects whitespace-only identity locally", async () => {
    const successHost = makeHost(() =>
      jsonResponse({ update: sampleStatusUpdate, ticket: sampleDetail }, 201),
    );
    const trimmed = await runCli(
      ["ticket", "status-update", "add", "12", "--body", "Progress"],
      { ...baseEnv, CC_CONVERSATION_ID: "  conversation-1 \n" },
      successHost,
    );
    expect(trimmed.exitCode).toBe(0);
    expect(
      successHost.requests[0]?.init.headers?.["x-cc-conversation-id"],
    ).toBe("conversation-1");

    const whitespaceHost = makeHost(() => jsonResponse({}));
    const whitespace = await runCli(
      ["ticket", "status-update", "add", "12", "--body", "Progress"],
      { ...baseEnv, CC_CONVERSATION_ID: " \n\t " },
      whitespaceHost,
    );
    expect(whitespace.exitCode).toBe(2);
    expect(whitespace.stderr).toContain("CC_CONVERSATION_ID");
    expect(whitespaceHost.requests).toHaveLength(0);
  });

  it("returns a bounded add receipt instead of raw status-update Markdown", async () => {
    const fullBody = `${"sensitive update ".repeat(5_000)}STATUS_TAIL`;
    const host = makeHost(() =>
      jsonResponse(
        {
          update: { ...sampleStatusUpdate, bodyMarkdown: fullBody },
          ticket: sampleDetail,
        },
        201,
      ),
    );
    const result = await runCli(
      [
        "ticket",
        "status-update",
        "add",
        "12",
        "--body",
        "requested update",
        "--json",
      ],
      agentEnv,
      host,
    );
    const textResult = await runCli(
      ["ticket", "status-update", "add", "12", "--body", "requested update"],
      agentEnv,
      host,
    );

    for (const output of [result, textResult]) {
      expect(output.exitCode).toBe(0);
      expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThan(60_000);
      expect(output.stdout).not.toContain("STATUS_TAIL");
    }
    expect(JSON.parse(result.stdout).update).toMatchObject({
      id: "update-1",
      bodyPreview: expect.any(String),
      getCommand: "cctl ticket status-update get 'cc#12' 'update-1'",
    });
    expect(JSON.parse(result.stdout).update).not.toHaveProperty("bodyMarkdown");
    expect(textResult.stdout).toContain(
      "get: cctl ticket status-update get 'cc#12' 'update-1'",
    );
  });

  it("refuses a global --conversation provenance override before the network", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      [
        "ticket",
        "status-update",
        "add",
        "12",
        "--body",
        "Update",
        "--conversation",
        "someone-else",
      ],
      agentEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_CONVERSATION_ID");
    expect(host.requests).toHaveLength(0);
  });

  it("fails locally when an authenticated call has no ambient conversation", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "status-update", "add", "12", "--body", "Update"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_CONVERSATION_ID");
    expect(host.requests).toHaveLength(0);
  });

  it.each(["", "   \n\t"])(
    "rejects an empty or whitespace-only body locally",
    async (body) => {
      const host = makeHost(() => jsonResponse({}));
      const result = await runCli(
        ["ticket", "status-update", "add", "12", `--body=${body}`],
        agentEnv,
        host,
      );
      expect(result.exitCode).toBe(2);
      expect(host.requests).toHaveLength(0);
    },
  );

  it("reads the body from --body-file", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          update: sampleStatusUpdate,
          ticket: sampleDetail,
        }),
      {},
      { ".cc/temp/update.md": " update from file \n" },
    );
    const result = await runCli(
      [
        "ticket",
        "status-update",
        "add",
        "12",
        "--body-file",
        ".cc/temp/update.md",
      ],
      agentEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toEqual({
      bodyMarkdown: "update from file",
    });
  });

  it("lists outlines and gets one full body with redacted provenance", async () => {
    const host = makeHost((request) =>
      new URL(request.url).pathname.endsWith("/update-1")
        ? jsonResponse(sampleStatusUpdate)
        : jsonResponse({
            items: [sampleStatusUpdate],
            total: 3,
            nextCursor: "next_update",
          }),
    );
    const listed = await runCli(
      ["ticket", "status-update", "list", "12", "--limit", "1", "--json"],
      agentEnv,
      host,
    );
    const got = await runCli(
      ["ticket", "status-update", "get", "12", "update-1"],
      agentEnv,
      host,
    );

    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      updates: [
        {
          id: "update-1",
          authorKind: "agent",
          backend: "codex",
          conversationId: "conversation-1",
          bodyPreview: "Implemented the first slice.",
        },
      ],
      total: 3,
      returned: 1,
      truncated: true,
    });
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("Implemented the first slice.");
    expect(got.stdout).toContain("conversation-1");
  });

  it.each([
    ["--limit", "0"],
    ["--limit", "101"],
    ["--cursor", "not-a-cursor"],
  ])("rejects invalid list %s locally", async (flag, value) => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "status-update", "list", "12", flag, value],
      agentEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it.each(["status_update_actor_required", "status_update_actor_not_found"])(
    "maps semantic HTTP 400 %s to exit 1",
    async (code) => {
      const host = makeHost(() =>
        jsonResponse(
          {
            error: "Agent provenance could not be resolved.",
            code,
            details: { conversationId: "conversation-1" },
            rationale:
              "Agent-authored updates require a resolvable conversation so source provenance remains durable.",
          },
          400,
        ),
      );
      const result = await runCli(
        ["ticket", "status-update", "add", "12", "--body", "Update", "--json"],
        agentEnv,
        host,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ code });
    },
  );
});

describe("cctl ticket get — bounded relationship and update disclosure", () => {
  it("replaces raw Markdown bodies with grouped outlines and exact drill-down commands", async () => {
    const rationale = "relationship secret ".repeat(20);
    const body = "status secret ".repeat(20);
    const host = makeHost(() =>
      jsonResponse({
        ...sampleDetail,
        relationships: [{ ...sampleRelationship, description: rationale }],
        statusUpdates: {
          total: 4,
          recent: [{ ...sampleStatusUpdate, bodyMarkdown: body }],
        },
      }),
    );
    const result = await runCli(
      ["ticket", "get", "12", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ticket.relationships).toMatchObject({
      total: 1,
      returned: 1,
      truncated: false,
      items: [{ id: "rel-1", getCommand: expect.stringContaining("rel-1") }],
    });
    expect(envelope.ticket.statusUpdates).toMatchObject({
      total: 4,
      returned: 1,
      truncated: true,
      items: [
        { id: "update-1", getCommand: expect.stringContaining("update-1") },
      ],
    });
    expect(result.stdout).not.toContain(rationale);
    expect(result.stdout).not.toContain(body);
  });

  it("spills either selected serialization at the stdout budget", async () => {
    const writes: string[] = [];
    const base = makeHost(() =>
      jsonResponse({ ...sampleDetail, description: "x".repeat(60_000) }),
    );
    const host: CliHost & { requests: RecordedRequest[] } = {
      ...base,
      async writeTextFile(_path, content) {
        writes.push(content);
      },
    };
    const result = await runCli(
      ["ticket", "get", "12", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      storage: "artifact",
      artifact: { reason: "stdout_budget_exceeded" },
    });
    expect(result.stdout).not.toContain("x".repeat(100));
    expect(writes).toHaveLength(1);
  });
});

describe("cctl ticket update", () => {
  it("PATCHes only the provided fields", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleDetail, status: "blocked" }),
    );
    const result = await runCli(
      ["ticket", "update", "12", "--status", "blocked"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("updated cc#12");
    const req = host.requests[0]!;
    expect(req.init.method).toBe("PATCH");
    expect(new URL(req.url).pathname).toBe("/api/projects/cc/tickets/12");
    expect(JSON.parse(req.init.body ?? "{}")).toEqual({ status: "blocked" });
  });

  it("exits 2 before any network call when no field flag is given", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(["ticket", "update", "12"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--title");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an invalid --status before any network call", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(
      ["ticket", "update", "12", "--status", "paused"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("in_progress");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl ticket delete", () => {
  it("exits 1 with ticket_not_found for an unknown ticket", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Ticket not found: cc#99", code: "ticket_not_found" },
        404,
      ),
    );
    const result = await runCli(["ticket", "delete", "99"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cc#99");
  });
});

describe("cctl ticket transport failures", () => {
  it("exits 3 when the server is unreachable", async () => {
    const host: CliHost = {
      async fetch() {
        throw new Error("ECONNREFUSED");
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
    const result = await runCli(["ticket", "get", "12"], baseEnv, host);
    expect(result.exitCode).toBe(3);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: "Invalid Command Center API token" }, 401),
    );
    const result = await runCli(["ticket", "get", "12"], baseEnv, host);
    expect(result.exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Attachments (task 4.2)
// ---------------------------------------------------------------------------

function sampleAttachment(
  id: string,
  payload: Record<string, unknown>,
  description = "why it matters",
) {
  return {
    id,
    ticketId: "ticket-1",
    description,
    payload,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

const LONG_DESCRIPTION = "x".repeat(150);

describe("cctl ticket attach", () => {
  it("keeps attach ticket as a narrow compatibility projection over the relationship route", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          relationship: { ...sampleRelationship, role: "related" },
          tickets: [sampleDetail],
        },
        201,
      ),
    );
    const result = await runCli(
      [
        "ticket",
        "attach",
        "ticket",
        "12",
        "other#7",
        "--description",
        "same release",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = firstOf(host.requests, "request");
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/tickets/12/relationships",
    );
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      target: { projectName: "other", number: 7 },
      role: "related",
      description: "same release",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      attachment: {
        id: "rel-1",
        ticketId: "ticket-1",
        payload: {
          kind: "related_ticket",
          ticketId: "ticket-2",
          identifierSnapshot: "other#7",
        },
      },
    });
  });

  it("exits 2 naming the offending kind and the registry's kinds", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attach", "url", "12", "--description", "d"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown ticket attach kind "url"');
    for (const kind of ["file", "conversation", "session", "ticket", "note"]) {
      expect(result.stderr, kind).toContain(kind);
    }
    expect(host.requests).toHaveLength(0);
  });

  it("requires --description for every kind before any network call", async () => {
    const host = makeHost(() => jsonResponse({}));
    const invocations = [
      ["ticket", "attach", "note", "12", "some text"],
      ["ticket", "attach", "session", "12", "csm/fix"],
      ["ticket", "attach", "ticket", "12", "7"],
      ["ticket", "attach", "conversation", "12"],
      ["ticket", "attach", "file", "12", "logs/ci.txt"],
    ];
    for (const argv of invocations) {
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("--description");
    }
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 before any network call on extra positional arguments for every kind", async () => {
    const invocations = [
      ["ticket", "attach", "note", "12", "md", "extra"],
      ["ticket", "attach", "ticket", "12", "7", "extra"],
      ["ticket", "attach", "session", "12", "s1", "extra"],
      ["ticket", "attach", "conversation", "12", "conv-1", "extra"],
      ["ticket", "attach", "file", "12", "a.txt", "extra"],
    ];
    for (const argv of invocations) {
      const host = makeHost(() => jsonResponse({}));
      const result = await runCli(
        [...argv, "--description", "d"],
        baseEnv,
        host,
      );
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(host.requests, argv.join(" ")).toHaveLength(0);
    }
  });

  it("attaches the current conversation from the env identity by default", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "conversation",
          projectPath: "/repos/cc",
          sessionName: "sess-env",
          conversationId: "conv-env",
          snapshotKey: "k",
          snapshotCapturedAt: "2026-01-02T00:00:00Z",
        }),
        201,
      ),
    );
    await runCli(
      ["ticket", "attach", "conversation", "12", "--description", "d"],
      { ...baseEnv, CC_SESSION: "sess-env", CC_CONVERSATION_ID: "conv-env" },
      host,
    );
    expect(
      JSON.parse(firstOf(host.requests, "request").init.body ?? "{}"),
    ).toEqual({
      description: "d",
      payload: {
        kind: "conversation",
        projectName: "cc",
        sessionName: "sess-env",
        conversationId: "conv-env",
      },
    });
  });

  it("attaches an explicit conversation id without inheriting the env session", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "conversation",
          projectPath: "/repos/cc",
          sessionName: null,
          conversationId: "conv-42",
          snapshotKey: "k",
          snapshotCapturedAt: "2026-01-02T00:00:00Z",
        }),
        201,
      ),
    );
    await runCli(
      [
        "ticket",
        "attach",
        "conversation",
        "12",
        "conv-42",
        "--description",
        "d",
      ],
      { ...baseEnv, CC_SESSION: "sess-env", CC_CONVERSATION_ID: "conv-env" },
      host,
    );
    const body = JSON.parse(host.requests[0]!.init.body ?? "{}");
    expect(body.payload.conversationId).toBe("conv-42");
    expect(body.payload.sessionName).toBeNull();
  });

  it("does not inherit the env session when --conversation names the target", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "conversation",
          projectPath: "/repos/cc",
          sessionName: null,
          conversationId: "conv-42",
          snapshotKey: "k",
          snapshotCapturedAt: "2026-01-02T00:00:00Z",
        }),
        201,
      ),
    );
    await runCli(
      [
        "ticket",
        "attach",
        "conversation",
        "12",
        "--conversation",
        "conv-42",
        "--description",
        "d",
      ],
      { ...baseEnv, CC_SESSION: "sess-env", CC_CONVERSATION_ID: "conv-env" },
      host,
    );
    const body = JSON.parse(host.requests[0]!.init.body ?? "{}");
    expect(body.payload.conversationId).toBe("conv-42");
    expect(body.payload.sessionName).toBeNull();
  });

  it("names the still-pending snapshot and its retry command on a conversation attach", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "conversation",
          projectPath: "/repos/cc",
          sessionName: null,
          conversationId: "conv-42",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: "pending",
        }),
        201,
      ),
    );
    const result = await runCli(
      [
        "ticket",
        "attach",
        "conversation",
        "12",
        "conv-42",
        "--description",
        "d",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("snapshot pending");
    expect(result.stdout).toContain(
      "cctl ticket attachment refresh 'cc#12' 'att-1'",
    );
  });

  it("says nothing about snapshots when the attached conversation is already captured", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "conversation",
          projectPath: "/repos/cc",
          sessionName: null,
          conversationId: "conv-42",
          snapshotKey: "k",
          snapshotCapturedAt: "2026-01-02T00:00:00Z",
        }),
        201,
      ),
    );
    const result = await runCli(
      [
        "ticket",
        "attach",
        "conversation",
        "12",
        "conv-42",
        "--description",
        "d",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("snapshot pending");
    expect(result.stdout).not.toContain("attachment refresh");
  });

  it("exits 2 when no conversation id is available", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attach", "conversation", "12", "--description", "d"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--conversation");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 naming the path when the file is unreadable", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attach", "file", "12", "missing.txt", "--description", "d"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing.txt");
    expect(host.requests).toHaveLength(0);
  });

  it("targets a qualified ticket reference's project", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", { kind: "note", markdown: "m" }),
        201,
      ),
    );
    await runCli(
      ["ticket", "attach", "note", "other#7", "m", "--description", "d"],
      baseEnv,
      host,
    );
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/other/tickets/7/attachments",
    );
  });
});

describe("cctl ticket attach note — file-sourced body (doc 09 §7)", () => {
  function noteHost(files: Record<string, string>) {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", { kind: "note", markdown: "m" }),
        201,
      ),
    );
    return {
      ...host,
      readTextFile: async (filePath: string) => files[filePath] ?? null,
    };
  }

  it("sends the markdown read from --markdown-file in place of the positional", async () => {
    const host = noteHost({
      ".cc/temp/note.md": "Repro: run `bun test` twice.\n",
    });
    const result = await runCli(
      [
        "ticket",
        "attach",
        "note",
        "12",
        "--markdown-file",
        ".cc/temp/note.md",
        "--description",
        "repro steps",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toEqual({
      description: "repro steps",
      payload: { kind: "note", markdown: "Repro: run `bun test` twice." },
    });
  });

  it("refuses a positional body alongside a file source before any request", async () => {
    const host = noteHost({ ".cc/temp/note.md": "from the file" });
    const result = await runCli(
      [
        "ticket",
        "attach",
        "note",
        "12",
        "inline body",
        "--markdown-file",
        ".cc/temp/note.md",
        "--description",
        "d",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("names the file alternative when no body is supplied at all", async () => {
    const host = noteHost({});
    const result = await runCli(
      ["ticket", "attach", "note", "12", "--description", "d"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--markdown-file");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl ticket create — file-sourced description (doc 09 §7)", () => {
  it("sends the description read from --description-file", async () => {
    const base = makeHost(() =>
      jsonResponse({ ticket: sampleDetail, warnings: [] }, 201),
    );
    const host = {
      ...base,
      readTextFile: async (filePath: string) =>
        filePath === ".cc/temp/desc.md"
          ? "Fails ~1 in 5 `bun test` runs.\n"
          : null,
    };
    const result = await runCli(
      [
        "ticket",
        "create",
        "--title",
        "Flaky gate",
        "--type",
        "bug",
        "--description-file",
        ".cc/temp/desc.md",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(firstOf(base.requests, "request").init.body ?? "{}"),
    ).toEqual({
      title: "Flaky gate",
      workType: "bug",
      description: "Fails ~1 in 5 `bun test` runs.",
    });
  });
});

describe("cctl ticket attachment get — file content", () => {
  function fileAttachment(fileName: string, mediaType: string | null) {
    return sampleAttachment(
      "att-1",
      {
        kind: "file",
        fileName,
        snapshotKey: "snap-1",
        mediaType,
        sizeBytes: 12,
        sha256: "deadbeef",
      },
      "captured build notes",
    );
  }

  function resolvedFile(input: {
    content: string;
    encoding: "utf8" | "base64";
    fileName?: string;
    mediaType?: string | null;
  }): Record<string, unknown> {
    const fileName = input.fileName ?? "notes.md";
    const mediaType =
      input.mediaType === undefined ? "text/markdown" : input.mediaType;
    return {
      kind: "file",
      attachment: fileAttachment(fileName, mediaType),
      fileName,
      mediaType,
      sizeBytes: Buffer.byteLength(input.content, "utf8"),
      sha256: "deadbeef",
      encoding: input.encoding,
      content: input.content,
    };
  }

  function writingHost(respond: (req: RecordedRequest) => Response) {
    const written: Array<{ path: string; content: string }> = [];
    const host = makeHost(respond);
    return Object.assign(host, {
      written,
      async writeTextFile(filePath: string, content: string) {
        written.push({ path: filePath, content });
      },
    });
  }

  it("keeps content within the stdout budget inline", async () => {
    const host = writingHost(() =>
      jsonResponse(resolvedFile({ content: "short body", encoding: "utf8" })),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("short body");
    expect(host.written).toHaveLength(0);
  });

  it("spills content past the stdout budget to an artifact and prints the manifest", async () => {
    const content = "x".repeat(70_000);
    const host = writingHost(() =>
      jsonResponse(resolvedFile({ content, encoding: "utf8" })),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(content);
    expect(host.written).toHaveLength(1);
    const written = firstOf(host.written, "artifact write");
    expect(written.content).toBe(content);
    expect(result.stdout).toContain(`artifact: ${written.path}`);
    expect(result.stdout).toContain("bytes: 70000");
    expect(result.stdout).toMatch(/sha256: sha256:[a-f0-9]{64}/u);
    expect(result.stdout).toContain("notes.md");
    expect(result.stdout).toContain("text/markdown");
  });

  it("replaces the content field with the manifest in the --json envelope", async () => {
    const content = "x".repeat(70_000);
    const host = writingHost(() =>
      jsonResponse(resolvedFile({ content, encoding: "utf8" })),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1", "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout);
    expect(envelope.attachment.content).toBeUndefined();
    expect(envelope.artifact).toMatchObject({
      path: firstOf(host.written, "artifact write").path,
      bytes: 70_000,
      reason: "stdout_budget_exceeded",
    });
    expect(envelope.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("always writes base64 content to an artifact, whatever its size", async () => {
    const host = writingHost(() =>
      jsonResponse(
        resolvedFile({
          content: "aGVsbG8=",
          encoding: "base64",
          fileName: "diagram.png",
          mediaType: "image/png",
        }),
      ),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("aGVsbG8=");
    expect(host.written).toHaveLength(1);
    expect(firstOf(host.written, "artifact write").path).toContain(".cc/temp/");
    expect(result.stdout).toContain("base64");
  });

  it("fails loudly when the artifact cannot be written", async () => {
    const host = makeHost(() =>
      jsonResponse(resolvedFile({ content: "aGVsbG8=", encoding: "base64" })),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("write_unavailable");
  });
});

describe("cctl ticket attachment", () => {
  it("accepts the narrow legacy relationship projections from get, update, and remove", async () => {
    const legacyAttachment = sampleAttachment(
      "rel-1",
      {
        kind: "related_ticket",
        ticketId: "ticket-2",
        identifierSnapshot: "other#7",
      },
      "Related ticket",
    );
    const host = makeHost((request) => {
      if (request.init.method === "PATCH") {
        return jsonResponse({ ...legacyAttachment, description: "updated" });
      }
      if (request.init.method === "DELETE") {
        return jsonResponse({
          attachmentId: "rel-1",
          ticketId: "ticket-1",
          kind: "related_ticket",
          ticketUpdatedAt: "2026-01-03T00:00:00Z",
        });
      }
      return jsonResponse({
        kind: "related_ticket",
        attachment: legacyAttachment,
        available: true,
        ticket: { ...sampleDetail, projectName: "other", number: 7 },
        followCommand: "cctl ticket get 'other#7'",
      });
    });

    const got = await runCli(
      ["ticket", "attachment", "get", "12", "rel-1"],
      baseEnv,
      host,
    );
    const updated = await runCli(
      [
        "ticket",
        "attachment",
        "update",
        "12",
        "rel-1",
        "--description",
        "updated",
      ],
      baseEnv,
      host,
    );
    const removed = await runCli(
      ["ticket", "attachment", "remove", "12", "rel-1", "--json"],
      baseEnv,
      host,
    );

    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("related ticket: other#7");
    expect(updated.exitCode).toBe(0);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      removed: { kind: "related_ticket", attachmentId: "rel-1" },
    });
  });

  it.each([
    {
      state: "pending" as const,
      error: undefined,
      expected: "snapshot pending",
    },
    {
      state: "failed" as const,
      error: "Compaction timed out.",
      expected: "snapshot failed: Compaction timed out.",
    },
  ])(
    "renders a $state conversation snapshot with its retry command",
    async (fixture) => {
      const retryCommand = "cctl ticket attachment refresh 'cc#12' 'att-1'";
      const attachment = sampleAttachment("att-1", {
        kind: "conversation",
        projectPath: "/repos/cc",
        sessionName: null,
        conversationId: "conv-9",
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: fixture.state,
        ...(fixture.error !== undefined
          ? { snapshotError: fixture.error }
          : {}),
      });
      const host = makeHost(() =>
        jsonResponse({
          kind: "conversation",
          state: fixture.state,
          attachment,
          conversationId: "conv-9",
          sessionName: null,
          ...(fixture.error !== undefined ? { error: fixture.error } : {}),
          retryCommand,
        }),
      );

      const text = await runCli(
        ["ticket", "attachment", "get", "12", "att-1"],
        baseEnv,
        host,
      );
      const json = await runCli(
        ["ticket", "attachment", "get", "12", "att-1", "--json"],
        baseEnv,
        host,
      );

      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain(fixture.expected);
      expect(text.stdout).toContain(retryCommand);
      expect(JSON.parse(json.stdout).attachment).toMatchObject({
        kind: "conversation",
        state: fixture.state,
        retryCommand,
      });
    },
  );

  it.each([
    {
      state: "pending" as const,
      error: undefined,
      expected: "snapshot pending",
    },
    {
      state: "failed" as const,
      error: "Compaction timed out.",
      expected: "snapshot failed: Compaction timed out.",
    },
  ])(
    "renders a canonical $state result when refresh loses the snapshot race",
    async (fixture) => {
      const attachment = sampleAttachment("att-1", {
        kind: "conversation",
        projectPath: "/repos/cc",
        sessionName: null,
        conversationId: "conv-9",
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: fixture.state,
        ...(fixture.error !== undefined
          ? { snapshotError: fixture.error }
          : {}),
      });
      const host = makeHost(() => jsonResponse(attachment));

      const text = await runCli(
        ["ticket", "attachment", "refresh", "12", "att-1"],
        baseEnv,
        host,
      );
      const json = await runCli(
        ["ticket", "attachment", "refresh", "12", "att-1", "--json"],
        baseEnv,
        host,
      );

      const retryCommand = "cctl ticket attachment refresh 'cc#12' 'att-1'";
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain(fixture.expected);
      expect(text.stdout).toContain(retryCommand);
      expect(text.stdout).not.toContain("refreshed conversation snapshot");
      expect(JSON.parse(json.stdout).attachment).toMatchObject({
        kind: "conversation",
        state: fixture.state,
        attachment: {
          id: "att-1",
          payload: { snapshotStatus: fixture.state },
        },
        retryCommand,
      });
    },
  );

  it("exits 2 naming the offending verb and the registry's verbs", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attachment", "frob", "12", "att-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'unknown ticket attachment subcommand "frob"',
    );
    for (const verb of ["get", "update", "refresh", "remove"]) {
      expect(result.stderr, verb).toContain(verb);
    }
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 before any network call when update has no field flags", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attachment", "update", "12", "att-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--description");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 before any network call on extra positional arguments for every verb", async () => {
    for (const verb of ["get", "update", "refresh", "remove"] as const) {
      const host = makeHost(() => jsonResponse({}));
      const result = await runCli(
        [
          "ticket",
          "attachment",
          verb,
          "12",
          "att-1",
          "extra",
          ...(verb === "update" ? ["--description", "d"] : []),
        ],
        baseEnv,
        host,
      );
      expect(result.exitCode, verb).toBe(2);
      expect(host.requests, verb).toHaveLength(0);
    }
  });

  it("exits 2 before any network call when the attachment id is missing", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attachment", "get", "12"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 1 with attachment_not_found for an unknown attachment", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Attachment not found on cc#12: att-9",
          code: "attachment_not_found",
        },
        404,
      ),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-9", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("attachment_not_found");
  });
});

describe("cctl ticket malformed 2xx response contracts", () => {
  it.each([
    [
      "create",
      ["ticket", "create", "--title", "Fix", "--type", "bug", "--json"],
    ],
    ["update", ["ticket", "update", "12", "--title", "Fixed", "--json"]],
    ["delete", ["ticket", "delete", "12", "--json"]],
    [
      "attach",
      [
        "ticket",
        "attach",
        "note",
        "12",
        "body",
        "--description",
        "context",
        "--json",
      ],
    ],
    [
      "attachment get",
      ["ticket", "attachment", "get", "12", "att-1", "--json"],
    ],
    [
      "attachment update",
      [
        "ticket",
        "attachment",
        "update",
        "12",
        "att-1",
        "--description",
        "context",
        "--json",
      ],
    ],
    [
      "attachment remove",
      ["ticket", "attachment", "remove", "12", "att-1", "--json"],
    ],
    [
      "attachment refresh",
      ["ticket", "attachment", "refresh", "12", "att-1", "--json"],
    ],
  ] as const)("fails %s instead of reporting success", async (_label, argv) => {
    const host = makeHost(() => jsonResponse({ nope: true }));

    const result = await runCli([...argv], baseEnv, host);

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: false, code: "invalid_response" });
  });
});

describe("attachment index on list (bounded mode)", () => {
  function listHost() {
    return makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/attachments")) {
        return jsonResponse({
          attachments: [
            sampleAttachment(
              "att-1",
              { kind: "note", markdown: "m" },
              LONG_DESCRIPTION,
            ),
          ],
        });
      }
      return jsonResponse([
        { ...sampleListItem, attachmentCount: 1 },
        { ...sampleListItem, number: 13, attachmentCount: 0 },
      ]);
    });
  }

  it("fetches attachments only for tickets that have any", async () => {
    const host = listHost();
    await runCli(["ticket", "list", "--attachments"], baseEnv, host);
    // One list call + one attachments call for cc#12; none for cc#13.
    expect(host.requests).toHaveLength(2);
  });
});

describe("cctl ticket start", () => {
  const startedDetail = {
    ...sampleDetail,
    status: "in_progress",
    sessions: [
      {
        id: "link-1",
        ticketId: "ticket-1",
        projectPath: "/repos/cc",
        sessionName: "ticket-12-fix-the-flaky-gate-1",
        sessionCreatedAt: "2026-01-01T00:00:01Z",
        startMode: "agent",
        linkedAt: "2026-01-01T00:00:02Z",
        endedAt: null,
        endReason: null,
      },
    ],
  };
  const startOutput = {
    ticket: startedDetail,
    sessionName: "ticket-12-fix-the-flaky-gate-1",
    conversationId: "11111111-1111-4111-8111-111111111111",
    initialPromptQueued: true,
  };

  it("POSTs the selected kickoff configuration and reports the session", async () => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(
      [
        "ticket",
        "start",
        "12",
        "--mode",
        "agent",
        "--backend",
        "codex",
        "--model",
        "gpt-5.6-sol",
        "--model-param",
        "reasoning=ultra",
        "--model-param",
        "fast=true",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(1);
    const req = host.requests[0];
    expect(req?.url).toContain("/api/projects/cc/tickets/12/start");
    expect(req?.init.method).toBe("POST");
    expect(JSON.parse(String(req?.init.body))).toEqual({
      mode: "agent",
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "ultra", fast: "true" },
      },
    });
    expect(result.stdout).toContain("cc#12");
    expect(result.stdout).toContain("ticket-12-fix-the-flaky-gate-1");
    expect(result.stdout).toContain("agent");
  });

  it.each([
    {
      label: "a parameter without a model",
      args: ["--model-param", "fast=true"],
      message: "--model-param requires --model",
    },
    {
      label: "a malformed parameter",
      args: ["--model", "gpt-5.6-sol", "--model-param", "fast"],
      message: 'invalid --model-param "fast"',
    },
    {
      label: "a duplicate parameter",
      args: [
        "--model",
        "gpt-5.6-sol",
        "--model-param",
        "fast=true",
        "--model-param",
        "fast=false",
      ],
      message: 'duplicate --model-param "fast"',
    },
  ])("rejects $label before sending a request", async ({ args, message }) => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "agent", ...args],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
    expect(host.requests).toHaveLength(0);
  });

  it("names the conversation snapshots still capturing after the start returns", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ...startOutput,
        ticket: {
          ...startedDetail,
          attachments: [
            sampleAttachment("att-pending", {
              kind: "conversation",
              projectPath: "/repos/cc",
              sessionName: null,
              conversationId: "conv-1",
              snapshotKey: null,
              snapshotCapturedAt: null,
              snapshotStatus: "pending",
            }),
            sampleAttachment("att-captured", {
              kind: "conversation",
              projectPath: "/repos/cc",
              sessionName: null,
              conversationId: "conv-2",
              snapshotKey: "k",
              snapshotCapturedAt: "2026-01-02T00:00:00Z",
            }),
          ],
        },
      }),
    );
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "agent"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("att-pending");
    expect(result.stdout).toContain(
      "cctl ticket attachment get 'cc#12' 'att-pending'",
    );
    expect(result.stdout).not.toContain("att-captured");
  });

  it("says nothing about snapshots when every attachment is settled", async () => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "agent"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("pending");
  });

  it("reports a prepared start as waiting for the first prompt", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ...startOutput,
        ticket: { ...startedDetail, sessions: [] },
        initialPromptQueued: false,
      }),
    );
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "prepared"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(host.requests[0]?.init.body))).toEqual({
      mode: "prepared",
    });
    expect(result.stdout).toContain("prepared");
  });

  it("emits the full output in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(
      ["ticket", "start", "cc#12", "--mode", "agent", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      sessionName: string;
      initialPromptQueued: boolean;
      ticket: { number: number };
    };
    expect(body.ok).toBe(true);
    expect(body.sessionName).toBe("ticket-12-fix-the-flaky-gate-1");
    expect(body.initialPromptQueued).toBe(true);
    expect(body.ticket.number).toBe(12);
  });

  it("exits 2 without --mode before any network call", async () => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(["ticket", "start", "12"], baseEnv, host);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--mode");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an invalid --mode before any network call", async () => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "yolo"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("agent");
    expect(result.stderr).toContain("prepared");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on extra positionals before any network call", async () => {
    const host = makeHost(() => jsonResponse(startOutput));
    const result = await runCli(
      ["ticket", "start", "12", "extra", "--mode", "agent"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("fails loudly on an unparseable 2xx body", async () => {
    const host = makeHost(() => jsonResponse({ nope: true }));
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "agent"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    // Evidence over hypothesis: name the validation failure and the check
    // that separates build skew from a contract defect (command-center#91).
    expect(result.stderr).toContain("failed this CLI's validation");
    expect(result.stderr).not.toContain("same build as this CLI");
    expect(result.stderr).toContain("cctl doctor");
  });

  it("maps the active-session 409 through the shared failure path", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Ticket already has an active session: ticket-12-live-1",
          code: "active_session",
        },
        409,
      ),
    );
    const result = await runCli(
      ["ticket", "start", "12", "--mode", "agent"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ticket-12-live-1");
  });
});
