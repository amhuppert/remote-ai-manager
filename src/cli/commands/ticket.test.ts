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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  respond: (req: RecordedRequest) => Response,
  files: Record<string, Uint8Array<ArrayBuffer>> = {},
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
};

const sampleCreateResponse = { ticket: sampleDetail, warnings: [] };

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
  it("POSTs to the project create endpoint and reports the identifier", async () => {
    const host = makeHost(() => jsonResponse(sampleCreateResponse, 201));
    const result = await runCli(
      [
        "ticket",
        "create",
        "--title",
        "Fix the flaky gate",
        "--type",
        "bug",
        "--description",
        "It fails on Tuesdays.",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created cc#12");

    expect(host.requests).toHaveLength(1);
    const req = host.requests[0]!;
    expect(req.init.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe("/api/projects/cc/tickets");
    expect(JSON.parse(req.init.body ?? "{}")).toEqual({
      title: "Fix the flaky gate",
      workType: "bug",
      description: "It fails on Tuesdays.",
    });
  });

  it("carries the ticket detail in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(sampleCreateResponse, 201));
    const result = await runCli(
      ["ticket", "create", "--title", "Fix", "--type", "bug", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.ticket.number).toBe(12);
    expect(envelope.ticket.projectName).toBe("cc");
  });

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

  it("passes an explicit --status through to the request body", async () => {
    const host = makeHost(() => jsonResponse(sampleCreateResponse, 201));
    await runCli(
      [
        "ticket",
        "create",
        "--title",
        "Fix",
        "--type",
        "bug",
        "--status",
        "in_progress",
      ],
      baseEnv,
      host,
    );
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toMatchObject({
      status: "in_progress",
    });
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
  it("GETs the ambient project list and renders one line per ticket", async () => {
    const host = makeHost(() => jsonResponse([sampleListItem]));
    const result = await runCli(["ticket", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cc#12");
    expect(result.stdout).toContain("Fix the flaky gate");
    expect(result.stdout).toContain("not_started");

    const url = new URL(host.requests[0]!.url);
    expect(url.pathname).toBe("/api/projects/cc/tickets");
  });

  it("passes status/type/sort filters as query params", async () => {
    const host = makeHost(() => jsonResponse([]));
    await runCli(
      [
        "ticket",
        "list",
        "--status",
        "in_progress",
        "--type",
        "bug",
        "--sort",
        "created",
      ],
      baseEnv,
      host,
    );
    const url = new URL(host.requests[0]!.url);
    expect(url.searchParams.get("status")).toBe("in_progress");
    expect(url.searchParams.get("workType")).toBe("bug");
    expect(url.searchParams.get("sort")).toBe("created");
  });

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

  it("prints an empty-state line when no tickets match", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(["ticket", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no tickets");
  });

  it("fails on a malformed list response instead of reporting no tickets", async () => {
    const host = makeHost(() => jsonResponse({ nope: true }));
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("invalid_response");
  });

  it("carries the list in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse([sampleListItem]));
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.tickets).toHaveLength(1);
    expect(envelope.tickets[0].number).toBe(12);
  });
});

describe("cctl ticket list — attachment-index enrichment", () => {
  const attachedItem = { ...sampleListItem, attachmentCount: 1 };

  it("renders the bounded index fetched from the attachments endpoint", async () => {
    const host = makeHost((req) =>
      req.url.includes("/attachments")
        ? jsonResponse({
            attachments: [
              sampleAttachment("att-1", { kind: "note", markdown: "m" }),
            ],
          })
        : jsonResponse([attachedItem]),
    );
    const result = await runCli(["ticket", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "cctl ticket attachment get 'cc#12' 'att-1'",
    );
  });

  it("exits 3 when the index fetch cannot reach the server", async () => {
    const host = makeHost((req) => {
      if (req.url.includes("/attachments")) throw new Error("ECONNREFUSED");
      return jsonResponse([attachedItem]);
    });
    const result = await runCli(["ticket", "list"], baseEnv, host);
    expect(result.exitCode).toBe(3);
  });

  it("propagates a structured index-fetch failure instead of rendering an empty index", async () => {
    const host = makeHost((req) =>
      req.url.includes("/attachments")
        ? jsonResponse({ error: "index exploded", code: "index_kaboom" }, 500)
        : jsonResponse([attachedItem]),
    );
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);
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
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("invalid_response");
    expect(result.stderr).toContain("cc#12");
  });
});

describe("cctl ticket get — identifier forms", () => {
  it("resolves a bare number through the ambient project scope", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const result = await runCli(["ticket", "get", "12"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/cc/tickets/12",
    );
    expect(result.stdout).toContain("cc#12");
    expect(result.stdout).toContain("Fix the flaky gate");
  });

  it("resolves project#number cross-scope without any ambient project", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleDetail, projectName: "other" }),
    );
    const result = await runCli(
      ["ticket", "get", "other#7"],
      { CC_SERVER_URL: baseEnv["CC_SERVER_URL"], CC_API_TOKEN: "env-token" },
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/other/tickets/7",
    );
  });

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

  it("renders the description and sessions in text mode", async () => {
    const linkedAt = "2026-01-02T00:00:00Z";
    const host = makeHost((req) =>
      new URL(req.url).pathname.endsWith("/session-links")
        ? jsonResponse({
            "csm/fix-gate": {
              ticketId: "ticket-1",
              projectName: "cc",
              number: 12,
              title: sampleDetail.title,
              active: true,
              linkedAt,
              endedAt: null,
            },
          })
        : jsonResponse({
            ...sampleDetail,
            sessions: [
              {
                id: "link-1",
                ticketId: "ticket-1",
                projectPath: "/repos/cc",
                sessionName: "csm/fix-gate",
                sessionCreatedAt: "2026-01-02T00:00:00Z",
                startMode: "agent",
                linkedAt,
                endedAt: null,
                endReason: null,
              },
            ],
          }),
    );
    const result = await runCli(["ticket", "get", "12"], baseEnv, host);
    expect(result.stdout).toContain("It fails on Tuesdays.");
    expect(result.stdout).toContain("csm/fix-gate");
    expect(result.stdout).toContain("active");
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

  it("accepts the qualified reference form", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleDetail, projectName: "other" }),
    );
    await runCli(
      ["ticket", "update", "other#7", "--title", "Renamed"],
      baseEnv,
      host,
    );
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/other/tickets/7",
    );
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
  it("DELETEs by reference and confirms the removed identity", async () => {
    const host = makeHost(() =>
      jsonResponse({
        id: "ticket-1",
        projectPath: "/repos/cc",
        projectName: "cc",
        number: 12,
      }),
    );
    const result = await runCli(["ticket", "delete", "12"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted cc#12");
    expect(host.requests[0]!.init.method).toBe("DELETE");
  });

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
  it("exits 2 naming the kinds on an unknown kind", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["ticket", "attach", "url", "12", "--description", "d"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("conversation");
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

  it("POSTs a note payload from the positional markdown", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "note",
          markdown: "repro on staging",
        }),
        201,
      ),
    );
    const result = await runCli(
      [
        "ticket",
        "attach",
        "note",
        "12",
        "repro on staging",
        "--description",
        "repro notes",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("attached note att-1 to cc#12");
    const req = host.requests[0]!;
    expect(req.init.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe(
      "/api/projects/cc/tickets/12/attachments",
    );
    expect(JSON.parse(req.init.body ?? "{}")).toEqual({
      description: "repro notes",
      payload: { kind: "note", markdown: "repro on staging" },
    });
  });

  it("POSTs a session payload scoped to the ambient project", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "session",
          projectPath: "/repos/cc",
          sessionName: "csm/fix",
        }),
        201,
      ),
    );
    await runCli(
      ["ticket", "attach", "session", "12", "csm/fix", "--description", "d"],
      baseEnv,
      host,
    );
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toEqual({
      description: "d",
      payload: { kind: "session", projectName: "cc", sessionName: "csm/fix" },
    });
  });

  it("POSTs a related-ticket payload for bare and qualified references", async () => {
    const host = makeHost(() =>
      jsonResponse(
        sampleAttachment("att-1", {
          kind: "related_ticket",
          ticketId: "ticket-9",
          identifierSnapshot: "cc#7",
        }),
        201,
      ),
    );
    await runCli(
      ["ticket", "attach", "ticket", "12", "7", "--description", "d"],
      baseEnv,
      host,
    );
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toMatchObject({
      payload: { kind: "related_ticket", projectName: "cc", number: 7 },
    });

    await runCli(
      ["ticket", "attach", "ticket", "12", "other#3", "--description", "d"],
      baseEnv,
      host,
    );
    expect(JSON.parse(host.requests[1]!.init.body ?? "{}")).toMatchObject({
      payload: { kind: "related_ticket", projectName: "other", number: 3 },
    });
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
    expect(JSON.parse(host.requests[0]!.init.body ?? "{}")).toEqual({
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

  it("uploads a file as multipart form data with metadata and bytes", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const host = makeHost(
      () =>
        jsonResponse(
          sampleAttachment("att-1", {
            kind: "file",
            fileName: "ci.zip",
            snapshotKey: "k",
            mediaType: "application/zip",
            sizeBytes: 5,
            sha256: "h",
          }),
          201,
        ),
      { "logs/ci.zip": bytes },
    );
    const result = await runCli(
      [
        "ticket",
        "attach",
        "file",
        "12",
        "logs/ci.zip",
        "--description",
        "failing CI archive",
        "--media-type",
        "application/zip",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("attached file att-1 to cc#12");

    const req = host.requests[0]!;
    const contentType = req.init.headers["content-type"] ?? "";
    expect(contentType).toContain("multipart/form-data");
    expect(req.init.rawBody).toBeDefined();

    const form = await new Response(req.init.rawBody, {
      headers: { "content-type": contentType },
    }).formData();
    const metadata = JSON.parse(String(form.get("metadata")));
    expect(metadata).toEqual({
      description: "failing CI archive",
      fileName: "ci.zip",
      mediaType: "application/zip",
    });
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes);
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

describe("cctl ticket attachment", () => {
  it("GETs and renders a resolved note", async () => {
    const host = makeHost(() =>
      jsonResponse({
        kind: "note",
        attachment: sampleAttachment("att-1", {
          kind: "note",
          markdown: "the note body",
        }),
        markdown: "the note body",
      }),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/cc/tickets/12/attachments/att-1",
    );
    expect(result.stdout).toContain("the note body");
  });

  it("labels a retained conversation snapshot and lists read commands", async () => {
    const host = makeHost(() =>
      jsonResponse({
        kind: "conversation",
        attachment: sampleAttachment("att-1", {
          kind: "conversation",
          projectPath: "/repos/cc",
          sessionName: null,
          conversationId: "conv-9",
          snapshotKey: "k",
          snapshotCapturedAt: "2026-01-02T00:00:00Z",
        }),
        conversationId: "conv-9",
        sessionName: null,
        source: "retained_compaction",
        sourceAvailable: false,
        markdown: "compaction summary",
        capturedAt: "2026-01-02T00:00:00Z",
        readCommands: ["cctl conversation compaction get conv-9"],
      }),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1"],
      baseEnv,
      host,
    );
    expect(result.stdout).toContain("retained");
    expect(result.stdout).toContain("compaction summary");
    expect(result.stdout).toContain("cctl conversation compaction get conv-9");
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

  it("carries the resolved attachment in the --json envelope", async () => {
    const host = makeHost(() =>
      jsonResponse({
        kind: "note",
        attachment: sampleAttachment("att-1", { kind: "note", markdown: "m" }),
        markdown: "m",
      }),
    );
    const result = await runCli(
      ["ticket", "attachment", "get", "12", "att-1", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.attachment.kind).toBe("note");
  });

  it("PATCHes only the provided fields on update", async () => {
    const host = makeHost(() =>
      jsonResponse(sampleAttachment("att-1", { kind: "note", markdown: "m" })),
    );
    const result = await runCli(
      [
        "ticket",
        "attachment",
        "update",
        "12",
        "att-1",
        "--description",
        "sharper",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("updated attachment att-1 on cc#12");
    const req = host.requests[0]!;
    expect(req.init.method).toBe("PATCH");
    expect(JSON.parse(req.init.body ?? "{}")).toEqual({
      description: "sharper",
    });
  });

  it("POSTs refresh-snapshot and returns the captured attachment", async () => {
    const attachment = sampleAttachment("att-1", {
      kind: "conversation",
      projectPath: "/repos/cc",
      sessionName: null,
      conversationId: "conv-9",
      snapshotKey: "ticket-1/att-1/compaction-refresh.md",
      snapshotCapturedAt: "2026-01-02T00:00:00Z",
      snapshotStatus: "captured",
    });
    const host = makeHost(() => jsonResponse(attachment));

    const result = await runCli(
      ["ticket", "attachment", "refresh", "12", "att-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed conversation snapshot att-1");
    expect(host.requests[0]?.init.method).toBe("POST");
    expect(new URL(host.requests[0]!.url).pathname).toBe(
      "/api/projects/cc/tickets/12/attachments/att-1/refresh-snapshot",
    );
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

  it("DELETEs on remove and confirms the identity", async () => {
    const host = makeHost(() =>
      jsonResponse({
        attachmentId: "att-1",
        ticketId: "ticket-1",
        kind: "note",
      }),
    );
    const result = await runCli(
      ["ticket", "attachment", "remove", "12", "att-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("removed attachment att-1 from cc#12");
    expect(host.requests[0]!.init.method).toBe("DELETE");
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

describe("attachment index on get (full mode)", () => {
  const detailWithAttachments = {
    ...sampleDetail,
    attachments: [
      sampleAttachment(
        "att-1",
        {
          kind: "file",
          fileName: "ci.log",
          snapshotKey: "k",
          mediaType: null,
          sizeBytes: 10,
          sha256: "h",
        },
        LONG_DESCRIPTION,
      ),
      sampleAttachment("att-2", {
        kind: "related_ticket",
        ticketId: "ticket-9",
        identifierSnapshot: "other#3",
      }),
    ],
  };

  it("renders the full index with retrieval and follow commands in text mode", async () => {
    const host = makeHost(() => jsonResponse(detailWithAttachments));
    const result = await runCli(["ticket", "get", "12"], baseEnv, host);
    expect(result.stdout).toContain("attachments:");
    expect(result.stdout).toContain(
      "cctl ticket attachment get 'cc#12' 'att-1'",
    );
    expect(result.stdout).toContain(
      "cctl ticket attachment get 'cc#12' 'att-2'",
    );
    expect(result.stdout).toContain("cctl ticket get 'other#3'");
    // Full mode: the long description is NOT truncated.
    expect(result.stdout).toContain(LONG_DESCRIPTION);
  });

  it("carries the typed index in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(detailWithAttachments));
    const result = await runCli(
      ["ticket", "get", "12", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.attachmentIndex).toHaveLength(2);
    expect(envelope.attachmentIndex[0].kind).toBe("file");
    expect(envelope.attachmentIndex[0].description).toBe(LONG_DESCRIPTION);
    expect(envelope.attachmentIndex[0].commands).toContain(
      "cctl ticket attachment get 'cc#12' 'att-1'",
    );
    expect(envelope.attachmentIndex[1].commands).toContain(
      "cctl ticket get 'other#3'",
    );
  });

  it("renders an explicit empty index for a ticket without attachments", async () => {
    const host = makeHost(() => jsonResponse(sampleDetail));
    const text = await runCli(["ticket", "get", "12"], baseEnv, host);
    expect(text.stdout).toContain("attachments: none");
    const json = await runCli(["ticket", "get", "12", "--json"], baseEnv, host);
    expect(JSON.parse(json.stdout).attachmentIndex).toEqual([]);
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

  it("renders bounded index entries under each ticket in text mode", async () => {
    const host = listHost();
    const result = await runCli(["ticket", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "cctl ticket attachment get 'cc#12' 'att-1'",
    );
    // Bounded mode truncates the long description with an explicit ellipsis.
    expect(result.stdout).toContain("…");
    expect(result.stdout).not.toContain(LONG_DESCRIPTION);
  });

  it("carries per-ticket indexes in the --json envelope", async () => {
    const host = listHost();
    const result = await runCli(["ticket", "list", "--json"], baseEnv, host);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.tickets[0].attachmentIndex).toHaveLength(1);
    expect(envelope.tickets[0].attachmentIndex[0].truncated).toBe(true);
    expect(envelope.tickets[1].attachmentIndex).toEqual([]);
  });

  it("fetches attachments only for tickets that have any", async () => {
    const host = listHost();
    await runCli(["ticket", "list"], baseEnv, host);
    // One list call + one attachments call for cc#12; none for cc#13.
    expect(host.requests).toHaveLength(2);
  });
});

describe("cctl ticket help", () => {
  it("renders the group index listing every subcommand", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["ticket", "--help"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    for (const verb of [
      "create",
      "list",
      "get",
      "update",
      "delete",
      "attach",
      "attachment",
    ]) {
      expect(result.stdout).toContain(`ticket ${verb}`);
    }
  });

  it("lists the five kinds under ticket attach and the attachment verbs", async () => {
    const host = makeHost(() => jsonResponse({}));
    const attach = await runCli(["ticket", "attach", "--help"], baseEnv, host);
    expect(attach.exitCode).toBe(0);
    for (const kind of ["file", "conversation", "session", "ticket", "note"]) {
      expect(attach.stdout).toContain(`ticket attach ${kind}`);
    }
    const attachment = await runCli(
      ["ticket", "attachment", "--help"],
      baseEnv,
      host,
    );
    expect(attachment.exitCode).toBe(0);
    for (const verb of ["get", "update", "refresh", "remove"]) {
      expect(attachment.stdout).toContain(`ticket attachment ${verb}`);
    }
  });

  it("renders leaf help for ticket get with both identifier forms", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["ticket", "get", "--help"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("project");
    expect(result.stdout).toContain("#");
  });

  it("describes created sorting as newest first", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["ticket", "list", "--help"], baseEnv, host);
    expect(result.stdout).toContain("newest first");
    expect(result.stdout).not.toContain("oldest first");
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
        "--effort",
        "ultra",
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
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    expect(result.stdout).toContain("cc#12");
    expect(result.stdout).toContain("ticket-12-fix-the-flaky-gate-1");
    expect(result.stdout).toContain("agent");
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
    expect(result.stderr).toContain("unexpected response");
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
