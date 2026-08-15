import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import {
  PROJECT_SUPPORTED_CLI_COMMANDS,
  SESSION_ONLY_CLI_COMMANDS,
} from "./session-env-inventory";
import type { CliEnv, CliHost, FetchInit } from "./shared";

/**
 * The env a PROJECT conversation's agent actually receives from
 * `buildSessionEnvContract` (R2.2): an explicit scope discriminator plus a
 * neutralized — present, empty — `CC_SESSION`. Every assertion below drives the
 * real command dispatch with this env, so nothing here can pass by agreeing
 * with a fake.
 */
const projectEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
  CC_CONVERSATION_ID: "conv-1",
};

const validationListResponse = {
  commands: [
    {
      name: "test",
      cost: 4,
      description: "Focused tests",
      pathArgs: "paths",
      changedScope: "native",
      timeoutMs: null,
      enabled: true,
    },
  ],
  capacity: { limit: 8, inUse: 0, queueDepth: 0 },
  runs: [],
};

function validationResponse(request: RecordedRequest): Response {
  const path = pathOf(request.url);
  if (path.endsWith("/cancel")) {
    return new Response(JSON.stringify({ cancelled: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (/\/validation\/[^/]+$/.test(path)) {
    return new Response(
      JSON.stringify({
        runId: "vrun-1",
        status: "running",
        position: null,
        result: null,
        requestedScope: "changed",
        effectiveScope: "changed",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if ((request.init.method ?? "GET").toUpperCase() === "POST") {
    return new Response(
      JSON.stringify({
        kind: "not_started",
        result: {
          kind: "skipped_by_policy",
          message: "Skipped by workflow policy. Do not bypass it.",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify(validationListResponse), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const validationVerbCases = [
  {
    verb: "list",
    argv: ["validate", "list"],
    suffix: "/validation",
    method: "GET",
  },
  {
    verb: "run",
    argv: ["validate", "run", "test"],
    suffix: "/validation",
    method: "POST",
  },
  {
    verb: "status",
    argv: ["validate", "status", "vrun-1"],
    suffix: "/validation/vrun-1",
    method: "GET",
  },
  {
    verb: "cancel",
    argv: ["validate", "cancel", "vrun-1"],
    suffix: "/validation/vrun-1/cancel",
    method: "POST",
  },
] as const;

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function makeHost(
  respond: (req: RecordedRequest) => Response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      return respond({ url, init });
    },
    async readTextFile(filePath) {
      if (filePath.includes("validation-lease-")) return "lease-1\n";
      // Commands that read a payload file do so BEFORE resolving scope, so the
      // file must parse for the scope refusal to be the failure under test.
      return JSON.stringify({ summary: "s", objective: "o", decisions: [] });
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

/** The command's single request, extracted with a guard rather than an assertion. */
function onlyRequest(host: { requests: RecordedRequest[] }): RecordedRequest {
  const [first, ...rest] = host.requests;
  if (first === undefined) {
    throw new Error(
      "expected the command to issue exactly one request, got none",
    );
  }
  if (rest.length > 0) {
    throw new Error(
      `expected the command to issue exactly one request, got ${host.requests.length}`,
    );
  }
  return first;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

describe("cctl at project conversation scope — project-supported commands", () => {
  for (const testCase of validationVerbCases) {
    it(`validate ${testCase.verb} selects the project conversation route`, async () => {
      const host = makeHost(validationResponse);
      const result = await runCli([...testCase.argv], projectEnv, host);

      expect(result.stderr).not.toContain("CC_SESSION");
      const request = onlyRequest(host);
      expect(pathOf(request.url)).toBe(
        `/api/projects/cc/conversations/conv-1${testCase.suffix}`,
      );
      expect(request.init.method).toBe(testCase.method);
      expect(request.url).not.toContain("/sessions/");
      expect(request.url).not.toContain("__project__");
    });
  }

  it("notify posts to the project conversation notifications route", async () => {
    const host = makeHost();
    const result = await runCli(["notify", "done"], projectEnv, host);

    expect(result.exitCode).toBe(0);
    expect(pathOf(onlyRequest(host).url)).toBe(
      "/api/projects/cc/conversations/conv-1/notifications",
    );
  });

  it("ask posts to the project conversation ask route", async () => {
    const host = makeHost(
      () =>
        new Response(JSON.stringify({ ok: true, questionBatchId: "b-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await runCli(
      [
        "ask",
        "--question",
        "Ship it?",
        "--option",
        "Yes",
        "--option",
        "No",
        "--header",
        "Ship",
      ],
      projectEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(pathOf(onlyRequest(host).url)).toBe(
      "/api/projects/cc/conversations/conv-1/ask",
    );
  });

  it("doctor diagnoses at project scope without publishing an empty session", async () => {
    // `doctor` reads the session env and PUBLISHES the resolved identity as
    // handshake query params. A `?session=` built from the neutralized "" would
    // be echoed back and logged as a session name — the same silent misrouting
    // an empty URL segment causes, on a payload surface instead of a path.
    const host = makeHost(
      () =>
        new Response(
          JSON.stringify({
            serverBuild: "dev",
            identity: { project: "cc", session: null, conversation: "conv-1" },
            tokenValid: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await runCli(["doctor"], projectEnv, host);

    expect(result.exitCode).toBe(0);
    const url = new URL(onlyRequest(host).url);
    expect(url.pathname).toBe("/api/agent/handshake");
    expect(url.searchParams.has("session")).toBe(false);
    expect(url.searchParams.get("project")).toBe("cc");
    expect(url.searchParams.get("conversation")).toBe("conv-1");
    expect(result.stdout).toContain("session=-");
  });

  it("conversation read builds the project route, never an empty session segment", async () => {
    const host = makeHost(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            conversationId: "conv-1",
            messages: [],
            window: { from: 0, to: 0, total: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await runCli(
      ["conversation", "read", "conv-1"],
      projectEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const path = pathOf(onlyRequest(host).url);
    expect(path).toBe("/api/projects/cc/conversations/conv-1/read");
    expect(path).not.toContain("/sessions/");
    expect(path).not.toContain("//");
  });

  it("ticket attach records absent session provenance, not an empty session name", async () => {
    const host = makeHost(
      () =>
        new Response(
          JSON.stringify({
            id: "att-1",
            kind: "conversation",
            description: "d",
            createdAt: "2026-01-02T00:00:00Z",
            snapshotKey: "k",
            snapshotCapturedAt: "2026-01-02T00:00:00Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    await runCli(
      ["ticket", "attach", "conversation", "12", "--description", "d"],
      projectEnv,
      host,
    );

    const body: unknown = JSON.parse(onlyRequest(host).init.body ?? "{}");
    expect(body).toEqual({
      description: "d",
      payload: {
        kind: "conversation",
        projectName: "cc",
        sessionName: null,
        conversationId: "conv-1",
      },
    });
  });

  it("spec authoring still works at project scope instead of demanding a session", async () => {
    const host = makeHost(
      () =>
        new Response(
          JSON.stringify({ spec: { slug: "feat", status: "abandoned" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await runCli(
      ["spec", "abandon", "feat", "--reason", "superseded"],
      projectEnv,
      host,
    );

    expect(result.stderr).not.toContain("CC_SESSION");
    expect(pathOf(onlyRequest(host).url)).not.toContain("/sessions/");
  });

  it("never puts the sentinel or an empty session segment in any request URL", async () => {
    for (const argv of [
      ["notify", "done"],
      ["conversation", "read", "conv-1"],
    ]) {
      const host = makeHost();
      await runCli(argv, projectEnv, host);
      for (const request of host.requests) {
        expect(request.url).not.toContain("__project__");
        expect(request.url).not.toContain("/sessions/");
      }
    }
  });
});

describe("cctl at project conversation scope — session-only commands", () => {
  // The inventory is the contract (R2.4): every command classified session-only
  // must refuse loudly at project scope rather than build a sentinel URL.
  const invocations: Record<string, string[]> = {
    agent: ["agent", "status", "run-1"],
    charter: ["charter", "write", "--file", "/tmp/charter.json"],
    decisions: ["decisions", "propose", "--file", "/tmp/decisions.json"],
    dev: ["dev", "list"],
    docs: ["docs", "list"],
    fixture: ["fixture", "session", "create", "cc"],
    // Exercises the group default through the EXECUTION verbs, and each lane
    // entry point, rather than one representative — a single sample let the
    // project-supported definition verbs hide inside a session-only group.
    workflow: ["workflow", "live", "get"],
    // A leaf that differs from its project-supported group: starting an execution
    // pins it to a session, and approveExecutionStart refuses one whose session is
    // null, so a project-scope start would persist an unapprovable execution.
    "spec start": ["spec", "start", "feat"],
  };

  /** Session-only workflow verbs that resolve through the group entry. */
  const sessionOnlyWorkflowVerbs: string[][] = [
    ["workflow", "validate", "--file", "/tmp/plan.json"],
    ["workflow", "status"],
    ["workflow", "status", "exec-7"],
    ["workflow", "start", "wf-1"],
    ["workflow", "wait", "exec-7", "--timeout", "1ms"],
    ["workflow", "abandon", "exec-7", "--reason", "superseded"],
    ["workflow", "live", "get"],
    ["workflow", "live", "edit", "--file", "/tmp/edit.json"],
    ["workflow", "live", "pause"],
    ["workflow", "live", "resume"],
    ["workflow", "task", "complete", "t1", "--summary", "s"],
    ["workflow", "task", "add", "--title", "t", "--instructions", "i"],
    ["workflow", "collab", "request", "--brief", "b"],
  ];

  for (const argv of sessionOnlyWorkflowVerbs) {
    it(`${argv.slice(0, 3).join(" ")} refuses at project scope`, async () => {
      const host = makeHost();
      const result = await runCli(argv, projectEnv, host);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("CC_SESSION");
      expect(host.requests).toHaveLength(0);
    });
  }

  it("workflow run gives project conversations session-conversation guidance without a request", async () => {
    const host = makeHost();
    const result = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json", "--json"],
      projectEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "project_scope_refused",
      details: { remedy: expect.stringContaining("session conversation") },
    });
    expect(host.requests).toHaveLength(0);
  });

  it("covers every session-only command in the inventory", () => {
    expect(Object.keys(invocations).sort()).toEqual(
      [...SESSION_ONLY_CLI_COMMANDS].sort(),
    );
  });

  // The converse of the refusal contract: a command classified project-supported
  // must NOT demand a session. Without this, a verb could be mis-filed as
  // session-only (or inherit a session-only group) and the suite would still be
  // green while project agents silently lost a working command (R2.4).
  describe("project-supported commands do not demand a session", () => {
    const projectSupportedInvocations: Record<string, string[]> = {
      // Leaves that differ from their session-only group: the profile library
      // is project-scoped, so a project agent keeps the discovery surface even
      // though `agent run` needs a session worktree.
      "agent list": ["agent", "list"],
      "agent get": ["agent", "get", "builtin:standard-agent"],
      ask: ["ask", "--file", "/tmp/ask.json"],
      conversation: ["conversation", "read", "conv-1"],
      doctor: ["doctor"],
      notify: ["notify", "done"],
      spec: ["spec", "abandon", "feat", "--reason", "x"],
      ticket: ["ticket", "list"],
      validate: ["validate", "list"],
      "workflow create": ["workflow", "create", "--file", "/tmp/plan.json"],
      "workflow replace": [
        "workflow",
        "replace",
        "wf-1",
        "--file",
        "/tmp/plan.json",
      ],
      "workflow list": ["workflow", "list"],
      "workflow get": ["workflow", "get", "wf-1"],
      "workflow edit": ["workflow", "edit", "wf-1", "--file", "/tmp/edit.json"],
      "workflow delete": ["workflow", "delete", "wf-1"],
      "workflow templates": ["workflow", "templates"],
    };

    it("covers every project-supported command in the inventory", () => {
      expect(Object.keys(projectSupportedInvocations).sort()).toEqual(
        [...PROJECT_SUPPORTED_CLI_COMMANDS].sort(),
      );
    });

    for (const [command, argv] of Object.entries(projectSupportedInvocations)) {
      it(`${command} routes at project scope instead of failing for a missing session`, async () => {
        const host = makeHost();
        const result = await runCli(argv, projectEnv, host);

        expect(result.stderr).not.toContain("CC_SESSION");
        for (const request of host.requests) {
          expect(request.url).not.toContain("__project__");
          expect(request.url).not.toContain("/sessions/");
        }
      });
    }
  });

  for (const [command, argv] of Object.entries(invocations)) {
    it(`${command} fails with the explicit CC_SESSION usage error and issues no request`, async () => {
      const host = makeHost();
      const result = await runCli(argv, projectEnv, host);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("CC_SESSION");
      expect(host.requests).toHaveLength(0);
    });
  }
});

describe("cctl validate at session conversation scope", () => {
  const sessionEnv: CliEnv = {
    ...projectEnv,
    CC_CONVERSATION_SCOPE: "session",
    CC_SESSION: "feature",
  };

  for (const testCase of validationVerbCases) {
    it(`validate ${testCase.verb} selects the session conversation route`, async () => {
      const host = makeHost(validationResponse);
      await runCli([...testCase.argv], sessionEnv, host);

      const request = onlyRequest(host);
      expect(pathOf(request.url)).toBe(
        `/api/projects/cc/sessions/feature/conversations/conv-1${testCase.suffix}`,
      );
      expect(request.init.method).toBe(testCase.method);
      expect(request.url).not.toContain("__project__");
      expect(request.url).not.toContain("/sessions//");
    });
  }
});
